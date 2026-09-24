import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyRelease({ directory, bundle, publicKeys, version, now = Date.now() }) {
  const bytes = await readFile(join(bundle, 'manifest.json'));
  if (bytes.length > 64 * 1024) throw new Error('Manifest exceeds limit');
  const envelope = JSON.parse(await readFile(join(bundle, 'manifest.sig.json'), 'utf8'));
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'ed25519' || typeof envelope.signature !== 'string') throw new Error('Invalid signature envelope');
  const keys = publicKeys.map(pem => createPublicKey(pem));
  const key = keys.find(key => key.asymmetricKeyType === 'ed25519' && createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') === envelope.keyId);
  if (!key || !verify(null, Buffer.concat([Buffer.from(`agent-inbox-claude-bridge-manifest:v1\n${envelope.keyId}\n`), bytes]), key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Untrusted manifest');
  const manifest = JSON.parse(bytes);
  const published = Date.parse(manifest.publishedAt), expires = Date.parse(manifest.expiresAt);
  if (manifest.schemaVersion !== 1 || manifest.repository !== 'zkywalker/agent-inbox-claude-bridge' || manifest.version !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !Number.isFinite(published) || !Number.isFinite(expires) || published > now + 300_000 || expires <= now || expires <= published || expires - published > 7 * 86400_000 || manifest.assets?.length !== 3) throw new Error('Invalid release identity or validity');
  for (const platform of ['linux-x64', 'darwin-x64', 'darwin-arm64']) {
    const matching = manifest.assets.filter(asset => asset.platform === platform);
    if (matching.length !== 1) throw new Error('Missing or duplicate platform');
    const asset = matching[0], name = `claude-bridge-${version}-${platform}.tar.gz`;
    if (asset.name !== name || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid asset metadata');
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.size !== asset.size) throw new Error('Asset size mismatch');
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== asset.sha256) throw new Error('Asset digest mismatch');
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6) throw new Error('Expected directory, manifest bundle, pinned public-key file and version');
    await verifyRelease({ directory: resolve(process.argv[2]), bundle: resolve(process.argv[3]), publicKeys: JSON.parse(await readFile(process.argv[4], 'utf8')), version: process.argv[5] });
    console.log('Claude release signature, repository, validity and all three asset hashes verified.');
  } catch { console.error('Claude release verification failed. Do not install these assets.'); process.exitCode = 1; }
}
