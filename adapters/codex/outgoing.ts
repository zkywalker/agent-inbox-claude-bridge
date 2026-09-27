import { isDeepStrictEqual } from 'node:util';
import type { Message } from '../../shared/protocol.js';
import { Gateway, GatewayError } from './gateway.js';
import { BridgeState, type Outgoing } from './state.js';

export const OUTGOING_MAX_TEXT = 100_000;
export const OUTGOING_AUTH_RETRY_MS = 60_000;
const truncationNotice = '\n\n[回复超过网关单条消息限制，显示内容已截断；完整原文保留在 Bridge 本地出站记录中。]';

/** Only the wire projection is bounded; durable runtime output remains complete. */
export function outgoingProjection(message: Outgoing): Outgoing {
  if (message.text.length <= OUTGOING_MAX_TEXT) return message;
  let text = message.text.slice(0, OUTGOING_MAX_TEXT - truncationNotice.length);
  // Do not cut an emoji's surrogate pair in half.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { ...message, text: text + truncationNotice };
}

function matches(created: Message, message: Outgoing) {
  return created.text === message.text && created.streaming === message.streaming
    && (created.label ?? null) === (message.label ?? null)
    && isDeepStrictEqual(created.process, message.process)
    && isDeepStrictEqual(created.runtimeActivity, message.runtimeActivity);
}

/** Delivery retries never execute a runtime. Identity and output live in BridgeState. */
export class OutgoingTransport {
  private pending?: Promise<number>;
  constructor(readonly state: BridgeState, readonly gateway: Gateway, readonly now = Date.now) {}
  flush(): Promise<number> {
    if (this.pending) return this.pending;
    this.pending = this.sendBatch().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async sendBatch(): Promise<number> {
    const queues = new Map<string, ReturnType<BridgeState['dirty']>>();
    for (const row of this.state.dirty(this.now())) {
      const message: Outgoing = JSON.parse(row.body as string);
      const queue = queues.get(message.conversationId) ?? [];
      queue.push(row); queues.set(message.conversationId, queue);
    }
    const topics = [...queues.values()];
    let next = 0, sent = 0, authenticationFailed = false;
    // Different topics retain a send opportunity even if another request is slow.
    const worker = async () => {
      while (next < topics.length && !authenticationFailed) {
        const rows = topics[next++];
        for (const row of rows) {
          if (authenticationFailed) break;
          const message = outgoingProjection(JSON.parse(row.body as string));
          const key = row.key as string, revision = Number(row.revision);
          this.state.attemptedOutgoing(key, this.now());
          try {
            let messageId = row.message_id as string | null;
            let needsPatch = !!messageId;
            if (!messageId) {
              const { key: _key, conversationId: _conversationId, notificationProcessId: _notificationProcessId, ...body } = message;
              const created = await this.gateway.call<Message>(`/connector/conversations/${message.conversationId}/messages`, { ...body, attachmentIds: message.attachmentIds ?? [], clientMessageId: key });
              messageId = created.id;
              // A lost POST response may replay an older committed revision.
              needsPatch = !matches(created, message);
              if (needsPatch) this.state.createdOutgoing(key, messageId);
            }
            if (needsPatch) await this.gateway.call(`/connector/messages/${messageId}`, {
              text: message.text, streaming: message.streaming, ...(message.label ? { label: message.label } : {}),
              ...(message.process ? { process: message.process } : {}), ...(message.runtimeActivity ? { runtimeActivity: message.runtimeActivity } : {}),
            }, false, 'PATCH');
            // A newer revision created during either request must remain dirty.
            this.state.sent(key, messageId, revision); sent++;
          } catch (error) {
            const at = this.now(), prior = this.state.outgoingFailure(key);
            const status = error instanceof GatewayError ? error.status : null;
            // These statuses mean this output cannot be accepted without changing it.
            const blocked = status !== null && [400, 404, 405, 409, 410, 413, 415, 422].includes(status);
            const auth = status === 401 || status === 403;
            const attempts = (prior?.attempts ?? 0) + 1;
            const retryAt = at + (auth ? OUTGOING_AUTH_RETRY_MS : Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)));
            // Never persist arbitrary exception text, response bodies or credentials.
            const reason = auth ? 'authentication_required' : blocked ? `http_${status}_output_rejected` : status === 429 ? 'rate_limited' : 'transport_unavailable';
            this.state.failOutgoing(key, { revision, attempts, retryAt, blocked, status, reason, failedAt: at });
            if (auth) {
              authenticationFailed = true;
              this.state.saveTool('outgoing:authentication', { retryAt, reason, status });
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, topics.length) }, () => worker()));
    return sent;
  }
}
