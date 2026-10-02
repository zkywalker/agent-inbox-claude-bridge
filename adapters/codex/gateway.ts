import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Attachment, type Delivery } from '../../shared/protocol.js';
import type { CodexOptions } from '../../shared/codex-settings.js';
import type { HostEvent } from './host-safety.js';

export interface BridgeConfig {
  configVersion?: 1;
  gatewayUrl: string; token: string; managementToken: string;
  accessClientId?: string; accessClientSecret?: string;
  codexBinary: string; stateDir: string;
  allowNativeUpdate?: boolean;
  projects: { id: string; name: string; path: string }[];
  hostLabel?: string;
  projectRoots?: { id: string; name: string; path: string }[];
  maxFileBytes?: number;
  maxRemoteFileBytes?: number;
  additionalModels?: { model: string; reasoningEfforts?: string[]; defaultReasoningEffort?: string }[];
  /** Defaults for new Inbox topics; existing native settings always win. */
  defaultCodexSettings?: Pick<CodexOptions, 'sandboxMode' | 'approvalPolicy' | 'approvalsReviewer' | 'networkAccess'>;
}
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Inbox request failed (${status}, ${code})`); }
}
export class Gateway {
  supportsMessageDeltas = false;
  supportsCodingInput = false;
  private queueClaims = new Map<string, string>();
  onHealth?: (event: HostEvent) => void;
  private inboxPollId = randomUUID();
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
    let response: Response;
    const scope = management ? 'management' : 'message';
    const endpoint = path.split('?')[0].replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, ':id');
    try { response = await fetch(new URL(path, this.base), { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(28_000) }); }
    catch (error) { if (init.signal?.aborted) throw error; this.onHealth?.({ component: 'gateway', code: 'gateway_unreachable', scope, endpoint }); throw new GatewayError(503, 'gateway_unreachable'); }
    if (init.method === 'POST' && /^\/api\/connector\/conversations\/[^/]+\/messages$/.test(path) || init.method === 'PATCH' && path.startsWith('/api/connector/messages/')) {
      this.supportsMessageDeltas = response.headers.get('x-inbox-message-delta') === 'v1';
    }
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      if ([401, 403].includes(response.status)) this.onHealth?.({ component: 'gateway', code: 'auth_failed', scope, endpoint });
      else if (response.status === 409 && body.error === 'reconnect') this.onHealth?.({ component: 'gateway', code: 'instance_conflict', scope, endpoint });
      else if (response.status >= 500) this.onHealth?.({ component: 'gateway', code: 'gateway_unreachable', scope, endpoint });
      throw new GatewayError(response.status, typeof body.error === 'string' ? body.error.slice(0, 100) : 'request_failed');
    }
    const check = path.startsWith('/api/connector/codex/session') ? 'session' : path.startsWith('/api/connector/codex/inbox?') ? 'management_inbox' : path === '/api/connector/profile' ? 'profile' : undefined;
    if (response.status === 204 || response.headers.get('content-type')?.includes('application/json') || !path.startsWith('/api/connector/')) this.onHealth?.({ component: 'gateway', code: 'healthy', scope, endpoint, ...(check ? { check, httpStatus: response.status } : {}) });
    return response;
  }
  async call<T = any>(path: string, body?: unknown, management = false, method?: string, signal?: AbortSignal): Promise<T> {
    const response = await this.raw(`/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(28_000)]) } : {}), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, management);
    if (response.status === 204) return undefined as T;
    if (!response.headers.get('content-type')?.includes('application/json')) { this.onHealth?.({ component: 'gateway', code: 'auth_failed', scope: management ? 'management' : 'message', endpoint: `/api${path}`.split('?')[0].replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, ':id') }); throw new GatewayError(401, 'access_login_required'); }
    return response.json() as Promise<T>;
  }
  async pollInbox(options: { signal?: AbortSignal; claudeInstanceId?: string; codingInstanceId?: string } = {}): Promise<{ deliveries: Delivery[] }> {
    // Keep this key only while recovering a response that never reached the
    // input handler. It is deliberately not persisted across process restarts.
    const query = new URLSearchParams({ wait: '20', pollId: this.inboxPollId });
    if (options.claudeInstanceId) query.set('claudeInstanceId', options.claudeInstanceId);
    if (this.supportsCodingInput && options.codingInstanceId) query.set('codingInstanceId', options.codingInstanceId);
    const result = await this.call<unknown>(`/connector/inbox?${query}`, undefined, false, undefined, options.signal);
    if (!validInbox(result)) throw new GatewayError(502, 'invalid_inbox_response');
    // Rotate before the caller can submit any native input or send an ACK.
    this.inboxPollId = randomUUID();
    return result;
  }
  pendingQueuedTopics() { return [...this.queueClaims.keys()]; }
  async claimQueued(conversationId: string, instanceId: string): Promise<Delivery | null> {
    const clientRequestId = this.queueClaims.get(conversationId) ?? randomUUID();
    this.queueClaims.set(conversationId, clientRequestId);
    const result = await this.call<{ delivery: Delivery | null }>('/connector/coding/queue/claim', { conversationId, instanceId, clientRequestId }, true);
    if (result.delivery !== null && !validInbox({ protocolVersion: PROTOCOL_VERSION, deliveries: [result.delivery] })) throw new GatewayError(502, 'invalid_inbox_response');
    this.queueClaims.delete(conversationId);
    return result.delivery;
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
function validInbox(value: unknown): value is { deliveries: Delivery[] } {
  const record = (item: unknown): item is Record<string, any> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const uuid = (item: unknown) => typeof item === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item);
  const message = (item: unknown): item is Record<string, any> => record(item) && uuid(item.id) && uuid(item.conversationId)
    && typeof item.text === 'string' && ['user', 'agent'].includes(item.role) && ['chat', 'activity', 'system'].includes(item.kind)
    && ['received', 'sending', 'delivered', 'failed'].includes(item.status) && Array.isArray(item.attachments)
    && item.attachments.every((file: unknown) => record(file) && uuid(file.id) && typeof file.name === 'string'
      && typeof file.mimeType === 'string' && typeof file.url === 'string' && Number.isSafeInteger(file.size) && file.size >= 0);
  return record(value) && value.protocolVersion === PROTOCOL_VERSION && Array.isArray(value.deliveries) && value.deliveries.length <= 10
    && value.deliveries.every((item: unknown) => record(item) && uuid(item.id) && record(item.conversation)
      && uuid(item.conversation.id) && uuid(item.conversation.agentId) && message(item.message) && item.message.role === 'user'
      && item.message.conversationId === item.conversation.id && Array.isArray(item.history) && item.history.length <= 40
      && item.history.every((entry: unknown) => message(entry) && entry.conversationId === item.conversation.id));
}
export async function safeProjectFile(root: string, input: string, maxBytes: number) {
  const canonicalRoot = await realpath(root), file = await realpath(resolve(canonicalRoot, input));
  const rel = relative(canonicalRoot, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.startsWith('.') || part.includes(':') || /^(auth\.json|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(part))) throw new Error('File is outside the project or is a protected configuration file');
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Only regular files within the upload limit can be sent');
  return file;
}
