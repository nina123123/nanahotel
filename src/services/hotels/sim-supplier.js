import { CITIES, findCity } from './sim-cities.js';
import { generateHotels } from './sim-hotels.js';
import { hotelMatchesKeyword, parseKeyword } from './supplier.js';
import { distanceM } from '../../util/geo.js';

/**
 * Simulated hotel supplier: real cities/areas/landmarks (sim-cities.js) + generated fictional hotels.
 * Implements the HotelSupplier interface documented in supplier.js.
 */

const PREFIXES = ['靠近', '离', '近', '在', '去', '到', '住'];
// A city name followed by one of these is a street ('广州北京路', '上海南京东路', '长安街'), not that city.
const STREET_AFTER = /^[东西南北中]?(?:路|街|大街|大道|巷)/;
const SUFFIXES = ['的酒店', '酒店', '的', '附近', '旁边', '周边', '周围', '一带', '那边', '这边', '边上', '对面', '近一点', '近点', '步行可达', '风景区', '景区', '里面', '旁', '边', '里', '内'];

function norm(text) {
  return String(text || '').trim().toLowerCase().replace(/[\s"'“”‘’。，,!！?？]+/g, '');
}

function stripAffixes(q) {
  let s = q;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of PREFIXES) {
      if (s.length > p.length + 1 && s.startsWith(p)) { s = s.slice(p.length); changed = true; }
    }
    for (const x of SUFFIXES) {
      if (s.length > x.length + 1 && s.endsWith(x)) { s = s.slice(0, -x.length); changed = true; }
    }
  }
  return s;
}

function cityInfo(c) {
  return { code: c.code, name: c.name, fullName: c.fullName, tier: c.tier, center: { ...c.center }, season: c.season ? [...c.season] : null };
}

function areaKeys(area) {
  return [area.name, ...area.name.split(/[/·]/), area.short, ...area.aliases].map(norm).filter(Boolean);
}

function landmarkKeys(lm) {
  return [lm.name, ...lm.aliases].map(norm).filter(Boolean);
}

function placeFromLandmark(lm, area, matched) {
  return { name: lm.name, location: { ...lm.location }, area: area.name, type: lm.type, extentM: lm.extentM || 0, matched };
}

function placeFromArea(area, matched) {
  return { name: area.name, location: { ...area.center }, area: area.name, type: '商圈', extentM: 0, matched };
}

/** Exact, then containment matching of `variants` against one city's landmarks and areas. */
function matchPlace(city, variants) {
  for (const v of variants) {
    for (const area of city.areas) {
      for (const lm of area.landmarks) if (landmarkKeys(lm).includes(v)) return placeFromLandmark(lm, area, 'exact');
    }
    for (const area of city.areas) if (areaKeys(area).includes(v)) return placeFromArea(area, 'exact');
  }
  // Containment: '西湖断桥那边的' contains '断桥'; prefer the longest key so '杭州东站' beats '东站'.
  let best = null;
  const consider = (key, make) => {
    if (key.length < 2) return;
    for (const v of variants) {
      if (v.length < 2) continue;
      const score = v.includes(key) ? key.length * 2 : key.includes(v) ? v.length : 0;
      if (score && (!best || score > best.score)) best = { score, make };
    }
  };
  for (const area of city.areas) {
    for (const lm of area.landmarks) for (const k of landmarkKeys(lm)) consider(k, () => placeFromLandmark(lm, area, 'partial'));
    for (const k of areaKeys(area)) consider(k, () => placeFromArea(area, 'partial'));
  }
  return best ? best.make() : null;
}

export function createSimSupplier({ cities = CITIES } = {}) {
  const hotelCache = new Map();

  function hotelsOf(city) {
    let list = hotelCache.get(city.code);
    if (!list) {
      list = generateHotels(city);
      hotelCache.set(city.code, list);
    }
    return list;
  }

  function cityRecord(text) {
    const exact = findCity(text, cities);
    if (exact) return exact;
    const q = norm(text);
    if (!q) return null;
    // '去杭州玩' / '杭州西湖' → the city whose name or alias appears earliest in the text (longest on a tie),
    // skipping street names so '广州北京路' is 广州.
    let best = null;
    for (const c of cities) {
      for (const key of [c.name, ...c.aliases.filter((a) => /[一-龥]{2,}/.test(a))]) {
        const k = key.toLowerCase();
        for (let at = q.indexOf(k); at !== -1; at = q.indexOf(k, at + 1)) {
          if (STREET_AFTER.test(q.slice(at + k.length))) continue;
          if (!best || at < best.at || (at === best.at && k.length > best.len)) best = { city: c, at, len: k.length };
          break;
        }
      }
    }
    if (best) return best.city;
    // A bare landmark ('鼓浪屿', '外滩') identifies its city when only one city has it.
    const variants = [...new Set([q, stripAffixes(q)])];
    const hits = cities.filter((c) => {
      const p = matchPlace(c, variants);
      return p && p.matched === 'exact';
    });
    return hits.length === 1 ? hits[0] : null;
  }

  function resolveCity(text) {
    const c = cityRecord(text);
    return c ? cityInfo(c) : null;
  }

  function resolveLandmark(cityText, text) {
    const city = cityRecord(cityText);
    const q = norm(text);
    if (!city || !q) return null;
    // '杭州' / '杭州市区' as a place means "anywhere in the city", not the first landmark containing it.
    const cityNames = [city.name, city.fullName, ...city.aliases].map(norm);
    if (cityNames.includes(q) || cityNames.includes(stripAffixes(q)) || cityNames.some((n) => q === `${n}市区`)) return null;
    const variants = [q, stripAffixes(q)];
    for (const name of [city.name, ...city.aliases.map(norm)]) {
      for (const v of [q, stripAffixes(q)]) {
        if (name.length >= 2 && v.startsWith(name) && v.length > name.length + 1) variants.push(stripAffixes(v.slice(name.length)));
      }
    }
    return matchPlace(city, [...new Set(variants)]);
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
      const { tokens, categories: kwCats } = parseKeyword(keyword, { ignore: [c.name, c.fullName] });
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
    listCities: () => cities.map((c) => ({ name: c.name, tier: c.tier })),
    resolveCity,
    resolveLandmark,
    listAreas,
    searchHotels,
    getHotel,
  };
}
