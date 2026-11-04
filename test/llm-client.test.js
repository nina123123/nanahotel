import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmClient, createSseParser, classifyProviderError, buildRequestBody, parseToolArguments, retryDelayMs, parseRetryAfter, LlmError,
  LLM_ERROR_MESSAGES, REASON_MESSAGES,
} from '../src/llm/client.js';
import { PROVIDERS, resolveLlmConfig, inferProvider, normalizeProvider, DEFAULT_PROVIDER } from '../src/llm/providers.js';
import { createFakeFetch } from './fakes/fake-fetch.js';
import { textAnswer, sseStep } from './fakes/anthropic-sse.js';

// The engine (retries, timeouts, aborts, fallback) is shared by both providers; it is exercised here through the
// OpenAI Chat Completions adapter. Anthropic specifics: test/live-anthropic.test.js.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const CJK = /[　-鿿＀-￯]/;

function chunk(delta, finish = null, extra = {}) {
  return { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
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
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-openai-key',
    model: 'gpt-4.1-mini',
    provider: 'openai',
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
  const res = await llm.chat({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs });
  return { res, deltas, fetch, sleeps };
}

async function runError(steps, opts = {}, chatArgs = {}) {
  const { llm, fetch, sleeps } = makeClient(steps, opts);
  const deltas = [];
  const err = await llm.chat({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs }).then(
    () => assert.fail('expected chat() to reject'),
    (e) => e,
  );
  return { err, deltas, fetch, sleeps };
}

const TOOLS = [{ type: 'function', function: { name: 'search_hotels', description: 'Search hotels', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

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
// Stream quirks of OpenAI-compatible endpoints, table-driven
// ---------------------------------------------------------------------------

const QUIRKS = [
  {
    name: 'canonical: id/name on first chunk, args streamed, usage chunk with empty choices',
    body: sse(
      chunk({ role: 'assistant', content: '' }),
      toolDelta([{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, function: { arguments: '{"ci' } }]),
      toolDelta([{ index: 0, function: { arguments: 'ty":"New York"}' } }]),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_abc', name: 'search_hotels', args: { city: 'New York' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
  {
    name: 'id (and name) repeated on every chunk are never concatenated',
    body: sse(
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { arguments: '{"city":' } }]),
      toolDelta([{ index: 0, id: 'call_q1', type: 'function', function: { name: 'search_hotels', arguments: '"Boston"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_q1', name: 'search_hotels', args: { city: 'Boston' } }],
  },
  {
    name: 'missing index, two sequential calls, choice-level usage',
    body: sse(
      toolDelta([{ id: 'call_s1', type: 'function', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ function: { arguments: '{"city":"Chicago"}' } }]),
      toolDelta([{ id: 'call_s2', type: 'function', function: { name: 'list_areas', arguments: '' } }]),
      toolDelta([{ function: { arguments: '{"city":' } }]),
      toolDelta([{ function: { arguments: '"Chicago"}' } }]),
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls', usage: { total_tokens: 42 } }] },
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'call_s1', name: 'search_hotels', args: { city: 'Chicago' } },
      { id: 'call_s2', name: 'list_areas', args: { city: 'Chicago' } },
    ],
    usage: { total_tokens: 42 },
  },
  {
    name: 'index -1 with all arguments in a single chunk',
    body: sse(
      toolDelta([{ index: -1, id: 'call_g', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"Denver","near":"LoDo"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_g', name: 'search_hotels', args: { city: 'Denver', near: 'LoDo' } }],
  },
  {
    name: 'placeholder chunks and empty tool_calls arrays are ignored',
    body: sse(
      chunk({ reasoning_content: 'thinking it over', tool_calls: [] }),
      toolDelta([{ index: 0 }]),
      toolDelta([{ index: 0, id: 'call_p', function: { name: 'search_hotels', arguments: '' } }]),
      toolDelta([{ index: 0, function: {} }]),
      toolDelta([{ index: 0, id: '', type: 'function', function: { name: '', arguments: '' } }]),
      toolDelta([{ index: 0, function: { arguments: '{"city":"Austin"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_p', name: 'search_hotels', args: { city: 'Austin' } }],
    reasoning: 'thinking it over',
  },
  {
    name: 'arguments arrive before the name (with index)',
    body: sse(
      toolDelta([{ index: 0, function: { arguments: '{"city":"Seattle"}' } }]),
      toolDelta([{ index: 0, id: 'call_late', type: 'function', function: { name: 'search_hotels' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_late', name: 'search_hotels', args: { city: 'Seattle' } }],
  },
  {
    name: 'arguments arrive before the name (no index)',
    body: sse(
      toolDelta([{ function: { arguments: '{"city":' } }]),
      toolDelta([{ function: { arguments: '"Miami"}' } }]),
      toolDelta([{ id: 'call_late2', function: { name: 'search_hotels' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [{ id: 'call_late2', name: 'search_hotels', args: { city: 'Miami' } }],
  },
  {
    name: 'reused index for a different id starts a new call',
    body: sse(
      toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"Orlando"}' } }]),
      toolDelta([{ index: 0, id: 'call_b', function: { name: 'list_areas', arguments: '{"city":"Orlando"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'call_a', name: 'search_hotels', args: { city: 'Orlando' } },
      { id: 'call_b', name: 'list_areas', args: { city: 'Orlando' } },
    ],
  },
  {
    name: 'parallel calls with interleaved indexes keep index order',
    body: sse(
      toolDelta([{ index: 1, id: 'call_2', function: { name: 'list_areas', arguments: '' } }]),
      toolDelta([{ index: 0, id: 'call_1', function: { name: 'search_hotels', arguments: '{"city":' } }]),
      toolDelta([{ index: 1, function: { arguments: '{"city":"Nashville"}' } }]),
      toolDelta([{ index: 0, function: { arguments: '"Nashville"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'call_1', name: 'search_hotels', args: { city: 'Nashville' } },
      { id: 'call_2', name: 'list_areas', args: { city: 'Nashville' } },
    ],
  },
  {
    name: 'missing id gets a generated one; empty arguments become {}',
    body: sse(toolDelta([{ index: 0, function: { name: 'list_orders', arguments: '' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_gen_1', name: 'list_orders', args: {} }],
  },
  {
    name: 'tool calls with finish_reason "stop" are still a tool turn',
    body: sse(toolDelta([{ index: 0, id: 'call_s', function: { name: 'search_hotels', arguments: '{"city":"Honolulu"}' } }]), chunk({}, 'stop'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_s', name: 'search_hotels', args: { city: 'Honolulu' } }],
  },
  {
    name: 'EOF without [DONE] after a finish_reason is a normal end',
    body: sse(chunk({ content: 'On it,' }), chunk({ content: ' checking now.' }, 'stop')),
    content: 'On it, checking now.',
    finishReason: 'stop',
  },
  {
    name: 'keep-alive comments, data: without space, CRLF line endings',
    body: ': keep-alive\r\n\r\n: keep-alive\r\n\r\n'
      + `data:${JSON.stringify(chunk({ content: 'Times ' }))}\r\n\r\n: ping\r\n\r\n`
      + `data:${JSON.stringify(chunk({ content: 'Square' }, 'stop'))}\r\n\r\ndata:[DONE]\r\n\r\n`,
    content: 'Times Square',
    finishReason: 'stop',
  },
  {
    name: 'multibyte characters split across 1-byte network chunks',
    body: sse(chunk({ content: 'Two nights at the Café Rouge — ' }), chunk({ content: 'under $300 🙂' }, 'stop'), 'data: [DONE]\n\n'),
    size: 1,
    content: 'Two nights at the Café Rouge — under $300 🙂',
  },
  {
    name: 'content as an array of parts, text alongside tool calls, finish in the same chunk as the last delta',
    body: sse(
      chunk({ content: [{ type: 'text', text: 'Let me ' }, { type: 'text', text: 'check' }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_t', function: { name: 'search_hotels', arguments: '{"city":"San Diego"}' } }] }, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    content: 'Let me check',
    calls: [{ id: 'call_t', name: 'search_hotels', args: { city: 'San Diego' } }],
  },
  {
    name: 'fenced, double-encoded and duplicated arguments are repaired',
    body: sse(
      toolDelta([{ index: 0, id: 'c1', function: { name: 'search_hotels', arguments: '```json\n{"city":"Las Vegas"}\n```' } }]),
      toolDelta([{ index: 1, id: 'c2', function: { name: 'list_areas', arguments: JSON.stringify(JSON.stringify({ city: 'Boston' })) } }]),
      toolDelta([{ index: 2, id: 'c3', function: { name: 'list_areas', arguments: '{"city":"Austin"}{"city":"Austin"}' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
    calls: [
      { id: 'c1', name: 'search_hotels', args: { city: 'Las Vegas' } },
      { id: 'c2', name: 'list_areas', args: { city: 'Boston' } },
      { id: 'c3', name: 'list_areas', args: { city: 'Austin' } },
    ],
  },
  {
    name: 'legacy function_call delta is treated as a tool call',
    body: sse(chunk({ function_call: { name: 'list_orders', arguments: '{}' } }), chunk({}, 'function_call'), 'data: [DONE]\n\n'),
    calls: [{ id: 'call_gen_1', name: 'list_orders', args: {} }],
  },
  {
    name: 'several JSON chunks inside one event (non-compliant proxy)',
    body: `data: ${JSON.stringify(chunk({ content: 'He' }))}\ndata: ${JSON.stringify(chunk({ content: 'llo' }, 'stop'))}\n\ndata: [DONE]\n\n`,
    content: 'Hello',
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
    const body = sse(chunk({ reasoning_content: 'They want ' }), chunk({ reasoning_content: 'New York' }), chunk({ content: 'Sure' }, 'stop'), 'data: [DONE]\n\n');
    const { res, deltas } = await run([streamStep(body)]);
    assert.equal(res.reasoningContent, 'They want New York');
    assert.deepEqual(deltas, ['Sure']);
    assert.equal(res.encryptedContent, undefined);
  });

  test('non-SSE JSON body for a streaming request is parsed as a complete response', async () => {
    const json = {
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'call_j', type: 'function', function: { name: 'search_hotels', arguments: { city: 'Miami' } } }] } }],
      usage: { total_tokens: 9 },
    };
    const { res, deltas } = await run([{ status: 200, body: `\n\n${JSON.stringify(json)}`, headers: { 'content-type': 'application/json' } }]);
    assert.deepEqual(calls(res), [{ id: 'call_j', name: 'search_hotels', args: { city: 'Miami' } }]);
    assert.deepEqual(deltas, ['Checking']);
    assert.deepEqual(res.usage, { total_tokens: 9 });
  });

  test('a JSON error body labelled text/event-stream is still classified', async () => {
    const { err, fetch } = await runError([streamStep(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }))]);
    assert.equal(err.code, 'auth');
    assert.equal(fetch.calls.length, 1);
  });

  test('a large JSON completion labelled text/event-stream and split into pieces is still parsed', async () => {
    const json = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok '.repeat(3000) } }] };
    const text = JSON.stringify(json);
    assert.ok(enc.encode(text).length > 8000);
    const { res, fetch } = await run([streamStep(text, 1024)]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(res.content, 'ok '.repeat(3000));
  });

  test('SSE body served with a wrong content-type is still parsed as SSE', async () => {
    const body = sse(chunk({ content: 'Hello' }, 'stop'), 'data: [DONE]\n\n');
    const { res } = await run([{ status: 200, body, headers: { 'content-type': 'text/plain' } }]);
    assert.equal(res.content, 'Hello');
  });

  test('invalid JSON arguments trigger one non-streaming retry', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":"New' } }]), chunk({}, 'length'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"New York"}' } }] } }] };
    const { res, fetch } = await run([streamStep(broken), { json: fixed }]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].json.stream, false);
    assert.equal(fetch.calls[1].json.stream_options, undefined);
    assert.equal(fetch.calls[1].headers.accept, 'application/json');
    assert.deepEqual(calls(res), [{ id: 'call_y', name: 'search_hotels', args: { city: 'New York' } }]);
  });

  test('arguments still invalid after the fallback come back flagged with "{}"', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const stillBroken = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_z', type: 'function', function: { name: 'search_hotels', arguments: '{city: Boston' } }] } }] };
    const { res, fetch } = await run([streamStep(broken), { json: stillBroken }]);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(res.toolCalls, [{ id: 'call_z', name: 'search_hotels', arguments: '{}', invalidArguments: true }]);
  });

  test('finish_reason tool_calls without any call triggers the non-streaming retry', async () => {
    const empty = sse(chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'stop', message: { content: 'Which city are you heading to?' } }] };
    const { res, deltas, fetch } = await run([streamStep(empty), { json: fixed }]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, 'Which city are you heading to?');
    assert.deepEqual(deltas, ['Which city are you heading to?']);
  });

  test('arguments cut off by finish_reason length get a fallback with a larger token limit', async () => {
    const broken = sse(toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"city":"New' } }]), chunk({}, 'length'), 'data: [DONE]\n\n');
    const fixed = { choices: [{ index: 0, finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"New York"}' } }] } }] };
    const plain = await run([streamStep(broken), { json: fixed }]);
    assert.equal(plain.fetch.calls[0].json.max_completion_tokens, undefined);
    assert.equal(plain.fetch.calls[1].json.max_completion_tokens, 8192);
    const capped = await run([streamStep(broken), { json: fixed }], { maxTokens: 6000 });
    assert.equal(capped.fetch.calls[0].json.max_completion_tokens, 6000);
    assert.equal(capped.fetch.calls[1].json.max_completion_tokens, 12000);
  });

  test('a failed fallback keeps the usable streamed calls (bad ones flagged)', async () => {
    const two = sse(
      toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"Boston"}' } }]),
      toolDelta([{ index: 1, id: 'call_b', function: { name: 'search_hotels', arguments: '{"city":"Bo' } }]),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    );
    const busy = { status: 429, json: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } } };
    const { res, fetch } = await run([streamStep(two), busy, busy, busy]);
    assert.equal(fetch.calls.length, 4);
    assert.deepEqual(res.toolCalls, [
      { id: 'call_a', name: 'search_hotels', arguments: '{"city":"Boston"}' },
      { id: 'call_b', name: 'search_hotels', arguments: '{}', invalidArguments: true },
    ]);
    const nothingUsable = await runError([streamStep(sse(chunk({}, 'tool_calls'), 'data: [DONE]\n\n')), busy, busy, busy]);
    assert.equal(nothingUsable.err.code, 'rate_limit');
  });

  test('no fallback once text was shown: invalid arguments are flagged instead', async () => {
    const body = sse(chunk({ content: 'Let me look' }), toolDelta([{ index: 0, id: 'call_x', function: { name: 'search_hotels', arguments: '{"ci' } }]), chunk({}, 'tool_calls'), 'data: [DONE]\n\n');
    const { res, fetch } = await run([streamStep(body)]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(res.content, 'Let me look');
    assert.deepEqual(res.toolCalls, [{ id: 'call_x', name: 'search_hotels', arguments: '{}', invalidArguments: true }]);
  });

  test('stream: false mode emits the whole text once', async () => {
    const { res, deltas, fetch } = await run([{ json: { choices: [{ index: 0, finish_reason: 'stop', message: { content: 'Hi there' } }] } }], { stream: false });
    assert.equal(fetch.calls[0].json.stream, false);
    assert.equal(res.content, 'Hi there');
    assert.deepEqual(deltas, ['Hi there']);
  });
});

// ---------------------------------------------------------------------------
// Errors in the stream
// ---------------------------------------------------------------------------

describe('in-stream errors', () => {
  test('data: {"error":...} before any text is retried, after text it is not', async () => {
    const errEvent = sse({ error: { message: 'The server had an error while processing your request.', type: 'server_error' } });
    const before = await run([streamStep(errEvent), okText('Sure')]);
    assert.equal(before.fetch.calls.length, 2);
    assert.equal(before.res.content, 'Sure');

    const after = await runError([streamStep(sse(chunk({ content: 'I can' })) + errEvent), okText('x')]);
    assert.equal(after.fetch.calls.length, 1);
    assert.equal(after.err.code, 'unavailable');
    assert.deepEqual(after.deltas, ['I can']);
  });

  test('event: error is classified like an error body', async () => {
    const body = `event: error\ndata: ${JSON.stringify({ error: { code: 'content_policy_violation', message: 'Your request was rejected as a result of our safety system.' } })}\n\n`;
    const { err, fetch } = await runError([streamStep(body)]);
    assert.equal(err.code, 'content_filter');
    assert.equal(fetch.calls.length, 1);
  });

  test('finish_reason content_filter → content_filter, not retried', async () => {
    const { err, fetch } = await runError([streamStep(sse(chunk({ content: 'Partial' }), chunk({}, 'content_filter'), 'data: [DONE]\n\n'))]);
    assert.ok(err instanceof LlmError);
    assert.equal(err.code, 'content_filter');
    assert.equal(fetch.calls.length, 1);
  });

  test('stream cut before finish_reason and before any output is retried', async () => {
    const { res, fetch } = await run([streamStep(sse(toolDelta([{ index: 0, id: 'c', function: { name: 'search_hotels', arguments: '{"ci' } }]))), okText('Sure')]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, 'Sure');
  });

  test('a stream that ends cleanly after text but without finish_reason is an interruption, not an answer', async () => {
    const { err, deltas, fetch } = await runError([streamStep(sse(chunk({ content: 'I recommend the Loop' }))), okText('x')]);
    assert.ok(err instanceof LlmError);
    assert.equal(err.code, 'network');
    assert.equal(fetch.calls.length, 1, 'no retry once text was shown');
    assert.equal(deltas.join(''), 'I recommend the Loop');
  });

  test('a clean end after one complete call of several is re-requested instead of running the call', async () => {
    const cut = sse(toolDelta([{ index: 0, id: 'call_a', function: { name: 'search_hotels', arguments: '{"city":"Boston"}' } }]), toolDelta([{ index: 1, id: 'call_b', function: { name: 'search_hotels', arguments: '' } }]));
    const { res, fetch } = await run([streamStep(cut), okText('Sure')]);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.content, 'Sure');
  });
});

// ---------------------------------------------------------------------------
// HTTP errors, retries, backoff, timeouts, aborts (engine behaviour)
// ---------------------------------------------------------------------------

describe('retries and backoff', () => {
  test('429 then success: retries with exponential backoff', async () => {
    const { res, fetch, sleeps } = await run([
      { status: 429, json: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } },
      { status: 503, json: { error: { message: 'busy' } } },
      okText('Sure'),
    ]);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(res.content, 'Sure');
  });

  test('jitter reduces the delay by up to 25%', () => {
    assert.equal(retryDelayMs(new LlmError('unavailable'), 0, () => 1), 375);
    assert.equal(retryDelayMs(new LlmError('unavailable'), 5, () => 0), 8000);
  });

  test('retry-after-ms / retry-after are honored and capped at 20 s', async () => {
    const a = await run([{ status: 429, json: {}, headers: { 'retry-after-ms': '1500' } }, okText('Sure')]);
    assert.deepEqual(a.sleeps, [1500]);
    const b = await run([{ status: 429, json: {}, headers: { 'retry-after': '30' } }, okText('Sure')]);
    assert.deepEqual(b.sleeps, [20000]);
    const c = await run([{ status: 429, json: {}, headers: { 'retry-after': '90' } }, okText('Sure')]);
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

  test('network errors are retried, then mapped to code network with an English message', async () => {
    const ok = await run([{ error: new TypeError('fetch failed') }, okText('Sure')]);
    assert.equal(ok.res.content, 'Sure');
    const { err } = await runError([{ error: new TypeError('fetch failed') }], { maxRetries: 0 });
    assert.equal(err.code, 'network');
    assert.equal(err.userMessage, LLM_ERROR_MESSAGES.network);
    assert.doesNotMatch(err.userMessage, CJK);
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
    const { res, fetch } = await run([stalled, okText('Sure')], { timeoutMs: 50, totalTimeoutMs: 1000, maxRetries: 2 });
    assert.equal(fetch.calls.length, 2);
    assert.equal(res.content, 'Sure');
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
    const { llm, fetch } = makeClient([{ chunks: [enc.encode(sse(chunk({ content: 'Sure' })))], chunkDelayMs: 200, headers: { 'content-type': 'text/event-stream' } }, okText('x')]);
    setTimeout(() => ctrl.abort(), 20);
    const err = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
    assert.ok(!(err instanceof LlmError));
    assert.equal(fetch.calls.length, 1);
  });

  test('an already-aborted signal rejects before any request', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { llm, fetch } = makeClient([okText('x')]);
    const err = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
    assert.equal(fetch.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Error classification (OpenAI-style bodies)
// ---------------------------------------------------------------------------

const ERROR_CASES = [
  ['OpenAI 401 invalid key', 401, { error: { message: 'Incorrect API key provided: sk-abc***xyz.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth'],
  ['403 unsupported region', 403, { error: { message: 'Country, region, or territory not supported', type: 'request_forbidden', code: 'unsupported_country_region_territory' } }, 'auth'],
  ['429 insufficient_quota is billing', 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 'billing'],
  ['402 payment required', 402, { error: { message: 'Payment required' } }, 'billing'],
  ['429 rate limit', 429, { error: { message: 'Rate limit reached for gpt-5-mini on tokens per min (TPM)', type: 'tokens', code: 'rate_limit_exceeded' } }, 'rate_limit'],
  ['400 content policy', 400, { error: { message: 'Your request was rejected as a result of our safety system.', type: 'invalid_request_error', code: 'content_policy_violation' } }, 'content_filter'],
  ['gateway content risk (detail body)', 400, { detail: 'Content Exists Risk' }, 'content_filter'],
  ['408', 408, { error: { message: 'Request Timeout' } }, 'timeout'],
  ['409', 409, { error: { message: 'conflict' } }, 'unavailable'],
  ['500 server_error', 500, { error: { message: 'The server had an error while processing your request.', type: 'server_error' } }, 'unavailable'],
  ['503 overloaded', 503, 'Service Unavailable', 'unavailable'],
  ['400 invalid param', 400, { error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' } }, 'bad_request'],
  ['422', 422, { error: { message: 'Invalid parameters' } }, 'bad_request'],
  ['400 context length', 400, { error: { message: "This model's maximum context length is 128000 tokens.", type: 'invalid_request_error', code: 'context_length_exceeded' } }, 'bad_request', 'context_length'],
  ['404 model', 404, { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } }, 'bad_request', 'model_not_found'],
  ['gateway 400 "Model Not Exist"', 400, { error: { message: 'Model Not Exist', type: 'invalid_request_error' } }, 'bad_request', 'model_not_found'],
];

describe('classifyProviderError', () => {
  for (const [name, status, body, code, reason] of ERROR_CASES) {
    test(`${name} → ${code}${reason ? `/${reason}` : ''}`, () => {
      const err = classifyProviderError(status, body);
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, code);
      if (reason) assert.equal(err.reason, reason);
      assert.equal(err.status, status);
      assert.doesNotMatch(err.userMessage, CJK);
      assert.equal(err.retryable, ['rate_limit', 'timeout', 'unavailable', 'network'].includes(code));
    });
  }

  test('billing, auth, content and bad requests are never retried end to end', async () => {
    for (const [, status, body] of ERROR_CASES.filter(([, , , code]) => ['billing', 'auth', 'content_filter', 'bad_request'].includes(code))) {
      const { err, fetch } = await runError([{ status, json: typeof body === 'string' ? { message: body } : body }, okText('x')]);
      assert.equal(fetch.calls.length, 1, `${status} ${JSON.stringify(body)}`);
      assert.ok(err instanceof LlmError);
    }
  });

  test('every code and reason has a short English user message (no CJK, no tildes, at most one emoji)', () => {
    const emoji = /\p{Extended_Pictographic}/gu;
    for (const code of ['auth', 'billing', 'rate_limit', 'content_filter', 'bad_request', 'timeout', 'unavailable', 'network']) {
      const msg = new LlmError(code).userMessage;
      assert.equal(msg, LLM_ERROR_MESSAGES[code]);
      assert.doesNotMatch(msg, CJK, code);
      assert.doesNotMatch(msg, /[~～]/, code);
      assert.ok((msg.match(emoji) || []).length <= 1, code);
    }
    assert.equal(new LlmError('bad_request', { reason: 'context_length' }).userMessage, REASON_MESSAGES.context_length);
    assert.match(REASON_MESSAGES.context_length, /New chat/);
    assert.match(REASON_MESSAGES.model_not_found, /ANTHROPIC_MODEL/);
  });

  test('the API key never appears in error messages, even when the provider echoes it', async () => {
    const key = 'sk-secret-123456789';
    const { err } = await runError([{ status: 401, json: { error: { message: `Incorrect API key provided: ${key}` } } }], { apiKey: key });
    assert.ok(!err.message.includes(key));
    assert.ok(!err.userMessage.includes(key));
    assert.match(err.message, /\[redacted\]/);
  });
});

// ---------------------------------------------------------------------------
// Request building (OpenAI)
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: 'system', content: 'You are Nana.' },
  { role: 'user', content: 'New York this Friday' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"New York"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: { hotels: [] } },
  { role: 'assistant', content: 'Nothing yet', reasoning_content: 'thought', encrypted_content: '{"v":1,"api":"anthropic"}' },
  { role: 'user', content: 'Try again', at: '2026-11-04T00:00:00Z' },
];

describe('buildRequestBody (OpenAI)', () => {
  test('non-reasoning model: temperature and usage, tools, history sanitized for the wire', () => {
    const b = buildRequestBody({ model: 'gpt-4.1', messages: HISTORY, tools: TOOLS, temperature: 0.3, stream: true });
    assert.equal(b.temperature, 0.3);
    assert.deepEqual(b.stream_options, { include_usage: true });
    assert.equal(b.tools, TOOLS);
    assert.equal(b.reasoning_effort, undefined);
    assert.equal(b.max_completion_tokens, undefined);
    assert.deepEqual(b.messages[2], { role: 'assistant', content: null, tool_calls: HISTORY[2].tool_calls });
    assert.deepEqual(b.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"hotels":[]}' });
    assert.deepEqual(b.messages[4], { role: 'assistant', content: 'Nothing yet' }, 'no reasoning_content / encrypted_content echo');
    assert.deepEqual(b.messages[5], { role: 'user', content: 'Try again' });
  });

  test('reasoning models (gpt-5*, o-series): no temperature, reasoning_effort when an effort is set', () => {
    const b = buildRequestBody({ model: 'gpt-5-mini', messages: HISTORY, tools: TOOLS, temperature: 0.3, stream: true, effort: 'low' });
    assert.equal(b.temperature, undefined);
    assert.equal(b.reasoning_effort, 'low');
    assert.equal(buildRequestBody({ model: 'o4-mini', messages: [], stream: false, thinking: true }).reasoning_effort, 'high');
    assert.equal(buildRequestBody({ model: 'gpt-5', messages: [], stream: false, effort: 'max' }).reasoning_effort, 'high');
    assert.equal(buildRequestBody({ model: 'gpt-5', messages: [], stream: false }).reasoning_effort, undefined);
    assert.equal(buildRequestBody({ model: 'gpt-4.1', messages: [], stream: false, effort: 'low' }).reasoning_effort, undefined);
    assert.equal(buildRequestBody({ model: 'gpt-5', messages: [], stream: false, maxTokens: 4000 }).max_completion_tokens, 4000);
    assert.equal(buildRequestBody({ model: 'gpt-5', messages: [], stream: false, tools: [] }).tools, undefined);
  });

  test('client sends POST {baseUrl}/chat/completions with bearer auth; gateways get max_tokens', async () => {
    const { fetch } = await run([okText('Sure')], { baseUrl: 'https://api.openai.com/v1/' });
    const req = fetch.calls[0];
    assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer sk-test-openai-key');
    assert.equal(req.headers.accept, 'text/event-stream');
    assert.equal(req.json.model, 'gpt-4.1-mini');
    assert.equal(req.json.stream, true);
    const gw = await run([okText('Sure')], { baseUrl: 'https://llm-gateway.example.com/v1', maxTokens: 2000 });
    assert.equal(gw.fetch.calls[0].url, 'https://llm-gateway.example.com/v1/chat/completions');
    assert.equal(gw.fetch.calls[0].json.max_tokens, 2000);
    assert.equal(gw.fetch.calls[0].json.max_completion_tokens, undefined);
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
  test('two US providers; Anthropic Claude Opus 5.5 is the default', () => {
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'openai']);
    assert.equal(DEFAULT_PROVIDER, 'anthropic');
    const c = resolveLlmConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    assert.equal(c.provider, 'anthropic');
    assert.equal(c.label, 'Anthropic Claude');
    assert.equal(c.baseUrl, 'https://api.anthropic.com');
    assert.equal(c.model, 'claude-opus-5-5');
    assert.equal(c.apiKey, 'sk-ant-test');
    assert.equal(c.keyEnv, 'ANTHROPIC_API_KEY');
    assert.equal(c.configured, true);
    assert.equal(c.effort, 'medium');
    assert.equal(c.fallbacks, 'default');
    assert.equal(c.thinking, false);
    assert.deepEqual(c.warnings, []);
    const none = resolveLlmConfig({});
    assert.equal(none.provider, 'anthropic');
    assert.equal(none.configured, false);
    for (const p of Object.values(PROVIDERS)) assert.ok(p.label && p.keyEnv && p.baseUrl && p.model && p.modelEnv);
  });

  test('the return shape is unchanged (plus effort and fallbacks)', () => {
    assert.deepEqual(Object.keys(resolveLlmConfig({})).sort(), [
      'apiKey', 'baseUrl', 'configured', 'effort', 'fallbacks', 'keyEnv', 'label', 'model', 'provider', 'temperature', 'thinking', 'warnings',
    ]);
  });

  test('OpenAI preset, and the provider whose key is set is chosen when LLM_PROVIDER is empty', () => {
    const o = resolveLlmConfig({ OPENAI_API_KEY: 'sk-proj-abc' });
    assert.equal(o.provider, 'openai');
    assert.equal(o.baseUrl, 'https://api.openai.com/v1');
    assert.equal(o.model, PROVIDERS.openai.model);
    assert.equal(o.keyEnv, 'OPENAI_API_KEY');
    assert.equal(o.effort, null);
    assert.equal(resolveLlmConfig({ OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-ant-1' }).provider, 'anthropic');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-ant-1' }).apiKey, 'sk-1');
  });

  test('model env vars, generic overrides, aliases and effort', () => {
    assert.equal(resolveLlmConfig({ ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'ChatGPT', OPENAI_MODEL: 'gpt-5' }).model, 'gpt-5');
    assert.equal(resolveLlmConfig({ LLM_MODEL: 'claude-haiku-5-5' }).model, 'claude-haiku-5-5');
    assert.equal(resolveLlmConfig({ LLM_MODEL: 'x', ANTHROPIC_MODEL: 'y' }).model, 'y', 'the provider-specific name wins');
    assert.equal(resolveLlmConfig({ LLM_API_KEY: 'g', ANTHROPIC_API_KEY: 'sk-ant-d' }).apiKey, 'g');
    assert.equal(resolveLlmConfig({ LLM_TEMPERATURE: 'hot' }).temperature, 0.3);
    assert.equal(resolveLlmConfig({ LLM_TEMPERATURE: '0.6' }).temperature, 0.6);
    assert.equal(normalizeProvider('Claude'), 'anthropic');
    assert.equal(normalizeProvider('GPT'), 'openai');
    assert.equal(normalizeProvider('deepseek'), null);
    assert.equal(resolveLlmConfig({ LLM_EFFORT: 'LOW' }).effort, 'low');
    assert.equal(resolveLlmConfig({ LLM_EFFORT: 'xhigh' }).effort, 'xhigh');
    assert.equal(resolveLlmConfig({ LLM_THINKING: 'on' }).effort, 'high');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'openai', LLM_EFFORT: 'minimal' }).effort, 'minimal');
    const bad = resolveLlmConfig({ LLM_EFFORT: 'turbo' });
    assert.equal(bad.effort, 'medium');
    assert.equal(bad.warnings.length, 1);
    assert.equal(resolveLlmConfig({ ANTHROPIC_FALLBACKS: 'off' }).fallbacks, null);
  });

  test('unknown providers (e.g. the old Chinese ones) fall back with an English warning that never shows the key', () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: 'deepseek', ANTHROPIC_API_KEY: 'sk-ant-secret-key-1' });
    assert.equal(c.provider, 'anthropic');
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /Unknown LLM_PROVIDER "deepseek"/);
    const wrong = resolveLlmConfig({ ANTHROPIC_API_KEY: 'sk-proj-not-anthropic' });
    assert.equal(wrong.warnings.length, 1);
    assert.match(wrong.warnings[0], /doesn't look like/);
    for (const w of [...c.warnings, ...wrong.warnings]) {
      assert.doesNotMatch(w, CJK);
      assert.ok(!w.includes('secret'), w);
      assert.ok(!w.includes('not-anthropic'), w);
    }
  });

  test('LLM_BASE_URL decides the provider when LLM_PROVIDER is empty, and a mismatch is warned about', () => {
    assert.equal(inferProvider('https://api.anthropic.com'), 'anthropic');
    assert.equal(inferProvider('https://api.openai.com/v1'), 'openai');
    assert.equal(inferProvider('https://my-resource.openai.azure.com/openai'), 'openai');
    assert.equal(inferProvider('not a url'), null);
    const c = resolveLlmConfig({ LLM_BASE_URL: 'https://api.openai.com/v1/', OPENAI_API_KEY: 'sk-k' });
    assert.equal(c.provider, 'openai');
    assert.equal(c.baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(c.warnings, []);
    const gateway = resolveLlmConfig({ LLM_BASE_URL: 'https://gw.example.com/v1' });
    assert.equal(gateway.provider, 'anthropic');
    assert.equal(gateway.baseUrl, 'https://gw.example.com/v1');
    const mismatch = resolveLlmConfig({ LLM_PROVIDER: 'anthropic', LLM_BASE_URL: 'https://api.openai.com/v1' });
    assert.equal(mismatch.provider, 'anthropic');
    assert.equal(mismatch.warnings.length, 1);
    assert.match(mismatch.warnings[0], /OpenAI/);
  });

  test('resolveLlmConfig output can be spread into createLlmClient (both providers)', async () => {
    const openaiFetch = createFakeFetch([okText('Sure')]);
    const o = createLlmClient({ ...resolveLlmConfig({ OPENAI_API_KEY: 'sk-test-openai' }), fetch: openaiFetch });
    assert.equal(o.provider, 'openai');
    assert.equal((await o.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS })).content, 'Sure');
    assert.equal(openaiFetch.calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(openaiFetch.calls[0].json.temperature, undefined, 'gpt-5 family: no temperature');

    const anthropicFetch = createFakeFetch([sseStep(textAnswer('Hello!'))]);
    const a = createLlmClient({ ...resolveLlmConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }), fetch: anthropicFetch });
    assert.equal(a.provider, 'anthropic');
    assert.equal(a.model, 'claude-opus-5-5');
    assert.equal((await a.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS })).content, 'Hello!');
    assert.equal(anthropicFetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(anthropicFetch.calls[0].headers['x-api-key'], 'sk-ant-test-key');
    assert.deepEqual(anthropicFetch.calls[0].json.output_config, { effort: 'medium' });
  });
});
