import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readLiveConfig, describeLiveConfig } from '../src/live/config.js';
import { createLiveServices } from '../src/live/index.js';
import { createHttpClient, createTtlCache, redact, LiveServiceError } from '../src/live/http.js';
import { createFakeFetch } from './fakes/fake-fetch.js';

const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-secret-anthropic-key',
  LITEAPI_API_KEY: 'sand_secret-liteapi-key-0001',
  LITEAPI_PAYMENT_KEY: 'pk_test_51NanaPublishableKey',
  GOOGLE_PLACES_API_KEY: 'AIzaSy-secret-google-key-0002',
  RESEND_API_KEY: 're_secret_resend_key_0003',
  EMAIL_FROM: 'NanaHotel <bookings@nanahotel.example>',
};
const SECRET_VALUES = ['secret-anthropic', 'secret-liteapi', 'secret-google', 'secret_resend'];

describe('readLiveConfig', () => {
  test('no keys: demo mode, the app runs exactly as today (rides links still on)', () => {
    const c = readLiveConfig({});
    assert.equal(c.mode, 'demo');
    assert.equal(c.demo, true);
    assert.deepEqual(c.on, { llm: false, hotels: false, places: false, email: false, rides: true });
    assert.equal(c.hotels.provider, 'sim');
    assert.deepEqual(c.payments, { provider: 'sim', mode: 'demo', publishableKey: null, keyEnv: 'LITEAPI_PAYMENT_KEY' });
    assert.equal(c.places.provider, 'sim');
    assert.equal(c.email.provider, 'none');
    assert.equal(c.llm.provider, 'anthropic');
    assert.deepEqual(c.warnings, []);
    const lines = describeLiveConfig(c);
    assert.match(lines.join('\n'), /Hotels: demo .*set LITEAPI_API_KEY/);
    assert.match(lines.join('\n'), /set GOOGLE_PLACES_API_KEY/);
    assert.match(lines.join('\n'), /set RESEND_API_KEY and EMAIL_FROM/);
  });

  test('every key switches its service on; a sandbox LiteAPI key means test bookings and the test card', () => {
    const c = readLiveConfig(KEYS);
    assert.equal(c.mode, 'sandbox');
    assert.deepEqual(c.on, { llm: true, hotels: true, places: true, email: true, rides: true });
    assert.equal(c.hotels.sandbox, true);
    assert.equal(c.hotels.apiKey, KEYS.LITEAPI_API_KEY, 'connectors can still read the key');
    assert.equal(c.payments.mode, 'sandbox');
    assert.equal(c.payments.environment, 'sandbox');
    assert.equal(c.payments.publishableKey, KEYS.LITEAPI_PAYMENT_KEY);
    assert.equal(c.payments.testCard, '4242 4242 4242 4242');
    assert.equal(c.places.apiKey, KEYS.GOOGLE_PLACES_API_KEY);
    assert.equal(c.email.from, KEYS.EMAIL_FROM);
    assert.equal(c.email.testSender, false);
    assert.equal(c.llm.model, 'claude-opus-5-5');
    assert.deepEqual(c.warnings, []);
    assert.match(describeLiveConfig(c).join('\n'), /LiteAPI sandbox/);
  });

  test('a production LiteAPI key is live and says so', () => {
    const c = readLiveConfig({ LITEAPI_API_KEY: 'prod_live_key_123', LITEAPI_PAYMENT_KEY: 'pk_live_51Nana' });
    assert.equal(c.mode, 'live');
    assert.equal(c.payments.mode, 'live');
    assert.equal(c.payments.environment, 'live');
    assert.equal(c.payments.testCard, null);
    assert.deepEqual(c.warnings, ['LITEAPI_API_KEY is a production key: bookings are real and guests are charged']);
    assert.match(describeLiveConfig(c).join('\n'), /LiteAPI LIVE \(real bookings, guests are charged\)/);
  });

  test('the card form key (LITEAPI_PAYMENT_KEY): publishable keys only, matching the LiteAPI environment', () => {
    const missing = readLiveConfig({ LITEAPI_API_KEY: 'sand_abc_123' });
    assert.equal(missing.payments.publishableKey, null);
    assert.match(missing.warnings.join('\n'), /LITEAPI_PAYMENT_KEY is not set: the card form cannot load/);
    assert.match(describeLiveConfig(missing).join('\n'), /card form off until LITEAPI_PAYMENT_KEY is set/);
    // A secret pasted by mistake must never reach a browser.
    for (const secret of ['sk_live_51Secret', 'rk_test_51Restricted', 'sand_abc_123', 'prod_xyz_789']) {
      const c = readLiveConfig({ LITEAPI_API_KEY: 'sand_abc_123', LITEAPI_PAYMENT_KEY: secret });
      assert.equal(c.payments.publishableKey, null, secret);
      assert.match(c.warnings.join('\n'), /looks like a secret key/, secret);
      assert.ok(!JSON.stringify(c).includes(secret), secret);
    }
    const odd = readLiveConfig({ LITEAPI_API_KEY: 'sand_abc_123', LITEAPI_PAYMENT_KEY: 'whatever-123' });
    assert.equal(odd.payments.publishableKey, null);
    assert.match(odd.warnings.join('\n'), /doesn't look like a publishable key/);
    assert.match(readLiveConfig({ LITEAPI_API_KEY: 'sand_abc_123', LITEAPI_PAYMENT_KEY: 'pk_live_1' }).warnings.join('\n'), /sandbox key but LITEAPI_PAYMENT_KEY is a live/);
    assert.match(readLiveConfig({ LITEAPI_API_KEY: 'prod_abc_123', LITEAPI_PAYMENT_KEY: 'pk_test_1' }).warnings.join('\n'), /production key but LITEAPI_PAYMENT_KEY is a test/);
    assert.match(readLiveConfig({ LITEAPI_PAYMENT_KEY: 'pk_test_1' }).warnings.join('\n'), /LITEAPI_API_KEY is not/);
    // Publishable keys are meant for the browser: shown as is.
    assert.match(JSON.stringify(readLiveConfig(KEYS)), /"publishableKey":"pk_test_51NanaPublishableKey"/);
  });

  test('email settings: test sender without EMAIL_FROM, bad addresses warned about', () => {
    const noFrom = readLiveConfig({ RESEND_API_KEY: 're_x_123456', APP_NAME: 'NanaHotel' });
    assert.equal(noFrom.email.from, 'NanaHotel <onboarding@resend.dev>');
    assert.equal(noFrom.email.testSender, true);
    assert.match(noFrom.warnings[0], /EMAIL_FROM is not set/);
    const bad = readLiveConfig({ RESEND_API_KEY: 're_x_123456', EMAIL_FROM: 'bookings at nanahotel', EMAIL_REPLY_TO: 'nope' });
    assert.equal(bad.email.testSender, true);
    assert.equal(bad.email.replyTo, '');
    assert.equal(bad.warnings.length, 2);
    assert.match(readLiveConfig({ EMAIL_FROM: KEYS.EMAIL_FROM }).warnings[0], /RESEND_API_KEY is not/);
    assert.equal(readLiveConfig({ RESEND_API_KEY: 're_x_123456', EMAIL_FROM: KEYS.EMAIL_FROM, EMAIL_REPLY_TO: 'help@nanahotel.example' }).email.replyTo, 'help@nanahotel.example');
  });

  test('aliases: LITEAPI_KEY (with a rename warning) and GOOGLE_MAPS_API_KEY; blank values count as unset', () => {
    const c = readLiveConfig({ LITEAPI_KEY: 'sand_alias_123', GOOGLE_MAPS_API_KEY: 'AIza-alias', RESEND_API_KEY: '   ' });
    assert.equal(c.hotels.enabled, true);
    assert.match(c.warnings[0], /rename/);
    assert.equal(c.places.enabled, true);
    assert.equal(c.email.enabled, false);
  });

  test('keys never show in JSON, console output or the startup summary', () => {
    const c = readLiveConfig({ ...KEYS, OPENAI_API_KEY: 'sk-proj-secret-openai' });
    const outputs = [JSON.stringify(c), inspect(c, { depth: 10 }), describeLiveConfig(c).join('\n'), String(c.hotels), JSON.stringify(c.warnings)];
    for (const out of outputs) {
      for (const s of [...SECRET_VALUES, 'secret-openai']) assert.ok(!out.includes(s), `${s} leaked into: ${out.slice(0, 80)}`);
    }
    assert.match(JSON.stringify(c), /"apiKey":"\[redacted\]"/);
  });
});

describe('createLiveServices', () => {
  const simSupplier = { resolveLandmark: (city, text) => (/times square/i.test(text) ? { name: 'Times Square', location: { lng: -73.9855, lat: 40.758 }, area: 'Midtown', type: 'landmark' } : null) };

  test('demo: no supplier (keep the simulator), disabled mailer, demo landmarks', async () => {
    const live = createLiveServices(readLiveConfig({}), { fetch: createFakeFetch([]), simSupplier });
    assert.equal(live.hotels, null);
    assert.equal(live.email.enabled, false);
    assert.equal(live.places.live, false);
    assert.equal((await live.places.geocode('Times Square', { city: 'New York' })).source, 'sim');
    assert.equal(live.rides.links({ dropoff: { name: 'Hotel', lat: 40.7, lng: -73.9 } }).uber.label, 'Open in Uber');
    assert.ok(live.describe().length >= 5);
  });

  test('live: the LiteAPI supplier geocodes through Google Places', async () => {
    const place = { displayName: { text: 'Times Square' }, location: { latitude: 40.758, longitude: -73.9855 }, formattedAddress: 'Manhattan, NY', types: ['tourist_attraction'] };
    const fetch = createFakeFetch([{ json: { places: [place] } }]);
    const live = createLiveServices(readLiveConfig(KEYS), { fetch, simSupplier, logger: { info() {}, warn() {} } });
    assert.equal(live.hotels.source, 'liteapi');
    assert.equal(live.hotels.sandbox, true);
    assert.equal(live.hotels.paymentSdk.publishableKey, KEYS.LITEAPI_PAYMENT_KEY);
    assert.equal(live.email.enabled, true);
    const lm = await live.hotels.resolveLandmark('New York', 'Times Square');
    assert.equal(lm.name, 'Times Square');
    assert.equal(fetch.calls[0].url, 'https://places.googleapis.com/v1/places:searchText');
  });
});

describe('http helper', () => {
  test('redact, TTL cache and a retry-free POST', async () => {
    assert.equal(redact('key=abcdef123 and abcdef123', ['abcdef123']), 'key=[redacted] and [redacted]');
    let t = 0;
    const cache = createTtlCache({ max: 2, ttlMs: 100, now: () => t });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined, 'least recently used goes first');
    assert.equal(cache.get('a'), 1);
    t = 500;
    assert.equal(cache.get('a'), undefined, 'expired');
    const fetch = createFakeFetch([{ status: 503, json: {} }]);
    const http = createHttpClient({ service: 'liteapi', baseUrl: 'https://api.example.com', fetch, sleep: async () => {} });
    await assert.rejects(http.request({ method: 'POST', path: '/x', body: { a: 1 } }), (e) => e instanceof LiveServiceError && e.code === 'unavailable');
    assert.equal(fetch.calls.length, 1, 'POST is not retried unless asked');
  });
});
