import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseManifest } from '../scripts/create-release-manifest.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';

test('Claude release signature binds product, version, expiry and all platform bytes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeys = [publicKey.export({ type: 'spki', format: 'pem' })];
  for (const platform of ['linux-x64', 'darwin-x64', 'darwin-arm64']) await writeFile(join(directory, `claude-bridge-0.1.0-${platform}.tar.gz`), `fixture-${platform}`);
  await createReleaseManifest({ directory, version: '0.1.0', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const options = { directory, bundle: join(directory, 'manifest-bundle'), publicKeys, version: '0.1.0' };
  const manifest = await verifyRelease(options); assert.equal(manifest.repository, 'zkywalker/agent-inbox-claude-bridge');
  await assert.rejects(verifyRelease({ ...options, version: '0.1.1' }));
  await assert.rejects(verifyRelease({ ...options, publicKeys: [] }));
  await assert.rejects(verifyRelease({ ...options, now: Date.now() + 8 * 86400_000 }));
  const path = join(directory, 'claude-bridge-0.1.0-linux-x64.tar.gz');
  const original = await readFile(path); await writeFile(path, Buffer.alloc(original.length, 0));
  await assert.rejects(verifyRelease(options)); await writeFile(path, original);
  const manifestPath = join(options.bundle, 'manifest.json');
  const bytes = await readFile(manifestPath, 'utf8'); await writeFile(manifestPath, bytes.replace('agent-inbox-claude-bridge', 'agent-inbox-codex-bridge'));
  await assert.rejects(verifyRelease(options));
});
