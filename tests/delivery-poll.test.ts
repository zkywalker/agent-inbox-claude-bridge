import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Gateway, GatewayError } from '../adapters/codex/gateway.js';

function payload() {
  const conversationId = randomUUID();
  return { protocolVersion: 1, deliveries: [{
    id: randomUUID(), conversation: { id: conversationId, agentId: randomUUID(), projectId: 'fixture' },
    message: { id: randomUUID(), conversationId, role: 'user', kind: 'chat', text: 'local fixture', status: 'sending', attachments: [] },
    history: [],
  }] };
}

async function server(t: test.TestContext, respond: (response: ServerResponse, index: number, url: URL) => void) {
  const keys: string[] = [];
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/api/connector/inbox');
    const key = url.searchParams.get('pollId')!;
    assert.match(key, /^[a-f\d-]{36}$/);
    keys.push(key);
    response.setHeader('content-type', 'application/json');
    respond(response, keys.length, url);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); });
  const config = { gatewayUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: 'local-test-only', stateDir: '', projects: [] };
  return { keys, config, gateway: new Gateway(config) };
}

test('a truncated poll response reuses the same batch key; the next successful poll rotates it before input handling', async t => {
  const batch = payload();
  const { gateway, keys } = await server(t, (response, index) => {
    if (index === 1) {
      response.writeHead(200, { 'content-length': 5000 });
      response.write('{"protocolVersion":1,"deliveries":[');
      setImmediate(() => response.destroy());
    } else response.end(JSON.stringify(index === 2 ? batch : { protocolVersion: 1, deliveries: [] }));
  });
  await assert.rejects(gateway.pollInbox());
  const recovered = await gateway.pollInbox();
  assert.deepEqual(recovered.deliveries, batch.deliveries);
  // The key has already changed when the response is handed to the caller.
  assert.deepEqual((await gateway.pollInbox()).deliveries, []);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test('invalid JSON and a partially invalid batch are rejected before any delivery is exposed', async t => {
  const batch = payload();
  const { gateway, keys } = await server(t, (response, index) => {
    if (index === 1) response.end('{"deliveries":');
    else if (index === 2) response.end(JSON.stringify({ ...batch, deliveries: [...batch.deliveries, { id: randomUUID() }] }));
    else response.end(JSON.stringify(batch));
  });
  await assert.rejects(gateway.pollInbox(), SyntaxError);
  await assert.rejects(gateway.pollInbox(), (error: unknown) => error instanceof GatewayError && error.code === 'invalid_inbox_response');
  assert.deepEqual((await gateway.pollInbox()).deliveries, batch.deliveries);
  assert.equal(new Set(keys).size, 1);
});

test('the real 28-second request deadline retains the recovery key', { timeout: 40_000 }, async t => {
  const batch = payload();
  const { gateway, keys } = await server(t, (response, index) => {
    if (index === 1) return; // The first response never reaches the connector.
    response.end(JSON.stringify(batch));
  });
  await assert.rejects(gateway.pollInbox(), (error: unknown) => error instanceof GatewayError && error.code === 'gateway_unreachable');
  assert.deepEqual((await gateway.pollInbox()).deliveries, batch.deliveries);
  assert.equal(keys[0], keys[1]);
});

test('HTTP failures retain the key, empty successes rotate, and new clients do not resume old polls', async t => {
  const { gateway, keys, config } = await server(t, (response, index) => {
    if (index === 1) { response.statusCode = 409; response.end(JSON.stringify({ error: 'conflict' })); }
    else response.end(JSON.stringify({ protocolVersion: 1, deliveries: [] }));
  });
  await assert.rejects(gateway.pollInbox(), (error: unknown) => error instanceof GatewayError && error.status === 409);
  await gateway.pollInbox();
  await gateway.pollInbox();
  await new Gateway(config).pollInbox();
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
  assert.notEqual(keys[2], keys[3]);
});

test('Claude instance binding survives a cancelled HTTP poll without advancing its recovery key', async t => {
  const instanceId = randomUUID(), abort = new AbortController();
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const { gateway, keys } = await server(t, (response, index, url) => {
    assert.equal(url.searchParams.get('claudeInstanceId'), instanceId);
    if (index === 1) { received(); return; }
    response.end(JSON.stringify({ protocolVersion: 1, deliveries: [] }));
  });
  const pending = gateway.pollInbox({ claudeInstanceId: instanceId, signal: abort.signal });
  const rejected = assert.rejects(pending);
  await started; abort.abort(); await rejected;
  await gateway.pollInbox({ claudeInstanceId: instanceId });
  assert.equal(keys[0], keys[1]);
});
