import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createPlacesService } from '../src/services/places.js';
import { HotelError } from '../src/services/hotels/index.js';
import { generateHotels } from '../src/services/hotels/sim-hotels.js';
import { findCity } from '../src/services/hotels/sim-cities.js';
import { lowestNightly } from '../src/services/hotels/pricing.js';

const supplier = createSimSupplier();
// Wed, Nov 4, 2026, 10 AM in New York.
const NOW = new Date('2026-11-04T15:00:00Z');
const places = createPlacesService({ supplier, clock: { now: () => NOW } });

test('searchPlaces returns guide entries with the spec fields', () => {
  const res = places.searchPlaces({ city: 'New York', keyword: 'Times Square' });
  assert.ok(res.length > 0);
  const [first] = res;
  assert.equal(first.name, 'Times Square');
  assert.equal(first.type, 'Sight');
  assert.equal(first.area, 'Times Square / Midtown');
  assert.equal(first.district, 'Midtown Manhattan');
  assert.ok(first.location && Number.isFinite(first.location.lng));
  assert.ok(Math.abs(first.location.lat - 40.758) < 0.01 && Math.abs(first.location.lng + 73.9855) < 0.01, 'real coordinates');
  assert.ok(first.nearbyHotelCount > 0);
  for (const p of res) for (const k of ['name', 'area', 'type', 'location', 'nearbyHotelCount']) assert.ok(k in p, k);
});

test('searchPlaces: aliases, generic words and limits', () => {
  assert.equal(places.searchPlaces({ city: 'Chicago', keyword: 'the Bean' })[0].name, 'Cloud Gate');
  assert.equal(places.searchPlaces({ city: 'San Diego', keyword: 'zoo' })[0].name, 'San Diego Zoo');
  assert.equal(places.searchPlaces({ city: 'Orlando', keyword: 'Disney' })[0].name, 'Walt Disney World Resort');
  assert.equal(places.searchPlaces({ city: 'NYC', keyword: 'Penn Station' })[0].name, 'Penn Station');
  assert.ok(places.searchPlaces({ city: 'New York', keyword: 'airport' }).some((p) => p.name === 'John F. Kennedy International Airport'));
  assert.ok(places.searchPlaces({ city: 'New York', keyword: 'train station' }).some((p) => p.name === 'Penn Station'));
  assert.ok(places.searchPlaces({ city: 'New York', keyword: 'museums' }).some((p) => p.name === 'The Metropolitan Museum of Art'));
  assert.ok(places.searchPlaces({ city: 'New Orleans', keyword: 'jazz' }).some((p) => p.name === 'Preservation Hall'));
  assert.ok(places.searchPlaces({ city: 'Honolulu', keyword: 'beach' }).some((p) => p.name === 'Waikiki Beach'));
  assert.ok(places.searchPlaces({ city: 'New York', keyword: 'near Central Park' }).some((p) => p.name === 'Central Park'));
  assert.equal(places.searchPlaces({ city: 'New York', keyword: 'Times Square', limit: 2 }).length, 2);
  assert.deepEqual(places.searchPlaces({ city: 'New York', keyword: 'Mars base' }), []);
});

test('searchPlaces without a keyword lists the neighborhoods with reasons', () => {
  const res = places.searchPlaces({ city: 'Miami', limit: 20 });
  assert.equal(res.length, findCity('Miami').areas.length);
  assert.ok(res.every((p) => p.type === 'Neighborhood' && p.reason));
  assert.ok(res.some((p) => p.name === 'South Beach'));
});

test('listAreas: where-to-stay advice with landmarks, hotel counts and a weekday "from" price', () => {
  const areas = places.listAreas('New York');
  const city = findCity('New York');
  const hotels = generateHotels(city);
  assert.equal(areas.length, city.areas.length);
  assert.equal(areas.reduce((s, a) => s + a.hotelCount, 0), hotels.length);
  const midtown = areas.find((a) => a.name === 'Times Square / Midtown');
  assert.ok(midtown.landmarks.includes('Times Square') && midtown.landmarks.includes('Rockefeller Center'), midtown.landmarks.join());
  assert.match(midtown.reason, /Broadway/);
  assert.equal(midtown.priceFrom, Math.min(...hotels.filter((h) => h.businessArea === midtown.name).map((h) => h.priceHint)));
  for (const a of areas) for (const k of ['name', 'landmarks', 'hotelCount', 'priceFrom', 'district', 'reason', 'location']) assert.ok(k in a, k);
  assert.ok(areas.every((a) => a.priceBasis === 'weekday'), 'a dateless "from" price says it is the weekday price');
  for (const a of areas) assert.doesNotMatch(`${a.name} ${a.reason} ${a.landmarks.join(' ')}`, /[㐀-鿿]/);
});

test('listAreas with dates prices the stay all-in (season and holidays included)', () => {
  const ny = findCity('New York');
  const midtown = generateHotels(ny).filter((h) => h.businessArea === 'Times Square / Midtown');
  const stay = { checkIn: '2026-12-31', checkOut: '2027-01-01' };
  const nye = places.listAreas('New York', stay).find((a) => a.name === 'Times Square / Midtown');
  const weekday = places.listAreas('New York').find((a) => a.name === 'Times Square / Midtown');
  const expected = Math.min(...midtown.map((h) => lowestNightly(h, { ...stay, city: supplier.resolveCity('New York'), now: NOW })).filter(Number.isFinite));
  assert.equal(nye.priceFrom, expected);
  assert.ok(nye.priceFrom > weekday.priceFrom * 1.5, `${nye.priceFrom} vs ${weekday.priceFrom}`);
  assert.deepEqual([nye.priceBasis, nye.checkIn, nye.checkOut], ['dates', '2026-12-31', '2027-01-01']);
  assert.equal(places.listAreas('New York', { checkIn: '2026-12-31' })[0].checkOut, '2027-01-01', 'one night by default');
  assert.throws(() => places.listAreas('New York', { checkIn: '2027-01-01', checkOut: '2026-12-31' }), (e) => e instanceof HotelError && e.code === 'invalid_dates');
  assert.throws(() => places.listAreas('New York', { checkIn: '2026-10-01', checkOut: '2026-10-02' }), (e) => e.code === 'invalid_dates' && /already passed/.test(e.message));
});

test('landmarks carry their own neighborhood when it differs from their area', () => {
  const cases = [
    ['Boston', 'Fenway Park', 'Fenway', 'Back Bay'],
    ['San Francisco', 'Golden Gate Bridge', 'Presidio', "Fisherman's Wharf"],
    ['New York', 'The High Line', 'Chelsea', 'SoHo / Greenwich Village'],
    ['New York', 'Central Park', 'Upper West Side', 'Central Park'],
    ['New Orleans', 'Frenchmen Street', 'Marigny', 'French Quarter'],
  ];
  for (const [city, keyword, district, area] of cases) {
    const [hit] = places.searchPlaces({ city, keyword, limit: 1 });
    assert.equal(hit.name, keyword, `${city} ${keyword}`);
    assert.equal(hit.district, district, `${city} ${keyword}`);
    assert.equal(hit.area, area, `${city} ${keyword}`);
  }
});

test('unsupported city → HotelError city_not_supported; missing city → city_required', () => {
  assert.throws(() => places.searchPlaces({ city: 'Paris', keyword: 'Eiffel Tower' }),
    (e) => e instanceof HotelError && e.code === 'city_not_supported' && /^The demo covers New York, Los Angeles/.test(e.message) && /"Paris" isn't covered yet/.test(e.message));
  assert.throws(() => places.listAreas('Mars'), (e) => e instanceof HotelError && e.code === 'city_not_supported');
  assert.throws(() => places.listAreas(''), (e) => e instanceof HotelError && e.code === 'city_required' && e.message === 'Which city is it?');
});

test('works with a supplier that has no city guide', () => {
  const bare = { ...supplier, listAreas: undefined };
  const p = createPlacesService({ supplier: bare });
  assert.deepEqual(p.searchPlaces({ city: 'New York', keyword: 'Times Square' }), []);
  assert.deepEqual(p.listAreas('New York'), []);
  assert.throws(() => createPlacesService({}), /supplier/);
});
