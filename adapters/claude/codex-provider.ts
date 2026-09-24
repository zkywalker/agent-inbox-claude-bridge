import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { messagesBaseUrl, type ClaudeConfig } from './config.js';

function field(section: string, key: string): string | undefined {
  const lines = section.split('\n').filter(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (!lines.length) return undefined;
  if (lines.length !== 1) throw new Error('Unsupported Codex provider configuration');
  const value = lines[0].slice(lines[0].indexOf('=') + 1).trim();
  const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(value)?.[1];
  if (!quoted) throw new Error('Unsupported Codex provider configuration');
  return quoted.startsWith("'") ? quoted.slice(1, -1) : JSON.parse(quoted);
}

export async function resolveCodexProvider(config: ClaudeConfig, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeConfig> {
  if (!config.codexProvider) return config;
  try {
    const root = config.codexProvider.configDir ?? env.CODEX_HOME ?? join(homedir(), '.codex');
    const text = await readFile(join(root, 'config.toml'), 'utf8');
    const sections = text.split(/(?=^\s*\[)/m), top = sections.shift() ?? '';
    const provider = field(top, 'model_provider');
    if (!provider) throw new Error();
    const selected = sections.filter(section => {
      const header = section.split('\n')[0].trim().replace(/\s+#.*$/, '');
      return header === `[model_providers.${provider}]` || header === `[model_providers.${JSON.stringify(provider)}]`;
    });
    if (selected.length !== 1) throw new Error();
    const base = field(selected[0], 'base_url'), envKey = field(selected[0], 'env_key');
    const model = config.model ?? field(top, 'model');
    const apiKey = envKey ? env[envKey] : JSON.parse(await readFile(join(root, 'auth.json'), 'utf8')).OPENAI_API_KEY;
    if (!base || !model || typeof apiKey !== 'string' || !apiKey) throw new Error();
    const tokenEnv = 'INBOX_CLAUDE_CODEX_PROVIDER_TOKEN';
    const baseUrl = messagesBaseUrl(base);
    env[tokenEnv] = apiKey;
    const { codexProvider: _source, ...resolved } = config;
    return { ...resolved, model, provider: { baseUrl, tokenEnv, apiMode: 'anthropic_messages', models: [model] } };
  } catch { throw new Error('Cannot read the selected Codex API provider; configure an explicit Messages provider instead'); }
}
