import * as defaultIds from '../util/ids.js';
import {
  todayIn, earliestCheckIn, addDays, isValidDate, zonedTimeMs, formatDate, formatTime, weekdayLong, dayOfWeek, monthOf, dateIn, timeIn,
  resolveTimeZone, DEFAULT_TIME_ZONE,
} from '../util/dates.js';
import { maskedGuestName } from '../util/names.js';
import { hashString, hash01 } from './hotels/sim-hotels.js';
import { findCity } from './hotels/sim-cities.js';
import { buildRoomOffer, dayFactor, parseFloors, isInn } from './hotels/pricing.js';
import { holidayOn } from './hotels/holidays.js';

/**
 * NanaHotel for Hotels (docs/MERCHANT.md): the hotel's console over the same data as the traveler side — the
 * overview, the room grid with front-desk check-in, guests' service tickets, reviews with replies, and the hotel's
 * deals.
 *
 * The hotel's other guests (rooms, tickets, channels, review history) are simulated, deterministically per hotel id
 * and date (hashes, like pricing.js): a hotel shows the same night whenever it is looked at. What happens in
 * NanaHotel — orders, requests, reviews — is layered on top with `source: 'nanahotel'` (simulated items carry
 * `source: 'sim'`). A NanaHotel guest's room is the one stays.js gives at check-in (same floors, same numbering), so it
 * is always in the grid; the simulated guest who would have had that room makes way. Guests appear masked
 * ("Sarah M.").
 *
 * The hotel's own changes are stored: a room cleaned or out of order (today only), a simulated ticket handled, a
 * reply to a simulated review, the deals. Changes that reach a NanaHotel guest (front-desk check-in, an early
 * check-in answered, a reply to their review) return an `event` ({ kind, userId, sessionId, ... }) for the server to
 * turn into a notice in the guest's chat; the user id never goes to the console.
 *
 * Times are the hotel's own (its city's time zone). The hotel's day is the night in progress: until 6 AM it is still
 * the previous date, so a guest arriving at 12:30 AM for "tonight" is an arrival of the night that began yesterday.
 * Dates in and out of the API stay calendar dates; "today" in the room grid shows that night until 6 AM.
 *
 * Same style as stays.js: synchronous methods, the injected clock, statuses worked out when read (no timers), and no
 * Node-only imports, so it also runs inside the phone app's page.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ROOM_DAYS_AHEAD = 6;
const FORECAST_DAYS = 14;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 60;
const REVIEW_DAYS = 60;
const MAX_SIM_REVIEWS = 30;
const TICKET_KEEP_MS = 24 * HOUR;
const WAIT_ALERT_MS = 10 * MIN;
const MAX_PROMOTIONS = 5;
const PROMO_AHEAD_DAYS = 60;
const MIN_DISCOUNT = 0.5;
const MAX_DISCOUNT = 0.95;
const MAX_TITLE_CHARS = 30;
const MAX_REPLY_CHARS = 500;
const MAX_ARRIVALS = 20;
// A simulated stay never runs past this many nights (every room has a fixed day in the cycle when guests change).
const STAY_CYCLE_DAYS = 14;
// Any date: a hotel's room types and their floors do not depend on it.
const REF_DATE = '2026-01-05';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const STATUS = {
  hotel_not_found: 404, not_found: 404, room_not_found: 404,
  invalid_action: 409, wrong_room: 409, too_many_promotions: 409, order_not_confirmed: 409,
};

/** Typed merchant error; `message` is user-facing English. A stays.js error keeps its own code and status. */
export class MerchantError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'MerchantError';
    this.code = code;
    this.status = status || STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const CHANNEL_LABELS = Object.freeze({ nanahotel: 'NanaHotel', expedia: 'Expedia', booking: 'Booking.com', google: 'Google', direct: 'Direct' });
const CHANNELS = Object.freeze(Object.keys(CHANNEL_LABELS));
export const ROOM_ACTIONS = Object.freeze(['clean', 'ooo', 'release', 'check_in']);
export const TICKET_ACTIONS = Object.freeze(['accept', 'deliver', 'done', 'approve', 'decline']);

const CATEGORIES = ['budget', 'midscale', 'upscale', 'luxury'];
// stays.js assignRoom: the booked room type's floors (its defaults when a hotel has no room types), skipping the
// 13th floor, rooms 01–28 a floor (01–08 in a historic inn).
const FLOORS = { budget: [2, 6], midscale: [2, 12], upscale: [4, 24], luxury: [8, 40] };
const INN_FLOORS = [1, 3];
const UNLUCKY_FLOORS = new Set([13]);
// How common each room type is on a floor (R1 kings the most, suites the fewest).
const TYPE_WEIGHTS = [0.4, 0.32, 0.18, 0.1];
const BASE_OCCUPANCY = { budget: 0.78, midscale: 0.75, upscale: 0.72, luxury: 0.68 };
const FNB_PER_ROOM = { budget: 6, midscale: 18, upscale: 55, luxury: 140 };
const FALLBACK_PRICE = { budget: 139, midscale: 209, upscale: 319, luxury: 649 };
const BUSINESS_KINDS = new Set(['cbd', 'station', 'airport', 'university']);
const LONG_STAY_KINDS = new Set(['resort', 'beach', 'inn']);
const CHANNEL_MIX = { expedia: 0.34, booking: 0.24, google: 0.12, direct: 0.3 };

// Common first names, most frequent first (picked with a bias towards the front), and last-name initials.
const FIRST_NAMES = [
  'Sarah', 'Michael', 'Jessica', 'David', 'Emily', 'James', 'Ashley', 'Chris', 'Jennifer', 'Daniel', 'Amanda', 'Matthew', 'Lauren', 'Andrew',
  'Megan', 'Ryan', 'Rachel', 'Kevin', 'Nicole', 'Brian', 'Olivia', 'Jason', 'Sophia', 'Eric', 'Maria', 'Jose', 'Priya', 'Wei', 'Aisha',
  'Carlos', 'Hannah', 'Tyler', 'Grace', 'Marcus', 'Elena', 'Nathan', 'Chloe', 'Omar', 'Lily', 'Diego',
];
const LAST_INITIALS = 'SMJBWDGHCLRTPKANFEOVY';

// Simulated requests the front desk takes by phone.
const SIM_ITEMS = [['Towels', 2], ['Bath towels', 1], ['Bottled water', 2], ['Toothbrush kit', 1], ['Slippers', 2], ['Extra pillows', 2],
  ['Blanket', 1], ['Hair dryer', 1], ['Phone charger', 1], ['Hangers', 4], ['Toilet paper', 2], ['Housekeeping', 1]];
const SIM_NOTES = ['Just leave it at the door', 'As soon as you can, please', 'Firm pillows if possible', 'For the kids', 'Thanks so much!'];
const TASK_RE = /housekeeping|clean|tidy|make up|turndown|repair|fix|maintenance|crib|rollaway/i;

// What simulated reviews praise: [key, tag, phrases]; `${lm}` is the area's landmark, `${view}` the hotel's view.
const PRAISE = {
  location: ['Great location', ['Great location, a few minutes on foot from ${lm}', 'Perfect spot, with ${lm} right there', 'Easy to get to ${lm} and back in the evening']],
  clean: ['Spotless', ['The room was spotless', 'Very clean room and bathroom', 'Housekeeping did a great job every day']],
  service: ['Friendly staff', ['The front desk was friendly and check-in was quick', 'Staff went out of their way to help with our bags', 'Great tips for dinner from the front desk']],
  breakfast: ['Good breakfast', ['Breakfast had plenty of choice, with eggs made to order', 'Breakfast was really good']],
  bed: ['Comfy bed', ['The bed was super comfortable', 'Slept great, the pillows were perfect']],
  quiet: ['Quiet', ['Nice and quiet at night', 'A quiet room, we slept really well']],
  value: ['Great value', ['Great value for the price', 'Worth every penny, we would book again']],
  view: ['Great views', ['The ${view} was amazing', 'We loved the ${view} from our room']],
  transit: ['Convenient', ['Close to the station, very convenient', 'Easy to get to the airport for an early flight']],
  facility: ['Great amenities', ['The pool and the gym were great', 'Modern rooms with a great design']],
  family: ['Family-friendly', ['Great with kids, they even had a little gift for ours', 'Our kids loved the family room']],
};
// What they complain about: label (as in "3 reviews mention noise"), tag, phrases, how text mentions it, the hotel's
// remedy (for a drafted reply) and advice (for the overview).
const ISSUES = {
  noise: {
    label: 'noise', tag: 'Noisy', re: /noise|noisy|loud|thin walls|hear the|neighbors/i,
    phrases: ['The walls are thin and we could hear the hallway at night', 'Street-facing rooms are noisy', 'We could hear the neighbors talking'],
    remedy: "we're installing quieter windows in street-facing rooms, and we're happy to give you a quiet, higher room next time",
    advice: 'give guests who care about it quieter, higher rooms, and mention the window upgrade in replies',
  },
  breakfast: {
    label: 'breakfast', tag: 'Breakfast could be better', re: /breakfast/i,
    phrases: ['Breakfast had little choice and things ran out early', 'Breakfast was the same every day'],
    remedy: "we're adding made-to-order options at breakfast and restocking faster at busy times",
    advice: 'check how fast breakfast is restocked at peak times and add a made-to-order option',
  },
  parking: {
    label: 'parking', tag: 'Parking', re: /parking|valet|garage/i,
    phrases: ['Parking was expensive and hard to find', 'The valet took forever'],
    remedy: 'we now partner with a nearby garage, and the front desk can sign you up for the discounted rate',
    advice: 'mention the partner garage in the confirmation email',
  },
  aircon: {
    label: 'the AC', tag: 'AC issues', re: /\bac\b|a\/c|air condition|heating|hvac/i,
    phrases: ['The AC was loud', "The AC didn't cool the room well"],
    remedy: "our engineering team is servicing every room's AC unit",
    advice: 'have engineering service the AC units floor by floor',
  },
  bathroom: {
    label: 'the bathroom', tag: 'Bathroom needs work', re: /bathroom|shower|water pressure|hot water/i,
    phrases: ['The bathroom was small and the water pressure was weak', 'The shower took ages to get hot'],
    remedy: "we've scheduled repairs for the hot water and the shower pressure",
    advice: 'check the hot water loop and the shower pressure',
  },
  dated: {
    label: 'dated rooms', tag: 'Dated rooms', re: /dated|worn|carpet|tired|older than/i,
    phrases: ['The room felt dated and the carpet was worn', 'The room looked older than in the photos'],
    remedy: "we're renovating rooms floor by floor and will put you in a renovated room next time",
    advice: 'give new bookings the renovated rooms first and update the room photos',
  },
  frontdesk: {
    label: 'check-in waits', tag: 'Slow check-in', re: /waited|in line|slow check|queue|took a long time/i,
    phrases: ['We waited 20 minutes in line to check in', 'Check-out took a long time'],
    remedy: "we're adding front desk staff at busy times, and you can check in through NanaHotel too",
    advice: 'add a front desk agent for the 4–7 PM check-in rush',
  },
  wifi: {
    label: 'Wi-Fi', tag: 'Spotty Wi-Fi', re: /wi-?fi|internet|signal|connection/i,
    phrases: ['The Wi-Fi kept dropping during video calls', 'The internet in the room was really slow'],
    remedy: "we've upgraded the network, and if anything is still slow the front desk can help right away",
    advice: 'test the Wi-Fi coverage on the guest floors',
  },
};
const LIKED = [['location', /location|walk|close to|steps from|convenient/i, 'location'], ['clean', /clean|spotless/i, 'clean rooms'],
  ['service', /staff|service|front desk|friendly|helpful/i, 'team'], ['breakfast', /breakfast/i, 'breakfast'], ['bed', /bed|slept|sleep|pillow/i, 'beds'],
  ['view', /view/i, 'views']];

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
}

/** One line of the hotel's text (a deal title): no control characters, no brackets that could pass for a notice. */
function clean(v, max) {
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Free text (a reply): line breaks kept, nothing cut, so an over-long one can be refused. */
function cleanText(v) {
  return (typeof v === 'string' ? v : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[[\]【】]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const iso = (ms) => new Date(ms).toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const round = (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dayIndex = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const fill = (template, vars) => template.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function hhmm(minutes) {
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

/** 'Sarah Miller' → 'Sarah M.': the console only shows a guest's first name and last initial. */
export function maskName(name) {
  return maskedGuestName(name);
}

/** Largest-remainder split of `n` slots by weight; every weight gets at least one while slots last. */
function splitByWeight(n, weights) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (w / total) * n);
  const counts = exact.map((x) => Math.max(n >= weights.length ? 1 : 0, Math.floor(x)));
  let left = n - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  for (let k = counts.length - 1; left < 0 && k >= 0; k--) {
    while (left < 0 && counts[k] > 1) {
      counts[k]--;
      left++;
    }
  }
  return counts;
}

/** An entry picked with a bias towards the front of the list (its most common entries). */
function biasedPick(list, u, power = 1.6) {
  return list[Math.min(list.length - 1, Math.floor(list.length * u ** power))];
}

function simGuestName(u1, u2) {
  return `${biasedPick(FIRST_NAMES, u1)} ${LAST_INITIALS[Math.floor(u2 * LAST_INITIALS.length)]}.`;
}

function requireDate(v, what) {
  const d = str(v, 10);
  if (!isValidDate(d)) throw new MerchantError('invalid_date', `The ${what} needs to be a valid date (YYYY-MM-DD)`);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Deals (shared with the hotel service, which prices with them)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The hotels' own deals ("promotions"), stored in `merchant_promotions`. The hotel service reads `activeFor` to
 * discount the nights they cover (search, rooms, quotes, orders); the merchant service lists, creates and switches them.
 * @param {{ store: { collection(name: string) }, clock?: { now: () => Date }, ids?: Partial<typeof defaultIds>, zoneOf?: (hotelId: string) => string }} deps
 */
export function createPromotionBook({ store, clock = { now: () => new Date() }, ids, zoneOf } = {}) {
  if (!store) throw new Error('createPromotionBook: store is required');
  const idgen = { ...defaultIds, ...(ids || {}) };
  const col = store.collection('merchant_promotions');
  const nowMs = () => clock.now().getTime();

  /** Deals switched on, as the hotel service prices with them: [{ id, title, discount, from, to }]. */
  function activeFor(hotelId) {
    const out = [];
    for (const p of col.values()) if (p.hotelId === hotelId && p.active) out.push({ id: p.id, title: p.title, discount: p.discount, from: p.from, to: p.to });
    return out;
  }

  /** Every deal of a hotel (stored records), newest first. */
  function listFor(hotelId) {
    return col.values().filter((p) => p.hotelId === hotelId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }

  function get(hotelId, id) {
    const p = col.get(str(id, 80));
    return p && p.hotelId === hotelId ? p : null;
  }

  /**
   * A new deal, switched on: title 1–30 characters, discount 0.5–0.95 (0.85 = 15% off), nights `from`–`to`
   * (inclusive) between today and 60 days ahead (the hotel's dates); at most 5 per hotel that have not ended.
   */
  function create(hotelId, { title, discount, from, to } = {}, zone = zoneOf?.(hotelId)) {
    const t = nowMs();
    const z = resolveTimeZone(zone, DEFAULT_TIME_ZONE);
    const today = todayIn(z, t);
    // Until 6 AM the night in progress can still be booked, so it can be discounted too.
    const earliest = earliestCheckIn(new Date(t), z);
    const name = clean(title, MAX_TITLE_CHARS + 1);
    if (!name) throw new MerchantError('invalid_title', 'A deal needs a name, like "Fall special"');
    if (name.length > MAX_TITLE_CHARS) throw new MerchantError('invalid_title', `Deal names can be up to ${MAX_TITLE_CHARS} characters`);
    const d = typeof discount === 'number' ? discount : typeof discount === 'string' && discount.trim() ? Number(discount) : NaN;
    if (!Number.isFinite(d) || d < MIN_DISCOUNT || d > MAX_DISCOUNT) {
      throw new MerchantError('invalid_discount', `The discount needs to be between ${MIN_DISCOUNT} and ${MAX_DISCOUNT} (0.85 means 15% off)`);
    }
    const first = requireDate(from, 'start date (from)');
    const last = requireDate(to, 'end date (to)');
    const latest = addDays(today, PROMO_AHEAD_DAYS);
    if (first < earliest) throw new MerchantError('invalid_date', `The start date ${first} has already passed; the earliest is today (${today})`);
    if (last > latest) throw new MerchantError('invalid_date', `Deals can run up to ${PROMO_AHEAD_DAYS} days ahead (until ${latest})`);
    if (last < first) throw new MerchantError('invalid_date', "The end date can't be before the start date");
    const running = col.values().filter((p) => p.hotelId === hotelId && p.to >= earliest).length;
    if (running >= MAX_PROMOTIONS) {
      throw new MerchantError('too_many_promotions', `Each hotel can have up to ${MAX_PROMOTIONS} deals that haven't ended; wait for one to end first`);
    }
    const at = iso(t);
    const rec = {
      id: idgen.newId('PM'), hotelId, title: name, discount: round(d, 2), from: first, to: last,
      active: true, createdAt: at, updatedAt: at, activeSince: at, activeMs: 0,
    };
    col.set(rec.id, rec);
    return rec;
  }

  /** Switches a deal on or off (`active` true / false); the time it was on is kept for its view count. */
  function setActive(hotelId, id, active) {
    const p = get(hotelId, id);
    if (!p) throw new MerchantError('not_found', "Couldn't find that deal");
    const on = active === true || active === 'true' ? true : active === false || active === 'false' ? false : null;
    if (on === null) throw new MerchantError('invalid_active', 'active needs to be true (on) or false (off)');
    if (on === p.active) return p;
    const t = nowMs();
    const next = on
      ? { ...p, active: true, activeSince: iso(t), updatedAt: iso(t) }
      : { ...p, active: false, activeSince: null, activeMs: (p.activeMs || 0) + Math.max(0, t - Date.parse(p.activeSince || iso(t))), updatedAt: iso(t) };
    col.set(p.id, next);
    return next;
  }

  return { activeFor, listFor, get, create, setActive };
}

// ---------------------------------------------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{ store: { collection(name: string) },
 *           bookings: { ordersForHotel }, stays: { listHotelStays, listHotelRequests, frontDeskCheckIn, advanceRequest, replyReview },
 *           hotels: { getHotel }, clock?: { now: () => Date }, promotions?: ReturnType<typeof createPromotionBook>,
 *           ids?: Partial<typeof defaultIds> }} deps
 *   promotions defaults to a deal book over the same store (the one the hotel service prices with).
 */
export function createMerchantService({ store, bookings, stays, hotels, clock = { now: () => new Date() }, promotions, ids } = {}) {
  if (!store) throw new Error('createMerchantService: store is required');
  if (!bookings) throw new Error('createMerchantService: bookings is required');
  if (!stays) throw new Error('createMerchantService: stays is required');
  if (!hotels) throw new Error('createMerchantService: hotels is required');
  const promos = promotions || createPromotionBook({ store, clock, ids });
  const roomMarks = store.collection('merchant_rooms');
  const ticketMarks = store.collection('merchant_tickets');
  const replies = store.collection('merchant_replies');
  // Read only: which hotels NanaHotel guests booked (bookings.js owns the collection).
  const orderRecords = store.collection('orders');
  const nowMs = () => clock.now().getTime();
  const models = new Map();

  /** A stays.js error keeps its code, status and message. */
  function viaStays(fn) {
    try {
      return fn();
    } catch (err) {
      if (err?.name === 'StayError') throw new MerchantError(err.code, err.message, err.details, err.status);
      throw err;
    }
  }

  // ---- the hotel and its rooms (deterministic per hotel id) ------------------------------------------------

  function requireHotel(hotelId) {
    const id = str(hotelId, 80);
    let hotel = null;
    try {
      hotel = ID_RE.test(id) ? hotels.getHotel(id) : null;
    } catch {
      hotel = null;
    }
    if (!hotel) throw new MerchantError('hotel_not_found', "Couldn't find that hotel; please pick another one");
    return hotel;
  }

  function modelOf(hotel) {
    let m = models.get(hotel.id);
    if (m) return m;
    const category = CATEGORIES.includes(hotel.category) ? hotel.category : 'midscale';
    const city = findCity(hotel.city);
    const area = city?.areas.find((a) => a.name === hotel.businessArea) || null;
    const lowRise = isInn(hotel);
    const kind = area?.kind || 'shopping';
    let offer = null;
    try {
      offer = buildRoomOffer(hotel, { checkIn: REF_DATE, checkOut: addDays(REF_DATE, 1) });
    } catch {
      offer = null;
    }
    const [dLo, dHi] = lowRise ? INN_FLOORS : FLOORS[category];
    let types = (offer?.roomTypes || []).map((rt) => {
      const f = parseFloors(rt.floor);
      return { roomId: rt.roomId, name: rt.name, lo: f ? f[0] : dLo, hi: f ? f[1] : dHi };
    });
    if (!types.length) types = [{ roomId: 'R1', name: 'Standard room', lo: dLo, hi: dHi }];
    const perFloor = lowRise ? 8 : 28;
    const rooms = [];
    const bottom = Math.min(...types.map((t) => t.lo));
    const top = Math.max(...types.map((t) => t.hi));
    for (let f = bottom; f <= top; f++) {
      if (UNLUCKY_FLOORS.has(f)) continue;
      let here = types.filter((t) => t.lo <= f && f <= t.hi);
      if (!here.length) here = [types.reduce((a, b) => (b.hi > a.hi ? b : a))];
      const counts = splitByWeight(perFloor, here.map((t) => TYPE_WEIGHTS[types.indexOf(t)] ?? 0.1));
      let index = 1;
      here.forEach((type, i) => {
        for (let k = 0; k < counts[i]; k++, index++) rooms.push(makeRoom(hotel.id, f, index, type));
      });
    }
    if (!rooms.length) for (let i = 1; i <= perFloor; i++) rooms.push(makeRoom(hotel.id, bottom, i, types[0]));
    const issues = Object.keys(ISSUES);
    const weak = [issues[hashString(`${hotel.id}|weak1`) % issues.length]];
    const second = issues[hashString(`${hotel.id}|weak2`) % issues.length];
    if (second !== weak[0]) weak.push(second);
    const view = (hotel.tags || []).find((t) => / view$/.test(t));
    m = {
      id: hotel.id,
      hotel,
      category,
      lowRise,
      kind,
      city,
      zone: resolveTimeZone(hotel.timeZone || city?.zone, DEFAULT_TIME_ZONE),
      market: city?.market || 'mixed',
      season: Array.isArray(city?.season) ? city.season : null,
      business: BUSINESS_KINDS.has(kind),
      // Leisure stays are longer than business trips.
      cont: LONG_STAY_KINDS.has(kind) ? 0.72 : BUSINESS_KINDS.has(kind) ? 0.5 : 0.6,
      baseOcc: BASE_OCCUPANCY[category] + (hash01(`${hotel.id}|occ`) - 0.5) * 0.1 + ((Number(hotel.rating) || 4.3) - 4.3) * 0.08,
      types,
      rooms,
      byNumber: new Map(rooms.map((r) => [r.number, r])),
      landmark: area?.landmarks?.[0]?.name || area?.short || 'the sights',
      view: view ? view.toLowerCase() : '',
      weak,
      occCache: new Map(),
      priceCache: new Map(),
    };
    models.set(hotel.id, m);
    return m;
  }

  function makeRoom(hotelId, floor, index, type) {
    const number = `${floor}${pad2(index)}`;
    return { number, floor, type, cycleDay: hashString(`${hotelId}|${number}|cycle`) % STAY_CYCLE_DAYS };
  }

  function modelFor(hotelId) {
    return modelOf(requireHotel(hotelId));
  }

  /** Epoch ms of a wall-clock time at the hotel. */
  const at = (m, date, hhmmText) => zonedTimeMs(date, hhmmText, m.zone);

  /**
   * Share of rooms sold on the night of `date`: the category's level, then demand — leisure hotels fill up on
   * weekends and holidays (pricing.js dayFactor), business hotels on weekdays — the city's season and a weekly wobble.
   */
  function occRate(m, date) {
    const hit = m.occCache.get(date);
    if (hit !== undefined) return hit;
    let demand;
    if (m.business) {
      const dow = dayOfWeek(date);
      demand = holidayOn(date, m.city?.code) ? 0.88 : dow === 5 ? 0.93 : dow === 6 ? 0.86 : dow === 0 ? 0.9 : 1.05;
    } else {
      demand = 1 + (dayFactor(date, m.market, m.city) - 1) * 0.8;
    }
    const season = m.season ? 1 + ((m.season[monthOf(date) - 1] || 1) - 1) * 0.6 : 1;
    const monday = addDays(date, -((dayOfWeek(date) + 6) % 7));
    const wobble = 1 + (hash01(`${m.id}|${monday}|occ`) - 0.5) * 0.08 + (hash01(`${m.id}|${date}|occ`) - 0.5) * 0.04;
    const v = clamp(m.baseOcc * demand * season * wobble, 0.28, 0.97);
    if (m.occCache.size > 800) m.occCache.clear();
    m.occCache.set(date, v);
    return v;
  }

  /** Each room type's price on the night of `date` (the plain rate, as other channels sell it). */
  function pricesOn(m, date) {
    const hit = m.priceCache.get(date);
    if (hit) return hit;
    const prices = new Map();
    try {
      for (const rt of buildRoomOffer(m.hotel, { checkIn: date, checkOut: addDays(date, 1) }).roomTypes) prices.set(rt.roomId, rt.rates[0]?.nightly[0]?.price);
    } catch {
      // no simulated prices: the fallback below
    }
    const fallback = Math.round((Number(m.hotel.priceHint) || FALLBACK_PRICE[m.category]) * dayFactor(date, m.market, m.city));
    const out = (roomId) => prices.get(roomId) || fallback;
    if (m.priceCache.size > 800) m.priceCache.clear();
    m.priceCache.set(date, out);
    return out;
  }

  // ---- the simulated guests: one decision per room and night, hashed ---------------------------------------

  const simOcc = (m, room, date) => hash01(`${m.id}|${room.number}|${date}|o`) < occRate(m, date);
  /** The guest of the night before stays on (never across the room's changeover day). */
  const continues = (m, room, date) => dayIndex(date) % STAY_CYCLE_DAYS !== room.cycleDay && hash01(`${m.id}|${room.number}|${date}|c`) < m.cont;
  /** A NanaHotel guest holds this room on `date` (from arrival through the day they leave). */
  const heldByGuest = (real, number, date) => (real.byRoom.get(number) || []).some((r) => r.start <= date && date <= r.end);
  const occAt = (m, real, room, date) => !heldByGuest(real, room.number, date) && simOcc(m, room, date);

  function guestName(m, room, start) {
    return simGuestName(hash01(`${m.id}|${room.number}|${start}|name`), hash01(`${m.id}|${room.number}|${start}|last`));
  }

  /** The simulated guest staying the night of `date` (which must be occupied): arrival, departure, masked name. */
  function simStay(m, real, room, date) {
    let start = date;
    for (let i = 0; i < STAY_CYCLE_DAYS && continues(m, room, start) && occAt(m, real, room, addDays(start, -1)); i++) start = addDays(start, -1);
    let last = date;
    for (let i = 0; i < STAY_CYCLE_DAYS; i++) {
      const next = addDays(last, 1);
      if (!(continues(m, room, next) && occAt(m, real, room, next))) break;
      last = next;
    }
    return { checkIn: start, checkOut: addDays(last, 1), name: guestName(m, room, start) };
  }

  /** Today's times of a simulated room: the leaving guest goes 7–11 AM, housekeeping follows, arrivals 3–10 PM. */
  function departAt(m, room, date) {
    return at(m, date, '07:00') + Math.round(240 * Math.sqrt(hash01(`${m.id}|${room.number}|${date}|dep`))) * MIN;
  }

  function cleanedAt(m, room, date) {
    return departAt(m, room, date) + (20 + Math.round(90 * hash01(`${m.id}|${room.number}|${date}|cln`))) * MIN;
  }

  function etaOf(m, room, date) {
    const minutes = Math.round((15 * 60 + 420 * hash01(`${m.id}|${room.number}|${date}|eta`) ** 1.3) / 30) * 30;
    return { at: at(m, date, '00:00') + minutes * MIN, time: hhmm(minutes) };
  }

  // ---- NanaHotel guests --------------------------------------------------------------------------------------

  /** This hotel's confirmed NanaHotel orders with their rooms (stays.js), and the days each holds its room. */
  function realOf(m, today) {
    const list = viaStays(() => stays.listHotelStays(m.id)).map(({ order, roomNumber, floor, stay }) => {
      // On the hotel's business day: a check-in at 5:20 AM belongs to the night in progress, like the grid's today.
      const inDate = stay?.checkedInAt ? earliestCheckIn(new Date(stay.checkedInAt), m.zone) : null;
      const outDate = stay?.checkedOutAt ? dateIn(stay.checkedOutAt, m.zone) : null;
      // Still in after the check-out date: the room is theirs until they leave.
      const end = outDate || (stay && today > order.checkOut ? today : order.checkOut);
      return { order, roomNumber, floor, stay, inDate, outDate, start: inDate && inDate < order.checkIn ? inDate : order.checkIn, end, nightsUntil: outDate || order.checkOut };
    });
    const byRoom = new Map();
    for (const r of list) {
      if (!byRoom.has(r.roomNumber)) byRoom.set(r.roomNumber, []);
      byRoom.get(r.roomNumber).push(r);
    }
    return { list, byRoom };
  }

  /** The NanaHotel stay holding a room on `date`: in the room first, then expected, then just left. */
  function holderOf(real, number, date) {
    const rank = (r) => (r.stay && !r.outDate ? 0 : !r.stay ? 1 : 2);
    let best = null;
    for (const r of real.byRoom.get(number) || []) if (r.start <= date && date <= r.end && (!best || rank(r) < rank(best))) best = r;
    return best;
  }

  /**
   * Everything one call needs about now: the hotel's day (`today`: the night in progress, so before 6 AM the
   * previous date), NanaHotel stays and requests, the day's room marks, the tickets.
   */
  function dayContext(m, t) {
    const today = earliestCheckIn(new Date(t), m.zone);
    const marks = new Map();
    for (const mk of roomMarks.values()) if (mk.hotelId === m.id && mk.date === today) marks.set(mk.number, mk);
    const ctx = { today, now: t, real: realOf(m, today), requests: viaStays(() => stays.listHotelRequests(m.id)), marks };
    ctx.tickets = ticketList(m, ctx);
    ctx.openTickets = new Map();
    for (const tk of ctx.tickets) if (tk.status === 'new' || tk.status === 'doing') ctx.openTickets.set(tk.roomNumber, (ctx.openTickets.get(tk.roomNumber) || 0) + 1);
    return ctx;
  }

  /** The grid's rooms plus any room a NanaHotel guest was given outside it (never for simulated hotels). */
  function gridRooms(m, ctx) {
    const extra = [];
    for (const r of ctx.real.list) {
      if (m.byNumber.has(r.roomNumber) || extra.some((x) => x.number === r.roomNumber)) continue;
      extra.push({ number: r.roomNumber, floor: r.floor, type: { roomId: r.order.room?.roomId, name: r.order.room?.name || 'Room' }, cycleDay: 0 });
    }
    return extra.length ? [...m.rooms, ...extra] : m.rooms;
  }

  function findRoom(m, ctx, number) {
    const n = str(number, 10);
    return gridRooms(m, ctx).find((r) => r.number === n) || null;
  }

  // ---- room status -------------------------------------------------------------------------------------------

  function roomView(m, ctx, room, date) {
    const holder = holderOf(ctx.real, room.number, date);
    let view;
    if (holder) view = guestRoom(holder, room, date, ctx);
    else if (date === ctx.today && ctx.marks.get(room.number)?.ooo) view = { number: room.number, roomType: room.type.name, status: 'ooo' };
    else view = simRoom(m, ctx, room, date);
    const open = date === ctx.today ? ctx.openTickets.get(room.number) : 0;
    if (open) view.tickets = open;
    return view;
  }

  function guestRoom(r, room, date, ctx) {
    const { order, stay } = r;
    const base = { number: room.number, roomType: order.room?.name || room.type.name };
    if (r.outDate) {
      // Left today: dirty until housekeeping (the front desk's Clean) has been.
      const mark = date === ctx.today ? ctx.marks.get(room.number) : null;
      const cleaned = mark?.cleanedAt && Date.parse(mark.cleanedAt) >= Date.parse(stay.checkedOutAt);
      return { ...base, roomType: room.type.name, status: cleaned ? 'vacant' : 'dirty' };
    }
    let status;
    if (stay) status = date >= order.checkOut ? 'departing' : 'occupied';
    else if (date > ctx.today) status = date === order.checkIn ? 'arriving' : date >= order.checkOut ? 'departing' : 'occupied';
    // Today: expected (or late); on the check-out day a guest who never came is not coming.
    else status = date < order.checkOut ? 'arriving' : null;
    if (!status) return { ...base, roomType: room.type.name, status: 'vacant' };
    return {
      ...base,
      status,
      guest: { name: maskName(order.guests?.[0]), orderId: order.id, checkIn: order.checkIn, checkOut: order.checkOut, source: 'nanahotel' },
    };
  }

  function simRoom(m, ctx, room, date) {
    const base = { number: room.number, roomType: room.type.name };
    const prev = addDays(date, -1);
    const was = occAt(m, ctx.real, room, prev);
    const is = occAt(m, ctx.real, room, date);
    const guestOf = (night) => {
      const s = simStay(m, ctx.real, room, night);
      return { name: s.name, checkIn: s.checkIn, checkOut: s.checkOut, source: 'sim' };
    };
    if (was && is && continues(m, room, date)) return { ...base, status: 'occupied', guest: guestOf(date) };
    if (date !== ctx.today) {
      if (was) return { ...base, status: 'departing', guest: guestOf(prev) };
      if (is) return { ...base, status: 'arriving', guest: guestOf(date) };
      return { ...base, status: 'vacant' };
    }
    if (was) {
      const leaves = departAt(m, room, date);
      if (ctx.now < leaves) return { ...base, status: 'departing', guest: guestOf(prev) };
      const mark = ctx.marks.get(room.number);
      const cleaned = (mark?.cleanedAt && Date.parse(mark.cleanedAt) >= leaves) || ctx.now >= cleanedAt(m, room, date);
      if (!cleaned) return { ...base, status: 'dirty' };
    }
    if (is) return { ...base, status: ctx.now < etaOf(m, room, date).at ? 'arriving' : 'occupied', guest: guestOf(date) };
    return { ...base, status: 'vacant' };
  }

  /**
   * GET rooms: the grid by floor for `date` (today by default, up to 6 days ahead), each room's status and guest.
   * @returns {{ date, counts: { vacant, dirty, occupied, arriving, departing, ooo }, floors: [{ floor, rooms }] }}
   */
  function rooms(hotelId, { date } = {}) {
    const m = modelFor(hotelId);
    const t = nowMs();
    const today = todayIn(m.zone, t);
    const last = addDays(today, ROOM_DAYS_AHEAD);
    const day = date === undefined || date === null || date === '' ? today : requireDate(date, 'room grid date');
    const ctx = dayContext(m, t);
    if (day < ctx.today || day > last) {
      throw new MerchantError('invalid_date', `The room grid covers today to ${ROOM_DAYS_AHEAD} days ahead (${formatDate(today)} – ${formatDate(last)})`);
    }
    // Before 6 AM "today" is the night still in progress.
    const night = day <= today ? ctx.today : day;
    const counts = { vacant: 0, dirty: 0, occupied: 0, arriving: 0, departing: 0, ooo: 0 };
    const byFloor = new Map();
    for (const room of gridRooms(m, ctx)) {
      const view = roomView(m, ctx, room, night);
      counts[view.status]++;
      if (!byFloor.has(room.floor)) byFloor.set(room.floor, []);
      byFloor.get(room.floor).push(view);
    }
    const floors = [...byFloor.entries()].sort((a, b) => a[0] - b[0])
      .map(([floor, list]) => ({ floor, rooms: list.sort((a, b) => Number(a.number) - Number(b.number)) }));
    return { date: day, counts, floors };
  }

  /**
   * POST rooms/:number: `clean` (vacant dirty → vacant clean), `ooo` (an empty room → out of order), `release`
   * (out of order → vacant clean) for today, or `check_in` a NanaHotel order at the front desk — in the room stays.js
   * gives it (else 409 wrong_room with the right one).
   * @returns {{ room, event? }}  event: { kind: 'front_desk_checkin', userId, sessionId, stay }
   */
  function roomAction(hotelId, number, body = {}) {
    const m = modelFor(hotelId);
    const action = str(body.action, 20);
    if (!ROOM_ACTIONS.includes(action)) throw new MerchantError('unknown_action', 'The room action needs to be clean, ooo (out of order), release (back in service) or check_in');
    const t = nowMs();
    const ctx = dayContext(m, t);
    const { today } = ctx;
    const room = findRoom(m, ctx, number);
    if (!room) throw new MerchantError('room_not_found', `This hotel has no room ${str(number, 10)}`);
    if (action === 'check_in') return frontDeskCheckIn(m, ctx, room, body.orderId);
    const view = roomView(m, ctx, room, today);
    const key = `${m.id}|${today}|${room.number}`;
    const mark = roomMarks.get(key) || { hotelId: m.id, date: today, number: room.number };
    if (action === 'clean') {
      if (view.status !== 'dirty') throw new MerchantError('invalid_action', `Room ${room.number} isn't vacant and dirty, so it doesn't need cleaning`);
      roomMarks.set(key, { ...mark, cleanedAt: iso(t) });
    } else if (action === 'ooo') {
      if (view.status !== 'vacant' && view.status !== 'dirty') throw new MerchantError('invalid_action', `Room ${room.number} has a guest; only a vacant room can be taken out of order`);
      roomMarks.set(key, { ...mark, ooo: true, oooAt: iso(t) });
    } else {
      if (view.status !== 'ooo') throw new MerchantError('invalid_action', `Room ${room.number} isn't out of order`);
      roomMarks.set(key, { ...mark, ooo: false, cleanedAt: iso(t) });
    }
    return { room: roomView(m, dayContext(m, t), room, today) };
  }

  function frontDeskCheckIn(m, ctx, room, orderIdRaw) {
    const orderId = str(orderIdRaw, 80).toUpperCase();
    if (!orderId || !ID_RE.test(orderId)) throw new MerchantError('invalid_order', 'Checking a guest in needs the order number (orderId)');
    const entry = ctx.real.list.find((r) => r.order.id === orderId);
    if (!entry) {
      const other = bookings.ordersForHotel(m.id).find((o) => o.id === orderId);
      if (!other) throw new MerchantError('not_found', "This hotel has no booking with that number");
      throw new MerchantError('order_not_confirmed', other.status === 'cancelled' ? "This booking was cancelled, so it can't be checked in" : "This booking isn't paid or has closed, so it can't be checked in");
    }
    if (entry.roomNumber !== room.number) {
      throw new MerchantError('wrong_room', `This booking is in room ${entry.roomNumber}; check the guest in there`, { roomNumber: entry.roomNumber });
    }
    const out = viaStays(() => stays.frontDeskCheckIn(orderId));
    const fresh = dayContext(m, nowMs());
    return {
      room: roomView(m, fresh, room, fresh.today),
      event: { kind: 'front_desk_checkin', userId: out.userId, sessionId: out.sessionId, stay: out.stay },
    };
  }

  // ---- tickets -----------------------------------------------------------------------------------------------

  const RANK = { new: 0, doing: 1, done: 2, declined: 2 };

  function serviceTitle(items) {
    return items.map((i) => (TASK_RE.test(i.name) && i.qty <= 1 ? i.name : `${i.name} ×${i.qty}`)).join(', ');
  }

  function actionsFor(kind, status, title) {
    if (kind === 'service') {
      const finish = TASK_RE.test(title) ? 'done' : 'deliver';
      return status === 'new' ? ['accept', finish] : status === 'doing' ? [finish] : [];
    }
    return kind === 'early_checkin' && status === 'new' ? ['approve', 'decline'] : [];
  }

  /** A NanaHotel guest's request as a ticket (null for kinds the hotel does not handle, or ones cancelled at check-out). */
  function guestTicket(m, r, order, roomNumber) {
    const common = { id: r.id, roomNumber, guest: maskName(order.guests?.[0]), source: 'nanahotel', orderId: order.id };
    let ticket = null;
    if (r.kind === 'service') {
      const status = { accepted: 'new', on_the_way: 'doing', done: 'done' }[r.status];
      ticket = { kind: 'service', title: serviceTitle(r.items), ...(r.note ? { note: r.note } : {}), createdAt: r.createdAt, dueAt: r.eta, status };
    } else if (r.kind === 'early_checkin') {
      const status = { pending: 'new', confirmed: 'done', declined: 'declined' }[r.status];
      if (!status) return null;
      ticket = {
        kind: 'early_checkin', title: `Early check-in ${formatTime(r.arrivalTime)}`, note: `Arriving ${formatDate(r.date)}`,
        createdAt: r.createdAt, dueAt: iso(at(m, r.date, r.arrivalTime)), status,
      };
    } else if (r.kind === 'wakeup' && r.status !== 'cancelled') {
      ticket = { kind: 'wakeup', title: `Wake-up call ${formatTime(timeIn(r.at, m.zone))}`, createdAt: r.createdAt, dueAt: r.at, status: r.status === 'done' ? 'done' : 'doing' };
    } else if (r.kind === 'dining' && r.status !== 'cancelled') {
      ticket = {
        kind: 'dining', title: `${r.kindLabel} for ${r.people} at ${formatTime(timeIn(r.at, m.zone))}`, note: [r.note, `${r.restaurant}, ${r.place} · ${r.table}`].filter(Boolean).join(' · '),
        createdAt: r.createdAt, dueAt: r.at, status: r.status === 'done' ? 'done' : 'doing',
      };
    }
    return ticket && { ...common, ...ticket, actions: actionsFor(ticket.kind, ticket.status, ticket.title) };
  }

  /**
   * The front desk's simulated requests created on `day` (by phone): 4–12 a day by hotel size, in rooms whose
   * simulated guests are in (an early check-in: a guest arriving that day). Each moves on with the clock — a delivery
   * waits 2–30 minutes for someone to take it — unless the console moved it first.
   */
  function simTickets(m, ctx, day) {
    const prev = addDays(day, -1);
    const inHouse = [];
    const arriving = [];
    for (const room of m.rooms) {
      if (!simOcc(m, room, day) || heldByGuest(ctx.real, room.number, day) || heldByGuest(ctx.real, room.number, prev)) continue;
      (simOcc(m, room, prev) && continues(m, room, day) ? inHouse : arriving).push(room);
    }
    const h = (i, k) => hash01(`${m.id}|${day}|t${i}|${k}`);
    const n = clamp(Math.round(m.rooms.length * occRate(m, day) * 0.045 * (0.7 + 0.6 * hash01(`${m.id}|${day}|tickets`))), 4, 12);
    const after = (hhmmText, minutes) => at(m, day, hhmmText) + Math.round(minutes) * MIN;
    const clock12 = (ms) => formatTime(timeIn(ms, m.zone));
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = h(i, 'kind');
      const kind = u < 0.55 ? 'service' : u < 0.73 ? 'wakeup' : u < 0.88 ? 'dining' : 'early_checkin';
      const pool = kind === 'early_checkin' ? arriving : inHouse;
      if (!pool.length) continue;
      const room = pool[Math.floor(h(i, 'room') * pool.length)];
      const guest = simStay(m, ctx.real, room, day).name;
      const id = `T-${m.id}-${day.replace(/-/g, '')}-${i + 1}`;
      let ticket;
      let timeStatus;
      if (kind === 'service') {
        const [name, qty] = SIM_ITEMS[Math.floor(h(i, 'item') * SIM_ITEMS.length)];
        const created = after('07:30', 930 * h(i, 'at'));
        const taken = created + (2 + Math.round(28 * h(i, 'wait') ** 1.5)) * MIN;
        const brought = taken + (5 + Math.round(10 * h(i, 'walk'))) * MIN;
        const note = h(i, 'note') < 0.3 ? SIM_NOTES[Math.floor(h(i, 'which') * SIM_NOTES.length)] : '';
        ticket = { kind, title: serviceTitle([{ name, qty }]), ...(note ? { note } : {}), createdAt: iso(created), dueAt: iso(brought) };
        timeStatus = ctx.now < taken ? 'new' : ctx.now < brought ? 'doing' : 'done';
      } else if (kind === 'wakeup') {
        const due = at(m, addDays(day, 1), '06:00') + Math.round(10 * h(i, 'due')) * 15 * MIN;
        ticket = { kind, title: `Wake-up call ${clock12(due)}`, createdAt: iso(after('20:00', 210 * h(i, 'at'))), dueAt: iso(due) };
        timeStatus = ctx.now < due ? 'doing' : 'done';
      } else if (kind === 'dining') {
        const breakfast = h(i, 'meal') < 0.3;
        const due = breakfast
          ? at(m, addDays(day, 1), '07:00') + Math.round(4 * h(i, 'due')) * 30 * MIN
          : at(m, day, '18:00') + Math.round(5 * h(i, 'due')) * 30 * MIN;
        const people = 1 + Math.floor(4 * h(i, 'people'));
        ticket = { kind, title: `${breakfast ? 'Breakfast' : 'Dinner'} for ${people} at ${clock12(due)}`, createdAt: iso(after('09:00', 540 * h(i, 'at'))), dueAt: iso(due) };
        timeStatus = ctx.now < due ? 'doing' : 'done';
      } else {
        const created = after('07:00', 180 * h(i, 'at'));
        const due = Math.max(at(m, day, '10:00') + Math.round(6 * h(i, 'due')) * 30 * MIN, Math.ceil((created + 30 * MIN) / (30 * MIN)) * 30 * MIN);
        ticket = { kind, title: `Early check-in ${clock12(due)}`, note: `Arriving ${formatDate(day)}`, createdAt: iso(created), dueAt: iso(due) };
        // Nobody answered before the guest came: the front desk sorted it out on arrival.
        timeStatus = ctx.now < due ? 'new' : 'done';
      }
      const mark = ticketMarks.get(id);
      const status = mark && mark.hotelId === m.id && RANK[mark.status] >= RANK[timeStatus] ? mark.status : timeStatus;
      out.push({ id, kind, roomNumber: room.number, guest, source: 'sim', ...ticket, status, actions: actionsFor(kind, status, ticket.title) });
    }
    return out;
  }

  /** Tickets newest first: NanaHotel guests' requests and the simulated ones; finished ones only from the last 24 hours. */
  function ticketList(m, ctx) {
    const out = [];
    for (const { request, order, roomNumber } of ctx.requests) {
      const ticket = guestTicket(m, request, order, roomNumber);
      if (ticket) out.push(ticket);
    }
    for (const day of [addDays(ctx.today, -1), ctx.today]) out.push(...simTickets(m, ctx, day));
    const t = ctx.now;
    return out
      .filter((tk) => Date.parse(tk.createdAt) <= t && (RANK[tk.status] < 2 || Date.parse(tk.createdAt) >= t - TICKET_KEEP_MS))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  }

  /** GET tickets → { tickets }. */
  function tickets(hotelId) {
    const m = modelFor(hotelId);
    return { tickets: dayContext(m, nowMs()).tickets };
  }

  function whyNot(ticket, action) {
    if (ticket.kind === 'wakeup' || ticket.kind === 'dining') return 'Wake-up calls and table reservations finish on their own at their time';
    if (ticket.kind === 'early_checkin') return ticket.status === 'new' ? 'An early check-in can only be approved or declined' : 'This early check-in was already answered';
    if (ticket.status === 'done') return 'This one is already done';
    if (action === 'accept') return 'This one was already accepted and is on its way';
    return 'A delivery can only be accepted, delivered or marked done';
  }

  /**
   * POST tickets/:id: a delivery `accept` (→ doing; the guest's card says on the way) or `deliver` / `done` (→ done;
   * delivered); an early check-in `approve` / `decline`. Anything the ticket cannot do now is a 409 invalid_action.
   * @returns {{ ticket, event? }}  event: { kind: 'early_checkin_approved' | 'early_checkin_declined', userId, sessionId, request }
   */
  function ticketAction(hotelId, ticketId, body = {}) {
    const m = modelFor(hotelId);
    const action = str(body.action, 20);
    if (!TICKET_ACTIONS.includes(action)) throw new MerchantError('unknown_action', 'The ticket action needs to be accept, deliver, done, approve or decline');
    const t = nowMs();
    const id = str(ticketId, 80);
    const ticket = dayContext(m, t).tickets.find((tk) => tk.id === id);
    if (!ticket) throw new MerchantError('not_found', "Couldn't find that ticket (finished ones disappear after 24 hours)");
    const finish = ticket.actions.find((a) => a === 'deliver' || a === 'done');
    const allowed = ticket.actions.includes(action) || (finish && (action === 'deliver' || action === 'done'));
    if (!allowed) throw new MerchantError('invalid_action', whyNot(ticket, action));
    let event;
    if (ticket.source === 'nanahotel') {
      const out = viaStays(() => stays.advanceRequest(id, action));
      if (ticket.kind === 'early_checkin') {
        event = { kind: action === 'approve' ? 'early_checkin_approved' : 'early_checkin_declined', userId: out.userId, sessionId: out.sessionId, request: out.request };
      }
    } else {
      const status = action === 'accept' ? 'doing' : action === 'decline' ? 'declined' : 'done';
      ticketMarks.set(id, { id, hotelId: m.id, status, action, at: iso(t) });
    }
    const fresh = dayContext(m, t).tickets.find((tk) => tk.id === id) || ticket;
    return { ticket: fresh, ...(event ? { event } : {}) };
  }

  // ---- reviews -----------------------------------------------------------------------------------------------

  /** Shares of 5…1 stars for a hotel rated `rating` (3.6 → many 3–4 stars, 4.9 → nearly all 5). */
  function starShares(rating) {
    const x = clamp(((Number(rating) || 4.3) - 3.6) / 1.3, 0, 1);
    return { 5: 0.4 + 0.53 * x, 4: 0.3 - 0.25 * x, 3: 0.15 - 0.14 * x, 2: 0.09 - 0.085 * x, 1: 0.06 - 0.055 * x };
  }

  function praiseKeys(m) {
    const keys = ['location', 'clean', 'service', 'bed', 'quiet'];
    if (m.category !== 'budget' || (m.hotel.amenities || []).includes('Free breakfast')) keys.push('breakfast');
    if (m.category === 'budget' || m.category === 'midscale') keys.push('value');
    if (m.view) keys.push('view');
    if (m.kind === 'station' || m.kind === 'airport') keys.push('transit');
    if (m.category === 'upscale' || m.category === 'luxury') keys.push('facility');
    if ((m.hotel.tags || []).includes('Family-friendly')) keys.push('family');
    return keys;
  }

  /** The simulated reviews of the last 60 days (0–2 a day by how popular the hotel is), newest first. */
  function simReviews(m, today, t) {
    const out = [];
    const shares = starShares(m.hotel.rating);
    const perDay = clamp((Number(m.hotel.reviewCount) || 500) / 1800, 0.25, 1.5);
    const keys = praiseKeys(m);
    const vars = { lm: m.landmark, view: m.view || 'view' };
    for (let i = 0; i < REVIEW_DAYS && out.length < MAX_SIM_REVIEWS; i++) {
      const day = addDays(today, -i);
      const count = (hash01(`${m.id}|${day}|rv1`) < perDay * 0.7 ? 1 : 0) + (hash01(`${m.id}|${day}|rv2`) < perDay * 0.3 ? 1 : 0);
      for (let k = 0; k < count && out.length < MAX_SIM_REVIEWS; k++) {
        const h = (key) => hash01(`${m.id}|${day}|rv${k}|${key}`);
        const atMs = at(m, day, '08:00') + Math.round(930 * h('at')) * MIN;
        if (atMs > t) continue;
        let u = h('stars');
        let rating = 5;
        for (const s of [5, 4, 3, 2, 1]) {
          if (u < shares[s]) {
            rating = s;
            break;
          }
          u -= shares[s];
          rating = s;
        }
        const pickPraise = (n) => {
          const chosen = [];
          for (let j = 0; chosen.length < n && j < 8; j++) {
            const key = keys[Math.floor(h(`p${j}`) * keys.length)];
            if (!chosen.includes(key)) chosen.push(key);
          }
          return chosen;
        };
        const pickIssue = (j) => {
          const all = Object.keys(ISSUES);
          return h(`i${j}`) < 0.7 ? m.weak[Math.floor(h(`w${j}`) * m.weak.length)] : all[Math.floor(h(`a${j}`) * all.length)];
        };
        const say = (list, key) => fill(list[Math.floor(h(`say-${key}`) * list.length)], vars);
        let praise = [];
        let issues = [];
        let text;
        if (rating === 5) {
          praise = pickPraise(2 + (h('n') < 0.4 ? 1 : 0));
          const ending = ['Would stay again.', 'Highly recommend!', 'Loved it overall.', "We'll be back.", ''][Math.floor(h('end') * 5)];
          text = `${praise.map((key) => say(PRAISE[key][1], key)).join('. ')}. ${ending}`.trim();
        } else if (rating === 4) {
          praise = pickPraise(2);
          issues = h('minor') < 0.5 ? [pickIssue(0)] : [];
          text = `${praise.map((key) => say(PRAISE[key][1], key)).join('. ')}.${issues.length ? ` Only thing: ${lowerFirst(say(ISSUES[issues[0]].phrases, issues[0]))}.` : ''}`;
        } else if (rating === 3) {
          praise = pickPraise(1);
          issues = [pickIssue(0)];
          text = `${say(PRAISE[praise[0]][1], praise[0])}, but ${lowerFirst(say(ISSUES[issues[0]].phrases, issues[0]))}. Overall it was okay.`;
        } else {
          issues = [...new Set([pickIssue(0), pickIssue(1)])];
          text = `${issues.map((key) => say(ISSUES[key].phrases, key)).join('. ')}. ${rating === 1 ? "A really bad experience; we won't be back." : 'A bit disappointing.'}`;
        }
        const id = `R-${m.id}-${day.replace(/-/g, '')}-${k + 1}`;
        const review = {
          id, source: 'sim', guest: simGuestName(h('name'), h('last')), rating, text: capitalize(text),
          tags: [...praise.map((key) => PRAISE[key][0]), ...issues.map((key) => ISSUES[key].tag)].slice(0, 3),
          roomType: m.types[Math.min(m.types.length - 1, Math.floor(m.types.length * h('room') ** 1.8))].name,
          at: iso(atMs), issues,
        };
        // Hotels answer most reviews within a day or two, complaints first.
        const repliedAt = atMs + Math.round((2 + 28 * h('replyAt')) * 60) * MIN;
        if (h('reply') < (rating <= 3 ? 0.85 : 0.6) && repliedAt <= t) review.reply = { text: draftText(m, review), at: iso(repliedAt) };
        out.push(review);
      }
    }
    return out;
  }

  /** Issue keys a review mentions: a simulated one says; a guest's text is read for them (complaints only). */
  function issuesOf(review) {
    if (Array.isArray(review.issues)) return review.issues;
    if (review.rating > 3) return [];
    return Object.keys(ISSUES).filter((key) => ISSUES[key].re.test(review.text || ''));
  }

  function reviewList(m, t, requests = viaStays(() => stays.listHotelRequests(m.id))) {
    const real = requests
      .filter(({ request }) => request.kind === 'review' && request.status === 'published')
      .map(({ request: r, order }) => ({
        id: r.id, source: 'nanahotel', guest: maskName(order.guests?.[0]), rating: r.rating, text: r.text, tags: [...(r.tags || [])],
        roomType: order.room?.name || undefined, at: r.publishedAt, ...(r.reply ? { reply: { ...r.reply } } : {}),
      }));
    const sim = simReviews(m, todayIn(m.zone, t), t).map((rv) => {
      const own = replies.get(rv.id);
      return own && own.hotelId === m.id ? { ...rv, reply: { text: own.text, at: own.at } } : rv;
    });
    return [...real, ...sim].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  function publicReview(rv) {
    const { issues, ...out } = rv;
    if (!out.roomType) delete out.roomType;
    return out;
  }

  /** Rating, count, star distribution and tags: the hotel's whole history (simulated) plus NanaHotel guests' reviews. */
  function reviewSummary(m, list) {
    const real = list.filter((rv) => rv.source === 'nanahotel');
    const baseCount = Math.max(0, Math.round(Number(m.hotel.reviewCount) || 0));
    const shares = starShares(m.hotel.rating);
    const exact = [5, 4, 3, 2, 1].map((s) => shares[s] * baseCount);
    const counts = exact.map(Math.floor);
    let left = baseCount - counts.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; left > 0; k = (k + 1) % 5, left--) counts[order[k][1]]++;
    const distribution = { 5: counts[0], 4: counts[1], 3: counts[2], 2: counts[3], 1: counts[4] };
    for (const rv of real) distribution[rv.rating] = (distribution[rv.rating] || 0) + 1;
    const count = baseCount + real.length;
    const rating = count ? round(((Number(m.hotel.rating) || 4.3) * baseCount + real.reduce((s, rv) => s + rv.rating, 0)) / count, 1) : Number(m.hotel.rating) || null;
    const tagCounts = new Map();
    praiseKeys(m).forEach((key, i) => tagCounts.set(PRAISE[key][0], Math.round(baseCount * (0.06 + 0.16 * hash01(`${m.id}|tag|${key}`)) * (i < 3 ? 1.3 : 1))));
    for (const key of m.weak) tagCounts.set(ISSUES[key].tag, Math.round(baseCount * (shares[3] + shares[2]) * (0.25 + 0.2 * hash01(`${m.id}|tag|${key}`))));
    for (const rv of real) for (const tag of rv.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const tags = [...tagCounts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([tag, n]) => ({ tag, count: n }));
    return { rating, count, distribution, tags };
  }

  /** GET reviews → { summary, reviews } (newest first). */
  function reviews(hotelId) {
    const m = modelFor(hotelId);
    const list = reviewList(m, nowMs());
    return { summary: reviewSummary(m, list), reviews: list.map(publicReview) };
  }

  function findReview(m, reviewId) {
    const id = str(reviewId, 80);
    const review = ID_RE.test(id) ? reviewList(m, nowMs()).find((rv) => rv.id === id) : null;
    if (!review) throw new MerchantError('not_found', "Couldn't find that review");
    return review;
  }

  /** A hotel's short name for signing a reply: 'The Ashgrove Times Square' → 'The Ashgrove'. */
  function shortName(hotel) {
    const name = String(hotel.name || 'our hotel');
    const area = findCity(hotel.city)?.areas.find((a) => a.name === hotel.businessArea);
    const trimmed = area ? name.replace(new RegExp(`\\s+(?:${[area.short, hotel.city].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`), '') : name;
    return trimmed || name;
  }

  /** A reply by template from the rating and what the review praised or complained about (no LLM). */
  function draftText(m, review) {
    const name = shortName(m.hotel);
    const v = hashString(`${review.id}|draft`) % 2;
    const [issue] = issuesOf(review);
    const fix = issue ? `About ${ISSUES[issue].label}: ${ISSUES[issue].remedy}. ` : '';
    if (review.rating >= 4) {
      const liked = LIKED.find(([key, re]) => (review.tags || []).includes(PRAISE[key]?.[0]) || re.test(review.text || ''))?.[2] || 'team';
      return v
        ? `Thank you for the wonderful review! We're so glad you enjoyed our ${liked}. ${fix}We hope to welcome you back to ${name} soon.`
        : `Thanks so much for your kind words! Hearing that you loved our ${liked} means a lot to the whole team. ${fix}We look forward to your next stay at ${name}.`;
    }
    if (review.rating === 3) return `Thank you for staying with us and for the honest feedback. ${fix || "We've shared your comments with the team so we can do better. "}We hope to give you a better experience next time at ${name}.`;
    return `We're very sorry your stay didn't meet your expectations. ${fix || 'Our manager on duty is looking into your feedback. '}If you're open to it, please contact the front desk so we can make this right.`;
  }

  /** POST reviews/:id/draft-reply → { text }: a reply drafted from the review, for the hotel to edit. */
  function draftReply(hotelId, reviewId) {
    const m = modelFor(hotelId);
    return { text: draftText(m, findReview(m, reviewId)) };
  }

  /**
   * POST reviews/:id/reply { text } (1–500 characters) → { review }. A NanaHotel guest's review carries the reply on
   * their review card too, and they hear about it (event, when the text is new).
   * @returns {{ review, event? }}  event: { kind: 'review_replied', userId, sessionId, review }
   */
  function replyReview(hotelId, reviewId, body = {}) {
    const m = modelFor(hotelId);
    const text = cleanText(body.text);
    if (!text) throw new MerchantError('invalid_reply', 'The reply needs some text');
    if (text.length > MAX_REPLY_CHARS) throw new MerchantError('invalid_reply', `Replies can be up to ${MAX_REPLY_CHARS} characters (this one has ${text.length}); make it shorter`);
    const review = findReview(m, reviewId);
    if (review.source === 'nanahotel') {
      const out = viaStays(() => stays.replyReview(review.id, text));
      const updated = { ...review, reply: { ...out.review.reply } };
      const event = out.changed ? { kind: 'review_replied', userId: out.userId, sessionId: out.sessionId, review: out.review } : null;
      return { review: publicReview(updated), ...(event ? { event } : {}) };
    }
    const atText = iso(nowMs());
    replies.set(review.id, { id: review.id, hotelId: m.id, text, at: atText });
    return { review: publicReview({ ...review, reply: { text, at: atText } }) };
  }

  // ---- deals -------------------------------------------------------------------------------------------------

  /** Views accrue while a deal is on (until it ends), more for bigger hotels and deeper discounts; NanaHotel orders are real. */
  function promotionView(m, p, t, guestOrders) {
    const endMs = at(m, addDays(p.to, 1), '00:00');
    const onMs = (p.activeMs || 0) + (p.active && p.activeSince ? Math.max(0, Math.min(t, endMs) - Date.parse(p.activeSince)) : 0);
    const perHour = (4 + 10 * hash01(`${p.id}|views`)) * (1 + (1 - p.discount) * 2) * clamp(m.rooms.length / 200, 0.4, 2);
    const views = Math.floor((onMs / HOUR) * perHour);
    const orders = guestOrders.filter((o) => o.rate?.promo?.id === p.id).length + Math.floor(views * (0.02 + 0.03 * hash01(`${p.id}|conv`)));
    return { id: p.id, title: p.title, discount: p.discount, from: p.from, to: p.to, active: Boolean(p.active), createdAt: p.createdAt, stats: { views, orders } };
  }

  function confirmedOrders(m) {
    return bookings.ordersForHotel(m.id).filter((o) => o.status === 'confirmed');
  }

  /** GET promotions → { promotions } (newest first). */
  function listPromotions(hotelId) {
    const m = modelFor(hotelId);
    const t = nowMs();
    const orders = confirmedOrders(m);
    return { promotions: promos.listFor(m.id).map((p) => promotionView(m, p, t, orders)) };
  }

  /** POST promotions { title, discount, from, to } → { promotion }. */
  function createPromotion(hotelId, body = {}) {
    const m = modelFor(hotelId);
    const p = promos.create(m.id, body || {}, m.zone);
    return { promotion: promotionView(m, p, nowMs(), confirmedOrders(m)) };
  }

  /** POST promotions/:id { active } → { promotion }. */
  function setPromotion(hotelId, promotionId, body = {}) {
    const m = modelFor(hotelId);
    const p = promos.setActive(m.id, promotionId, body?.active);
    return { promotion: promotionView(m, p, nowMs(), confirmedOrders(m)) };
  }

  // ---- overview ----------------------------------------------------------------------------------------------

  /** Rooms sold, room revenue, F&B and NanaHotel room nights for the night of `date`; channels when asked. */
  function nightStats(m, real, date, channels) {
    const price = pricesOn(m, date);
    const rate = occRate(m, date);
    let sold = 0;
    let revenue = 0;
    for (const room of m.rooms) {
      if (heldByGuest(real, room.number, date) || hash01(`${m.id}|${room.number}|${date}|o`) >= rate) continue;
      sold++;
      revenue += price(room.type.roomId) * (0.9 + 0.2 * hash01(`${m.id}|${room.number}|${date}|rate`));
      if (channels) {
        const ch = pickChannel(m, hash01(`${m.id}|${room.number}|${date}|ch`));
        channels[ch] = (channels[ch] || 0) + 1;
      }
    }
    let ours = 0;
    for (const r of real.list) {
      if (!(r.start <= date && date < r.nightsUntil)) continue;
      const roomsBooked = Number(r.order.rooms) || 1;
      sold += roomsBooked;
      const night = (r.order.nightly || []).find((n) => n.date === date);
      if (night) {
        revenue += night.price * roomsBooked;
        ours += roomsBooked;
      }
    }
    if (channels) channels.nanahotel = (channels.nanahotel || 0) + ours;
    const fnb = sold * FNB_PER_ROOM[m.category] * (0.75 + 0.5 * hash01(`${m.id}|${date}|fnb`));
    return { sold, occupancy: Math.min(1, sold / m.rooms.length), roomRevenue: revenue, fnb, nanahotel: ours };
  }

  function channelWeights(m) {
    const w = { ...CHANNEL_MIX };
    if (m.category === 'budget') Object.assign(w, { expedia: w.expedia + 0.04, booking: w.booking + 0.06, direct: w.direct - 0.1 });
    if (m.category === 'luxury') Object.assign(w, { direct: w.direct + 0.12, booking: w.booking - 0.08, expedia: w.expedia - 0.04 });
    if (['scenic', 'resort', 'beach', 'inn'].includes(m.kind)) Object.assign(w, { google: w.google + 0.05, direct: w.direct - 0.05 });
    if (m.kind === 'cbd') Object.assign(w, { direct: w.direct + 0.06, google: w.google - 0.03, booking: w.booking - 0.03 });
    for (const k of Object.keys(w)) w[k] = Math.max(0.02, w[k] * (0.85 + 0.3 * hash01(`${m.id}|mix|${k}`)));
    return w;
  }

  function pickChannel(m, u) {
    m.mix ??= channelWeights(m);
    const total = Object.values(m.mix).reduce((a, b) => a + b, 0);
    let x = u * total;
    for (const [k, w] of Object.entries(m.mix)) {
      if (x < w) return k;
      x -= w;
    }
    return 'expedia';
  }

  /** Today's arrivals: NanaHotel guests first, then the simulated ones by arrival time. */
  function arrivalsToday(m, ctx) {
    const out = [];
    for (const r of ctx.real.list) {
      const { order, stay } = r;
      const arriving = !stay && order.checkIn <= ctx.today && order.checkOut > ctx.today;
      const arrivedToday = stay && order.checkIn === ctx.today;
      if (!arriving && !arrivedToday) continue;
      const early = ctx.requests.find((x) => x.order.id === order.id && x.request.kind === 'early_checkin' && x.request.status !== 'cancelled')?.request;
      const eta = HHMM_RE.test(order.arrivalTime || '') ? order.arrivalTime.padStart(5, '0') : early?.arrivalTime;
      out.push({
        orderId: order.id, guest: maskName(order.guests?.[0]), roomType: order.room?.name || '', nights: order.nights,
        ...(eta ? { eta } : {}), source: 'nanahotel', status: stay ? 'checked_in' : 'arriving',
      });
    }
    const sim = [];
    const prev = addDays(ctx.today, -1);
    for (const room of m.rooms) {
      if (!occAt(m, ctx.real, room, ctx.today)) continue;
      if (occAt(m, ctx.real, room, prev) && continues(m, room, ctx.today)) continue;
      if (ctx.marks.get(room.number)?.ooo) continue;
      const s = simStay(m, ctx.real, room, ctx.today);
      const eta = etaOf(m, room, ctx.today);
      sim.push({
        guest: s.name, roomType: room.type.name, nights: Math.max(1, Math.round((Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 86400000)),
        eta: eta.time, source: 'sim', status: ctx.now >= eta.at ? 'checked_in' : 'arriving',
      });
    }
    sim.sort((a, b) => (a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0));
    return { list: [...out, ...sim], count: out.length + sim.length };
  }

  function whenText(date, today) {
    if (date === today) return 'Tonight';
    if (date === addDays(today, 1)) return 'Tomorrow';
    if (date <= addDays(today, 6)) return weekdayLong(date);
    return formatDate(date);
  }

  /** 2–4 suggestions from rules over the numbers, the tickets and the reviews. */
  function buildInsights(m, ctx, { forecast, arrivals, reviewsList, orders }) {
    const out = [];
    const today = ctx.today;
    const waiting = ctx.tickets.filter((tk) => tk.status === 'new' && ctx.now - Date.parse(tk.createdAt) >= WAIT_ALERT_MS);
    if (waiting.length) {
      const oldest = waiting.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      out.push({
        id: 'tickets-waiting', level: 'warn', title: `${plural(waiting.length, 'request')} not picked up`,
        text: `The oldest has waited ${Math.round((ctx.now - Date.parse(oldest.createdAt)) / MIN)} minutes: room ${oldest.roomNumber}, ${oldest.title}`,
        action: { tab: 'tickets', label: 'Handle them' },
      });
    }
    const since = ctx.now - 30 * 24 * HOUR;
    const mentions = new Map();
    for (const rv of reviewsList) {
      if (Date.parse(rv.at) < since || rv.rating > 3) continue;
      for (const key of issuesOf(rv)) mentions.set(key, (mentions.get(key) || 0) + 1);
    }
    const [topIssue] = [...mentions.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (topIssue && topIssue[1] >= 2) {
      const issue = ISSUES[topIssue[0]];
      out.push({
        id: `reviews-${topIssue[0]}`, level: 'warn', title: `${topIssue[1]} reviews mention ${issue.label}`,
        text: `${topIssue[1]} critical reviews in the last 30 days mention ${issue.label}: ${issue.advice}.`, action: { tab: 'reviews', label: 'Reply' },
      });
    }
    const ourArrivals = arrivals.filter((a) => a.source === 'nanahotel' && a.status === 'arriving');
    if (ourArrivals.length) {
      const first = ourArrivals[0];
      out.push({
        id: 'nanahotel-arrivals', level: 'tip', title: `${plural(ourArrivals.length, 'NanaHotel guest')} arriving today`,
        text: `${first.guest} · ${first.roomType}${first.eta ? `, expected around ${formatTime(first.eta)}` : ''}; check them in from the room grid when they arrive.`,
        action: { tab: 'rooms', label: 'Open rooms' },
      });
    }
    const full = forecast.find((f) => f.occupancy >= 0.9);
    if (full) {
      out.push({
        id: `full-${full.date}`, level: 'tip', title: `${whenText(full.date, today)} looks full`,
        text: `${formatDate(full.date)} is forecast at ${Math.round(full.occupancy * 100)}%: consider raising the ${m.types[0].name} rate 8–12% and holding back rooms from discount channels.`,
        action: { tab: 'reviews', label: 'Promotions' },
      });
    }
    const active = promos.activeFor(m.id);
    const low = forecast.slice(0, 7).filter((f) => f.occupancy < 0.55 && !active.some((p) => p.from <= f.date && f.date <= p.to))
      .sort((a, b) => a.occupancy - b.occupancy)[0];
    if (low) {
      out.push({
        id: `low-${low.date}`, level: 'tip', title: `${whenText(low.date, today)} looks quiet`,
        text: `${formatDate(low.date)} is forecast at only ${Math.round(low.occupancy * 100)}%: a limited-time deal (like 15% off) shows up when NanaHotel travelers search.`,
        action: { tab: 'reviews', label: 'Start a deal' },
      });
    }
    const week = (from, to) => orders.filter((o) => {
      const created = Date.parse(o.createdAt);
      return created >= from && created < to;
    });
    const thisWeek = week(ctx.now - 7 * 24 * HOUR, ctx.now + 1);
    const lastWeek = week(ctx.now - 14 * 24 * HOUR, ctx.now - 7 * 24 * HOUR);
    if (thisWeek.length > lastWeek.length) {
      const nights = thisWeek.reduce((s, o) => s + (Number(o.nights) || 0) * (Number(o.rooms) || 1), 0);
      out.push({
        id: 'nanahotel-up', level: 'good', title: `NanaHotel bookings up ${thisWeek.length - lastWeek.length} this week`,
        text: `${plural(thisWeek.length, 'booking')} from NanaHotel this week (last week ${lastWeek.length}), ${plural(nights, 'room night')}.`,
      });
    }
    const unreplied = reviewsList.filter((rv) => !rv.reply && Date.parse(rv.at) >= ctx.now - 7 * 24 * HOUR);
    if (unreplied.length) {
      out.push({
        id: 'reviews-unreplied', level: 'tip', title: `${plural(unreplied.length, 'new review')} without a reply`,
        text: 'A quick reply to a critical review wins back goodwill, and good ones deserve a thank-you; NanaHotel can draft one for you.', action: { tab: 'reviews', label: 'Reply' },
      });
    }
    const recent = reviewsList.filter((rv) => Date.parse(rv.at) >= since);
    const good = recent.filter((rv) => rv.rating >= 4).length;
    out.push({
      id: 'reviews-good', level: 'good', title: recent.length ? `${Math.round((good / recent.length) * 100)}% positive in the last 30 days` : `Rated ${m.hotel.rating}`,
      text: recent.length ? `${good} of ${recent.length} new reviews are 4 stars or more; keep it up.` : 'No new reviews lately; remind guests at check-out to leave one.',
    });
    return out.slice(0, 4);
  }

  /**
   * GET overview?days=30: today's KPIs, the last `days` nights (old → new, tonight last), the next 14 nights'
   * forecast, the channel mix over those days, today's arrivals and 2–4 suggestions. See docs/MERCHANT.md §2.
   */
  function overview(hotelId, { days } = {}) {
    const m = modelFor(hotelId);
    let n = DEFAULT_DAYS;
    if (!(days === undefined || days === null || days === '')) {
      n = typeof days === 'number' ? days : Number(String(days).trim());
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new MerchantError('invalid_days', `days needs to be a whole number from 1 to ${MAX_DAYS}`);
    }
    const t = nowMs();
    const ctx = dayContext(m, t);
    // Tonight is the night in progress (before 6 AM the one that began yesterday); `date` is the calendar date.
    const { today } = ctx;
    const total = m.rooms.length;
    const dining = diningByDate(m, ctx.requests);
    const diningOn = (date) => dining.get(date) || 0;
    const channels = {};
    const series = [];
    for (let i = n - 1; i >= 0; i--) {
      const date = addDays(today, -i);
      const s = nightStats(m, ctx.real, date, channels);
      series.push({
        date, occupancy: round(s.occupancy, 3), revenue: Math.round(s.roomRevenue + s.fnb + diningOn(date)),
        adr: s.sold ? Math.round(s.roomRevenue / s.sold) : 0, xiaosu: s.nanahotel, nanahotel: s.nanahotel,
      });
    }
    const forecast = [];
    for (let i = 1; i <= FORECAST_DAYS; i++) {
      const date = addDays(today, i);
      forecast.push({ date, occupancy: round(nightStats(m, ctx.real, date).occupancy, 3) });
    }
    const tonight = nightStats(m, ctx.real, today);
    const lastWeek = nightStats(m, ctx.real, addDays(today, -7));
    const revenue = tonight.roomRevenue + tonight.fnb + diningOn(today);
    const revenueLastWeek = lastWeek.roomRevenue + lastWeek.fnb + diningOn(addDays(today, -7));
    const grid = gridRooms(m, ctx).map((room) => roomView(m, ctx, room, today));
    const arrivals = arrivalsToday(m, ctx);
    const prev = addDays(today, -1);
    let departures = 0;
    for (const room of m.rooms) {
      if (occAt(m, ctx.real, room, prev) && !(occAt(m, ctx.real, room, today) && continues(m, room, today))) departures++;
    }
    departures += ctx.real.list.filter((r) => r.stay && (r.outDate ? r.outDate === today : r.order.checkOut === today)).length;
    const list = reviewList(m, t, ctx.requests);
    const summary = reviewSummary(m, list);
    const nightsTotal = Object.values(channels).reduce((a, b) => a + b, 0) || 1;
    return {
      hotel: { id: m.id, name: m.hotel.name, city: m.hotel.city || '', category: m.category, rating: m.hotel.rating ?? null, rooms: total, timeZone: m.zone },
      date: todayIn(m.zone, t),
      currency: 'USD',
      kpis: {
        occupancy: round(tonight.occupancy, 3),
        revenue: Math.round(revenue),
        adr: tonight.sold ? Math.round(tonight.roomRevenue / tonight.sold) : 0,
        revpar: Math.round(tonight.roomRevenue / total),
        arrivals: arrivals.count,
        departures,
        inHouse: grid.filter((r) => r.status === 'occupied' || r.status === 'departing').length,
        openTickets: ctx.tickets.filter((tk) => tk.status === 'new' || tk.status === 'doing').length,
        rating: summary.rating,
        reviewCount: summary.count,
        vsLastWeek: {
          occupancy: lastWeek.occupancy ? round((tonight.occupancy - lastWeek.occupancy) / lastWeek.occupancy, 3) : 0,
          revenue: revenueLastWeek ? round((revenue - revenueLastWeek) / revenueLastWeek, 3) : 0,
        },
      },
      series,
      forecast,
      channels: CHANNELS.map((key) => ({ key, label: CHANNEL_LABELS[key], share: round((channels[key] || 0) / nightsTotal, 3), nights: channels[key] || 0 })),
      arrivals: arrivals.list.slice(0, MAX_ARRIVALS),
      insights: buildInsights(m, ctx, { forecast, arrivals: arrivals.list, reviewsList: list, orders: confirmedOrders(m) }),
    };
  }

  /** NanaHotel guests' meals served, on the room bill, by date (simulated F&B is in nightStats). */
  function diningByDate(m, requests) {
    const byDate = new Map();
    for (const { request: r } of requests) {
      if (r.kind !== 'dining' || r.status !== 'done' || !(r.price > 0)) continue;
      const date = dateIn(r.at, m.zone);
      byDate.set(date, (byDate.get(date) || 0) + r.price * Math.max(0, r.people - (Number(r.covered) || 0)));
    }
    return byDate;
  }

  // ---- hotels ------------------------------------------------------------------------------------------------

  /** The first simulated hotel of a city (by code) that `pred` accepts, or null (not the simulator's ids). */
  function firstHotel(code, pred) {
    for (let i = 1; i <= 40; i++) {
      let hotel = null;
      try {
        hotel = hotels.getHotel(`sim-${code}-${String(i).padStart(3, '0')}`);
      } catch {
        hotel = null;
      }
      if (!hotel) return null;
      if (pred(hotel)) return hotel;
    }
    return null;
  }

  /** The first simulated hotel near Times Square: the console's hotel before anyone has booked. */
  function demoHotel() {
    const area = findCity('New York')?.areas.find((a) => a.landmarks.some((l) => l.name === 'Times Square'));
    return firstHotel('nyc', (h) => !area || h.businessArea === area.name);
  }

  /**
   * GET hotels → { hotels: [{ id, name, city, category, rating, rooms, hasGuests }], current }: hotels NanaHotel
   * guests booked (most recent first), the demo hotel and a few other kinds (a luxury resort, a historic inn, a
   * budget hotel). `current` is the hotel of the latest confirmed order, else the demo hotel.
   */
  function listHotels() {
    const t = nowMs();
    const latest = new Map();
    const guests = new Set();
    for (const o of orderRecords.values()) {
      if (o.status !== 'confirmed' || !o.hotel?.id) continue;
      const when = o.payment?.paidAt || o.updatedAt || o.createdAt || '';
      if (!latest.has(o.hotel.id) || latest.get(o.hotel.id) < when) latest.set(o.hotel.id, when);
      if (o.checkOut >= todayIn(resolveTimeZone(o.hotel.timeZone, DEFAULT_TIME_ZONE), t)) guests.add(o.hotel.id);
    }
    const booked = [...latest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([id]) => id);
    const demo = demoHotel();
    const samples = [
      demo,
      firstHotel('lv', (h) => h.category === 'luxury'),
      firstHotel('nola', (h) => h.businessArea === 'French Quarter' && h.category === 'midscale'),
      firstHotel('orl', (h) => h.category === 'budget'),
    ].filter(Boolean).map((h) => h.id);
    const list = [];
    for (const id of [...booked, ...samples]) {
      if (list.some((x) => x.id === id)) continue;
      let hotel = null;
      try {
        hotel = hotels.getHotel(id);
      } catch {
        hotel = null;
      }
      if (!hotel) continue;
      const m = modelOf(hotel);
      list.push({
        id: hotel.id, name: hotel.name, city: hotel.city || '', category: m.category,
        rating: hotel.rating ?? null, rooms: m.rooms.length, hasGuests: guests.has(hotel.id),
      });
    }
    const current = booked.find((id) => list.some((x) => x.id === id)) || demo?.id || list[0]?.id || null;
    return { hotels: list, current };
  }

  return {
    listHotels, overview, rooms, roomAction, tickets, ticketAction, reviews, draftReply, replyReview,
    listPromotions, createPromotion, setPromotion,
  };
}
