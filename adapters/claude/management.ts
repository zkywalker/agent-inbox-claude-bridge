import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClaudeSelection, ClaudeSettings, CodexUpdateInfo, RuntimeReport, RuntimeRequest } from '../../shared/runtime.js';
import type { CodexAction, CodexSession } from '../../shared/codex.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Gateway, GatewayError } from '../codex/gateway.js';
import { BridgeState, stableKey, type Session } from '../codex/state.js';
import { Projects } from '../codex/projects.js';
import { OnlineFiles } from '../codex/files.js';
import { MessagesProxy, type ProxyConnection } from './messages-proxy.js';
import { messagesBaseUrl, providerEnvironment, type ClaudeConfig } from './config.js';
import { verifyClaudeBinary } from './runtime.js';

interface Host { busy: (conversationId?: string) => boolean; control: (action: CodexAction) => Promise<void> }
const unknownUsage: RuntimeReport['usage'] = { contextTokens: null, contextLimit: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, contextSource: 'unknown', totalsSource: 'unknown' };
// These are configurable adapter parameters, not a probe of upstream model support.
const reasoningEfforts = [
  { id: 'low', description: '低（配置值）' }, { id: 'medium', description: '中（配置值）' },
  { id: 'high', description: '高（配置值）' }, { id: 'max', description: '最高（仅原生 Messages 配置）' },
];
const allowedEfforts = (connection?: ProxyConnection) => reasoningEfforts.filter(effort => effort.id !== 'max' || !connection || connection.apiMode === 'anthropic_messages');
export class ClaudeManagement {
  readonly instanceId = randomUUID();
  readonly projects: Projects;
  readonly files: OnlineFiles;
  readonly proxy = new MessagesProxy();
  readonly projectConfig: { projects: { id: string; name: string; path: string }[]; projectRoots?: { id: string; name: string; path: string }[] };
  maintenance = false;
  ready = false;
  version = 'unknown';
  private stopped = false;
  private readonly abort = new AbortController();
  private registered = false;
  private registration?: Promise<void>;
  private lastRegisteredAt = 0;
  private lastConfiguredAt = 0;
  private lastHeartbeatAt = 0;
  private authenticationRetryAt = 0;
  private readonly publishing = new Map<string, Promise<void>>();
  private readonly sessionRetryAt = new Map<string, number>();
  private pendingOperation?: Promise<void>;
  private revision = -1;
  private credentialsReady = false;
  private connections: (ProxyConnection & { name: string })[] = [];
  private skills: { id: string; name: string; path: string; description: string }[] = [];
  private pluginPath?: string;
  private update: CodexUpdateInfo;
  constructor(readonly config: ClaudeConfig, readonly gateway: Gateway, readonly state: BridgeState, readonly host: Host) {
    this.projectConfig = { projects: gateway.config.projects, projectRoots: config.projectRoots };
    this.projects = new Projects(this.projectConfig, state);
    this.files = new OnlineFiles(gateway, state, this.projects, () => {});
    this.update = state.tool('claude:update') ?? { supported: !!config.allowNativeUpdate, reason: config.allowNativeUpdate ? null : 'disabled', status: 'idle', operationId: null, fromVersion: null, toVersion: null, error: null, updatedAt: new Date().toISOString() };
    if (['updating', 'restarting', 'verifying'].includes(this.update.status)) this.saveUpdate({ ...this.update, status: 'uncertain', error: 'update_interrupted' });
    this.maintenance = this.update.status === 'uncertain';
    this.state.invalidateSessionReports();
  }
  private saveUpdate(update: CodexUpdateInfo) { this.update = { ...update, updatedAt: new Date().toISOString() }; this.state.saveTool('claude:update', this.update); }
  private localConnection() {
    const provider = this.config.provider;
    if (!provider) return [];
    const models = provider.models ?? (this.config.model ? [this.config.model] : []);
    if (!models.length) throw new Error('Explicit provider requires a configured model');
    return [{ id: 'local', name: '主机连接', baseUrl: provider.baseUrl, apiKey: process.env[provider.tokenEnv] ?? '', apiMode: provider.apiMode, models }];
  }
  async initialize(version: string) {
    this.version = version;
    await this.projects.restore();
    await this.scanSkills(); await this.prepareSkills();
    this.connections = this.localConnection();
    await this.configureConnections(this.connections);
    if (this.config.managementToken) { await this.register(); await this.syncConnections(); }
    else this.credentialsReady = true;
    const defaults = this.defaultModel(), settings = this.settings();
    for (const session of this.state.sessions()) {
      // Freeze legacy inheritance once; a complete native null model stays SDK-default, not future bridge defaults.
      if (!session.nativeSettings || !session.provider || session.model === undefined || session.model === '' || (session.model === null && session.provider !== 'native')) session.model ||= defaults.model ?? null;
      session.provider ||= defaults.provider;
      session.nativeSettings ??= { ...settings };
      session.state = ['running', 'waiting'].includes(session.state) ? 'unknown' : session.state; session.turnId = null;
      this.state.save(session);
      if (this.projectConfig.projects.some(project => project.id === session.projectId)) await this.publishSession(session);
    }
    if (this.config.managementToken) await this.gateway.call('/connector/runtime/report', this.report(null), true);
    this.lastHeartbeatAt = Date.now();
    this.ready = true;
  }
  private async register() {
    if (this.registration) return this.registration;
    this.registration = this.gateway.call('/connector/coding/connect', { instanceId: this.instanceId, version: this.version, account: this.connections.length ? 'apiKey' : 'unknown', projects: this.projectConfig.projects.map(project => ({ ...project, host: hostname() })) }, true).then(() => {
      this.registered = true; this.lastRegisteredAt = Date.now();
    }).finally(() => { this.registration = undefined; });
    return this.registration;
  }
  session(conversationId: string) { return this.state.session(conversationId); }
  project(session?: Pick<Session, 'projectId'>) {
    const project = this.projectConfig.projects.find(project => project.id === (session?.projectId ?? this.projectConfig.projects[0].id));
    if (!project) throw new Error('Project no longer configured');
    return project;
  }
  async validateProject(projectId: string) {
    await this.projects.validate(projectId);
    const project = this.project({ projectId });
    if (await realpath(project.path) !== project.path || !(await lstat(project.path)).isDirectory()) throw new Error('Project changed');
    return project;
  }
  choices() {
    const choices = this.connections.flatMap(connection => connection.models.map(model => ({ id: stableKey(`${connection.id}:${model}`), model, provider: connection.id, providerLabel: connection.name, reasoningEfforts: allowedEfforts(connection) })));
    if (!this.config.provider && this.config.model) choices.push({ id: stableKey(`native:${this.config.model}`), model: this.config.model, provider: 'native', providerLabel: 'Claude 原生认证', reasoningEfforts: allowedEfforts() });
    return choices;
  }
  private defaultModel(): { model?: string; provider: string } {
    const defaults = this.state.tool('claude:default-model') as { model: string; provider: string } | undefined;
    const first = this.choices()[0];
    return defaults ?? { model: first?.model ?? this.config.model, provider: first?.provider ?? 'native' };
  }
  selection(session?: Pick<Session, 'model' | 'provider'>) {
    const selected = session ?? this.defaultModel();
    if (selected.provider === 'native') {
      if (this.config.provider || selected.model != null && selected.model !== this.config.model) throw new Error('unsupported');
      return { model: selected.model ?? undefined, connection: undefined };
    }
    const connection = this.connections.find(connection => connection.id === selected.provider && connection.models.includes(selected.model ?? ''));
    if (!connection) throw new Error('unsupported');
    return { model: selected.model!, connection };
  }
  settings(session?: Session): ClaudeSettings {
    return { ...(session ? session.nativeSettings ?? { permissionMode: 'default' } : this.state.tool('claude:default-settings') ?? { permissionMode: 'default' }) };
  }
  private validateSettings(settings: { permissionMode?: unknown; effort?: unknown }, connection?: ProxyConnection): ClaudeSettings {
    if (settings.permissionMode !== undefined && !['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(settings.permissionMode as string)
      || settings.effort !== undefined && !allowedEfforts(connection).some(effort => effort.id === settings.effort)) throw new Error('unsupported');
    return settings as ClaudeSettings;
  }
  initialSelection(initial: ClaudeSelection = {}) {
    const { model, provider, ...overrides } = initial;
    if ((model !== undefined) !== (provider !== undefined) || model !== undefined && (!model || !provider)) throw new Error('unsupported');
    const selected = model !== undefined ? this.selection({ model, provider: provider! }) : this.selection();
    const nativeSettings = this.validateSettings({ ...this.settings(), ...overrides }, selected.connection);
    return { model: selected.model ?? null, provider: selected.connection?.id ?? 'native', nativeSettings };
  }
  private busy(conversationId?: string) {
    return this.host.busy(conversationId) || (conversationId ? ['running', 'waiting', 'unknown'].includes(this.session(conversationId)?.state ?? '') : this.state.hasUnfinishedSessions());
  }
  private saveDefaults(model: { model: string; provider: string }, settings: ClaudeSettings) {
    this.state.db.exec('BEGIN IMMEDIATE');
    try {
      this.state.saveTool('claude:default-model', model);
      this.state.saveTool('claude:default-settings', settings);
      this.state.db.exec('COMMIT');
    } catch (error) { this.state.db.exec('ROLLBACK'); throw error; }
  }
  redact(text: string) {
    for (const secret of [this.config.token, this.config.managementToken, this.config.accessClientSecret, this.proxy.token, ...this.connections.map(connection => connection.apiKey)]) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  options(session: Session): Partial<Options> {
    if (!this.credentialsReady || this.maintenance) throw new Error('Management not ready');
    const { model, connection } = this.selection(session);
    const settings = this.validateSettings(this.settings(session), connection);
    const env = providerEnvironment(this.config);
    if (connection) {
      for (const [key, value] of Object.entries(env)) if (value === connection.apiKey || key === 'OPENAI_API_KEY' || key === this.config.provider?.tokenEnv) delete env[key];
      const direct = connection.apiMode === 'anthropic_messages';
      env.ANTHROPIC_BASE_URL = direct ? messagesBaseUrl(connection.baseUrl) : this.proxy.url(connection.id);
      env.ANTHROPIC_AUTH_TOKEN = direct ? connection.apiKey : this.proxy.token; delete env.ANTHROPIC_API_KEY;
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']) delete env[key];
      for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[key] = model;
      if (!direct) env.ENABLE_TOOL_SEARCH = 'false';
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    }
    const disabled: string[] = this.state.tool('claude:disabled-mcp') ?? [];
    return { model, env, permissionMode: settings.permissionMode ?? 'default', allowDangerouslySkipPermissions: settings.permissionMode === 'bypassPermissions', effort: settings.effort,
      ...(connection?.apiMode !== 'anthropic_messages' && connection ? { thinking: { type: 'disabled' } } : {}),
      mcpServers: Object.fromEntries(Object.entries(this.config.mcpServers).filter(([name]) => !disabled.includes(name))),
      plugins: this.pluginPath ? [{ type: 'local', path: this.pluginPath }] : [],
    };
  }
  report(conversationId: string | null): RuntimeReport {
    const session = conversationId ? this.session(conversationId) : undefined;
    const configured = session ?? this.defaultModel(), settings = this.settings(session);
    let selection: ReturnType<ClaudeManagement['selection']> = { model: configured.model ?? undefined, connection: undefined };
    try { selection = this.selection(session); } catch {}
    const disabledSkills: string[] = this.state.tool('claude:disabled-skills') ?? [], disabledMcp: string[] = this.state.tool('claude:disabled-mcp') ?? [];
    const provider = configured.provider;
    return {
      conversationId, claudeInstanceId: this.instanceId, maintenance: this.maintenance, runtimeVersion: this.version === 'unknown' ? null : this.version,
      capabilities: { inspect: true, switchModel: true, syncConnections: true, readFiles: true, reasoning: true, initialSelection: true, defaultsWhileBusy: true, claudeBypassPermissions: true, updateSettings: true, manageProjects: this.projects.enabled, manageSkills: true, manageMcp: true },
      reasoning: { effort: settings.effort ?? null },
      claude: { settings, source: 'configuration', conversion: selection.connection?.apiMode === 'chat_completions' || selection.connection?.apiMode === 'responses' ? selection.connection.apiMode : 'native' },
      claudeUpdate: this.update,
      model: selection.model ? { model: selection.model, provider, providerLabel: selection.connection?.name ?? 'Claude 原生认证', scope: conversationId ? 'conversation' : 'instance', source: 'configuration' } : null,
      lastUsedModel: session?.lastUsedModel ? { model: session.lastUsedModel, provider: session.provider } : null,
      models: this.choices(), busy: this.maintenance || this.busy(conversationId ?? undefined) || (conversationId !== null && session?.state !== 'idle'),
      usage: session?.usage ?? unknownUsage,
      environment: { host: hostname(), project: session ? this.project(session).name : null, cwd: session ? this.project(session).path : '', source: this.host.busy(conversationId ?? undefined) && session ? 'runtime' : 'defaults', sandbox: null, writableRoots: [], networkAccess: null, approvalPolicy: this.settings(session).permissionMode ?? 'default', approvalsReviewer: 'user' },
      inventory: { scope: session ? 'project' : 'instance', observedAt: new Date().toISOString(), warnings: ['Skills/MCP 开关作用于此 bridge 的受管插件和服务器；配置在下一次原生回合加载，不修改主机其他 Claude 客户端。'] },
      providers: this.connections.map(connection => ({ id: connection.id, name: connection.name, apiMode: connection.apiMode, endpoint: null, current: connection.id === provider })),
      skills: this.skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description, source: 'bridge', scope: 'installed', enabled: !disabledSkills.includes(skill.id), mutable: true })),
      mcp: Object.keys(this.config.mcpServers).map(name => ({ id: name, name, status: disabledMcp.includes(name) ? 'disabled' : 'configured', enabled: !disabledMcp.includes(name), tools: [], mutable: true })),
      files: session ? [{ id: 'claude-project-instructions', name: 'CLAUDE.md', source: '项目', loaded: null }] : [],
    };
  }
  async projectInstructions(session: Session) {
    try {
      const root = this.project(session).path, path = join(root, 'CLAUDE.md');
      if (await realpath(path) !== path || (await lstat(path)).size > 32000) return '';
      return await readFile(path, 'utf8');
    } catch { return ''; }
  }
  async publishSession(session: Session) {
    if (!this.config.managementToken) return;
    const id = session.conversationId;
    const pending = (this.publishing.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      session = this.session(id) ?? session;
      const revision = this.state.sessionRevision(id), previous = this.state.sessionReport(id);
      if (previous && Number(previous.sent_revision) === revision) return;
      const report = this.report(id);
      const snapshot: CodexSession = { conversationId: id, projectId: session.projectId, threadId: session.threadId, turnId: session.turnId, state: session.state, model: session.model, error: session.error, environment: report.environment };
      await this.gateway.call('/connector/coding/session', { instanceId: this.instanceId, session: snapshot }, true);
      await this.gateway.call('/connector/runtime/report', report, true);
      this.state.reportedSession(id, revision, Date.now());
      this.sessionRetryAt.delete(id);
    });
    this.publishing.set(id, pending);
    try { await pending; }
    catch (error) { this.sessionRetryAt.set(id, Date.now() + 10_000); this.state.postponeSessionReport(id, Date.now()); throw error; }
    finally { if (this.publishing.get(id) === pending) this.publishing.delete(id); }
  }
  private async scanSkills() {
    const skills: typeof this.skills = [];
    for (const directory of this.config.skillDirectories) {
      const root = await realpath(directory);
      if (root !== directory) throw new Error('Skill directory cannot be a symlink');
      for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 100)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[\w-]+$/.test(entry.name)) continue;
        const path = join(root, entry.name), source = join(path, 'SKILL.md');
        try {
          if (await realpath(source) !== source || (await lstat(source)).size > 32000) continue;
          const body = await readFile(source, 'utf8');
          skills.push({ id: stableKey(path), name: entry.name, path, description: /^description:\s*(.+)$/m.exec(body)?.[1]?.slice(0, 1000) ?? '' });
        } catch {}
      }
    }
    if (new Set(skills.map(skill => skill.name)).size !== skills.length || skills.length > 100) throw new Error('Duplicate or excessive skills');
    this.skills = skills;
  }
  private async prepareSkills() {
    const root = join(this.config.stateDir, 'managed-plugin');
    await rm(root, { recursive: true, force: true }); await mkdir(join(root, '.claude-plugin'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inbox-managed', version: '1.0.0' }), { mode: 0o600 });
    const disabled: string[] = this.state.tool('claude:disabled-skills') ?? [];
    for (const skill of this.skills.filter(skill => !disabled.includes(skill.id))) {
      let bytes = 0, files = 0;
      await cp(skill.path, join(root, 'skills', skill.name), { recursive: true, filter: async path => {
        const rel = relative(skill.path, path), info = await lstat(path);
        if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel.split(sep).some(part => part.startsWith('.')) || info.isSymbolicLink()) return false;
        bytes += info.size; files++;
        if (bytes > 10 * 1024 * 1024 || files > 1000) throw new Error('Skill exceeds limits');
        return info.isDirectory() || info.isFile();
      } });
    }
    this.pluginPath = this.skills.length ? root : undefined;
  }
  async syncConnections() {
    if (this.host.busy() || (this.ready && this.busy()) || this.maintenance || this.pendingOperation) return;
    const desired = await this.gateway.call('/connector/runtime/connections?after=' + this.revision, undefined, true);
    this.lastConfiguredAt = Date.now();
    // The network wait may have admitted a turn or another maintenance owner.
    if (this.host.busy() || (this.ready && this.busy()) || this.maintenance || this.pendingOperation) return;
    if (desired.connections === null) { this.credentialsReady = true; return; }
    this.maintenance = true;
    try {
      const connections = desired.connections as (ProxyConnection & { name: string })[];
      if (!Array.isArray(connections) || connections.length > 50 || connections.some(connection => !['chat_completions', 'responses', 'anthropic_messages'].includes(connection.apiMode))) throw new Error('Invalid connections');
      const next = [...this.localConnection(), ...connections];
      await this.configureConnections(next);
      this.connections = next; this.revision = desired.revision; this.credentialsReady = true;
      this.state.invalidateSessionReports(); this.lastHeartbeatAt = 0;
      await this.gateway.call('/connector/runtime/connections/ack', { revision: this.revision, ok: true }, true);
    } catch {
      this.credentialsReady = false;
      await this.gateway.call('/connector/runtime/connections/ack', { revision: desired.revision, ok: false, error: 'invalid_config' }, true).catch(() => {});
      throw new Error('Connection sync failed');
    } finally { this.maintenance = false; }
  }
  private async configureConnections(connections: ProxyConnection[]) {
    this.proxy.configure(connections);
    const converted = connections.filter(connection => connection.apiMode !== 'anthropic_messages');
    this.proxy.configure(converted);
    if (converted.length) await this.proxy.start();
    else await this.proxy.close();
  }
  private async operation(request: RuntimeRequest) {
    const prior = this.state.tool(`claude:operation:${request.id}`);
    if (prior) {
      await this.gateway.call(`/connector/runtime/requests/${request.id}/result`, prior === 'processing' ? { ok: false, error: 'restarted' } : prior, true); return;
    }
    this.state.saveTool(`claude:operation:${request.id}`, 'processing');
    let result: RuntimeRequest['result'] = null, ownsMaintenance = false;
    const releaseMaintenance = () => {
      if (ownsMaintenance) { this.maintenance = this.update.status === 'uncertain'; ownsMaintenance = false; }
    };
    try {
      const session = request.conversationId ? this.session(request.conversationId) : undefined;
      const configuration = request.kind === 'switch-model' || request.kind === 'update-claude-settings';
      if (request.kind !== 'inspect') {
        if (this.maintenance || this.update.status === 'uncertain') throw new Error('busy');
        if (configuration) {
          if (request.conversationId !== null && !session) throw new Error('unsupported');
          if (session && (session.state !== 'idle' || this.host.busy(session.conversationId))) throw new Error('busy');
          // These synchronous writes affect one idle topic or future defaults only.
        } else {
          if (this.busy()) throw new Error('busy');
          this.maintenance = true; ownsMaintenance = true;
        }
      }
      if (request.kind === 'switch-model') {
        const choice = this.choices().find(choice => choice.id === request.payload.choiceId);
        if (!choice) throw new Error('unsupported');
        const { connection } = this.selection(choice);
        const settings = this.validateSettings({ ...this.settings(session), ...(request.payload.effort !== undefined ? { effort: request.payload.effort } : {}) }, connection);
        if (session) { Object.assign(session, { model: choice.model, provider: choice.provider, nativeSettings: settings }); this.state.save(session); }
        else this.saveDefaults({ model: choice.model, provider: choice.provider }, settings);
      } else if (request.kind === 'update-claude-settings') {
        if (!request.payload.claudeSettings) throw new Error('unsupported');
        const { connection } = this.selection(session);
        const settings = this.validateSettings({ ...this.settings(session), ...request.payload.claudeSettings }, connection);
        if (session) { session.nativeSettings = settings; this.state.save(session); }
        else this.state.saveTool('claude:default-settings', settings);
      } else if (request.kind === 'browse-projects') result = { listing: await this.projects.browse(request.payload.directoryId) };
      else if (request.kind === 'register-project') { result = { project: await this.projects.register(request.payload.directoryId!, request.payload.name) }; await this.register(); }
      else if (request.kind === 'read-file') {
        if (!session || request.payload.fileId !== 'claude-project-instructions') throw new Error('unsupported');
        result = { file: { name: 'CLAUDE.md', text: await this.projectInstructions(session), truncated: false, source: '项目' } };
      } else if (request.kind === 'set-skill' || request.kind === 'set-mcp') {
        const skill = request.kind === 'set-skill', id = request.payload.targetId!;
        if (typeof request.payload.enabled !== 'boolean' || !(skill ? this.skills.some(item => item.id === id) : Object.hasOwn(this.config.mcpServers, id))) throw new Error('unsupported');
        const key = skill ? 'claude:disabled-skills' : 'claude:disabled-mcp';
        const disabled = new Set<string>(this.state.tool(key) ?? []);
        if (request.payload.enabled) disabled.delete(id); else disabled.add(id);
        this.state.saveTool(key, [...disabled]); if (skill) await this.prepareSkills();
      } else if (request.kind === 'reload-mcp') { await this.scanSkills(); await this.prepareSkills(); }
      else if (request.kind === 'update-claude') {
        if (!this.config.allowNativeUpdate || !this.config.claudeBinary || this.update.status === 'uncertain') throw new Error('unsupported');
        const from = await verifyClaudeBinary(this.config.claudeBinary);
        this.saveUpdate({ ...this.update, status: 'updating', operationId: request.id, fromVersion: from, toVersion: null, error: null });
        await this.gateway.call('/connector/runtime/report', this.report(null), true);
        try {
          await promisify(execFile)(this.config.claudeBinary, ['update'], { timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true });
          const to = await verifyClaudeBinary(this.config.claudeBinary); this.version = to;
          this.saveUpdate({ ...this.update, status: from === to ? 'unchanged' : 'succeeded', toVersion: to, error: null }); await this.register();
        } catch { this.saveUpdate({ ...this.update, status: 'uncertain', error: 'update_interrupted' }); throw new Error('update_interrupted'); }
      } else if (request.kind !== 'inspect') throw new Error('unsupported');
      releaseMaintenance();
      if (['set-skill', 'set-mcp', 'reload-mcp', 'update-claude'].includes(request.kind)) this.state.invalidateSessionReports();
      this.lastHeartbeatAt = 0;
      const outcome = { ok: true, result, report: this.report(request.conversationId) };
      this.state.saveTool(`claude:operation:${request.id}`, outcome);
      await this.gateway.call(`/connector/runtime/requests/${request.id}/result`, outcome, true);
      if (session) await this.publishSession(this.session(session.conversationId) ?? session);
    } catch (error) {
      const code = error instanceof Error && ['busy', 'unsupported', 'update_interrupted'].includes(error.message) ? error.message : 'failed';
      const outcome = { ok: false, error: code };
      if (this.state.tool(`claude:operation:${request.id}`) === 'processing') this.state.saveTool(`claude:operation:${request.id}`, outcome);
      await this.gateway.call(`/connector/runtime/requests/${request.id}/result`, this.state.tool(`claude:operation:${request.id}`), true).catch(() => {});
    } finally { releaseMaintenance(); }
  }
  async run() {
    if (!this.config.managementToken) return;
    await Promise.all([this.controlLoop(), this.runtimeLoop(), this.maintenanceLoop(), this.heartbeatLoop(), this.reportLoop()]);
  }
  private async wait(ms: number) { await delay(ms, undefined, { signal: this.abort.signal }).catch(() => {}); }
  private async waitForAuthentication() {
    const remaining = this.authenticationRetryAt - Date.now();
    if (remaining > 0) await this.wait(remaining);
  }
  private retryDelay(error: unknown) {
    this.ready = false;
    if (error instanceof GatewayError && error.status === 409 && error.code === 'reconnect') {
      this.registered = false; this.state.invalidateSessionReports(); this.lastHeartbeatAt = 0;
    }
    if (error instanceof GatewayError && [401, 403].includes(error.status)) {
      this.authenticationRetryAt = Date.now() + 60_000; return 60_000;
    }
    return 2000;
  }
  private async controlLoop() {
    while (!this.stopped) {
      await this.waitForAuthentication(); if (this.stopped) break;
      try {
        if (!this.registered) await this.register();
        const controls = await this.gateway.call('/connector/coding/inbox?instanceId=' + this.instanceId + '&wait=20', undefined, true, undefined, this.abort.signal);
        if (this.stopped) break;
        for (const action of controls.actions as CodexAction[]) {
          const key = `claude:control:${action.id}`, prior = this.state.tool(key);
          let outcome = prior === 'processing' ? { ok: false, error: '操作结果不确定，未重放。' } : prior;
          if (!outcome) {
            this.state.saveTool(key, 'processing');
            try { await this.host.control(action); outcome = { ok: true }; } catch { outcome = { ok: false, error: '原生操作未确认或已过期。' }; }
            this.state.saveTool(key, outcome);
          }
          await this.gateway.call(`/connector/coding/actions/${action.id}/result`, { ...outcome, instanceId: this.instanceId }, true);
        }
        // Older gateways may ignore wait; avoid turning compatibility into a busy loop.
        if (!controls.actions.length) await this.wait(1000);
      } catch (error) { if (!this.stopped) await this.wait(this.retryDelay(error)); }
    }
  }
  private async runtimeLoop() {
    while (!this.stopped) {
      await this.waitForAuthentication(); if (this.stopped) break;
      try {
        if (!this.registered) { await this.wait(1000); continue; }
        const inbox = await this.gateway.call('/connector/runtime/inbox?wait=20&instanceId=' + this.instanceId, undefined, true, undefined, this.abort.signal);
        if (this.stopped) break;
        if (inbox.requests.length) {
          this.pendingOperation = (async () => {
            for (const request of inbox.requests as RuntimeRequest[]) await this.operation(request);
          })().catch(() => { this.ready = false; }).finally(() => { this.pendingOperation = undefined; });
          await this.pendingOperation;
        }
        if (!inbox.requests.length) await this.wait(1000);
      } catch (error) { if (!this.stopped) await this.wait(this.retryDelay(error)); }
    }
  }
  private async maintenanceLoop() {
    while (!this.stopped) {
      await this.waitForAuthentication(); if (this.stopped) break;
      try {
        if (!this.registered || Date.now() - this.lastRegisteredAt >= 30_000) await this.register();
        if (Date.now() - this.lastConfiguredAt >= 30_000) await this.syncConnections();
        await this.wait(1000);
      } catch (error) { if (!this.stopped) await this.wait(this.retryDelay(error)); }
    }
  }
  private async reportLoop() {
    while (!this.stopped) {
      await this.waitForAuthentication(); if (this.stopped) break;
      try {
        if (!this.registered) { await this.wait(1000); continue; }
        for (const session of this.state.dirtySessions()) {
          if (this.stopped || this.authenticationRetryAt > Date.now()) break;
          if ((this.sessionRetryAt.get(session.conversationId) ?? 0) > Date.now() || !this.projectConfig.projects.some(project => project.id === session.projectId)) continue;
          await this.publishSession(session).catch(error => { this.retryDelay(error); });
        }
        await this.wait(1000);
      } catch (error) { if (!this.stopped) await this.wait(this.retryDelay(error)); }
    }
  }
  private async heartbeatLoop() {
    while (!this.stopped) {
      await this.waitForAuthentication(); if (this.stopped) break;
      try {
        if (this.registered && Date.now() - this.lastHeartbeatAt >= 10_000) {
          await this.gateway.call('/connector/runtime/report', this.report(null), true);
          this.lastHeartbeatAt = Date.now(); this.ready = this.credentialsReady && this.authenticationRetryAt <= Date.now();
        }
        await this.wait(1000);
      } catch (error) { if (!this.stopped) await this.wait(this.retryDelay(error)); }
    }
  }
  stop() { this.stopped = true; this.abort.abort(); this.ready = false; this.files.stop(); }
  async close() { this.stop(); await this.proxy.close(); await this.pendingOperation; }
}
