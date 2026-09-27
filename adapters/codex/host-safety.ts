import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import type { BridgeConfig } from './gateway.js';

export type HostCode = 'starting' | 'healthy' | 'stopped' | 'not_started' | 'config_invalid' | 'codex_unavailable' | 'auth_failed' | 'instance_conflict' | 'gateway_unreachable' | 'recovery_required';
export type HostEvent = { component: 'gateway' | 'native' | 'registration'; code: HostCode; instanceId?: string; scope?: 'message' | 'management'; endpoint?: string; check?: 'profile' | 'session' | 'management_inbox'; httpStatus?: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hostDirectory = () => join(homedir(), '.agent-inbox', 'codex-host');

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== resolve(directory) || (process.platform !== 'win32' && (await stat(directory)).mode & 0o077)) throw new Error('Unsafe host state directory');
}

export async function acquireHostLocks(config: BridgeConfig, directory = hostDirectory()) {
  await privateDirectory(directory);
  const identities = [digest(`credential:${new URL(config.gatewayUrl).origin}:${config.token}`), digest(`state:${await realpath(config.stateDir)}`)].sort();
  const nonce = randomUUID();
  const owned: string[] = [];
  const release = async () => {
    for (const path of owned.splice(0).reverse()) {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.nonce !== nonce) throw new Error('Host lock ownership changed');
      await unlink(path);
    }
  };
  try {
    for (const identity of identities) {
      const path = join(directory, `${identity}.lock`);
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })); await handle.sync(); }
      finally { await handle.close(); }
      owned.push(path);
    }
    return { release };
  } catch (error) {
    await release();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('instance_conflict');
    throw error;
  }
}

export interface HostSnapshot {
  schemaVersion: 1; code: HostCode; pid: number; updatedAt: string;
  startupFailures: number; lastExitCode: number | null; lastRegisteredAt: string | null;
  instanceId: string | null; gateway: HostCode; native: HostCode;
  checks?: Partial<Record<'profile' | 'session' | 'management_inbox', number>>;
}
export class HostHealth {
  private gatewayFailures = new Map<string, HostCode>();
  private queue = Promise.resolve();
  private snapshot: HostSnapshot;
  readonly path: string;
  constructor(configPath: string, private directory = hostDirectory(), private notify: (record: HostSnapshot) => void = () => {}) {
    this.path = join(directory, `${digest(`config:${resolve(configPath)}`)}.health.json`);
    this.snapshot = { schemaVersion: 1, code: 'starting', pid: process.pid, updatedAt: new Date().toISOString(), startupFailures: 0, lastExitCode: null, lastRegisteredAt: null, instanceId: null, gateway: 'not_started', native: 'not_started' };
  }
  async start() {
    await privateDirectory(this.directory);
    try {
      const previous = JSON.parse(await readFile(this.path, 'utf8')) as HostSnapshot;
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0 && previous.pid !== process.pid) {
        let alive = false;
        try { process.kill(previous.pid, 0); alive = true; } catch {}
        if (alive) throw new Error('Health record belongs to a live process');
      }
      if (Number.isSafeInteger(previous.startupFailures)) this.snapshot.startupFailures = previous.startupFailures;
      if (typeof previous.lastRegisteredAt === 'string' && Number.isFinite(Date.parse(previous.lastRegisteredAt))) this.snapshot.lastRegisteredAt = previous.lastRegisteredAt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unsafe host health record'); }
    await this.save();
  }
  observe(event: HostEvent) {
    const changedCheck = event.check && event.httpStatus !== undefined && this.snapshot.checks?.[event.check] !== event.httpStatus;
    if (event.check && event.httpStatus !== undefined) this.snapshot.checks = { ...this.snapshot.checks, [event.check]: event.httpStatus };
    if (event.component === 'gateway') {
      const key = `${event.scope ?? 'message'}:${event.endpoint ?? ''}`;
      if (event.code === 'healthy') this.gatewayFailures.delete(key);
      else this.gatewayFailures.set(key, event.code);
      this.snapshot.gateway = [...this.gatewayFailures.values()].find(code => code === 'auth_failed' || code === 'instance_conflict') ?? [...this.gatewayFailures.values()][0] ?? 'healthy';
    }
    if (event.component === 'native') this.snapshot.native = event.code;
    if (event.component === 'registration') {
      this.snapshot.lastRegisteredAt = new Date().toISOString();
      this.snapshot.instanceId = event.instanceId ?? null;
    }
    const code = this.snapshot.native === 'codex_unavailable' ? 'codex_unavailable' : this.snapshot.gateway !== 'healthy' ? this.snapshot.gateway : this.snapshot.native === 'healthy' && this.snapshot.instanceId ? 'healthy' : 'starting';
    if (code !== this.snapshot.code || event.component === 'registration' || changedCheck) {
      this.snapshot.code = code; void this.save().catch(() => { console.error('[codex-host] recovery_required: health persistence failed'); });
    }
  }
  async finish(code: HostCode, exitCode: number, startupFailure = false) {
    this.snapshot.code = code; this.snapshot.lastExitCode = exitCode;
    if (startupFailure) this.snapshot.startupFailures++;
    await this.save();
  }
  async flush() { await this.queue; }
  private save() {
    this.snapshot.updatedAt = new Date().toISOString();
    const record = { ...this.snapshot };
    this.queue = this.queue.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
      this.notify(record);
    });
    return this.queue;
  }
}

export async function diagnoseHost(configPath: string, directory = hostDirectory()) {
  const health = new HostHealth(configPath, directory);
  try {
    const record = JSON.parse(await readFile(health.path, 'utf8')) as HostSnapshot;
    let alive = false;
    if (Number.isSafeInteger(record.pid) && record.pid > 0) try { process.kill(record.pid, 0); alive = true; } catch {}
    const codes: HostCode[] = ['starting', 'healthy', 'stopped', 'not_started', 'config_invalid', 'codex_unavailable', 'auth_failed', 'instance_conflict', 'gateway_unreachable', 'recovery_required'];
    const stamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    return { code: !alive && record.code === 'healthy' ? 'not_started' : codes.includes(record.code) ? record.code : 'recovery_required', processAlive: alive, pid: Number.isSafeInteger(record.pid) ? record.pid : null, startupFailures: Number.isSafeInteger(record.startupFailures) ? record.startupFailures : null, lastExitCode: Number.isSafeInteger(record.lastExitCode) ? record.lastExitCode : null, lastRegisteredAt: stamp(record.lastRegisteredAt), instanceId: typeof record.instanceId === 'string' && /^[a-f0-9-]{36}$/i.test(record.instanceId) ? record.instanceId : null, updatedAt: stamp(record.updatedAt), gateway: codes.includes(record.gateway) ? record.gateway : 'recovery_required', native: codes.includes(record.native) ? record.native : 'recovery_required', checks: Object.fromEntries(['profile', 'session', 'management_inbox'].flatMap(key => Number.isInteger(record.checks?.[key as keyof typeof record.checks]) ? [[key, record.checks?.[key as keyof typeof record.checks]]] : [])), observation: alive ? 'local record; PID liveness is not a remote health probe' : 'process not running; last recorded failure retained' };
  } catch (error) {
    return { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_started' : 'recovery_required', processAlive: false };
  }
}

export async function diagnoseSupervisor(root: string) {
  try {
    const record = JSON.parse(await readFile(join(root, 'state', 'supervisor-health.json'), 'utf8'));
    const codes = ['starting', 'healthy', 'stopped', 'not_started', 'config_invalid', 'codex_unavailable', 'auth_failed', 'instance_conflict', 'gateway_unreachable', 'recovery_required'];
    return {
      code: codes.includes(record.code) ? record.code : 'recovery_required',
      pid: Number.isSafeInteger(record.pid) ? record.pid : null,
      startupFailures: Number.isSafeInteger(record.startupFailures) ? record.startupFailures : null,
      lastExitCode: Number.isSafeInteger(record.lastExitCode) ? record.lastExitCode : null,
      lastRegisteredAt: typeof record.lastRegisteredAt === 'string' && Number.isFinite(Date.parse(record.lastRegisteredAt)) ? record.lastRegisteredAt : null,
      instanceId: typeof record.instanceId === 'string' && /^[a-f0-9-]{36}$/i.test(record.instanceId) ? record.instanceId : null,
      retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : null,
    };
  } catch { return { code: 'not_started' }; }
}
