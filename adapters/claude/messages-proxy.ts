import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';

export interface ProxyConnection { id: string; baseUrl: string; apiKey: string; apiMode: 'chat_completions' | 'responses' | 'anthropic_messages'; models: string[] }
export class CompatibilityError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const unsupported = () => new CompatibilityError(400, 'unsupported_feature');
const limit = 8 * 1024 * 1024;
const object = z.record(z.string(), z.any());
const requestSchema = z.object({
  model: z.string().min(1).max(256), messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.union([z.string(), z.array(object)]) }).strict()).min(1).max(2000),
  max_tokens: z.number().int().positive().max(131072), stream: z.boolean().optional(), system: z.union([z.string(), z.array(object)]).optional(),
  tools: z.array(object).max(256).optional(), tool_choice: object.optional(), temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(), stop_sequences: z.array(z.string()).max(16).optional(),
  thinking: object.optional(), output_config: object.optional(), metadata: object.optional(),
  service_tier: z.string().optional(),
}).strict();
type MessagesRequest = z.infer<typeof requestSchema>;
const blocks = (content: string | Record<string, any>[]) => typeof content === 'string' ? [{ type: 'text', text: content }] : content;
function text(content: string | Record<string, any>[] | undefined): string {
  if (content === undefined) return '';
  return blocks(content).map(block => { if (block.type !== 'text' || typeof block.text !== 'string') throw unsupported(); return block.text; }).join('\n');
}
function image(block: Record<string, any>) {
  const source = block.source;
  if (source?.type !== 'base64' || !/^image\/(png|jpeg|gif|webp)$/.test(source.media_type) || typeof source.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) throw unsupported();
  return `data:${source.media_type};base64,${source.data}`;
}
export function translateRequest(raw: unknown, mode: 'chat_completions' | 'responses') {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new CompatibilityError(400, 'invalid_request');
  const input = parsed.data;
  if (input.thinking && input.thinking.type !== 'disabled') throw unsupported();
  if (input.service_tier && input.service_tier !== 'auto') throw unsupported();
  if (input.output_config && Object.keys(input.output_config).some(key => !['effort', 'format'].includes(key))) throw unsupported();
  if (mode === 'responses' && input.stop_sequences?.length) throw unsupported();
  const tools = input.tools?.map(tool => {
    if (tool.type && tool.type !== 'custom' || typeof tool.name !== 'string' || !tool.input_schema || tool.defer_loading) throw unsupported();
    const definition = { name: tool.name, description: tool.description, parameters: tool.input_schema };
    return mode === 'responses' ? { type: 'function', ...definition, strict: false } : { type: 'function', function: definition };
  });
  let toolChoice: any;
  if (input.tool_choice) {
    const choice = input.tool_choice;
    if (choice.type === 'auto') toolChoice = 'auto';
    else if (choice.type === 'any') toolChoice = 'required';
    else if (choice.type === 'none') toolChoice = 'none';
    else if (choice.type === 'tool' && tools?.some(tool => (tool as any).name === choice.name || (tool as any).function?.name === choice.name))
      toolChoice = mode === 'responses' ? { type: 'function', name: choice.name } : { type: 'function', function: { name: choice.name } };
    else throw unsupported();
  }
  const messages: any[] = [], responseInput: any[] = [];
  const system = text(input.system);
  if (system) messages.push({ role: 'system', content: system });
  const pending = new Set<string>();
  for (const message of input.messages) {
    const content: any[] = [], calls: any[] = [];
    const originalBlocks = blocks(message.content);
    const messageBlocks = mode === 'responses' && message.role === 'assistant'
      ? [...originalBlocks.filter(block => block.type === 'redacted_thinking'), ...originalBlocks.filter(block => block.type !== 'redacted_thinking')]
      : originalBlocks;
    for (const block of messageBlocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
        responseInput.push({ role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text }] });
      } else if (block.type === 'image' && message.role === 'user') {
        const url = image(block);
        content.push({ type: 'image_url', image_url: { url } });
        responseInput.push({ role: 'user', content: [{ type: 'input_image', image_url: url }] });
      } else if (block.type === 'tool_use' && message.role === 'assistant' && typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object') {
        if (pending.has(block.id)) throw new CompatibilityError(400, 'duplicate_tool_call');
        pending.add(block.id);
        const args = JSON.stringify(block.input);
        calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: args } });
        responseInput.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: args });
      } else if (block.type === 'tool_result' && message.role === 'user' && pending.has(block.tool_use_id)) {
        pending.delete(block.tool_use_id);
        const output = `${block.is_error ? 'Tool failed: ' : ''}${text(block.content)}`;
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: output });
        responseInput.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
      } else if (block.type === 'redacted_thinking' && mode === 'responses') {
        let item: any;
        try { item = JSON.parse(Buffer.from(block.data, 'base64').toString('utf8')); } catch { throw unsupported(); }
        if (item.type !== 'reasoning' || typeof item.encrypted_content !== 'string' || Object.keys(item).some(key => !['type', 'id', 'encrypted_content', 'summary', 'status'].includes(key))) throw unsupported();
        responseInput.push(item);
      } else throw unsupported();
    }
    if (content.length || calls.length) messages.push({ role: message.role, content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  if (pending.size) throw new CompatibilityError(400, 'missing_tool_result');
  const outputFormat = input.output_config?.format;
  if (outputFormat && (outputFormat.type !== 'json_schema' || !outputFormat.schema)) throw unsupported();
  const common = { model: input.model, stream: true, tools, tool_choice: toolChoice,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}), ...(input.top_p !== undefined ? { top_p: input.top_p } : {}),
    ...(input.tool_choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
  };
  const body = mode === 'responses' ? { ...common, input: responseInput, instructions: system || undefined, max_output_tokens: input.max_tokens, store: false,
    include: ['reasoning.encrypted_content'], ...(input.output_config?.effort ? { reasoning: { effort: input.output_config.effort } } : {}),
    ...(outputFormat ? { text: { format: { type: 'json_schema', name: 'response', schema: outputFormat.schema, strict: true } } } : {}),
  } : { ...common, messages, max_completion_tokens: input.max_tokens, stream_options: { include_usage: true },
    ...(input.stop_sequences?.length ? { stop: input.stop_sequences } : {}), ...(input.output_config?.effort ? { reasoning_effort: input.output_config.effort } : {}),
    ...(outputFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: outputFormat.schema, strict: true } } } : {}),
  };
  return { input, body };
}

export async function* readSse(response: Response): AsyncGenerator<any> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new CompatibilityError(502, 'upstream_protocol_error');
  const decoder = new TextDecoder(); let buffer = '', bytes = 0;
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > limit) throw new CompatibilityError(502, 'upstream_response_too_large');
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { yield { type: 'done' }; continue; }
      try { yield JSON.parse(data); } catch { throw new CompatibilityError(502, 'invalid_upstream_event'); }
    }
  }
  if (buffer.trim()) throw new CompatibilityError(502, 'truncated_upstream_event');
}

async function convertResponse(response: Response, request: MessagesRequest, mode: 'chat_completions' | 'responses', emit: (type: string, value: any) => Promise<void>) {
  const id = `msg_${randomUUID().replaceAll('-', '')}`, content: any[] = [];
  let output = '', textOpen = false, terminal = false, finished: string | null = null, usage: any = {}, finalResponse: any;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  await emit('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const append = async (value: string) => {
    if (!textOpen) { textOpen = true; await emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); }
    output += value;
    await emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
  };
  for await (const event of readSse(response)) {
    if (event.error || event.type === 'error' || event.type === 'response.failed') throw new CompatibilityError(502, 'upstream_generation_failed');
    if (mode === 'chat_completions') {
      if (event.type === 'done') { terminal = true; continue; }
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0]; if (!choice) continue;
      if (choice.delta?.content) await append(choice.delta.content);
      if (choice.delta?.refusal) await append(choice.delta.refusal);
      for (const part of choice.delta?.tool_calls ?? []) {
        if (!Number.isInteger(part.index)) throw new CompatibilityError(502, 'invalid_tool_call');
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.arguments += part.function?.arguments ?? ''; calls.set(part.index, call);
      }
      if (choice.finish_reason) finished = choice.finish_reason;
    } else {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') await append(event.delta);
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        finalResponse = event.response; usage = finalResponse?.usage ?? {}; terminal = true;
        finished = event.type === 'response.completed' ? 'stop' : finalResponse?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : null;
      }
    }
  }
  if (!terminal || !finished) throw new CompatibilityError(502, 'upstream_stream_incomplete');
  if (finalResponse) {
    let expected = '';
    for (const item of finalResponse.output ?? []) {
      if (item.type === 'message') for (const block of item.content ?? []) expected += block.text ?? block.refusal ?? '';
      else if (item.type === 'function_call') calls.set(calls.size, { id: item.call_id, name: item.name, arguments: item.arguments });
      else if (item.type === 'reasoning' && item.encrypted_content) content.push({ type: 'redacted_thinking', data: Buffer.from(JSON.stringify(item)).toString('base64') });
      else if (item.type !== 'reasoning') throw unsupported();
    }
    if (!output && expected) await append(expected);
    else if (output !== expected) throw new CompatibilityError(502, 'upstream_text_mismatch');
  }
  if (textOpen) { await emit('content_block_stop', { type: 'content_block_stop', index: 0 }); content.unshift({ type: 'text', text: output }); }
  for (const call of calls.values()) {
    let input: unknown;
    try { input = JSON.parse(call.arguments); } catch { throw new CompatibilityError(502, 'invalid_tool_arguments'); }
    if (!call.id || !call.name || !input || Array.isArray(input) || typeof input !== 'object') throw new CompatibilityError(502, 'invalid_tool_call');
    content.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  for (let index = textOpen ? 1 : 0; index < content.length; index++) {
    const block = content[index];
    await emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block });
    if (block.type === 'tool_use') await emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    await emit('content_block_stop', { type: 'content_block_stop', index });
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const mappedUsage = { input_tokens: Math.max(0, (usage.prompt_tokens ?? usage.input_tokens ?? 0) - cached), output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
  const reason = finished === 'length' ? 'max_tokens' : calls.size ? 'tool_use' : finished === 'content_filter' ? 'refusal' : 'end_turn';
  await emit('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: mappedUsage });
  await emit('message_stop', { type: 'message_stop' });
  return { id, type: 'message', role: 'assistant', model: request.model, content, stop_reason: reason, stop_sequence: null, usage: mappedUsage };
}

export class MessagesProxy {
  readonly token = randomBytes(32).toString('base64url');
  private server?: Server;
  private routes = new Map<string, ProxyConnection>();
  private active = new Set<AbortController>();
  origin = '';
  configure(connections: ProxyConnection[]) {
    const routes = new Map<string, ProxyConnection>();
    for (const connection of connections) {
      const url = new URL(connection.baseUrl);
      if (!/^[\w-]+$/.test(connection.id) || routes.has(connection.id) || !connection.apiKey || !connection.models.length || url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new CompatibilityError(400, 'invalid_provider');
      routes.set(connection.id, { ...connection, models: [...connection.models] });
    }
    for (const controller of this.active) controller.abort();
    this.routes = routes;
  }
  url(id: string) { if (!this.routes.has(id) || !this.origin) throw new Error('Provider unavailable'); return `${this.origin}/${id}`; }
  async start() {
    if (this.server) return;
    this.server = createServer(async (request, response) => {
      const auth = request.headers.authorization?.replace(/^Bearer /, '') ?? request.headers['x-api-key'];
      const supplied = Buffer.from(typeof auth === 'string' ? auth : ''); const expected = Buffer.from(this.token);
      const fail = (status: number, code: string) => {
        const body = { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: code } };
        if (response.headersSent) response.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        else { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
      };
      if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { fail(401, 'unauthorized'); return; }
      const match = /^\/([\w-]+)\/v1\/messages(\/count_tokens)?(?:\?beta=true)?$/.exec(request.url ?? '');
      const connection = match ? this.routes.get(match[1]) : undefined;
      if (request.method !== 'POST' || !connection) { fail(404, 'not_found'); return; }
      if (this.active.size >= 16) { fail(429, 'proxy_busy'); return; }
      const controller = new AbortController(); this.active.add(controller);
      const timeout = setTimeout(() => controller.abort(), 180_000);
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.on('close', disconnected); request.on('aborted', () => controller.abort());
      let ping: ReturnType<typeof setInterval> | undefined;
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new CompatibilityError(413, 'request_too_large'); chunks.push(chunk); }
        let raw: any;
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CompatibilityError(400, 'invalid_json'); }
        if (!connection.models.includes(raw.model)) throw new CompatibilityError(400, 'model_not_allowed');
        const base = connection.baseUrl.replace(/\/$/, '');
        if (connection.apiMode === 'anthropic_messages') {
          const upstream = await fetch(`${base}${base.endsWith('/v1') ? '' : '/v1'}/messages${match?.[2] ?? ''}`, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${connection.apiKey}`, 'x-api-key': connection.apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(typeof request.headers['anthropic-beta'] === 'string' ? { 'anthropic-beta': request.headers['anthropic-beta'] } : {}) }, body: JSON.stringify(raw) });
          if (!upstream.ok) throw new CompatibilityError(upstream.status, 'upstream_request_failed');
          response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
          for await (const chunk of upstream.body as any) if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
          response.end(); return;
        }
        if (match?.[2]) throw new CompatibilityError(501, 'exact_token_count_unavailable');
        const { input, body } = translateRequest(raw, connection.apiMode);
        const upstream = await fetch(`${base}/${connection.apiMode === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${connection.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!upstream.ok) { await upstream.body?.cancel(); throw new CompatibilityError(upstream.status, 'upstream_request_failed'); }
        if (input.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          ping = setInterval(() => { if (!response.writableNeedDrain) response.write('event: ping\ndata: {"type":"ping"}\n\n'); }, 10_000);
        }
        const emit = async (type: string, value: any) => {
          if (controller.signal.aborted) throw new Error('Aborted');
          if (input.stream && !response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)) await once(response, 'drain', { signal: controller.signal });
        };
        const result = await convertResponse(upstream, input, connection.apiMode, emit);
        if (!input.stream) { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); }
        else response.end();
      } catch (error) { if (!response.destroyed) fail(error instanceof CompatibilityError ? error.status : 502, error instanceof CompatibilityError ? error.code : 'upstream_unavailable'); }
      finally { clearInterval(ping); clearTimeout(timeout); controller.abort(); this.active.delete(controller); response.off('close', disconnected); }
    });
    this.server.requestTimeout = 30_000; this.server.headersTimeout = 10_000;
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async close() { for (const controller of this.active) controller.abort(); if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined; } }
}
