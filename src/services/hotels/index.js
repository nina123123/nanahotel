import { todayIn, earliestCheckIn, checkStay, formatDate, formatRange, DEFAULT_TIME_ZONE, resolveTimeZone } from '../../util/dates.js';
import { distanceM } from '../../util/geo.js';
import * as simPricing from './pricing.js';
import { CATEGORIES, CATEGORY_LABELS, normalizeCategory, parseKeyword, hotelMatchesKeyword, RATE_TOKENS } from './supplier.js';
import { BookingError } from '../bookings.js';

export { CATEGORIES, CATEGORY_LABELS };

const STATUS = { city_not_supported: 404, hotel_not_found: 404 };

/** Typed error with a user-facing English `message`. */
export class HotelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HotelError';
    this.code = code;
    this.status = STATUS[code] || 400;
    if (details) this.details = details;
  }
}

const SORTS = new Set(['recommended', 'price_asc', 'price_desc', 'rating', 'distance']);
const SORT_LABELS = { recommended: 'our picks', price_asc: 'price, low to high', price_desc: 'price, high to low', rating: 'rating', distance: 'distance' };
const M_PER_MILE = 1609.344;
const DEFAULT_RADIUS_MILES = 2;
const MAX_RADIUS_MILES = 12;
const MAX_RADIUS_M = Math.round(MAX_RADIUS_MILES * M_PER_MILE);
const MAX_CHILDREN = 6;

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

function num(v) {
  if (!present(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]|usd|dollars?/gi, ''));
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max, dflt) {
  const n = num(v);
  if (n === null) return dflt;
  return Math.min(max, Math.max(min, n));
}

function text(v, max = 60) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 3219 m → '2 miles', 800 m → '0.5 miles'. */
function miles(m) {
  const mi = Math.round((m / M_PER_MILE) * 10) / 10;
  return `${Number.isInteger(mi) ? mi : mi.toFixed(1)} mile${mi === 1 ? '' : 's'}`;
}

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toCategories(v) {
  const list = Array.isArray(v) ? v : present(v) ? String(v).split(/[\s,/]+/) : [];
  return [...new Set(list.map(normalizeCategory).filter(Boolean))];
}

/** '2 adults and 1 child'. */
export function partyText(adults, children = 0) {
  const a = `${adults} adult${adults === 1 ? '' : 's'}`;
  return children ? `${a} and ${children} ${children === 1 ? 'child' : 'children'}` : a;
}

/** The deepest active promotion covering the night of `date`, or null. */
function promoOn(promos, date) {
  let best = null;
  for (const p of promos) if (p.from <= date && date <= p.to && (!best || p.discount < best.discount)) best = p;
  return best;
}

/**
 * A RoomOffer with the hotel's own promotions applied: a night covered by an active promotion costs
 * round(price × discount) (the deepest one when several cover it), and a rate with any such night carries
 * `promo: { id, title, discount }` (the deepest it used). Taxes and fees shrink with the price. Pure: the offer
 * passed in is not changed.
 * @param {object} offer  RoomOffer
 * @param {Array<{ id: string, title: string, discount: number, from: string, to: string }>} promos  active ones
 */
export function applyPromotions(offer, promos) {
  if (!promos?.length || !offer?.roomTypes?.length) return offer;
  return {
    ...offer,
    roomTypes: offer.roomTypes.map((rt) => ({
      ...rt,
      rates: rt.rates.map((rate) => {
        let used = null;
        const nightly = rate.nightly.map((n) => {
          const p = promoOn(promos, n.date);
          if (!p) return n;
          if (!used || p.discount < used.discount) used = p;
          return { date: n.date, price: Math.round(n.price * p.discount) };
        });
        if (!used) return rate;
        const perRoom = nightly.reduce((sum, n) => sum + n.price, 0);
        const totalPrice = perRoom * (offer.rooms || 1);
        const taxesAndFees = Number.isFinite(rate.taxesAndFees) && rate.totalPrice > 0 ? Math.round((rate.taxesAndFees * totalPrice) / rate.totalPrice) : rate.taxesAndFees;
        return { ...rate, nightly, totalPrice, taxesAndFees, promo: { id: used.id, title: used.title, discount: used.discount } };
      }),
    })),
  };
}

/** The promotion a bookable rate of the offer uses (the deepest), for the hotel's deal tag; null when none. */
function offerPromo(offer) {
  let best = null;
  for (const rt of offer.roomTypes) {
    for (const r of rt.rates) if (r.available && r.promo && (!best || r.promo.discount < best.discount)) best = r.promo;
  }
  return best ? { ...best } : null;
}

/** Active promotions of one hotel from a provider ({ activeFor(hotelId) }), or none. */
function promosOf(promotions, hotelId) {
  const list = promotions ? promotions.activeFor(hotelId) : null;
  return Array.isArray(list) ? list : [];
}

/**
 * A pricing module ({ buildRoomOffer, lowestNightly, findRate }) whose offers include the hotels' promotions,
 * for services that price hotels on their own (places.js area prices). Without a provider it is `pricing` itself.
 */
export function withPromotions(promotions, pricing = simPricing) {
  if (!promotions) return pricing;
  const buildRoomOffer = (hotel, opts) => applyPromotions(pricing.buildRoomOffer(hotel, opts), promosOf(promotions, hotel.id));
  return { ...pricing, buildRoomOffer, lowestNightly: (hotel, opts) => simPricing.lowestNightlyOf(buildRoomOffer(hotel, opts)) };
}

/**
 * Supplier-agnostic hotel service: normalizes search params, resolves landmarks, prices and ranks hotels. Methods
 * are synchronous (callers may still `await` them).
 *
 * Dates: a stay is checked against the HOTEL's own date (its city's time zone, with the before-6-AM rule for the
 * night in progress). Missing dates default to the user's tonight (`timeZone`: the user's zone) when that night is
 * still bookable at the hotel, else to the hotel's tonight.
 *
 * @param {{ supplier: import('./supplier.js').HotelSupplier, clock?: { now: () => Date }, pricing?: { buildRoomOffer, lowestNightly, findRate },
 *           promotions?: { activeFor(hotelId: string): Array<{ id, title, discount, from, to }> } }} deps
 *   promotions: the hotels' own deals (merchant.js createPromotionBook). An active one covering a night discounts that
 *   night everywhere a price comes from here: search results' lowest price (+ `promo` on the hotel), room rates
 *   (+ `promo` on each discounted rate) and priceCheck, so quotes, orders and extensions charge what the cards showed.
 */
export function createHotelService({ supplier, clock = { now: () => new Date() }, pricing = simPricing, promotions = null } = {}) {
  if (!supplier) throw new Error('createHotelService: supplier is required');
  const offerFor = (hotel, opts) => applyPromotions(pricing.buildRoomOffer(hotel, opts), promosOf(promotions, hotel.id));

  function supportedText() {
    return supplier.listCities().map((c) => c.name).join(', ');
  }

  function requireCity(cityText) {
    const raw = text(cityText, 40);
    if (!raw) throw new HotelError('city_required', 'Which city are you going to?');
    const city = supplier.resolveCity(raw);
    if (!city) {
      throw new HotelError('city_not_supported', `The demo covers ${supportedText()}. "${raw}" isn't covered yet`, { city: raw });
    }
    return city;
  }

  function cityOfHotel(hotel) {
    return supplier.resolveCity(hotel.city) || undefined;
  }

  function zoneOfHotel(hotel) {
    return resolveTimeZone(hotel.timeZone || cityOfHotel(hotel)?.zone || DEFAULT_TIME_ZONE);
  }

  /** The stay checked at the hotel (its zone), defaulting to the user's tonight (`userZone`) when that still works there. */
  function stayOrThrow(checkIn, checkOut, ErrorClass, { zone, userZone, ...opts } = {}) {
    const now = clock.now();
    const hotelZone = resolveTimeZone(zone);
    const userTonight = userZone ? earliestCheckIn(now, resolveTimeZone(userZone)) : undefined;
    const stay = checkStay(checkIn, checkOut, todayIn(hotelZone, now), { ...opts, earliestCheckIn: earliestCheckIn(now, hotelZone), defaultCheckIn: userTonight });
    if (stay.error) throw new ErrorClass('invalid_dates', stay.error);
    return { ...stay, today: todayIn(hotelZone, now), earliest: earliestCheckIn(now, hotelZone) };
  }

  /** Children count as occupants (beds) but do not change the price. */
  function party(adults, rooms, children) {
    const r = Math.round(clamp(rooms, 1, 5, 1));
    const a = Math.round(clamp(adults, 1, 20, 2));
    const c = Math.round(clamp(children, 0, MAX_CHILDREN, 0));
    return { rooms: r, adults: a, children: c };
  }

  function resolveNear(city, near, tokens, notes) {
    if (near) {
      const lm = supplier.resolveLandmark(city.name, near);
      if (!lm) {
        notes.push(`Couldn't find "${near}" in ${city.name}, so I searched the whole city`);
        return { landmark: null, tokens };
      }
      if (lm.matched === 'partial' && !near.toLowerCase().includes(lm.name.toLowerCase())) notes.push(`Searched near ${lm.name} for "${near}"`);
      return { landmark: lm, tokens };
    }
    // Models often put a place into `keyword` ('Times Square'); treat it as `near` only on an exact match.
    if (tokens.length) {
      const lm = supplier.resolveLandmark(city.name, tokens.join(' '));
      if (lm && lm.matched === 'exact') return { landmark: lm, tokens: [] };
    }
    return { landmark: null, tokens };
  }

  /**
   * Distance from a landmark's edge (parks and beaches are big). Hotels "on" the edge get a stable 100–350 m
   * instead of a row of identical zeros.
   */
  function distanceFrom(landmark, location) {
    const raw = distanceM(location, landmark.location);
    if (raw === null) return null;
    const extent = landmark.extentM || 0;
    if (!extent) return raw;
    return Math.round(Math.max(raw - extent, Math.min(raw, 100 + (raw % 250))));
  }

  function collect(city, landmark, radiusM, cats) {
    const raw = supplier.searchHotels({
      city: city.name,
      location: landmark ? landmark.location : undefined,
      radiusM: landmark ? radiusM + (landmark.extentM || 0) : undefined,
      categories: cats.length ? cats : undefined,
    });
    const out = [];
    for (const hotel of raw) {
      const d = landmark ? distanceFrom(landmark, hotel.location) : null;
      if (landmark && (d === null || d > radiusM)) continue;
      if (cats.length && !cats.includes(hotel.category)) continue;
      out.push({ hotel, distanceM: d });
    }
    return out;
  }

  /**
   * Progressive relaxation of the hard filters (radius, categories) so the user rarely gets an empty answer; every
   * step leaves a note. Keywords never filter, they only rank (see keywordNotes).
   */
  function findWithRelaxation(city, landmark, radiusM, cats) {
    const attempts = [{ r: radiusM, cats }];
    if (landmark) attempts.push({ r: Math.min(MAX_RADIUS_M, radiusM * 2), cats });
    if (cats.length) attempts.push({ r: radiusM, cats: [] });
    if (landmark) {
      attempts.push({ r: Math.min(MAX_RADIUS_M, radiusM * 4), cats: [] });
      attempts.push({ r: MAX_RADIUS_M, cats: [] });
    }
    for (const a of attempts) {
      const found = collect(city, landmark, a.r, a.cats);
      if (!found.length) continue;
      const notes = [];
      if (a.r > radiusM) notes.push(`Nothing suitable within ${miles(radiusM)}, so I widened the search to ${miles(a.r)}`);
      if (cats.length && !a.cats.length) notes.push(`No ${cats.map((c) => CATEGORY_LABELS[c].toLowerCase()).join('/')} hotels there, so here are other kinds`);
      return { found, notes, radiusM: a.r };
    }
    return { found: [], notes: ['No hotels found nearby'], radiusM };
  }

  /** Breakfast is a rate property: a hotel matches when it has a bookable breakfast rate for this stay. */
  function sellsBreakfast(offer) {
    return offer.roomTypes.some((rt) => rt.rates.some((r) => r.available && r.breakfast > 0));
  }

  /** Says which preference words nothing matched, so the model does not present them as satisfied. */
  function keywordNotes(tokens, pool, sort) {
    if (!tokens.length || !pool.length) return [];
    const hit = new Set(pool.flatMap((h) => h.matchedKeywords));
    const matched = tokens.filter((t) => hit.has(t));
    const missing = tokens.filter((t) => !hit.has(t));
    if (!matched.length) return [`Nothing matches "${tokens.join(' ')}", so these are sorted by ${SORT_LABELS[sort] || SORT_LABELS.recommended}`];
    if (missing.length) return [`Nothing matches "${missing.join(' ')}"; hotels with "${matched.join(' ')}" come first`];
    if (tokens.length > 1 && !pool.some((h) => h.matchedKeywords.length === tokens.length)) {
      return [`No hotel has all of "${tokens.join(' ')}"; the ones with the most come first`];
    }
    return [];
  }

  function applyBudget(priced, priceMin, priceMax, notes) {
    if (priceMin === null && priceMax === null) return { pool: priced, forceSort: null };
    const avail = priced.filter((h) => h.lowestPrice !== null);
    if (!avail.length) return { pool: priced, forceSort: null };
    const within = (h, lo, hi) => (lo === null || h.lowestPrice >= lo) && (hi === null || h.lowestPrice <= hi);
    let fit = avail.filter((h) => within(h, priceMin, priceMax));
    if (fit.length) return { pool: fit, forceSort: null };
    if (priceMax !== null) {
      for (const f of [1.1, 1.2, 1.3]) {
        const hi = Math.ceil((priceMax * f) / 10) * 10;
        fit = avail.filter((h) => within(h, priceMin, hi));
        if (fit.length) {
          notes.push(`Nothing under ${money(priceMax)} a night, so I went up to ${money(hi)}`);
          return { pool: fit, forceSort: null };
        }
      }
    }
    if (priceMin !== null) {
      fit = avail.filter((h) => within(h, null, priceMax));
      if (fit.length) {
        notes.push(`Nothing from ${money(priceMin)} up, so here are other price points`);
        return { pool: fit, forceSort: null };
      }
    }
    const cheapest = Math.min(...avail.map((h) => h.lowestPrice));
    notes.push(`Nothing close to ${money(priceMax)} a night: the cheapest is ${money(cheapest)}, so these are sorted from low to high`);
    return { pool: avail, forceSort: 'price_asc' };
  }

  function rank(list, sort, landmark, radiusM) {
    const soldOutLast = (a, b) => (a.lowestPrice === null) - (b.lowestPrice === null);
    // Hotels matching more of the user's preference words come first, whatever the sort.
    const moreMatches = (a, b) => (b.matchedKeywords?.length || 0) - (a.matchedKeywords?.length || 0);
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const cmp = {
      price_asc: (a, b) => soldOutLast(a, b) || moreMatches(a, b) || a.lowestPrice - b.lowestPrice || byId(a, b),
      price_desc: (a, b) => soldOutLast(a, b) || moreMatches(a, b) || b.lowestPrice - a.lowestPrice || byId(a, b),
      rating: (a, b) => soldOutLast(a, b) || moreMatches(a, b) || (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount || byId(a, b),
      distance: (a, b) => soldOutLast(a, b) || moreMatches(a, b) || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || byId(a, b),
    };
    if (cmp[sort]) return [...list].sort(cmp[sort]);
    // recommended: rating quality + closeness + value for money (+ a little popularity).
    const med = median(list.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice));
    const score = (h) => {
      if (h.lowestPrice === null) return -1;
      const rating = Math.min(1, Math.max(0, ((h.rating ?? 4.2) - 3.6) / 1.3));
      const value = Math.min(1, Math.max(0, 0.5 + 0.5 * Math.log2(med / h.lowestPrice)));
      const pop = Math.min(1, Math.log10((h.reviewCount || 0) + 1) / 4);
      if (!landmark) return 0.5 * rating + 0.38 * value + 0.12 * pop;
      const dist = Math.min(1, Math.max(0, 1 - (h.distanceM ?? radiusM) / Math.max(radiusM, 1000)));
      return 0.38 * rating + 0.32 * dist + 0.22 * value + 0.08 * pop;
    };
    const scored = list.map((h) => ({ h, s: score(h) }));
    scored.sort((a, b) => soldOutLast(a.h, b.h) || moreMatches(a.h, b.h) || b.s - a.s || byId(a.h, b.h));
    return scored.map((x) => x.h);
  }

  function radiusMilesOf(params) {
    if (present(params.radiusMiles)) return Math.round(clamp(params.radiusMiles, 0.3, MAX_RADIUS_MILES, DEFAULT_RADIUS_MILES) * 10) / 10;
    if (present(params.radiusKm)) return Math.round((clamp(params.radiusKm, 0.5, 20, 3.2) / 1.609344) * 10) / 10;
    return DEFAULT_RADIUS_MILES;
  }

  /**
   * @param {object} params  HotelSearch (see docs/SPEC.md); `timeZone` is the user's zone (for "tonight")
   * @returns HotelSearchResult
   */
  function searchHotels(params = {}) {
    const now = clock.now();
    const city = requireCity(params.city);
    const zone = resolveTimeZone(city.zone);
    const stay = stayOrThrow(params.checkIn, params.checkOut, HotelError, { zone, userZone: params.timeZone });
    const { adults, rooms, children } = party(params.adults, params.rooms, params.children);
    const occupants = adults + children;
    const radiusMiles = radiusMilesOf(params);
    const limit = Math.round(clamp(params.limit, 1, 10, 6));
    let priceMin = num(params.priceMin);
    let priceMax = num(params.priceMax);
    priceMin = priceMin !== null && priceMin > 0 ? Math.round(priceMin) : null;
    priceMax = priceMax !== null && priceMax > 0 ? Math.round(priceMax) : null;
    if (priceMin !== null && priceMax !== null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
    const keyword = text(params.keyword, 60);
    const near = text(params.near, 60);
    const kw = parseKeyword(keyword, { ignore: [city.name.toLowerCase(), city.fullName.toLowerCase()] });
    const categories = [...new Set([...toCategories(params.categories), ...kw.categories])];
    let sort = SORTS.has(params.sort) ? params.sort : 'recommended';

    const notes = [];
    if (!present(params.checkIn)) {
      notes.push(stay.checkIn < stay.today
        ? `No dates given and it's after midnight, so I searched the night in progress (check in ${formatDate(stay.checkIn)}, check out ${formatDate(stay.checkOut)})`
        : `No dates given, so I searched ${stay.nights === 1 ? 'one night' : `${stay.nights} nights`} from ${stay.checkIn === stay.today ? 'tonight' : formatDate(stay.checkIn)}`);
    } else if (!present(params.checkOut)) notes.push('No check-out date given, so I searched one night');

    const { landmark, tokens } = resolveNear(city, near, kw.tokens, notes);
    if (sort === 'distance' && !landmark) sort = 'recommended';

    const relaxed = findWithRelaxation(city, landmark, Math.round(radiusMiles * M_PER_MILE), categories);
    notes.push(...relaxed.notes);

    const priceCtx = { checkIn: stay.checkIn, checkOut: stay.checkOut, adults, children, rooms, city, now };
    const priced = relaxed.found.map(({ hotel, distanceM: d }) => {
      const promos = promosOf(promotions, hotel.id);
      let offer = null;
      const offerOf = () => offer || (offer = applyPromotions(pricing.buildRoomOffer(hotel, priceCtx), promos));
      const lowestPrice = promos.length ? simPricing.lowestNightlyOf(offerOf()) : pricing.lowestNightly(hotel, priceCtx);
      const matchedKeywords = tokens.filter((t) => (RATE_TOKENS.has(t) ? sellsBreakfast(offerOf()) : hotelMatchesKeyword(hotel, [t])));
      const out = { ...hotel, distanceM: d, lowestPrice, matchedKeywords, fitsParty: true };
      if (Number.isFinite(d)) out.distanceMiles = Math.round((d / M_PER_MILE) * 10) / 10;
      const promo = promos.length && lowestPrice !== null ? offerPromo(offerOf()) : null;
      if (promo) out.promo = promo;
      if (lowestPrice === null) {
        // "Doesn't fit" is not sold out: tell them apart so nobody hears a hotel is full when it is not.
        const maxOcc = Math.max(0, ...offerOf().roomTypes.map((rt) => rt.maxOccupancy));
        if (maxOcc && rooms * maxOcc < occupants) Object.assign(out, { fitsParty: false, maxOccupancy: maxOcc, needRooms: Math.ceil(occupants / maxOcc) });
      }
      return out;
    });
    const tooSmall = priced.filter((h) => !h.fitsParty);
    if (tooSmall.length) {
      const m = Math.min(...tooSmall.map((h) => h.maxOccupancy));
      const need = Math.ceil(occupants / m);
      notes.push(`${partyText(adults, children)} in ${rooms} room${rooms === 1 ? '' : 's'}: ${tooSmall.length} hotel${tooSmall.length === 1 ? "'s rooms sleep" : "s' rooms sleep"} at most ${m}, so book ${need} rooms or a suite there`);
    }
    if (priced.length && priced.every((h) => h.lowestPrice === null && h.fitsParty)) notes.push('Everything around there is sold out for these dates; try other dates or another area?');

    const budget = applyBudget(priced, priceMin, priceMax, notes);
    if (budget.forceSort) sort = budget.forceSort;
    notes.push(...keywordNotes(tokens, budget.pool, sort));
    const hotels = rank(budget.pool, sort, landmark, relaxed.radiusM).slice(0, limit);

    return {
      query: {
        city: city.name,
        state: city.state,
        timeZone: zone,
        keyword: keyword || null,
        near: near || null,
        radiusMiles,
        radiusKm: Math.round(radiusMiles * 1.609344 * 10) / 10,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        nights: stay.nights,
        datesAssumed: stay.datesAssumed,
        adults,
        children,
        rooms,
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
      demo: true,
    };
  }

  function getHotel(id) {
    return supplier.getHotel(text(id, 80)) || null;
  }

  /** @returns {{ hotel, offer: RoomOffer, datesAssumed: boolean }}  `timeZone` is the user's zone (for "tonight") */
  function getRoomOffer({ hotelId, checkIn, checkOut, adults, rooms, children, timeZone } = {}) {
    const hotel = getHotel(hotelId);
    if (!hotel) throw new HotelError('hotel_not_found', "Couldn't find that hotel; the id may be wrong. Please search again");
    const stay = stayOrThrow(checkIn, checkOut, HotelError, { zone: zoneOfHotel(hotel), userZone: timeZone });
    const p = party(adults, rooms, children);
    const offer = offerFor(hotel, { checkIn: stay.checkIn, checkOut: stay.checkOut, ...p, city: cityOfHotel(hotel), now: clock.now() });
    return { hotel, offer, datesAssumed: stay.datesAssumed };
  }

  /** Re-price one rate for booking. Throws BookingError (hotel_not_found, invalid_dates, rate_not_found, too_many_guests, sold_out). */
  function priceCheck({ hotelId, rateId, checkIn, checkOut, rooms = 1, adults = 2, children = 0 } = {}) {
    const hotel = getHotel(hotelId);
    if (!hotel) throw new BookingError('hotel_not_found', "Couldn't find that hotel; please search again");
    const stay = stayOrThrow(checkIn, checkOut, BookingError, { zone: zoneOfHotel(hotel), allowDefaults: false });
    const kids = Math.round(clamp(children, 0, MAX_CHILDREN, 0));
    const offer = offerFor(hotel, { checkIn: stay.checkIn, checkOut: stay.checkOut, adults, children: kids, rooms, city: cityOfHotel(hotel), now: clock.now() });
    const hit = pricing.findRate(offer, text(rateId, 40));
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
    source: supplier.source,
    listCities: () => supplier.listCities(),
    resolveCity: (t) => supplier.resolveCity(t),
    zoneOfHotel,
    searchHotels,
    getHotel,
    getRoomOffer,
    priceCheck,
  };
}
