import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const platforms = ['linux-x64', 'darwin-x64', 'darwin-arm64'];
const maxAssetBytes = 256 * 1024 * 1024;
const validityMs = 7 * 24 * 60 * 60 * 1000;
const domain = 'agent-inbox-claude-bridge-manifest:v1\n';

async function assetMetadata(directory, version, platform) {
  const name = `claude-bridge-${version}-${platform}.tar.gz`;
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxAssetBytes)) throw new Error('Invalid release asset');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxAssetBytes) throw new Error('Release asset exceeds size limit');
      hash.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Release asset changed during hashing');
    return { platform, name, size, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

export async function createReleaseManifest({ directory, version, privateKeyPem, now = Date.now() }) {
  if (typeof version !== 'string' || version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected a stable release version');
  if (!Number.isFinite(now)) throw new Error('Invalid release time');
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----') || privateKeyPem.length > 4096) throw new Error('Release signing key is not configured');
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires Ed25519');
  const keyId = createHash('sha256').update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const assets = [];
  for (const platform of platforms) assets.push(await assetMetadata(directory, version, platform));
  const manifest = { schemaVersion: 1, repository: 'zkywalker/agent-inbox-claude-bridge', version, publishedAt: new Date(now).toISOString(), expiresAt: new Date(now + validityMs).toISOString(), assets };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, Buffer.concat([Buffer.from(`${domain}${keyId}\n`), bytes]), privateKey).toString('base64');
  const envelope = { schemaVersion: 1, algorithm: 'ed25519', keyId, signature };
  const output = join(directory, 'signed-manifest');
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [name, content] of [['manifest.json', bytes], ['manifest.sig.json', `${JSON.stringify(envelope, null, 2)}\n`]]) {
      const file = await open(join(output, name), 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    }
    await rename(output, join(directory, 'manifest-bundle'));
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return { keyId, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const privateKeyPem = process.env.BRIDGE_MANIFEST_SIGNING_KEY;
  delete process.env.BRIDGE_MANIFEST_SIGNING_KEY;
  try {
    if (process.argv.length !== 4) throw new Error('Invalid arguments');
    await createReleaseManifest({ directory: resolve(process.argv[2]), version: process.argv[3], privateKeyPem });
    console.log('Bridge manifest signed.');
  } catch {
    console.error('Bridge manifest generation failed; check the protected signing key, version and release assets.');
    process.exitCode = 1;
  }
}
