import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const configSchema = z.object({
  gatewayUrl: z.string().url(), token: z.string().min(20),
  managementToken: z.string().min(20).optional(),
  accessClientId: z.string().optional(), accessClientSecret: z.string().optional(),
  stateDir: z.string().refine(isAbsolute), projectPath: z.string().refine(isAbsolute),
  projects: z.array(z.object({ id: z.string().min(1).max(120), name: z.string().min(1).max(120), path: z.string().refine(isAbsolute) }).strict()).max(100).optional(),
  projectRoots: z.array(z.object({ id: z.string().min(1).max(120), name: z.string().min(1).max(120), path: z.string().refine(isAbsolute) }).strict()).max(20).optional(),
  allowNativeUpdate: z.boolean().default(false),
  skillDirectories: z.array(z.string().refine(isAbsolute)).max(20).default([]),
  mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.union([
    z.object({ type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }).strict(),
    z.object({ type: z.enum(['http', 'sse']), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }).strict(),
  ])).default({}),
  claudeBinary: z.string().refine(isAbsolute).optional(), model: z.string().min(1).optional(),
  maxFileBytes: z.number().int().positive().max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  maxRemoteFileBytes: z.number().int().positive().max(2 * 1024 ** 3).optional(),
  approvalTimeoutMs: z.number().int().min(1000).max(600_000).default(300_000),
  maxConcurrentTopics: z.number().int().min(1).max(16).default(4),
  codexProvider: z.object({ configDir: z.string().refine(isAbsolute).optional() }).strict().optional(),
  provider: z.object({
    baseUrl: z.string().url(), tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    apiMode: z.enum(['anthropic_messages', 'chat_completions', 'responses']).default('anthropic_messages'),
    models: z.array(z.string().min(1).max(256)).optional(),
  }).strict().optional(),
}).strict().refine(value => !!value.accessClientId === !!value.accessClientSecret, 'Access credentials must be paired')
  .refine(value => !(value.provider && value.codexProvider), 'Choose either provider or codexProvider')
  .refine(value => !value.projects || new Set(value.projects.map(project => project.id)).size === value.projects.length, 'Duplicate project IDs')
  .refine(value => !Object.hasOwn(value.mcpServers, 'inbox'), 'The inbox MCP name is reserved');
export type ClaudeConfig = z.infer<typeof configSchema>;

export function messagesBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Provider must use an HTTPS origin (localhost HTTP allowed)');
  return url.href.replace(/\/$/, '').replace(/\/v1$/, '');
}

export function providerEnvironment(config: ClaudeConfig, source = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (!config.provider) return env;
  const url = new URL(config.provider.baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Provider must use an HTTPS origin (localhost HTTP allowed)');
  const token = source[config.provider.tokenEnv];
  if (!token) throw new Error('Configured provider token environment variable is missing');
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']) delete env[key];
  env.ANTHROPIC_BASE_URL = config.provider.apiMode === 'anthropic_messages' ? messagesBaseUrl(url.href) : url.href.replace(/\/$/, '');
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (config.model) for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[key] = config.model;
  return env;
}
