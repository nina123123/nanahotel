import { distanceM } from '../util/geo.js';
import { todayIn, earliestCheckIn, checkStay, resolveTimeZone } from '../util/dates.js';
import { HotelError } from './hotels/index.js';
import * as simPricing from './hotels/pricing.js';

/**
 * City guide over the supplier's neighborhoods and landmarks: "where is X", "what's near Y", "which area should I
 * stay in". Only real places from the guide; no weather, opening hours or other live facts.
 */

const NEARBY_RADIUS_M = 3200;

/** Generic words → which guide entries they should surface ('train station' → stations, 'museums' → museums …). */
const TYPE_HINTS = [
  [/\b(?:train|amtrak|rail|station|union station)\b/, (p) => p.type === 'Transit hub' && /station/i.test(p.name)],
  [/\b(?:airport|terminal|flight|fly|flying)\b/, (p) => p.type === 'Transit hub' && /airport/i.test(p.name)],
  [/\b(?:cruise|ferry|ferries|port)\b/, (p) => p.type === 'Transit hub' && /cruise|ferry|pier|port/i.test(p.name)],
  [/\b(?:transit|transport|getting around|subway|metro)\b/, (p) => p.type === 'Transit hub'],
  [/\b(?:sights?|sightseeing|attractions?|things to do|landmarks?|must see|famous|tourist)\b/, (p) => p.type === 'Sight' || p.type === 'Landmark'],
  [/\b(?:museums?|galler(?:y|ies)|exhibits?|art)\b/, (p) => p.type === 'Museum'],
  [/\b(?:conventions?|conference|expo|trade show)\b/, (p) => p.type === 'Convention center'],
  [/\b(?:beach(?:es)?|ocean|swim|surf|sand)\b/, (p) => p.type === 'Beach'],
  [/\b(?:theme parks?|amusement|rides|kids|family|children)\b/, (p) => p.type === 'Theme park'],
  // Food streets first; nightlife strips and neighborhoods known for their restaurants count too.
  [/\b(?:food|eat|eating|restaurants?|dining|dinner|lunch|brunch|market)\b/, (p) => p.type === 'Food & drink' || p.type === 'Nightlife' || /restaurant|food|dining|caf[eé]s|brunch/i.test(p.text || '')],
  [/\b(?:shop|shopping|mall|stores?|boutiques?)\b/, (p) => p.type === 'Shopping'],
  [/\b(?:nightlife|bars?|music|jazz|clubs?|drinks?|live music)\b/, (p) => p.type === 'Nightlife'],
  [/\b(?:universit(?:y|ies)|college|campus)\b/, (p) => p.type === 'University'],
  [/\b(?:stadium|arena|game|ballpark|sports?|concert)\b/, (p) => p.type === 'Stadium'],
  [/\b(?:parks?|walk|walking|gardens?|outdoors|hike|hiking)\b/, (p) => p.type === 'Park'],
  [/\b(?:neighborhoods?|areas?|where to stay|districts?)\b/, (p) => p.type === 'Neighborhood'],
];

// On equal scores, sights beat hubs, and hubs beat malls.
const TYPE_PRIORITY = {
  Sight: 3, 'Theme park': 3, Museum: 3, Beach: 3, Park: 3, 'Transit hub': 2, 'Food & drink': 2, Nightlife: 2, Landmark: 2,
  Neighborhood: 1, Shopping: 1, University: 1, 'Convention center': 1, Stadium: 1,
};

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
}

function compact(s) {
  return norm(s).replace(/[^a-z0-9&]+/g, '');
}

/**
 * @param {{ supplier, pricing?: { lowestNightly }, clock?: { now: () => Date } }} deps  pricing defaults to the
 *        simulator's, the same default the hotel service uses
 */
export function createPlacesService({ supplier, pricing = simPricing, clock = { now: () => new Date() } } = {}) {
  if (!supplier) throw new Error('createPlacesService: supplier is required');

  function requireCity(cityText) {
    const raw = String(cityText || '').trim();
    if (!raw) throw new HotelError('city_required', 'Which city is it?');
    const city = supplier.resolveCity(raw);
    if (!city) {
      const names = supplier.listCities().map((c) => c.name).join(', ');
      throw new HotelError('city_not_supported', `The demo covers ${names}. "${raw}" isn't covered yet`, { city: raw });
    }
    return city;
  }

  function guide(city) {
    const areas = typeof supplier.listAreas === 'function' ? supplier.listAreas(city.name) : [];
    const hotels = supplier.searchHotels({ city: city.name });
    return { areas, hotels };
  }

  function nearbyCount(hotels, location, extentM = 0) {
    return hotels.filter((h) => (distanceM(h.location, location) ?? Infinity) <= NEARBY_RADIUS_M + extentM).length;
  }

  /** @returns {Array<{ name, area, type, location, nearbyHotelCount, district, reason? }>} */
  function searchPlaces({ city, keyword, limit = 8 } = {}) {
    const c = requireCity(city);
    const { areas, hotels } = guide(c);
    const max = Math.min(20, Math.max(1, Math.round(Number(limit) || 8)));
    const cityWords = [c.name, c.fullName].map(norm);
    let text = norm(keyword).replace(/\b(?:near|nearby|around|in|the|best|good|top|any|some|what are|where is|where's|how about)\b/g, ' ');
    for (const w of cityWords) text = text.replace(w, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    const q = compact(text);

    const entries = [];
    for (const a of areas) {
      entries.push({ name: a.name, area: a.name, type: 'Neighborhood', location: a.location, district: a.district, reason: a.reason, keys: [a.name, ...a.name.split(' / '), a.short, ...a.aliases], parentKeys: [], text: a.reason });
      for (const l of a.landmarks) {
        entries.push({ name: l.name, area: a.name, type: l.type, location: l.location, extentM: l.extentM || 0, district: l.district || a.district, keys: [l.name, ...l.aliases], parentKeys: [a.name, ...a.name.split(' / '), a.short, ...a.aliases], text: a.reason });
      }
    }

    const typeTests = TYPE_HINTS.filter(([re]) => re.test(text)).map(([, test]) => test);
    // A short word on its own ('zoo', 'pier') still finds 'San Diego Zoo' as a whole word.
    const wordRe = text.length >= 3 && /^[a-z0-9' ]+$/.test(text) ? new RegExp(`(?:^|[^a-z0-9])${text}(?:$|[^a-z0-9])`) : null;
    const scored = [];
    for (const e of entries) {
      const keys = e.keys.map(compact).filter(Boolean);
      const parents = e.parentKeys.map(compact).filter(Boolean);
      let score = 0;
      if (!q) score = e.type === 'Neighborhood' ? 50 : 0;
      else if (keys.includes(q)) score = 100;
      else if (keys.some((k) => k.length >= 4 && (k.startsWith(q) || q.includes(k)))) score = 80;
      else if ((q.length >= 4 && keys.some((k) => k.includes(q))) || (wordRe && e.keys.some((k) => wordRe.test(norm(k))))) score = 60;
      else if (typeTests.some((t) => t(e))) score = 45;
      else if (parents.some((k) => k.length >= 4 && (k === q || q.includes(k) || (q.length >= 4 && k.includes(q))))) score = 35;
      else if (q.length >= 4 && compact(e.text).includes(q)) score = 20;
      if (score > 0) scored.push({ e, score });
    }

    const seen = new Set();
    return scored
      .map(({ e, score }) => ({ e, score, count: nearbyCount(hotels, e.location, e.extentM) }))
      .sort((a, b) => b.score - a.score || (TYPE_PRIORITY[b.e.type] || 0) - (TYPE_PRIORITY[a.e.type] || 0) || b.count - a.count)
      .filter(({ e }) => (seen.has(e.name) ? false : seen.add(e.name)))
      .slice(0, max)
      .map(({ e, count }) => ({
        name: e.name,
        area: e.area,
        type: e.type,
        location: { ...e.location },
        nearbyHotelCount: count,
        district: e.district,
        ...(e.type === 'Neighborhood' ? { reason: e.reason } : {}),
      }));
  }

  /**
   * Where-to-stay advice: every area with its landmarks, simulated hotel count and a "from" price.
   * With dates, priceFrom is the cheapest bookable nightly price (taxes and fees included) for that stay, seasons and
   * holidays included (null when all sold out), and priceBasis is 'dates'. Without dates it is the weekday room rate
   * before taxes and priceBasis is 'weekday'. `timeZone` is the user's zone, for a stay starting "tonight".
   */
  function listAreas(city, { checkIn, checkOut, adults, rooms, children, timeZone } = {}) {
    const c = requireCity(city);
    const { areas, hotels } = guide(c);
    let stay = null;
    if (checkIn || checkOut) {
      const now = clock.now();
      const zone = resolveTimeZone(c.zone);
      const s = checkStay(checkIn, checkOut, todayIn(zone, now), {
        allowDefaults: !!checkIn || !!checkOut, earliestCheckIn: earliestCheckIn(now, zone), defaultCheckIn: timeZone ? earliestCheckIn(now, resolveTimeZone(timeZone)) : undefined,
      });
      if (s.error) throw new HotelError('invalid_dates', s.error);
      stay = { checkIn: s.checkIn, checkOut: s.checkOut, adults: adults ?? 2, rooms: rooms ?? 1, children: children ?? 0, city: c, now };
    }
    return areas.map((a) => {
      const inArea = hotels.filter((h) => h.businessArea === a.name);
      const prices = stay
        ? inArea.map((h) => pricing.lowestNightly(h, stay)).filter(Number.isFinite)
        : inArea.map((h) => h.priceHint).filter(Number.isFinite);
      return {
        name: a.name,
        district: a.district,
        reason: a.reason,
        location: { ...a.location },
        landmarks: a.landmarks.map((l) => l.name),
        hotelCount: inArea.length,
        priceFrom: prices.length ? Math.min(...prices) : null,
        priceBasis: stay ? 'dates' : 'weekday',
        ...(stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut } : {}),
      };
    });
  }

  return { searchPlaces, listAreas };
}
