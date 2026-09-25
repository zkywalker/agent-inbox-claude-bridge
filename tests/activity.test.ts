import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeActivity } from '../shared/protocol.js';
import { ClaudeActivity } from '../adapters/claude/activity.js';

function tracker() {
  const entries = new Map<string, { activity: RuntimeActivity; detail: string }>();
  const activity = new ClaudeActivity((record, detail) => entries.set(record.id, { activity: record, detail }), text => text.replaceAll('fixture-secret', '[redacted]'));
  return { entries, activity, send: (event: unknown) => activity.observe(event as SDKMessage) };
}

test('Skill and nested tasks retain independent identity, redact summaries, and do not publish prompts or thinking', () => {
  const { entries, send, activity } = tracker();
  send({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'code-review', args: 'private-input' } }, { type: 'thinking', thinking: 'private-thought' }] } });
  send({ type: 'system', subtype: 'task_started', task_id: 'first', tool_use_id: 'spawn', description: 'Review permissions', prompt: 'private-prompt' });
  send({ type: 'system', subtype: 'task_started', task_id: 'second', description: 'Review permissions' });
  send({ type: 'system', subtype: 'task_progress', task_id: 'first', description: 'Review permissions', summary: 'fixture-secret progress', usage: { duration_ms: 12000 }, last_tool_name: 'Read' });
  assert.equal(entries.get('task:first')?.activity.elapsedSeconds, 12);
  assert.equal(entries.get('task:first')?.detail, '[redacted] progress');
  send({ type: 'system', subtype: 'task_notification', task_id: 'first', status: 'failed', summary: 'API Error 429: Concurrency limit exceeded', output_file: '/private/secret-file' });
  send({ type: 'system', subtype: 'task_progress', task_id: 'first', description: 'late progress', usage: { duration_ms: 15000 } });
  assert.equal(entries.get('task:first')?.activity.state, 'failed');
  assert.equal(entries.get('task:first')?.activity.statusCode, 429);
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'skill', is_error: false, content: 'private-output' }] } });
  assert.equal(entries.get('skill')?.activity.state, 'completed');
  activity.finish(false);
  assert.equal(entries.get('task:second')?.activity.state, 'unknown');
  assert.equal(entries.get('task:first')?.activity.state, 'failed');
  assert(!JSON.stringify([...entries.values()]).includes('private-'));
});

test('native retry and quota evidence stays distinct from failure, terminal result and gateway replay', () => {
  const { entries, send, activity } = tracker();
  send({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 10000, error_status: 429 });
  assert.equal(entries.get('request:main')?.activity.state, 'retrying');
  assert.equal(entries.get('request:main')?.activity.statusCode, 429);
  send({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'new response' }] } });
  assert.equal(entries.get('request:main')?.activity.state, 'completed');
  send({ type: 'result', is_error: true, errors: ['Upstream failure'], api_error_status: 429 });
  assert.equal(entries.get('request:main')?.activity.state, 'failed');
  assert.equal(entries.get('request:main')?.activity.statusCode, 429);
  send({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'new response' }] } });
  send({ type: 'tool_progress', tool_use_id: 'spawn', tool_name: 'Agent', parent_tool_use_id: 'skill', elapsed_time_seconds: 30, subagent_retry: { attempt: 3, max_retries: 5, retry_delay_ms: 20000, error_status: 429 } });
  assert.equal(entries.get('spawn')?.activity.parentId, 'skill');
  assert.equal(entries.get('spawn')?.activity.state, 'retrying');
  send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
  assert.equal(entries.get('quota')?.activity.state, 'limited');
  activity.finish(true);
  assert.equal(entries.get('spawn')?.activity.state, 'unknown');
  assert.equal(entries.get('request:main')?.activity.state, 'completed');
});

test('ambient tasks remain hidden and missing start is not required for terminal notification', () => {
  const { entries, send } = tracker();
  send({ type: 'system', subtype: 'task_started', task_id: 'ambient', description: 'watcher', ambient: true });
  send({ type: 'system', subtype: 'task_progress', task_id: 'ambient', description: 'watcher', usage: { duration_ms: 1 } });
  send({ type: 'system', subtype: 'task_notification', task_id: 'unknown-start', status: 'stopped', summary: 'stopped' });
  assert.equal(entries.size, 1);
  assert.equal(entries.get('task:unknown-start')?.activity.state, 'stopped');
  send({ type: 'system', subtype: 'task_started', task_id: 'unknown-start', description: 'Explicitly resumed task' });
  assert.equal(entries.get('task:unknown-start')?.activity.state, 'running');
  for (let index = 0; index < 305; index++) send({ type: 'system', subtype: 'task_started', task_id: `bounded-${index}`, description: 'bounded task' });
  assert.equal(entries.size, 301);
  assert.equal(entries.get('progress-overflow')?.activity.state, 'unknown');
});
