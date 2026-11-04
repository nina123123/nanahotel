/**
 * Shared plumbing for the live connectors (LiteAPI, Google Places, Resend): one JSON-over-HTTP helper with a
 * per-request timeout, caller aborts, bounded retries for idempotent calls, and LiveServiceError — a typed error
 * whose `message` is for logs (provider text, secrets scrubbed) and whose `userMessage` is short English a guest
 * can read. Nothing here logs request bodies, query strings, headers or keys.
 *
 * Runs in Node 22 and in the phone apps' browser build, so it only uses fetch, AbortController and timers.
 */

export const LIVE_ERROR_MESSAGES = Object.freeze({
  liteapi: Object.freeze({
    auth: 'Hotel booking is temporarily unavailable. Please try again later.',
    rate_limit: 'The hotel system is busy right now. Please try again in a few seconds.',
    timeout: 'The hotel system is taking too long to answer. Please try again in a moment.',
    network: 'I couldn\'t reach the hotel system. Please try again in a moment.',
    unavailable: 'The hotel system is having trouble right now. Please try again in a moment.',
    bad_request: 'The hotel system couldn\'t process that request.',
    not_found: 'I couldn\'t find that hotel or booking.',
    sold_out: 'That room just sold out. Want me to look for another option?',
    price_changed: 'The price just changed. Please check the new price before you book.',
    expired: 'That price hold expired. Let me get you a fresh price.',
    payment_failed: 'The payment didn\'t go through, so nothing was booked. Please try again or use another card.',
    not_cancellable: 'This booking can\'t be cancelled online. Please contact the hotel.',
  }),
  google_places: Object.freeze({
    auth: 'Map search is temporarily unavailable.',
    rate_limit: 'Map search is busy right now. Please try again in a few seconds.',
    timeout: 'Map search is taking too long. Please try again.',
    network: 'I couldn\'t reach map search. Please try again.',
    unavailable: 'Map search is having trouble right now.',
    bad_request: 'Map search couldn\'t understand that place.',
    not_found: 'I couldn\'t find that place.',
  }),
  resend: Object.freeze({
    auth: 'Email is temporarily unavailable. Your booking is not affected.',
    rate_limit: 'Email is busy right now. I\'ll try again shortly.',
    timeout: 'Sending the email took too long. Your booking is not affected.',
    network: 'I couldn\'t reach the email service. Your booking is not affected.',
    unavailable: 'The email service is having trouble. Your booking is not affected.',
    bad_request: 'That email couldn\'t be sent. Please check the address.',
    not_found: 'That email couldn\'t be sent.',
  }),
});

const DEFAULT_MESSAGES = LIVE_ERROR_MESSAGES.liteapi;
const RETRYABLE = new Set(['rate_limit', 'timeout', 'network', 'unavailable']);

export class LiveServiceError extends Error {
  /**
   * @param {'liteapi'|'google_places'|'resend'|string} service
   * @param {string} code  auth | rate_limit | timeout | network | unavailable | bad_request | not_found |
   *                       sold_out | price_changed | expired | payment_failed | not_cancellable
   * @param {{ status?: number, message?: string, userMessage?: string, retryable?: boolean, providerCode?: string,
   *           requestId?: string, retryAfterMs?: number|null, details?: object, cause?: unknown }} [opts]
   */
  constructor(service, code, { status = 0, message, userMessage, retryable, providerCode = '', requestId = '', retryAfterMs = null, details, cause } = {}) {
    super(message || `${service} error: ${code}`, cause ? { cause } : undefined);
    this.name = 'LiveServiceError';
    this.service = service;
    this.code = code;
    this.status = status;
    this.userMessage = userMessage || LIVE_ERROR_MESSAGES[service]?.[code] || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.unavailable;
    this.retryable = retryable ?? RETRYABLE.has(code);
    this.providerCode = providerCode ? String(providerCode) : '';
    this.retryAfterMs = retryAfterMs;
    if (requestId) this.requestId = requestId;
    if (details) this.details = details;
  }
}

/** Replaces every occurrence of each secret (6+ chars) in `text` with [redacted]. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  return out;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** console-like objects and plain functions both work; missing methods are no-ops. */
export function normalizeLogger(logger) {
  if (typeof logger === 'function') return { info: (m) => logger(m), warn: (m) => logger(m) };
  if (logger && typeof logger === 'object') {
    return {
      info: typeof logger.info === 'function' ? (m) => logger.info(m) : () => {},
      warn: typeof logger.warn === 'function' ? (m) => logger.warn(m) : typeof logger.error === 'function' ? (m) => logger.error(m) : () => {},
    };
  }
  return { info() {}, warn() {} };
}

export function parseRetryAfterMs(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function abortReason(signal) {
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

/** Generic status → code mapping; connectors refine it with the provider's error body. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  if (status === 409) return 'unavailable';
  return 'bad_request';
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(`${String(baseUrl || '').replace(/\/+$/, '')}${path || ''}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return url;
}

const MAX_BODY_CHARS = 8 * 1024 * 1024;

/**
 * @param {{ service: string, baseUrl: string, fetch?: typeof fetch, headers?: Record<string, string>, timeoutMs?: number,
 *           maxRetries?: number, sleep?: Function, random?: () => number, logger?: object|Function, secrets?: string[],
 *           classify?: (status: number, body: unknown, headers: Headers) => LiveServiceError,
 *           checkBody?: (body: unknown, status: number) => LiveServiceError|null }} opts
 *   classify maps a non-2xx response; checkBody can reject a 2xx response that carries an error (LiteAPI does this).
 */
export function createHttpClient({
  service, baseUrl, fetch: fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 15000, maxRetries = 2,
  sleep = defaultSleep, random = Math.random, logger, secrets = [], classify, checkBody,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error(`${service}: fetch is required`);
  const log = normalizeLogger(logger);
  const scrub = (s) => redact(s, secrets);
  const classifyFn = classify || ((status, body) => new LiveServiceError(service, codeForStatus(status), { status, message: `${service} HTTP ${status}: ${String(typeof body === 'string' ? body : JSON.stringify(body ?? '')).slice(0, 300)}` }));

  function toLiveError(err) {
    if (err instanceof LiveServiceError) {
      err.message = scrub(err.message);
      return err;
    }
    if (err?.name === 'TimeoutError') return new LiveServiceError(service, 'timeout', { message: `${service} timed out`, cause: err });
    return new LiveServiceError(service, 'network', { message: scrub(`${service} network error: ${err?.message || err}`), cause: err });
  }

  async function once(url, { method, body, headers: extra, signal, timeoutMs: limit }) {
    const ctrl = new AbortController();
    const ms = limit ?? timeoutMs;
    const timer = setTimeout(() => ctrl.abort(new LiveServiceError(service, 'timeout', { message: `${service} ${method} ${url.pathname} timed out after ${ms}ms` })), ms);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      const init = { method, headers: { Accept: 'application/json', ...headers, ...(extra || {}) }, signal: combined };
      if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
      const res = await fetchImpl(url.href, init);
      const text = (await res.text()).slice(0, MAX_BODY_CHARS);
      let data = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) throw classifyFn(res.status, data, res.headers);
      if (checkBody) {
        const bad = checkBody(data, res.status);
        if (bad) throw bad;
      }
      return { status: res.status, data, headers: res.headers };
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{ method?: string, path?: string, query?: object, body?: unknown, headers?: object, signal?: AbortSignal,
   *           timeoutMs?: number, retry?: boolean, maxRetries?: number }} o  retry defaults to true for GET only; never
   *   set it on a call that charges money or creates something twice (book, send email without an idempotency key).
   * @returns {Promise<{ status: number, data: any, headers: Headers }>}
   */
  async function request(o = {}) {
    const method = String(o.method || 'GET').toUpperCase();
    const url = buildUrl(baseUrl, o.path, o.query);
    const retry = o.retry ?? method === 'GET';
    const retries = Number.isInteger(o.maxRetries) ? o.maxRetries : maxRetries;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw abortReason(o.signal);
      const started = Date.now();
      try {
        const res = await once(url, { ...o, method });
        log.info(`[${service}] ${method} ${url.pathname} ${res.status} ${Date.now() - started}ms`);
        return res;
      } catch (err) {
        if (o.signal?.aborted) throw abortReason(o.signal);
        const e = toLiveError(err);
        log.warn(`[${service}] ${method} ${url.pathname} failed: ${e.code}${e.status ? ` (${e.status})` : ''} ${Date.now() - started}ms`);
        if (!retry || !e.retryable || attempt >= retries) throw e;
        const hinted = e.retryAfterMs;
        const delay = Number.isFinite(hinted) && hinted >= 0 && hinted <= 10000 ? hinted : Math.round(Math.min(400 * 2 ** attempt, 4000) * (1 - 0.25 * random()));
        await sleep(delay, o.signal);
      }
    }
  }

  return { request };
}

// ---------------------------------------------------------------------------
// Small value helpers shared by the connectors
// ---------------------------------------------------------------------------

export function str(v, max = 300) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Great-circle distance in meters between { lat, lng } points; null when either is missing. */
export function distanceMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return null;
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** A tiny TTL + LRU map (insertion order = recency). */
export function createTtlCache({ max = 500, ttlMs = 60000, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > (hit.ttlMs ?? ttlMs)) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, ttl) {
      map.delete(key);
      map.set(key, { value, at: now(), ttlMs: ttl });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/** 12-char deterministic hash (FNV-1a, two lanes) for short stable ids. */
export function shortHash(s) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`.padEnd(12, '0').slice(0, 12);
}
