import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../adapters/claude/config.js';
import { resolveCodexProvider } from '../adapters/claude/codex-provider.js';
import { ClaudeBridge } from '../adapters/claude/bridge.js';
import { BridgeState } from '../adapters/codex/state.js';

test('direct Messages source remains local and never starts conversion listener', async context => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-runtime-')));
  const previous = process.env.INBOX_CLAUDE_CODEX_PROVIDER_TOKEN;
  let state: BridgeState | undefined, bridge: ClaudeBridge | undefined;
  context.after(async () => { await bridge?.management.close(); state?.close(); if (previous === undefined) delete process.env.INBOX_CLAUDE_CODEX_PROVIDER_TOKEN; else process.env.INBOX_CLAUDE_CODEX_PROVIDER_TOKEN = previous; await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'config.toml'), 'model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://example.com/v1"\n');
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key-only' }));
  const config = await resolveCodexProvider(configSchema.parse({ gatewayUrl: 'http://localhost', token: 'fixture-connector-not-for-network', projectPath: directory, stateDir: directory, codexProvider: { configDir: directory } }));
  state = new BridgeState(join(directory, 'test.sqlite')); bridge = new ClaudeBridge(config, state);
  await bridge.initialize('2.1.281');
  const options = bridge.management.options({ conversationId: 'fixture', projectId: 'default', threadId: null, turnId: null, state: 'idle', model: config.model!, provider: 'local', error: null });
  assert.equal(options.env?.ANTHROPIC_BASE_URL, 'https://example.com');
  assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, 'fixture-key-only');
  assert.equal(options.env?.INBOX_CLAUDE_CODEX_PROVIDER_TOKEN, undefined);
  assert.equal(bridge.management.proxy.origin, '');
  assert.ok(!JSON.stringify(config).includes('fixture-key-only'));
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.equal(bridge.management.report(null).capabilities.claudeBypassPermissions, true);
  const session = { conversationId: 'fixture', projectId: 'default', threadId: null, turnId: null, state: 'idle' as const, model: config.model!, provider: 'local', error: null };
  const trusted = bridge.management.options({ ...session, nativeSettings: { permissionMode: 'bypassPermissions' } });
  assert.equal(trusted.permissionMode, 'bypassPermissions');
  assert.equal(trusted.allowDangerouslySkipPermissions, true);
  for (const permissionMode of ['default', 'acceptEdits', 'plan', 'dontAsk'] as const) {
    assert.equal(bridge.management.options({ ...session, nativeSettings: { permissionMode } }).allowDangerouslySkipPermissions, false);
  }
  state.saveTool('claude:default-settings', { permissionMode: 'bypassPermissions' });
  assert.equal(bridge.management.initialSelection().nativeSettings.permissionMode, 'bypassPermissions');
  assert.equal(bridge.management.initialSelection({ permissionMode: 'default' }).nativeSettings.permissionMode, 'default');
  assert.equal(bridge.management.options({ ...session, nativeSettings: { permissionMode: 'default' } }).allowDangerouslySkipPermissions, false);
});
