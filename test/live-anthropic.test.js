import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClient, LlmError, buildAnthropicRequest, classifyAnthropicError, LLM_ERROR_MESSAGES } from '../src/llm/client.js';
import { ANTHROPIC, decodeReplay, sanitizeToolId, supportsEffort, supportsServerFallback } from '../src/llm/anthropic.js';
import { createFakeFetch } from './fakes/fake-fetch.js';
import { anthropicSse, sseStep, ev, textAnswer, anthropicMessage, anthropicError } from './fakes/anthropic-sse.js';

const KEY = 'sk-ant-api03-test-key-0123456789';
const CJK = /[　-鿿]/;
const TOOLS = [
  { type: 'function', function: { name: 'search_hotels', description: 'Search hotels', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'get_hotel_rooms', description: 'Rooms of one hotel', parameters: { type: 'object', properties: { hotel_id: { type: 'string' } } } } },
];

function makeClient(steps, opts = {}) {
  const fetch = createFakeFetch(steps);
  const sleeps = [];
  let ids = 0;
  const llm = createLlmClient({
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: KEY,
    model: 'claude-opus-5-5',
    effort: 'medium',
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

const USER = [{ role: 'system', content: 'You are Nana, a hotel concierge.' }, { role: 'user', content: 'Hotels near Times Square this Friday' }];

async function run(steps, opts = {}, chatArgs = {}) {
  const { llm, fetch, sleeps } = makeClient(steps, opts);
  const deltas = [];
  const res = await llm.chat({ messages: USER, tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs });
  return { res, deltas, fetch, sleeps, llm };
}

async function runError(steps, opts = {}, chatArgs = {}) {
  const { llm, fetch, sleeps } = makeClient(steps, opts);
  const deltas = [];
  const err = await llm.chat({ messages: USER, tools: TOOLS, onTextDelta: (t) => deltas.push(t), ...chatArgs }).then(
    () => assert.fail('expected chat() to reject'),
    (e) => e,
  );
  return { err, deltas, fetch, sleeps };
}

const toolTurn = (signature = 'sig-1') => anthropicSse(
  ev.start(),
  ev.thinking(0, signature),
  ev.text(1, 'On it!'),
  ev.tool(2, 'toolu_01', 'search_hotels', ['{"ci', 'ty": "New York"}']),
  ev.delta('tool_use'),
  ev.stop(),
);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

describe('Anthropic request', () => {
  test('POST /v1/messages with x-api-key, anthropic-version, the fallback beta and a streamed body', async () => {
    const { fetch } = await run([sseStep(textAnswer('Hi!'))]);
    const req = fetch.calls[0];
    assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-api-key'], KEY);
    assert.equal(req.headers['anthropic-version'], ANTHROPIC.version);
    assert.equal(req.headers['anthropic-beta'], ANTHROPIC.fallbackBeta);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.accept, 'text/event-stream');
    assert.equal(req.headers.authorization, undefined);
    const b = req.json;
    assert.equal(b.model, 'claude-opus-5-5');
    assert.equal(b.max_tokens, ANTHROPIC.defaultMaxTokens);
    assert.equal(b.stream, true);
    assert.deepEqual(b.output_config, { effort: 'medium' });
    assert.equal(b.fallbacks, 'default');
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert.equal(b[k], undefined, k);
    assert.deepEqual(b.system, [{ type: 'text', text: 'You are Nana, a hotel concierge.', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(b.messages, [{ role: 'user', content: [{ type: 'text', text: 'Hotels near Times Square this Friday', cache_control: { type: 'ephemeral' } }] }]);
  });

  test('tools become name/description/input_schema with eager input streaming; the last one carries the cache breakpoint', async () => {
    const { fetch } = await run([sseStep(textAnswer('Hi!'))]);
    const tools = fetch.calls[0].json.tools;
    assert.deepEqual(tools[0], { name: 'search_hotels', description: 'Search hotels', input_schema: TOOLS[0].function.parameters, eager_input_streaming: true });
    assert.equal(tools[1].cache_control.type, 'ephemeral');
    assert.equal(tools[0].cache_control, undefined);
    const gw = await run([sseStep(textAnswer('Hi!'))], { baseUrl: 'https://claude-gateway.example.com/v1' });
    assert.equal(gw.fetch.calls[0].url, 'https://claude-gateway.example.com/v1/messages');
    assert.equal(gw.fetch.calls[0].json.tools[0].eager_input_streaming, undefined, 'off behind a custom base URL');
    assert.equal(gw.fetch.calls[0].json.fallbacks, undefined, 'fallbacks only on the Claude API');
    assert.equal(gw.fetch.calls[0].headers['anthropic-beta'], undefined);
  });

  test('effort and fallbacks follow the model; LLM_EFFORT-style values are normalized', async () => {
    assert.equal(supportsEffort('claude-opus-5-5'), true);
    assert.equal(supportsEffort('claude-sonnet-5-5'), true);
    assert.equal(supportsEffort('claude-haiku-4-5'), false);
    assert.equal(supportsServerFallback('claude-opus-5-5'), true);
    assert.equal(supportsServerFallback('claude-haiku-5-5'), false);
    const haiku = await run([sseStep(textAnswer('Hi!'))], { model: 'claude-haiku-4-5' });
    assert.equal(haiku.fetch.calls[0].json.output_config, undefined);
    assert.equal(haiku.fetch.calls[0].json.fallbacks, undefined);
    const high = await run([sseStep(textAnswer('Hi!'))], { effort: undefined, thinking: true });
    assert.deepEqual(high.fetch.calls[0].json.output_config, { effort: 'high' });
    const off = await run([sseStep(textAnswer('Hi!'))], { fallbacks: null, effort: null });
    assert.equal(off.fetch.calls[0].json.fallbacks, undefined);
    assert.equal(off.fetch.calls[0].json.output_config, undefined);
    assert.equal(off.fetch.calls[0].headers['anthropic-beta'], undefined);
  });

  test('OpenAI-style history becomes valid alternating Messages turns', () => {
    const { body } = buildAnthropicRequest({
      model: 'claude-opus-5-5',
      promptCaching: false,
      messages: [
        { role: 'system', content: 'S' },
        { role: 'assistant', content: 'stray leading assistant turn' },
        { role: 'user', content: 'Book something in Miami' },
        { role: 'user', content: '[System notice — not from the user] Your order was paid.' },
        { role: 'assistant', content: 'Checking two things', tool_calls: [
          { id: 'functions.search_hotels:0', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"Miami"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_hotel_rooms', arguments: '{"hotel_id":"lp1"}' } },
        ] },
        { role: 'tool', tool_call_id: 'functions.search_hotels:0', content: '{"hotels":[]}' },
        { role: 'tool', tool_call_id: 'call_orphan', content: '{"x":1}' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"Miami Beach"}' } }] },
        { role: 'tool', tool_call_id: 'call_3', content: '{"error":"City not covered"}' },
        { role: 'user', content: 'ok' },
        { role: 'assistant', content: 'trailing assistant (no prefill)' },
      ],
    });
    const sid = sanitizeToolId('functions.search_hotels:0');
    assert.match(sid, /^[A-Za-z0-9_-]+$/);
    assert.equal(sid, sanitizeToolId('functions.search_hotels:0'), 'deterministic');
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(body.messages[0].content.map((b) => b.text), ['Book something in Miami', '[System notice — not from the user] Your order was paid.']);
    assert.deepEqual(body.messages[1].content, [
      { type: 'text', text: 'Checking two things' },
      { type: 'tool_use', id: sid, name: 'search_hotels', input: { city: 'Miami' } },
      { type: 'tool_use', id: 'call_2', name: 'get_hotel_rooms', input: { hotel_id: 'lp1' } },
    ]);
    // Both results in one user message, in tool_use order; the missing one is filled in, the orphan dropped.
    assert.deepEqual(body.messages[2].content, [
      { type: 'tool_result', tool_use_id: sid, content: '{"hotels":[]}' },
      { type: 'tool_result', tool_use_id: 'call_2', content: '{"error":"No result was recorded for this call."}', is_error: true },
    ]);
    assert.deepEqual(body.messages[4].content, [
      { type: 'tool_result', tool_use_id: 'call_3', content: '{"error":"City not covered"}', is_error: true },
      { type: 'text', text: 'ok' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('Anthropic streaming', () => {
  test('text deltas reach the caller as they arrive; usage is merged', async () => {
    const body = anthropicSse(ev.start(), ev.ping(), ev.text(0, ['Here are ', 'a few near ', 'Times Square.']), ev.delta('end_turn', { output_tokens: 9 }), ev.stop());
    const { res, deltas, fetch } = await run([sseStep(body, 5)]);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(deltas, ['Here are ', 'a few near ', 'Times Square.']);
    assert.equal(res.content, 'Here are a few near Times Square.');
    assert.equal(res.finishReason, 'stop');
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.usage.output_tokens, 9);
    assert.equal(res.usage.input_tokens, 25);
    assert.equal(res.encryptedContent, undefined, 'no thinking, nothing to replay');
  });

  test('tool_use input streamed as input_json_delta pieces becomes a tool call; thinking is never shown', async () => {
    const { res, deltas } = await run([sseStep(toolTurn(), 3)]);
    assert.deepEqual(deltas, ['On it!']);
    assert.equal(res.content, 'On it!');
    assert.deepEqual(res.toolCalls, [{ id: 'toolu_01', name: 'search_hotels', arguments: '{"city":"New York"}' }]);
    assert.equal(res.finishReason, 'tool_calls');
    const rec = decodeReplay(res.encryptedContent);
    assert.ok(rec, 'thinking blocks travel as encryptedContent');
    assert.deepEqual(rec.blocks, [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'On it!' },
      { type: 'tool_use', id: 'toolu_01', name: 'search_hotels', input: { city: 'New York' } },
    ]);
  });

  test('parallel tool calls keep their order; a call without input gets {}', async () => {
    const body = anthropicSse(
      ev.start(),
      ev.tool(0, 'toolu_a', 'search_hotels', '{"city":"Boston"}'),
      ev.tool(1, 'toolu_b', 'get_hotel_rooms', ''),
      ev.delta('tool_use'),
      ev.stop(),
    );
    const { res } = await run([sseStep(body)]);
    assert.deepEqual(res.toolCalls, [
      { id: 'toolu_a', name: 'search_hotels', arguments: '{"city":"Boston"}' },
      { id: 'toolu_b', name: 'get_hotel_rooms', arguments: '{}' },
    ]);
  });

  test('a text block after thinking starts a new paragraph on screen', async () => {
    const body = anthropicSse(ev.start(), ev.text(0, 'First thought.'), ev.thinking(1, 'sig-x'), ev.text(2, 'Second thought.'), ev.delta('end_turn'), ev.stop());
    const { res, deltas } = await run([sseStep(body)]);
    assert.equal(res.content, 'First thought.\n\nSecond thought.');
    assert.equal(deltas.join(''), res.content);
    assert.deepEqual(decodeReplay(res.encryptedContent).blocks.filter((b) => b.type === 'text').map((b) => b.text), ['First thought.', 'Second thought.']);
  });

  test('stream: false uses a complete Messages response', async () => {
    const json = anthropicMessage({ content: [{ type: 'thinking', thinking: '', signature: 'sig-j' }, { type: 'text', text: 'All set.' }] });
    const { res, deltas, fetch } = await run([{ json }], { stream: false });
    assert.equal(fetch.calls[0].json.stream, undefined);
    assert.equal(fetch.calls[0].headers.accept, 'application/json');
    assert.deepEqual(deltas, ['All set.']);
    assert.equal(res.content, 'All set.');
    assert.ok(decodeReplay(res.encryptedContent));
  });

  test('stop_reason refusal → content_filter, never retried (the agent retracts the turn)', async () => {
    const body = anthropicSse(ev.start(), ev.text(0, 'Partial '), ev.delta('refusal', { output_tokens: 3 }, { type: 'refusal', category: 'cyber', explanation: null }), ev.stop());
    const { err, deltas, fetch } = await runError([sseStep(body), sseStep(textAnswer('x'))]);
    assert.ok(err instanceof LlmError);
    assert.equal(err.code, 'content_filter');
    assert.equal(err.providerCode, 'refusal:cyber');
    assert.equal(err.userMessage, LLM_ERROR_MESSAGES.content_filter);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(deltas, ['Partial ']);
  });

  test('a tool input cut off by max_tokens is streamed again with a larger limit', async () => {
    const cut = anthropicSse(ev.start(), ev.tool(0, 'toolu_c', 'search_hotels', '{"city":"New', { stop: false }), ev.delta('max_tokens'), ev.stop());
    const { res, fetch } = await run([sseStep(cut), sseStep(toolTurn())]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].json.stream, true);
    assert.equal(fetch.calls[1].json.max_tokens, 32000);
    assert.deepEqual(res.toolCalls.map((c) => c.name), ['search_hotels']);
  });

  test('malformed tool JSON (eager streaming) is asked again once without streaming; still broken → flagged', async () => {
    const broken = anthropicSse(ev.start(), ev.tool(0, 'toolu_m', 'search_hotels', '{"city": New York}'), ev.delta('tool_use'), ev.stop());
    const fixed = anthropicMessage({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_n', name: 'search_hotels', input: { city: 'New York' } }] });
    const ok = await run([sseStep(broken), { json: fixed }]);
    assert.equal(ok.fetch.calls.length, 2);
    assert.equal(ok.fetch.calls[1].json.stream, undefined);
    assert.equal(ok.fetch.calls[1].json.max_tokens, ANTHROPIC.defaultMaxTokens);
    assert.deepEqual(ok.res.toolCalls, [{ id: 'toolu_n', name: 'search_hotels', arguments: '{"city":"New York"}' }]);

    const shown = anthropicSse(ev.start(), ev.text(0, 'Looking'), ev.tool(1, 'toolu_m', 'search_hotels', '{"city":'), ev.delta('tool_use'), ev.stop());
    const flagged = await run([sseStep(shown)]);
    assert.equal(flagged.fetch.calls.length, 1, 'no second request once text was shown');
    assert.deepEqual(flagged.res.toolCalls, [{ id: 'toolu_m', name: 'search_hotels', arguments: '{}', invalidArguments: true }]);
  });

  test('a stream cut before message_stop is retried before any text, reported after', async () => {
    const cutEarly = anthropicSse(ev.start(), ev.tool(0, 'toolu_x', 'search_hotels', '{"ci', { stop: false }));
    const early = await run([sseStep(cutEarly), sseStep(textAnswer('Here you go.'))]);
    assert.equal(early.fetch.calls.length, 2);
    assert.equal(early.res.content, 'Here you go.');

    const cutLate = anthropicSse(ev.start(), ev.text(0, 'I recommend the Loop'));
    const late = await runError([sseStep(cutLate), sseStep(textAnswer('x'))]);
    assert.equal(late.err.code, 'network');
    assert.equal(late.fetch.calls.length, 1);
    assert.equal(late.deltas.join(''), 'I recommend the Loop');
  });

  test('an error event (overloaded) before any text is retried; after text it ends the turn', async () => {
    const overloaded = anthropicSse(ev.start(), ev.error('overloaded_error', 'Overloaded'));
    const before = await run([sseStep(overloaded), sseStep(textAnswer('Sure!'))]);
    assert.equal(before.fetch.calls.length, 2);
    assert.deepEqual(before.sleeps, [500]);
    assert.equal(before.res.content, 'Sure!');

    const after = await runError([sseStep(anthropicSse(ev.start(), ev.text(0, 'Half'), ev.error('overloaded_error', 'Overloaded'))), sseStep(textAnswer('x'))]);
    assert.equal(after.err.code, 'unavailable');
    assert.equal(after.fetch.calls.length, 1);
  });

  test('a mid-stream refusal fallback: the declined attempt\'s tool calls and thinking are dropped, its text kept', async () => {
    const body = anthropicSse(
      ev.start('claude-opus-5-5'),
      ev.thinking(0, 'sig-declined'),
      ev.text(1, 'Let me '),
      ev.tool(2, 'toolu_declined', 'search_hotels', '{"city":"Nowhere"}'),
      ev.fallback(3),
      ev.thinking(4, 'sig-fallback'),
      ev.text(5, 'look that up.'),
      ev.tool(6, 'toolu_ok', 'search_hotels', '{"city":"Chicago"}'),
      ev.delta('tool_use'),
      ev.stop(),
    );
    const { res } = await run([sseStep(body)]);
    assert.deepEqual(res.toolCalls, [{ id: 'toolu_ok', name: 'search_hotels', arguments: '{"city":"Chicago"}' }]);
    assert.match(res.content, /^Let me /);
    const blocks = decodeReplay(res.encryptedContent).blocks;
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'thinking', 'text', 'tool_use']);
    assert.ok(!JSON.stringify(blocks).includes('sig-declined'));
    assert.ok(!JSON.stringify(blocks).includes('toolu_declined'));
  });
});

// ---------------------------------------------------------------------------
// Thinking replay (preserved thinking)
// ---------------------------------------------------------------------------

describe('thinking replay', () => {
  async function firstStep() {
    const { res } = await run([sseStep(toolTurn('sig-step1'))]);
    return [
      ...USER,
      { role: 'assistant', content: res.content, tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })), encrypted_content: res.encryptedContent },
      { role: 'tool', tool_call_id: res.toolCalls[0].id, content: '{"hotels":[{"id":"lp1"}]}' },
    ];
  }

  test('within a turn the thinking blocks go back unchanged, in their original order', async () => {
    const history = await firstStep();
    const { fetch } = await run([sseStep(textAnswer('Here are three.'))], {}, { messages: history });
    const assistant = fetch.calls[0].json.messages[1];
    assert.deepEqual(assistant, {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-step1' },
        { type: 'text', text: 'On it!' },
        { type: 'tool_use', id: 'toolu_01', name: 'search_hotels', input: { city: 'New York' } },
      ],
    });
  });

  test('once the prefix changed (a new system prompt) the blocks are not replayed', async () => {
    const history = await firstStep();
    const changed = [{ role: 'system', content: 'You are Nana. It is now 9:31 PM.' }, ...history.slice(1)];
    const { fetch } = await run([sseStep(textAnswer('Here are three.'))], {}, { messages: changed });
    const assistant = fetch.calls[0].json.messages[1];
    assert.deepEqual(assistant.content.map((b) => b.type), ['text', 'tool_use']);
  });

  test('blocks whose tool calls no longer match the history are not replayed', async () => {
    const history = await firstStep();
    history[2] = { ...history[2], tool_calls: [{ id: 'call_regenerated', type: 'function', function: { name: 'search_hotels', arguments: '{"city":"New York"}' } }] };
    history[3] = { ...history[3], tool_call_id: 'call_regenerated' };
    const { fetch } = await run([sseStep(textAnswer('ok'))], {}, { messages: history });
    assert.ok(!JSON.stringify(fetch.calls[0].json).includes('sig-step1'));
  });

  test('a 400 about a thinking signature is retried once with every thinking block stripped, and not replayed again', async () => {
    const history = await firstStep();
    const sig400 = { status: 400, json: anthropicError('invalid_request_error', 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.') };
    const { llm, fetch } = makeClient([sig400, sseStep(textAnswer('Here are three.')), sseStep(textAnswer('Again.'))]);
    const res = await llm.chat({ messages: history, tools: TOOLS });
    assert.equal(res.content, 'Here are three.');
    assert.equal(fetch.calls.length, 2);
    assert.ok(JSON.stringify(fetch.calls[0].json).includes('sig-step1'));
    assert.ok(!JSON.stringify(fetch.calls[1].json).includes('"thinking"'));
    await llm.chat({ messages: history, tools: TOOLS });
    assert.ok(!JSON.stringify(fetch.calls[2].json).includes('sig-step1'), 'the refused record stays out');
  });

  test('records from other providers or damaged ones are ignored', () => {
    assert.equal(decodeReplay('enc-abc'), null);
    assert.equal(decodeReplay('{"v":1,"api":"other","h":"x","blocks":[]}'), null);
    assert.equal(decodeReplay('{"v":1,"api":"anthropic","h":"x","blocks":[{"type":"text"}]}'), null);
    assert.equal(decodeReplay(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERRORS = [
  ['401 authentication_error', 401, anthropicError('authentication_error', 'invalid x-api-key'), 'auth'],
  ['403 permission_error', 403, anthropicError('permission_error', 'Your API key does not have permission to use the specified resource.'), 'auth'],
  ['402 billing_error', 402, anthropicError('billing_error', 'Billing issue'), 'billing'],
  ['400 credit balance too low', 400, anthropicError('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'billing'],
  ['404 model', 404, anthropicError('not_found_error', 'model: claude-opus-9'), 'bad_request', 'model_not_found'],
  ['413 request_too_large', 413, anthropicError('request_too_large', 'Request exceeds the maximum allowed number of bytes.'), 'bad_request', 'context_length'],
  ['400 prompt too long', 400, anthropicError('invalid_request_error', 'prompt is too long: 1050000 tokens > 1000000 maximum'), 'bad_request', 'context_length'],
  ['400 invalid request', 400, anthropicError('invalid_request_error', 'messages: roles must alternate between "user" and "assistant"'), 'bad_request'],
  ['429 rate_limit_error', 429, anthropicError('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), 'rate_limit'],
  ['500 api_error', 500, anthropicError('api_error', 'Internal server error'), 'unavailable'],
  ['529 overloaded_error', 529, anthropicError('overloaded_error', 'Overloaded'), 'unavailable'],
  ['504 gateway timeout (HTML)', 504, '<html>Gateway Timeout</html>', 'timeout'],
];

describe('Anthropic errors', () => {
  for (const [name, status, body, code, reason] of ERRORS) {
    test(`${name} → ${code}${reason ? `/${reason}` : ''}`, () => {
      const err = classifyAnthropicError(status, body);
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, code);
      assert.equal(err.reason, reason || '');
      assert.equal(err.status, status);
      assert.equal(err.retryable, ['rate_limit', 'timeout', 'unavailable', 'network'].includes(code));
      assert.doesNotMatch(err.userMessage, CJK);
    });
  }

  test('429 honours retry-after, 529 is retried, auth is not; the request id is kept', async () => {
    const limited = await run([{ status: 429, json: anthropicError('rate_limit_error', 'slow down'), headers: { 'retry-after': '3' } }, sseStep(textAnswer('Sure'))]);
    assert.deepEqual(limited.sleeps, [3000]);
    const busy = await run([{ status: 529, json: anthropicError('overloaded_error', 'Overloaded') }, sseStep(textAnswer('Sure'))]);
    assert.equal(busy.fetch.calls.length, 2);
    const auth = await runError([{ status: 401, json: anthropicError('authentication_error', 'invalid x-api-key'), headers: { 'request-id': 'req_abc' } }, sseStep(textAnswer('x'))]);
    assert.equal(auth.fetch.calls.length, 1);
    assert.equal(auth.err.code, 'auth');
    assert.equal(auth.err.requestId, 'req_err_1');
    const noRetry = await runError([{ status: 500, json: anthropicError('api_error', 'x'), headers: { 'x-should-retry': 'false' } }, sseStep(textAnswer('x'))]);
    assert.equal(noRetry.fetch.calls.length, 1);
  });

  test('a 400 rejecting the fallback beta is retried without it, and the client stops sending it', async () => {
    const rejected = { status: 400, json: anthropicError('invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.') };
    const { llm, fetch } = makeClient([rejected, sseStep(textAnswer('Hi')), sseStep(textAnswer('Hi again'))]);
    assert.equal((await llm.chat({ messages: USER, tools: TOOLS })).content, 'Hi');
    assert.equal(fetch.calls[1].json.fallbacks, undefined);
    assert.equal(fetch.calls[1].headers['anthropic-beta'], undefined);
    await llm.chat({ messages: USER, tools: TOOLS });
    assert.equal(fetch.calls[2].json.fallbacks, undefined);
  });

  test('a stalled stream hits the idle timeout; a user stop rejects with the abort', async () => {
    const enc = new TextEncoder();
    const stalled = () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(anthropicSse(ev.start())));
      },
      pull: () => new Promise(() => {}),
    }), { headers: { 'content-type': 'text/event-stream' } });
    const t = await runError([stalled, stalled], { timeoutMs: 40, maxRetries: 1 });
    assert.equal(t.err.code, 'timeout');
    assert.equal(t.fetch.calls.length, 2);

    const ctrl = new AbortController();
    const { llm } = makeClient([{ ...sseStep(textAnswer('Slow answer')), chunkDelayMs: 100 }]);
    setTimeout(() => ctrl.abort(), 20);
    const err = await llm.chat({ messages: USER, signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
    assert.ok(!(err instanceof LlmError));
  });

  test('the API key never appears in errors', async () => {
    const { err } = await runError([{ status: 401, json: anthropicError('authentication_error', `invalid x-api-key ${KEY}`) }]);
    assert.ok(!err.message.includes(KEY));
    assert.ok(!err.userMessage.includes(KEY));
    assert.ok(!JSON.stringify(err).includes(KEY));
  });
});
