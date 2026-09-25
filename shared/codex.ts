export interface CodexProject { id: string; name: string; path?: string; host?: string }
export type CodexSessionState = 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'unknown';
export interface CodexSession {
  conversationId: string;
  projectId: string;
  threadId: string | null;
  turnId: string | null;
  state: CodexSessionState;
  model: string | null;
  error: string | null;
  environment?: RuntimeEnvironment;
}
export interface CodexQuestion {
  id: string; question: string; options: { label: string; description: string }[]; isSecret: boolean;
}
export type CodexApprovalResolution = 'approved' | 'rejected' | 'timed-out' | 'cancelled';
export interface CodexApproval {
  scope?: 'once' | 'turn';
  id: string; conversationId: string; threadId: string; turnId: string;
  kind: 'command' | 'file-change' | 'permissions' | 'user-input';
  title: string; details: string; choices: { id: string; label: string }[];
  questions: CodexQuestion[];
  status: 'pending' | 'submitted' | 'resolved' | 'expired';
  createdAt: string;
}
export interface CodexAction {
  id: string; conversationId: string; instanceId: string;
  kind: 'interrupt' | 'approval';
  payload: { turnId?: string; approvalId?: string; decision?: string; answers?: Record<string, string[]> };
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  error: string | null;
}
export interface CodexView {
  enabled: boolean; online: boolean; version: string | null;
  account: 'apiKey' | 'chatgpt' | 'external' | 'missing' | 'unknown';
  projects: CodexProject[]; session: CodexSession | null; approvals: CodexApproval[];
}
import type { RuntimeEnvironment } from './runtime.js';
