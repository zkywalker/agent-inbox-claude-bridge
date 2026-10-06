import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, stat, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHealth } from '../dist/adapters/claude/local-health.js';

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
