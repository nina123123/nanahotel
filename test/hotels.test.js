import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, findCity, cityZone } from '../src/services/hotels/sim-cities.js';
import { generateHotels, hashString, mulberry32, BRAND_STEMS } from '../src/services/hotels/sim-hotels.js';
import { buildRoomOffer } from '../src/services/hotels/pricing.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService, HotelError, CATEGORY_LABELS } from '../src/services/hotels/index.js';
import { parseKeyword, hotelMatchesKeyword, normalizeCategory } from '../src/services/hotels/supplier.js';
import { BookingError } from '../src/services/bookings.js';
import { distanceM } from '../src/util/geo.js';
import { addDays } from '../src/util/dates.js';

const NOW = new Date('2026-11-04T15:00:00Z'); // Wed, Nov 4, 2026, 10 AM in New York
const clock = { now: () => NOW };
const supplier = createSimSupplier();
const hotels = createHotelService({ supplier, clock });
const at = (iso) => createHotelService({ supplier, clock: { now: () => new Date(iso) } });

// Real chains, brands and famous hotels: no generated name may contain one (whole words, case-insensitive).
const REAL_BRANDS = [
  'Hilton', 'Marriott', 'Hyatt', 'Sheraton', 'Westin', 'Holiday Inn', 'Best Western', 'Motel 6', 'Super 8', 'Days Inn', 'Comfort Inn',
  'Comfort Suites', 'Hampton', 'Courtyard by', 'Fairfield', 'Ritz', 'Four Seasons', 'St. Regis', 'Kimpton', 'Omni', 'Loews', 'Wyndham',
  'Radisson', 'La Quinta', 'Red Roof', 'Extended Stay', 'Embassy Suites', 'DoubleTree', 'Waldorf', 'Conrad', 'InterContinental',
  'Crowne Plaza', 'Indigo', 'Aloft', 'Moxy', 'Ace Hotel', 'Hard Rock', 'Mandarin Oriental', 'Peninsula', 'Aman', 'Rosewood', 'Fontainebleau',
  'Bellagio', 'Caesars', 'MGM', 'Venetian', 'Wynn', 'Aria', 'Mirage', 'Luxor', 'Excalibur', 'Flamingo', 'Drury', 'Homewood', 'Home2',
  'TownePlace', 'SpringHill', 'Residence Inn', 'Candlewood', 'Staybridge', 'Graduate', 'Virgin', 'Nobu', 'Edition', 'Thompson', 'Andaz',
  'Sonesta', 'Quality Inn', 'Econo Lodge', 'Rodeway', 'Sleep Inn', 'Clarion', 'Cambria', 'citizenM', 'Yotel', 'Arlo', 'Hoxton', 'Freehand',
  'Le Meridien', 'Renaissance', 'Autograph', 'Six Senses', 'Regent', 'Montage', 'Pendry', 'Auberge', 'Langham', 'Fairmont', 'Raffles',
  'Sofitel', 'Novotel', 'Pullman', 'Mercure', 'ibis', 'Shangri-La', 'Gaylord', 'Margaritaville', 'Great Wolf', 'Harrah', 'Tropicana',
  'Golden Nugget', 'Circus Circus', 'Cosmopolitan', 'Mandalay', 'Delano', 'Vdara', 'NoMad', 'Mondrian', 'Sahara', 'Plaza Hotel', 'Carlyle',
  'Chateau Marmont', 'Biltmore', 'Broadmoor', 'Halekulani', 'Royal Hawaiian', 'Moana Surfrider', 'Outrigger', 'Driskill', 'Monteleone', 'Peabody',
  'Palmer House', 'Willard', 'Hay-Adams', 'Thistle', 'Linden Row', 'Pod Hotel', 'Standard Hotel', 'W Hotel', 'JW', 'Tru by', 'Curio',
];

const REQUIRED_CITIES = ['New York', 'Los Angeles', 'San Francisco', 'Las Vegas', 'Miami', 'Orlando', 'Chicago', 'Seattle', 'Boston',
  'Washington DC', 'New Orleans', 'Honolulu', 'San Diego', 'Nashville', 'Austin', 'Denver'];
const ZONES = new Set(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu']);

const allHotels = CITIES.flatMap((c) => generateHotels(c).map((h) => ({ h, c })));
const areaOf = (h, c) => c.areas.find((a) => a.name === h.businessArea);

test('city guide: the 16 US cities, each with its zone, area code, market and 4–8 real neighborhoods', () => {
  assert.equal(CITIES.length, 16);
  assert.deepEqual(CITIES.map((c) => c.name), REQUIRED_CITIES);
  const codes = new Set();
  for (const c of CITIES) {
    assert.ok(!codes.has(c.code), `duplicate code ${c.code}`);
    codes.add(c.code);
    assert.match(c.state, /^[A-Z]{2}$/);
    assert.equal(c.fullName, `${c.name.replace(/ DC$/, '')}, ${c.state}`);
    assert.ok(ZONES.has(c.zone), `${c.name} ${c.zone}`);
    assert.equal(cityZone(c.name), c.zone);
    assert.match(c.areaCode, /^\d{3}$/);
    assert.ok(['business', 'mixed', 'leisure'].includes(c.market), c.name);
    assert.ok(c.areas.length >= 4 && c.areas.length <= 8, `${c.name} has ${c.areas.length} areas`);
    assert.equal(c.season.length, 12);
    assert.equal(c.weekdays.length, 7);
    for (const a of c.areas) {
      assert.ok(a.name && a.district && a.reason && a.reason.length >= 20, `${c.name}/${a.name}`);
      assert.ok(a.landmarks.length >= 1 && a.landmarks.length <= 6, `${c.name}/${a.name} landmarks`);
      for (const p of [a.center, ...a.landmarks.map((l) => l.location)]) {
        // The continental US plus Hawaii.
        assert.ok((p.lng > -125 && p.lng < -66 && p.lat > 24 && p.lat < 50) || (p.lng > -160 && p.lng < -154 && p.lat > 18 && p.lat < 23), `${c.name}/${a.name} coords in the US`);
      }
      assert.ok(distanceM(a.center, c.center) < 45000, `${c.name}/${a.name} near its city`);
      for (const l of a.landmarks) {
        assert.ok(l.name && l.type, `${a.name} landmark`);
        assert.ok(distanceM(l.location, a.center) < 16000, `${l.name} close to ${a.name}`);
      }
      assert.doesNotMatch(`${a.name} ${a.reason} ${a.landmarks.map((l) => `${l.name} ${l.type}`).join(' ')}`, /[㐀-鿿]/);
    }
  }
  assert.equal(findCity('New York').zone, 'America/New_York');
  assert.equal(findCity('Las Vegas').zone, 'America/Los_Angeles');
  assert.equal(findCity('Honolulu').zone, 'Pacific/Honolulu');
  assert.equal(findCity('Denver').zone, 'America/Denver');
  assert.equal(findCity('Nashville').zone, 'America/Chicago');
  assert.equal(findCity('Las Vegas').market, 'leisure');
  assert.equal(findCity('San Francisco').market, 'business');
});

test('the National Mall runs east–west: its monuments share one latitude (real coordinates)', () => {
  const dc = findCity('Washington DC');
  const lm = (name) => dc.areas.flatMap((a) => a.landmarks).find((l) => l.name === name).location;
  const lat = lm('U.S. Capitol').lat;
  for (const name of ['Lincoln Memorial', 'Washington Monument', 'National Mall']) assert.ok(Math.abs(lm(name).lat - lat) < 0.002, `${name} ${lm(name).lat} vs ${lat}`);
  assert.ok(lm('Lincoln Memorial').lng < lm('Washington Monument').lng && lm('Washington Monument').lng < lm('U.S. Capitol').lng, 'west to east');
  // Times Square → Empire State Building: about 1.1 km south.
  const ny = findCity('New York');
  const nyLm = (name) => ny.areas.flatMap((a) => a.landmarks).find((l) => l.name === name).location;
  const d = distanceM(nyLm('Times Square'), nyLm('Empire State Building'));
  assert.ok(d > 900 && d < 1300, String(d));
});

test('PRNG and hash are deterministic', () => {
  assert.equal(hashString('sim-nyc-001'), hashString('sim-nyc-001'));
  assert.notEqual(hashString('sim-nyc-001'), hashString('sim-nyc-002'));
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('generated hotels: 18–30 per city, every Hotel field filled, stable ids', () => {
  for (const c of CITIES) {
    const list = generateHotels(c);
    assert.ok(list.length >= 18 && list.length <= 30, `${c.name}: ${list.length}`);
    assert.deepEqual(generateHotels(c), list, `${c.name} deterministic`);
    const names = new Set();
    list.forEach((h, i) => {
      assert.equal(h.id, `sim-${c.code}-${String(i + 1).padStart(3, '0')}`);
      assert.ok(!names.has(h.name), `duplicate name ${h.name}`);
      names.add(h.name);
      assert.equal(h.city, c.name);
      assert.equal(h.state, c.state);
      assert.equal(h.timeZone, c.zone);
      assert.equal(h.source, 'sim');
      assert.ok(Object.isFrozen(h));
      assert.match(h.address, / \(simulated address\)$/);
      assert.ok(h.address.includes(`${h.district}, ${c.fullName}`), h.address);
      assert.ok(['budget', 'midscale', 'upscale', 'luxury'].includes(h.category));
      assert.ok(h.rating >= 3.6 && h.rating <= 4.9 && Math.round(h.rating * 10) === h.rating * 10, `${h.id} rating ${h.rating}`);
      assert.ok(Number.isInteger(h.reviewCount) && h.reviewCount > 0);
      assert.ok(h.openedYear >= 2002 && h.openedYear <= 2025);
      assert.ok(Array.isArray(h.amenities) && h.amenities.length >= 3);
      assert.ok(Array.isArray(h.tags) && h.tags.length >= 1 && h.tags.length <= 4, `${h.id} tags`);
      assert.deepEqual(h.photos, []);
      assert.ok(Number.isInteger(h.priceHint) && h.priceHint > 0);
      // 555-0100…0199 are the numbers reserved for fiction.
      assert.ok(h.tel === '' || new RegExp(`^\\(${c.areaCode}\\) 555-01\\d{2}$`).test(h.tel), h.tel);
      const area = areaOf(h, c);
      assert.ok(area, `${h.id} businessArea`);
      assert.equal(h.district, area.district);
      const d = distanceM(h.location, area.center);
      assert.ok(d >= 140 && d <= area.spreadM + 20, `${h.id} ${d}m from ${area.name}`);
      assert.doesNotMatch([h.name, h.address, ...h.amenities, ...h.tags].join(' '), /[㐀-鿿]/);
    });
  }
});

test('hotel names are fictional: none contain a real chain, brand or famous hotel', () => {
  const re = new RegExp(`(^|[^A-Za-z])(${REAL_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})($|[^A-Za-z])`, 'i');
  for (const { h } of allHotels) assert.doesNotMatch(h.name, re, h.name);
  for (const stem of BRAND_STEMS) assert.doesNotMatch(stem, re, stem);
});

test('no name reads like an official hotel of a trademarked park or resort (Disney, Universal, SeaWorld, Opryland)', () => {
  for (const { h } of allHotels) assert.doesNotMatch(h.name, /disney|universal|epcot|seaworld|opry|caesars|bellagio/i, h.name);
  const orlando = generateHotels(findCity('Orlando')).filter((h) => /Disney|Universal/.test(h.businessArea));
  assert.ok(orlando.length >= 4, 'the Orlando parks still have hotels nearby');
});

test('no brand stem appears twice in one area (no near-duplicate listings)', () => {
  for (const c of CITIES) {
    const seen = new Map();
    for (const h of generateHotels(c)) {
      for (const stem of BRAND_STEMS.filter((b) => h.name.includes(b))) {
        const key = `${h.businessArea}|${stem}`;
        assert.ok(!seen.has(key), `${c.name}/${h.businessArea}: ${seen.get(key)} and ${h.name} share ${stem}`);
        seen.set(key, h.name);
      }
    }
  }
  const r = hotels.searchHotels({ city: 'New York', near: 'Times Square', checkIn: '2026-11-10' });
  const stems = r.hotels.flatMap((h) => BRAND_STEMS.filter((b) => h.name.includes(b)));
  assert.equal(new Set(stems).size, stems.length, r.hotels.map((h) => h.name).join(' | '));
});

test('historic inns (French Quarter, Garden District) have no big-hotel amenities', () => {
  let n = 0;
  for (const { h, c } of allHotels) {
    if (areaOf(h, c).kind !== 'inn' || h.category === 'luxury') continue;
    n++;
    for (const a of ['Fitness center', 'Meeting rooms', 'Business center', '24-hour front desk', 'Indoor pool', 'Outdoor pool']) {
      assert.ok(!h.amenities.includes(a), `${h.id} ${h.name} has ${a}`);
    }
  }
  assert.ok(n >= 6, String(n));
});

test('amenities and views follow the place: casinos only in Las Vegas, oceans only on the coasts', () => {
  for (const { h, c } of allHotels) {
    if (h.amenities.includes('Casino')) assert.equal(c.code, 'lv', `${h.id} ${h.name}`);
    if (['lv', 'den', 'bna', 'aus', 'chi', 'orl', 'nola', 'dc'].includes(c.code)) {
      assert.ok(!h.tags.includes('Ocean view') && !h.tags.includes('Beach access'), `${h.id} ${c.name} ${h.tags.join()}`);
      assert.ok(!h.amenities.includes('Beach access'), `${h.id} ${c.name}`);
    }
    if (c.code === 'bos') assert.ok(!h.tags.includes('Ocean view'), `${h.id}: Boston's Seaport looks at the harbor`);
  }
  assert.ok(generateHotels(findCity('Chicago')).some((h) => h.tags.includes('Lake view')), 'Lake Michigan gives lake views');
  assert.ok(generateHotels(findCity('Boston')).some((h) => h.tags.includes('Harbor view')));
  assert.ok(generateHotels(findCity('Honolulu')).some((h) => h.tags.includes('Ocean view')));
  const airport = allHotels.filter(({ h, c }) => areaOf(h, c).kind === 'airport');
  assert.ok(airport.filter(({ h }) => h.amenities.includes('Free airport shuttle')).length > airport.length / 2, 'most airport hotels run a shuttle');
});

test('category mix follows the area: sights, downtown and beaches skew upscale, airports skew budget', () => {
  const rank = { budget: 0, midscale: 1, upscale: 2, luxury: 3 };
  const avgRank = (kinds) => {
    const xs = allHotels.filter(({ h, c }) => kinds.includes(areaOf(h, c).kind)).map(({ h }) => rank[h.category]);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  assert.ok(avgRank(['scenic', 'cbd', 'beach']) > avgRank(['station', 'airport']) + 0.8);
  for (const c of CITIES) {
    const cats = new Set(generateHotels(c).map((h) => h.category));
    assert.ok(cats.size >= 3, `${c.name} has a category mix`);
  }
  const airportLuxury = allHotels.filter(({ h, c }) => h.category === 'luxury' && ['station', 'airport'].includes(areaOf(h, c).kind));
  assert.equal(airportLuxury.length, 0);
});

test('supplier.resolveCity is tolerant', () => {
  for (const t of ['New York', 'new york city', 'NYC', 'New York, NY', ' NEW YORK ', 'Manhattan', 'Brooklyn', 'Times Square']) {
    assert.equal(supplier.resolveCity(t)?.name, 'New York', t);
  }
  const cases = [
    ['going to Vegas next week', 'Las Vegas'], ['LA', 'Los Angeles'], ['L.A.', 'Los Angeles'], ['Hollywood', 'Los Angeles'], ['SF', 'San Francisco'],
    ['DC', 'Washington DC'], ['D.C.', 'Washington DC'], ['Washington', 'Washington DC'], ['Washington, DC', 'Washington DC'], ['NOLA', 'New Orleans'],
    ['the Big Easy', 'New Orleans'], ['Miami Beach', 'Miami'], ['Waikiki', 'Honolulu'], ['Oahu', 'Honolulu'], ['Austin, TX', 'Austin'],
    ['Music City', 'Nashville'], ['Mile High City', 'Denver'], ['Chi-town', 'Chicago'], ['Beantown', 'Boston'], ['Disney World', 'Orlando'],
    ['the Las Vegas Strip', 'Las Vegas'],
  ];
  for (const [t, name] of cases) assert.equal(supplier.resolveCity(t)?.name, name, t);
  // A place name that contains another city's name: Washington Square Park is in New York.
  assert.equal(supplier.resolveCity('Washington Square Park').name, 'New York');
  assert.equal(supplier.resolveCity('near Washington Square Park').name, 'New York');
  // A place several cities share is not enough on its own; with a city name it is.
  assert.equal(supplier.resolveCity('Union Station'), null);
  assert.equal(supplier.resolveCity('Union Station in Chicago').name, 'Chicago');
  for (const none of ['Portland', 'Paris', '', 'Mars']) assert.equal(supplier.resolveCity(none), null, none);
  const ny = supplier.resolveCity('New York');
  assert.deepEqual(Object.keys(ny).sort(), ['areaCode', 'center', 'code', 'fullName', 'market', 'name', 'priceLevel', 'season', 'state', 'tax', 'weekdays', 'zone']);
  assert.deepEqual(supplier.listCities().find((c) => c.name === 'Honolulu'), { name: 'Honolulu', state: 'HI', zone: 'Pacific/Honolulu', market: 'leisure' });
  assert.equal(supplier.listCities().length, 16);
});

test('supplier.resolveLandmark: aliases resolve to the right real place', () => {
  const cases = [
    ['New York', 'Times Square', 'Times Square'], ['New York', 'near Times Sq', 'Times Square'], ['New York', 'the Met', 'The Metropolitan Museum of Art'],
    ['New York', 'JFK', 'John F. Kennedy International Airport'], ['New York', 'Penn Station', 'Penn Station'], ['New York', 'Empire State', 'Empire State Building'],
    ['New York', 'Brooklyn Bridge', 'Brooklyn Bridge'], ['Los Angeles', 'LAX', 'Los Angeles International Airport'], ['Los Angeles', 'Santa Monica Pier', 'Santa Monica Pier'],
    ['San Francisco', 'Golden Gate', 'Golden Gate Bridge'], ['San Francisco', 'SFO', 'San Francisco International Airport'], ['Las Vegas', 'the Strip', 'Las Vegas Strip'],
    ['Las Vegas', 'Fremont Street', 'Fremont Street Experience'], ['Orlando', 'Disney World', 'Walt Disney World Resort'], ['Orlando', 'Universal', 'Universal Orlando Resort'],
    ['Chicago', 'the Bean', 'Cloud Gate'], ['Chicago', "O'Hare", "O'Hare International Airport"], ['Chicago', 'Wrigley Field', 'Wrigley Field'],
    ['Seattle', 'Pike Place', 'Pike Place Market'], ['Boston', 'Fenway', 'Fenway Park'], ['Washington DC', 'Capitol', 'U.S. Capitol'],
    ['New Orleans', 'Bourbon St', 'Bourbon Street'], ['Honolulu', 'Waikiki', 'Waikiki Beach'], ['Honolulu', 'Pearl Harbor', 'Pearl Harbor National Memorial'],
    ['San Diego', 'Gaslamp', 'Gaslamp Quarter'], ['Nashville', 'Broadway', 'Lower Broadway'], ['Austin', '6th Street', 'Sixth Street'],
    ['Denver', 'Union Station', 'Denver Union Station'], ['Miami', 'South Beach', 'South Beach'],
  ];
  for (const [city, text, expected] of cases) {
    const lm = supplier.resolveLandmark(city, text);
    assert.equal(lm?.name, expected, `${city} ${text}`);
    assert.ok(lm.location && Number.isFinite(lm.location.lng));
    assert.equal(typeof lm.area, 'string');
  }
  assert.equal(supplier.resolveLandmark('New York', 'Midtown').type, 'Neighborhood');
  assert.equal(supplier.resolveLandmark('New Orleans', 'French Quarter').name, 'French Quarter');
  assert.equal(supplier.resolveLandmark('New York', 'Times Square subway station').matched, 'partial');
  assert.equal(supplier.resolveLandmark('New York', 'Fenway Park'), null, 'Fenway is not in New York');
  assert.equal(supplier.resolveLandmark('New York', 'Mars'), null);
  assert.equal(supplier.resolveLandmark('New York', 'New York'), null, 'the city itself is not a landmark');
  assert.equal(supplier.resolveLandmark('New York', 'New York City'), null);
  assert.equal(supplier.resolveLandmark('Paris', 'Eiffel Tower'), null);
});

test('far places are not passed off as near: Disneyland, the Grand Canyon, Red Rocks', () => {
  assert.equal(supplier.resolveLandmark('Los Angeles', 'Disneyland'), null, 'Disneyland is in Anaheim');
  assert.equal(supplier.resolveLandmark('Las Vegas', 'Grand Canyon'), null);
  assert.equal(supplier.resolveLandmark('Denver', 'Red Rocks'), null);
  const r = hotels.searchHotels({ city: 'Las Vegas', near: 'Grand Canyon', checkIn: '2026-11-10' });
  assert.ok(r.notes.includes('Couldn\'t find "Grand Canyon" in Las Vegas, so I searched the whole city'), r.notes.join('|'));
  assert.equal(r.landmark, null);
});

test('supplier.searchHotels filters by radius, categories and keyword; getHotel round-trips', () => {
  const ts = supplier.resolveLandmark('New York', 'Times Square');
  const near = supplier.searchHotels({ city: 'New York', location: ts.location, radiusM: 1600 });
  assert.ok(near.length > 0);
  assert.ok(near.every((h) => distanceM(h.location, ts.location) <= 1600));
  const lux = supplier.searchHotels({ city: 'New York', categories: ['luxury'] });
  assert.ok(lux.length && lux.every((h) => h.category === 'luxury'));
  const family = supplier.searchHotels({ city: 'Orlando', keyword: 'family' });
  assert.ok(family.length && family.every((h) => hotelMatchesKeyword(h, ['family'])));
  assert.deepEqual(supplier.searchHotels({ city: 'Paris' }), []);
  const h = supplier.searchHotels({ city: 'New York' })[3];
  assert.equal(supplier.getHotel(h.id), h);
  assert.equal(supplier.getHotel('sim-nyc-999'), null);
  assert.equal(supplier.getHotel('sim-xx-001'), null);
  assert.equal(supplier.getHotel('nope'), null);
});

test('keyword parsing: wishes, stop words, phrases, synonyms and category words', () => {
  assert.deepEqual(parseKeyword('pool and spa').tokens, ['pool', 'spa']);
  assert.deepEqual(parseKeyword('family-friendly with a pool'), { tokens: ['family', 'pool'], categories: [] });
  assert.deepEqual(parseKeyword('five-star ocean view'), { tokens: ['ocean view'], categories: ['luxury'] });
  assert.deepEqual(parseKeyword('cheap'), { tokens: [], categories: ['budget'] });
  assert.deepEqual(parseKeyword('breakfast included, kids'), { tokens: ['breakfast', 'family'], categories: [] });
  assert.deepEqual(parseKeyword('mid-range near the subway'), { tokens: ['transit'], categories: ['midscale'] });
  assert.deepEqual(parseKeyword('brand new').tokens, ['newly opened']);
  assert.deepEqual(parseKeyword('pet friendly, free parking').tokens.sort(), ['parking', 'pet']);
  assert.deepEqual(parseKeyword('harbor view').tokens, ['harbor view']);
  assert.deepEqual(parseKeyword('New York quiet', { ignore: ['new york'] }), { tokens: ['quiet'], categories: [] });
  assert.equal(normalizeCategory('Luxury'), 'luxury');
  assert.equal(normalizeCategory('five-star'), 'luxury');
  assert.equal(normalizeCategory('cheap'), 'budget');
  assert.equal(normalizeCategory('upscale'), 'upscale');
  assert.equal(normalizeCategory('whatever'), null);
  // Whole words only: 'bar' is not in 'Harborline'; 'pool' is in 'Outdoor pool'; 'view' alone is any view.
  const h = { name: 'Harborline Suites', businessArea: 'X', district: 'Y', tags: ['City view'], amenities: ['Outdoor pool'], category: 'midscale' };
  assert.equal(hotelMatchesKeyword(h, ['pool']), true);
  assert.equal(hotelMatchesKeyword(h, ['bar']), false);
  assert.equal(hotelMatchesKeyword(h, ['view']), true);
  assert.equal(hotelMatchesKeyword(h, ['ocean view']), false);
  assert.equal(hotelMatchesKeyword(h, ['midscale']), true);
});

test('searchHotels: unsupported / missing city errors are typed and English', () => {
  assert.throws(() => hotels.searchHotels({ city: 'Paris' }), (err) => {
    assert.ok(err instanceof HotelError);
    assert.equal(err.code, 'city_not_supported');
    assert.match(err.message, /^The demo covers New York, Los Angeles, San Francisco, Las Vegas, Miami/);
    assert.match(err.message, /"Paris" isn't covered yet$/);
    return true;
  });
  assert.throws(() => hotels.searchHotels({}), (err) => err instanceof HotelError && err.code === 'city_required' && err.message === 'Which city are you going to?');
});

test('"tonight" is the user\'s tonight: Los Angeles at 11 PM, and the night in progress after midnight', () => {
  // 11 PM Wednesday in Los Angeles is 2 AM Thursday in New York.
  const la11pm = at('2026-11-05T07:00:00Z');
  const vegas = la11pm.searchHotels({ city: 'Las Vegas', timeZone: 'America/Los_Angeles' });
  assert.deepEqual([vegas.query.checkIn, vegas.query.checkOut], ['2026-11-04', '2026-11-05']);
  assert.ok(vegas.notes.includes('No dates given, so I searched one night from tonight'), vegas.notes.join('|'));
  assert.equal(vegas.query.timeZone, 'America/Los_Angeles', 'the hotel\'s own zone');
  // In New York it is already 2 AM, so the same night is "the night in progress" there, and still bookable.
  const ny = la11pm.searchHotels({ city: 'New York', timeZone: 'America/Los_Angeles' });
  assert.deepEqual([ny.query.checkIn, ny.query.checkOut], ['2026-11-04', '2026-11-05']);
  assert.ok(ny.notes.some((n) => n.startsWith("No dates given and it's after midnight, so I searched the night in progress (check in Wed, Nov 4")), ny.notes.join('|'));
  assert.equal(ny.query.timeZone, 'America/New_York');
  // Honolulu (9 PM) agrees.
  assert.equal(la11pm.searchHotels({ city: 'Honolulu', timeZone: 'America/Los_Angeles' }).query.checkIn, '2026-11-04');

  // 1:30 AM in Los Angeles: still the night of Nov 4 for the user, bookable and the default.
  const late = at('2026-11-05T09:30:00Z');
  const r = late.searchHotels({ city: 'Los Angeles', timeZone: 'America/Los_Angeles' });
  assert.deepEqual([r.query.checkIn, r.query.checkOut], ['2026-11-04', '2026-11-05']);
  assert.ok(r.notes.some((n) => n.includes('after midnight') && n.includes('night in progress')), r.notes.join('|'));
  assert.equal(late.searchHotels({ city: 'Los Angeles', checkIn: '2026-11-04', checkOut: '2026-11-05' }).query.checkIn, '2026-11-04');
  assert.equal(late.priceCheck({ hotelId: 'sim-la-002', rateId: 'R1-RO-NR', checkIn: '2026-11-04', checkOut: '2026-11-05' }).rate.rateId, 'R1-RO-NR');
  assert.throws(() => late.searchHotels({ city: 'Los Angeles', checkIn: '2026-11-03', checkOut: '2026-11-04' }),
    (e) => e.code === 'invalid_dates' && /night in progress/.test(e.message));
  // 6:30 AM in Los Angeles: a new day.
  const morning = at('2026-11-05T14:30:00Z');
  assert.equal(morning.searchHotels({ city: 'Los Angeles', timeZone: 'America/Los_Angeles' }).query.checkIn, '2026-11-05');
  assert.throws(() => morning.searchHotels({ city: 'Los Angeles', checkIn: '2026-11-04', checkOut: '2026-11-05' }), (e) => e.code === 'invalid_dates');
  // A New York user at 7 AM (4 AM in Los Angeles) asking for Los Angeles "tonight" means Thursday night.
  const nyMorning = at('2026-11-05T12:00:00Z');
  assert.equal(nyMorning.searchHotels({ city: 'Los Angeles', timeZone: 'America/New_York' }).query.checkIn, '2026-11-05');
});

test('searchHotels: a party that does not fit is not sold out (fitsParty / needRooms), children count as occupants', () => {
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-11' };
  const r = hotels.searchHotels({ city: 'Chicago', near: 'the Loop', ...stay, adults: 5, categories: ['budget'] });
  assert.ok(r.hotels.length > 0);
  assert.ok(!r.notes.some((n) => n.includes('sold out')), r.notes.join('|'));
  assert.ok(r.notes.some((n) => /^5 adults in 1 room: .* at most 4, so book 2 rooms or a suite there$/.test(n)), r.notes.join('|'));
  for (const h of r.hotels) {
    assert.equal(h.lowestPrice, null);
    assert.equal(h.fitsParty, false, h.id);
    assert.equal(h.needRooms, 2);
    assert.equal(h.maxOccupancy, 4);
  }
  const kids = hotels.searchHotels({ city: 'Chicago', near: 'the Loop', ...stay, adults: 4, children: 1, categories: ['budget'] });
  assert.equal(kids.query.children, 1);
  assert.deepEqual(kids.hotels.map((h) => [h.id, h.lowestPrice, h.fitsParty]), r.hotels.map((h) => [h.id, h.lowestPrice, h.fitsParty]));
  assert.ok(kids.notes.some((n) => n.startsWith('4 adults and 1 child in 1 room')), kids.notes.join('|'));
  const two = hotels.searchHotels({ city: 'Chicago', near: 'the Loop', ...stay, adults: 4, children: 1, rooms: 2, categories: ['budget'] });
  assert.ok(two.hotels.every((h) => h.fitsParty), 'two rooms fit');
  assert.equal(hotels.searchHotels({ city: 'New York' }).query.children, 0);
  assert.throws(() => hotels.priceCheck({ hotelId: 'sim-nyc-002', rateId: 'R1-RO-NR', ...stay, adults: 2, children: 1 }),
    (e) => e.code === 'too_many_guests' && /2 adults and 1 child/.test(e.message));
  const { offer } = hotels.getRoomOffer({ hotelId: 'sim-nyc-002', ...stay, adults: 2, children: 1 });
  assert.equal(offer.children, 1);
  assert.ok(offer.roomTypes.every((rt) => rt.maxOccupancy >= 3 || rt.rates.every((x) => x.unavailableReason === 'occupancy')));
});

test('searchHotels: dates default to tonight → tomorrow and are validated', () => {
  const r = hotels.searchHotels({ city: 'New York' });
  assert.equal(r.query.checkIn, '2026-11-04');
  assert.equal(r.query.checkOut, '2026-11-05');
  assert.equal(r.query.nights, 1);
  assert.equal(r.query.datesAssumed, true);
  assert.ok(r.notes.includes('No dates given, so I searched one night from tonight'), r.notes.join('|'));
  assert.equal(r.demo, true);

  const given = hotels.searchHotels({ city: 'New York', checkIn: '2026-11-06', checkOut: '2026-11-08' });
  assert.equal(given.query.datesAssumed, false);
  assert.equal(given.query.nights, 2);
  assert.ok(!given.notes.some((n) => n.startsWith('No dates')));
  assert.ok(hotels.searchHotels({ city: 'New York', checkIn: '2026-11-06' }).notes.includes('No check-out date given, so I searched one night'));

  for (const [ci, co, re] of [['2026-11-03', '2026-11-04', /has already passed/], ['2026-11-10', '2026-11-09', /Check-out needs to be after check-in/],
    ['2026-11-30', '2027-01-30', /at most 30 nights/], ['next friday', '', /isn't a valid date; use YYYY-MM-DD/]]) {
    assert.throws(() => hotels.searchHotels({ city: 'New York', checkIn: ci, checkOut: co }), (err) => err instanceof HotelError && err.code === 'invalid_dates' && re.test(err.message), ci);
  }
});

test('searchHotels: defaults and clamping (miles; radius_km still understood)', () => {
  const r = hotels.searchHotels({ city: 'nyc', limit: 50, radiusMiles: 100, adults: '3', rooms: 9, sort: 'weird', near: 'Times Square' });
  assert.equal(r.query.city, 'New York');
  assert.equal(r.query.state, 'NY');
  assert.equal(r.query.limit, 10);
  assert.equal(r.query.radiusMiles, 12);
  assert.equal(r.query.adults, 3);
  assert.equal(r.query.rooms, 5);
  assert.equal(r.query.sort, 'recommended');
  assert.equal(r.query.currency, 'USD');
  const d = hotels.searchHotels({ city: 'New York' });
  assert.deepEqual([d.query.adults, d.query.rooms, d.query.radiusMiles, d.query.limit], [2, 1, 2, 6]);
  assert.ok(d.hotels.length <= 6);
  assert.equal(hotels.searchHotels({ city: 'New York', near: 'Times Square', radiusKm: 1.6 }).query.radiusMiles, 1);
});

test('searchHotels near a landmark: distances in miles, radius and the result shape', () => {
  const r = hotels.searchHotels({ city: 'New York', near: 'Times Square', checkIn: '2026-11-10', checkOut: '2026-11-12', limit: 10 });
  assert.equal(r.landmark.name, 'Times Square');
  assert.ok(r.totalFound >= r.hotels.length && r.hotels.length > 0);
  for (const h of r.hotels) {
    assert.ok(Number.isInteger(h.distanceM) && h.distanceM <= 3300, `${h.id} ${h.distanceM}`);
    assert.equal(h.distanceMiles, Math.round((h.distanceM / 1609.344) * 10) / 10);
    assert.ok(h.lowestPrice === null || Number.isInteger(h.lowestPrice));
    for (const k of ['id', 'name', 'city', 'state', 'district', 'address', 'location', 'tel', 'rating', 'reviewCount', 'openedYear', 'amenities',
      'category', 'businessArea', 'tags', 'photos', 'priceHint', 'timeZone', 'source']) {
      assert.ok(k in h, `hotel.${k}`);
    }
  }
  const byDistance = hotels.searchHotels({ city: 'Seattle', near: 'Space Needle', sort: 'distance', checkIn: '2026-11-10' });
  const ds = byDistance.hotels.map((h) => h.distanceM);
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
  const noLandmark = hotels.searchHotels({ city: 'New York', sort: 'distance' });
  assert.equal(noLandmark.query.sort, 'recommended');
  assert.ok(noLandmark.hotels.every((h) => h.distanceM === null && h.distanceMiles === undefined));
});

test('searchHotels: an unknown `near` falls back to the whole city with a note', () => {
  const r = hotels.searchHotels({ city: 'New York', near: 'Mars base' });
  assert.equal(r.landmark, null);
  assert.ok(r.notes.includes('Couldn\'t find "Mars base" in New York, so I searched the whole city'), r.notes.join('|'));
  assert.ok(r.hotels.length > 0);
});

test('searchHotels: a landmark given as keyword is treated as near', () => {
  const r = hotels.searchHotels({ city: 'Orlando', keyword: 'Disney World' });
  assert.equal(r.landmark?.name, 'Walt Disney World Resort');
  assert.ok(r.hotels.length > 0 && r.hotels.every((h) => h.distanceM !== null));
});

test('searchHotels: radius expands with a note when nothing is close enough', () => {
  const r = hotels.searchHotels({ city: 'San Diego', near: 'Torrey Pines', radiusMiles: 0.3 });
  assert.ok(r.hotels.length > 0);
  assert.ok(r.notes.some((n) => /^Nothing suitable within 0\.3 miles, so I widened the search to \d+(\.\d)? miles$/.test(n)), r.notes.join('|'));
});

test('searchHotels: categories filter, also as words', () => {
  const r = hotels.searchHotels({ city: 'New York', near: 'Times Square', categories: ['budget'] });
  assert.ok(r.hotels.length > 0 && r.hotels.every((h) => h.category === 'budget'));
  const word = hotels.searchHotels({ city: 'Boston', categories: ['Luxury'] });
  assert.ok(word.hotels.length > 0 && word.hotels.every((h) => h.category === 'luxury'));
  assert.deepEqual(word.query.categories, ['luxury']);
  const kw = hotels.searchHotels({ city: 'Boston', keyword: 'five-star' });
  assert.ok(kw.hotels.every((h) => h.category === 'luxury'));
  const cheap = hotels.searchHotels({ city: 'Las Vegas', near: 'the Strip', keyword: 'cheap' });
  assert.ok(cheap.hotels.length > 0 && cheap.hotels.every((h) => h.category === 'budget'), 'the "Vegas … cheap" demo phrase');
});

test('searchHotels: keyword is a soft preference — matches rank first, nothing is dropped, misses get a note', () => {
  const opts = { city: 'Orlando', near: 'Disney World', checkIn: '2026-11-10', limit: 10 };
  const r = hotels.searchHotels({ ...opts, keyword: 'family' });
  const all = hotels.searchHotels(opts);
  assert.equal(r.totalFound, all.totalFound, 'no hotel is dropped for a missing preference');
  assert.ok(hotelMatchesKeyword(r.hotels[0], ['family']));
  for (const h of r.hotels) assert.deepEqual(h.matchedKeywords, hotelMatchesKeyword(h, ['family']) ? ['family'] : []);
  const flags = r.hotels.filter((h) => h.lowestPrice !== null).map((h) => h.matchedKeywords.length);
  assert.deepEqual(flags, [...flags].sort((a, b) => b - a), 'matching hotels come first');
  assert.ok(flags.includes(0), 'non-matching hotels are still listed');
  assert.ok(!r.notes.some((n) => n.startsWith('Nothing matches')), r.notes.join('|'));
  const none = hotels.searchHotels({ city: 'New York', keyword: 'ski-in ski-out' });
  assert.ok(none.hotels.length > 0);
  assert.ok(none.notes.includes('Nothing matches "ski-in ski-out", so these are sorted by our picks'), none.notes.join('|'));
});

test('searchHotels: an unmatched preference does not throw away the ones that matched', () => {
  const opts = { city: 'New York', near: 'Times Square', checkIn: '2026-11-10' };
  const r = hotels.searchHotels({ ...opts, keyword: 'pool high floor' });
  const pool = hotels.searchHotels({ ...opts, keyword: 'pool' });
  assert.ok(r.hotels.length > 0);
  assert.deepEqual(r.hotels.map((h) => h.id), pool.hotels.map((h) => h.id), 'ranked exactly as for "pool" alone');
  assert.ok(hotelMatchesKeyword(r.hotels[0], ['pool']));
  assert.ok(r.notes.includes('Nothing matches "high floor"; hotels with "pool" come first'), r.notes.join('|'));
  // Several wishes nobody satisfies together: ranked by how many they meet.
  const many = hotels.searchHotels({ ...opts, keyword: 'pool spa trendy newly opened' });
  const counts = many.hotels.filter((h) => h.lowestPrice !== null).map((h) => h.matchedKeywords.length);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('searchHotels: breakfast is matched against bookable breakfast rates, not hotel tags', () => {
  const stay = { checkIn: '2026-11-06', checkOut: '2026-11-08' };
  const r = hotels.searchHotels({ city: 'New York', near: 'Central Park', keyword: 'park view breakfast', ...stay, limit: 10 });
  assert.ok(!r.notes.some((n) => n.includes('breakfast')), r.notes.join('|'));
  assert.ok(r.hotels[0].matchedKeywords.includes('park view'), 'a park-view hotel ranks first');
  assert.ok(r.hotels.some((h) => h.matchedKeywords.includes('breakfast')));
  for (const h of r.hotels) {
    const offer = hotels.getRoomOffer({ hotelId: h.id, ...stay }).offer;
    const hasBreakfast = offer.roomTypes.some((rt) => rt.rates.some((x) => x.available && x.breakfast > 0));
    assert.equal(h.matchedKeywords.includes('breakfast'), hasBreakfast, h.id);
  }
});

test('searchHotels: budget filter (all-in, per night), then relaxation up to +30% with a note', () => {
  const ok = hotels.searchHotels({ city: 'Chicago', priceMax: 250, checkIn: '2026-11-10' });
  assert.ok(ok.hotels.length > 0 && ok.hotels.every((h) => h.lowestPrice <= 250));
  assert.ok(!ok.notes.some((n) => n.startsWith('Nothing under')));

  // A budget just under the cheapest option near Fisherman's Wharf, so that only relaxation can satisfy it.
  const base = hotels.searchHotels({ city: 'San Francisco', near: "Fisherman's Wharf", checkIn: '2026-11-10', sort: 'price_asc', limit: 10 });
  const cheapest = base.hotels.find((h) => h.lowestPrice !== null).lowestPrice;
  const budget = Math.floor((cheapest / 1.15) / 10) * 10;
  const relaxed = hotels.searchHotels({ city: 'San Francisco', near: "Fisherman's Wharf", checkIn: '2026-11-10', priceMax: budget });
  const note = relaxed.notes.find((n) => n.startsWith(`Nothing under $${budget} a night, so I went up to $`));
  assert.ok(note, relaxed.notes.join('|'));
  const hi = Number(/went up to \$([\d,]+)/.exec(note)[1].replace(/,/g, ''));
  assert.ok(hi <= Math.ceil((budget * 1.3) / 10) * 10 && hi > budget, `${hi} vs ${budget}`);
  assert.ok(relaxed.hotels.every((h) => h.lowestPrice <= hi));

  const tiny = hotels.searchHotels({ city: 'New York', near: 'Times Square', priceMax: 50 });
  assert.ok(tiny.hotels.length > 0);
  assert.equal(tiny.query.sort, 'price_asc');
  assert.ok(tiny.notes.some((n) => /^Nothing close to \$50 a night: the cheapest is \$\d+, so these are sorted from low to high$/.test(n)), tiny.notes.join('|'));

  const swapped = hotels.searchHotels({ city: 'New York', priceMin: 900, priceMax: 300 });
  assert.deepEqual([swapped.query.priceMin, swapped.query.priceMax], [300, 900]);

  // The §12 demo phrase: this Friday in New York near Times Square, two nights, under $300.
  const demo = hotels.searchHotels({ city: 'New York', near: 'Times Square', checkIn: '2026-11-06', checkOut: '2026-11-08', priceMax: 300 });
  assert.ok(demo.hotels.length >= 3 && demo.hotels.every((h) => h.lowestPrice <= 300), JSON.stringify(demo.notes));
});

test('searchHotels: sort orders', () => {
  const opts = { city: 'Chicago', limit: 10, checkIn: '2026-11-10' };
  const asc = hotels.searchHotels({ ...opts, sort: 'price_asc' }).hotels.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = hotels.searchHotels({ ...opts, sort: 'price_desc' }).hotels.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  const rating = hotels.searchHotels({ ...opts, sort: 'rating' }).hotels.map((h) => h.rating);
  assert.deepEqual(rating, [...rating].sort((a, b) => b - a));
  const rec1 = hotels.searchHotels({ city: 'Chicago', near: 'the Bean', checkIn: '2026-11-10' });
  const rec2 = hotels.searchHotels({ city: 'Chicago', near: 'the Bean', checkIn: '2026-11-10' });
  assert.deepEqual(rec1, rec2, 'recommended is deterministic');
});

test('the demo phrases all produce results', () => {
  // "Next weekend in Miami Beach, 2 adults and 1 kid"
  const a = hotels.searchHotels({ city: 'Miami', near: 'Miami Beach', checkIn: '2026-11-13', checkOut: '2026-11-15', adults: 2, children: 1 });
  assert.ok(a.hotels.length >= 2 && a.hotels.some((h) => h.lowestPrice !== null), JSON.stringify(a.notes));
  // "Tonight in Las Vegas on the Strip, cheap"
  const b = hotels.searchHotels({ city: 'Las Vegas', near: 'the Strip', categories: ['budget'] });
  assert.ok(b.hotels.length >= 1 && b.hotels.every((h) => h.category === 'budget'));
  // "Show cheaper ones" after the New York search
  const c = hotels.searchHotels({ city: 'New York', near: 'Times Square', checkIn: '2026-11-06', checkOut: '2026-11-08', sort: 'price_asc' });
  const prices = c.hotels.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice);
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y));
});

test('getRoomOffer and getHotel', () => {
  const { hotel, offer, datesAssumed } = hotels.getRoomOffer({ hotelId: 'sim-nyc-002', checkIn: '2026-11-10', checkOut: '2026-11-12', adults: 2, rooms: 1 });
  assert.equal(hotel.id, 'sim-nyc-002');
  assert.equal(offer.hotelId, 'sim-nyc-002');
  assert.equal(offer.nights, 2);
  assert.equal(offer.currency, 'USD');
  assert.equal(datesAssumed, false);
  assert.ok(offer.roomTypes.length >= 2);
  assert.equal(hotels.getRoomOffer({ hotelId: 'sim-nyc-002' }).offer.checkIn, '2026-11-04');
  assert.equal(at('2026-11-05T07:00:00Z').getRoomOffer({ hotelId: 'sim-lv-002', timeZone: 'America/Los_Angeles' }).offer.checkIn, '2026-11-04', 'tonight for an LA user at 11 PM');
  assert.throws(() => hotels.getRoomOffer({ hotelId: 'sim-nyc-999' }), (e) => e instanceof HotelError && e.code === 'hotel_not_found');
  assert.equal(hotels.getHotel('sim-nyc-002').name, hotel.name);
  assert.equal(hotels.getHotel('missing'), null);
  assert.equal(CATEGORY_LABELS[hotel.category], 'Upscale');
  assert.equal(hotels.zoneOfHotel(hotel), 'America/New_York');
  assert.equal(hotels.zoneOfHotel(hotels.getHotel('sim-hnl-001')), 'Pacific/Honolulu');
});

test('priceCheck returns the rate or throws BookingError with a precise code', () => {
  const ok = hotels.priceCheck({ hotelId: 'sim-nyc-002', rateId: 'R1-RO-FC', checkIn: '2026-11-10', checkOut: '2026-11-12', rooms: 1, adults: 2 });
  assert.equal(ok.rate.rateId, 'R1-RO-FC');
  assert.equal(ok.roomType.roomId, 'R1');
  assert.equal(ok.roomType.rates, undefined);
  assert.equal(ok.hotel.id, 'sim-nyc-002');
  const codeOf = (args) => {
    try {
      hotels.priceCheck(args);
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof BookingError, e.name);
      assert.doesNotMatch(e.message, /[㐀-鿿]/);
      return e.code;
    }
  };
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-12' };
  assert.equal(codeOf({ hotelId: 'sim-nyc-999', rateId: 'R1-RO-NR', ...stay }), 'hotel_not_found');
  assert.equal(codeOf({ hotelId: 'sim-nyc-002', rateId: 'R9-XX', ...stay }), 'rate_not_found');
  assert.equal(codeOf({ hotelId: 'sim-nyc-002', rateId: 'R1-RO-NR', checkIn: '2026-11-10' }), 'invalid_dates');
  assert.equal(codeOf({ hotelId: 'sim-nyc-002', rateId: 'R1-RO-NR', ...stay, adults: 3, rooms: 1 }), 'too_many_guests');

  // Find a deterministic sold-out combination and check it is reported as such.
  let soldOut = null;
  for (let i = 0; i < 60 && !soldOut; i++) {
    const checkIn = addDays('2026-11-10', i);
    const { offer } = hotels.getRoomOffer({ hotelId: 'sim-nyc-003', checkIn, checkOut: addDays(checkIn, 1) });
    const rt = offer.roomTypes.find((r) => !r.rates[0].available);
    if (rt) soldOut = { checkIn, rateId: rt.rates[0].rateId };
  }
  assert.ok(soldOut, 'some night is sold out');
  assert.equal(codeOf({ hotelId: 'sim-nyc-003', rateId: soldOut.rateId, checkIn: soldOut.checkIn, checkOut: addDays(soldOut.checkIn, 1) }), 'sold_out');
});

test('room offers are in the hotel\'s own time zone (cancellation deadlines)', () => {
  const { offer } = hotels.getRoomOffer({ hotelId: 'sim-hnl-002', checkIn: '2026-11-10', checkOut: '2026-11-11' });
  const free = offer.roomTypes[0].rates.find((r) => r.cancelPolicy.type === 'free');
  assert.equal(free.cancelPolicy.freeUntil, '2026-11-09T15:00:00-10:00');
  assert.match(free.cancelPolicy.text, /3:00 PM HST on Mon, Nov 9/);
  assert.ok(buildRoomOffer(hotels.getHotel('sim-den-002'), { checkIn: '2026-11-10', checkOut: '2026-11-11' }).roomTypes[0].rates
    .some((r) => r.cancelPolicy.freeUntil === '2026-11-09T15:00:00-07:00'));
});

test('createHotelService requires a supplier', () => {
  assert.throws(() => createHotelService({}), /supplier/);
});
