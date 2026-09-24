import type { CodexSelection } from './codex-settings.js';
export const PROTOCOL_VERSION = 1;
export type AgentKind = "hermes" | "openclaw" | "nanobot" | "codex" | "claude" | "custom";
export const isCodingAgent = (kind: AgentKind | undefined) => kind === 'codex' || kind === 'claude';
export const avatarPresets = ["codex", "hermes", "openclaw", "nanobot", "inbox", "sparkles", "orbit", "leaf"] as const;
export type AvatarPreset = typeof avatarPresets[number];
export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  avatar?: Attachment | null;
  avatarEmoji?: string | null;
  avatarPreset?: AvatarPreset | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}
export interface Conversation {
  id: string;
  agentId: string;
  projectId?: string;
  /** Initial Codex selection only; confirmed current settings come from runtime reports. */
  codexSettings?: CodexSelection;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  unread: number;
  /** Latest agent chat/system sequence. Activity and edits do not advance it. */
  lastIncomingSeq?: number;
  /** Gateway presentation state after Hermes accepted a `/sethome` delivery. */
  isHomeChannel?: boolean;
  /** Fresh native Codex turn on this topic; absent when idle or unconfirmed. */
  codexActivity?: "running" | "waiting";
}
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  /** Remote files remain on the source agent and require a live transfer. */
  source?: "remote";
  /** Connection presence only; does not guarantee the source file still exists. */
  agentOnline?: boolean;
}
export type DeliveryStatus = "received" | "sending" | "delivered" | "failed";
export type MessageKind = "chat" | "activity" | "system";
/** Presentation-only Codex lifecycle, observed at the adapter boundary. */
export interface MessageProcess {
  id: string;
  state: "running" | "waiting" | "completed" | "failed" | "interrupted" | "unknown";
  startedAt: string;
  completedAt?: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "agent";
  kind: MessageKind;
  label: string | null;
  text: string;
  attachments: Attachment[];
  status: DeliveryStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
  streaming: boolean;
  process?: MessageProcess;
  codexApprovalId?: string;
}
export interface Delivery {
  id: string;
  conversation: Conversation;
  message: Message;
  history: Message[];
}
export interface Snapshot {
  agents: Agent[];
  conversations: Conversation[];
  revision: number;
  webVersion?: string;
}
export interface Identity {
  id: string;
  name: string;
  authMode: "development" | "access";
}
export interface ApiError {
  error: string;
  message: string;
}
