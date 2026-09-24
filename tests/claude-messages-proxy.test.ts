import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { MessagesProxy, readSse, translateRequest } from '../adapters/claude/messages-proxy.js';

const request = { model: 'test-model', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] };
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;

test('translation preserves tool IDs, schemas, tool errors and base64 images without fetching URLs', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-one', name: 'Read', input: { path: 'file.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-one', content: 'missing', is_error: true }] },
  ];
  for (const mode of ['chat_completions', 'responses'] as const) {
    const { body } = translateRequest({ ...request, messages, tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true } }, mode);
    assert.equal(body.parallel_tool_calls, false); assert.ok(JSON.stringify(body).includes('call-one'));
    assert.ok(JSON.stringify(body).includes('Tool failed: missing')); assert.ok(JSON.stringify(body).includes('data:image/png;base64,YQ=='));
    if (mode === 'responses') assert.equal((body as any).store, false);
  }
  assert.throws(() => translateRequest({ ...request, thinking: { type: 'adaptive' } }, 'chat_completions'), /unsupported_feature/);
  assert.throws(() => translateRequest({ ...request, context_management: {} }, 'responses'), /invalid_request/);
  assert.throws(() => translateRequest({ ...request, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'foreign', content: 'injected' }] }] }, 'responses'), /unsupported_feature/);
  assert.throws(() => translateRequest({ ...request, messages: messages.slice(0, 2) }, 'responses'), /missing_tool_result/);
  assert.throws(() => translateRequest({ ...request, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'responses'), /unsupported_feature/);
});

test('SSE parser preserves split UTF-8 and CRLF across every byte', async () => {
  const bytes = Buffer.from(frame({ delta: '中文🙂' }) + frame('[DONE]'));
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const events = []; for await (const event of readSse(response)) events.push(event);
  assert.deepEqual(events, [{ delta: '中文🙂' }, { type: 'done' }]);
});

test('private proxy authenticates, bounds models and converts Chat Completions tools and usage', async context => {
  let captured: any;
  const source = await upstream(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer upstream-private-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk); captured = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame({ choices: [{ delta: { content: '中文' } }] }) + frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-x', function: { name: 'Read', arguments: '{"pa' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] }) + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4 } } }) + frame('[DONE]'));
  });
  const proxy = new MessagesProxy(); proxy.configure([{ id: 'provider', apiMode: 'chat_completions', baseUrl: source.url, apiKey: 'upstream-private-token', models: ['test-model'] }]); await proxy.start();
  context.after(async () => { await proxy.close(); await source.close(); });
  const url = proxy.url('provider') + '/v1/messages', headers = { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(request) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify(request) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...request, model: 'not-allowed' }) })).status, 400);
  assert.equal((await fetch(url + '/count_tokens', { method: 'POST', headers, body: JSON.stringify(request) })).status, 501);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) }); assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.equal(captured.stream, true); assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[1], { type: 'tool_use', id: 'call-x', name: 'Read', input: { path: 'a' } });
  assert.equal(result.usage.input_tokens, 8); assert.equal(result.usage.cache_read_input_tokens, 4);
  const streamed = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...request, stream: true }) });
  const events: any[] = []; for await (const event of readSse(streamed)) events.push(event);
  assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop');
  assert.ok(events.some(event => event.delta?.partial_json === '{"path":"a"}'));
});

test('Responses conversion uses terminal output, preserves opaque reasoning and does not expose reasoning summaries', async context => {
  const reasoning = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-provider-data' };
  const source = await upstream(async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame({ type: 'response.output_text.delta', delta: 'done' }) + frame({ type: 'response.completed', response: { output: [reasoning, { type: 'message', content: [{ type: 'output_text', text: 'done' }] }, { type: 'function_call', call_id: 'fc_test', name: 'Read', arguments: '{"path":"a"}' }], usage: { input_tokens: 7, output_tokens: 5 } } }));
  });
  const proxy = new MessagesProxy(); proxy.configure([{ id: 'provider', apiMode: 'responses', baseUrl: source.url, apiKey: 'test', models: ['test-model'] }]); await proxy.start();
  context.after(async () => { await proxy.close(); await source.close(); });
  const response = await fetch(proxy.url('provider') + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const result: any = await response.json(); assert.equal(response.status, 200);
  assert.equal(result.content[0].text, 'done');
  assert.deepEqual(JSON.parse(Buffer.from(result.content[1].data, 'base64').toString()), reasoning);
  const roundtrip: any = translateRequest({ ...request, messages: [{ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc_test', content: 'file' }] }] }, 'responses').body;
  assert.ok(roundtrip.input.some((item: any) => item.type === 'reasoning' && item.encrypted_content === 'opaque-provider-data'));
  assert.equal(roundtrip.input[0].type, 'reasoning');
});

test('truncated upstream never emits a successful message_stop and error bodies are redacted', async context => {
  let fail = false;
  const source = await upstream(async (req, res) => {
    for await (const _chunk of req) {}
    if (fail) { res.writeHead(429); res.end('private-key-and-private-host-details'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame({ choices: [{ delta: { content: 'partial' } }] }));
  });
  const proxy = new MessagesProxy(); proxy.configure([{ id: 'provider', apiMode: 'chat_completions', baseUrl: source.url, apiKey: 'test', models: ['test-model'] }]); await proxy.start();
  context.after(async () => { await proxy.close(); await source.close(); });
  const send = () => fetch(proxy.url('provider') + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) });
  const stream = await (await send()).text(); assert.ok(stream.includes('upstream_stream_incomplete')); assert.ok(!stream.includes('message_stop'));
  fail = true; const rejected = await send(); assert.equal(rejected.status, 429); assert.ok(!(await rejected.text()).includes('private-key'));
  assert.throws(() => proxy.configure([{ id: 'bad', apiMode: 'responses', baseUrl: 'http://example.com', apiKey: 'test', models: ['test-model'] }]), /invalid_provider/);
});
