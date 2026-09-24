import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeSettings, CodexUpdateInfo, RuntimeReport, RuntimeRequest } from '../../shared/runtime.js';
import type { CodexAction, CodexSession } from '../../shared/codex.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Gateway } from '../codex/gateway.js';
import { BridgeState, stableKey, type Session } from '../codex/state.js';
import { Projects } from '../codex/projects.js';
import { OnlineFiles } from '../codex/files.js';
import { MessagesProxy, type ProxyConnection } from './messages-proxy.js';
import { messagesBaseUrl, providerEnvironment, type ClaudeConfig } from './config.js';
import { verifyClaudeBinary } from './runtime.js';

interface Host { busy: (conversationId?: string) => boolean; control: (action: CodexAction) => Promise<void> }
const unknownUsage: RuntimeReport['usage'] = { contextTokens: null, contextLimit: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, contextSource: 'unknown', totalsSource: 'unknown' };
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
    if (this.config.managementToken) {
      await this.register();
      for (const session of this.state.sessions()) {
        if (this.projectConfig.projects.some(project => project.id === session.projectId)) {
          session.state = ['running', 'waiting'].includes(session.state) ? 'unknown' : session.state; session.turnId = null;
          this.state.save(session); await this.publishSession(session);
        }
      }
      await this.syncConnections();
      await this.gateway.call('/connector/runtime/report', this.report(null), true);
    } else this.credentialsReady = true;
    this.ready = true;
  }
  private async register() {
    await this.gateway.call('/connector/coding/connect', { instanceId: this.instanceId, version: this.version, account: this.connections.length ? 'apiKey' : 'unknown', projects: this.projectConfig.projects.map(project => ({ ...project, host: hostname() })) }, true);
  }
  session(conversationId: string) { return this.state.sessions().find(session => session.conversationId === conversationId); }
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
    const choices = this.connections.flatMap(connection => connection.models.map(model => ({ id: stableKey(`${connection.id}:${model}`), model, provider: connection.id, providerLabel: connection.name })));
    if (!choices.length && !this.config.provider && this.config.model) choices.push({ id: stableKey(`native:${this.config.model}`), model: this.config.model, provider: 'native', providerLabel: 'Claude 原生认证' });
    return choices;
  }
  selection(session?: Session) {
    const defaults = this.state.tool('claude:default-model') as { model: string; provider: string } | undefined;
    if (!session?.provider && defaults) {
      const connection = this.connections.find(item => item.id === defaults.provider && item.models.includes(defaults.model));
      if (defaults.provider !== 'native' && !connection) throw new Error('Default connection was removed; select another model explicitly');
      return { model: defaults.model, connection };
    }
    if (session?.provider && session.provider !== 'native') {
      const selected = this.connections.find(connection => connection.id === session.provider && connection.models.includes(session.model ?? ''));
      if (!selected) throw new Error('Selected connection was removed; select another model explicitly');
      return { model: session.model!, connection: selected };
    }
    if (session?.provider === 'native') return { model: session.model ?? this.config.model, connection: undefined };
    const first = this.choices()[0];
    return { model: first?.model ?? this.config.model, connection: this.connections.find(connection => connection.id === first?.provider) };
  }
  settings(session?: Session): ClaudeSettings { return session?.nativeSettings ?? this.state.tool('claude:default-settings') ?? { permissionMode: 'default' }; }
  redact(text: string) {
    for (const secret of [this.config.token, this.config.managementToken, this.config.accessClientSecret, this.proxy.token, ...this.connections.map(connection => connection.apiKey)]) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  options(session: Session): Partial<Options> {
    if (!this.credentialsReady || this.maintenance) throw new Error('Management not ready');
    const { model, connection } = this.selection(session);
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
    const settings = this.settings(session);
    return { model, env, permissionMode: settings.permissionMode ?? 'default', effort: settings.effort,
      ...(connection?.apiMode !== 'anthropic_messages' && connection ? { thinking: { type: 'disabled' } } : {}),
      mcpServers: Object.fromEntries(Object.entries(this.config.mcpServers).filter(([name]) => !disabled.includes(name))),
      plugins: this.pluginPath ? [{ type: 'local', path: this.pluginPath }] : [],
    };
  }
  report(conversationId: string | null): RuntimeReport {
    const session = conversationId ? this.session(conversationId) : undefined;
    let selection: ReturnType<ClaudeManagement['selection']> = { model: session?.model ?? undefined, connection: undefined };
    try { selection = this.selection(session); } catch {}
    const disabledSkills: string[] = this.state.tool('claude:disabled-skills') ?? [], disabledMcp: string[] = this.state.tool('claude:disabled-mcp') ?? [];
    const provider = session?.provider ?? selection.connection?.id ?? 'native';
    return {
      conversationId, runtimeVersion: this.version === 'unknown' ? null : this.version,
      capabilities: { inspect: true, switchModel: true, syncConnections: true, readFiles: true, manageProjects: this.projects.enabled, manageSkills: true, manageMcp: true },
      claude: { settings: this.settings(session), source: 'configuration', conversion: selection.connection?.apiMode === 'chat_completions' || selection.connection?.apiMode === 'responses' ? selection.connection.apiMode : 'native' },
      claudeUpdate: this.update,
      model: selection.model ? { model: selection.model, provider, providerLabel: selection.connection?.name ?? 'Claude 原生认证', scope: conversationId ? 'conversation' : 'instance', source: 'configuration' } : null,
      lastUsedModel: session?.lastUsedModel ? { model: session.lastUsedModel, provider: session.provider } : null,
      models: this.choices(), busy: this.host.busy(conversationId ?? undefined) || this.maintenance,
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
    const snapshot: CodexSession = { conversationId: session.conversationId, projectId: session.projectId, threadId: session.threadId, turnId: session.turnId, state: session.state, model: session.model, error: session.error, environment: this.report(session.conversationId).environment };
    await this.gateway.call('/connector/coding/session', { instanceId: this.instanceId, session: snapshot }, true);
    await this.gateway.call('/connector/runtime/report', this.report(session.conversationId), true);
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
    if (this.host.busy() || this.maintenance) return;
    const desired = await this.gateway.call('/connector/runtime/connections?after=' + this.revision, undefined, true);
    if (desired.connections === null) { this.credentialsReady = true; return; }
    this.maintenance = true;
    try {
      const connections = desired.connections as (ProxyConnection & { name: string })[];
      if (!Array.isArray(connections) || connections.length > 50 || connections.some(connection => !['chat_completions', 'responses', 'anthropic_messages'].includes(connection.apiMode))) throw new Error('Invalid connections');
      const next = [...this.localConnection(), ...connections];
      await this.configureConnections(next);
      this.connections = next; this.revision = desired.revision; this.credentialsReady = true;
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
    let result: RuntimeRequest['result'] = null;
    try {
      const session = request.conversationId ? this.session(request.conversationId) : undefined;
      if (request.kind !== 'inspect' && (this.host.busy() || this.maintenance)) throw new Error('busy');
      this.maintenance = request.kind !== 'inspect';
      if (request.kind === 'switch-model') {
        const choice = this.choices().find(choice => choice.id === request.payload.choiceId);
        if (!choice || request.conversationId && !session) throw new Error('unsupported');
        if (session) { session.model = choice.model; session.provider = choice.provider; this.state.save(session); }
        else this.state.saveTool('claude:default-model', { model: choice.model, provider: choice.provider });
      } else if (request.kind === 'update-claude-settings') {
        if (request.conversationId && !session || !request.payload.claudeSettings) throw new Error('unsupported');
        const settings = { ...this.settings(session), ...request.payload.claudeSettings };
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
      this.maintenance = false;
      const outcome = { ok: true, result, report: this.report(request.conversationId) };
      this.state.saveTool(`claude:operation:${request.id}`, outcome);
      await this.gateway.call(`/connector/runtime/requests/${request.id}/result`, outcome, true);
      if (session) await this.publishSession(session);
    } catch (error) {
      const code = error instanceof Error && ['busy', 'unsupported', 'update_interrupted'].includes(error.message) ? error.message : 'failed';
      const outcome = { ok: false, error: code };
      if (this.state.tool(`claude:operation:${request.id}`) === 'processing') this.state.saveTool(`claude:operation:${request.id}`, outcome);
      await this.gateway.call(`/connector/runtime/requests/${request.id}/result`, this.state.tool(`claude:operation:${request.id}`), true).catch(() => {});
    } finally { this.maintenance = this.update.status === 'uncertain'; }
  }
  async run() {
    if (!this.config.managementToken) return;
    while (!this.stopped) {
      try {
        await this.syncConnections();
        await this.register();
        const controls = await this.gateway.call('/connector/coding/inbox?instanceId=' + this.instanceId, undefined, true);
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
        if (!this.pendingOperation) {
          const inbox = await this.gateway.call('/connector/runtime/inbox?wait=0', undefined, true);
          this.pendingOperation = (async () => {
            for (const request of inbox.requests as RuntimeRequest[]) await this.operation(request);
          })().catch(() => { this.ready = false; }).finally(() => { this.pendingOperation = undefined; });
        }
        for (const session of this.state.sessions()) if (this.projectConfig.projects.some(project => project.id === session.projectId)) await this.publishSession(session);
        await this.gateway.call('/connector/runtime/report', this.report(null), true);
        this.ready = this.credentialsReady;
      } catch { this.ready = false; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  stop() { this.stopped = true; this.ready = false; this.files.stop(); }
  async close() { this.stop(); await this.proxy.close(); await this.pendingOperation; }
}
