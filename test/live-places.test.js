import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGooglePlaces, createPlacesConnector, createSimGeocoder, GOOGLE_PLACES, classifyGoogleError } from '../src/live/places.js';
import { LiveServiceError } from '../src/live/http.js';
import { createFakeFetch } from './fakes/fake-fetch.js';

const KEY = 'AIzaSyTEST-places-key-000111';
const TIMES_SQUARE = {
  id: 'ChIJmQJIxlVYwokRLgeuocVOGVU',
  displayName: { text: 'Times Square', languageCode: 'en' },
  formattedAddress: 'Manhattan, NY 10036, USA',
  location: { latitude: 40.7579747, longitude: -73.9855426 },
  types: ['tourist_attraction', 'point_of_interest', 'establishment'],
};

function google(steps, opts = {}) {
  const fetch = createFakeFetch(steps);
  const logs = [];
  const places = createGooglePlaces({ apiKey: KEY, fetch, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, sleep: async () => {}, ...opts });
  return { places, fetch, logs };
}

describe('Google Places (New) Text Search', () => {
  test('request: POST searchText with the key and field mask headers, English/US, a location bias', async () => {
    const { places, fetch } = google([{ json: { places: [TIMES_SQUARE] } }]);
    const place = await places.geocode('Times Square', { city: 'New York, NY', near: { lat: 40.7549, lng: -73.984 } });
    const req = fetch.calls[0];
    assert.equal(req.url, GOOGLE_PLACES.textSearchUrl);
    assert.equal(req.url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-goog-api-key'], KEY);
    assert.equal(req.headers['x-goog-fieldmask'], 'places.id,places.displayName,places.formattedAddress,places.location,places.types');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(req.json, {
      textQuery: 'Times Square, New York, NY',
      languageCode: 'en',
      regionCode: 'US',
      pageSize: 1,
      locationBias: { circle: { center: { latitude: 40.7549, longitude: -73.984 }, radius: 30000 } },
    });
    assert.deepEqual(place, {
      name: 'Times Square', lat: 40.7579747, lng: -73.9855426, address: 'Manhattan, NY 10036, USA',
      types: ['tourist_attraction', 'point_of_interest', 'establishment'], id: 'ChIJmQJIxlVYwokRLgeuocVOGVU', source: 'google',
    });
  });

  test('the city is not repeated when the text already names it; no match is null; empty text makes no request', async () => {
    const { places, fetch } = google([{ json: {} }, { json: { places: [{ displayName: { text: 'No location' } }, TIMES_SQUARE] } }]);
    assert.equal(await places.geocode('Hotels in New York near the park', { city: 'New York, NY' }), null);
    assert.equal(fetch.calls[0].json.textQuery, 'Hotels in New York near the park');
    assert.equal(fetch.calls[0].json.locationBias, undefined);
    const list = await places.searchText('Times Square', { limit: 50 });
    assert.equal(fetch.calls[1].json.pageSize, 20);
    assert.deepEqual(list.map((p) => p.name), ['Times Square'], 'results without a location are dropped');
    assert.deepEqual(await places.searchText('  '), []);
    assert.equal(await places.geocode(''), null);
    assert.equal(fetch.calls.length, 2);
  });

  test('errors: a bad key (400 on Google) and a disabled API (403) are auth; 429 is retried once', async () => {
    assert.equal(classifyGoogleError(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }).code, 'auth');
    assert.equal(classifyGoogleError(403, { error: { code: 403, message: 'Places API (New) has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED' } }).code, 'auth');
    assert.equal(classifyGoogleError(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "pageSize"', status: 'INVALID_ARGUMENT' } }).code, 'bad_request');
    assert.equal(classifyGoogleError(500, { error: { status: 'INTERNAL' } }).code, 'unavailable');
    const busy = { status: 429, json: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } };
    const { places, fetch } = google([busy, busy]);
    const err = await places.geocode('Times Square').catch((e) => e);
    assert.ok(err instanceof LiveServiceError);
    assert.equal(err.code, 'rate_limit');
    assert.equal(fetch.calls.length, 2);
  });

  test('the key never appears in errors or logs', async () => {
    const { places, logs } = google([{ status: 400, json: { error: { message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT' } } }]);
    const err = await places.geocode('Times Square').catch((e) => e);
    assert.equal(err.code, 'auth');
    assert.ok(!err.message.includes(KEY));
    assert.ok(!logs.join('\n').includes(KEY));
    assert.ok(!logs.join('\n').includes('Times Square'), 'search text is not logged');
  });

  test('timeouts and caller aborts', async () => {
    const { places } = google([{ delayMs: 2000, json: {} }], { timeoutMs: 20, maxRetries: 0 });
    assert.equal((await places.geocode('Times Square').catch((e) => e)).code, 'timeout');
    const { places: p2 } = google([{ delayMs: 2000, json: {} }]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const err = await p2.geocode('Times Square', { signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
  });
});

describe('places connector and demo fallback', () => {
  const simSupplier = {
    resolveLandmark(city, text) {
      if (city === 'New York' && /times square/i.test(text)) return { name: 'Times Square', location: { lng: -73.9855, lat: 40.758 }, area: 'Midtown', type: 'landmark', extentM: 0 };
      return null;
    },
  };

  test('without a key the demo landmarks answer (no network)', async () => {
    const fetch = createFakeFetch([]);
    const conn = createPlacesConnector({ fetch, fallback: createSimGeocoder(simSupplier) });
    assert.equal(conn.live, false);
    assert.equal(conn.source, 'sim');
    assert.deepEqual(await conn.geocode('Times Square', { city: 'New York, NY' }), { name: 'Times Square', lat: 40.758, lng: -73.9855, address: 'Midtown', types: ['landmark'], source: 'sim' });
    assert.equal(await conn.geocode('Nowhere', { city: 'New York, NY' }), null);
    assert.deepEqual(await conn.searchText('x'), []);
    assert.equal(fetch.calls.length, 0);
    assert.equal(await createPlacesConnector({}).geocode('Times Square'), null, 'no key and no fallback');
  });

  test('with a key: Google answers and is cached; when Google fails the demo landmarks are used', async () => {
    const fetch = createFakeFetch([{ json: { places: [TIMES_SQUARE] } }, { status: 500, json: {} }, { status: 500, json: {} }]);
    const logs = [];
    const conn = createPlacesConnector({ apiKey: KEY, fetch, fallback: createSimGeocoder(simSupplier), logger: { warn: (m) => logs.push(m) } });
    assert.equal(conn.live, true);
    const a = await conn.geocode('Times Square', { city: 'New York, NY' });
    const b = await conn.geocode('times square', { city: 'New York, NY' });
    assert.equal(a.source, 'google');
    assert.deepEqual(a, b);
    assert.equal(fetch.calls.length, 1, 'cached');
    const fallback = await conn.geocode('Times Square', { city: 'New York' });
    assert.equal(fallback.source, 'sim');
    assert.match(logs.join('\n'), /Google Places failed \(unavailable\); using the demo landmarks/);
    assert.ok(!logs.join('\n').includes(KEY));
  });

  test('a stop still aborts instead of falling back', async () => {
    const fetch = createFakeFetch([{ delayMs: 1000, json: {} }]);
    const conn = createPlacesConnector({ apiKey: KEY, fetch, fallback: createSimGeocoder(simSupplier) });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const err = await conn.geocode('Times Square', { city: 'New York', signal: ctrl.signal }).catch((e) => e);
    assert.equal(err.name, 'AbortError');
  });
});
