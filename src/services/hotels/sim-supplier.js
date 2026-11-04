import { CITIES, findCity, normCityText } from './sim-cities.js';
import { generateHotels } from './sim-hotels.js';
import { hotelMatchesKeyword, parseKeyword } from './supplier.js';
import { distanceM } from '../../util/geo.js';

/**
 * Simulated hotel supplier: real cities, neighborhoods and landmarks (sim-cities.js) + generated fictional hotels.
 * Implements the HotelSupplier interface documented in supplier.js.
 */

// Words around a place name that are not part of it: 'near the Strip', 'Times Square area', 'close to JFK'.
const LEAD_WORDS = ['walking distance to', 'walking distance from', 'within walking distance of', 'close to', 'next to', 'right by',
  'near', 'nearby', 'around', 'by', 'in', 'at', 'on', 'to', 'the', 'a', 'an'];
const TRAIL_WORDS = ['area', 'district', 'neighborhood', 'neighbourhood', 'hotel', 'hotels', 'nearby', 'vicinity', 'region', 'please'];

/** Lower case, curly quotes straightened, punctuation to spaces (keeps & ' . - inside names). */
function words(text) {
  return normCityText(text).replace(/[^a-z0-9&'.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The comparable form of a name: 'Fisherman’s Wharf' → 'fishermanswharf'. */
function compact(text) {
  return normCityText(text).replace(/[^a-z0-9&]+/g, '');
}

function stripAffixes(text) {
  let s = ` ${words(text)} `;
  for (let changed = true; changed;) {
    changed = false;
    for (const w of LEAD_WORDS) {
      if (s.startsWith(` ${w} `) && s.trim().length > w.length + 2) { s = s.slice(w.length + 1); changed = true; }
    }
    for (const w of TRAIL_WORDS) {
      if (s.endsWith(` ${w} `) && s.trim().length > w.length + 2) { s = s.slice(0, -(w.length + 1)); changed = true; }
    }
  }
  return s.trim();
}

/** True when `phrase` (words) appears in `text` (words) on word boundaries. */
function hasPhrase(text, phrase) {
  return Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);
}

function cityInfo(c) {
  return {
    code: c.code, name: c.name, state: c.state, fullName: c.fullName, zone: c.zone, market: c.market, areaCode: c.areaCode,
    priceLevel: c.priceLevel, tax: { ...c.tax }, weekdays: [...c.weekdays], center: { ...c.center }, season: c.season ? [...c.season] : null,
  };
}

function areaKeys(area) {
  return [area.name, ...area.name.split(' / '), area.short, ...area.aliases];
}

function landmarkKeys(lm) {
  return [lm.name, ...lm.aliases];
}

function placeFromLandmark(lm, area, matched) {
  return { name: lm.name, location: { ...lm.location }, area: area.name, type: lm.type, extentM: lm.extentM || 0, matched };
}

function placeFromArea(area, matched) {
  return { name: area.name, location: { ...area.center }, area: area.name, type: 'Neighborhood', extentM: 0, matched };
}

/**
 * Exact, then containment matching of the query against one city's landmarks and areas. `variants` are spaced
 * word strings: an exact hit compares compact forms ('fishermans wharf' = "Fisherman's Wharf"); containment needs
 * a whole-word phrase ('the times square subway station' contains 'times square'), longest first.
 */
function matchPlace(city, variants) {
  const compacts = variants.map(compact).filter(Boolean);
  for (const v of compacts) {
    for (const area of city.areas) {
      for (const lm of area.landmarks) if (landmarkKeys(lm).some((k) => compact(k) === v)) return placeFromLandmark(lm, area, 'exact');
    }
    for (const area of city.areas) if (areaKeys(area).some((k) => compact(k) === v)) return placeFromArea(area, 'exact');
  }
  let best = null;
  const consider = (key, make) => {
    const k = words(key);
    if (compact(k).length < 3) return;
    for (const v of variants) {
      const cv = compact(v);
      if (cv.length < 3) continue;
      // The key inside the query scores by its length; the query inside a long key (a fragment) a little less.
      const score = hasPhrase(v, k) ? compact(k).length * 2 : cv.length >= 4 && hasPhrase(k, v) ? cv.length : 0;
      if (score && (!best || score > best.score)) best = { score, make };
    }
  };
  for (const area of city.areas) {
    for (const lm of area.landmarks) for (const k of landmarkKeys(lm)) consider(k, () => placeFromLandmark(lm, area, 'partial'));
    for (const k of areaKeys(area)) consider(k, () => placeFromArea(area, 'partial'));
  }
  return best ? best.make() : null;
}

/**
 * Multi-word place names of every city with the cities that have them, longest first (for telling 'Washington
 * Square Park' from Washington DC). A name several cities share ('Union Station') lists all of them.
 */
function placePhrases(cities) {
  const byPhrase = new Map();
  for (const c of cities) {
    for (const area of c.areas) {
      for (const k of [...areaKeys(area), ...area.landmarks.flatMap(landmarkKeys)]) {
        const w = words(k);
        if (!w.includes(' ')) continue;
        const list = byPhrase.get(w) || [];
        if (!list.includes(c)) list.push(c);
        byPhrase.set(w, list);
      }
    }
  }
  return [...byPhrase].map(([phrase, list]) => ({ phrase, cities: list })).sort((a, b) => b.phrase.length - a.phrase.length);
}

export function createSimSupplier({ cities = CITIES } = {}) {
  const hotelCache = new Map();
  const phrases = placePhrases(cities);

  function hotelsOf(city) {
    let list = hotelCache.get(city.code);
    if (!list) {
      list = generateHotels(city);
      hotelCache.set(city.code, list);
    }
    return list;
  }

  /** The cities whose landmark or area `text` names exactly (compact forms). */
  function exactPlaceCities(text) {
    const variants = [...new Set([words(text), stripAffixes(text)])];
    return cities.filter((c) => matchPlace(c, variants)?.matched === 'exact');
  }

  function cityRecord(text) {
    const exact = findCity(text, cities);
    if (exact) return exact;
    const q = words(text);
    if (!q) return null;
    // A bare landmark or neighborhood ('La Jolla', 'Miami Beach', 'the Strip') identifies its city when only one has it.
    const named = exactPlaceCities(text);
    if (named.length === 1) return named[0];
    // Place names that contain a city word are taken out first, so 'Washington Square Park in New York' is New York.
    let rest = ` ${q} `;
    const placeCities = [];
    for (const { phrase, cities: owners } of phrases) {
      if (rest.includes(` ${phrase} `)) {
        rest = rest.split(` ${phrase} `).join(' , ');
        for (const city of owners) if (!placeCities.includes(city)) placeCities.push(city);
      }
    }
    // 'going to vegas next week' → the city whose name or alias appears earliest (the longest on a tie).
    let best = null;
    for (const c of cities) {
      for (const key of [c.name.toLowerCase(), ...c.aliases]) {
        const k = words(key);
        if (!k) continue;
        const at = rest.indexOf(` ${k} `);
        if (at === -1) continue;
        if (!best || at < best.at || (at === best.at && k.length > best.len)) best = { city: c, at, len: k.length };
      }
    }
    if (best) return best.city;
    return placeCities.length === 1 ? placeCities[0] : null;
  }

  function resolveCity(text) {
    const c = cityRecord(text);
    return c ? cityInfo(c) : null;
  }

  function resolveLandmark(cityText, text) {
    const city = cityRecord(cityText);
    const q = words(text);
    if (!city || !q) return null;
    // 'New York' / 'Downtown New York' as a place means "anywhere in the city", not the first landmark containing it.
    const cityNames = [city.name.toLowerCase(), city.fullName.toLowerCase(), ...city.aliases].map(words);
    const stripped = stripAffixes(q);
    if (cityNames.includes(q) || cityNames.includes(stripped)) return null;
    const variants = [q, stripped];
    for (const name of cityNames) {
      for (const v of [q, stripped]) {
        if (name.length >= 2 && v.startsWith(`${name} `) && v.length > name.length + 2) variants.push(stripAffixes(v.slice(name.length + 1)));
        if (name.length >= 2 && v.endsWith(` ${name}`) && v.length > name.length + 2) variants.push(stripAffixes(v.slice(0, -(name.length + 1))));
      }
    }
    return matchPlace(city, [...new Set(variants)].filter(Boolean));
  }

  function listAreas(cityText) {
    const city = cityRecord(cityText);
    if (!city) return [];
    return city.areas.map((a) => ({
      name: a.name,
      short: a.short,
      aliases: [...a.aliases],
      district: a.district,
      kind: a.kind,
      reason: a.reason,
      location: { ...a.center },
      features: [...a.features],
      landmarks: a.landmarks.map((l) => ({
        name: l.name, type: l.type, location: { ...l.location }, aliases: [...l.aliases], extentM: l.extentM || 0, district: l.district || a.district,
      })),
    }));
  }

  function searchHotels({ city, keyword, location, radiusM, categories } = {}) {
    const c = cityRecord(city);
    if (!c) return [];
    let list = hotelsOf(c);
    if (location && Number.isFinite(radiusM)) list = list.filter((h) => (distanceM(h.location, location) ?? Infinity) <= radiusM);
    if (Array.isArray(categories) && categories.length) list = list.filter((h) => categories.includes(h.category));
    if (keyword) {
      const { tokens, categories: kwCats } = parseKeyword(keyword, { ignore: [c.name.toLowerCase(), ...c.aliases] });
      if (kwCats.length) list = list.filter((h) => kwCats.includes(h.category));
      list = list.filter((h) => hotelMatchesKeyword(h, tokens));
    }
    return [...list];
  }

  function getHotel(id) {
    const m = /^sim-([a-z]+)-\d{3}$/.exec(String(id || '').trim());
    if (!m) return null;
    const city = cities.find((c) => c.code === m[1]);
    if (!city) return null;
    return hotelsOf(city).find((h) => h.id === id.trim()) || null;
  }

  return {
    source: 'sim',
    listCities: () => cities.map((c) => ({ name: c.name, state: c.state, zone: c.zone, market: c.market })),
    resolveCity,
    resolveLandmark,
    listAreas,
    searchHotels,
    getHotel,
  };
}
