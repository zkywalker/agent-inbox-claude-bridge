export const approvalPolicies = ['on-request', 'untrusted', 'never'] as const;
export const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const approvalsReviewers = ['user', 'auto_review'] as const;
export const collaborationModes = ['default', 'plan'] as const;
export const personalities = ['none', 'friendly', 'pragmatic'] as const;
export const reasoningSummaries = ['auto', 'concise', 'detailed', 'none'] as const;
export const serviceTiers = ['default', 'fast'] as const;

export interface CodexOptions {
  approvalPolicy?: typeof approvalPolicies[number];
  approvalsReviewer?: typeof approvalsReviewers[number];
  sandboxMode?: typeof sandboxModes[number];
  networkAccess?: boolean;
  collaborationMode?: typeof collaborationModes[number];
  personality?: typeof personalities[number];
  summary?: typeof reasoningSummaries[number];
  serviceTier?: typeof serviceTiers[number];
}
export type CodexSelection = CodexOptions & { model?: string; effort?: string };
export interface CodexSettingsReport {
  values: CodexOptions;
  source: 'runtime' | 'defaults';
  allowed: { approvalPolicies: string[]; sandboxModes: string[]; approvalsReviewers: string[]; collaborationModes: string[] };
}
export const codexOptionKeys = ['approvalPolicy', 'approvalsReviewer', 'sandboxMode', 'networkAccess', 'collaborationMode', 'personality', 'summary', 'serviceTier'] as const;
export function selectCodexOptions(value: CodexSelection): CodexOptions {
  return Object.fromEntries(codexOptionKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
export function canonicalSelection(value: object | undefined): string | null {
  return value && Object.keys(value).length ? JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))) : null;
}
export function codexOptionsAllowed(value: CodexOptions, allowed: CodexSettingsReport['allowed']): boolean {
  return (!value.approvalPolicy || allowed.approvalPolicies.includes(value.approvalPolicy)) &&
    (!value.approvalsReviewer || allowed.approvalsReviewers.includes(value.approvalsReviewer)) &&
    (!value.sandboxMode || allowed.sandboxModes.includes(value.sandboxMode)) &&
    (!value.collaborationMode || allowed.collaborationModes.includes(value.collaborationMode)) &&
    !(value.sandboxMode === 'danger-full-access' && value.networkAccess === false);
}
