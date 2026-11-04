import { randomUUID } from 'node:crypto';
import { PROVIDERS, DEFAULT_TEMPERATURE, normalizeProvider, inferProvider } from './providers.js';

/**
 * OpenAI-compatible chat-completions client for domestic providers (DeepSeek, Qwen, Kimi, GLM, Doubao).
 * Implements RESEARCH-llm.md §3–5: lenient SSE reader, a tool-call accumulator that survives every known
 * provider deviation, a post-stream decision table, retries only before any text reached the user, and
 * error classification into LlmError codes with Chinese user-facing messages.
 */

export const LLM_ERROR_MESSAGES = Object.freeze({
  auth: 'AI 服务的密钥无效或没有权限，请检查 .env 里的 API Key 配置。',
  billing: 'AI 服务账户余额不足或已欠费，请充值后再试。',
  rate_limit: '现在找我的人有点多，请稍等几秒再发一次。',
  content_filter: '抱歉，这个话题我没法继续聊。我们换个话题吧，行程和酒店的事随时找我；如果一直这样，请在右上角「⋯」里点「新对话」重新开始。',
  bad_request: 'AI 服务拒绝了这次请求，请换个说法再试，或在右上角「⋯」里点「新对话」重新开始。',
  timeout: 'AI 服务响应超时了，请稍后再试。',
  unavailable: 'AI 服务暂时不可用，请稍后再试。',
  network: '连接 AI 服务失败，请检查网络后重试。',
});

const REASON_MESSAGES = Object.freeze({
  context_length: '这段对话太长了，请在右上角「⋯」里点「新对话」重新开始。',
  model_not_found: '找不到配置的模型或接口地址，请检查 LLM_MODEL / LLM_BASE_URL 配置。',
});

const RETRYABLE_CODES = new Set(['rate_limit', 'timeout', 'unavailable', 'network']);

export class LlmError extends Error {
  /**
   * @param {'auth'|'billing'|'rate_limit'|'content_filter'|'bad_request'|'timeout'|'unavailable'|'network'} code
   * @param {{ status?: number, message?: string, userMessage?: string, retryable?: boolean, retryAfterMs?: number|null,
   *           providerCode?: string, reason?: string, cause?: unknown }} [opts]
   */
  constructor(code, { status = 0, message, userMessage, retryable, retryAfterMs = null, providerCode = '', reason = '', cause } = {}) {
    super(message || `LLM error: ${code}`, cause ? { cause } : undefined);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    this.reason = reason || '';
    this.userMessage = userMessage || REASON_MESSAGES[reason] || LLM_ERROR_MESSAGES[code] || LLM_ERROR_MESSAGES.unavailable;
    this.retryable = retryable ?? RETRYABLE_CODES.has(code);
    this.retryAfterMs = retryAfterMs;
    this.providerCode = providerCode;
  }
}

// ---------------------------------------------------------------------------
// Error classification (RESEARCH-llm.md §4)
// ---------------------------------------------------------------------------

const CONTENT_RE = /data_?inspection_?failed|sensitive_?content|content[_ ]?filter|content[_ ]?policy|risk_?detection|inappropriate content|unsafe content|content[_ ]?exists[_ ]?risk|内容安全|敏感内容/i;
const BILLING_RE = /arrearage|exceeded_current_quota|insufficient_quota|insufficient_?balance|account_?overdue|quota_?exceeded|set_?limit_?exceeded|invalid_?subscription|payment required|余额不足|欠费|账户.*(异常|冻结)/i;
const AUTH_RE = /invalid_?api_?key|incorrect_api_key|invalid_authentication|authentication|unauthori[sz]ed|permission_denied|access_?denied|api key|鉴权|身份验证/i;
const RATE_RE = /rate_?limit|throttl|too many requests|request_?burst|并发|频率/i;
// DeepSeek answers an unknown model id with 400 "Model Not Exist".
const NOT_FOUND_RE = /not_?found|does not exist|model not exist|no such model|不存在/i;
const TIMEOUT_RE = /time_?d?\s?out|timeout|超时/i;
const OVERLOAD_RE = /overload|insufficient_system_resource|internal_?(server_?)?error|internal_?service|server_?error|service_?unavailable|bad gateway|繁忙/i;
const CONTEXT_RE = /context|max_completion=0|too long|maximum.{0,20}tokens|token.{0,10}limit|超长|超过.{0,10}长度/i;
const GLM_CONTENT = new Set(['1301']);
const GLM_BILLING = new Set(['1113', '1304', '1308', '1310']);
const GLM_AUTH = new Set(['1000', '1001', '1002', '1003', '1004']);
const GLM_RATE = new Set(['1302', '1303', '1305', '1312']);
const GLM_CONTEXT = new Set(['1261']);

function isClientError(status) {
  return status >= 400 && status < 500;
}

function errorInfo(body) {
  if (body == null) return { code: '', type: '', message: '' };
  if (typeof body === 'string') return { code: '', type: '', message: body.slice(0, 500) };
  const e = body.error && typeof body.error === 'object' ? body.error : body;
  // DeepSeek's older content-safety body is { detail: 'Content Exists Risk' }.
  const detail = typeof body.detail === 'string' ? body.detail : undefined;
  const msg = typeof body.error === 'string' ? body.error : e.message ?? e.msg ?? body.message ?? body.msg ?? detail ?? '';
  return { code: String(e.code ?? ''), type: String(e.type ?? ''), message: String(msg).slice(0, 500) };
}

/** Milliseconds from retry-after-ms / retry-after (seconds or HTTP date); null when absent. */
export function parseRetryAfter(headers, now = Date.now()) {
  const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers?.[k]) ?? null;
  const ms = Number(get('retry-after-ms'));
  if (get('retry-after-ms') !== null && Number.isFinite(ms)) return ms;
  const ra = get('retry-after');
  if (ra === null || ra === '') return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(ra);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * Maps an HTTP status + provider error body to an LlmError. status 200 = error delivered inside the stream.
 * @returns {LlmError}
 */
export function classifyProviderError(status, body, headers) {
  const info = errorInfo(body);
  const hay = `${info.code} ${info.type} ${info.message}`;
  const providerCode = info.code || info.type;
  let code;
  let reason = '';
  if (GLM_CONTENT.has(info.code) || CONTENT_RE.test(hay)) code = 'content_filter';
  else if (status === 402 || GLM_BILLING.has(info.code) || BILLING_RE.test(hay)) code = 'billing';
  else if (status === 401 || status === 403 || GLM_AUTH.has(info.code) || (status < 500 && AUTH_RE.test(hay))) code = 'auth';
  else if (status === 429 || GLM_RATE.has(info.code) || RATE_RE.test(hay)) code = 'rate_limit';
  else if (status === 404 || (status >= 400 && status < 500 && NOT_FOUND_RE.test(hay))) {
    code = 'bad_request';
    reason = 'model_not_found';
  } else if (status === 408 || (!isClientError(status) && TIMEOUT_RE.test(hay))) code = 'timeout';
  else if (status === 409 || status >= 500 || (!isClientError(status) && OVERLOAD_RE.test(hay))) code = 'unavailable';
  else if (status >= 400) {
    code = 'bad_request';
    if (GLM_CONTEXT.has(info.code) || CONTEXT_RE.test(hay)) reason = 'context_length';
  } else code = 'unavailable';

  let retryable = RETRYABLE_CODES.has(code);
  const shouldRetry = headers && typeof headers.get === 'function' ? headers.get('x-should-retry') : null;
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

/** retry-after (when 0–60 s, capped at 20 s), else 0.5·2^n s capped at 8 s, minus up to 25% jitter. */
export function retryDelayMs(err, attempt, random = Math.random) {
  const hinted = err?.retryAfterMs;
  if (Number.isFinite(hinted) && hinted >= 0 && hinted <= 60000) return Math.min(hinted, 20000);
  const base = Math.min(500 * 2 ** attempt, 8000);
  return Math.round(base * (1 - 0.25 * random()));
}

function toLlmError(err) {
  if (err instanceof LlmError) return err;
  if (err?.name === 'TimeoutError') return new LlmError('timeout', { message: err.message, cause: err });
  return new LlmError('network', { message: `LLM network error: ${err?.message || err}`, cause: err });
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

// ---------------------------------------------------------------------------
// SSE reader (RESEARCH-llm.md §3.1)
// ---------------------------------------------------------------------------

/**
 * Incremental SSE parser: tolerant of `data:` without a space, CRLF, `:` comments (keep-alive),
 * `event:` names and a final event without a trailing blank line.
 * @returns {{ push(text: string): Array<{ event: string, data: string }>, end(): Array<{ event: string, data: string }> }}
 */
export function createSseParser() {
  let buf = '';
  let data = [];
  let event = '';
  const out = [];
  const dispatch = () => {
    if (data.length) out.push({ event, data: data.join('\n') });
    data = [];
    event = '';
  };
  const line = (l) => {
    if (l === '') return dispatch();
    if (l[0] === ':') return undefined;
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    let v = c < 0 ? '' : l.slice(c + 1);
    if (v[0] === ' ') v = v.slice(1);
    if (field === 'data') data.push(v);
    else if (field === 'event') event = v.trim();
    return undefined;
  };
  return {
    push(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      return out.splice(0);
    },
    end() {
      if (buf) line(buf.replace(/\r$/, ''));
      buf = '';
      dispatch();
      return out.splice(0);
    },
  };
}

async function* readText(body, signal, onBytes) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  // undici aborts the body itself; this also covers streams that ignore the signal.
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (done) break;
      onBytes();
      const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    finished = true;
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-call accumulator (RESEARCH-llm.md §3.3, §5)
// ---------------------------------------------------------------------------

function nonBlank(s) {
  return typeof s === 'string' && s.trim() !== '' ? s : null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newAccumulator() {
  return { text: '', reasoning: '', encrypted: '', slots: [], byIdx: new Map(), byId: new Map(), finish: null, usage: null, sawDone: false };
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
    if (last && !id && !name) slot = last; // index-less continuation (Moonshot)
    else if (last && !last.id && !last.name) slot = last; // arguments arrived before id/name
  }
  if (!slot) {
    slot = { id: null, name: null, args: '', index: idx ?? pos, seq: acc.slots.length };
    acc.slots.push(slot);
  }
  if (idx !== null) acc.byIdx.set(idx, slot);
  // id and name are set once and never concatenated (Qwen repeats the id on every chunk).
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
  if (typeof d.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
  if (typeof d.encrypted_content === 'string' && d.encrypted_content) acc.encrypted = d.encrypted_content;
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

/**
 * Parses tool arguments leniently: empty → {}, ```json fences, double-encoded strings, and a payload
 * duplicated back-to-back. Returns undefined when the result is not a JSON object.
 */
export function parseToolArguments(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return {};
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  const attempt = (s) => {
    try {
      let v = JSON.parse(s);
      if (typeof v === 'string') v = JSON.parse(v);
      if (v === null) return {};
      return isPlainObject(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  let v = attempt(t);
  if (v === undefined && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) v = attempt(t.slice(0, t.length / 2));
  return v;
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
  if (typeof m.encrypted_content === 'string') acc.encrypted = m.encrypted_content;
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

function parseEventData(raw) {
  try {
    return [JSON.parse(raw)];
  } catch {
    // Non-compliant proxies sometimes put several JSON chunks into one event, one per line.
    const out = [];
    for (const part of raw.split('\n')) {
      try {
        out.push(JSON.parse(part));
      } catch {
        // skip junk
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Request adaptation (RESEARCH-llm.md §1, §5 adaptRequest)
// ---------------------------------------------------------------------------

const GLM_TOOL_STREAM_RE = /^glm-(4\.[6-9]|[5-9])/i;
const GLM_ALWAYS_THINKS_RE = /^glm-(5\.[3-9]|[6-9])/i;

function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function thinkingIsOn(provider, body, thinking) {
  if (provider === 'qwen') return body.enable_thinking === true;
  if (PROVIDERS[provider]) return body.thinking?.type !== 'disabled';
  return Boolean(thinking);
}

function argString(a) {
  if (typeof a === 'string') return a;
  return JSON.stringify(a ?? {});
}

function toWireMessage(m, { provider, thinkingOn, hasTools }) {
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
    if (provider === 'doubao' && m.encrypted_content) out.encrypted_content = m.encrypted_content;
    // DeepSeek (thinking + tools) wants reasoning on every assistant message, Kimi on tool-call messages;
    // ' ' rather than '' because V4-Pro reportedly rejects the empty string.
    const mustEcho = thinkingOn && (provider === 'deepseek' ? hasTools : provider === 'kimi' ? calls.length > 0 : false);
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) out.reasoning_content = m.reasoning_content;
    else if (mustEcho) out.reasoning_content = ' ';
    return out;
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: String(m.tool_call_id ?? ''), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null) };
  }
  const content = typeof m.content === 'string' || Array.isArray(m.content) ? m.content : String(m.content ?? '');
  return { role: m.role, content };
}

/**
 * Builds the provider-specific request body. Exported for tests.
 * @param {{ provider: string, model: string, messages: object[], tools?: object[], temperature?: number, thinking?: boolean,
 *           stream: boolean, maxTokens?: number, extraBody?: object }} o
 */
export function buildRequestBody({ provider, model, messages, tools, temperature = DEFAULT_TEMPERATURE, thinking = false, stream, maxTokens, extraBody }) {
  const preset = PROVIDERS[provider] || {};
  const body = { model, messages: [], stream: Boolean(stream) };
  // GLM always reports usage in the last chunk and documents no stream_options.
  if (stream && provider !== 'glm') body.stream_options = { include_usage: true };

  const extra = cloneJson(preset.extraBody) || {};
  if (thinking) {
    if (extra.thinking?.type === 'disabled') delete extra.thinking;
    if (extra.enable_thinking === false) extra.enable_thinking = true;
  }
  Object.assign(body, extra, cloneJson(extraBody) || {});

  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) body.tools = tools;
  else delete body.parallel_tool_calls;

  if (provider === 'glm' || preset.noToolChoice) {
    delete body.tool_choice;
    delete body.parallel_tool_calls;
    if (stream && hasTools && preset.toolStream !== false && GLM_TOOL_STREAM_RE.test(model)) body.tool_stream = true;
    if (GLM_ALWAYS_THINKS_RE.test(model) && body.thinking?.type === 'disabled') delete body.thinking;
  }
  // Stream-only thinking models reject non-streaming calls with thinking on.
  if (provider === 'qwen' && !stream) body.enable_thinking = false;
  if (provider === 'deepseek' && body.thinking?.type === 'disabled') delete body.reasoning_effort;

  if (!preset.noTemperature && Number.isFinite(temperature)) {
    body.temperature = provider === 'glm' ? Math.min(0.99, Math.max(0.01, temperature)) : temperature;
  }
  // Reasoning shares the completion budget, so thinking models get a larger default.
  const limit = maxTokens ?? ((thinking && preset.thinkingMaxTokens) || preset.maxTokens);
  if (Number.isInteger(limit) && limit > 0) body.max_tokens = limit;

  const thinkingOn = thinkingIsOn(provider, body, thinking);
  body.messages = (messages || []).filter(Boolean).map((m) => toWireMessage(m, { provider, thinkingOn, hasTools }));
  return body;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const CONTENT_FILTER_FINISH = new Set(['content_filter', 'sensitive']);
const RETRYABLE_FINISH = new Set(['insufficient_system_resource', 'network_error']);
const TOOL_FINISH = new Set(['tool_calls', 'function_call']);
const MAX_ERROR_BODY = 64 * 1024;
const MAX_JSON_BODY = 4 * 1024 * 1024;

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultGenId() {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, provider?: string, temperature?: number, thinking?: boolean,
 *           fetch?: typeof fetch, timeoutMs?: number, totalTimeoutMs?: number, maxRetries?: number, stream?: boolean,
 *           maxTokens?: number, extraBody?: object, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *           random?: () => number, genId?: () => string, onRetry?: (info: { attempt: number, delayMs: number, error: LlmError }) => void }} opts
 */
export function createLlmClient({
  baseUrl,
  apiKey,
  model,
  provider,
  temperature = DEFAULT_TEMPERATURE,
  thinking = false,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
  totalTimeoutMs = 120000,
  maxRetries = 2,
  stream = true,
  maxTokens,
  extraBody,
  sleep = defaultSleep,
  random = Math.random,
  genId = defaultGenId,
  onRetry,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createLlmClient: fetch is required');
  const kind = normalizeProvider(provider) || inferProvider(baseUrl) || 'openai';
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;

  // The idle timer is per attempt (a stalled connection may recover on a retry); the total
  // timeout is one deadline for the whole chat() call, see chat().
  function attemptTimers(parent) {
    const ctrl = new AbortController();
    const fire = () => ctrl.abort(new LlmError('timeout', { message: `LLM idle ${timeoutMs}ms timeout` }));
    let idle = setTimeout(fire, timeoutMs);
    return {
      signal: parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal,
      touch() {
        clearTimeout(idle);
        idle = setTimeout(fire, timeoutMs);
      },
      done() {
        clearTimeout(idle);
      },
    };
  }

  async function readAll(res, signal, touch) {
    if (!res.body) return '';
    let text = '';
    for await (const t of readText(res.body, signal, touch)) {
      text += t;
      if (text.length > MAX_JSON_BODY) break;
    }
    return text;
  }

  async function httpError(res, signal, touch) {
    let raw = '';
    try {
      raw = (await readAll(res, signal, touch)).slice(0, MAX_ERROR_BODY);
    } catch {
      raw = '';
    }
    let body = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep text
    }
    return classifyProviderError(res.status, body, res.headers);
  }

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

  /** One HTTP request; returns an accumulator (streamed) or throws LlmError / abort. */
  async function request(body, streaming, signal, emit) {
    const timers = attemptTimers(signal);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: streaming ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: timers.signal,
      });
      timers.touch();
      if (!res.ok) throw await httpError(res, timers.signal, timers.touch);

      const ctype = res.headers.get('content-type') || '';
      if (!streaming || !/event-stream/i.test(ctype)) {
        const text = await readAll(res, timers.signal, timers.touch);
        const trimmed = text.trim();
        if (/^(data|event)\s*:|^:/.test(trimmed)) {
          const acc = newAccumulator();
          const parser = createSseParser();
          if (!consumeEvents(acc, parser.push(text), emit)) consumeEvents(acc, parser.end(), emit);
          return { acc, streamed: true };
        }
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          throw new LlmError('unavailable', { status: res.status, message: `LLM returned non-JSON body: ${trimmed.slice(0, 120)}` });
        }
        if (isErrorPayload(json)) throw classifyProviderError(res.status === 200 ? 200 : res.status, json, res.headers);
        return { acc: fromCompletion(json, emit), streamed: false };
      }

      const acc = newAccumulator();
      const parser = createSseParser();
      let done = false;
      let events = 0;
      let head = '';
      const feed = (evs) => {
        events += evs.length;
        return consumeEvents(acc, evs, emit);
      };
      if (res.body) {
        for await (const text of readText(res.body, timers.signal, timers.touch)) {
          // Until an SSE event shows up the body may be plain JSON, so keep all of it (readAll's cap).
          if (!events && head.length < MAX_JSON_BODY) head += text;
          if (feed(parser.push(text))) {
            done = true;
            break;
          }
        }
      }
      if (!done) feed(parser.end());
      // Some gateways label a plain JSON error (or completion) as text/event-stream.
      if (!events && head.trim().startsWith('{')) {
        let json = null;
        try {
          json = JSON.parse(head.trim());
        } catch {
          json = null;
        }
        if (json && isErrorPayload(json)) throw classifyProviderError(200, json, res.headers);
        if (json) return { acc: fromCompletion(json, emit), streamed: false };
      }
      return { acc, streamed: true };
    } finally {
      timers.done();
    }
  }

  /** Decision table after the response ended (RESEARCH-llm.md §5). */
  function decide({ acc, streamed }) {
    const finish = acc.finish;
    if (CONTENT_FILTER_FINISH.has(finish)) {
      throw new LlmError('content_filter', { status: 200, providerCode: finish, message: `finish_reason ${finish}` });
    }
    if (RETRYABLE_FINISH.has(finish)) {
      throw new LlmError('unavailable', { status: 200, providerCode: finish, message: `finish_reason ${finish}`, retryable: true });
    }
    if (finish === 'model_context_window_exceeded') {
      throw new LlmError('bad_request', { status: 200, providerCode: finish, reason: 'context_length', message: `finish_reason ${finish}` });
    }
    // A stream that ends without finish_reason or [DONE] was cut off, even if it ended cleanly:
    // its text is incomplete and its parallel calls may be missing. Before any text reached the
    // user this is retried; after, the agent reports the interruption.
    if (streamed && !finish && !acc.sawDone) {
      throw new LlmError('network', { message: 'LLM stream ended before finish_reason', retryable: true });
    }
    const { calls, bad } = finalizeCalls(acc, genId);
    const missingCalls = TOOL_FINISH.has(finish) && !calls.length && !acc.text.trim();
    return { acc, calls, bad, needsFallback: streamed && (bad > 0 || missingCalls) };
  }

  /**
   * `signal` is the caller's (a user stop surfaces as its abort reason, never as an LlmError);
   * `deadline` bounds every attempt and backoff together.
   */
  async function withRetries(fn, signal, canRetry, deadline) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal);
        if (deadline.signal.aborted) throw deadline.signal.reason;
        const e = toLlmError(err);
        if (!e.retryable || attempt >= maxRetries || !canRetry()) throw e;
        const delayMs = retryDelayMs(e, attempt, random);
        // A retry that cannot finish before the deadline only delays the error.
        if (deadline.at - Date.now() < delayMs + deadline.marginMs) throw e;
        onRetry?.({ attempt: attempt + 1, delayMs, error: e });
        await sleep(delayMs, deadline.callSignal);
      }
    }
  }

  /**
   * @param {{ messages: object[], tools?: object[], signal?: AbortSignal, onTextDelta?: (text: string) => void }} args
   * @returns {Promise<{ content: string, reasoningContent?: string, encryptedContent?: string,
   *   toolCalls: Array<{ id: string, name: string, arguments: string, invalidArguments?: true }>, finishReason: string, usage: object|null }>}
   */
  async function chat({ messages, tools, signal, onTextDelta } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    // totalTimeoutMs covers every attempt, backoff and the non-streaming fallback of this call.
    const dl = new AbortController();
    const dlTimer = setTimeout(() => dl.abort(new LlmError('timeout', { retryable: false, message: `LLM total ${totalTimeoutMs}ms deadline` })), totalTimeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, dl.signal]) : dl.signal;
    const deadline = { signal: dl.signal, callSignal, at: Date.now() + totalTimeoutMs, marginMs: Math.min(5000, totalTimeoutMs / 10) };
    // Once text has reached the caller a retry would duplicate it on screen, so retries stop there.
    let emitted = false;
    const emit = (text) => {
      if (!onTextDelta) return;
      emitted = true;
      onTextDelta(text);
    };
    const canRetry = () => !emitted;
    const run = (streaming, limit = maxTokens) => withRetries(async () => {
      const body = buildRequestBody({ provider: kind, model, messages, tools, temperature, thinking, stream: streaming, maxTokens: limit, extraBody });
      return decide(await request(body, streaming, callSignal, emit));
    }, signal, canRetry, deadline);

    try {
      let out = await run(stream);
      // Truncated/invalid tool arguments or a tool finish without calls: one non-streaming retry,
      // only while nothing has been shown to the user yet.
      if (out.needsFallback && !emitted) {
        // Arguments cut off by the token limit would be cut off again with the same limit.
        const limit = out.acc.finish === 'length' && out.bad > 0 ? Math.max(8192, 2 * (maxTokens ?? PROVIDERS[kind]?.maxTokens ?? 0)) : maxTokens;
        try {
          out = await run(false, limit);
        } catch (err) {
          // The streamed pass is still usable (bad calls stay flagged) unless the user stopped.
          if (signal?.aborted || err?.name === 'AbortError') throw err;
          if (!out.acc.text.trim() && !out.calls.some((c) => !c.invalidArguments)) throw err;
        }
      }

      const { acc, calls } = out;
      const result = {
        content: acc.text,
        toolCalls: calls,
        finishReason: calls.length ? 'tool_calls' : acc.finish || 'stop',
        usage: acc.usage || null,
      };
      if (acc.reasoning) result.reasoningContent = acc.reasoning;
      if (acc.encrypted) result.encryptedContent = acc.encrypted;
      return result;
    } finally {
      clearTimeout(dlTimer);
    }
  }

  return { chat, provider: kind, model };
}
