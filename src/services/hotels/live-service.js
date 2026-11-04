/**
 * The hotel service over a live supplier (LiteAPI, src/live/liteapi.js): the same results as createHotelService
 * (index.js) gives over the simulator — search results, room offers and price checks with the same fields — but
 * every method is async, prices come from the supplier (cents, USD) and nothing is simulated. Ranking, budget and
 * keyword handling are the simulator service's own (shared helpers in index.js).
 */
import { todayIn, earliestCheckIn, checkStay, formatDate, formatRange, DEFAULT_TIME_ZONE, resolveTimeZone } from '../../util/dates.js';
import { normalizeCategory, parseKeyword, hotelMatchesKeyword, RATE_TOKENS, CATEGORY_LABELS } from './supplier.js';
import { HotelError, partyText, rankHotels, applyBudget, keywordNotes, radiusMilesOf, partyOf, sellsBreakfast, M_PER_MILE, MAX_RADIUS_M, miles } from './index.js';
import { BookingError } from '../bookings.js';

/** Each state's main time zone (a hotel's own zone decides "tonight" and the cancellation deadlines shown). */
const STATE_ZONES = Object.freeze({
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico',
});

/** A US time zone from a place's state, else roughly from its longitude (good enough for the lower 48). */
export function usZoneOf({ state, location } = {}) {
  const byState = STATE_ZONES[String(state || '').toUpperCase()];
  if (byState) return byState;
  const lat = location?.lat;
  const lng = location?.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (lat < 23 && lng < -150) return 'Pacific/Honolulu';
    if (lat > 51 && lng < -129) return 'America/Anchorage';
    if (lng > -87.6) return 'America/New_York';
    if (lng > -101.5) return 'America/Chicago';
    if (lng > -114.6) return 'America/Denver';
    return 'America/Los_Angeles';
  }
  return DEFAULT_TIME_ZONE;
}

const MAX_CHILDREN = 6;
// How many hotels around the place (or across the city) are priced in one search.
const PRICED_PER_SEARCH = 20;

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

function text(v, max = 60) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function numOrNull(v) {
  if (!present(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]|usd|dollars?/gi, ''));
  return Number.isFinite(n) ? n : null;
}

function toCategories(v) {
  const list = Array.isArray(v) ? v : present(v) ? String(v).split(/[\s,/]+/) : [];
  return [...new Set(list.map(normalizeCategory).filter(Boolean))];
}

/** A supplier error (LiveServiceError) the guest can read, as the hotel service's own error type. */
function asHotelError(err, ErrorClass = HotelError) {
  if (err instanceof HotelError || err instanceof BookingError) return err;
  if (err?.name === 'LiveServiceError') {
    const e = new ErrorClass(err.code === 'not_found' ? 'hotel_not_found' : 'supplier_unavailable', err.userMessage || "The hotel service isn't answering right now. Please try again in a minute.");
    e.status = err.code === 'not_found' ? 404 : 503;
    e.retryable = Boolean(err.retryable);
    return e;
  }
  return err;
}

/**
 * @param {{ supplier: object, clock?: { now: () => Date }, logger?: { warn: Function } }} deps
 *   supplier: createLiteApiSupplier(...) (async searchHotels / getHotel / getRoomOffer, sync resolveCity)
 */
export function createLiveHotelService({ supplier, clock = { now: () => new Date() }, logger = console } = {}) {
  if (!supplier) throw new Error('createLiveHotelService: supplier is required');
  // Where a hotel is, from the searches that found it (its state decides its time zone).
  const placeOf = new Map();
  // Hotels whose cached rates proved stale (a price lock found another price): read afresh next time.
  const stale = new Set();
  const takeFresh = (hotelId) => stale.delete(hotelId);

  function remember(hotel, city) {
    if (!hotel?.id) return;
    if (placeOf.size > 20000) placeOf.clear();
    placeOf.set(hotel.id, { state: city?.state || '', city: city?.name || hotel.city || '' });
  }

  function zoneOfHotel(hotel) {
    if (hotel?.timeZone) return resolveTimeZone(hotel.timeZone);
    const known = hotel?.id ? placeOf.get(hotel.id) : null;
    return usZoneOf({ state: hotel?.state || known?.state, location: hotel?.location });
  }

  function withPlace(hotel, city) {
    const known = placeOf.get(hotel.id);
    const state = hotel.state || city?.state || known?.state || '';
    return { ...hotel, state, timeZone: zoneOfHotel({ ...hotel, state }) };
  }

  function requireCity(cityText) {
    const raw = text(cityText, 60);
    if (!raw) throw new HotelError('city_required', 'Which city are you going to?');
    const city = supplier.resolveCity(raw);
    if (!city) throw new HotelError('city_not_supported', `NanaHotel books hotels in the United States. Which US city is "${raw}" in?`, { city: raw });
    return city;
  }

  function stayOrThrow(checkIn, checkOut, ErrorClass, { zone, userZone, ...opts } = {}) {
    const now = clock.now();
    const hotelZone = resolveTimeZone(zone);
    const userTonight = userZone ? earliestCheckIn(now, resolveTimeZone(userZone)) : undefined;
    const stay = checkStay(checkIn, checkOut, todayIn(hotelZone, now), { ...opts, earliestCheckIn: earliestCheckIn(now, hotelZone), defaultCheckIn: userTonight });
    if (stay.error) throw new ErrorClass('invalid_dates', stay.error);
    return { ...stay, today: todayIn(hotelZone, now), earliest: earliestCheckIn(now, hotelZone) };
  }

  async function resolveNear(city, near, notes) {
    if (!near) return null;
    let lm = null;
    try {
      lm = await supplier.resolveLandmark(city.fullName || city.name, near);
    } catch (err) {
      logger?.warn?.(`[hotels] finding "${near}" failed: ${err?.message || err}`);
    }
    if (!lm) notes.push(`Couldn't find "${near}" in ${city.name}, so I searched the whole city`);
    return lm;
  }

  /** One priced search (radius around the landmark, or city-wide); hotels outside the radius are dropped. */
  async function collect(city, landmark, radiusM, cats, stay, p) {
    let raw;
    try {
      raw = await supplier.searchHotels({
        city: city.fullName || city.name,
        location: landmark ? landmark.location : undefined,
        radiusM: landmark ? radiusM : undefined,
        categories: cats.length ? cats : undefined,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: p.adults,
        children: p.children,
        rooms: p.rooms,
        limit: PRICED_PER_SEARCH,
      });
    } catch (err) {
      throw asHotelError(err);
    }
    return (raw || []).filter((h) => !landmark || (Number.isFinite(h.distanceM) && h.distanceM <= radiusM));
  }

  /**
   * Wider circles (and other kinds of hotel) until something is bookable; each step leaves a note. When nothing
   * anywhere is bookable, the last hotels found come back (sold out) so the guest hears why.
   */
  async function findWithRelaxation(city, landmark, radiusM, cats, stay, p) {
    const attempts = [{ r: radiusM, cats }];
    if (landmark) attempts.push({ r: Math.min(MAX_RADIUS_M, radiusM * 2), cats });
    if (cats.length) attempts.push({ r: radiusM, cats: [] });
    if (landmark) attempts.push({ r: Math.min(MAX_RADIUS_M, radiusM * 4), cats: [] });
    let fallback = null;
    for (const a of attempts) {
      const found = await collect(city, landmark, a.r, a.cats, stay, p);
      if (!found.length) continue;
      const notes = [];
      if (a.r > radiusM) notes.push(`Nothing bookable within ${miles(radiusM)}, so I widened the search to ${miles(a.r)}`);
      if (cats.length && !a.cats.length) notes.push(`No ${cats.map((c) => CATEGORY_LABELS[c].toLowerCase()).join('/')} hotels were bookable there, so here are other kinds`);
      if (found.some((h) => h.lowestPrice !== null)) return { found, notes, radiusM: a.r };
      if (!fallback) fallback = { found, notes, radiusM: a.r };
    }
    return fallback || { found: [], notes: ['No hotels found nearby'], radiusM };
  }

  async function searchHotels(params = {}) {
    const city = requireCity(params.city);
    const zone = usZoneOf({ state: city.state, location: city.center });
    const stay = stayOrThrow(params.checkIn, params.checkOut, HotelError, { zone, userZone: params.timeZone });
    const p = partyOf(params.adults, params.rooms, params.children);
    const occupants = p.adults + p.children;
    const radiusMiles = radiusMilesOf(params);
    const limit = Math.round(Math.min(10, Math.max(1, numOrNull(params.limit) ?? 6)));
    let priceMin = numOrNull(params.priceMin);
    let priceMax = numOrNull(params.priceMax);
    priceMin = priceMin !== null && priceMin > 0 ? Math.round(priceMin) : null;
    priceMax = priceMax !== null && priceMax > 0 ? Math.round(priceMax) : null;
    if (priceMin !== null && priceMax !== null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
    const keyword = text(params.keyword, 60);
    const near = text(params.near, 60);
    const kw = parseKeyword(keyword, { ignore: [city.name.toLowerCase(), String(city.fullName || '').toLowerCase()] });
    const categories = [...new Set([...toCategories(params.categories), ...kw.categories])];
    let sort = ['recommended', 'price_asc', 'price_desc', 'rating', 'distance'].includes(params.sort) ? params.sort : 'recommended';

    const notes = [];
    if (!present(params.checkIn)) {
      notes.push(stay.checkIn < stay.today
        ? `No dates given and it's after midnight, so I searched the night in progress (check in ${formatDate(stay.checkIn)}, check out ${formatDate(stay.checkOut)})`
        : `No dates given, so I searched ${stay.nights === 1 ? 'one night' : `${stay.nights} nights`} from ${stay.checkIn === stay.today ? 'tonight' : formatDate(stay.checkIn)}`);
    } else if (!present(params.checkOut)) notes.push('No check-out date given, so I searched one night');

    const landmark = await resolveNear(city, near, notes);
    if (sort === 'distance' && !landmark) sort = 'recommended';
    const relaxed = await findWithRelaxation(city, landmark, Math.round(radiusMiles * M_PER_MILE), categories, stay, p);
    notes.push(...relaxed.notes);

    const tokens = kw.tokens;
    const priced = relaxed.found.map((h) => {
      remember(h, city);
      const { offer, ...hotel } = h;
      const d = landmark && Number.isFinite(h.distanceM) ? h.distanceM : null;
      const out = {
        ...withPlace(hotel, city),
        distanceM: d,
        lowestPrice: h.lowestPrice ?? null,
        matchedKeywords: tokens.filter((t) => (RATE_TOKENS.has(t) ? Boolean(offer) && sellsBreakfast(offer) : hotelMatchesKeyword(hotel, [t]))),
        fitsParty: true,
      };
      if (d !== null) out.distanceMiles = Math.round((d / M_PER_MILE) * 10) / 10;
      if (out.lowestPrice === null && offer?.roomTypes?.length) {
        const maxOcc = Math.max(0, ...offer.roomTypes.map((rt) => rt.maxOccupancy || 0));
        if (maxOcc && p.rooms * maxOcc < occupants) Object.assign(out, { fitsParty: false, maxOccupancy: maxOcc, needRooms: Math.ceil(occupants / maxOcc) });
      }
      return out;
    });
    if (priced.length && priced.every((h) => h.lowestPrice === null && h.fitsParty)) notes.push('Everything around there is sold out for these dates; try other dates or another area?');

    const budget = applyBudget(priced, priceMin, priceMax, notes);
    if (budget.forceSort) sort = budget.forceSort;
    notes.push(...keywordNotes(tokens, budget.pool, sort));
    const hotels = rankHotels(budget.pool, sort, landmark, relaxed.radiusM).slice(0, limit);

    return {
      query: {
        city: city.name,
        state: city.state || '',
        timeZone: zone,
        keyword: keyword || null,
        near: near || null,
        radiusMiles,
        radiusKm: Math.round(radiusMiles * 1.609344 * 10) / 10,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        nights: stay.nights,
        datesAssumed: stay.datesAssumed,
        adults: p.adults,
        children: p.children,
        rooms: p.rooms,
        priceMin,
        priceMax,
        categories,
        sort,
        limit,
        currency: 'USD',
      },
      landmark: landmark ? { name: landmark.name, location: { ...landmark.location }, area: landmark.area || '' } : null,
      hotels,
      totalFound: priced.length,
      notes,
      demo: false,
      live: true,
      sandbox: Boolean(supplier.sandbox),
    };
  }

  async function getHotel(id) {
    const hotelId = text(id, 80);
    if (!hotelId) return null;
    let hotel;
    try {
      hotel = await supplier.getHotel(hotelId);
    } catch (err) {
      throw asHotelError(err);
    }
    return hotel ? withPlace(hotel) : null;
  }

  async function requireHotel(hotelId, ErrorClass) {
    const hotel = await getHotel(hotelId);
    if (!hotel) throw new ErrorClass('hotel_not_found', "Couldn't find that hotel; the id may be wrong. Please search again");
    return hotel;
  }

  /** @returns {Promise<{ hotel, offer, datesAssumed: boolean }>} */
  async function getRoomOffer({ hotelId, checkIn, checkOut, adults, rooms, children, timeZone } = {}) {
    const hotel = await requireHotel(hotelId, HotelError);
    const stay = stayOrThrow(checkIn, checkOut, HotelError, { zone: zoneOfHotel(hotel), userZone: timeZone });
    const p = partyOf(adults, rooms, children);
    let offer;
    try {
      ({ offer } = await supplier.getRoomOffer({ hotelId: hotel.id, checkIn: stay.checkIn, checkOut: stay.checkOut, ...p, fresh: takeFresh(hotel.id) }));
    } catch (err) {
      throw asHotelError(err);
    }
    return { hotel, offer, datesAssumed: stay.datesAssumed };
  }

  /**
   * One rate re-read for booking (from the supplier's few-minute cache, else a fresh search). Throws BookingError
   * (hotel_not_found, invalid_dates, rate_not_found, too_many_guests, sold_out, supplier_unavailable).
   */
  async function priceCheck({ hotelId, rateId, checkIn, checkOut, rooms = 1, adults = 2, children = 0 } = {}) {
    const hotel = await requireHotel(hotelId, BookingError);
    const stay = stayOrThrow(checkIn, checkOut, BookingError, { zone: zoneOfHotel(hotel), allowDefaults: false });
    const kids = Math.round(Math.min(MAX_CHILDREN, Math.max(0, numOrNull(children) ?? 0)));
    let offer;
    try {
      ({ offer } = await supplier.getRoomOffer({ hotelId: hotel.id, checkIn: stay.checkIn, checkOut: stay.checkOut, adults, children: kids, rooms, fresh: takeFresh(hotel.id) }));
    } catch (err) {
      throw asHotelError(err, BookingError);
    }
    const hit = supplier.findRate(offer, text(rateId, 40));
    if (!hit) throw new BookingError('rate_not_found', "That rate isn't offered anymore; please look at the rooms again");
    const { rates, ...roomType } = hit.roomType;
    const occupants = adults + kids;
    if (rooms * roomType.maxOccupancy < occupants) {
      const need = Math.ceil(occupants / roomType.maxOccupancy);
      throw new BookingError('too_many_guests', `The ${roomType.name} sleeps up to ${roomType.maxOccupancy}; ${partyText(adults, kids)} need at least ${need} rooms`);
    }
    if (!hit.rate.available) {
      throw new BookingError('sold_out', `The ${roomType.name} is sold out for ${formatRange(stay.checkIn, stay.checkOut, stay.today)}; try another room or other dates`);
    }
    return { hotel, roomType, rate: hit.rate };
  }

  return {
    source: supplier.source || 'liteapi',
    live: true,
    sandbox: Boolean(supplier.sandbox),
    listCities: () => supplier.listCities(),
    resolveCity: (t) => supplier.resolveCity(t),
    zoneOfHotel,
    searchHotels,
    getHotel,
    getRoomOffer,
    priceCheck,
    /** The next room offer or price check of this hotel skips the rates cache. */
    invalidate(hotelId) {
      if (hotelId) stale.add(String(hotelId));
    },
  };
}
