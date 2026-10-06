import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, stat, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHealth } from '../dist-tests/adapters/claude/local-health.js';
import { ClaudeBridge } from '../dist-tests/adapters/claude/bridge.js';
import { configSchema } from '../dist-tests/adapters/claude/config.js';
import { BridgeState } from '../dist-tests/adapters/codex/state.js';
import { GatewayError } from '../dist-tests/adapters/codex/gateway.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inbox-health-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('local health separates process heartbeat from actual successful communication', async t => {
  const root = await fixture(t), health = new LocalHealth('claude', join(root, 'config.json'));
  t.after(() => health.stop());
  await health.start();
  let record = JSON.parse(await readFile(health.path, 'utf8'));
  assert.equal(record.state, 'starting'); assert.equal(record.lastSuccessAt, undefined);
  assert.equal(record.pid, process.pid); assert.ok(record.processStartId);
  health.success(); await health.flush();
  record = JSON.parse(await readFile(health.path, 'utf8'));
  assert.equal(record.state, 'connected'); const success = record.lastSuccessAt;
  health.failure(401); await health.flush();
  record = JSON.parse(await readFile(health.path, 'utf8'));
  assert.equal(record.state, 'auth_failed'); assert.equal(record.reasonCode, 'authentication');
  assert.equal(record.lastSuccessAt, success);
  assert.equal(record.configPath, undefined); assert.equal(record.token, undefined);
  assert.equal((await stat(health.path)).mode & 0o777, 0o600);
  health.failure(409); await health.flush();
  assert.equal(JSON.parse(await readFile(health.path, 'utf8')).state, 'conflict');
  await health.stop(); health.success(); await health.flush();
  assert.equal(JSON.parse(await readFile(health.path, 'utf8')).state, 'stopped');
});
test('diagnostic writer does not follow a substituted directory link', async t => {
  const root = await fixture(t), target = join(root, 'other'); await mkdir(target);
  await symlink(target, join(root, '.agent-inbox-health'));
  const health = new LocalHealth('claude', join(root, 'config.json'));
  await health.start(); health.success(); await health.stop();
  assert.deepEqual(await readdir(target), []);
});

async function bridgeFixture(t) {
  const root = await fixture(t);
  const state = new BridgeState(':memory:');
  const config = configSchema.parse({ gatewayUrl: 'http://localhost', token: 'isolated-health-test-token', projectPath: root, stateDir: root });
  const bridge = new ClaudeBridge(config, state);
  bridge.management.run = async () => {};
  bridge.flushOutgoing = async () => {};
  bridge.gateway.call = async () => assert.fail('health must use the existing polling transport');
  t.after(async () => { bridge.stop(); await bridge.management.close(); state.close(); });
  return bridge;
}

test('local health follows recoverable polls and shutdown cancels authentication backoff', { timeout: 5000 }, async t => {
  for (const status of [undefined, 401]) {
    const bridge = await bridgeFixture(t);
    const observed = [];
    bridge.gateway.pollInbox = async options => {
      assert.equal(options.claudeInstanceId, bridge.management.instanceId);
      assert.ok(options.signal instanceof AbortSignal);
      if (status) throw new GatewayError(status, 'isolated-private-reason');
      return { protocolVersion: 1, deliveries: [] };
    };
    bridge.onLocalConnection = (...event) => { observed.push(event); bridge.stop(); };
    await bridge.run();
    assert.deepEqual(observed, status ? [[false, status]] : [[true]]);
  }
});

test('a poll settling after shutdown cannot publish fresh connection evidence', { timeout: 5000 }, async t => {
  const bridge = await bridgeFixture(t);
  const observed = [];
  bridge.onLocalConnection = (...event) => observed.push(event);
  bridge.gateway.pollInbox = async () => {
    bridge.stop();
    return { protocolVersion: 1, deliveries: [] };
  };
  await bridge.run();
  assert.deepEqual(observed, []);
});
