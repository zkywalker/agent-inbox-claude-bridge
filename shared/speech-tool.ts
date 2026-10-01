import { z } from 'zod';
import { speechLimits } from './speech-generation.js';

export const speechToolSchema = z.object({
  action: z.enum(['capabilities', 'generate', 'get']),
  text: z.string().min(1).max(speechLimits.maxTextLength).nullish(),
  clientRequestId: z.string().min(1).max(128).nullish(),
  voice: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullish(),
  speed: z.number().min(speechLimits.minSpeed).max(speechLimits.maxSpeed).nullish(),
  format: z.literal('mp3').nullish(), jobId: z.string().uuid().nullish(),
}).strict();

export async function callSpeechTool(raw: unknown, call: (path: string, body?: unknown) => Promise<unknown>) {
  const args = speechToolSchema.parse(raw);
  if (args.action === 'capabilities') return call('/connector/speech-generation');
  if (args.action === 'get') {
    if (!args.jobId) throw new Error('Supply jobId for get.');
    return call(`/connector/speech-generation/jobs/${args.jobId}`);
  }
  if (!args.text || !args.clientRequestId) throw new Error('Supply text and a stable clientRequestId.');
  return call('/connector/speech-generation/jobs', Object.fromEntries(Object.entries({ text: args.text, clientRequestId: args.clientRequestId, voice: args.voice, speed: args.speed, format: args.format }).filter(([, value]) => value != null)));
}
