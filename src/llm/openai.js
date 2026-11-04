import {
  LlmError, isPlainObject, nonBlank, parseToolArguments, parseEventData, parseRetryAfter, shouldRetryHeader, isRetryableCode, cloneJson,
} from './core.js';

/**
 * OpenAI Chat Completions adapter (`POST {baseUrl}/chat/completions`, Bearer auth, SSE streaming).
 * The stream reader tolerates the deviations OpenAI-compatible gateways are known for (repeated ids, missing
 * indexes, arguments before the name, several JSON chunks per event, plain JSON bodies labelled as SSE),
 * so LLM_BASE_URL can also point at a proxy in front of OpenAI.
 *
 * VERIFY (OpenAI, checked against the public API reference as of 2025; re-check if requests start failing):
 * - reasoning models (gpt-5*, o1/o3/o4*) reject `temperature` and take `reasoning_effort` (minimal|low|medium|high);
 * - `max_completion_tokens` replaces the deprecated `max_tokens` on api.openai.com;
 * - errors are { error: { message, type, code } }; 429 `insufficient_quota` means billing, not a rate limit.
 */

export const DEFAULT_TEMPERATURE = 0.3;
const REASONING_MODEL_RE = /^(o\d|gpt-5)/i;
const OPENAI_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

/** True for models that reject sampling parameters and take reasoning_effort instead. */
export function isReasoningModel(model) {
  return REASONING_MODEL_RE.test(String(model || '').replace(/^.*\//, ''));
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const CONTENT_RE = /content[_ ]?filter|content[_ ]?policy|content_policy_violation|safety system|data_?inspection_?failed|sensitive_?content|inappropriate content|unsafe content|content[_ ]?exists[_ ]?risk/i;
const BILLING_RE = /insufficient_quota|exceeded (your|the) current quota|billing_?(hard_)?limit|billing|payment required|credit balance|insufficient_?balance|account_?overdue|quota_?exceeded|arrearage/i;
const AUTH_RE = /invalid_?api_?key|incorrect_api_key|invalid_authentication|authentication|unauthori[sz]ed|permission_denied|access_?denied|api key/i;
const RATE_RE = /rate_?limit|throttl|too many requests|request_?burst/i;
// "Model Not Exist" is what some OpenAI-compatible gateways answer for an unknown model id.
const NOT_FOUND_RE = /not_?found|does not exist|model not exist|no such model/i;
const TIMEOUT_RE = /time_?d?\s?out|timeout/i;
const OVERLOAD_RE = /overload|internal_?(server_?)?error|internal_?service|server_?error|service_?unavailable|bad gateway/i;
const CONTEXT_RE = /context|too long|maximum.{0,20}tokens|token.{0,10}limit|string_above_max_length/i;

function isClientError(status) {
  return status >= 400 && status < 500;
}

function errorInfo(body) {
  if (body == null) return { code: '', type: '', message: '' };
  if (typeof body === 'string') return { code: '', type: '', message: body.slice(0, 500) };
  const e = body.error && typeof body.error === 'object' ? body.error : body;
  const detail = typeof body.detail === 'string' ? body.detail : undefined;
  const msg = typeof body.error === 'string' ? body.error : e.message ?? e.msg ?? body.message ?? body.msg ?? detail ?? '';
  return { code: String(e.code ?? ''), type: String(e.type ?? ''), message: String(msg).slice(0, 500) };
}

/**
 * Maps an HTTP status + OpenAI-style error body to an LlmError. status 200 = error delivered inside the stream.
 * @returns {LlmError}
 */
export function classifyProviderError(status, body, headers) {
  const info = errorInfo(body);
  const hay = `${info.code} ${info.type} ${info.message}`;
  const providerCode = info.code || info.type;
  let code;
  let reason = '';
  if (CONTENT_RE.test(hay)) code = 'content_filter';
  else if (status === 402 || BILLING_RE.test(hay)) code = 'billing';
  else if (status === 401 || status === 403 || (status < 500 && AUTH_RE.test(hay))) code = 'auth';
  else if (status === 429 || RATE_RE.test(hay)) code = 'rate_limit';
  else if (status === 404 || (status >= 400 && status < 500 && NOT_FOUND_RE.test(hay))) {
    code = 'bad_request';
    reason = 'model_not_found';
  } else if (status === 408 || (!isClientError(status) && TIMEOUT_RE.test(hay))) code = 'timeout';
  else if (status === 409 || status >= 500 || (!isClientError(status) && OVERLOAD_RE.test(hay))) code = 'unavailable';
  else if (status >= 400) {
    code = 'bad_request';
    if (CONTEXT_RE.test(hay)) reason = 'context_length';
  } else code = 'unavailable';

  let retryable = isRetryableCode(code);
  const shouldRetry = shouldRetryHeader(headers);
  if (shouldRetry === 'true' && code !== 'billing' && code !== 'content_filter') retryable = true;
  if (shouldRetry === 'false') retryable = false;
  return new LlmError(code, {
    status,
    providerCode,
    reason,
    retryable,
    retryAfterMs: parseRetryAfter(headers),
    message: `LLM ${status || ''} ${providerCode} ${info.message}`.replace(/\s+/g, ' ').trim(),
  });
}

// ---------------------------------------------------------------------------
// Tool-call accumulator
// ---------------------------------------------------------------------------

function newAccumulator() {
  return { text: '', reasoning: '', slots: [], byIdx: new Map(), byId: new Map(), finish: null, usage: null, sawDone: false };
}

function addToolDelta(acc, t, pos) {
  if (!isPlainObject(t)) return;
  const fn = isPlainObject(t.function) ? t.function : {};
  const id = nonBlank(t.id);
  const name = nonBlank(fn.name);
  const args = typeof fn.arguments === 'string' ? fn.arguments : isPlainObject(fn.arguments) ? JSON.stringify(fn.arguments) : '';
  const idx = Number.isInteger(t.index) && t.index >= 0 ? t.index : null;
  if (!id && !name && !args) return; // placeholder chunk

  let slot = id ? acc.byId.get(id) : undefined;
  if (!slot && idx !== null) {
    const cur = acc.byIdx.get(idx);
    // A reused index starts a new call when it brings a different id, or a different name.
    if (cur && !(id && cur.id && id !== cur.id) && !(name && cur.name && name !== cur.name)) slot = cur;
  }
  if (!slot && idx === null) {
    const last = acc.slots.at(-1);
    if (last && !id && !name) slot = last; // index-less continuation
    else if (last && !last.id && !last.name) slot = last; // arguments arrived before id/name
  }
  if (!slot) {
    slot = { id: null, name: null, args: '', index: idx ?? pos, seq: acc.slots.length };
    acc.slots.push(slot);
  }
  if (idx !== null) acc.byIdx.set(idx, slot);
  // id and name are set once and never concatenated (some gateways repeat the id on every chunk).
  if (id && !slot.id) {
    slot.id = id;
    acc.byId.set(id, slot);
  }
  if (name && !slot.name) slot.name = name;
  if (args) slot.args += args;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

function applyChunk(acc, j, emit) {
  if (isPlainObject(j.usage)) acc.usage = j.usage;
  const choices = Array.isArray(j.choices) ? j.choices : [];
  const ch = choices.find((c) => (c?.index ?? 0) === 0) ?? choices[0];
  if (!isPlainObject(ch)) return;
  if (isPlainObject(ch.usage)) acc.usage = ch.usage;
  const d = isPlainObject(ch.delta) ? ch.delta : isPlainObject(ch.message) ? ch.message : {};
  // Some OpenAI-compatible gateways stream hidden reasoning here; it is kept, never shown.
  if (typeof d.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
  const text = contentText(d.content);
  if (text) {
    acc.text += text;
    emit(text);
  }
  if (Array.isArray(d.tool_calls)) d.tool_calls.forEach((t, pos) => addToolDelta(acc, t, pos));
  if (isPlainObject(d.function_call)) addToolDelta(acc, { index: 0, function: d.function_call }, 0);
  // finish_reason may share a chunk with the last delta, so it is read after the delta.
  if (ch.finish_reason) acc.finish = ch.finish_reason;
}

function finalizeCalls(acc, genId) {
  const calls = [];
  const used = new Set();
  let bad = 0;
  const slots = [...acc.slots].sort((a, b) => a.index - b.index || a.seq - b.seq);
  for (const s of slots) {
    if (!s.name) {
      if (s.args.trim()) bad++;
      continue;
    }
    let id = s.id && !used.has(s.id) ? s.id : genId();
    while (used.has(id)) id = genId();
    used.add(id);
    const parsed = parseToolArguments(s.args);
    if (parsed === undefined) {
      bad++;
      calls.push({ id, name: s.name, arguments: '{}', invalidArguments: true });
    } else {
      calls.push({ id, name: s.name, arguments: JSON.stringify(parsed) });
    }
  }
  return { calls, bad };
}

function fromCompletion(json, emit) {
  const acc = newAccumulator();
  acc.sawDone = true;
  if (isPlainObject(json.usage)) acc.usage = json.usage;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const ch = choices.find((c) => (c?.index ?? 0) === 0) ?? choices[0];
  if (!isPlainObject(ch)) throw new LlmError('unavailable', { status: 200, message: 'LLM response has no choices' });
  const m = isPlainObject(ch.message) ? ch.message : isPlainObject(ch.delta) ? ch.delta : {};
  if (typeof m.reasoning_content === 'string') acc.reasoning = m.reasoning_content;
  acc.text = contentText(m.content);
  if (acc.text) emit(acc.text);
  if (Array.isArray(m.tool_calls)) m.tool_calls.forEach((t, pos) => addToolDelta(acc, { ...t, index: pos }, pos));
  else if (isPlainObject(m.function_call)) addToolDelta(acc, { index: 0, function: m.function_call }, 0);
  acc.finish = ch.finish_reason ?? null;
  return acc;
}

function isErrorPayload(j) {
  return isPlainObject(j) && (j.error != null || (!Array.isArray(j.choices) && j.code !== undefined && (j.message || j.msg)));
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function argString(a) {
  if (typeof a === 'string') return a;
  return JSON.stringify(a ?? {});
}

function toWireMessage(m) {
  if (m.role === 'assistant') {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(Boolean) : [];
    const out = { role: 'assistant', content: calls.length ? m.content || null : m.content ?? '' };
    if (calls.length) {
      out.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function?.name ?? c.name, arguments: argString(c.function?.arguments ?? c.arguments) },
      }));
    }
    // reasoning_content / encrypted_content (other providers' replay data) are never sent: OpenAI rejects unknown fields.
    return out;
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: String(m.tool_call_id ?? ''), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null) };
  }
  const content = typeof m.content === 'string' || Array.isArray(m.content) ? m.content : String(m.content ?? '');
  return { role: m.role, content };
}

function effortFor(effort) {
  const e = String(effort || '').toLowerCase();
  if (OPENAI_EFFORTS.has(e)) return e;
  if (e === 'xhigh' || e === 'max') return 'high';
  return '';
}

/**
 * Builds the Chat Completions request body. Exported for tests.
 * @param {{ model: string, messages: object[], tools?: object[], temperature?: number, effort?: string, thinking?: boolean,
 *           stream: boolean, maxTokens?: number, extraBody?: object, tokenParam?: 'max_completion_tokens'|'max_tokens' }} o
 */
export function buildRequestBody({ model, messages, tools, temperature = DEFAULT_TEMPERATURE, effort, thinking = false, stream, maxTokens, extraBody, tokenParam = 'max_completion_tokens' }) {
  const body = { model, messages: [], stream: Boolean(stream) };
  if (stream) body.stream_options = { include_usage: true };
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) body.tools = tools;
  const reasoning = isReasoningModel(model);
  if (!reasoning && Number.isFinite(temperature)) body.temperature = temperature;
  const e = effortFor(effort || (thinking ? 'high' : ''));
  if (reasoning && e) body.reasoning_effort = e;
  if (Number.isInteger(maxTokens) && maxTokens > 0) body[tokenParam] = maxTokens;
  Object.assign(body, cloneJson(extraBody) || {});
  body.messages = (messages || []).filter(Boolean).map(toWireMessage);
  return body;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const CONTENT_FILTER_FINISH = new Set(['content_filter']);
const TOOL_FINISH = new Set(['tool_calls', 'function_call']);

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, temperature?: number, effort?: string, thinking?: boolean,
 *           maxTokens?: number, extraBody?: object, genId: () => string }} opts
 */
export function createOpenAiAdapter({ baseUrl, apiKey, model, temperature = DEFAULT_TEMPERATURE, effort, thinking = false, maxTokens, extraBody, genId }) {
  const root = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  let host = '';
  try {
    host = new URL(root).hostname;
  } catch {
    host = '';
  }
  // Gateways in front of other models usually still expect max_tokens.
  const tokenParam = /(^|\.)openai\.com$/i.test(host) ? 'max_completion_tokens' : 'max_tokens';

  function consumeEvents(acc, events, emit) {
    for (const ev of events) {
      const raw = ev.data.trim();
      if (!raw) continue;
      if (raw === '[DONE]') {
        acc.sawDone = true;
        return true;
      }
      const payloads = parseEventData(raw);
      if (ev.event === 'error') throw classifyProviderError(200, payloads[0] ?? raw);
      for (const j of payloads) {
        if (isErrorPayload(j)) throw classifyProviderError(200, j);
        applyChunk(acc, j, emit);
      }
    }
    return false;
  }

  /** Decision table after the response ended. */
  function decide({ acc, streamed }, { maxTokens: limit } = {}) {
    const finish = acc.finish;
    if (CONTENT_FILTER_FINISH.has(finish)) {
      throw new LlmError('content_filter', { status: 200, providerCode: finish, message: `finish_reason ${finish}` });
    }
    // A stream that ends without finish_reason or [DONE] was cut off, even if it ended cleanly:
    // its text is incomplete and its parallel calls may be missing. Before any text reached the
    // user this is retried; after, the agent reports the interruption.
    if (streamed && !finish && !acc.sawDone) {
      throw new LlmError('network', { message: 'LLM stream ended before finish_reason', retryable: true });
    }
    const { calls, bad } = finalizeCalls(acc, genId);
    const missingCalls = TOOL_FINISH.has(finish) && !calls.length && !acc.text.trim();
    // Arguments cut off by the token limit would be cut off again with the same limit.
    const fallbackMaxTokens = finish === 'length' && bad > 0 ? Math.max(8192, 2 * (limit ?? maxTokens ?? 0)) : limit;
    return { acc, calls, bad, needsFallback: streamed && (bad > 0 || missingCalls), fallbackStream: false, fallbackMaxTokens };
  }

  function toResult({ acc, calls }) {
    const result = {
      content: acc.text,
      toolCalls: calls,
      finishReason: calls.length ? 'tool_calls' : acc.finish || 'stop',
      usage: acc.usage || null,
    };
    if (acc.reasoning) result.reasoningContent = acc.reasoning;
    return result;
  }

  return {
    kind: 'openai',
    model,
    secrets: [apiKey],
    buildRequest({ messages, tools, stream, maxTokens: limit }) {
      return {
        url,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: buildRequestBody({ model, messages, tools, temperature, effort, thinking, stream, maxTokens: limit, extraBody, tokenParam }),
      };
    },
    newAccumulator,
    consumeEvents,
    fromJson: fromCompletion,
    isErrorPayload,
    classifyError: classifyProviderError,
    decide,
    toResult,
  };
}
