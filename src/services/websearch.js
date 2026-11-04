/**
 * Optional web search via the Bocha Web Search API. Disabled (and the tool is not offered to the model) when no
 * API key is configured.
 */

export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search';
const FRESHNESS = new Map([
  ['nolimit', 'noLimit'], ['any', 'noLimit'], ['all', 'noLimit'], ['anytime', 'noLimit'],
  ['oneday', 'oneDay'], ['day', 'oneDay'], ['24h', 'oneDay'], ['today', 'oneDay'], ['past day', 'oneDay'],
  ['oneweek', 'oneWeek'], ['week', 'oneWeek'], ['this week', 'oneWeek'], ['past week', 'oneWeek'],
  ['onemonth', 'oneMonth'], ['month', 'oneMonth'], ['this month', 'oneMonth'], ['past month', 'oneMonth'],
  ['oneyear', 'oneYear'], ['year', 'oneYear'], ['this year', 'oneYear'], ['past year', 'oneYear'],
]);

export class WebSearchError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
    if (status) this.status = status;
  }
}

function freshnessOf(v) {
  if (!v) return 'noLimit';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/.test(s)) return s;
  return FRESHNESS.get(s.toLowerCase()) || 'noLimit';
}

function errorFor(status, apiCode, apiMsg) {
  const code = status || apiCode;
  if (code === 401) return new WebSearchError('auth', 'The web search API key is invalid; check BOCHA_API_KEY', 401);
  if (code === 403) return new WebSearchError('quota', 'The web search quota ran out or access was denied; check the Bocha account balance', 403);
  if (code === 429) return new WebSearchError('rate_limited', 'Too many web searches; please try again in a moment', 429);
  if (code === 400) return new WebSearchError('bad_request', `The web search request was rejected${apiMsg ? `: ${String(apiMsg).slice(0, 80)}` : ''}`, 400);
  return new WebSearchError('unavailable', 'Web search is unavailable right now; please try again later', typeof code === 'number' ? code : undefined);
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function mapResult(v) {
  const url = safeUrl(v?.url);
  if (!url) return null;
  let site = String(v.siteName || '').trim();
  if (!site) {
    try { site = new URL(url).hostname; } catch { site = ''; }
  }
  return {
    title: clip(v.name, 120) || url,
    url,
    snippet: clip(v.summary || v.snippet, 300),
    site: clip(site, 40),
    date: typeof v.datePublished === 'string' ? v.datePublished.slice(0, 10) : '',
  };
}

/**
 * @param {{ provider?: 'bocha', apiKey?: string, fetch?: typeof fetch, timeoutMs?: number, endpoint?: string }} opts
 * @returns {{ enabled: boolean, provider: string, search(query: string, opts?: { freshness?: string, count?: number, signal?: AbortSignal }): Promise<Array<{ title, url, snippet, site, date }>> }}
 */
export function createWebSearch({ provider = 'bocha', apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, endpoint = BOCHA_ENDPOINT } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const enabled = provider === 'bocha' && !!key && typeof fetchImpl === 'function';

  async function search(query, { freshness, count = 5, signal } = {}) {
    if (!enabled) throw new WebSearchError('disabled', 'Web search is off (BOCHA_API_KEY is not set)');
    const q = String(query || '').trim().slice(0, 200);
    if (!q) throw new WebSearchError('bad_request', 'The search query is empty');
    const n = Math.min(10, Math.max(1, Math.round(Number(count) || 5)));

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, freshness: freshnessOf(freshness), summary: true, count: n }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new WebSearchError('timeout', 'The web search timed out; please try again later');
      throw new WebSearchError('unavailable', 'Web search is unavailable right now; please try again later');
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw errorFor(res.status, body?.code, body?.msg || body?.message);
    if (!body || typeof body !== 'object') throw new WebSearchError('unavailable', 'The web search returned something unexpected');
    if (body.code !== undefined && Number(body.code) !== 200) throw errorFor(null, Number(body.code), body.msg);

    const values = body.data?.webPages?.value;
    if (!Array.isArray(values)) return [];
    return values.map(mapResult).filter(Boolean).slice(0, n);
  }

  return { enabled, provider, search };
}
