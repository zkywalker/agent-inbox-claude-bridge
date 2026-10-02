import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeState } from '../dist-tests/adapters/codex/state.js';
import { Gateway, GatewayError } from '../dist-tests/adapters/codex/gateway.js';
import { OutgoingTransport } from '../dist-tests/adapters/codex/outgoing.js';
async function until(check, timeout = 2500) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeout) await delay(5);
  assert.ok(check(), 'state did not settle before deadline');
}

test('coalesced output is durable, bounded and reconstructs after an unclean database close', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-output-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.sqlite');
  const state = new BridgeState(path);
  const message = { key: 'one', conversationId: 'topic', text: 'a', kind: 'chat', streaming: true };
  state.queue(message);
  const before = Number(state.db.prepare('SELECT total_changes() AS n').get().n);
  for (let i = 1; i <= 1000; i++) {
    state.queue({ ...message, text: 'a'.repeat(1 + i * 80) });
    if (i % 50 === 0) state.flushBuffered();
  }
  const writes = Number(state.db.prepare('SELECT total_changes() AS n').get().n) - before;
  assert.ok(writes < 100, `expected batch writes, got ${writes}`);
  assert.equal(state.outgoing('one')?.text.length, 80001);
  assert.ok(Number(state.db.prepare('SELECT COUNT(*) AS n FROM outgoing_text_deltas').get().n) <= 128);
  state.db.close(); // No graceful snapshot compaction: simulate process loss after durable flush.
  const recovered = new BridgeState(path);
  assert.equal(recovered.outgoing('one')?.text.length, 80001);
  assert.equal(recovered.outgoing('one')?.streaming, false);
  recovered.close();
});


test('outgoing scheduler sleeps while idle and wakes immediately for a new durable message', async t => {
  const state = new BridgeState(':memory:');
  const gateway = new Gateway({ gatewayUrl: 'http://localhost', token: 'test', stateDir: '', projects: [] });
  let calls = 0, scans = 0;
  gateway.call = (async (_path, body) => { calls++; return { ...body, id: 'message' }; });
  const dirty = state.dirty.bind(state);
  state.dirty = at => { scans++; return dirty(at); };
  const controller = new AbortController(), transport = new OutgoingTransport(state, gateway);
  const run = transport.run(controller.signal);
  t.after(async () => { controller.abort(); await run; state.close(); });
  await delay(120); assert.equal(scans, 1); assert.equal(calls, 0);
  state.put({ key: 'one', conversationId: 'topic', text: 'first', kind: 'chat', streaming: false });
  await until(() => calls === 1, 100);
  const settled = scans; await delay(120); assert.equal(scans, settled);
});


test('lost delta receipts retain identity and revision mismatches recover newer output', async t => {
  const state = new BridgeState(':memory:');
  t.after(() => state.close());
  const gateway = new Gateway({ gatewayUrl: 'http://localhost', token: 'test', stateDir: '', projects: [] });
  gateway.supportsMessageDeltas = true;
  let current, creations = 0, lose = true, at = Date.now(), deltaAttempts = 0, fullPatches = 0;
  gateway.call = async (path, body) => {
    if (path.endsWith('/messages')) { creations++; current = { ...body, id: 'message', revision: 1 }; return { ...current }; }
    assert.equal(path, '/connector/messages/message');
    if (body.delta) {
      deltaAttempts++;
      if (body.delta.baseRevision !== current.revision) throw new GatewayError(409, 'message_revision_mismatch');
      current = { ...current, ...body, text: current.text.slice(0, body.delta.prefix) + body.delta.tail, revision: current.revision + 1 };
      if (lose) { lose = false; throw new GatewayError(503, 'lost_response'); }
    } else { fullPatches++; current = { ...current, ...body, revision: current.revision + 1 }; }
    return { ...current };
  };
  const transport = new OutgoingTransport(state, gateway, () => at);
  const output = { key: 'stable-output', conversationId: 'topic', text: 'first', streaming: true, kind: 'chat' };
  state.queue(output); await transport.flush();
  state.queue({ ...output, text: 'first next' }); await transport.flush();
  assert.equal(current.text, 'first next');
  state.queue({ ...output, text: 'first next final', streaming: false });
  at += 1100; await transport.flush();
  assert.equal(current.text, 'first next final'); assert.equal(current.streaming, false);
  assert.equal(creations, 1); assert.equal(deltaAttempts, 2); assert.equal(fullPatches, 1);
  assert.equal(state.dirty(at).length, 0);
});

test('capability loss after a gateway downgrade falls back once to full PATCH over HTTP', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const state = new BridgeState(':memory:');
  let revision = 1, text = '', deltas = 0, full = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      text = body.text; response.setHeader('X-Inbox-Message-Delta', 'v1');
      response.end(JSON.stringify({ ...body, id: 'message', text, revision })); return;
    }
    if (body.delta) { deltas++; response.writeHead(400); response.end(JSON.stringify({ error: 'validation_error' })); return; }
    full++; text = body.text; response.end(JSON.stringify({ id: 'message', text, revision: ++revision }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { state.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const gateway = new Gateway({ gatewayUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', stateDir: '', projects: [] });
  const transport = new OutgoingTransport(state, gateway);
  const output = { key: 'same', conversationId: 'topic', text: 'start', streaming: true, kind: 'chat' };
  state.queue(output); await transport.flush(); assert.equal(gateway.supportsMessageDeltas, true);
  state.queue({ ...output, text: 'start next' }); await transport.flush();
  state.queue({ ...output, text: 'start next final', streaming: false }); await transport.flush();
  assert.equal(text, 'start next final'); assert.equal(deltas, 1); assert.equal(full, 2);
  assert.equal(gateway.supportsMessageDeltas, false); assert.equal(state.dirty().length, 0);
});
