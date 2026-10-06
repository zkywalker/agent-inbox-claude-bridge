import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type ConnectionState = 'starting' | 'connected' | 'retrying' | 'auth_failed' | 'conflict' | 'stopped';
export type HealthReason = 'none' | 'network' | 'authentication' | 'conflict' | 'protocol';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function processStartIdentity(): string {
  try {
    if (process.platform === 'darwin') {
      const start = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim().replace(/\s+/g, ' ');
      return start ? `darwin:${start}` : '';
    }
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(ticks ?? '') && /^[a-f0-9-]{36}$/.test(boot) ? `linux:${boot}:${ticks}` : '';
    }
  } catch { /* Missing process identity makes the snapshot unverified. */ }
  return '';
}

// A public local snapshot, independent of message/session databases and secrets.
// Failure to publish diagnostics must never interrupt the connector itself.
export class LocalHealth {
  readonly path: string;
  private readonly directory: string;
  private readonly identity = processStartIdentity();
  private state: ConnectionState = 'starting';
  private reasonCode: HealthReason = 'none';
  private lastSuccessAt: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private agent: string, private configPath: string, private accountId = '') {
    this.configPath = resolve(configPath);
    this.directory = join(dirname(this.configPath), '.agent-inbox-health');
    this.path = join(this.directory, `${agent}-${hash(`config:${this.configPath}`)}-${hash(accountId)}.json`);
  }
  async start() {
    await this.publish();
    this.timer = setInterval(() => { void this.publish(); }, 15_000).unref();
  }
  success() {
    if (this.closed) return;
    this.state = 'connected'; this.reasonCode = 'none';
    this.lastSuccessAt = new Date().toISOString();
    void this.publish();
  }
  failure(status?: number) {
    if (this.closed) return;
    this.state = status === 401 || status === 403 ? 'auth_failed' : status === 409 ? 'conflict' : 'retrying';
    this.reasonCode = this.state === 'auth_failed' ? 'authentication' : this.state === 'conflict' ? 'conflict' : status ? 'protocol' : 'network';
    void this.publish();
  }
  async stop() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.state = 'stopped';
    await this.publish();
  }
  async flush() { await this.queue; }
  private publish() {
    const record = { schemaVersion: 1, agent: this.agent, configHash: hash(`config:${this.configPath}`), accountId: this.accountId, pid: process.pid, processStartId: this.identity, state: this.state, updatedAt: new Date().toISOString(), ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}), reasonCode: this.reasonCode };
    this.queue = this.queue.then(async () => {
      // Never follow a pre-existing directory symlink or broaden permissions.
      if (await realpath(dirname(this.directory)) !== dirname(this.directory)) return;
      await mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) return;
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => {});
    return this.queue;
  }
}
