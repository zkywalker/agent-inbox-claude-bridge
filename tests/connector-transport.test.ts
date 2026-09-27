import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeState, stableKey, type Outgoing, type Session } from '../adapters/codex/state.js';
import { Gateway, GatewayError } from '../adapters/codex/gateway.js';
import { OUTGOING_AUTH_RETRY_MS, OUTGOING_MAX_TEXT, OutgoingTransport } from '../adapters/codex/outgoing.js';
import { ClaudeManagement } from '../adapters/claude/management.js';
import { configSchema } from '../adapters/claude/config.js';

const output = (key: string, conversationId = key): Outgoing => ({ key, conversationId, text: key, kind: 'chat', streaming: false });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(context: TestContext) {
  const state = new BridgeState(':memory:');
  context.after(() => state.close());
  const gateway = new Gateway({ gatewayUrl: 'http://localhost', token: 'simulated-connector', stateDir: '', projects: [] });
  let now = 1000;
  const transport = new OutgoingTransport(state, gateway, () => now);
  return { state, gateway, transport, advance(ms: number) { now += ms; }, get now() { return now; } };
}
function mockGateway(gateway: Gateway, handler: (path: string, body?: any, method?: string) => Promise<any>) {
  gateway.call = (async (path: string, body?: unknown, _management?: boolean, method?: string) => handler(path, body, method)) as Gateway['call'];
}

test('permanent output rejection is durable and cannot block another topic', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'connector-outgoing-'));
  let state = new BridgeState(join(dir, 'state.sqlite'));
  context.after(async () => { state.close(); await rm(dir, { recursive: true, force: true }); });
  const gateway = new Gateway({ gatewayUrl: 'http://localhost', token: 'simulated-connector', stateDir: dir, projects: [] });
  const sent: string[] = [];
  for (const status of [400, 404, 413]) state.put(output(`rejected-${status}`));
  state.put(output('healthy'));
  mockGateway(gateway, async (_path, body) => {
    const status = Number(body.text.split('-')[1]);
    if (status) throw new GatewayError(status, 'private-message-not-persisted');
    sent.push(body.text); return { ...body, id: 'created-id' };
  });
  assert.equal(await new OutgoingTransport(state, gateway).flush(), 1);
  assert.deepEqual(sent, ['healthy']);
  assert.equal(state.dirty().length, 0);
  state.close(); state = new BridgeState(join(dir, 'state.sqlite'));
  for (const status of [400, 404, 413]) {
    const failure = state.outgoingFailure(stableKey(`rejected-${status}`));
    assert.equal(failure?.status, status); assert.equal(failure?.blocked, true);
    assert.equal(failure?.reason, `http_${status}_output_rejected`);
    assert.ok(state.outgoing(`rejected-${status}`));
  }
  state.put({ ...output('rejected-400'), text: 'corrected' });
  assert.equal(await new OutgoingTransport(state, gateway).flush(), 1);
  assert.equal(state.outgoingFailure(stableKey('rejected-400')), undefined);
});

test('network and 429 retries preserve identity and back off while healthy topics send', async context => {
  const f = fixture(context); let connected = false;
  const attempts = new Map<string, number>(), keys = new Map<string, string>();
  for (const key of ['network', 'rate', 'healthy']) f.state.put(output(key));
  mockGateway(f.gateway, async (_path, body) => {
    const key = body.text; attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (keys.has(key)) assert.equal(body.clientMessageId, keys.get(key));
    keys.set(key, body.clientMessageId);
    if (!connected && key === 'network') throw new Error('simulated lost connection');
    if (!connected && key === 'rate') throw new GatewayError(429, 'limited');
    return { ...body, id: `${key}-id` };
  });
  assert.equal(await f.transport.flush(), 1);
  await f.transport.flush();
  assert.deepEqual([...attempts.values()], [1, 1, 1]);
  assert.equal(f.state.outgoingFailure(stableKey('rate'))?.reason, 'rate_limited');
  f.advance(1000); connected = true;
  assert.equal(await f.transport.flush(), 2);
  assert.deepEqual([...attempts.values()], [2, 2, 1]);
});

test('authentication errors pause the whole outbox instead of retrying every loop', async context => {
  const f = fixture(context); let calls = 0, authorized = false;
  for (let i = 0; i < 10; i++) f.state.put(output(`topic-${i}`));
  mockGateway(f.gateway, async (_path, body) => {
    calls++;
    if (!authorized) throw new GatewayError(401, 'access_login_required');
    return { ...body, id: `message-${body.clientMessageId}` };
  });
  await f.transport.flush(); assert.ok(calls <= 4);
  const first = calls; await f.transport.flush(); f.advance(OUTGOING_AUTH_RETRY_MS - 1); await f.transport.flush();
  assert.equal(calls, first);
  assert.equal(f.state.tool('outgoing:authentication').reason, 'authentication_required');
  f.advance(1); authorized = true;
  assert.equal(await f.transport.flush(), 10);
});

test('more than one batch of hot activities cannot starve another topic or later activities', async context => {
  const f = fixture(context), seen = new Set<string>();
  for (let i = 0; i < 60; i++) f.state.put(output(`hot-${i}`, 'busy-topic'));
  f.state.put(output('other', 'another-topic'));
  mockGateway(f.gateway, async (_path, body, method) => {
    const key = body.text; seen.add(key);
    if (key.startsWith('hot-')) f.state.put(output(key, 'busy-topic'));
    return { ...body, id: method === 'PATCH' ? 'existing' : `id-${key}` };
  });
  await f.transport.flush(); assert.ok(seen.has('other'));
  f.advance(10); await f.transport.flush(); f.advance(10); await f.transport.flush();
  assert.equal(seen.size, 61, 'a continuously revised first batch does not monopolize the queue');
});

test('a committed create uses one request; lost create responses recover the latest revision', async context => {
  const f = fixture(context), message = output('same-key');
  f.state.put(message);
  let created: any, loseResponse = true;
  const methods: string[] = [], keys: string[] = [];
  mockGateway(f.gateway, async (_path, body, method) => {
    methods.push(method ?? 'POST');
    if (method === 'PATCH') { Object.assign(created, body); return created; }
    keys.push(body.clientMessageId);
    created ??= { ...body, id: 'durable-id' };
    if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
    return created;
  });
  await f.transport.flush();
  f.state.put({ ...message, text: 'latest completed reply' }); f.advance(1000);
  await f.transport.flush();
  assert.deepEqual(methods, ['POST', 'POST', 'PATCH']); assert.equal(keys[0], keys[1]);
  assert.equal(created.text, 'latest completed reply'); assert.equal(f.state.dirty(f.now).length, 0);
  f.state.put(output('fresh'));
  mockGateway(f.gateway, async (_path, body, method) => {
    assert.equal(method, undefined, 'a confirmed current POST does not need PATCH');
    return { ...body, id: 'fresh-id' };
  });
  await f.transport.flush();
});

test('edits during POST and PATCH remain dirty, including concurrent flush attempts', async context => {
  const f = fixture(context), message = output('concurrent'); f.state.put(message);
  let count = 0;
  mockGateway(f.gateway, async (_path, body, method) => {
    count++;
    if (count === 1) f.state.put({ ...message, text: 'revision-two' });
    if (count === 2) { assert.equal(method, 'PATCH'); f.state.put({ ...message, text: 'revision-three' }); }
    return { ...body, id: 'message-id' };
  });
  await Promise.all([f.transport.flush(), f.transport.flush()]);
  assert.equal(count, 1); assert.equal(f.state.dirty(f.now).length, 1);
  await f.transport.flush(); assert.equal(f.state.dirty(f.now).length, 1);
  await f.transport.flush(); assert.equal(f.state.dirty(f.now).length, 0); assert.equal(count, 3);
});

test('local notification correlation survives transport without becoming a wire field', async context => {
  const f = fixture(context);
  const process = f.state.beginProcess('topic', 'native-thread', 'native-turn', '2026-09-28T00:00:00.000Z');
  f.state.put({ ...output('answer', 'topic'), text: 'Confirmed final answer', notificationProcessId: process.id });
  mockGateway(f.gateway, async (_path, body) => {
    assert.equal(Object.hasOwn(body, 'notificationProcessId'), false);
    return { ...body, id: 'message-id' };
  });
  await f.transport.flush();
  assert.equal(f.state.outgoing('answer')?.notificationProcessId, process.id);
  f.state.updateProcess('native-thread', 'native-turn', 'completed', '2026-09-28T00:01:00.000Z');
  assert.equal(f.state.turnProcess('native-thread', 'native-turn')?.summary, 'Confirmed final answer');
});

test('a slow topic does not hold another topic and oversized Claude output is explicitly bounded', async context => {
  const f = fixture(context), stalled = deferred(), healthy = deferred();
  const fullText = '长回复'.repeat(50_000);
  f.state.put({ ...output('long'), text: fullText }); f.state.put(output('healthy'));
  let wireText = '';
  mockGateway(f.gateway, async (path, body) => {
    if (path.includes('/long/')) { wireText = body.text; await stalled.promise; }
    else healthy.resolve();
    return { ...body, id: `id-${body.clientMessageId}` };
  });
  const flush = f.transport.flush();
  await healthy.promise;
  assert.ok(wireText.length <= OUTGOING_MAX_TEXT); assert.match(wireText, /已截断/);
  assert.equal(f.state.outgoing('long')?.text, fullText);
  stalled.resolve(); assert.equal(await flush, 2);
});

test('Claude reports only dirty historical sessions; control long polling stays independent of a held report', { timeout: 10_000 }, async context => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'connector-management-')));
  const state = new BridgeState(':memory:');
  const config = configSchema.parse({ gatewayUrl: 'http://localhost', token: 'simulated-connector-token', managementToken: 'simulated-management-token', stateDir: dir, projectPath: dir });
  const gateway = new Gateway({ ...config, projects: [{ id: 'default', name: 'Fixture', path: dir }] });
  const heldReport = deferred(), reportStarted = deferred(), controlled = deferred();
  let loop: Promise<void> | undefined, holdReports = false, actionOffered = false;
  let topicReports = 0, registrations = 0, configurationReads = 0;
  const management = new ClaudeManagement(config, gateway, state, { busy: () => false, control: async () => { controlled.resolve(); } });
  context.after(async () => { management.stop(); heldReport.resolve(); await loop; await management.close(); state.close(); await rm(dir, { recursive: true, force: true }); });
  gateway.call = (async (path: string, body?: any, _management?: boolean, _method?: string, signal?: AbortSignal) => {
    if (path === '/connector/coding/connect') { registrations++; return {}; }
    if (path.startsWith('/connector/runtime/connections')) { configurationReads++; return { connections: null }; }
    if (path === '/connector/coding/session') {
      topicReports++; if (holdReports) { reportStarted.resolve(); await heldReport.promise; } return {};
    }
    if (path.startsWith('/connector/coding/inbox?')) {
      assert.match(path, /wait=20/); assert.match(path, new RegExp(`instanceId=${management.instanceId}`));
      if (!actionOffered) { actionOffered = true; await reportStarted.promise; return { actions: [{ id: 'control-action', kind: 'interrupt', conversationId: 'topic-0', payload: {} }] }; }
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })); return { actions: [] };
    }
    if (path.startsWith('/connector/runtime/inbox?')) {
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })); return { requests: [] };
    }
    return {};
  }) as Gateway['call'];
  for (let i = 0; i < 100; i++) state.save({ conversationId: `topic-${i}`, projectId: 'default', threadId: `native-${i}`, turnId: null, state: 'idle', model: null, provider: 'native', nativeSettings: { permissionMode: 'default' }, error: null } satisfies Session);
  await management.initialize('2.1.281');
  assert.equal(topicReports, 100); assert.equal(state.dirtySessions().length, 0);
  state.sessions = () => { throw new Error('The management loop must not scan all historical sessions'); };
  holdReports = true;
  const changed = state.session('topic-0')!; changed.state = 'running'; state.save(changed);
  topicReports = 0; loop = management.run();
  await controlled.promise;
  assert.equal(topicReports, 1); assert.equal(registrations, 1); assert.equal(configurationReads, 1);
  heldReport.resolve();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(topicReports, 1, 'unchanged history is not uploaded on the next management iteration');
  assert.equal(state.dirtySessions().length, 0);
});
