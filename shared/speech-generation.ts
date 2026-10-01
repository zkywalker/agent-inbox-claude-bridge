/** The Agent contract contains no vendor model, endpoint or credentials. */
export const speechLimits = { maxTextLength: 3000, maxConcurrent: 2, minSpeed: 0.5, maxSpeed: 2 } as const;
export interface SpeechRequest {
  clientRequestId: string;
  text: string;
  voice?: string;
  speed?: number;
  format?: 'mp3';
}
export interface SpeechVoice { id: string; name: string; providerVoiceId: string }
export interface SpeechSettings {
  enabled: boolean;
  provider: 'minimax';
  region: 'cn' | 'global';
  model: string;
  voices: SpeechVoice[];
  agentIds: string[];
  version: number;
  hasCredential: boolean;
  credentialStorageAvailable: boolean;
}
export type SpeechSettingsInput = Omit<SpeechSettings, 'hasCredential' | 'credentialStorageAvailable'> & { apiKey?: string };
export interface SpeechJob {
  id: string;
  clientRequestId: string;
  status: 'running' | 'succeeded' | 'failed' | 'uncertain';
  attachmentId: string | null;
  format: 'mp3';
  durationMs: number | null;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export const speechToolDescription = 'Generate speech with the owner-authorized Inbox TTS service. Check action=capabilities for available voice aliases. generate needs text and a stable clientRequestId; optional voice (default), speed (0.5–2), format (mp3). get needs jobId. Poll get until terminal. Generation returns an attachmentId and does not send a message. Send the attachment separately. Never automatically create a new paid request after failed or uncertain results. Do not supply vendor models, URLs or API keys.';
export const speechToolProperties = {
  action: { type: 'string', enum: ['capabilities', 'generate', 'get'] },
  text: { type: 'string', minLength: 1, maxLength: speechLimits.maxTextLength },
  clientRequestId: { type: 'string', minLength: 1, maxLength: 128 },
  voice: { type: 'string', description: 'An alias from capabilities; omit for default.' },
  speed: { type: 'number', minimum: speechLimits.minSpeed, maximum: speechLimits.maxSpeed },
  format: { type: 'string', enum: ['mp3'] },
  jobId: { type: 'string', format: 'uuid' },
};
