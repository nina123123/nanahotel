import {
  LlmError, isPlainObject, nonBlank, parseToolArguments, parseRetryAfter, shouldRetryHeader, isRetryableCode,
} from './core.js';

/**
 * Anthropic Messages API adapter (raw fetch: the project has no npm dependencies, and tests inject fetch).
 *
 * The agent speaks OpenAI-style messages ({ role: 'assistant', tool_calls }, { role: 'tool', tool_call_id });
 * this file converts them to Messages API content blocks, streams the answer (text deltas to the user, tool_use
 * input accumulated per block), and hands back the chat() result the agent loop expects.
 *
 * Thinking: Claude Opus 5.5 always thinks (adaptive; `output_config.effort` is the only control). Its `thinking`
 * blocks must go back unchanged in a tool-use loop, and they are bound to the conversation prefix (system prompt,
 * tools, every earlier message): replaying one after that prefix changed is a 400 on newer accounts. So the
 * blocks of each answer travel in the chat() result as `encryptedContent` (the agent stores it on the assistant
 * message as `encrypted_content`) together with a hash of the request prefix that produced them, and they are
 * replayed only while that prefix is unchanged. A 400 about a thinking signature anyway makes the request go once
 * more with every thinking block stripped (the documented recovery).
 */

// ---------------------------------------------------------------------------
// VERIFY: every assumption about the Anthropic API lives here (sources: Anthropic's Claude API reference for
// the Messages API, streaming, tool use, errors, refusals/fallbacks and preserved thinking, as of 2026-10).
// ---------------------------------------------------------------------------
export const ANTHROPIC = Object.freeze({
  baseUrl: 'https://api.anthropic.com',
  messagesPath: '/v1/messages',
  // Required header. On this version temperature/top_p/top_k are rejected on every model, so none are sent.
  version: '2026-10-21',
  apiKeyHeader: 'x-api-key',
  defaultModel: 'claude-opus-5-5',
  // Thinking counts toward max_tokens; replies here are short chat turns plus a little thinking.
  defaultMaxTokens: 16000,
  maxRetryTokens: 64000,
  // Opus 5.5's API default is medium; it is sent explicitly.
  defaultEffort: 'medium',
  efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  // Server-side refusal fallback: `fallbacks: "default"` + this beta header re-runs a classifier-declined request on
  // the model Anthropic recommends for that refusal category (Claude API only, not on a custom base URL).
  fallbackBeta: 'server-side-fallback-2026-07-01',
  fallbackModels: Object.freeze(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']),
  // Stream events: message_start, content_block_start/delta/stop, message_delta, message_stop, ping, error.
  // Deltas: text_delta, thinking_delta, signature_delta, input_json_delta. Block types: text, thinking,
  // redacted_thinking, tool_use, fallback (a refusal-fallback boundary marker).
  // Stop reasons: end_turn, tool_use, max_tokens, stop_sequence, pause_turn, refusal, model_context_window_exceeded.
  // Errors: { type: 'error', error: { type, message }, request_id } with types invalid_request_error 400,
  // authentication_error 401, billing_error 402, permission_error 403, not_found_error 404, request_too_large 413,
  // rate_limit_error 429, api_error 500, overloaded_error 529; retry-after and x-should-retry headers.
});

const EPHEMERAL = Object.freeze({ type: 'ephemeral' });
const MAX_REPLAY_CHARS = 512 * 1024;
const MAX_POISONED = 1000;
const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STOP_TO_FINISH = Object.freeze({ end_turn: 'stop', stop_sequence: 'stop', pause_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' });
const MISSING_RESULT = JSON.stringify({ error: 'No result was recorded for this call.' });

/** Effort levels (output_config.effort) are accepted by Opus 4.5+, Sonnet 4.6+, Haiku 5+, Fable and Mythos. */
export function supportsEffort(model) {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-[6-9]|5)|haiku-5|fable-|mythos-)/.test(String(model || ''));
}

export function supportsServerFallback(model) {
  return ANTHROPIC.fallbackModels.includes(String(model || ''));
}

export function normalizeEffort(effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (ANTHROPIC.efforts.includes(e)) return e;
  if (e === 'minimal') return 'low';
  return null;
}

// ---------------------------------------------------------------------------
// Hashing (pure JS: these modules also run in the phone apps, whose node:crypto shim has no createHash)
// ---------------------------------------------------------------------------

function createHasher() {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  let n = 0;
  return {
    update(s) {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 13;
      }
      n += s.length;
    },
    digest() {
      return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}${n.toString(36)}`;
    },
  };
}

function shortHash(s) {
  const h = createHasher();
  h.update(String(s));
  return h.digest().slice(0, 12);
}

/** Tool ids must match ^[A-Za-z0-9_-]+$; other providers' ids ('functions.x:0') are mapped deterministically. */
export function sanitizeToolId(id) {
  const s = String(id ?? '');
  if (TOOL_ID_RE.test(s)) return s;
  const base = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'call';
  return `${base}_${shortHash(s)}`;
}

// ---------------------------------------------------------------------------
// Replay records (thinking blocks carried through the agent's history)
// ---------------------------------------------------------------------------

export function encodeReplay(prefixHash, blocks) {
  const s = JSON.stringify({ v: 1, api: 'anthropic', h: prefixHash, blocks });
  return s.length <= MAX_REPLAY_CHARS ? s : '';
}

function cleanReplayBlock(b) {
  if (!isPlainObject(b)) return null;
  if (b.type === 'thinking' && typeof b.thinking === 'string' && typeof b.signature === 'string') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
  if (b.type === 'redacted_thinking' && typeof b.data === 'string') return { type: 'redacted_thinking', data: b.data };
  if (b.type === 'text' && typeof b.text === 'string' && b.text) return { type: 'text', text: b.text };
  if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' && isPlainObject(b.input)) return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  return null;
}

/** The record stored by encodeReplay, or null for anything else (other providers' data, damage). */
export function decodeReplay(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{"v":1')) return null;
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(rec) || rec.v !== 1 || rec.api !== 'anthropic' || typeof rec.h !== 'string' || !Array.isArray(rec.blocks)) return null;
  const blocks = [];
  for (const b of rec.blocks) {
    const c = cleanReplayBlock(b);
    if (!c) return null;
    blocks.push(c);
  }
  return blocks.length ? { h: rec.h, blocks } : null;
}

function toolUseSignature(blocks) {
  return JSON.stringify(blocks.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.name, b.input]));
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return content == null ? '' : String(content);
}

/** OpenAI-style tool definitions ({ type: 'function', function: { name, description, parameters } }) → Anthropic. */
export function toAnthropicTools(tools, { eager = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = isPlainObject(t?.function) ? t.function : isPlainObject(t) && typeof t.name === 'string' ? t : null;
    if (!fn || typeof fn.name !== 'string' || !fn.name || seen.has(fn.name)) continue;
    seen.add(fn.name);
    const schema = isPlainObject(fn.parameters) ? fn.parameters : isPlainObject(fn.input_schema) ? fn.input_schema : null;
    const tool = { name: fn.name };
    if (typeof fn.description === 'string' && fn.description) tool.description = fn.description;
    tool.input_schema = schema && schema.type === 'object' ? schema : { type: 'object', properties: {} };
    // Streams tool input as it is generated; the input is then validated here (strict JSON parse) and by the tools.
    if (eager) tool.eager_input_streaming = true;
    out.push(tool);
  }
  return out;
}

function toolResultBlock(m) {
  const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null);
  const content = raw && raw.trim() ? raw : '{}';
  const block = { type: 'tool_result', tool_use_id: sanitizeToolId(m.tool_call_id), content };
  try {
    const j = JSON.parse(content);
    if (isPlainObject(j) && typeof j.error === 'string') block.is_error = true;
  } catch {
    // plain text result
  }
  return block;
}

function assistantCalls(m) {
  const calls = [];
  for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    if (!isPlainObject(c)) continue;
    const name = nonBlank(c.function?.name ?? c.name);
    if (!name) continue;
    const args = c.function?.arguments ?? c.arguments;
    const input = typeof args === 'string' ? parseToolArguments(args) : isPlainObject(args) ? args : {};
    calls.push({ type: 'tool_use', id: sanitizeToolId(c.id), name, input: input ?? {} });
  }
  return calls;
}

/**
 * OpenAI-style history → { system, wire messages, prefixHash }. Repairs what the Messages API rejects: consecutive
 * same-role turns are merged, tool results go into one user message right after their tool_use (missing ones are
 * filled in as errors, orphans dropped), and the conversation starts and ends with a user turn.
 */
function buildConversation(messages, { toolsWire, stripThinking = false, poisoned = new Set() } = {}) {
  const systemParts = [];
  const out = [];
  let pending = null;

  const pushUser = (blocks) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === 'user') last.blocks.push(...blocks);
    else out.push({ role: 'user', blocks: [...blocks] });
  };
  const closePending = (userBlocks = []) => {
    if (pending) {
      const results = pending.ids.map((id) => pending.results.get(id) || { type: 'tool_result', tool_use_id: id, content: MISSING_RESULT, is_error: true });
      pending = null;
      pushUser([...results, ...userBlocks]);
    } else {
      pushUser(userBlocks);
    }
  };

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isPlainObject(m) || typeof m.role !== 'string') continue;
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t.trim()) systemParts.push(t);
    } else if (m.role === 'tool') {
      const block = toolResultBlock(m);
      if (pending && pending.ids.includes(block.tool_use_id) && !pending.results.has(block.tool_use_id)) pending.results.set(block.tool_use_id, block);
    } else if (m.role === 'user') {
      const t = textOf(m.content);
      closePending(t.trim() ? [{ type: 'text', text: t }] : []);
    } else if (m.role === 'assistant') {
      const calls = assistantCalls(m);
      const text = textOf(m.content);
      const blocks = [];
      if (text.trim()) blocks.push({ type: 'text', text });
      blocks.push(...calls);
      if (!blocks.length) continue;
      closePending();
      // The first turn must be the user's.
      if (!out.length) continue;
      const last = out.at(-1);
      if (last.role === 'assistant') {
        last.blocks.push(...blocks);
        last.replay = null;
      } else {
        out.push({ role: 'assistant', blocks, replay: decodeReplay(m.encrypted_content) });
      }
      const ids = out.at(-1).blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
      pending = ids.length ? { ids, results: new Map() } : null;
    }
  }
  closePending();
  // No assistant prefill: the request must end with the user's turn.
  while (out.length && out.at(-1).role === 'assistant') out.pop();
  if (!out.length) out.push({ role: 'user', blocks: [{ type: 'text', text: '…' }] });

  const system = systemParts.join('\n\n');
  const hasher = createHasher();
  hasher.update(JSON.stringify({ system, tools: toolsWire }));
  const wire = [];
  const replayed = [];
  for (const msg of out) {
    let blocks = msg.blocks;
    if (msg.role === 'assistant' && msg.replay && !stripThinking) {
      const digest = hasher.digest();
      if (msg.replay.h === digest && !poisoned.has(digest) && toolUseSignature(msg.replay.blocks) === toolUseSignature(blocks)) {
        const visible = blocks;
        blocks = msg.replay.blocks.map((b) => ({ ...b }));
        // A turn whose own text was empty (the agent showed a canned line instead) still needs visible content.
        if (!blocks.some((b) => b.type === 'text' || b.type === 'tool_use')) blocks.push(...visible.filter((b) => b.type === 'text'));
        replayed.push(digest);
      }
    }
    const w = { role: msg.role, content: blocks };
    hasher.update(JSON.stringify(w));
    wire.push(w);
  }
  return { system, wire, prefixHash: hasher.digest(), replayed };
}

/**
 * The Messages API request body for one call. Exported for tests.
 * Cache breakpoints: the last tool (tools never change), the system prompt (fixed within a turn) and the newest
 * block of the conversation (the next step of the same turn reads everything before it).
 */
export function buildAnthropicRequest({
  model = ANTHROPIC.defaultModel, messages, tools, stream = true, maxTokens = ANTHROPIC.defaultMaxTokens, effort = null, fallbacks = null,
  eagerToolStreaming = false, promptCaching = true, stripThinking = false, poisoned,
} = {}) {
  const toolsWire = toAnthropicTools(tools, { eager: eagerToolStreaming });
  const { system, wire, prefixHash, replayed } = buildConversation(messages, { toolsWire, stripThinking, poisoned });
  const body = { model, max_tokens: maxTokens };
  if (system) body.system = [promptCaching ? { type: 'text', text: system, cache_control: EPHEMERAL } : { type: 'text', text: system }];
  if (toolsWire.length) body.tools = promptCaching ? toolsWire.map((t, i) => (i === toolsWire.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)) : toolsWire;
  if (promptCaching) {
    const last = wire.at(-1);
    const blocks = [...last.content];
    blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: EPHEMERAL };
    wire[wire.length - 1] = { ...last, content: blocks };
  }
  body.messages = wire;
  if (effort) body.output_config = { effort };
  if (fallbacks) body.fallbacks = fallbacks;
  if (stream) body.stream = true;
  return { body, meta: { prefixHash, replayed } };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const BILLING_RE = /credit balance|billing|payment required|insufficient (credit|funds)|purchase credits/i;
const CONTEXT_RE = /prompt is too long|context (window|length)|too many (input )?tokens|exceeds? the (maximum|context)|input length/i;
const SIGNATURE_RE = /signature[\s\S]{0,60}thinking|thinking[\s\S]{0,60}signature|bound to a different conversation|block_binding|redacted_thinking/i;
const FALLBACK_RE = /fallbacks?\b|server-side-fallback|anthropic-beta/i;

function errorInfo(body) {
  if (body == null) return { type: '', message: '' };
  if (typeof body === 'string') return { type: '', message: body.slice(0, 500) };
  const e = isPlainObject(body.error) ? body.error : body;
  const message = typeof body.error === 'string' ? body.error : e.message ?? body.message ?? '';
  return { type: String(e.type && e.type !== 'error' ? e.type : ''), message: String(message).slice(0, 500) };
}

/**
 * HTTP status + Anthropic error body → LlmError. status 200 = an `error` event inside the stream.
 * `reason` thinking_signature / fallbacks_rejected mark the two 400s the adapter repairs on its own.
 */
export function classifyAnthropicError(status, body, headers) {
  const info = errorInfo(body);
  const t = info.type;
  let code;
  let reason = '';
  if (t === 'billing_error' || status === 402 || BILLING_RE.test(info.message)) code = 'billing';
  else if (status === 401 || status === 403 || t === 'authentication_error' || t === 'permission_error') code = 'auth';
  else if (status === 429 || t === 'rate_limit_error') code = 'rate_limit';
  else if (status === 404 || t === 'not_found_error') {
    code = 'bad_request';
    reason = 'model_not_found';
  } else if (status === 413 || t === 'request_too_large') {
    code = 'bad_request';
    reason = 'context_length';
  } else if (status === 408 || status === 504 || t === 'timeout_error') code = 'timeout';
  else if (status === 529 || status === 409 || status >= 500 || t === 'overloaded_error' || t === 'api_error') code = 'unavailable';
  else if (status >= 400 || t === 'invalid_request_error') {
    code = 'bad_request';
    if (CONTEXT_RE.test(info.message)) reason = 'context_length';
    else if (SIGNATURE_RE.test(info.message)) reason = 'thinking_signature';
    else if (FALLBACK_RE.test(info.message)) reason = 'fallbacks_rejected';
  } else code = 'unavailable';

  let retryable = isRetryableCode(code);
  const shouldRetry = shouldRetryHeader(headers);
  if (shouldRetry === 'true' && code !== 'billing' && code !== 'content_filter') retryable = true;
  if (shouldRetry === 'false') retryable = false;
  return new LlmError(code, {
    status,
    providerCode: t,
    reason,
    retryable,
    retryAfterMs: parseRetryAfter(headers),
    requestId: typeof body?.request_id === 'string' ? body.request_id : '',
    message: `Anthropic ${status || ''} ${t} ${info.message}`.replace(/\s+/g, ' ').trim(),
  });
}

// ---------------------------------------------------------------------------
// Response accumulation
// ---------------------------------------------------------------------------

function newAccumulator() {
  return { text: '', blocks: [], byIndex: new Map(), prevType: '', stop: null, stopDetails: null, usage: null, model: '', sawStop: false, fallbackAt: -1 };
}

function appendText(acc, block, text, emit) {
  if (!text) return;
  // A text block after thinking or a tool call is a new paragraph on screen.
  const piece = !block.text && block.sep && acc.text && !/\s$/.test(acc.text) ? `\n\n${text}` : text;
  block.text += text;
  acc.text += piece;
  emit(piece);
}

function startBlock(acc, index, raw, emit) {
  const b = isPlainObject(raw) ? raw : {};
  let block;
  if (b.type === 'text') {
    block = { type: 'text', text: '', sep: ['thinking', 'redacted_thinking', 'tool_use'].includes(acc.prevType) };
  } else if (b.type === 'thinking') {
    block = { type: 'thinking', thinking: typeof b.thinking === 'string' ? b.thinking : '', signature: typeof b.signature === 'string' ? b.signature : '' };
  } else if (b.type === 'redacted_thinking') {
    block = { type: 'redacted_thinking', data: typeof b.data === 'string' ? b.data : '' };
  } else if (b.type === 'tool_use') {
    block = { type: 'tool_use', id: nonBlank(b.id), name: nonBlank(b.name), input: isPlainObject(b.input) ? b.input : {}, json: '', jsonSeen: false, invalid: false };
  } else if (b.type === 'fallback') {
    // A refusal fallback switched models here: tool calls and thinking before it belong to the declined attempt.
    acc.fallbackAt = acc.blocks.length;
    block = { type: 'fallback' };
  } else {
    block = { type: String(b.type || 'unknown') };
  }
  acc.blocks.push(block);
  if (Number.isInteger(index)) acc.byIndex.set(index, block);
  if (block.type !== 'fallback') acc.prevType = block.type;
  if (block.type === 'text' && typeof b.text === 'string') appendText(acc, block, b.text, emit);
  return block;
}

function applyDelta(acc, index, delta, emit) {
  const block = acc.byIndex.get(index);
  if (!block || !isPlainObject(delta)) return;
  if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') appendText(acc, block, delta.text, emit);
  else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') block.thinking += delta.thinking;
  else if (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string') block.signature += delta.signature;
  else if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') {
    block.json += delta.partial_json;
    block.jsonSeen = true;
  }
}

function finishToolBlock(block) {
  if (block.type !== 'tool_use' || block.done) return;
  block.done = true;
  if (!block.jsonSeen) return;
  // Strict: a cut-off or malformed input is flagged, never half-run (tolerant partial parsing would hide it).
  const parsed = parseToolArguments(block.json);
  if (parsed === undefined) {
    block.invalid = true;
    block.input = {};
  } else {
    block.input = parsed;
  }
}

function mergeUsage(acc, usage) {
  if (isPlainObject(usage)) acc.usage = { ...(acc.usage || {}), ...usage };
}

/** One parsed stream event; true when the message is complete. */
function applyEvent(acc, type, j, emit) {
  switch (type) {
    case 'message_start': {
      const m = isPlainObject(j.message) ? j.message : {};
      if (typeof m.model === 'string') acc.model = m.model;
      mergeUsage(acc, m.usage);
      return false;
    }
    case 'content_block_start':
      startBlock(acc, j.index, j.content_block, emit);
      return false;
    case 'content_block_delta':
      applyDelta(acc, j.index, j.delta, emit);
      return false;
    case 'content_block_stop': {
      const block = acc.byIndex.get(j.index);
      if (block) finishToolBlock(block);
      return false;
    }
    case 'message_delta': {
      const d = isPlainObject(j.delta) ? j.delta : {};
      if (typeof d.stop_reason === 'string') acc.stop = d.stop_reason;
      if (d.stop_details !== undefined) acc.stopDetails = d.stop_details;
      else if (j.stop_details !== undefined) acc.stopDetails = j.stop_details;
      mergeUsage(acc, j.usage);
      return false;
    }
    case 'message_stop':
      acc.sawStop = true;
      return true;
    default:
      return false; // ping and anything new
  }
}

function isErrorPayload(j) {
  return isPlainObject(j) && (j.type === 'error' || isPlainObject(j.error));
}

function fromMessage(json, emit) {
  const acc = newAccumulator();
  acc.sawStop = true;
  if (typeof json.model === 'string') acc.model = json.model;
  mergeUsage(acc, json.usage);
  acc.stop = typeof json.stop_reason === 'string' ? json.stop_reason : null;
  acc.stopDetails = json.stop_details ?? null;
  const content = Array.isArray(json.content) ? json.content : [];
  content.forEach((b, i) => {
    const block = startBlock(acc, i, b, emit);
    if (block.type === 'thinking' && typeof b.signature === 'string') block.signature = b.signature;
    if (block.type === 'tool_use') block.done = true;
  });
  return acc;
}

function refusalCategory(details) {
  return isPlainObject(details) && typeof details.category === 'string' ? details.category : '';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {{ baseUrl?: string, apiKey: string, model?: string, effort?: string|null, maxTokens?: number,
 *           fallbacks?: 'default'|null|false, eagerToolStreaming?: boolean, promptCaching?: boolean, genId: () => string }} opts
 *   eagerToolStreaming defaults to on for api.anthropic.com and off behind a custom base URL (a gateway may reject it);
 *   fallbacks ('default') is sent only to api.anthropic.com and only for the models that accept it.
 */
export function createAnthropicAdapter({
  baseUrl = ANTHROPIC.baseUrl, apiKey, model = ANTHROPIC.defaultModel, effort = ANTHROPIC.defaultEffort, maxTokens,
  fallbacks = 'default', eagerToolStreaming, promptCaching = true, genId,
} = {}) {
  const root = String(baseUrl || ANTHROPIC.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = `${root}${ANTHROPIC.messagesPath}`;
  const official = /(^|\.)anthropic\.com$/i.test(hostOf(root));
  const eager = eagerToolStreaming ?? official;
  const effortValue = supportsEffort(model) ? normalizeEffort(effort) : null;
  const defaultLimit = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : ANTHROPIC.defaultMaxTokens;
  const shared = {
    fallbacksOff: !fallbacks || !official || !supportsServerFallback(model),
    // Prefix hashes whose thinking blocks the API refused once: never replayed again by this client.
    poisoned: new Set(),
  };
  const fallbackValue = typeof fallbacks === 'string' && fallbacks ? fallbacks : 'default';

  function headersFor(stream, withFallbacks) {
    const h = {
      [ANTHROPIC.apiKeyHeader]: apiKey,
      'anthropic-version': ANTHROPIC.version,
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (withFallbacks) h['anthropic-beta'] = ANTHROPIC.fallbackBeta;
    return h;
  }

  function consumeEvents(acc, events, emit) {
    for (const ev of events) {
      const raw = ev.data.trim();
      if (!raw) continue;
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isPlainObject(j)) continue;
      const type = typeof j.type === 'string' ? j.type : ev.event;
      if (type === 'error' || ev.event === 'error') throw classifyAnthropicError(200, j);
      if (applyEvent(acc, type, j, emit)) return true;
    }
    return false;
  }

  function decide({ acc, streamed }, { maxTokens: limit } = {}) {
    if (acc.stop === 'refusal') {
      const cat = refusalCategory(acc.stopDetails);
      throw new LlmError('content_filter', { status: 200, retryable: false, providerCode: cat ? `refusal:${cat}` : 'refusal', message: `stop_reason refusal${cat ? ` (${cat})` : ''}` });
    }
    // Without message_stop or a stop reason the stream was cut off: retried before any text reached the user.
    if (streamed && !acc.sawStop && !acc.stop) {
      throw new LlmError('network', { message: 'Anthropic stream ended before message_stop', retryable: true });
    }
    if (acc.stop === 'model_context_window_exceeded') {
      throw new LlmError('bad_request', { status: 200, reason: 'context_length', providerCode: acc.stop, message: `stop_reason ${acc.stop}` });
    }
    const calls = [];
    const used = new Set();
    let bad = 0;
    acc.blocks.forEach((block, i) => {
      if (block.type !== 'tool_use' || i < acc.fallbackAt) return;
      finishToolBlock(block);
      if (!block.name) {
        bad++;
        return;
      }
      let id = block.id && !used.has(block.id) ? block.id : genId();
      while (used.has(id)) id = genId();
      used.add(id);
      block.finalId = id;
      if (block.invalid) {
        bad++;
        calls.push({ id, name: block.name, arguments: '{}', invalidArguments: true });
      } else {
        calls.push({ id, name: block.name, arguments: JSON.stringify(block.input) });
      }
    });
    const missingCalls = acc.stop === 'tool_use' && !calls.length && !acc.text.trim();
    const cut = acc.stop === 'max_tokens' && bad > 0;
    const used0 = limit ?? defaultLimit;
    return {
      acc,
      calls,
      bad,
      needsFallback: streamed && (bad > 0 || missingCalls),
      // Cut off by max_tokens: stream again with room; malformed input: once without streaming (validated server-side).
      fallbackStream: cut,
      fallbackMaxTokens: cut ? Math.min(ANTHROPIC.maxRetryTokens, Math.max(32000, 2 * used0)) : limit,
    };
  }

  function toResult({ acc, calls }, meta = {}) {
    const result = {
      content: acc.text,
      toolCalls: calls,
      finishReason: calls.length ? 'tool_calls' : STOP_TO_FINISH[acc.stop] || 'stop',
      usage: acc.usage || null,
    };
    if (acc.model) result.model = acc.model;
    // What goes back on the next request: tool calls and thinking from before a fallback boundary are dropped.
    const replay = [];
    acc.blocks.forEach((b, i) => {
      const beforeFallback = i < acc.fallbackAt;
      if (b.type === 'text' && b.text) replay.push({ type: 'text', text: b.text });
      else if (beforeFallback) return;
      else if (b.type === 'thinking' && b.signature) replay.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
      else if (b.type === 'redacted_thinking' && b.data) replay.push({ type: 'redacted_thinking', data: b.data });
      else if (b.type === 'tool_use' && b.finalId) replay.push({ type: 'tool_use', id: b.finalId, name: b.name, input: b.invalid ? {} : b.input });
    });
    if (meta.prefixHash && replay.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
      const enc = encodeReplay(meta.prefixHash, replay);
      if (enc) result.encryptedContent = enc;
    }
    return result;
  }

  return {
    kind: 'anthropic',
    model,
    secrets: [apiKey],
    newCallState: () => ({ stripThinking: false, fallbacks: !shared.fallbacksOff, replayed: [] }),
    buildRequest({ messages, tools, stream, maxTokens: limit, state = {} }) {
      const withFallbacks = Boolean(state.fallbacks) && !shared.fallbacksOff;
      const { body, meta } = buildAnthropicRequest({
        model,
        messages,
        tools,
        stream,
        maxTokens: limit ?? defaultLimit,
        effort: effortValue,
        fallbacks: withFallbacks ? fallbackValue : null,
        eagerToolStreaming: eager,
        promptCaching,
        stripThinking: Boolean(state.stripThinking),
        poisoned: shared.poisoned,
      });
      state.replayed = meta.replayed;
      return { url, headers: headersFor(stream, withFallbacks), body, meta };
    },
    newAccumulator,
    consumeEvents,
    fromJson: fromMessage,
    isErrorPayload,
    classifyError: classifyAnthropicError,
    decide,
    toResult,
    recover(err, state) {
      if (err?.reason === 'thinking_signature' && !state.stripThinking) {
        for (const h of state.replayed || []) {
          if (shared.poisoned.size >= MAX_POISONED) shared.poisoned.clear();
          shared.poisoned.add(h);
        }
        state.stripThinking = true;
        return true;
      }
      if (err?.reason === 'fallbacks_rejected' && state.fallbacks) {
        state.fallbacks = false;
        shared.fallbacksOff = true;
        return true;
      }
      return false;
    },
  };
}
