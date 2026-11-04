import { randomUUID } from 'node:crypto';

/**
 * Provider-neutral LLM plumbing shared by the Anthropic (anthropic.js) and OpenAI (openai.js) adapters:
 * the LlmError class with English user-facing messages, a lenient SSE reader, and the chat engine that owns
 * timeouts (idle per attempt + one deadline per call), retries (only before any text reached the user),
 * caller aborts and the one-shot "fallback" re-request an adapter can ask for.
 *
 * An adapter turns the agent's OpenAI-style messages/tools into one provider request and parses the answer:
 *   {
 *     kind, model,
 *     newCallState?() -> object                   per chat() call, shared by its attempts (recoveries)
 *     buildRequest({ messages, tools, stream, maxTokens, state }) -> { url, headers, body, meta? }
 *     newAccumulator() -> acc                      acc.text is the visible text so far
 *     consumeEvents(acc, events, emit) -> boolean  SSE events; true = the stream is complete
 *     fromJson(json, emit) -> acc                  a complete (non-streamed) response
 *     isErrorPayload(json) -> boolean
 *     classifyError(status, body, headers) -> LlmError
 *     decide({ acc, streamed }, { maxTokens }) -> { acc, calls, bad, needsFallback, fallbackStream?, fallbackMaxTokens? }
 *     toResult(decided, meta) -> chat() result
 *     recover?(err, state) -> boolean               true = rebuild the request and try again at once
 *     secrets: string[]                             values scrubbed from every error message
 *   }
 */

export const LLM_ERROR_MESSAGES = Object.freeze({
  auth: 'The AI service rejected our API key. Please check the key in the server settings.',
  billing: 'The AI service account is out of credit. Please top it up and try again.',
  rate_limit: 'Lots of people are chatting with me right now. Please wait a few seconds and try again.',
  content_filter: 'Sorry, I can\'t help with that one. Let\'s get back to your trip! If this keeps happening, tap ⋯ at the top right and choose "New chat".',
  bad_request: 'The AI service couldn\'t handle that request. Try saying it another way, or tap ⋯ at the top right and choose "New chat".',
  timeout: 'The AI service took too long to answer. Please try again in a moment.',
  unavailable: 'The AI service is having trouble right now. Please try again in a moment.',
  network: 'I couldn\'t reach the AI service. Please check the connection and try again.',
});

export const REASON_MESSAGES = Object.freeze({
  context_length: 'This chat has gotten too long for me. Tap ⋯ at the top right and choose "New chat" to start fresh.',
  model_not_found: 'The AI model in the server settings wasn\'t found. Please check ANTHROPIC_MODEL / OPENAI_MODEL (or LLM_MODEL).',
});

const RETRYABLE_CODES = new Set(['rate_limit', 'timeout', 'unavailable', 'network']);

export class LlmError extends Error {
  /**
   * @param {'auth'|'billing'|'rate_limit'|'content_filter'|'bad_request'|'timeout'|'unavailable'|'network'} code
   * @param {{ status?: number, message?: string, userMessage?: string, retryable?: boolean, retryAfterMs?: number|null,
   *           providerCode?: string, reason?: string, requestId?: string, cause?: unknown }} [opts]
   */
  constructor(code, { status = 0, message, userMessage, retryable, retryAfterMs = null, providerCode = '', reason = '', requestId = '', cause } = {}) {
    super(message || `LLM error: ${code}`, cause ? { cause } : undefined);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    this.reason = reason || '';
    this.userMessage = userMessage || REASON_MESSAGES[reason] || LLM_ERROR_MESSAGES[code] || LLM_ERROR_MESSAGES.unavailable;
    this.retryable = retryable ?? RETRYABLE_CODES.has(code);
    this.retryAfterMs = retryAfterMs;
    this.providerCode = providerCode;
    if (requestId) this.requestId = requestId;
  }
}

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function nonBlank(s) {
  return typeof s === 'string' && s.trim() !== '' ? s : null;
}

export function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Replaces every occurrence of each secret (8+ chars) in `text` with [redacted]. */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
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

/** x-should-retry (both Anthropic and OpenAI send it) overrides the code's default. */
export function shouldRetryHeader(headers) {
  return headers && typeof headers.get === 'function' ? headers.get('x-should-retry') : null;
}

/** retry-after (when 0–60 s, capped at 20 s), else 0.5·2^n s capped at 8 s, minus up to 25% jitter. */
export function retryDelayMs(err, attempt, random = Math.random) {
  const hinted = err?.retryAfterMs;
  if (Number.isFinite(hinted) && hinted >= 0 && hinted <= 60000) return Math.min(hinted, 20000);
  const base = Math.min(500 * 2 ** attempt, 8000);
  return Math.round(base * (1 - 0.25 * random()));
}

export function toLlmError(err) {
  if (err instanceof LlmError) return err;
  if (err?.name === 'TimeoutError') return new LlmError('timeout', { message: err.message, cause: err });
  return new LlmError('network', { message: `LLM network error: ${err?.message || err}`, cause: err });
}

export function abortReason(signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export function defaultSleep(ms, signal) {
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

export function defaultGenId() {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
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

// ---------------------------------------------------------------------------
// SSE reader
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

export async function* readText(body, signal, onBytes) {
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

/** Several JSON payloads in one event (one per line) happen behind non-compliant proxies. */
export function parseEventData(raw) {
  try {
    return [JSON.parse(raw)];
  } catch {
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
// Chat engine
// ---------------------------------------------------------------------------

const MAX_ERROR_BODY = 64 * 1024;
const MAX_JSON_BODY = 4 * 1024 * 1024;
const MAX_RECOVERIES = 2;

/**
 * @param {object} adapter  see the file comment
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, totalTimeoutMs?: number, maxRetries?: number, stream?: boolean,
 *           maxTokens?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, random?: () => number,
 *           onRetry?: (info: { attempt: number, delayMs: number, error: LlmError }) => void }} opts
 * @returns {{ chat: Function }}
 */
export function createChatEngine(adapter, {
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
  totalTimeoutMs = 120000,
  maxRetries = 2,
  stream = true,
  maxTokens,
  sleep = defaultSleep,
  random = Math.random,
  onRetry,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createLlmClient: fetch is required');
  const secrets = (adapter.secrets || []).filter((s) => typeof s === 'string' && s.length >= 8);
  const scrub = (err) => {
    if (err instanceof LlmError && secrets.length) err.message = redactSecrets(err.message, secrets);
    return err;
  };

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
    const err = adapter.classifyError(res.status, body, res.headers);
    const requestId = res.headers?.get?.('request-id') || res.headers?.get?.('x-request-id') || '';
    if (requestId && !err.requestId) err.requestId = requestId;
    return err;
  }

  /** One HTTP request; returns { acc, streamed } or throws LlmError / abort. */
  async function request(req, streaming, signal, emit) {
    const timers = attemptTimers(signal);
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: timers.signal,
      });
      timers.touch();
      if (!res.ok) throw await httpError(res, timers.signal, timers.touch);

      const ctype = res.headers.get('content-type') || '';
      if (!streaming || !/event-stream/i.test(ctype)) {
        const text = await readAll(res, timers.signal, timers.touch);
        const trimmed = text.trim();
        if (/^(data|event)\s*:|^:/.test(trimmed)) {
          const acc = adapter.newAccumulator();
          const parser = createSseParser();
          if (!adapter.consumeEvents(acc, parser.push(text), emit)) adapter.consumeEvents(acc, parser.end(), emit);
          return { acc, streamed: true };
        }
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          throw new LlmError('unavailable', { status: res.status, message: `LLM returned a non-JSON body: ${trimmed.slice(0, 120)}` });
        }
        if (adapter.isErrorPayload(json)) throw adapter.classifyError(res.status === 200 ? 200 : res.status, json, res.headers);
        return { acc: adapter.fromJson(json, emit), streamed: false };
      }

      const acc = adapter.newAccumulator();
      const parser = createSseParser();
      let done = false;
      let events = 0;
      let head = '';
      const feed = (evs) => {
        events += evs.length;
        return adapter.consumeEvents(acc, evs, emit);
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
        if (json && adapter.isErrorPayload(json)) throw adapter.classifyError(200, json, res.headers);
        if (json) return { acc: adapter.fromJson(json, emit), streamed: false };
      }
      return { acc, streamed: true };
    } finally {
      timers.done();
    }
  }

  /**
   * `signal` is the caller's (a user stop surfaces as its abort reason, never as an LlmError);
   * `deadline` bounds every attempt and backoff together.
   */
  async function withRetries(fn, signal, canRetry, deadline, state) {
    let recoveries = 0;
    for (let attempt = 0; ;) {
      try {
        return await fn();
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal);
        if (deadline.signal.aborted) throw scrub(deadline.signal.reason);
        const e = scrub(toLlmError(err));
        // An adapter-specific repair (e.g. drop replayed thinking blocks the API no longer accepts): at once, no backoff.
        if (recoveries < MAX_RECOVERIES && canRetry() && typeof adapter.recover === 'function' && adapter.recover(e, state)) {
          recoveries++;
          continue;
        }
        if (!e.retryable || attempt >= maxRetries || !canRetry()) throw e;
        const delayMs = retryDelayMs(e, attempt, random);
        // A retry that cannot finish before the deadline only delays the error.
        if (deadline.at - Date.now() < delayMs + deadline.marginMs) throw e;
        attempt++;
        onRetry?.({ attempt, delayMs, error: e });
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
    // totalTimeoutMs covers every attempt, backoff and the fallback re-request of this call.
    const dl = new AbortController();
    const dlTimer = setTimeout(() => dl.abort(new LlmError('timeout', { retryable: false, message: `LLM total ${totalTimeoutMs}ms deadline` })), totalTimeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, dl.signal]) : dl.signal;
    const deadline = { signal: dl.signal, callSignal, at: Date.now() + totalTimeoutMs, marginMs: Math.min(5000, totalTimeoutMs / 10) };
    // Once text has reached the caller a retry would duplicate it on screen, so retries stop there.
    let emitted = false;
    const emit = (text) => {
      if (!onTextDelta || !text) return;
      emitted = true;
      onTextDelta(text);
    };
    const canRetry = () => !emitted;
    const state = typeof adapter.newCallState === 'function' ? adapter.newCallState() : {};
    const run = (streaming, limit = maxTokens) => withRetries(async () => {
      const req = adapter.buildRequest({ messages, tools, stream: streaming, maxTokens: limit, state });
      const decided = adapter.decide(await request(req, streaming, callSignal, emit), { maxTokens: limit });
      return { ...decided, meta: req.meta || {} };
    }, signal, canRetry, deadline, state);

    try {
      let out = await run(stream);
      // Truncated/invalid tool arguments or a tool stop without calls: one more request,
      // only while nothing has been shown to the user yet.
      if (out.needsFallback && !emitted) {
        const fallbackStream = out.fallbackStream ?? false;
        const limit = out.fallbackMaxTokens ?? maxTokens;
        try {
          out = await run(fallbackStream && stream, limit);
        } catch (err) {
          // The first pass is still usable (bad calls stay flagged) unless the user stopped.
          if (signal?.aborted || err?.name === 'AbortError') throw err;
          if (!out.acc.text.trim() && !out.calls.some((c) => !c.invalidArguments)) throw err;
        }
      }
      return adapter.toResult(out, out.meta);
    } finally {
      clearTimeout(dlTimer);
    }
  }

  return { chat };
}
