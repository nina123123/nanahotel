// The whole live path with a fake LiteAPI: buildDeps picks the live services when a LiteAPI key is set, the tools
// search, show rooms and quote over LiteAPI's answers, and the HTTP API locks the price, hands the card form its
// session (to the owner only), books with the stored transaction id and cancels at LiteAPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps, createApp, LIVE_CSP, CSP } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createTools, createProfileRepo } from '../src/agent/tools.js';
import { SANDBOX_KEY, hotelsList, hotelDetails, ratesResponse, prebookResponse, bookResponse, cancelResponse } from './fakes/liteapi-fixtures.js';

const USER = '0b8f5a52-4a7e-4e7f-9d55-6b5b8c1f2a10';
const OTHER = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';

function makeClock(iso) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

/** A fake LiteAPI routed by method and path; `calls` records what NanaHotel sent. */
function fakeLiteApi(overrides = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body, key: new Headers(init.headers).get('x-api-key') });
    const route = `${method} ${u.pathname}`;
    if (overrides[route]) return overrides[route]({ body, url: u, json });
    switch (route) {
      case 'GET /v3.0/data/hotels': return json(hotelsList());
      case 'GET /v3.0/data/hotel': return json(hotelDetails());
      case 'POST /v3.0/hotels/rates': return json(ratesResponse());
      case 'POST /v3.0/rates/prebook': return json(prebookResponse());
      case 'POST /v3.0/rates/book': return json(bookResponse());
      case 'GET /v3.0/bookings/BKX7Q2': return json(bookResponse());
      case 'PUT /v3.0/bookings/BKX7Q2': return json(cancelResponse());
      default: return json({ error: { code: 404, description: `no fake for ${route}` } }, 404);
    }
  };
  return { fetch, calls };
}

async function liveApp(t, { overrides, env = {} } = {}) {
  const clock = makeClock('2026-11-04T16:00:00.000Z');
  const config = {
    ...loadConfig({ env: { LITEAPI_API_KEY: SANDBOX_KEY, ...env }, envFile: null }),
    dataDir: null,
  };
  const api = fakeLiteApi(overrides);
  const logger = { info() {}, warn() {}, error() {} };
  const deps = await buildDeps(config, { fetch: api.fetch, clock, logger, llm: null, webSearch: { enabled: false } });
  const app = createApp({ ...deps, logger });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close({ graceMs: 50 }));
  const tools = createTools({
    hotels: deps.hotels, places: deps.places, bookings: deps.bookings, stays: deps.stays, rides: deps.rides,
    profiles: createProfileRepo(deps.store, { clock }), clock, logger: () => {},
  });
  return { base: `http://127.0.0.1:${app.server.address().port}`, deps, tools, api, clock };
}

async function call(base, method, path, { user = USER, body } = {}) {
  const headers = {};
  if (user) headers['X-User-Id'] = user;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, json, text };
}

const ctx = { userId: USER, sessionId: 'S-live-test', timeZone: 'America/New_York' };
const STAY = { check_in: '2026-12-04', check_out: '2026-12-06', adults: 2 };

async function quoteBreakfastRate(tools) {
  const rooms = await tools.execute('get_hotel_rooms', { hotel_id: 'lp1a2b3', ...STAY }, ctx);
  const rate = rooms.card.offer.roomTypes.flatMap((rt) => rt.rates).find((r) => r.breakfast > 0 && r.refundable);
  assert.ok(rate, 'a refundable breakfast rate');
  const out = await tools.execute('prepare_booking', {
    hotel_id: 'lp1a2b3', rate_id: rate.rateId, ...STAY, guest_names: ['Sarah Miller'], email: 'sarah@example.com', contact_phone: '(415) 555-0123',
  }, ctx);
  assert.ok(out.card, JSON.stringify(out.content));
  return out.card.quote;
}

test('a LiteAPI key switches the server to live hotels: no simulated stay, the live CSP, health says so', async (t) => {
  const { base, deps, tools } = await liveApp(t);
  assert.equal(deps.hotels.live, true);
  assert.equal(deps.stays, null);
  assert.equal(deps.places, null);
  const health = await call(base, 'GET', '/api/health', { user: null });
  assert.equal(health.json.hotels, 'liteapi');
  assert.deepEqual(health.json.live, { hotels: 'liteapi', sandbox: true, payments: 'liteapi', email: false, places: false, stays: false });
  assert.equal(health.headers.get('content-security-policy'), LIVE_CSP);
  assert.match(LIVE_CSP, /script-src [^;]*https:\/\/payment-wrapper\.liteapi\.travel/);
  assert.match(LIVE_CSP, /frame-src [^;]*https:\/\/js\.stripe\.com/);
  assert.doesNotMatch(CSP, /stripe/);
  const names = tools.definitions().map((d) => d.function.name);
  for (const n of ['search_hotels', 'get_hotel_rooms', 'prepare_booking', 'list_orders', 'prepare_cancellation', 'get_ride_links']) assert.ok(names.includes(n), n);
  for (const n of ['check_in', 'request_service', 'quote_ride', 'list_areas', 'search_places']) assert.ok(!names.includes(n), n);
  // The demo's wording is gone from what the model reads.
  assert.ok(!JSON.stringify(tools.definitions()).includes('test payment'));
});

test('search and rooms come from LiteAPI with real photos and cents', async (t) => {
  const { tools, api } = await liveApp(t);
  const res = await tools.execute('search_hotels', { city: 'New York', near: 'Times Square', ...STAY }, ctx);
  assert.ok(res.card, JSON.stringify(res.content));
  assert.equal(res.card.type, 'hotels');
  assert.equal(res.card.demo, false);
  const first = res.card.hotels.find((h) => h.id === 'lp1a2b3');
  assert.ok(first, 'Midtown Lights Hotel is found near Times Square');
  assert.equal(first.timeZone, 'America/New_York');
  assert.ok(first.photos[0].startsWith('https://'));
  assert.ok(first.lowestPrice > 0);
  assert.ok(!('offer' in first), 'the priced offer stays server-side');
  assert.ok(!JSON.stringify(res.content).includes('simulated'));
  assert.ok(api.calls.every((c) => c.key === SANDBOX_KEY), 'every LiteAPI call carries the key header');

  const rooms = await tools.execute('get_hotel_rooms', { hotel_id: 'lp1a2b3', ...STAY }, ctx);
  assert.equal(rooms.card.type, 'rooms');
  const rates = rooms.card.offer.roomTypes.flatMap((rt) => rt.rates);
  assert.ok(rates.some((r) => r.totalPrice === 412.3), 'cents survive');
});

test('quote → Confirm booking (price lock) → card form session → pay → book → cancel, all at LiteAPI', async (t) => {
  const { base, tools, api } = await liveApp(t);
  const quote = await quoteBreakfastRate(tools);
  assert.equal(quote.totalPrice, 468);
  assert.equal(quote.live.sandbox, true);
  assert.ok(quote.hotel.photos[0].startsWith('https://'));

  const confirm = await call(base, 'POST', `/api/quotes/${quote.id}/confirm`, { body: {} });
  assert.equal(confirm.status, 200, confirm.text);
  const order = confirm.json.order;
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.live.environment, 'sandbox');
  assert.ok(!confirm.text.includes('pi_3Q_secret'), 'the client secret is never on the order');
  const prebook = api.calls.find((c) => c.path === '/v3.0/rates/prebook');
  assert.equal(prebook.host, 'book.liteapi.travel');
  assert.equal(prebook.body.usePaymentSdk, true);

  // The card form's session: the owner only.
  const stranger = await call(base, 'GET', `/api/orders/${order.id}/payment`, { user: OTHER });
  assert.equal(stranger.status, 404);
  const session = await call(base, 'GET', `/api/orders/${order.id}/payment`);
  assert.equal(session.status, 200, session.text);
  assert.equal(session.json.secretKey, 'pi_3Q_secret_test_abc');
  assert.equal(session.json.environment, 'sandbox');
  assert.equal(session.json.amount, 468);
  assert.match(session.json.scriptUrl, /^https:\/\/payment-wrapper\.liteapi\.travel\//);

  // After the card form: the server books with the transaction id it stored (whatever the browser sends).
  const paid = await call(base, 'POST', `/api/orders/${order.id}/pay`, { body: { method: 'liteapi', transactionId: 'tr_forged' } });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.order.status, 'confirmed');
  assert.equal(paid.json.order.confirmationNo, 'MLH-77801');
  assert.equal(paid.json.order.live.bookingId, 'BKX7Q2');
  const book = api.calls.find((c) => c.path === '/v3.0/rates/book');
  assert.deepEqual(book.body.payment, { method: 'TRANSACTION_ID', transactionId: 'tr_9b2c' });
  assert.equal(book.body.prebookId, 'pb_7f3a');
  assert.equal(book.body.holder.email, 'sarah@example.com');
  // Paying again books nothing new; the session is gone once booked.
  const again = await call(base, 'POST', `/api/orders/${order.id}/pay`, { body: { method: 'liteapi' } });
  assert.equal(again.json.order.status, 'confirmed');
  assert.equal(api.calls.filter((c) => c.path === '/v3.0/rates/book').length, 1);
  assert.equal((await call(base, 'GET', `/api/orders/${order.id}/payment`)).status, 409);

  // My trips lists it (no simulated stay with live hotels).
  const trips = await call(base, 'GET', '/api/stays');
  assert.equal(trips.status, 200, trips.text);
  assert.deepEqual(trips.json.stays.map((x) => [x.order.id, x.stay, x.requests.length]), [[order.id, null, 0]]);

  const preview = await call(base, 'GET', `/api/orders/${order.id}/cancel-preview`);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.cancellable, true);
  assert.equal(preview.json.penalty, 0);
  const cancelled = await call(base, 'POST', `/api/orders/${order.id}/cancel`, { body: {} });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.order.status, 'cancelled');
  assert.equal(cancelled.json.order.cancellation.refund, 468);
  assert.ok(api.calls.some((c) => c.method === 'PUT' && c.path === '/v3.0/bookings/BKX7Q2'));
});

test('two taps on Confirm booking lock the price once and share the order', async (t) => {
  const { base, tools, api } = await liveApp(t);
  const quote = await quoteBreakfastRate(tools);
  const [a, b] = await Promise.all([
    call(base, 'POST', `/api/quotes/${quote.id}/confirm`, { body: {} }),
    call(base, 'POST', `/api/quotes/${quote.id}/confirm`, { body: {} }),
  ]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.equal(a.json.order.id, b.json.order.id);
  assert.equal(api.calls.filter((c) => c.path === '/v3.0/rates/prebook').length, 1);
});

test('a higher locked price is refused before any payment, and the next quote reads LiteAPI afresh', async (t) => {
  let rateCalls = 0;
  const { base, tools, api } = await liveApp(t, {
    overrides: {
      'POST /v3.0/rates/prebook': ({ json }) => json(prebookResponse({ price: 499, pct: 6.6 })),
      'POST /v3.0/hotels/rates': ({ json }) => {
        rateCalls += 1;
        return json(ratesResponse());
      },
    },
  });
  const quote = await quoteBreakfastRate(tools);
  const before = rateCalls;
  const confirm = await call(base, 'POST', `/api/quotes/${quote.id}/confirm`, { body: {} });
  assert.equal(confirm.status, 409, confirm.text);
  assert.equal(confirm.json.error.code, 'price_changed');
  assert.match(confirm.json.error.message, /\$499/);
  assert.ok(!api.calls.some((c) => c.path === '/v3.0/rates/book'));
  await quoteBreakfastRate(tools);
  assert.ok(rateCalls > before, 'the requote skipped the rates cache');
});

test('a LiteAPI refusal at booking leaves the order unpaid and can be tried again', async (t) => {
  let fail = true;
  const { base, tools } = await liveApp(t, {
    overrides: {
      'POST /v3.0/rates/book': ({ json }) => (fail
        ? json({ error: { code: 4002, description: 'payment not completed' } }, 400)
        : json(bookResponse())),
    },
  });
  const quote = await quoteBreakfastRate(tools);
  const { json: { order } } = await call(base, 'POST', `/api/quotes/${quote.id}/confirm`, { body: {} });
  const first = await call(base, 'POST', `/api/orders/${order.id}/pay`, { body: { method: 'liteapi' } });
  assert.equal(first.status, 402, first.text);
  assert.equal(first.json.error.code, 'payment_incomplete');
  assert.equal((await call(base, 'GET', `/api/orders/${order.id}/payment`)).status, 200, 'the card form can be shown again');
  fail = false;
  const second = await call(base, 'POST', `/api/orders/${order.id}/pay`, { body: { method: 'liteapi' } });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.order.status, 'confirmed');
});

test('ride links: Uber and Lyft with the trip filled in, no simulated driver', async (t) => {
  const { tools } = await liveApp(t);
  const out = await tools.execute('get_ride_links', { from: 'Times Square', to: 'Central Park', city: 'New York', kind: 'ride' }, ctx);
  assert.ok(out.card, JSON.stringify(out.content));
  assert.equal(out.card.type, 'ride_links');
  assert.match(out.card.links.uber.url, /^https:\/\/m\.uber\.com\/ul\/\?/);
  assert.match(out.card.links.lyft.url, /^https:\/\/lyft\.com\/ride\?/);
  assert.match(out.content.instruction, /books and pays there/);
});

test('the hotel console: off on a public address without a password, a sign-in with one', async (t) => {
  const off = await liveApp(t, { env: { HOST: '0.0.0.0' } });
  assert.equal((await call(off.base, 'GET', '/api/merchant/hotels', { user: null })).status, 404);
  assert.equal((await call(off.base, 'GET', '/api/health', { user: null })).json.console, 'off');

  const locked = await liveApp(t, { env: { HOST: '0.0.0.0', MERCHANT_PASSWORD: 'correct horse battery' } });
  const blocked = await call(locked.base, 'GET', '/api/merchant/hotels', { user: null });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.json.error.code, 'login_required');
  const wrong = await call(locked.base, 'POST', '/api/merchant-login', { user: null, body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  const ok = await call(locked.base, 'POST', '/api/merchant-login', { user: null, body: { password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^nanahotel_console=[A-Za-z0-9]+; Path=\/api\/merchant; HttpOnly; SameSite=Strict/);
  const res = await fetch(`${locked.base}/api/merchant/hotels`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(res.status, 200);
});
