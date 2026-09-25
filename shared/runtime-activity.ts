import type { Message, RuntimeActivity } from './protocol.js';

export function legacyHeartbeatTarget(activity: RuntimeActivity): string | undefined {
  if (activity.category !== 'tool' || !activity.parentId) return;
  const prefix = `${activity.parentId}-heartbeat-`;
  if (activity.id.startsWith(prefix) && /^\d+$/.test(activity.id.slice(prefix.length))) return activity.parentId;
}

export function activityRunId(activity: RuntimeActivity): string | undefined {
  return activity.runId ?? activity.id.match(/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):/i)?.[1];
}

export function projectRuntimeActivities(messages: Message[]): Message[] {
  const key = (message: Message, id: string) => JSON.stringify([message.conversationId, activityRunId(message.runtimeActivity!), id]);
  const targets = new Map(messages.filter(message => message.runtimeActivity && !legacyHeartbeatTarget(message.runtimeActivity)).map(message => [key(message, message.runtimeActivity!.id), message]));
  const heartbeats = new Map<string, string>();
  for (const message of messages) {
    const activity = message.runtimeActivity;
    const target = activity && legacyHeartbeatTarget(activity);
    if (!activity || !target) continue;
    const identity = key(message, target);
    if (activity.updatedAt > (heartbeats.get(identity) ?? '')) heartbeats.set(identity, activity.updatedAt);
  }
  const missing = new Set<string>();
  return messages.flatMap(message => {
    const activity = message.runtimeActivity;
    if (!activity) return [message];
    const target = legacyHeartbeatTarget(activity);
    const identity = key(message, target ?? activity.id);
    if (target) {
      if (targets.has(identity) || missing.has(identity)) return [];
      missing.add(identity);
      return [{ ...message, text: '仅收到历史心跳，关联调用未加载；不能据此确认任务类型或执行状态。', runtimeActivity: { ...activity, id: target, category: 'request' as const, name: '关联调用未加载', state: 'unknown' as const, lastHeartbeatAt: heartbeats.get(identity) } }];
    }
    const heartbeat = heartbeats.get(identity);
    return [{ ...message, runtimeActivity: { ...activity, lastHeartbeatAt: heartbeat && heartbeat > (activity.lastHeartbeatAt ?? '') ? heartbeat : activity.lastHeartbeatAt } }];
  });
}
