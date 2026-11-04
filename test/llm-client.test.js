import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmClient, createSseParser, classifyProviderError, buildRequestBody, parseToolArguments, retryDelayMs, parseRetryAfter, LlmError,
} from '../src/llm/client.js';
import { PROVIDERS, resolveLlmConfig, inferProvider, normalizeProvider } from '../src/llm/providers.js';
import { createFakeFetch } from './fakes/fake-fetch.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const CJK = /[一-鿿]/;

function chunk(delta, finish = null, extra = {}) {
  return { id: 'cmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}

/** SSE text: objects become `data: {json}` events, strings are passed through verbatim. */
function sse(...parts) {
  return parts.map((p) => (typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\n\n`)).join('');
}

/** Splits UTF-8 bytes into fixed-size pieces so multibyte characters straddle chunk boundaries. */
function bytePieces(text, size) {
  const bytes = enc.encode(text);
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

function streamStep(text, size = 7) {
  return { headers: { 'content-type': 'text/event-stream; charset=utf-8' }, chunks: bytePieces(text, size) };
}

function toolDelta(calls) {
  return chunk({ tool_calls: calls });
}

function makeClient(steps, opts = {}) {
  const fetch = createFakeFetch(steps);
  const sleeps = [];
  let ids = 0;
  const llm = createLlmClient({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    genId: () => `call_gen_${++ids}`,
    ...opts,
  });
  return { llm, fetch, sleeps };
}

async function run(steps, opts = {}, chatArgs = {}) {
  const { llm, fetch, sleeps } = makeClient(steps, opts);
  const deltas = [];
  const res = await llm.chat({ messages: [{ role: 'user', content: '你好' }], tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs });
  return { res, deltas, fetch, sleeps };
}

async function runError(steps, opts = {}, chatArgs = {}) {
  const { llm, fetch, sleeps } = makeClient(steps, opts);
  const deltas = [];
  const err = await llm.chat({ messages: [{ role: 'user', content: '你好' }], tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs }).then(
    () => assert.fail('expected chat() to reject'),
    (e) => e,
  );
  return { err, deltas, fetch, sleeps };
}

const TOOLS = [{ type: 'function', function: { name: 'search_hotels', description: '搜索酒店', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

function calls(res) {
  return res.toolCalls.map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.arguments), ...(c.invalidArguments ? { invalid: true } : {}) }));
}

const okText = (text) => streamStep(sse(chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), 'data: [DONE]\n\n'));

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

describe('createSseParser', () => {
  test('handles data without space, CRLF, comments, event names and a final event without blank line', () => {
    const p = createSseParser();
    const events = [
      ...p.push(': keep-alive\r\n\r\ndata:{"a":1}\r\n\r\nevent: error\r\ndata: {"b"'),
      ...p.push(':2}\n\nid: 7\nretry: 100\ndata: x\ndata: y\n\ndata: [DONE]'),
      ...p.end(),
    ];
    assert.deepEqual(events, [
      { event: '', data: '{"a":1}' },
      { event: 'error', data: '{"b":2}' },
      { event: '', data: 'x\ny' },
      { event: '', data: '[DONE]' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stream quirks (RESEARCH-llm.md §3.3), table-driven
// ---------------------------------------------------------------------------

const QUIRKS = [
  {
    name: 'canonical: id/name on first chunk, args streamed, usage chunk with empty choices',
    body: sse(
      chunk({ role: 'assistant', content: '' }),
      toolDelta([{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, function: { arguments: '{"ci' } }]),
      toolDelta([{ index: 0, function: { arguments: 'ty":"杭州"}' } }]),
      chunk({}, 'tool_calls'),
      { id: 'cmpl-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_abc', name: 'search_hotels', args: { city: '杭州' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
  {
    name: 'Qwen: id (and name) repeated on every chunk are never concatenated',
    body: sse(
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { arguments: '{"city":' } }]),
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { name: 'search_hotels', arguments: '"上海"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_q1', name: 'search_hotels', args: { city: '上海' } }],
  },
  {
    name: 'Moonshot: missing index, two sequential calls, choice-level usage',
    body: sse(
      toolDelta([{ id: 'functions.search_hotels:0', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ function: { arguments: '{"city":"上海"}' } }]),
      toolDelta([{ id: 'functions.list_areas:1', type: 'function', function: { name: 'list_areas', arguments: '' } }]),
      toolDelta([{ function: { arguments: '{"city":' } }]),
      toolDelta([{ function: { arguments: '"上海"}' } }]),
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls', usage: { total_tokens: 42 } }] },
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'functions.search_hotels:0', name: 'search_hotels', args: { city: '上海' } },
      { id: 'functions.list_areas:1', name: 'list_areas', args: { city: '上海' } },
    ],
    usage: { total_tokens: 42 },
  },
  {
    name: 'GLM: index -1 with all arguments in a single chunk',
    body: sse(
      toolDelta([{ index: -1, id: 'call_g', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"成都","near":"春熙路"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_g', name: 'search_hotels', args: { city: '成都', near: '春熙路' } }],
  },
  {
    name: 'placeholder chunks and empty tool_calls arrays are ignored',
    body: sse(
      chunk({ reasoning_content: '想一想', tool_calls: [] }),
      toolDelta([{ index: 0 }]),
      toolDelta([{ index: 0, id: 'call_p', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, function: {} }]),
      toolDelta([{ index: 0, id: '', type: 'function', function: { name: '', arguments: '' } }]),
      toolDelta([{ index: 0, function: { arguments: '{"city":"西安"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_p', name: 'search_hotels', args: { city: '西安' } }],
    reasoning: '想一想',
  },
  {
    name: 'arguments arrive before the name (with index)',
    body: sse(
      toolDelta([{ index: 0, function: { arguments: '{"city":"南京"}' } }]),
      toolDelta([{ index: 0, id: 'call_late', type: 'function', function: { name: 'search_hotels' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_late', name: 'search_hotels', args: { city: '南京' } }],
  },
  {
    name: 'arguments arrive before the name (no index)',
    body: sse(
      toolDelta([{ function: { arguments: '{"city":' } }]),
      toolDelta([{ function: { arguments: '"苏州"}' } }]),
      toolDelta([{ id: 'call_late2', function: { name: 'search_hotels' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_late2', name: 'search_hotels', args: { city: '苏州' } }],
  },
  {
    name: 'reused index for a different id starts a new call',
    body: sse(
      toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"北京"}' } }]),
      toolDelta([{ index: 0, id: 'call_b', function: { name: 'list_areas', arguments: '{"city":"北京"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'call_a', name: 'search_hotels', args: { city: '北京' } },
      { id: 'call_b', name: 'list_areas', args: { city: '北京' } },
    ],
  },
  {
    name: 'parallel calls with interleaved indexes keep index order',
    body: sse(
      toolDelta([{ index: 1, id: 'call_2', function: { name: 'list_areas', arguments: '' } }]),
      toolDelta([{ index: 0, id: 'call_1', function: { name: 'search_hotels', arguments: '{"city":' } }]),
      toolDelta([{ index: 1, function: { arguments: '{"city":"厦门"}' } }]),
      toolDelta([{ index: 0, function: { arguments: '"厦门"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'call_1', name: 'search_hotels', args: { city: '厦门' } },
      { id: 'call_2', name: 'list_areas', args: { city: '厦门' } },
    ],
  },
  {
    name: 'missing id gets a generated one; empty arguments become {}',
    body: sse(toolDelta([{ index: 0, function: { name: 'list_orders', arguments: '' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_gen_1', name: 'list_orders', args: {} }],
  },
  {
    name: 'tool calls with finish_reason "stop" are still a tool turn',
    body: sse(toolDelta([{ index: 0, id: 'call_s', function: { name: 'search_hotels', arguments: '{"city":"三亚"}' } }]), chunk({}, 'stop'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_s', name: 'search_hotels', args: { city: '三亚' } }],
  },
  {
    name: 'EOF without [DONE] after a finish_reason is a normal end',
    body: sse(chunk({ content: '好的' }), chunk({ content: '，马上查。' }, 'stop')),
    content: '好的，马上查。',
    finishReason: 'stop',
  },
  {
    name: 'keep-alive comments, data: without space, CRLF line endings',
    body: ': keep-alive\r\n\r\n: keep-alive\r\n\r\n'
      + `data:${JSON.stringify(chunk({ content: '杭州' }))}\r\n\r\n: ping\r\n\r\n`
      + `data:${JSON.stringify(chunk({ content: '西湖' }, 'stop'))}\r\n\r\ndata:[DONE]\r\n\r\n`,
    content: '杭州西湖',
    finishReason: 'stop',
  },
  {
    name: 'multibyte characters split across 1-byte network chunks',
    body: sse(chunk({ content: '这周五去杭州西湖边住两晚' }), chunk({ content: '，预算¥600🙂' }, 'stop'), 'data: [DONE]\n\n'),
    size: 1,
    content: '这周五去杭州西湖边住两晚，预算¥600🙂',
  },
  {
    name: 'content as an array of parts, text alongside tool calls, finish in the same chunk as the last delta',
    body: sse(
      chunk({ content: [{ type: 'text', text: '我来' }, { type: 'text', text: '查一下' }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_t', function: { name: 'search_hotels', arguments: '{"city":"青岛"}' } }] }, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    content: '我来查一下',
    calls: [{ id: 'call_t', name: 'search_hotels', args: { city: '青岛' } }],
  },
  {
    name: 'fenced, double-encoded and duplicated arguments are repaired',
    body: sse(
      toolDelta([{ index: 0, id: 'c1', function: { name: 'search_hotels', arguments: '```json\n{"city":"长沙"}\n```' } }]),
      toolDelta([{ index: 1, id: 'c2', function: { name: 'list_areas', arguments: JSON.stringify(JSON.stringify({ city: '武汉' })) } }]),
      toolDelta([{ index: 2, id: 'c3', function: { name: 'list_areas', arguments: '{"city":"丽江"}{"city":"丽江"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'c1', name: 'search_hotels', args: { city: '长沙' } },
      { id: 'c2', name: 'list_areas', args: { city: '武汉' } },
      { id: 'c3', name: 'list_areas', args: { city: '丽江' } },
    ],
  },
  {
    name: 'legacy function_call delta is treated as a tool call',
    body: sse(chunk({ function_call: { name: 'list_orders', arguments: '{}' } }), chunk({}, 'function_call'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_gen_1', name: 'list_orders', args: {} }],
  },
  {
    name: 'several JSON chunks inside one event (non-compliant proxy)',
    body: `data: ${JSON.stringify(chunk({ content: '你' }))}\ndata: ${JSON.stringify(chunk({ content: '好' }, 'stop'))}\n\ndata: [DONE]\n\n`,
    content: '你好',
  },
];

describe('stream quirks', () => {
  for (const q of QUIRKS) {
    test(q.name, async () => {
      const { res, deltas, fetch } = await run([streamStep(q.body, q.size ?? 7)]);
      assert.equal(fetch.calls.length, 1, 'no retry or fallback needed');
      assert.deepEqual(calls(res), q.calls || []);
      assert.equal(res.content, q.content ?? '');
      assert.equal(deltas.join(''), q.content ?? '');
      assert.equal(res.finishReason, q.finishReason ?? (q.calls ? 'tool_calls' : 'stop'));
      if (q.usage) assert.deepEqual(res.usage, q.usage);
      if (q.reasoning) assert.equal(res.reasoningContent, q.reasoning);
    });
  }

  test('reasoning_content is collected separately and never streamed to the user', async () => {
    const body = sse(chunk({ reasoning_content: '用户想去' }), chunk({ reasoning_content: '杭州' }), chunk({ content: '好的' }, 'stop'), 'data: [DONE]\n\n');
    const { res, deltas } = await run([streamStep(body)]);
    assert.equal(res.reasoningContent, '用户想去杭州');
    assert.deepEqual(deltas, ['好的']);
  });

  test('Ark encrypted_content is returned for echoing', async () => {
    const body = sse(chunk({ encrypted_content: 'enc-abc' }), chunk({ content: '好' }, 'stop'), 'data: [DONE]\n\n');
    const { res } = await run([streamStep(body)]);
    assert.equal(res.encryptedContent, 'enc-abc');
  });

  test('non-SSE JSON body for a streaming request is parsed as a complete response', async () => {
    const json = {
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '我查一下', tool_calls: [{ id: 'call_j', type: 'function', function: { name: 'search_hotels', arguments: { city: '深圳' } } }] } }],
      usage: { total_tokens: 9 },
    };
    const { res, deltas } = await run([{ status: 200, body: `\n\n${JSON.stringify(json)}`, headers: { 'content-type': 'application/json' } }]);
    assert.deepEqual(calls(res), [{ id: 'call_j', name: 'search_hotels', args: { city: '深圳' } }]);
    assert.deepEqual(deltas, ['我查一下']);
    assert.deepEqual(res.usage, { total_tokens: 9 });
  });

  test('a JSON error body labelled text/event-stream is still classified', async () => {
    const { err, fetch } = await runError([streamStep(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key' } }))]);
    assert.equal(err.code, 'auth');
    assert.equal(fetch.calls.length, 1);
  });

  test('a large JSON completion labelled text/event-stream and split into pieces is still parsed', async () => {
    const json = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '好'.repeat(3000) } }] };
    const text = JSON.stringify(json);
    assert.ok(enc.encode(text).length > 8000);
    const { res, fetch } = await run([streamStep(text, 1024)]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(res.content, '好'.repeat(3000));
  });

  test('SSE body served with a wrong content-type is still parsed as SSE', async () => {
    const body = sse(chunk({ content: '你好' }, 'stop'), 'data: [DONE]\n\n');
    const { res } = await run([{ status: 200, body, headers: { 'content-type': 'text/plain' } }]);
    assert.equal(res.content, '你好');
  });

  test('invalid JSON arguments trigger one non-streaming retry', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":"杭' } }]), chunk({}, 'length'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"杭州"}' } }] } }] };
    const { res, fetch } = await run([streamStep(broken), { json: fixed }]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].json.stream, false);
    assert.equal(fetch.calls[1].json.stream_options, undefined);
    assert.equal(fetch.calls[1].headers.accept, 'application/json');
    assert.deepEqual(calls(res), [{ id: 'call_y', name: 'search_hotels', args: { city: '杭州' } }]);
  });

  test('arguments still invalid after the fallback come back flagged with "{}"', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const stillBroken = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_z', type: 'function', function: { name: 'search_hotels', arguments: '{city: 杭州' } }] } }] };
    const { res, fetch } = await run([streamStep(broken), { json: stillBroken }]);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(res.toolCalls, [{ id: 'call_z', name: 'search_hotels', arguments: '{}', invalidArguments: true }]);
  });

  test('finish_reason tool_calls without any call (GLM bug) triggers the non-streaming retry', async () => {
    const empty = sse(chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'stop', message: { content: '请问去哪个城市？' } }] };
    const { res, deltas, fetch } = await run([streamStep(empty), { json: fixed }]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, '请问去哪个城市？');
    assert.deepEqual(deltas, ['请问去哪个城市？']);
  });

  test('arguments cut off by finish_reason length get a fallback with a larger token limit', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":"杭' } }]), chunk({}, 'length'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"杭州"}' } }] } }] };
    const ds = await run([streamStep(broken), { json: fixed }]);
    assert.equal(ds.fetch.calls[0].json.max_tokens, undefined);
    assert.equal(ds.fetch.calls[1].json.max_tokens, 8192);
    const kimi = await run([streamStep(broken), { json: fixed }], { provider: 'kimi', model: 'kimi-k2.6' });
    assert.equal(kimi.fetch.calls[0].json.max_tokens, 8192);
    assert.equal(kimi.fetch.calls[1].json.max_tokens, 16384);
  });

  test('a failed fallback keeps the usable streamed calls (bad ones flagged)', async () => {
    const two = sse(
      toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"杭州"}' } }]),
      toolDelta([{ index: 1, id: 'call_b', function: { name: 'search_hotels', arguments: '{"city":"上' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    );
    const busy = { status: 429, json: { error: { message: 'Rate limit reached', type: 'rate_limit_reached_error' } } };
    const { res, fetch } = await run([streamStep(two), busy, busy, busy]);
    assert.equal(fetch.calls.length, 4);
    assert.deepEqual(res.toolCalls, [
      { id: 'call_a', name: 'search_hotels', arguments: '{"city":"杭州"}' },
      { id: 'call_b', name: 'search_hotels', arguments: '{}', invalidArguments: true },
    ]);
    const nothingUsable = await runError([streamStep(sse(chunk({}, 'tool_calls'), 'data: [DONE]\n\n')), busy, busy, busy]);
    assert.equal(nothingUsable.err.code, 'rate_limit');
  });

  test('no fallback once text was shown: invalid arguments are flagged instead', async () => {
    const body = sse(chunk({ content: '我来查' }), toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"ci' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const { res, fetch } = await run([streamStep(body)]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(res.content, '我来查');
    assert.deepEqual(res.toolCalls, [{ id: 'call_x', name: 'search_hotels', arguments: '{}', invalidArguments: true }]);
  });

  test('stream: false mode emits the whole text once', async () => {
    const { res, deltas, fetch } = await run([{ json: { choices: [{ index: 0, finish_reason: 'stop', message: { content: '你好呀' } }] } }], { stream: false });
    assert.equal(fetch.calls[0].json.stream, false);
    assert.equal(res.content, '你好呀');
    assert.deepEqual(deltas, ['你好呀']);
  });
});

// ---------------------------------------------------------------------------
// Errors in the stream
// ---------------------------------------------------------------------------

describe('in-stream errors', () => {
  test('data: {"error":...} before any text is retried, after text it is not', async () => {
    const errEvent = sse({ error: { message: 'Internal server error', type: 'server_error' } });
    const before = await run([streamStep(errEvent), okText('好的')]);
    assert.equal(before.fetch.calls.length, 2);
    assert.equal(before.res.content, '好的');

    const after = await runError([streamStep(sse(chunk({ content: '我来' })) + errEvent), okText('x')]);
    assert.equal(after.fetch.calls.length, 1);
    assert.equal(after.err.code, 'unavailable');
    assert.deepEqual(after.deltas, ['我来']);
  });

  test('event: error is classified like an error body', async () => {
    const body = `event: error\ndata: ${JSON.stringify({ error: { code: 'data_inspection_failed', message: 'Output data may contain inappropriate content.' } })}\n\n`;
    const { err, fetch } = await runError([streamStep(body)]);
    assert.equal(err.code, 'content_filter');
    assert.equal(fetch.calls.length, 1);
  });

  for (const finish of ['content_filter', 'sensitive']) {
    test(`finish_reason ${finish} → content_filter, not retried`, async () => {
      const { err, fetch } = await runError([streamStep(sse(chunk({ content: '部分' }), chunk({}, finish), 'data: [DONE]\n\n'))]);
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'content_filter');
      assert.equal(fetch.calls.length, 1);
    });
  }

  for (const finish of ['insufficient_system_resource', 'network_error']) {
    test(`finish_reason ${finish} before text is retried`, async () => {
      const { res, fetch, sleeps } = await run([streamStep(sse(chunk({}, finish), 'data: [DONE]\n\n')), okText('好')]);
      assert.equal(fetch.calls.length, 2);
      assert.deepEqual(sleeps, [500]);
      assert.equal(res.content, '好');
    });
  }

  test('stream cut before finish_reason and before any output is retried', async () => {
    const { res, fetch } = await run([streamStep(sse(toolDelta([{ index: 0, id: 'c', function: { name: 'search_hotels', arguments: '{"ci' } }]))), okText('好')]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, '好');
  });

  test('a stream that ends cleanly after text but without finish_reason is an interruption, not an answer', async () => {
    const { err, deltas, fetch } = await runError([streamStep(sse(chunk({ content: '推荐你住湖滨' }))), okText('x')]);
    assert.ok(err instanceof LlmError);
    assert.equal(err.code, 'network');
    assert.equal(fetch.calls.length, 1, 'no retry once text was shown');
    assert.equal(deltas.join(''), '推荐你住湖滨');
  });

  test('a clean end after one complete call of several is re-requested instead of running the call', async () => {
    const cut = sse(toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"杭州"}' } }]), toolDelta([{ index: 1, id: 'call_b', function: { name: 'search_hotels', arguments: '' } }]));
    const { res, fetch } = await run([streamStep(cut), okText('好')]);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.content, '好');
  });

  test('finish_reason model_context_window_exceeded → bad_request with context_length reason', async () => {
    const { err } = await runError([streamStep(sse(chunk({}, 'model_context_window_exceeded')))]);
    assert.equal(err.code, 'bad_request');
    assert.equal(err.reason, 'context_length');
    assert.match(err.userMessage, /新对话/);
  });
});

// ---------------------------------------------------------------------------
// HTTP errors, retries, backoff
// ---------------------------------------------------------------------------

describe('retries and backoff', () => {
  test('429 then success: retries with exponential backoff', async () => {
    const { res, fetch, sleeps } = await run([
      { status: 429, json: { error: { message: 'Rate limit reached', type: 'rate_limit_reached_error' } } },
      { status: 503, json: { error: { message: 'busy' } } },
      okText('好'),
    ]);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(res.content, '好');
  });

  test('jitter reduces the delay by up to 25%', () => {
    assert.equal(retryDelayMs(new LlmError('unavailable'), 0, () => 1), 375);
    assert.equal(retryDelayMs(new LlmError('unavailable'), 5, () => 0), 8000);
  });

  test('retry-after-ms / retry-after are honored and capped at 20 s', async () => {
    const a = await run([{ status: 429, json: {}, headers: { 'retry-after-ms': '1500' } }, okText('好')]);
    assert.deepEqual(a.sleeps, [1500]);
    const b = await run([{ status: 429, json: {}, headers: { 'retry-after': '30' } }, okText('好')]);
    assert.deepEqual(b.sleeps, [20000]);
    const c = await run([{ status: 429, json: {}, headers: { 'retry-after': '90' } }, okText('好')]);
    assert.deepEqual(c.sleeps, [500], 'more than 60 s falls back to backoff');
    assert.ok(Math.abs(parseRetryAfter({ 'retry-after': new Date(10000 + 5000).toUTCString() }, 10000) - 5000) < 1000);
  });

  test('gives up after maxRetries and throws the last error', async () => {
    const { err, fetch, sleeps } = await runError([{ status: 500, json: {} }, { status: 502, body: 'Bad Gateway' }, { status: 503, json: {} }, okText('x')]);
    assert.equal(fetch.calls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(err.code, 'unavailable');
    assert.equal(err.status, 503);
  });

  test('network errors are retried, then mapped to code network', async () => {
    const ok = await run([{ error: new TypeError('fetch failed') }, okText('好')]);
    assert.equal(ok.res.content, '好');
    const { err } = await runError([{ error: new TypeError('fetch failed') }], { maxRetries: 0 });
    assert.equal(err.code, 'network');
    assert.match(err.userMessage, CJK);
  });

  test('x-should-retry: false disables the retry', async () => {
    const { err, fetch } = await runError([{ status: 500, json: {}, headers: { 'x-should-retry': 'false' } }, okText('x')]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(err.code, 'unavailable');
  });

  test('idle timeout aborts a stalled stream and maps to timeout', async () => {
    const stalled = () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(': keep-alive\n\n'));
      },
      pull() {
        return new Promise(() => {});
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const { err, fetch } = await runError([stalled, stalled], { timeoutMs: 40, maxRetries: 1 });
    assert.equal(fetch.calls.length, 2, 'timeouts are retried');
    assert.equal(err.code, 'timeout');
  });

  test('a hanging request hits the total timeout', async () => {
    const { err } = await runError([{ delayMs: 5000 }], { timeoutMs: 1000, totalTimeoutMs: 40, maxRetries: 0 });
    assert.equal(err.code, 'timeout');
  });

  const keepAliveForever = () => {
    let timer;
    return new Response(new ReadableStream({
      start(c) {
        timer = setInterval(() => c.enqueue(enc.encode(': keep-alive\n\n')), 10);
      },
      cancel() {
        clearInterval(timer);
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  test('the total timeout is one deadline for the whole call, retries included', async () => {
    const started = Date.now();
    const { err, fetch } = await runError([keepAliveForever, keepAliveForever, keepAliveForever], { timeoutMs: 50, totalTimeoutMs: 200, maxRetries: 2 });
    const elapsed = Date.now() - started;
    assert.equal(err.code, 'timeout');
    assert.equal(err.retryable, false);
    assert.ok(elapsed < 350, `${elapsed} ms`);
    assert.equal(fetch.calls.length, 1, 'a deadline timeout is not retried');
  });

  test('an idle timeout is still retried while the deadline allows it', async () => {
    const stalled = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { 'content-type': 'text/event-stream' } });
    const { res, fetch } = await run([stalled, okText('好')], { timeoutMs: 50, totalTimeoutMs: 1000, maxRetries: 2 });
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, '好');
  });

  test('no retry when the backoff would run past the deadline', async () => {
    const { err, fetch } = await runError([{ status: 503, json: {}, headers: { 'retry-after': '5' } }, okText('x')], { totalTimeoutMs: 3000 });
    assert.equal(err.code, 'unavailable');
    assert.equal(fetch.calls.length, 1);
  });

  test('a user stop during keep-alives rejects with the abort, not a timeout', async () => {
    const ctrl = new AbortController();
    const { llm } = makeClient([keepAliveForever], { timeoutMs: 1000, totalTimeoutMs: 2000 });
    setTimeout(() => ctrl.abort(), 30);
    const err = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
    assert.ok(!(err instanceof LlmError));
  });

  test('caller abort rejects with the abort reason and is not retried', async () => {
    const ctrl = new AbortController();
    const { llm, fetch } = makeClient([{ chunks: [enc.encode(sse(chunk({ content: '好' })))], chunkDelayMs: 200, headers: { 'content-type': 'text/event-stream' } }, okText('x')]);
    setTimeout(() => ctrl.abort(), 20);
    const err = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
    assert.ok(!(err instanceof LlmError));
    assert.equal(fetch.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const ERROR_CASES = [
  ['DeepSeek 401', 401, { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } }, 'auth'],
  ['DashScope invalid key', 401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } }, 'auth'],
  ['GLM 1002 key', 401, { error: { code: '1002', message: 'Authorization Token非法' } }, 'auth'],
  ['Ark AuthenticationError', 401, { error: { code: 'AuthenticationError', message: 'the API key is invalid' } }, 'auth'],
  ['DeepSeek 402 balance', 402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } }, 'billing'],
  ['DashScope Arrearage', 400, { error: { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' } }, 'billing'],
  ['Kimi quota', 429, { error: { type: 'exceeded_current_quota_error', message: 'Your account is suspended' } }, 'billing'],
  ['GLM 1113 overdue', 429, { error: { code: '1113', message: '您的账户已欠费' } }, 'billing'],
  ['Ark AccountOverdueError', 403, { error: { code: 'AccountOverdueError', message: 'overdue balance' } }, 'billing'],
  ['DashScope content', 400, { error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.', type: 'data_inspection_failed' } }, 'content_filter'],
  ['Moonshot content_filter', 400, { error: { type: 'content_filter', message: 'The request was rejected because it was considered high risk' } }, 'content_filter'],
  ['GLM 1301', 400, { error: { code: '1301', message: '系统检测到输入或生成内容可能包含不安全或敏感内容' } }, 'content_filter'],
  ['Ark sensitive', 400, { error: { code: 'OutputTextSensitiveContentDetected', message: 'The request failed' } }, 'content_filter'],
  ['429 rate limit', 429, { error: { type: 'rate_limit_reached_error', message: 'Your account reached max request' } }, 'rate_limit'],
  ['GLM 1302 concurrency (flat body)', 429, { code: '1302', message: '您当前使用该API的并发数过高' }, 'rate_limit'],
  ['DashScope Throttling', 429, { error: { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' } }, 'rate_limit'],
  ['408', 408, { error: { message: 'Request Timeout' } }, 'timeout'],
  ['409', 409, { error: { message: 'conflict' } }, 'unavailable'],
  ['500 InternalError', 500, { error: { code: 'InternalError', message: 'oops' } }, 'unavailable'],
  ['503 overloaded', 503, 'Service Unavailable', 'unavailable'],
  ['400 invalid param', 400, { error: { message: 'Invalid value for temperature', type: 'invalid_request_error' } }, 'bad_request'],
  ['422', 422, { error: { message: 'Invalid parameters' } }, 'bad_request'],
  ['400 context', 400, { error: { message: 'This model\'s maximum context length is 131072 tokens' } }, 'bad_request', 'context_length'],
  ['DeepSeek max_completion=0', 400, { error: { message: 'max_completion=0 because the input is too long' } }, 'bad_request', 'context_length'],
  ['Ark 404 model', 404, { error: { code: 'InvalidEndpointOrModel.NotFound', message: 'The model or endpoint doubao-seed does not exist' } }, 'bad_request', 'model_not_found'],
  ['403 model access', 403, { error: { code: 'Model.AccessDenied', message: 'Model access denied.' } }, 'auth'],
  ['DeepSeek content risk', 400, { error: { message: 'Content Exists Risk', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }, 'content_filter'],
  ['DeepSeek content risk (detail body)', 400, { detail: 'Content Exists Risk' }, 'content_filter'],
];

describe('classifyProviderError', () => {
  for (const [name, status, body, code, reason] of ERROR_CASES) {
    test(`${name} → ${code}${reason ? `/${reason}` : ''}`, () => {
      const err = classifyProviderError(status, body);
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, code);
      if (reason) assert.equal(err.reason, reason);
      assert.equal(err.status, status);
      assert.match(err.userMessage, CJK);
      assert.equal(err.retryable, ['rate_limit', 'timeout', 'unavailable', 'network'].includes(code));
    });
  }

  test('billing, auth and content errors are never retried end to end', async () => {
    for (const [, status, body] of ERROR_CASES.filter(([, , , code]) => ['billing', 'auth', 'content_filter', 'bad_request'].includes(code))) {
      const { err, fetch } = await runError([{ status, json: typeof body === 'string' ? { message: body } : body }, okText('x')]);
      assert.equal(fetch.calls.length, 1, `${status} ${JSON.stringify(body)}`);
      assert.ok(err instanceof LlmError);
    }
  });

  test('every code has a Chinese user message', () => {
    for (const code of ['auth', 'billing', 'rate_limit', 'content_filter', 'bad_request', 'timeout', 'unavailable', 'network']) {
      assert.match(new LlmError(code).userMessage, CJK, code);
    }
  });

  test('the API key never appears in error messages', async () => {
    const { err } = await runError([{ status: 401, json: { error: { message: 'bad key' } } }], { apiKey: 'sk-secret-123' });
    assert.ok(!err.message.includes('sk-secret-123'));
    assert.ok(!err.userMessage.includes('sk-secret-123'));
  });
});

// ---------------------------------------------------------------------------
// Request adaptation per provider
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: 'system', content: '系统' },
  { role: 'user', content: '去杭州' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"杭州"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: { hotels: [] } },
  { role: 'assistant', content: '没找到', reasoning_content: '思考过' },
  { role: 'user', content: '再试试', at: '2026-10-25T00:00:00Z' },
];

function body(provider, { model = PROVIDERS[provider]?.model || 'gpt-x', stream = true, thinking = false, tools = TOOLS, temperature = 0.3, messages = HISTORY } = {}) {
  return buildRequestBody({ provider, model, messages, tools, temperature, thinking, stream });
}

describe('buildRequestBody', () => {
  test('DeepSeek: thinking disabled, usage requested, no tool_choice/user fields, history sanitized', () => {
    const b = body('deepseek');
    assert.deepEqual(b.thinking, { type: 'disabled' });
    assert.deepEqual(b.stream_options, { include_usage: true });
    assert.equal(b.temperature, 0.3);
    assert.equal(b.tool_choice, undefined);
    assert.equal(b.user, undefined);
    assert.equal(b.user_id, undefined);
    assert.equal(b.tools, TOOLS);
    assert.deepEqual(b.messages[2], { role: 'assistant', content: null, tool_calls: HISTORY[2].tool_calls });
    assert.deepEqual(b.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"hotels":[]}' });
    assert.deepEqual(b.messages[4], { role: 'assistant', content: '没找到', reasoning_content: '思考过' });
    assert.deepEqual(b.messages[5], { role: 'user', content: '再试试' });
  });

  test('DeepSeek thinking on: switch removed, every assistant message carries reasoning_content', () => {
    const b = body('deepseek', { thinking: true });
    assert.equal(b.thinking, undefined);
    assert.equal(b.messages[2].reasoning_content, ' ');
    assert.equal(b.messages[4].reasoning_content, '思考过');
    const noTools = body('deepseek', { thinking: true, tools: [] });
    assert.equal(noTools.tools, undefined);
    assert.equal(noTools.messages[2].reasoning_content, undefined, 'only required when tools are sent');
  });

  test('Qwen: enable_thinking false + parallel_tool_calls; non-streaming always disables thinking', () => {
    const b = body('qwen');
    assert.equal(b.enable_thinking, false);
    assert.equal(b.parallel_tool_calls, true);
    assert.equal(body('qwen', { tools: [] }).parallel_tool_calls, undefined);
    assert.equal(body('qwen', { thinking: true }).enable_thinking, true);
    assert.equal(body('qwen', { thinking: true, stream: false }).enable_thinking, false);
    assert.equal(b.messages[2].reasoning_content, undefined);
  });

  test('Kimi: no temperature, max_tokens 8192 (16000 with thinking); thinking on echoes reasoning on tool-call messages', () => {
    const b = body('kimi');
    assert.equal(b.temperature, undefined);
    assert.equal(b.max_tokens, 8192);
    assert.deepEqual(b.thinking, { type: 'disabled' });
    const t = body('kimi', { thinking: true });
    assert.equal(t.max_tokens, 16000);
    assert.equal(t.thinking, undefined);
    assert.equal(t.messages[2].reasoning_content, ' ');
    assert.equal(t.messages[4].reasoning_content, '思考过');
  });

  test('GLM: never tool_choice/parallel_tool_calls, tool_stream only when streaming, temperature clamped', () => {
    const b = buildRequestBody({ provider: 'glm', model: 'glm-4.7-flash', messages: HISTORY, tools: TOOLS, temperature: 0, stream: true, extraBody: { tool_choice: 'auto', parallel_tool_calls: true } });
    assert.equal(b.tool_choice, undefined);
    assert.equal(b.parallel_tool_calls, undefined);
    assert.equal(b.tool_stream, true);
    assert.equal(b.temperature, 0.01);
    assert.equal(b.stream_options, undefined);
    assert.equal(body('glm', { stream: false }).tool_stream, undefined);
    assert.equal(body('glm', { tools: [] }).tool_stream, undefined);
    assert.equal(body('glm', { model: 'glm-4.5' }).tool_stream, undefined);
    assert.equal(body('glm', { model: 'glm-5.3-flash' }).thinking, undefined, 'GLM-5.3+ cannot disable thinking');
    assert.deepEqual(body('glm').thinking, { type: 'disabled' });
  });

  test('Doubao: thinking disabled and encrypted_content echoed', () => {
    const msgs = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '好', encrypted_content: 'enc' }];
    const b = body('doubao', { messages: msgs });
    assert.deepEqual(b.thinking, { type: 'disabled' });
    assert.equal(b.messages[1].encrypted_content, 'enc');
    assert.equal(body('deepseek', { messages: msgs }).messages[1].encrypted_content, undefined);
  });

  test('client sends POST {baseUrl}/chat/completions with bearer auth', async () => {
    const { fetch } = await run([okText('好')], { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', provider: undefined, model: 'glm-4.7-flash' });
    const req = fetch.calls[0];
    assert.equal(req.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    assert.equal(req.headers.accept, 'text/event-stream');
    assert.equal(req.json.tool_stream, true, 'provider inferred from the base URL');
    assert.equal(req.json.model, 'glm-4.7-flash');
  });
});

describe('parseToolArguments', () => {
  test('lenient parsing', () => {
    assert.deepEqual(parseToolArguments(''), {});
    assert.deepEqual(parseToolArguments('  null '), {});
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
    assert.equal(parseToolArguments('[1,2]'), undefined);
    assert.equal(parseToolArguments('{"a":'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

describe('providers', () => {
  test('defaults to DeepSeek with the addendum values', () => {
    const c = resolveLlmConfig({ DEEPSEEK_API_KEY: 'sk-1' });
    assert.equal(c.provider, 'deepseek');
    assert.equal(c.baseUrl, 'https://api.deepseek.com');
    assert.equal(c.model, 'deepseek-v4-flash');
    assert.equal(c.apiKey, 'sk-1');
    assert.equal(c.configured, true);
    assert.equal(c.temperature, 0.3);
    assert.equal(c.thinking, false);
    assert.equal(resolveLlmConfig({}).configured, false);
  });

  test('preset values per provider', () => {
    assert.equal(PROVIDERS.qwen.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.equal(PROVIDERS.qwen.model, 'qwen-flash');
    assert.equal(PROVIDERS.kimi.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(PROVIDERS.kimi.model, 'kimi-k2.6');
    assert.equal(PROVIDERS.glm.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(PROVIDERS.glm.model, 'glm-4.7-flash');
    assert.equal(PROVIDERS.doubao.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
    assert.match(PROVIDERS.doubao.model, /^doubao-seed-2-1-lite-\d{6}$/);
    for (const p of Object.values(PROVIDERS)) assert.ok(p.label && p.keyEnv);
  });

  test('generic overrides, aliases, alt key env and thinking switch', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'Moonshot', MOONSHOT_API_KEY: 'k', LLM_MODEL: 'kimi-k3', LLM_BASE_URL: 'https://proxy.example.com/v1/', LLM_TEMPERATURE: '0.6', LLM_THINKING: 'on' });
    assert.equal(c.provider, 'kimi');
    assert.equal(c.model, 'kimi-k3');
    assert.equal(c.baseUrl, 'https://proxy.example.com/v1');
    assert.equal(c.temperature, 0.6);
    assert.equal(c.thinking, true);
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'glm', ZAI_API_KEY: 'z' }).apiKey, 'z');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'glm', ZHIPUAI_API_KEY: 'a', ZAI_API_KEY: 'z' }).apiKey, 'a');
    assert.equal(resolveLlmConfig({ LLM_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' }).apiKey, 'g');
    assert.equal(resolveLlmConfig({ LLM_TEMPERATURE: 'hot' }).temperature, 0.3);
    const bad = resolveLlmConfig({ LLM_PROVIDER: 'openai' });
    assert.equal(bad.provider, 'deepseek');
    assert.equal(bad.warnings.length, 1);
    assert.equal(normalizeProvider('ARK'), 'doubao');
    assert.equal(inferProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen');
    assert.equal(inferProvider('not a url'), null);
  });

  test('LLM_BASE_URL decides the provider when LLM_PROVIDER is empty, and a mismatch is warned about', () => {
    const c = resolveLlmConfig({ LLM_BASE_URL: 'https://api.moonshot.cn/v1', MOONSHOT_API_KEY: 'k' });
    assert.equal(c.provider, 'kimi');
    assert.equal(c.model, 'kimi-k2.6');
    assert.equal(c.apiKey, 'k');
    assert.deepEqual(c.warnings, []);
    const gateway = resolveLlmConfig({ LLM_BASE_URL: 'https://gw.example.com/v1' });
    assert.equal(gateway.provider, 'deepseek');
    assert.deepEqual(gateway.warnings, []);
    const mismatch = resolveLlmConfig({ LLM_PROVIDER: 'deepseek', LLM_BASE_URL: 'https://api.moonshot.cn/v1' });
    assert.equal(mismatch.provider, 'deepseek');
    assert.equal(mismatch.warnings.length, 1);
    assert.match(mismatch.warnings[0], /Kimi/);
  });

  test('resolveLlmConfig output can be spread into createLlmClient', async () => {
    const fetch = createFakeFetch([okText('好')]);
    const llm = createLlmClient({ ...resolveLlmConfig({ LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'k' }), fetch });
    assert.equal(llm.provider, 'qwen');
    const res = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    assert.equal(res.content, '好');
    assert.equal(fetch.calls[0].json.enable_thinking, false);
    assert.equal(fetch.calls[0].json.parallel_tool_calls, true);
  });
});
