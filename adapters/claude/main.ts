import { chmod, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeState } from '../codex/state.js';
import { configSchema, providerEnvironment } from './config.js';
import { ClaudeBridge } from './bridge.js';
import { resolveClaudeBinary, verifyClaudeBinary } from './runtime.js';
import { resolveCodexProvider } from './codex-provider.js';

async function main() {
  const validate = process.argv[2] === '--validate';
  const path = process.argv[validate ? 3 : 2];
  if (!path) throw new Error('Usage: npm run start:claude -- /absolute/private/claude.json');
  if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077)) throw new Error('Private config must have mode 0600');
  const config = await resolveCodexProvider(configSchema.parse(JSON.parse(await readFile(path, 'utf8'))));
  providerEnvironment(config);
  config.projectPath = await realpath(config.projectPath);
  for (const project of [...(config.projects ?? []), ...(config.projectRoots ?? [])]) project.path = await realpath(project.path);
  if (!(await stat(config.projectPath)).isDirectory()) throw new Error('Project must be a directory');
  config.claudeBinary = resolveClaudeBinary(config);
  const version = await verifyClaudeBinary(config.claudeBinary);
  if (validate) { console.log(`Claude bridge configuration and native binary valid (${version}); provider inference not tested.`); return; }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  const lockPath = join(config.stateDir, 'bridge.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let state: BridgeState | undefined;
  let bridge: ClaudeBridge | undefined;
  try {
    await lock.writeFile(String(process.pid));
    state = new BridgeState(join(config.stateDir, 'claude.sqlite'));
    await chmod(join(config.stateDir, 'claude.sqlite'), 0o600);
    bridge = new ClaudeBridge(config, state);
    const profile = await bridge.gateway.call('/connector/profile');
    if (profile.kind !== 'claude' && !(profile.kind === 'custom' && !config.managementToken)) throw new Error('Create a separate Claude contact; legacy custom contacts support messages only');
    bridge.bindIdentity('agent', profile.id);
    await bridge.initialize(version);
    console.log(`Claude bridge ready (${version}); native inference requires a working provider.`);
    process.once('SIGINT', () => bridge?.stop()); process.once('SIGTERM', () => bridge?.stop());
    try { await bridge.run(); } finally { bridge.stop(); }
  } finally { bridge?.stop(); await bridge?.management.close(); state?.close(); await lock.close(); await unlink(lockPath); }
}
main().catch(() => { console.error('Claude bridge startup failed. Check private config permissions, installed Claude binary, state lock, provider environment and gateway authentication.'); process.exitCode = 1; });
