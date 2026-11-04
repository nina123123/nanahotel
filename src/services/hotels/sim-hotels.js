import { offsetPoint } from '../../util/geo.js';

/**
 * Deterministic generator of FICTIONAL hotels around the real areas in sim-cities.js.
 * Every value derives from seeded PRNGs keyed by city code + hotel index, so ids, names and price anchors are
 * identical across restarts. Name stems are invented words, never real hotel chains or brands (see
 * test/hotels.test.js for the blocklist).
 */

/** 32-bit string hash (FNV-1a + murmur3 finalizer so neighbouring ids land far apart). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) derived from a string. */
export function hash01(str) {
  return hashString(str) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATS = ['budget', 'midscale', 'upscale', 'luxury'];

/** Per area kind: hotel count weight, category mix and a price factor relative to the city's level. */
const KINDS = {
  scenic: { count: 5, mix: [0.12, 0.33, 0.33, 0.22], priceFactor: 1.12 },
  cbd: { count: 5, mix: [0.08, 0.32, 0.38, 0.22], priceFactor: 1.08 },
  shopping: { count: 4, mix: [0.15, 0.38, 0.32, 0.15], priceFactor: 1.03 },
  oldtown: { count: 4, mix: [0.18, 0.4, 0.3, 0.12], priceFactor: 1.0 },
  nightlife: { count: 4, mix: [0.2, 0.42, 0.3, 0.08], priceFactor: 1.0 },
  university: { count: 3, mix: [0.3, 0.45, 0.25, 0], priceFactor: 0.92 },
  inn: { count: 4, mix: [0.15, 0.45, 0.33, 0.07], priceFactor: 1.05, inn: true },
  resort: { count: 5, mix: [0.12, 0.33, 0.33, 0.22], priceFactor: 1.05, resort: true },
  beach: { count: 4, mix: [0.08, 0.3, 0.34, 0.28], priceFactor: 1.08, resort: true },
  station: { count: 2, mix: [0.3, 0.45, 0.25, 0], priceFactor: 0.95 },
  airport: { count: 3, mix: [0.42, 0.45, 0.13, 0], priceFactor: 0.85 },
};

/**
 * Weekday room rates in USD before taxes (lowest room, room only) for an average US market, by category;
 * a city's priceLevel, the area kind and the rating move them (New York is about 1.35×, Las Vegas 0.7×).
 */
export const PRICE_RANGES = Object.freeze({ budget: [89, 139], midscale: [139, 219], upscale: [219, 359], luxury: [399, 899] });

const RATING = { budget: [3.6, 4.4], midscale: [4.0, 4.6], upscale: [4.2, 4.8], luxury: [4.5, 4.9] };
const YEARS = { budget: [2008, 2025], midscale: [2010, 2025], upscale: [2006, 2025], luxury: [2002, 2024] };
const REVIEWS = { budget: [300, 3500], midscale: [500, 5500], upscale: [600, 6500], luxury: [300, 4000] };
const NEWEST_YEAR = 2025;
// Where pools are outdoors all year.
const WARM_CITIES = new Set(['la', 'lv', 'mia', 'orl', 'hnl', 'sd', 'aus', 'nola']);

// Invented stems; none may be (or read like) a real chain or brand. Positions matter for determinism.
const BRANDS = {
  budget: ['Penny Pine', 'Cozy Owl', 'Sunny Gate', 'Lamplight', 'Pebble Lane', 'Bright Acre', 'Bramble', 'Sparrow Rest', 'Pinwheel', 'Kettle Creek'],
  midscale: ['Harborline', 'Copperleaf', 'Fernway', 'Lindenbrook', 'Silverbell', 'Wren & Willow', 'Northlight', 'Saltbox', 'Hollyhock', 'Tidewell'],
  upscale: ['Ashgrove', 'Bellvane', 'Ironleaf', 'Quillon', 'Westmere', 'Ambergate', 'Ravelle', 'Marbleton', 'Corliss', 'Evermere'],
  luxury: ['Aurelian', 'Vantorre', 'Halcourt', 'Solenne', 'Ardenne', 'Caelum', 'Montclaire', 'Larkhaven', 'Sable Crown', 'Ivoryline'],
  inn: ['Wisteria', 'Honeysuckle', 'Ivy Gate', 'Lantern House', 'Bayberry', 'Primrose', 'Willowmere', 'Sweetgrass', 'Rosebay', 'Jessamine'],
};

/** Every brand stem the generator uses (tests check none is a real chain and none repeats within an area). */
export const BRAND_STEMS = Object.freeze([...new Set(Object.values(BRANDS).flat())]);

// Place names that are trademarks: 'Disney Copperleaf Suites' would read like an official park hotel.
const TRADEMARK_RE = /disney|universal|epcot|seaworld|opry|caesars|bellagio/i;

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/** Whole dollars ending in 9 ($189, $229), as US rates usually are. */
function priceEnding9(x) {
  return Math.max(59, Math.round(x / 10) * 10 - 1);
}

/** Largest-remainder split of `n` hotels over the 4 categories, with seeded wobble so areas differ. */
function categoryDeck(n, mix, rng) {
  const w = mix.map((m) => (m > 0 ? Math.max(0, m + (rng() - 0.5) * 0.16) : 0));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const exact = w.map((x) => (x / sum) * n);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  const deck = [];
  counts.forEach((c, i) => { for (let j = 0; j < c; j++) deck.push(CATS[i]); });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Hotel counts per area: kind weights scaled so each city ends up with 18–30 hotels. */
function areaCounts(city) {
  const weights = city.areas.map((a) => (KINDS[a.kind] || KINDS.shopping).count);
  const total = weights.reduce((a, b) => a + b, 0);
  const target = Math.min(30, Math.max(18, total));
  const exact = weights.map((w) => (w / total) * target);
  const counts = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = target - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  return counts;
}

/** The area as hotels are named after it: 'Times Square', 'Las Vegas Strip' (not 'The Strip'). */
function placeName(city, area) {
  return area.short.startsWith('The ') ? `${city.name.replace(/ DC$/, '')} ${area.short.slice(4)}` : area.short;
}

/** @returns {{ brand: string, list: string[] }} the brand stem drawn and the name patterns using it */
function nameCandidates(rng, { city, area, category, inn, resort }) {
  const place = TRADEMARK_RE.test(placeName(city, area)) ? city.name : placeName(city, area);
  const cityName = city.name.replace(/ DC$/, '');
  if (inn && category !== 'luxury') {
    const b = pick(rng, BRANDS.inn);
    if (category === 'upscale') return { brand: b, list: [`The ${b} Inn`, `${b} Manor`, `The ${b} Courtyard Hotel`] };
    return { brand: b, list: [`${b} Inn`, `${b} Bed & Breakfast`, `The ${b} Guesthouse`, `${b} House ${place}`] };
  }
  const b = pick(rng, BRANDS[category]);
  const list = (() => {
    switch (category) {
      case 'budget':
        return area.kind === 'airport'
          ? [`${b} Airport Inn`, `${b} Inn ${place}`, `${b} Stay ${place}`]
          : [`${b} Inn ${place}`, `${b} Stay ${place}`, `${b} Inn & Suites ${place}`, `${b} Lodge ${place}`];
      case 'midscale':
        return [`${b} Hotel ${place}`, `${b} Suites ${place}`, `Hotel ${b} ${place}`, `${b} ${place}`];
      case 'upscale':
        return resort
          ? [`${b} Resort ${place}`, `The ${b} ${place}`, `${b} House ${place}`]
          : [`The ${b} ${place}`, `${b} House ${place}`, `The ${b} Hotel ${cityName}`, `${b} ${cityName}`];
      default:
        if (inn) return [`The ${b} ${place}`, `${b} House ${place}`];
        return resort
          ? [`The ${b} Resort & Spa`, `${b} Resort ${place}`, `The ${b} ${place}`]
          : [`The ${b}`, `The ${b} ${cityName}`, `${b} Grand ${place}`];
    }
  })();
  return { brand: b, list };
}

/** Unique within the city, and no brand stem twice in one area ('Copperleaf Suites SoHo' next to 'Copperleaf SoHo'). */
function uniqueName(rng, ctx, used, areaBrands) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { brand, list } = nameCandidates(rng, ctx);
    const name = list[Math.floor(rng() * list.length)];
    if (!used.has(name) && (attempt >= 40 || !areaBrands.has(brand))) {
      used.add(name);
      areaBrands.add(brand);
      return name;
    }
  }
  const fallback = `${nameCandidates(rng, ctx).list[0]} ${used.size}`;
  used.add(fallback);
  return fallback;
}

function makeAmenities(rng, { category, kind, area, inn, city }) {
  const out = new Set();
  const add = (x, p = 1) => { if (rng() < p) out.add(x); };
  const f = area.features;
  const warm = WARM_CITIES.has(city.code);
  const urban = f.includes('subway');
  const upscale = category === 'upscale' || category === 'luxury';
  const pool = kind.resort || warm ? 'Outdoor pool' : 'Indoor pool';
  // Historic inns and B&Bs have no gym, big pool or meeting rooms: they are converted townhouses.
  if (inn && category !== 'luxury') {
    add('Free Wi-Fi'); add('Luggage storage'); add('Historic building', 0.85); add('Courtyard', 0.6); add('Garden', 0.4);
    add('Concierge', category === 'upscale' ? 0.6 : 0.2); add('Bicycle rentals', 0.3);
    if (category === 'budget') add('Free breakfast', 0.7);
    else if (category === 'midscale') { add('Free breakfast', 0.6); add('Laundry service', 0.3); }
    else { add('Bar', 0.6); add('Restaurant', 0.4); add('Laundry service', 0.5); add('Courtyard pool', 0.25); }
  } else {
    add('Free Wi-Fi'); add('24-hour front desk'); add('Luggage storage');
    if (category === 'budget') {
      add('Free breakfast', 0.6); add('Guest laundry', 0.5); add(pool, warm ? 0.4 : 0.15); add('Fitness center', 0.3);
    } else if (category === 'midscale') {
      add('Fitness center'); add('Free breakfast', 0.55); add(pool, warm || kind.resort ? 0.65 : 0.35); add('Guest laundry', 0.5);
      add('Business center', 0.4); add('Bar', 0.35); add('Kitchenette', 0.25);
    } else if (category === 'upscale') {
      add('Fitness center'); add('Restaurant'); add('Bar'); add('Room service', 0.6); add('Meeting rooms', 0.6); add('Business center', 0.5);
      add('Concierge', 0.5); add(pool, kind.resort ? 0.95 : warm ? 0.65 : 0.35); add('Rooftop bar', f.includes('night') || f.includes('skyline') ? 0.35 : 0);
      add('Spa', kind.resort ? 0.5 : 0.2);
    } else {
      add('Fitness center'); add('Spa'); add(pool); add('Restaurant'); add('Bar'); add('Room service'); add('Concierge');
      add('Club lounge', 0.6); add('Airport transfers', 0.5); add('Rooftop bar', f.includes('night') || f.includes('skyline') ? 0.4 : 0);
    }
  }
  if (f.includes('sea') && (upscale || kind.resort)) add('Beach access', kind.resort ? 0.6 : 0.3);
  if (f.includes('family') || kind.resort) { add("Kids' club", upscale ? 0.5 : 0.1); add('Family rooms', 0.5); }
  else if (category !== 'budget') add('Family rooms', 0.2);
  if (area.landmarks.some((l) => l.type === 'Theme park')) add('Theme park shuttle', 0.7);
  if (area.kind === 'airport') add('Free airport shuttle', 0.8);
  if (city.code === 'lv' && (area.kind === 'resort' || area.kind === 'oldtown')) add('Casino', category === 'budget' ? 0.4 : 0.75);
  // Probabilities go to 0 rather than skipping a draw, so every hotel consumes the same random stream.
  if (area.kind === 'airport') add('Free parking', inn ? 0 : 0.6);
  else if (urban || upscale) add(upscale ? 'Valet parking' : 'Self parking', inn ? 0 : 0.8);
  else add('Free parking', inn ? 0.3 : 0.8);
  add('Pet friendly', 0.3);
  add('EV charging', upscale ? 0.35 : 0.1);
  return [...out];
}

const VIEWS = [['sea', 'Ocean view'], ['harbor', 'Harbor view'], ['bay', 'Bay view'], ['lake', 'Lake view'], ['river', 'River view'], ['park', 'Park view'],
  ['mountain', 'Mountain view'], ['skyline', 'City view']];

function makeTags(rng, { category, area, amenities, openedYear, inn }) {
  const tags = [];
  const f = area.features;
  const upscale = category === 'upscale' || category === 'luxury';
  const add = (t, p) => { if (tags.length < 4 && !tags.includes(t) && rng() < p) tags.push(t); };
  // A view tag only where a view room exists (budget templates have none), and at most one, since the view
  // room is named after it. p = 0 instead of skipping keeps the random stream for later tags.
  const canView = category !== 'budget';
  for (const [feature, tag] of VIEWS) {
    if (!f.includes(feature)) continue;
    const p = feature === 'sea' || feature === 'harbor' ? (upscale ? 0.8 : 0.4) : feature === 'skyline' ? (upscale ? 0.5 : 0.2) : upscale ? 0.6 : 0.3;
    add(tag, canView && !tags.some((x) => / view$/.test(x)) ? p : 0);
  }
  if (openedYear >= NEWEST_YEAR) add('Newly opened', 1);
  if (area.kind === 'station') add('Near the station', 0.9);
  if (area.kind === 'airport') add('Near the airport', 0.9);
  if (amenities.includes('Free airport shuttle')) add('Free airport shuttle', 0.9);
  if (amenities.includes('Family rooms') || f.includes('family')) add('Family-friendly', 0.7);
  if (f.includes('subway')) add('Near transit', 0.6);
  if (area.kind === 'scenic' || area.kind === 'oldtown' || area.kind === 'inn') add('Walk to sights', 0.45);
  if (inn && amenities.includes('Historic building')) add('Historic', 0.6);
  if (amenities.includes('Casino')) add('Casino', 0.5);
  if (f.includes('quiet')) add('Quiet', 0.5);
  if (f.includes('night')) add('Trendy', 0.3);
  if (area.kind === 'cbd') add('Business-friendly', 0.45);
  if (amenities.some((a) => / pool$/i.test(a))) add('Pool', 0.35);
  if (amenities.includes('Free breakfast')) add('Free breakfast', 0.6);
  if (amenities.includes('Free parking')) add('Free parking', 0.5);
  if (category === 'upscale' && ['shopping', 'oldtown', 'nightlife'].includes(area.kind)) add('Boutique', 0.3);
  if (category === 'budget') add('Great value', 0.35);
  if (!tags.length) tags.push(upscale ? 'Great service' : 'Spotless');
  return tags;
}

function makeHotel(city, area, category, index, used, areaBrands) {
  const id = `sim-${city.code}-${String(index).padStart(3, '0')}`;
  const rng = mulberry32(hashString(`${id}|${area.name}|${category}`));
  const kind = KINDS[area.kind] || KINDS.shopping;
  const inn = !!kind.inn;

  const [b0, b1] = area.bearings;
  const bearing = b0 + rng() * (b1 - b0);
  const dist = 150 + (area.spreadM - 150) * rng() ** 1.15;
  const location = offsetPoint(area.center, dist, bearing % 360);

  const name = uniqueName(rng, { city, area, category, inn, resort: !!kind.resort }, used, areaBrands);

  const [rLo, rHi] = RATING[category];
  const rating = round1(rLo + (rHi - rLo) * rng() ** 0.7);

  const [yLo, yHi] = YEARS[category];
  const openedYear = rng() < 0.12 ? Math.min(yHi, NEWEST_YEAR) : yLo + Math.floor(rng() * (yHi - yLo + 1));

  const [cLo, cHi] = REVIEWS[category];
  const age = Math.max(1, NEWEST_YEAR + 1 - openedYear);
  const reviewCount = Math.max(36, Math.round((cLo + (cHi - cLo) * rng()) * Math.min(1, 0.2 + age / 8)));

  const [pLo, pHi] = PRICE_RANGES[category];
  const ratingLift = 0.94 + 0.12 * ((rating - rLo) / (rHi - rLo || 1));
  const priceHint = priceEnding9((pLo + (pHi - pLo) * rng() ** 1.25) * kind.priceFactor * ratingLift * (city.priceLevel || 1));

  const amenities = makeAmenities(rng, { category, kind, area, inn, city });
  const tags = makeTags(rng, { category, area, amenities, openedYear, inn });
  // Fictional numbers only: 555-0100 to 555-0199 are reserved for fiction.
  const tel = rng() < 0.1 ? '' : `(${city.areaCode}) 555-01${String(Math.floor(rng() * 100)).padStart(2, '0')}`;
  const near = area.short === area.district ? '' : `Near ${area.short}, `;

  return {
    id,
    name,
    city: city.name,
    state: city.state,
    district: area.district,
    address: `${near}${area.district}, ${city.fullName} (simulated address)`,
    location,
    tel,
    rating,
    reviewCount,
    openedYear,
    amenities,
    category,
    businessArea: area.name,
    tags,
    photos: [],
    priceHint,
    timeZone: city.zone,
    source: 'sim',
  };
}

function freezeHotel(h) {
  Object.freeze(h.location);
  Object.freeze(h.amenities);
  Object.freeze(h.tags);
  Object.freeze(h.photos);
  return Object.freeze(h);
}

/** All fictional hotels of one city (stable order and ids). Pure: no caching here. */
export function generateHotels(city) {
  const counts = areaCounts(city);
  const used = new Set();
  const hotels = [];
  let index = 1;
  city.areas.forEach((area, ai) => {
    const kind = KINDS[area.kind] || KINDS.shopping;
    const deckRng = mulberry32(hashString(`deck|${city.code}|${area.name}`));
    const areaBrands = new Set();
    for (const category of categoryDeck(counts[ai], kind.mix, deckRng)) {
      hotels.push(freezeHotel(makeHotel(city, area, category, index++, used, areaBrands)));
    }
  });
  return Object.freeze(hotels);
}
