import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Attachment } from '../../shared/protocol.js';
import type { CodexOptions } from '../../shared/codex-settings.js';

export interface BridgeConfig {
  gatewayUrl: string; token: string; managementToken: string;
  accessClientId?: string; accessClientSecret?: string;
  codexBinary: string; stateDir: string;
  allowNativeUpdate?: boolean;
  defaultCodexSettings?: Pick<CodexOptions, 'approvalPolicy' | 'approvalsReviewer' | 'sandboxMode' | 'networkAccess'>;
  projects: { id: string; name: string; path: string }[];
  hostLabel?: string;
  projectRoots?: { id: string; name: string; path: string }[];
  maxFileBytes?: number;
  maxRemoteFileBytes?: number;
  additionalModels?: { model: string; reasoningEfforts?: string[]; defaultReasoningEffort?: string }[];
}
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Inbox request failed (${status}, ${code})`); }
}
export class Gateway {
  readonly base: URL;
  readonly maxFileBytes: number;
  constructor(readonly config: Omit<BridgeConfig, 'codexBinary' | 'managementToken'> & { codexBinary?: string; managementToken?: string }) {
    this.base = new URL(config.gatewayUrl);
    if (this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/' || (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)))) throw new Error('gatewayUrl must be an HTTPS origin (HTTP allowed only on localhost)');
    this.maxFileBytes = Math.min(config.maxFileBytes ?? 25 * 1024 * 1024, 25 * 1024 * 1024);
  }
  async raw(path: string, init: RequestInit = {}, management = false): Promise<Response> {
    if (!path.startsWith('/api/') || new URL(path, this.base).origin !== this.base.origin) throw new Error('Invalid Inbox endpoint');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.config.token}`);
    if (management) {
      if (!this.config.managementToken) throw new Error('Management credential required');
      headers.set('X-Agent-Inbox-Management-Token', this.config.managementToken);
    }
    if (this.config.accessClientId) headers.set('CF-Access-Client-Id', this.config.accessClientId);
    if (this.config.accessClientSecret) headers.set('CF-Access-Client-Secret', this.config.accessClientSecret);
    const response = await fetch(new URL(path, this.base), { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(28_000) });
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      throw new GatewayError(response.status, typeof body.error === 'string' ? body.error.slice(0, 100) : 'request_failed');
    }
    return response;
  }
  async call<T = any>(path: string, body?: unknown, management = false, method?: string): Promise<T> {
    const response = await this.raw(`/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, management);
    if (response.status === 204) return undefined as T;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new GatewayError(401, 'access_login_required');
    return response.json() as Promise<T>;
  }
  async download(attachment: Attachment, conversationId: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(attachment.id) || !/^[a-f0-9-]{36}$/.test(conversationId) || attachment.size > this.maxFileBytes) throw new Error('Attachment is invalid or exceeds size limit');
    const dir = join(this.config.stateDir, 'received', conversationId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const extension = /\.[a-zA-Z0-9]{1,10}$/.exec(attachment.name)?.[0] ?? '';
    const path = join(dir, attachment.id + extension);
    const response = await this.raw(`/api/attachments/${attachment.id}/content`);
    if (Number(response.headers.get('content-length')) > this.maxFileBytes) { await response.body?.cancel(); throw new Error('Attachment exceeds size limit'); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      size += chunk.length; if (size > this.maxFileBytes) throw new Error('Attachment exceeds size limit'); chunks.push(chunk);
    }
    await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
    return path;
  }
  async upload(path: string, projectRoot: string): Promise<Attachment> {
    const file = await safeProjectFile(projectRoot, path, this.maxFileBytes);
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(await readFile(file))]), basename(file));
    const response = await this.raw('/api/attachments', { method: 'POST', body: form });
    return response.json() as Promise<Attachment>;
  }
}
export async function safeProjectFile(root: string, input: string, maxBytes: number) {
  const canonicalRoot = await realpath(root), file = await realpath(resolve(canonicalRoot, input));
  const rel = relative(canonicalRoot, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.startsWith('.') || part.includes(':') || /^(auth\.json|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(part))) throw new Error('File is outside the project or is a protected configuration file');
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Only regular files within the upload limit can be sent');
  return file;
}
