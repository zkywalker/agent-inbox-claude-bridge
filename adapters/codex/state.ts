import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CodexSession } from '../../shared/codex.js';
import type { RuntimeReport, CodexUpdateInfo } from '../../shared/runtime.js';
import type { MessageKind, MessageProcess } from '../../shared/protocol.js';
import type { CodexOptions } from '../../shared/codex-settings.js';

export interface Session extends CodexSession { provider: string; usage?: RuntimeReport['usage']; lastUsedModel?: string; reasoningEffort?: string | null; environment?: RuntimeReport['environment']; settingsRevision?: number; nativeSettings?: Record<string, any>; initialOptions?: CodexOptions }
export interface Outgoing { key: string; conversationId: string; text: string; kind: MessageKind; label?: string; streaming: boolean; attachmentIds?: string[]; process?: MessageProcess }
export interface PublishedFile {
  clientFileId: string; attachmentId?: string; conversationId: string; projectId: string;
  projectRoot: string; path: string; name: string; size: number; version: string;
  referencePath?: string;
}
export interface ManagedConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiMode: string;
  models: string[];
  apiKey: string;
  providerId: string;
  envKey: string;
}
export const stableKey = (key: string) => createHash('sha256').update(key).digest('hex');
const processKey = (threadId: string, turnId: string) => stableKey(JSON.stringify(['process', threadId, turnId]));

export class BridgeState {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (message_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing (key TEXT PRIMARY KEY, body TEXT NOT NULL, message_id TEXT, revision INTEGER NOT NULL, sent_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS processes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_results (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_directories (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, path TEXT NOT NULL, UNIQUE(root_id,path));
      CREATE TABLE IF NOT EXISTS registered_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, directory_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS native_update (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_connections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS published_files (call_key TEXT PRIMARY KEY, body TEXT NOT NULL);
      UPDATE inputs SET state='uncertain' WHERE state='processing';`);
    this.loseRuntime();
  }
  /** A lost child cannot attest how its unfinished runs ended. */
  loseRuntime() {
    for (const row of this.db.prepare('SELECT body FROM processes').all()) {
      const process: MessageProcess = JSON.parse(row.body as string);
      if (process.state === 'running' || process.state === 'waiting') this.saveProcess({ ...process, state: 'unknown' });
    }
    // Persisted streams must not stay spinning after the child has gone.
    for (const row of this.db.prepare('SELECT key,body FROM outgoing').all()) {
      const message: Outgoing = JSON.parse(row.body as string);
      if (message.streaming) this.put({ ...message, streaming: false });
    }
  }
  sessions(): Session[] { return this.db.prepare('SELECT body FROM sessions').all().map(row => JSON.parse(row.body as string)); }
  nativeUpdate(): CodexUpdateInfo | undefined {
    const row = this.db.prepare('SELECT body FROM native_update WHERE id=1').get();
    return row ? JSON.parse(row.body as string) : undefined;
  }
  saveNativeUpdate(info: CodexUpdateInfo) { this.db.prepare('INSERT INTO native_update VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(info)); }
  managedConnections(): ManagedConnection[] { return this.db.prepare('SELECT body FROM managed_connections ORDER BY id').all().map(row => JSON.parse(row.body as string)); }
  saveManagedConnections(connections: ManagedConnection[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM managed_connections');
      const statement = this.db.prepare('INSERT INTO managed_connections(id,body) VALUES(?,?)');
      for (const connection of connections) statement.run(connection.id, JSON.stringify(connection));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(session: Session) { this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(session.conversationId, JSON.stringify(session)); }
  input(id: string): string | undefined { return this.db.prepare('SELECT state FROM inputs WHERE message_id=?').get(id)?.state as string | undefined; }
  markInput(id: string, state: string) { this.db.prepare('INSERT INTO inputs VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET state=excluded.state').run(id, state); }
  outgoing(key: string): Outgoing | undefined {
    const row = this.db.prepare('SELECT body FROM outgoing WHERE key=?').get(stableKey(key));
    return row ? JSON.parse(row.body as string) : undefined;
  }
  put(message: Outgoing) {
    // A delayed item update must use the current durable lifecycle state.
    if (message.process) message = { ...message, process: this.process(message.process.id) ?? message.process };
    this.db.prepare('INSERT INTO outgoing(key,body,revision) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=outgoing.revision+1').run(stableKey(message.key), JSON.stringify(message));
  }
  process(id: string): MessageProcess | undefined {
    const row = this.db.prepare('SELECT body FROM processes WHERE id=?').get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  beginProcess(conversationId: string, threadId: string, turnId: string, startedAt: string): MessageProcess {
    const id = processKey(threadId, turnId), prior = this.process(id);
    if (prior) return prior;
    const process: MessageProcess = { id, state: 'running', startedAt };
    this.db.prepare('INSERT INTO processes VALUES(?,?,?)').run(id, conversationId, JSON.stringify(process));
    return process;
  }
  turnProcess(threadId: string, turnId: string | null | undefined): MessageProcess | undefined {
    return turnId ? this.process(processKey(threadId, turnId)) : undefined;
  }
  updateProcess(threadId: string, turnId: string | null | undefined, state: MessageProcess['state'], completedAt?: string) {
    const prior = this.turnProcess(threadId, turnId);
    if (!prior || !['running', 'waiting'].includes(prior.state)) return;
    this.saveProcess({ id: prior.id, startedAt: prior.startedAt, state, ...(completedAt ? { completedAt } : {}) });
  }
  private saveProcess(process: MessageProcess) {
    // Commit the lifecycle and every pending/published record together, including
    // records outside the outbox's current upload batch or the browser's page.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE processes SET body=? WHERE id=?').run(JSON.stringify(process), process.id);
      for (const row of this.db.prepare("SELECT body FROM outgoing WHERE json_extract(body,'$.process.id')=?").all(process.id))
        this.put({ ...JSON.parse(row.body as string), process });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dirty() { return this.db.prepare('SELECT * FROM outgoing WHERE revision>sent_revision ORDER BY rowid LIMIT 30').all(); }
  finishStreams(conversationId: string) {
    for (const row of this.db.prepare("SELECT body FROM outgoing WHERE json_extract(body,'$.conversationId')=? AND json_extract(body,'$.streaming')=1").all(conversationId)) this.put({ ...JSON.parse(row.body as string), streaming: false });
  }
  sent(key: string, messageId: string, revision: number) { this.db.prepare('UPDATE outgoing SET message_id=?,sent_revision=? WHERE key=?').run(messageId, revision, key); }
  tool(id: string): any { const row = this.db.prepare('SELECT body FROM tool_results WHERE id=?').get(id); return row ? JSON.parse(row.body as string) : undefined; }
  saveTool(id: string, result: any) { this.db.prepare('INSERT OR REPLACE INTO tool_results VALUES(?,?)').run(id, JSON.stringify(result)); }
  publishedFile(key: string): PublishedFile | undefined {
    const row = this.db.prepare('SELECT body FROM published_files WHERE call_key=?').get(stableKey(key));
    return row ? JSON.parse(row.body as string) : undefined;
  }
  fileForAttachment(id: string): PublishedFile | undefined {
    const row = this.db.prepare("SELECT body FROM published_files WHERE json_extract(body,'$.attachmentId')=?").get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  saveFile(key: string, file: PublishedFile) {
    this.db.prepare('INSERT INTO published_files VALUES(?,?) ON CONFLICT(call_key) DO UPDATE SET body=excluded.body').run(stableKey(key), JSON.stringify(file));
  }
  close() { this.db.close(); }
}
