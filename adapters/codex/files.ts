import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Attachment } from '../../shared/protocol.js';
import { Gateway, GatewayError, safeProjectFile } from './gateway.js';
import type { BridgeState, PublishedFile } from './state.js';
import type { Projects } from './projects.js';
import type { FilePolicy, FileReferenceRequest } from '../../shared/file-references.js';
import { safeReferenceFile } from './file-references.js';

const chunkBytes = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Transfer = { id: string; attachmentId: string; method: 'GET' | 'HEAD'; policy?: FilePolicy };
export interface FileTransferFailure {
  event: 'file_transfer_failed'; transferId: string; method: 'GET' | 'HEAD';
  confirmedOffset: number; blockBytes: number; elapsedMs: number; blockElapsedMs: number;
  status?: number; code?: string;
}
const networkCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED',
]);
function failureCode(error: unknown): string {
  if (error instanceof FileError) return error.code;
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } : undefined;
  if (value?.name === 'TimeoutError') return 'timeout';
  if (value?.name === 'AbortError') return 'aborted';
  for (const code of [value?.code, value?.cause?.code]) if (typeof code === 'string' && networkCodes.has(code)) return code;
  if (value?.code === 'ENOENT') return 'file_missing';
  return 'unknown';
}
class FileError extends Error {
  constructor(readonly code: 'file_missing' | 'file_changed' | 'file_unavailable' | 'file_not_allowed') { super(code); }
}
const version = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');

/** The private host registry is the only place that maps a download ID to a path. */
export class OnlineFiles {
  private stopped = new AbortController();
  private tasks = new Map<string, Promise<void>>();
  readonly maxBytes: number;
  constructor(private gateway: Gateway, private state: BridgeState, private projects: Projects,
    private reportFailure: (event: FileTransferFailure) => void = event => console.error(`[codex-bridge] ${JSON.stringify(event)}`)) {
    this.maxBytes = Math.min(gateway.config.maxRemoteFileBytes ?? 2 * 1024 ** 3, 2 * 1024 ** 3);
  }
  async publish(input: string, projectId: string, conversationId: string, callKey: string, reference?: FileReferenceRequest): Promise<Attachment> {
    await this.projects.validate(projectId);
    const project = this.gateway.config.projects.find(project => project.id === projectId);
    if (!project) throw new FileError('file_unavailable');
    let file = this.state.publishedFile(callKey);
    if (!file) {
      const projectRoot = await realpath(project.path);
      if (projectRoot !== project.path) throw new FileError('file_unavailable');
      const path = reference ? await safeReferenceFile(projectRoot, input, reference.policy, this.maxBytes) : await safeProjectFile(projectRoot, input, this.maxBytes);
      const info = await stat(path, { bigint: true });
      file = { clientFileId: randomUUID(), projectId, conversationId, projectRoot, path, name: basename(path), size: Number(info.size), version: version(info), ...(reference ? { referencePath: input } : {}) };
      // Persist before the HTTP request, so uncertain retries reuse the same ID.
      this.state.saveFile(callKey, file);
    }
    if (file.projectId !== projectId || file.conversationId !== conversationId) throw new FileError('file_unavailable');
    const attachment = await this.gateway.call<Attachment>(`/connector/conversations/${conversationId}/files`, {
      clientFileId: file.clientFileId, name: file.name, size: file.size,
      ...(reference ? { referenceRequestId: reference.id } : {}),
    });
    if (!uuid.test(attachment.id) || attachment.size !== file.size || attachment.source !== 'remote') throw new FileError('file_unavailable');
    file.attachmentId = attachment.id;
    this.state.saveFile(callKey, file);
    return attachment;
  }
  private async checked(file: PublishedFile, policy?: FilePolicy): Promise<FileHandle> {
    await this.projects.validate(file.projectId);
    const project = this.gateway.config.projects.find(project => project.id === file.projectId);
    if (!project || file.size > this.maxBytes || project.path !== file.projectRoot || await realpath(project.path) !== file.projectRoot) throw new FileError('file_unavailable');
    if (file.referencePath) {
      if (!policy) throw new FileError('file_not_allowed');
      let checkedPath: string;
      try { checkedPath = await safeReferenceFile(file.projectRoot, file.referencePath, policy, this.maxBytes); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw error; throw new FileError('file_not_allowed'); }
      if (checkedPath !== file.path) throw new FileError('file_changed');
    }
    let handle: FileHandle | undefined;
    try {
      // The registered size already met the limit. A later growth is a changed
      // version (409), including growth past the configured maximum.
      const path = await safeProjectFile(file.projectRoot, file.path, Number.MAX_SAFE_INTEGER);
      if (path !== file.path) throw new FileError('file_changed');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || version(info) !== file.version || await realpath(path) !== path) throw new FileError('file_changed');
      // Compare the path again after opening, including inode identity, to catch
      // replacement of the final component or a parent while resolving it.
      if (version(await stat(path, { bigint: true })) !== file.version) throw new FileError('file_changed');
      return handle;
    } catch (error) { await handle?.close(); throw error; }
  }
  async transfer(request: Transfer): Promise<void> {
    if (!uuid.test(request.id) || !uuid.test(request.attachmentId) || !['HEAD', 'GET'].includes(request.method)) return;
    let handle: FileHandle | undefined;
    const started = Date.now();
    let confirmedOffset = 0, blockBytes = 0, blockStarted = started;
    try {
      const file = this.state.fileForAttachment(request.attachmentId);
      if (!file) throw new FileError('file_missing');
      handle = await this.checked(file, request.policy);
      if (request.method === 'HEAD' || file.size === 0) {
        const response = await this.gateway.raw(`/api/connector/file-transfers/${request.id}/content?offset=0`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' }, body: new Uint8Array(),
          signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(90_000)]),
        });
        await response.body?.cancel(); return;
      }
      // Keep at most one fixed-size chunk in memory, regardless of artifact size.
      // A chunk is checked before sending; HTTP bodies stay below edge limits.
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, file.size));
      for (; confirmedOffset < file.size;) {
        blockBytes = Math.min(buffer.length, file.size - confirmedOffset);
        blockStarted = Date.now();
        this.stopped.signal.throwIfAborted();
        if (version(await handle.stat({ bigint: true })) !== file.version) throw new FileError('file_changed');
        const length = blockBytes;
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, confirmedOffset + read);
          if (!bytesRead) throw new FileError('file_changed');
          read += bytesRead;
        }
        if (version(await handle.stat({ bigint: true })) !== file.version) throw new FileError('file_changed');
        const response = await this.gateway.raw(`/api/connector/file-transfers/${request.id}/content?offset=${confirmedOffset}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
          body: new Uint8Array(buffer.buffer, buffer.byteOffset, length),
          signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(90_000)]),
        });
        await response.body?.cancel(); confirmedOffset += length;
      }
    } catch (error) {
      // Construct from fixed fields only: upstream errors can contain private paths,
      // URLs, credentials or response bodies. Never serialize the error itself.
      try {
        this.reportFailure({
          event: 'file_transfer_failed', transferId: request.id, method: request.method,
          confirmedOffset, blockBytes, elapsedMs: Math.max(0, Date.now() - started), blockElapsedMs: Math.max(0, Date.now() - blockStarted),
          ...(error instanceof GatewayError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
            ? { status: error.status } : { code: failureCode(error) }),
        });
      } catch { /* Diagnostics never change transfer cleanup or failure handling. */ }
      if (this.stopped.signal.aborted || error instanceof GatewayError && [401, 403, 404, 409, 410].includes(error.status)) return;
      const code = error instanceof FileError ? error.code : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file_missing' : 'file_unavailable';
      // Only fixed public error codes cross the gateway; host paths stay local.
      await this.gateway.call(`/connector/file-transfers/${request.id}/error`, { code }).catch(() => {});
    } finally { await handle?.close(); }
  }
  async resolveReference(request: FileReferenceRequest) {
    if (!uuid.test(request.id) || !uuid.test(request.conversationId) || typeof request.path !== 'string' || request.path.length > 4096) return;
    try {
      const attachment = await this.publish(request.path, request.projectId, request.conversationId, `reference:${request.id}`, request);
      // Only expose the result after the host registry knows the attachment ID.
      await this.gateway.call(`/connector/file-references/${request.id}/result`, { attachmentId: attachment.id });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file_missing' : error instanceof GatewayError ? 'file_unavailable' : 'file_not_allowed';
      await this.gateway.call(`/connector/file-references/${request.id}/result`, { error: code }).catch(() => {});
    }
  }
  async run(onError: () => void) {
    while (!this.stopped.signal.aborted) {
      try {
        const response = await this.gateway.raw('/api/connector/file-transfers?wait=20&references=1', {
          signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(28_000)]),
        });
        const body = await response.json() as { transfers: Transfer[]; references?: FileReferenceRequest[] };
        if (!Array.isArray(body.transfers)) throw new Error('Invalid transfer inbox');
        for (const request of (body.references ?? []).slice(0, 2)) {
          if (this.tasks.has(request.id)) continue;
          if (this.tasks.size >= 4) { await this.gateway.call(`/connector/file-references/${request.id}/result`, { error: 'file_unavailable' }).catch(() => {}); continue; }
          const task = this.resolveReference(request).catch(onError);
          this.tasks.set(request.id, task); void task.finally(() => this.tasks.delete(request.id));
        }
        for (const request of body.transfers.slice(0, 4)) {
          if (this.tasks.has(request.id)) continue;
          if (this.tasks.size >= 4) {
            await this.gateway.call(`/connector/file-transfers/${request.id}/error`, { code: 'file_unavailable' }).catch(() => {});
            continue;
          }
          const task = this.transfer(request).catch(onError);
          this.tasks.set(request.id, task); void task.finally(() => this.tasks.delete(request.id));
        }
      } catch {
        if (this.stopped.signal.aborted) break;
        onError(); await delay(1500, undefined, { signal: this.stopped.signal }).catch(() => {});
      }
    }
    await Promise.allSettled(this.tasks.values());
  }
  stop() { this.stopped.abort(); }
}
