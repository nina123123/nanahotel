import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearch, WebSearchError, BOCHA_ENDPOINT } from '../src/services/websearch.js';
import { createFakeFetch, jsonResponse } from './fakes/fake-fetch.js';

function bochaBody(values) {
  return { code: 200, log_id: 'x', msg: null, data: { _type: 'SearchResponse', queryContext: { originalQuery: 'q' }, webPages: { value: values } } };
}

const SAMPLE = [
  {
    id: '1', name: 'Things to do near Times Square', url: 'https://example.com/a', displayUrl: 'example.com/a',
    snippet: 'Short snippet', summary: 'Times Square is free to visit around the clock; start at the TKTS steps and walk north…', siteName: 'Example Travel', datePublished: '2026-09-01T10:00:00-04:00',
  },
  { id: '2', name: 'No site name', url: 'https://news.example.org/b?x=1', snippet: 'Only a snippet', datePublished: null },
  { id: '3', name: 'A dangerous link', url: 'javascript:alert(1)', snippet: 'x' },
  { id: '4', name: '', url: 'not a url', snippet: 'x' },
];

test('disabled without an API key; the tool is then not offered', async () => {
  for (const apiKey of [undefined, '', '   ']) {
    const ws = createWebSearch({ provider: 'bocha', apiKey, fetch: createFakeFetch([]) });
    assert.equal(ws.enabled, false);
    await assert.rejects(ws.search('Times Square'), (e) => e instanceof WebSearchError && e.code === 'disabled');
  }
  assert.equal(createWebSearch({ provider: 'other', apiKey: 'k', fetch: createFakeFetch([]) }).enabled, false);
});

test('sends the Bocha request and maps results', async () => {
  const fetch = createFakeFetch([{ match: { method: 'POST', url: BOCHA_ENDPOINT }, status: 200, json: bochaBody(SAMPLE) }]);
  const ws = createWebSearch({ provider: 'bocha', apiKey: 'sk-test', fetch });
  assert.equal(ws.enabled, true);
  const res = await ws.search('  Times Square opening hours ', { freshness: 'week', count: 3 });
  assert.equal(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://api.bochaai.com/v1/web-search');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.json, { query: 'Times Square opening hours', freshness: 'oneWeek', summary: true, count: 3 });
  assert.ok(call.signal, 'request has an abort signal (timeout)');
  assert.deepEqual(res, [
    { title: 'Things to do near Times Square', url: 'https://example.com/a', snippet: 'Times Square is free to visit around the clock; start at the TKTS steps and walk north…', site: 'Example Travel', date: '2026-09-01' },
    { title: 'No site name', url: 'https://news.example.org/b?x=1', snippet: 'Only a snippet', site: 'news.example.org', date: '' },
  ]);
});

test('freshness and count are normalized', async () => {
  const fetch = createFakeFetch(() => jsonResponse(bochaBody([])));
  const ws = createWebSearch({ apiKey: 'k', fetch });
  await ws.search('a');
  await ws.search('a', { freshness: 'oneMonth', count: 99 });
  await ws.search('a', { freshness: '2026-01-01..2026-02-01', count: 0 });
  await ws.search('a', { freshness: 'whenever' });
  assert.deepEqual(fetch.calls.map((c) => [c.json.freshness, c.json.count]), [
    ['noLimit', 5], ['oneMonth', 10], ['2026-01-01..2026-02-01', 5], ['noLimit', 5],
  ]);
});

test('long snippets are clipped and results capped at count', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, url: `https://e.com/${i}`, summary: 'x'.repeat(500) }));
  const ws = createWebSearch({ apiKey: 'k', fetch: createFakeFetch([{ json: bochaBody(many) }]) });
  const res = await ws.search('a', { count: 4 });
  assert.equal(res.length, 4);
  assert.equal(res[0].snippet.length, 301);
  assert.ok(res[0].snippet.endsWith('…'));
});

test('HTTP and API errors map to typed errors with English messages', async () => {
  const cases = [
    [{ status: 401, json: { code: 401, msg: 'Invalid API KEY' } }, 'auth'],
    [{ status: 403, json: { code: 403, msg: 'Insufficient balance' } }, 'quota'],
    [{ status: 429, json: { code: 429 } }, 'rate_limited'],
    [{ status: 400, json: { code: 400, msg: 'bad' } }, 'bad_request'],
    [{ status: 500, body: 'oops' }, 'unavailable'],
    [{ status: 200, json: { code: 403, msg: 'Insufficient balance' } }, 'quota'],
    [{ status: 200, body: 'not json' }, 'unavailable'],
    [{ error: new TypeError('fetch failed') }, 'unavailable'],
  ];
  for (const [step, code] of cases) {
    const ws = createWebSearch({ apiKey: 'k', fetch: createFakeFetch([step]) });
    await assert.rejects(ws.search('a'), (e) => {
      assert.ok(e instanceof WebSearchError, e.name);
      assert.equal(e.code, code, JSON.stringify(step));
      assert.match(e.message, /^[A-Z][\x20-\x7e]+$/, 'a plain English sentence');
      return true;
    });
  }
});

test('timeouts and caller aborts', async () => {
  const slow = createWebSearch({ apiKey: 'k', timeoutMs: 20, fetch: createFakeFetch([{ delayMs: 500, json: bochaBody([]) }]) });
  await assert.rejects(slow.search('a'), (e) => e.code === 'timeout');

  const ctrl = new AbortController();
  const ws = createWebSearch({ apiKey: 'k', fetch: createFakeFetch([{ delayMs: 500, json: bochaBody([]) }]) });
  const p = ws.search('a', { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('empty query and missing webPages', async () => {
  const ws = createWebSearch({ apiKey: 'k', fetch: createFakeFetch([{ json: { code: 200, data: {} } }]) });
  await assert.rejects(ws.search('   '), (e) => e.code === 'bad_request');
  assert.deepEqual(await ws.search('a'), []);
});

test('fake-fetch: scripted steps, mismatches and streamed bodies', async () => {
  const fetch = createFakeFetch([
    { match: { method: 'GET', url: /example/ }, chunks: ['data: 1\n\n', 'data: 2\n\n'], headers: { 'content-type': 'text/event-stream' } },
    { match: { method: 'POST' }, json: {} },
  ]);
  const res = await fetch('https://example.com/stream');
  assert.equal(await res.text(), 'data: 1\n\ndata: 2\n\n');
  await assert.rejects(fetch('https://example.com', { method: 'GET' }), /did not match/);
  await assert.rejects(fetch('https://example.com'), /unexpected request/);
  assert.equal(fetch.pending(), 0);
});
