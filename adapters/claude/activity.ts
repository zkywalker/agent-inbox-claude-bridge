import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeActivity } from '../../shared/protocol.js';

type Entry = { activity: RuntimeActivity; detail: string };
const activeStates = new Set(['running', 'retrying', 'limited']);
const terminalStates = new Set(['completed', 'failed', 'stopped']);
const rateLimitStatus = (detail: string) => /HTTP\s+429\b|Request rejected \(429\)|\b429\b.*Concurrency limit exceeded/i.test(detail) ? 429 : undefined;

export class ClaudeActivity {
  private entries = new Map<string, Entry>();
  private taskTools = new Map<string, string>();
  private hiddenTasks = new Set<string>();
  private overflowReported = false;
  constructor(private publish: (activity: RuntimeActivity, detail: string) => void, private clean: (text: string) => string) {}
  private put(id: string, category: RuntimeActivity['category'], name: string, state: RuntimeActivity['state'], detail: string, extra: Partial<RuntimeActivity> = {}, restarted = false) {
    const previous = this.entries.get(id);
    if (!restarted && category !== 'request' && previous && terminalStates.has(previous.activity.state) && !terminalStates.has(state)) return;
    if (!previous && this.entries.size >= 300) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.publish({ id: 'progress-overflow', category: 'request', name: '部分进度已省略', state: 'unknown', updatedAt: new Date().toISOString() }, '本回合已记录 300 项过程；继续更新已有记录，但不再新增过程卡。原生任务和并发设置未改变。');
      }
      return;
    }
    const activity: RuntimeActivity = {
      id, category, name: this.clean(name).slice(0, 200) || '运行任务', state,
      ...extra, ...(previous ? { parentId: previous.activity.parentId } : {}), updatedAt: new Date().toISOString(),
    };
    const safeDetail = this.clean(detail).slice(0, 4000);
    this.entries.set(id, { activity, detail: safeDetail });
    this.publish(activity, safeDetail);
  }
  observe(event: SDKMessage) {
    if (event.type === 'assistant') {
      const requestId = `request:${event.parent_tool_use_id ?? 'main'}`;
      if (!event.error && this.entries.has(requestId)) this.put(requestId, 'request', '模型请求', 'completed', '已收到新的模型响应；不代表整项任务完成。', { parentId: event.parent_tool_use_id ?? undefined });
      for (const block of event.message.content) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown>;
        if (block.name === 'Skill') this.put(block.id, 'skill', typeof input.skill === 'string' ? input.skill : 'Skill', 'running', '原生技能调用已开始；子任务进度单独展示。', { parentId: event.parent_tool_use_id ?? undefined });
      }
      if (event.error) {
        const detail = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        this.put(`request:${event.parent_tool_use_id ?? 'main'}`, 'request', '模型请求', event.error === 'rate_limit' ? 'limited' : 'failed', detail || '原生模型请求报告错误。', { parentId: event.parent_tool_use_id ?? undefined, statusCode: rateLimitStatus(detail) });
      }
    }
    if (event.type === 'user' && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type !== 'tool_result') continue;
        const previous = this.entries.get(block.tool_use_id);
        if (previous) this.put(block.tool_use_id, previous.activity.category, previous.activity.name, block.is_error ? 'failed' : 'completed', block.is_error ? '原生工具返回错误；不代表子任务全部结束。' : '原生调用已返回；子任务结果以各自状态为准。', { parentId: previous.activity.parentId });
      }
    }
    if (event.type === 'tool_progress') {
      const taskId = event.task_id ?? this.taskTools.get(event.tool_use_id);
      if (taskId && this.hiddenTasks.has(taskId)) return;
      const id = taskId ? `task:${taskId}` : event.tool_use_id;
      const previous = this.entries.get(id)?.activity;
      const retry = event.subagent_retry;
      this.put(id, previous?.category ?? (taskId ? 'task' : 'tool'), previous?.name ?? event.tool_name, retry ? 'retrying' : 'running', retry ? '原生运行时正在重试请求；网关没有重放任务。' : '收到原生工具进度。', {
        parentId: previous?.parentId ?? event.parent_tool_use_id ?? undefined,
        tool: this.clean(event.tool_name).slice(0, 200), elapsedSeconds: event.elapsed_time_seconds,
        ...(retry ? { attempt: retry.attempt, maxRetries: retry.max_retries, retryDelayMs: retry.retry_delay_ms, statusCode: retry.error_status ?? undefined } : {}),
      });
    }
    if (event.type === 'system') {
      if (event.subtype === 'task_started' || event.subtype === 'task_notification') {
        if (event.ambient || event.skip_transcript) { this.hiddenTasks.add(event.task_id); return; }
      }
      if (event.subtype === 'task_started' || event.subtype === 'task_progress' || event.subtype === 'task_notification' || event.subtype === 'task_updated') {
        if (this.hiddenTasks.has(event.task_id)) return;
        const id = `task:${event.task_id}`;
        const previous = this.entries.get(id)?.activity;
        if ('tool_use_id' in event && event.tool_use_id) this.taskTools.set(event.tool_use_id, event.task_id);
        if (event.subtype === 'task_started') this.put(id, 'task', event.description, 'running', '原生任务已启动。', { parentId: event.tool_use_id }, true);
        if (event.subtype === 'task_progress') this.put(id, 'task', event.description, 'running', event.summary ?? '收到原生子任务进度。', { parentId: event.tool_use_id, tool: event.last_tool_name ? this.clean(event.last_tool_name).slice(0, 200) : undefined, elapsedSeconds: event.usage.duration_ms / 1000 });
        if (event.subtype === 'task_notification') this.put(id, 'task', previous?.name ?? '原生子任务', event.status, event.summary, { parentId: event.tool_use_id, elapsedSeconds: event.usage ? event.usage.duration_ms / 1000 : undefined, statusCode: event.status === 'failed' ? rateLimitStatus(event.summary) : undefined });
        if (event.subtype === 'task_updated') {
          const status = event.patch.status;
          const state = status === 'killed' ? 'stopped' : status === 'paused' || status === 'pending' ? 'unknown' : status ?? previous?.state ?? 'unknown';
          this.put(id, 'task', event.patch.description ?? previous?.name ?? '原生子任务', state, event.patch.error ?? '原生任务状态已更新。', { statusCode: event.patch.error ? rateLimitStatus(event.patch.error) : undefined });
        }
      }
      if (event.subtype === 'api_retry') this.put('request:main', 'request', '模型请求', 'retrying', '原生运行时报告请求重试；这不是网关自动重放。', { attempt: event.attempt, maxRetries: event.max_retries, retryDelayMs: event.retry_delay_ms, statusCode: event.error_status ?? undefined });
    }
    if (event.type === 'rate_limit_event') {
      const status = event.rate_limit_info.status;
      this.put('quota', 'request', '原生额度状态', status === 'allowed' ? 'completed' : 'limited', status === 'allowed' ? '原生运行时报告额度可用，不代表任务成功。' : status === 'allowed_warning' ? '原生运行时报告额度预警；请求不一定已被拒绝。' : '原生运行时报告额度限制；未收到重试事件时不推断正在重试。');
    }
    if (event.type === 'result' && event.is_error) {
      const detail = 'errors' in event ? event.errors.join('\n') : '原生回合报告失败。';
      this.put('request:main', 'request', '原生回合', 'failed', detail || '原生回合报告失败。', { statusCode: ('api_error_status' in event ? event.api_error_status : undefined) ?? rateLimitStatus(detail) });
    }
  }
  finish(interrupted: boolean) {
    for (const [id, { activity, detail }] of this.entries) {
      if (!activeStates.has(activity.state)) continue;
      this.put(id, activity.category, activity.name, 'unknown', `${detail}\n${interrupted ? '回合已中断' : '回合事件流已结束'}，未收到此项的终态；不推断成功或仍在执行。`, { parentId: activity.parentId, statusCode: activity.statusCode, elapsedSeconds: activity.elapsedSeconds, attempt: activity.attempt, maxRetries: activity.maxRetries, retryDelayMs: activity.retryDelayMs });
    }
  }
}
