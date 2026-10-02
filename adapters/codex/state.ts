import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CodexSession } from '../../shared/codex.js';
import type { RuntimeReport, CodexUpdateInfo } from '../../shared/runtime.js';
import type { MessageKind, MessageProcess, RuntimeActivity } from '../../shared/protocol.js';
import type { CodexOptions } from '../../shared/codex-settings.js';

export interface Session extends CodexSession { provider: string; usage?: RuntimeReport['usage']; lastUsedModel?: string; reasoningEffort?: string | null; environment?: RuntimeReport['environment']; settingsRevision?: number; nativeSettings?: Record<string, any>; initialOptions?: CodexOptions }
export interface Outgoing { key: string; conversationId: string; text: string; kind: MessageKind; label?: string; streaming: boolean; attachmentIds?: string[]; process?: MessageProcess; runtimeActivity?: RuntimeActivity; proactive?: boolean; notificationProcessId?: string }
export interface OutgoingFailure { revision: number; attempts: number; retryAt: number; blocked: boolean; status: number | null; reason: string; failedAt: number }
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
  private streamingOutput = new Set<string>();
  private pendingOutput = new Map<string, Outgoing>();
  private outputTimer?: ReturnType<typeof setTimeout>;
  private outputListeners = new Set<() => void>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (message_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing (key TEXT PRIMARY KEY, body TEXT NOT NULL, message_id TEXT, revision INTEGER NOT NULL, sent_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outgoing_text_deltas (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outgoing_text_keys ON outgoing_text_deltas(key,seq);
      CREATE TABLE IF NOT EXISTS outgoing_failures (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing_attempts (key TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_reports (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, sent_revision INTEGER NOT NULL DEFAULT 0, reported_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS processes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS process_progress_items (process_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(process_id,item_key));
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
      const message = this.materialize(row.key as string, row.body as string);
      if (message.streaming) this.put({ ...message, streaming: false });
    }
  }
  sessions(): Session[] { return this.db.prepare('SELECT body FROM sessions').all().map(row => JSON.parse(row.body as string)); }
  session(id: string): Session | undefined { const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.body as string) : undefined; }
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
  save(session: Session) {
    const body = JSON.stringify(session);
    if (this.db.prepare('SELECT body FROM sessions WHERE id=?').get(session.conversationId)?.body === body) return;
    this.db.exec('SAVEPOINT session_save');
    try {
      this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(session.conversationId, body);
      this.db.prepare('INSERT INTO session_reports(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET revision=revision+1').run(session.conversationId);
      this.db.exec('RELEASE session_save');
    } catch (error) { this.db.exec('ROLLBACK TO session_save; RELEASE session_save'); throw error; }
  }
  dirtySessions(limit = 30): Session[] {
    return this.db.prepare('SELECT s.body FROM sessions s LEFT JOIN session_reports r ON s.id=r.id WHERE r.id IS NULL OR r.revision>r.sent_revision ORDER BY COALESCE(r.reported_at,0),s.rowid LIMIT ?').all(limit).map(row => JSON.parse(row.body as string));
  }
  sessionRevision(id: string): number { return Number(this.db.prepare('SELECT revision FROM session_reports WHERE id=?').get(id)?.revision ?? 0); }
  sessionReport(id: string) { return this.db.prepare('SELECT * FROM session_reports WHERE id=?').get(id); }
  markSessionDirty(id: string) { this.db.prepare('INSERT INTO session_reports(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET revision=revision+1').run(id); }
  invalidateSessionReports() { this.db.prepare('UPDATE session_reports SET revision=revision+1,sent_revision=-1').run(); }
  postponeSessionReport(id: string, at: number) { this.db.prepare('UPDATE session_reports SET reported_at=? WHERE id=?').run(at, id); }
  hasUnfinishedSessions() { return !!this.db.prepare("SELECT 1 FROM sessions WHERE json_extract(body,'$.state') IN ('running','waiting','unknown') LIMIT 1").get(); }
  reportedSession(id: string, revision: number, at: number) {
    this.db.prepare('INSERT INTO session_reports(id,revision,sent_revision,reported_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET sent_revision=MAX(sent_revision,excluded.sent_revision),reported_at=excluded.reported_at').run(id, revision, revision, at);
  }
  input(id: string): string | undefined { return this.db.prepare('SELECT state FROM inputs WHERE message_id=?').get(id)?.state as string | undefined; }
  markInput(id: string, state: string) { this.db.prepare('INSERT INTO inputs VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET state=excluded.state').run(id, state); }
  outgoing(key: string): Outgoing | undefined {
    if (this.pendingOutput.has(key)) return this.pendingOutput.get(key);
    const row = this.db.prepare('SELECT body FROM outgoing WHERE key=?').get(stableKey(key));
    return row ? this.materialize(stableKey(key), row.body as string) : undefined;
  }
  private materialize(key: string, body: string): Outgoing {
    const message: Outgoing = JSON.parse(body);
    const tails = this.db.prepare('SELECT text FROM outgoing_text_deltas WHERE key=? ORDER BY seq').all(key);
    if (tails.length) message.text += tails.map(row => row.text as string).join('');
    return message;
  }
  subscribeOutgoing(listener: () => void) { this.outputListeners.add(listener); return () => { this.outputListeners.delete(listener); }; }
  private outputChanged() { for (const listener of this.outputListeners) listener(); }
  /** First output and completion commit immediately; only unpublished text is coalesced. */
  queue(message: Outgoing) {
    if (!message.streaming || !this.streamingOutput.has(message.key)) { this.put(message); return; }
    this.pendingOutput.set(message.key, message);
    let size = 0;
    for (const pending of this.pendingOutput.values()) size += pending.text.length;
    if (this.pendingOutput.size >= 64 || size >= 1024 * 1024) { this.flushBuffered(); return; }
    if (!this.outputTimer) this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      try { this.flushBuffered(); } catch { this.outputChanged(); }
    }, 120);
  }
  flushBuffered() {
    clearTimeout(this.outputTimer); this.outputTimer = undefined;
    if (!this.pendingOutput.size) return;
    const messages = [...this.pendingOutput.values()];
    this.db.exec('SAVEPOINT outgoing_batch');
    try {
      for (let message of messages) {
        if (message.process) message = { ...message, process: this.process(message.process.id) ?? message.process };
        const key = stableKey(message.key), row = this.db.prepare('SELECT body FROM outgoing WHERE key=?').get(key);
        const base: Outgoing | undefined = row ? JSON.parse(row.body as string) : undefined;
        const previous = row ? this.materialize(key, row.body as string) : undefined;
        if (base && previous && message.text.startsWith(previous.text) && message.text.length - base.text.length < 64 * 1024 && Number(this.db.prepare('SELECT COUNT(*) AS n FROM outgoing_text_deltas WHERE key=?').get(key)?.n) < 128) {
          if (message.text.length > previous.text.length) this.db.prepare('INSERT INTO outgoing_text_deltas(key,text) VALUES(?,?)').run(key, message.text.slice(previous.text.length));
          this.db.prepare('UPDATE outgoing SET body=?,revision=revision+1 WHERE key=?').run(JSON.stringify({ ...message, text: base.text }), key);
        } else this.persistOutput(message);
      }
      this.db.exec('RELEASE outgoing_batch');
      this.pendingOutput.clear();
    } catch (error) { this.db.exec('ROLLBACK TO outgoing_batch; RELEASE outgoing_batch'); throw error; }
    this.outputChanged();
  }
  put(message: Outgoing) {
    // A delayed item update must use the current durable lifecycle state.
    if (message.process) message = { ...message, process: this.process(message.process.id) ?? message.process };
    this.db.exec('SAVEPOINT outgoing_put');
    try { this.persistOutput(message); this.db.exec('RELEASE outgoing_put'); this.pendingOutput.delete(message.key);
      this.streamingOutput.delete(message.key);
      if (message.streaming) this.streamingOutput.add(message.key);
      if (this.streamingOutput.size > 256) this.streamingOutput.delete(this.streamingOutput.values().next().value!); }
    catch (error) { this.db.exec('ROLLBACK TO outgoing_put; RELEASE outgoing_put'); throw error; }
    this.outputChanged();
  }
  private persistOutput(message: Outgoing) {
    this.db.prepare('INSERT INTO outgoing(key,body,revision) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=outgoing.revision+1').run(stableKey(message.key), JSON.stringify(message));
    this.db.prepare('DELETE FROM outgoing_text_deltas WHERE key=?').run(stableKey(message.key));
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
    // A sentinel proves coverage began with this turn, including zero tool calls.
    this.db.prepare('INSERT INTO process_progress_items VALUES(?,?,?,?)').run(id, '', 'start', '');
    return process;
  }
  observeProgress(id: string, key: string, kind: NonNullable<MessageProcess['progress']>['kind'], summary: string, fingerprint: string, observedAt: string) {
    const process = this.process(id);
    if (!process || !['running', 'waiting'].includes(process.state) || !summary.trim()) return;
    const itemKey = stableKey(key);
    const prior = this.db.prepare('SELECT fingerprint FROM process_progress_items WHERE process_id=? AND item_key=?').get(id, itemKey);
    if (prior?.fingerprint === fingerprint) return;
    this.db.exec('SAVEPOINT process_progress');
    try {
      this.db.prepare('INSERT INTO process_progress_items VALUES(?,?,?,?) ON CONFLICT(process_id,item_key) DO UPDATE SET fingerprint=excluded.fingerprint').run(id, itemKey, kind, fingerprint);
      const complete = this.db.prepare("SELECT 1 FROM process_progress_items WHERE process_id=? AND item_key=''").get(id);
      const toolCalls = complete ? Number(this.db.prepare("SELECT COUNT(*) AS count FROM process_progress_items WHERE process_id=? AND kind='tool'").get(id)!.count) : undefined;
      const progress = { kind, summary: summary.trim().slice(0, 240), observedAt, ...(toolCalls !== undefined ? { toolCalls } : {}) };
      this.db.prepare('UPDATE processes SET body=? WHERE id=?').run(JSON.stringify({ ...process, progress }), id);
      this.db.exec('RELEASE process_progress');
    } catch (error) { this.db.exec('ROLLBACK TO process_progress; RELEASE process_progress'); throw error; }
  }
  turnProcess(threadId: string, turnId: string | null | undefined): MessageProcess | undefined {
    return turnId ? this.process(processKey(threadId, turnId)) : undefined;
  }
  updateProcess(threadId: string, turnId: string | null | undefined, state: MessageProcess['state'], completedAt?: string) {
    const prior = this.turnProcess(threadId, turnId);
    if (!prior || !['running', 'waiting'].includes(prior.state)) return;
    const result = state === 'completed' ? this.db.prepare("SELECT body FROM outgoing WHERE json_extract(body,'$.notificationProcessId')=? AND json_extract(body,'$.kind')='chat' AND json_extract(body,'$.streaming')=0 ORDER BY rowid DESC LIMIT 1").get(prior.id) : undefined;
    const summary = result ? (JSON.parse(result.body as string) as Outgoing).text.slice(0, 2000) : undefined;
    this.saveProcess({ ...prior, state, ...(completedAt ? { completedAt } : {}), ...(summary ? { summary } : {}) });
  }
  private saveProcess(process: MessageProcess) {
    this.flushBuffered();
    // Commit the lifecycle and every pending/published record together, including
    // records outside the outbox's current upload batch or the browser's page.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE processes SET body=? WHERE id=?').run(JSON.stringify(process), process.id);
      for (const row of this.db.prepare("SELECT body FROM outgoing WHERE json_extract(body,'$.process.id')=?").all(process.id))
        this.put({ ...this.outgoing((JSON.parse(row.body as string) as Outgoing).key)!, process });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dirty(at = Date.now()) {
    const auth = this.tool('outgoing:authentication');
    if (auth?.retryAt > at) return [];
    return this.db.prepare(`WITH eligible AS (SELECT o.*,o.rowid AS row_order,COALESCE(a.attempted_at,0) AS attempted_at,
        ROW_NUMBER() OVER (PARTITION BY json_extract(o.body,'$.conversationId') ORDER BY COALESCE(a.attempted_at,0),o.rowid) AS topic_position
      FROM outgoing o LEFT JOIN outgoing_failures f ON o.key=f.key LEFT JOIN outgoing_attempts a ON o.key=a.key
      WHERE o.revision>o.sent_revision AND (f.key IS NULL OR
        (COALESCE(json_extract(f.body,'$.blocked'),0)=0 AND json_extract(f.body,'$.retryAt')<=?) OR
        (json_extract(f.body,'$.blocked')=1 AND json_extract(f.body,'$.revision')<>o.revision)))
      SELECT * FROM eligible ORDER BY topic_position,attempted_at,row_order LIMIT 30`).all(at)
      .map(row => ({ ...row, body: JSON.stringify(this.materialize(row.key as string, row.body as string)) } as Record<string, any>));
  }
  nextOutgoingDelay(at = Date.now()): number | undefined {
    if (this.pendingOutput.size) return 120;
    const auth = this.tool('outgoing:authentication');
    if (auth?.retryAt > at) return auth.retryAt - at;
    const row = this.db.prepare(`SELECT MIN(CASE WHEN f.key IS NULL OR json_extract(f.body,'$.revision')<>o.revision AND json_extract(f.body,'$.blocked')=1 THEN ? ELSE json_extract(f.body,'$.retryAt') END) AS next
      FROM outgoing o LEFT JOIN outgoing_failures f ON f.key=o.key WHERE o.revision>o.sent_revision
      AND (f.key IS NULL OR json_extract(f.body,'$.blocked')=0 OR json_extract(f.body,'$.revision')<>o.revision)`).get(at);
    return row?.next == null ? undefined : Math.max(0, Number(row.next) - at);
  }
  attemptedOutgoing(key: string, at: number) { this.db.prepare('INSERT INTO outgoing_attempts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET attempted_at=excluded.attempted_at').run(key, at); }
  outgoingFailure(key: string): OutgoingFailure | undefined { const row = this.db.prepare('SELECT body FROM outgoing_failures WHERE key=?').get(key); return row ? JSON.parse(row.body as string) : undefined; }
  failOutgoing(key: string, failure: OutgoingFailure) { this.db.prepare('INSERT INTO outgoing_failures VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(failure)); }
  createdOutgoing(key: string, messageId: string) { this.db.prepare('UPDATE outgoing SET message_id=? WHERE key=?').run(messageId, key); }
  finishStreams(conversationId: string) {
    this.flushBuffered();
    for (const row of this.db.prepare("SELECT body FROM outgoing WHERE json_extract(body,'$.conversationId')=? AND json_extract(body,'$.streaming')=1").all(conversationId)) this.put({ ...this.outgoing((JSON.parse(row.body as string) as Outgoing).key)!, streaming: false });
  }
  sent(key: string, messageId: string, revision: number) {
    this.db.prepare('UPDATE outgoing SET message_id=?,sent_revision=MAX(sent_revision,?) WHERE key=?').run(messageId, revision, key);
    this.db.prepare('DELETE FROM outgoing_failures WHERE key=?').run(key);
  }
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
  /** Graceful shutdown leaves full snapshots readable by earlier Bridge builds. */
  private compactOutput() {
    this.db.exec('SAVEPOINT outgoing_compact');
    try {
      const rows = this.db.prepare('SELECT key,body FROM outgoing WHERE key IN (SELECT key FROM outgoing_text_deltas)').all();
      for (const row of rows) this.db.prepare('UPDATE outgoing SET body=? WHERE key=?').run(JSON.stringify(this.materialize(row.key as string, row.body as string)), row.key);
      this.db.exec('DELETE FROM outgoing_text_deltas; RELEASE outgoing_compact');
    } catch (error) { this.db.exec('ROLLBACK TO outgoing_compact; RELEASE outgoing_compact'); throw error; }
  }
  close() { this.flushBuffered(); this.compactOutput(); clearTimeout(this.outputTimer); this.outputListeners.clear(); this.db.close(); }
}
