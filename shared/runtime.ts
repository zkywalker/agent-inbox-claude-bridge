import type { CodexOptions, CodexSelection, CodexSettingsReport } from './codex-settings.js';
import type { BridgeUpdatePlan } from './bridge-update.js';
import type { BridgePlatform } from './bridge-release.js';
export type ModelApiMode = 'chat_completions' | 'responses' | 'anthropic_messages';

export interface ClaudeSettings { permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'; effort?: 'low' | 'medium' | 'high' | 'max' }
export type ClaudeSelection = ClaudeSettings & { model?: string; provider?: string };

export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiMode: ModelApiMode;
  models: string[];
  hasCredential: boolean;
  agentIds: string[];
  version: number;
  updatedAt: string;
}

export interface ModelConnectionInput {
  name: string;
  baseUrl: string;
  apiMode: ModelApiMode;
  models: string[];
  apiKey?: string;
  agentIds: string[];
  expectedVersion?: number;
}

export interface RuntimeModel {
  model: string;
  provider: string;
  providerLabel: string;
  scope: 'instance' | 'conversation';
  source: 'configuration' | 'session' | 'runtime';
}

export interface RuntimeModelChoice {
  id: string;
  model: string;
  provider: string;
  providerLabel: string;
  reasoningEfforts?: { id: string; description: string }[];
  defaultReasoningEffort?: string | null;
}

export interface RuntimeEnvironment {
  host: string;
  project: string | null;
  cwd: string;
  source: 'runtime' | 'defaults';
  sandbox: string | null;
  writableRoots: string[];
  networkAccess: boolean | null;
  approvalPolicy: string | null;
  approvalsReviewer: string | null;
}
export interface ProjectDirectory { id: string; name: string; path: string }
export interface ProjectListing {
  current: ProjectDirectory | null;
  parentId: string | null;
  directories: ProjectDirectory[];
  truncated: boolean;
}

export interface CodexUpdateInfo {
  supported: boolean;
  reason: 'disabled' | 'unsupported-platform' | 'unavailable' | null;
  status: 'idle' | 'updating' | 'restarting' | 'verifying' | 'succeeded' | 'unchanged' | 'failed' | 'uncertain';
  operationId: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  error: string | null;
  updatedAt: string;
}

export type BridgeUpdateStatus = 'idle' | 'staging' | 'restarting' | 'verifying' | 'succeeded' | 'failed' | 'uncertain';
export type BridgeUpdateError = 'update_bridge_failed' | 'update_bridge_timeout' | 'update_bridge_reconnect_failed' | 'update_bridge_unavailable' | 'update_bridge_interrupted' | 'update_bridge_manifest_invalid';
export interface BridgeUpdateInfo {
  supported: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  status: BridgeUpdateStatus;
  operationId: string | null;
  error: BridgeUpdateError | null;
  updatedAt: string;
}

export function isCodexRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value);
}

export interface RuntimeReport {
  claude?: { settings: ClaudeSettings; source: 'configuration' | 'runtime'; conversion: 'native' | 'chat_completions' | 'responses' };
  claudeUpdate?: CodexUpdateInfo;
  codexInstanceId?: string;
  claudeInstanceId?: string;
  maintenance?: boolean;
  conversationId: string | null;
  runtimeVersion: string | null;
  bridgeVersion?: string | null;
  capabilities: { inspect: boolean; switchModel: boolean; syncConnections: boolean; readFiles: boolean; reasoning?: boolean; manageProjects?: boolean; updateSettings?: boolean; manageSkills?: boolean; manageMcp?: boolean; initialSelection?: boolean; defaultsWhileBusy?: boolean; claudeBypassPermissions?: boolean };
  codex?: CodexSettingsReport;
  codexUpdate?: CodexUpdateInfo;
  bridgeUpdate?: BridgeUpdateInfo;
  bridgeUpdateCapability?: { platform: BridgePlatform; safeRetry: boolean };
  reasoning?: { effort: string | null };
  environment?: RuntimeEnvironment;
  providers?: { id: string; name: string; apiMode: string; endpoint: string | null; current: boolean }[] | null;
  inventory?: { scope: 'project' | 'instance'; observedAt: string; warnings: string[] };
  model: RuntimeModel | null;
  lastUsedModel: { model: string; provider: string } | null;
  models: RuntimeModelChoice[];
  busy: boolean | null;
  usage: {
    contextTokens: number | null;
    contextLimit: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    contextSource: 'provider' | 'estimate' | 'unknown';
    totalsSource: 'session' | 'runtime' | 'unknown';
  };
  skills: { name: string; description: string; scope: 'installed' | 'available'; enabled?: boolean; source?: string; id?: string; mutable?: boolean }[] | null;
  mcp: { name: string; status: 'connected' | 'configured' | 'disconnected' | 'disabled' | 'connecting' | 'failed' | 'unknown'; tools: string[]; authStatus?: string; id?: string; enabled?: boolean; mutable?: boolean }[] | null;
  files: { id: string; name: string; source: string; loaded: boolean | null }[];
}

export type RuntimeRequestKind = 'inspect' | 'switch-model' | 'read-file' | 'browse-projects' | 'register-project' | 'update-settings' | 'update-claude-settings' | 'set-skill' | 'set-mcp' | 'reload-mcp' | 'update-codex' | 'update-claude' | 'update-bridge';
export type RuntimeRequestStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export interface RuntimeRequest {
  bridgeRelease?: BridgeUpdatePlan;
  id: string;
  agentId: string;
  conversationId: string | null;
  kind: RuntimeRequestKind;
  payload: { choiceId?: string; fileId?: string; effort?: string; directoryId?: string; name?: string; settings?: CodexOptions; claudeSettings?: ClaudeSettings; targetId?: string; enabled?: boolean; targetVersion?: string };
  status: RuntimeRequestStatus;
  error: string | null;
  result: { file?: { name: string; text: string; truncated: boolean; source: string }; listing?: ProjectListing; project?: { id: string; name: string; path: string } } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeView {
  bridgeUpdateAllowed?: boolean;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  observedAt: string | null;
  report: RuntimeReport | null;
  codexDefaults?: CodexSelection;
  codexUpdateRequest?: { id: string; clientRequestId: string; status: RuntimeRequestStatus } | null;
  bridgeUpdateRequest?: { id: string; clientRequestId: string; status: RuntimeRequestStatus } | null;
  sync: { desiredRevision: number; appliedRevision: number | null; error: string | null };
}

export interface ConnectionsSnapshot {
  available: boolean;
  connections: ModelConnection[];
  agents: { agentId: string; enabled: boolean; online: boolean; sync: RuntimeView['sync'] }[];
}

export const runtimeErrorMessages: Record<string, string> = {
  offline: '运行管理未连接，请检查助手连接后重试。',
  disabled: '此助手尚未启用运行管理。',
  busy: '这个话题仍在执行任务，请停止或等待完成后再切换。',
  unsupported: '当前运行时版本尚不支持这项操作。',
  unavailable: '运行时暂时无法提供这项信息。',
  not_applied: '运行时未确认设置，请刷新实际状态或查看话题中的提示。',
  conflict: '远端配置已被其他方式修改，请先检查该连接。',
  invalid_config: '连接配置无法应用，请检查接口类型、地址和模型名称。',
  failed: '运行时操作失败，请检查助手后重试。',
  timeout: '未收到运行时确认，操作可能已经执行，请先刷新状态。',
  restarted: '网关已重启，未完成操作的结果不确定，请先刷新状态。',
  revoked: '运行管理授权已撤销，未完成操作的结果不确定。',
  update_failed: 'Codex 更新失败，请在主机检查安装权限与网络后重试。',
  update_timeout: 'Codex 更新超时，结果尚未确认，请在主机检查后再操作。',
  update_reconnect_failed: 'Codex 更新后的重连验证失败，请在主机检查运行状态。',
  update_unavailable: '此主机暂不支持 Codex 自更新，请在主机检查安装方式与更新配置。',
  update_interrupted: '原生运行时更新被中断，结果尚未确认，请在主机检查后再操作。',
  update_bridge_failed: 'Bridge 更新失败，请在主机检查安装与服务状态。',
  update_bridge_timeout: 'Bridge 更新超时，结果尚未确认，请先检查主机状态。',
  update_bridge_reconnect_failed: 'Bridge 更新后的重连验证失败，请在主机检查运行状态。',
  update_bridge_unavailable: '此主机暂不支持 Bridge 自更新，请先升级主机部署。',
  update_bridge_interrupted: 'Bridge 更新被中断，结果尚未确认，请在主机检查后再操作。',
  update_bridge_manifest_invalid: 'Bridge 更新清单无效，请刷新可用版本后重试。',
};

export function runtimeError(code: string | null | undefined): string {
  return code ? runtimeErrorMessages[code] || runtimeErrorMessages.failed : '';
}
