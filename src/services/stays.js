import * as defaultIds from '../util/ids.js';
import {
  todayIn, addDays, isValidDate, nightsBetween, zonedTimeMs, formatDate, formatTime, formatDateTime, dateIn, resolveTimeZone, DEFAULT_TIME_ZONE,
} from '../util/dates.js';
import { formatUsd } from '../util/money.js';
import { PAYMENT_METHOD_LABELS, maskPhone, normalizeMethod, normalizeEmail, toPublicOrder } from './bookings.js';
import { hashString, BRAND_STEMS } from './hotels/sim-hotels.js';
import { findCity } from './hotels/sim-cities.js';
import { buildRoomOffer, parseFloors, isInn } from './hotels/pricing.js';

/**
 * The guest journey after a booking is paid: rides and airport pickups, early check-in, check-in (room, digital key,
 * Wi-Fi), deliveries to the room, dining reservations, wake-up calls, stay extensions, the check-out bill, emailed
 * receipts, Nana Rewards points and reviews. All simulated: room numbers, drivers and plates derive from the order
 * id, Wi-Fi, breakfast and facilities from the hotel id, so the same order always gets the same ones.
 *
 * Times at the hotel (check-out, pickups, meals, wake-up calls) are in the hotel's own time zone.
 *
 * Same style as bookings.js: synchronous methods, the injected clock, and statuses worked out whenever a record is
 * read (a delivery is on its way after a minute, a ride quote expires after 15), so there are no timers. Spending
 * money and publishing need the user's own tap: the agent only prepares ride and extension quotes and review drafts;
 * confirmRide, confirmExtension and publishReview are called from the HTTP routes.
 *
 * Every request record and view carries `kind`, its category (ride, early_checkin, service, dining, wakeup, receipt,
 * extension, review); a ride's own type is `rideKind`, a meal's `mealKind`.
 *
 * The hotel's side (merchant.js, docs/MERCHANT.md) reads a hotel's stays and requests whoever booked them, checks
 * guests in at the front desk (the same room as their own check-in), moves deliveries on and answers early
 * check-ins (sooner than the usual pace, never back), and replies to published reviews.
 */

const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;
const QUOTE_TTL_MS = 15 * MIN;
const DELIVERY_ON_THE_WAY_MS = MIN;
const DELIVERY_DONE_MS = 5 * MIN;
const RECEIPT_SEND_MS = MIN;
const DRIVER_ASSIGN_MS = 90 * 1000;
const DRIVER_EARLY_MS = 5 * MIN;
const DEFAULT_PICKUP_IN_MS = 15 * MIN;
const MAX_PICKUP_AHEAD_DAYS = 60;
export const EARLY_CHECKIN_FROM = '12:00';
export const STANDARD_CHECKIN = '15:00';
export const CHECKOUT_TIME = '11:00';
export const BREAKFAST_PRICE = 18;
const MAX_REVIEW_CHARS = 500;
const MAX_REPLY_CHARS = 500;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const HOTEL_WORD_RE = /^(?:the |my |our )?(?:hotel|inn|resort|room|place)(?: where i'?m staying)?$|^where i'?m staying$/i;
const AIRPORT_RE = /airport|terminal|\b(?:jfk|lga|ewr|lax|sfo|las|mia|mco|ord|sea-?tac|bos|dca|iad|msy|hnl|san|bna|aus|den|dia)\b/i;

const STATUS = {
  unauthorized: 401, not_found: 404, no_order: 404, expired: 410,
  sold_out: 409, price_changed: 409, superseded: 409, order_not_confirmed: 409, not_checked_in: 409,
  checked_out: 409, already_checked_in: 409, already_published: 409, stay_over: 409,
  invalid_action: 409, not_arrived: 409, not_published: 409,
};

/** Typed stay error; `message` is user-facing English. */
export class StayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StayError';
    this.code = code;
    this.status = STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const RIDE_KIND_LABELS = Object.freeze({ airport_pickup: 'Airport pickup', to_hotel: 'To the hotel', from_hotel: 'From the hotel', taxi: 'Ride' });
export const MEALS = Object.freeze({
  breakfast: Object.freeze({ label: 'Breakfast', from: '07:00', to: '10:30' }),
  lunch: Object.freeze({ label: 'Lunch', from: '11:30', to: '14:30' }),
  dinner: Object.freeze({ label: 'Dinner', from: '17:30', to: '22:00' }),
});
export const REWARDS_PROGRAM = 'Nana Rewards';
// Simulated perks only: nothing here changes a price the user sees.
export const MEMBER_LEVELS = Object.freeze([
  Object.freeze({ name: 'Member', min: 0, perks: Object.freeze(['1 point for every $1 you pay, earned at check-out', 'Late checkout until 12:00 PM when available']) }),
  Object.freeze({ name: 'Gold', min: 2000, perks: Object.freeze(['Late checkout until 2:00 PM when available', 'Higher, quieter rooms when available', 'A welcome snack on arrival']) }),
  Object.freeze({ name: 'Platinum', min: 8000, perks: Object.freeze(['Late checkout until 4:00 PM when available', 'Free room upgrade when available', 'Club lounge access', 'A dedicated support line']) }),
]);

const CATEGORIES = ['budget', 'midscale', 'upscale', 'luxury'];
const FLOORS = { budget: [2, 6], midscale: [2, 12], upscale: [4, 24], luxury: [8, 40] };
const INN_FLOORS = [1, 3];
// Most US hotels have no 13th floor.
const UNLUCKY_FLOORS = new Set([13]);
const RESTAURANT_NAMES = ['Harvest Table', 'The Copper Pot', 'Juniper & Rye', 'The Morning Room', 'Bluebell Café', 'Ember Grill', 'The Saltwater Room', 'Oak & Ivy'];
const MEAL_PRICES = { budget: 16, midscale: 28, upscale: 45, luxury: 85 };
const DRIVER_FIRST = ['Mike', 'Jessica', 'Carlos', 'Ashley', 'David', 'Maria', 'Chris', 'Tanya', 'James', 'Priya', 'Kevin', 'Lauren', 'Andre', 'Nicole', 'Tom', 'Grace'];
const LAST_INITIALS = 'ABCDEFGHJKLMNPRSTW';
const SEDANS = [['Toyota Camry', 'White'], ['Tesla Model 3', 'Black'], ['Honda Accord', 'Silver'], ['Toyota Prius', 'Blue'], ['Tesla Model 3', 'White']];
const VANS = [['Honda Odyssey', 'Black'], ['Toyota Sienna', 'Silver']];
const PLATE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
}

/** One line of model/user text: no control characters, and no brackets that could pass for a platform notice. */
function clean(v, max) {
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Free text (a review): line breaks kept, nothing cut, so the caller can refuse an over-long one. */
function cleanText(v) {
  return (typeof v === 'string' ? v : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[[\]【】]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function money(n) {
  return Math.round(Number(n) || 0);
}

function sum(list, pick) {
  return list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

function intIn(v, min, max, message) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new StayError('invalid_number', message);
  return n;
}

/** 'HH:MM' (or 'H:MM') → zero-padded 24-hour 'HH:MM'. */
function requireTime(v, what) {
  const m = TIME_RE.exec(str(v, 10));
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) throw new StayError('invalid_time', `The ${what} needs to be a time like 07:30 (24-hour HH:MM)`);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function requireDate(v, what) {
  const d = str(v, 10);
  if (!isValidDate(d)) throw new StayError('invalid_date', `The ${what} needs to be a valid date (YYYY-MM-DD)`);
  return d;
}

function cityOf(order) {
  return String(order?.hotel?.city || '');
}

/** The hotel's time zone: times at the hotel are wall-clock times there. */
function zoneOf(order) {
  return resolveTimeZone(order?.hotel?.timeZone || findCity(order?.hotel?.city)?.zone, DEFAULT_TIME_ZONE);
}

function partyOf(order) {
  return (Number(order.adults) || 1) + (Number(order.children) || 0);
}

/** A ride's statuses over time: the quote expires after 15 minutes; once confirmed the driver comes and goes. */
function rideTimes(r) {
  const pickup = Date.parse(r.pickupAt);
  const arrivingAt = Math.max(Date.parse(r.confirmedAt) + DRIVER_ASSIGN_MS, pickup - DRIVER_EARLY_MS);
  // Confirmed after the pickup time: the trip starts when the driver gets there.
  return { arrivingAt, completedAt: Math.max(pickup, arrivingAt) + r.minutes * MIN };
}

function rideStatus(r, t) {
  if (r.status === 'quoted') return t >= Date.parse(r.expiresAt) ? 'expired' : 'quoted';
  if (r.status !== 'confirmed') return r.status;
  const { arrivingAt, completedAt } = rideTimes(r);
  if (t >= completedAt) return 'completed';
  return t >= arrivingAt ? 'arriving' : 'confirmed';
}

function extensionStatus(r, t) {
  return r.status === 'pending' && t >= Date.parse(r.expiresAt) ? 'expired' : r.status;
}

/** accepted → on_the_way → done; the hotel's accept / deliver (onTheWayAt / doneAt) can come sooner than the usual pace, never later. */
function deliverySteps(r) {
  const created = Date.parse(r.createdAt);
  const done = Math.min(created + DELIVERY_DONE_MS, r.doneAt ? Date.parse(r.doneAt) : Infinity);
  const onTheWay = Math.min(created + DELIVERY_ON_THE_WAY_MS, r.onTheWayAt ? Date.parse(r.onTheWayAt) : Infinity, done);
  return [['accepted', created], ['on_the_way', onTheWay], ['done', done]];
}

function sentAtMs(r) {
  return Date.parse(r.requestedAt || r.createdAt) + RECEIPT_SEND_MS;
}

/** The hotel's IANA zone on a view, when the record has one. */
function zoneField(r) {
  return r.timeZone ? { timeZone: r.timeZone } : {};
}

/** `kind: 'ride'` is the request category; the ride's own type is rideKind. */
function rideView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'ride', rideKind: r.rideKind, kindLabel: RIDE_KIND_LABELS[r.rideKind] || r.rideKind,
    from: r.from, to: r.to, pickupAt: r.pickupAt, passengers: r.passengers, carType: r.carType, fare: r.fare, minutes: r.minutes,
    status: rideStatus(r, t), expiresAt: r.expiresAt, createdAt: r.createdAt, ...zoneField(r),
    ...(r.confirmedAt ? { confirmedAt: r.confirmedAt } : {}),
    ...(r.driver ? { driver: { ...r.driver } } : {}),
  };
}

function earlyView(r) {
  return {
    id: r.id, orderId: r.orderId, kind: 'early_checkin', hotel: { ...r.hotel }, date: r.date, arrivalTime: r.arrivalTime,
    status: r.status, note: r.note, createdAt: r.createdAt, ...zoneField(r),
  };
}

function serviceView(r, t) {
  const reached = deliverySteps(r).filter(([, at], i) => i === 0 || t >= at);
  const [, , [, doneAt]] = deliverySteps(r);
  return {
    id: r.id, orderId: r.orderId, kind: 'service', roomNumber: r.roomNumber, items: r.items.map((i) => ({ ...i })),
    ...(r.note ? { note: r.note } : {}),
    status: reached[reached.length - 1][0], createdAt: r.createdAt, eta: new Date(doneAt).toISOString(), ...zoneField(r),
    timeline: reached.map(([status, at]) => ({ status, at: new Date(at).toISOString() })),
  };
}

/** `kind: 'dining'` is the request category; breakfast / lunch / dinner is mealKind. */
function diningView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'dining', mealKind: r.mealKind, kindLabel: MEALS[r.mealKind]?.label || r.mealKind,
    restaurant: r.restaurant, place: r.place, at: r.at, people: r.people, table: r.table, price: r.price, included: r.included,
    ...(r.covered > 0 ? { covered: r.covered } : {}),
    ...(r.note ? { note: r.note } : {}),
    status: r.status === 'cancelled' ? 'cancelled' : t < Date.parse(r.at) ? 'reserved' : 'done', createdAt: r.createdAt, ...zoneField(r),
  };
}

function wakeupView(r, t) {
  const status = r.status === 'cancelled' ? 'cancelled' : t >= Date.parse(r.at) ? 'done' : 'set';
  return { id: r.id, orderId: r.orderId, kind: 'wakeup', roomNumber: r.roomNumber, at: r.at, status, createdAt: r.createdAt, ...zoneField(r) };
}

/** An emailed receipt: 'sending' for a minute, then 'sent'. */
function receiptView(r, t) {
  const sent = t >= sentAtMs(r);
  return {
    id: r.id, orderId: r.orderId, kind: 'receipt', email: r.email, amount: r.amount, status: sent ? 'sent' : 'sending',
    ...(sent ? { sentAt: new Date(sentAtMs(r)).toISOString() } : {}),
    createdAt: r.createdAt, ...zoneField(r),
  };
}

function extensionView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'extension', hotel: { ...r.hotel }, room: r.room, fromDate: r.fromDate, toDate: r.toDate,
    nights: r.nights, price: r.price, ...(Number.isFinite(r.taxesAndFees) ? { taxesAndFees: r.taxesAndFees } : {}),
    status: extensionStatus(r, t), expiresAt: r.expiresAt, createdAt: r.createdAt, ...zoneField(r),
    ...(r.confirmedAt ? { confirmedAt: r.confirmedAt, payment: { ...r.payment } } : {}),
  };
}

function reviewView(r) {
  return {
    id: r.id, orderId: r.orderId, kind: 'review', hotel: { ...r.hotel }, rating: r.rating, text: r.text, tags: [...r.tags],
    status: r.status, createdAt: r.createdAt, ...zoneField(r),
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    ...(r.reply ? { reply: { text: r.reply.text, at: r.reply.at } } : {}),
  };
}

const VIEWS = {
  ride: rideView, early_checkin: earlyView, service: serviceView, dining: diningView, wakeup: wakeupView,
  receipt: receiptView, extension: extensionView, review: reviewView,
};

function viewOf(r, t) {
  return VIEWS[r.kind] ? VIEWS[r.kind](r, t) : null;
}

/** An in-progress request for stay_info.open: { kind, id, label, status }, or null when it is settled. */
function openItem(r, t, zone) {
  const v = viewOf(r, t);
  if (!v) return null;
  const item = (label) => ({ kind: r.kind, id: r.id, label, status: v.status });
  const when = (iso) => formatDateTime(iso, zone);
  switch (r.kind) {
    case 'ride': return ['quoted', 'confirmed', 'arriving'].includes(v.status) ? item(`${v.kindLabel} · ${when(v.pickupAt)}`) : null;
    case 'early_checkin': return v.status === 'pending' ? item(`Early check-in · ${formatTime(v.arrivalTime)}`) : null;
    case 'service': return v.status !== 'done' ? item(v.items.map((i) => `${i.name} ×${i.qty}`).join(', ')) : null;
    case 'dining': return v.status === 'reserved' ? item(`${v.kindLabel} · ${when(v.at)} · ${plural(v.people, 'guest')}`) : null;
    case 'wakeup': return v.status === 'set' ? item(`Wake-up call · ${when(v.at)}`) : null;
    case 'receipt': return v.status === 'sending' ? item(`Receipt · ${v.email}`) : null;
    case 'extension': return v.status === 'pending' ? item(`${plural(v.nights, 'more night')} · waiting for your tap`) : null;
    case 'review': return v.status === 'draft' ? item('Review draft · not posted yet') : null;
    default: return null;
  }
}

/** The brand stem in a hotel name ('Harborline Hotel SoHo' → 'Harborline'), or null. */
function stemOf(name) {
  let best = null;
  for (const stem of BRAND_STEMS) {
    const at = name.indexOf(stem);
    if (at >= 0 && (!best || at < best.at || (at === best.at && stem.length > best.stem.length))) best = { at, stem };
  }
  return best ? best.stem : null;
}

/** '1st floor' … '23rd floor'. */
function floorName(n) {
  if (n <= 1) return 'Lobby level';
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${s} floor`;
}

/**
 * @param {{ store: { collection(name: string) },
 *           bookings: { getOrder, listOrders, extendOrder, ordersForHotel?, markCheckedIn? }, hotels: { getHotel, priceCheck },
 *           clock?: { now: () => Date }, ids?: Partial<typeof defaultIds> }} deps
 */
export function createStayService({ store, bookings, hotels, clock = { now: () => new Date() }, ids } = {}) {
  if (!store) throw new Error('createStayService: store is required');
  if (!bookings) throw new Error('createStayService: bookings is required');
  if (!hotels) throw new Error('createStayService: hotels is required');
  const idgen = { ...defaultIds, ...(ids || {}) };
  const stays = store.collection('stays');
  const requests = store.collection('stay_requests');
  // Read only, to find a front-desk order by its id (bookings.js owns the collection; the front desk has no user id).
  const orderRecords = store.collection('orders');
  const nowMs = () => clock.now().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const profiles = new Map();

  function requireUser(userId) {
    const u = str(userId, 100);
    if (!u) throw new StayError('unauthorized', 'Your user id is missing; please reload the page and try again');
    return u;
  }

  // ---- hotel facts (deterministic per hotel id) ---------------------------------------------

  function facilitiesOf(hotel, category, courtyard, h, between) {
    const amenities = hotel?.amenities || [];
    const has = (a) => amenities.includes(a);
    if (courtyard) {
      const out = [{ name: 'Courtyard', hours: '7:00 AM–10:00 PM', place: 'Ground floor' }, { name: 'Guest lounge', hours: '24 hours', place: 'Ground floor' }];
      if (has('Courtyard pool')) out.push({ name: 'Courtyard pool', hours: '8:00 AM–9:00 PM', place: 'Courtyard' });
      return out;
    }
    const out = [];
    const pool = amenities.find((a) => / pool$/i.test(a));
    if (pool) out.push({ name: pool, hours: '6:00 AM–10:00 PM', place: pool === 'Rooftop pool' ? 'Rooftop' : pool === 'Outdoor pool' ? 'Pool deck, 2nd floor' : floorName(between('pool', 2, 4)) });
    if (has('Fitness center') || category === 'upscale' || category === 'luxury') out.push({ name: 'Fitness center', hours: '24 hours', place: floorName(between('gym', 2, 5)) });
    if (has('Spa')) out.push({ name: 'Spa', hours: '9:00 AM–8:00 PM', place: floorName(between('spa', 2, 4)) });
    if (has('Club lounge')) out.push({ name: 'Club lounge', hours: '6:30 AM–10:00 PM', place: floorName(between('lounge', 20, 30)) });
    if (has('Business center')) out.push({ name: 'Business center', hours: '24 hours', place: 'Lobby level' });
    if (has('Guest laundry')) out.push({ name: 'Guest laundry', hours: '24 hours', place: floorName(between('laundry', 2, 4)) });
    if (!out.length) out.push({ name: 'Vending area', hours: '24 hours', place: floorName(between('vending', 2, 3)) });
    return out;
  }

  function profileOf(order) {
    const hotelId = order.hotel?.id || '';
    if (profiles.has(hotelId)) return profiles.get(hotelId);
    let hotel = null;
    try {
      hotel = hotels.getHotel?.(hotelId) || null;
    } catch {
      hotel = null;
    }
    const h = (k) => hashString(`${hotelId}|${k}`);
    const between = (k, lo, hi) => lo + (h(k) % (hi - lo + 1));
    const category = CATEGORIES.includes(hotel?.category) ? hotel.category : 'midscale';
    const lowRise = hotel ? isInn(hotel) : false;
    const courtyard = lowRise && category !== 'luxury';
    const stem = stemOf(hotel?.name || order.hotel?.name || '');
    const short = stem ? stem.replace(/[^A-Za-z]/g, '') : 'NanaHotel';
    const letters = `${short.toLowerCase()}xxxx`.slice(0, 4);
    const restaurantName = RESTAURANT_NAMES[h('restaurant') % RESTAURANT_NAMES.length];
    let breakfastVenue;
    if (courtyard) breakfastVenue = { restaurant: 'Courtyard breakfast room', place: 'Ground floor' };
    else if (category === 'budget') breakfastVenue = { restaurant: 'Breakfast area', place: 'Lobby level' };
    else if (category === 'midscale') breakfastVenue = h('breakfast') % 2 ? { restaurant: 'Breakfast room', place: 'Lobby level' } : { restaurant: restaurantName, place: 'Lobby level' };
    else breakfastVenue = { restaurant: restaurantName, place: h('breakfast') % 2 ? 'Lobby level' : '2nd floor' };
    const areaCode = findCity(hotel?.city || order.hotel?.city)?.areaCode || '212';
    const profile = {
      hotel,
      category,
      lowRise,
      wifi: { ssid: `${short}-Guest`, password: `${letters}${String(h('wifi') % 1e4).padStart(4, '0')}` },
      breakfast: { time: `${formatTime(MEALS.breakfast.from)}–${formatTime(MEALS.breakfast.to)}`, place: `${breakfastVenue.restaurant}, ${breakfastVenue.place}`, price: BREAKFAST_PRICE },
      breakfastVenue,
      restaurant: {
        restaurant: courtyard ? 'The Courtyard Kitchen' : category === 'budget' ? 'Lobby Café' : restaurantName,
        place: lowRise || category === 'budget' ? 'Lobby level' : floorName(between('restaurant', 1, 2)),
        price: MEAL_PRICES[category],
      },
      // 555-01xx numbers are reserved for fiction and cannot reach anyone real.
      frontDesk: hotel?.tel || `(${areaCode}) 555-01${String(h('tel') % 100).padStart(2, '0')}`,
      facilities: facilitiesOf(hotel, category, courtyard, h, between),
    };
    profiles.set(hotelId, profile);
    return profile;
  }

  /** The floors the rooms card showed for the booked room type ('Floors 4–18'), else the hotel's usual range. */
  function floorRange(order, prof) {
    try {
      const offer = prof.hotel ? buildRoomOffer(prof.hotel, { checkIn: order.checkIn, checkOut: order.checkOut }) : null;
      const range = parseFloors(offer?.roomTypes.find((rt) => rt.roomId === order.room?.roomId)?.floor);
      if (range) return range;
    } catch {
      // not a simulated hotel: use the defaults below
    }
    return prof.lowRise ? INN_FLOORS : FLOORS[prof.category];
  }

  function assignRoom(order, prof) {
    const [lo, hi] = floorRange(order, prof);
    let floors = [];
    for (let f = lo; f <= hi; f++) if (!UNLUCKY_FLOORS.has(f)) floors.push(f);
    if (!floors.length) floors = [lo];
    const h = hashString(`${order.id}|room`);
    const floor = floors[h % floors.length];
    const index = 1 + (Math.floor(h / floors.length) % (prof.lowRise ? 8 : 28));
    return { floor, roomNumber: `${floor}${String(index).padStart(2, '0')}` };
  }

  // ---- orders and stays ------------------------------------------------------------------------

  function ownOrder(u, orderId) {
    const o = bookings.getOrder(u, str(orderId, 80).toUpperCase());
    if (!o) throw new StayError('not_found', "Couldn't find that order");
    return o;
  }

  function requireConfirmed(order) {
    if (order.status === 'confirmed') return order;
    if (order.status === 'cancelled') throw new StayError('order_not_confirmed', 'That booking was cancelled');
    if (order.status === 'pending_payment') throw new StayError('order_not_confirmed', "That booking isn't paid yet; I can arrange things once it is");
    throw new StayError('order_not_confirmed', 'That booking is closed, so nothing more can be arranged for it');
  }

  function stayRec(order) {
    const s = stays.get(order.id);
    return s && s.userId === order.userId ? s : null;
  }

  /**
   * The user's confirmed orders whose stay ended at most `horizon` days ago, most current first: checked in and
   * not out; dates covering today; upcoming (soonest first); checked out today or yesterday; then the ones that
   * ended. With `afterStay` (a receipt, a review: what is asked right after leaving) a stay checked out today or
   * yesterday comes right after the checked-in one instead. A stay ends at check-out, else on its check-out date.
   * "Today" is each hotel's own date. Ties keep listOrders' newest-first order.
   */
  function rankOrders(u, t, { horizon = 1, afterStay = false } = {}) {
    const ranked = [];
    for (const order of bookings.listOrders(u)) {
      if (order.status !== 'confirmed') continue;
      const zone = zoneOf(order);
      const today = todayIn(zone, t);
      const yesterday = addDays(today, -1);
      const oldest = addDays(today, -horizon);
      const rec = stayRec(order);
      const leftOn = rec?.checkedOutAt ? dateIn(rec.checkedOutAt, zone) : null;
      const ended = leftOn || order.checkOut;
      if (ended < oldest) continue;
      let tier;
      let key = 0;
      if (rec && !leftOn) {
        tier = 0;
        key = -Date.parse(rec.checkedInAt);
      } else if (leftOn && leftOn >= yesterday) {
        tier = afterStay ? 1 : 4;
        key = -Date.parse(rec.checkedOutAt);
      } else if (!leftOn && order.checkIn <= today && order.checkOut >= today) {
        tier = 2;
      } else if (!leftOn && order.checkIn > today) {
        tier = 3;
        key = nightsBetween(today, order.checkIn);
      } else {
        tier = 5;
        key = nightsBetween(ended, today);
      }
      ranked.push({ order, tier, key });
    }
    return ranked.sort((a, b) => a.tier - b.tier || a.key - b.key);
  }

  function currentOrder(u, opts) {
    const [first] = rankOrders(u, nowMs(), opts);
    if (!first) throw new StayError('no_order', "There's no confirmed booking yet; once one is booked and paid, I can arrange the rest");
    return first.order;
  }

  /** The order a request is about: the one named, else the current one (see rankOrders); it must be confirmed. */
  function resolveOrder(userId, orderId, opts = {}) {
    const u = requireUser(userId);
    return requireConfirmed(str(orderId, 80) ? ownOrder(u, orderId) : currentOrder(u, opts));
  }

  function requireCheckedIn(order) {
    const rec = stayRec(order);
    if (!rec) throw new StayError('not_checked_in', "You haven't checked in yet; I can check you in first");
    if (rec.checkedOutAt) throw new StayError('checked_out', 'You already checked out of this stay, so room services have ended');
    return rec;
  }

  function requireNotCheckedOut(order) {
    if (stayRec(order)?.checkedOutAt) throw new StayError('checked_out', 'You already checked out of this stay');
  }

  function stayView(order, rec) {
    const prof = profileOf(order);
    const zone = zoneOf(order);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name, category: prof.category },
      roomType: order.room?.name || '',
      roomNumber: rec.roomNumber,
      floor: rec.floor,
      checkIn: order.checkIn,
      checkOut: order.checkOut,
      nights: order.nights,
      guests: [...(order.guests || [])],
      checkedInAt: rec.checkedInAt,
      early: rec.early,
      // The key stops working at check-out.
      keyValidUntil: rec.checkedOutAt || iso(zonedTimeMs(order.checkOut, CHECKOUT_TIME, zone)),
      wifi: { ...prof.wifi },
      breakfast: { ...prof.breakfast, included: (order.rate?.breakfast || 0) > 0 },
      checkoutTime: CHECKOUT_TIME,
      timeZone: zone,
      ...(rec.checkedOutAt ? { checkedOutAt: rec.checkedOutAt, bill: structuredClone(rec.bill) } : {}),
    };
  }

  // ---- requests --------------------------------------------------------------------------------

  /** An order's requests in the order they were made (the store keeps insertion order; the sort is stable). */
  function requestsOf(order) {
    return requests
      .values()
      .filter((r) => r.orderId === order.id && r.userId === order.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  function ownRequest(u, id, kind) {
    const r = requests.get(str(id, 80));
    if (!r || r.userId !== u || (kind && r.kind !== kind)) throw new StayError('not_found', "Couldn't find that request; it may have expired");
    return r;
  }

  function base(kind, order, sessionId, t, prefix) {
    return {
      id: idgen.newId(prefix), kind, userId: order.userId, orderId: order.id, sessionId: str(sessionId, 100) || null, createdAt: iso(t),
      // The hotel's zone: the page formats the request's instants (pickupAt, at, eta …) in hotel time.
      timeZone: zoneOf(order),
    };
  }

  /** Today (at the hotel) when that time is still ahead (by more than `graceMs` ago), else tomorrow. */
  function nextDateFor(hhmm, t, zone, graceMs = 0) {
    const today = todayIn(zone, t);
    return zonedTimeMs(today, hhmm, zone) > t - graceMs ? today : addDays(today, 1);
  }

  // ---- before arrival ---------------------------------------------------------------------------

  /** A day plan for the itinerary card; not stored. The order is optional (it gives the city and the date). */
  function planItinerary({ userId, orderId, title, date, items, timeZone } = {}) {
    const u = requireUser(userId);
    const t = nowMs();
    const order = str(orderId, 80) ? requireConfirmed(ownOrder(u, orderId)) : rankOrders(u, t)[0]?.order || null;
    const today = todayIn(order ? zoneOf(order) : resolveTimeZone(timeZone), t);
    // The arrival day while it is still ahead and the guest is not in yet (an early check-in is already staying).
    const day = date ? requireDate(date, 'plan date') : order && order.checkIn > today && !stayRec(order) ? order.checkIn : today;
    if (day < today) throw new StayError('invalid_date', `${formatDate(day)} has already passed; pick another day`);
    const list = Array.isArray(items) ? items : [];
    if (list.length < 2 || list.length > 8) throw new StayError('invalid_items', 'A day plan needs 2–8 items, each with a time and what to do');
    const out = list.map((item, i) => {
      const what = clean(item?.title, 40);
      if (!what) throw new StayError('invalid_items', `Item ${i + 1} has nothing to do (title)`);
      const place = clean(item?.place, 40);
      const note = clean(item?.note, 80);
      return { time: requireTime(item?.time, `time of item ${i + 1}`), title: what, ...(place ? { place } : {}), ...(note ? { note } : {}) };
    });
    out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const city = order ? cityOf(order) : '';
    return { title: clean(title, 40) || `Plan for ${formatDate(day)}`, date: day, ...(city ? { city } : {}), items: out };
  }

  function estimateRide(order, rideKind, from, to, passengers) {
    const h = hashString(`${order.id}|${rideKind}|${from}|${to}`);
    const airport = rideKind === 'airport_pickup' || AIRPORT_RE.test(`${from} ${to}`);
    const [lo, hi] = airport ? [30, 60] : [10, 35];
    const minutes = lo + (h % (hi - lo + 1));
    const van = passengers > 4;
    const fare = Math.round(((airport ? 25 : 8) + minutes * (airport ? 1.1 : 0.9)) * (van ? 1.4 : 1));
    return { minutes, fare, carType: van ? 'Minivan' : 'Sedan' };
  }

  function pickupMs({ pickupDate, pickupTime }, rideKind, order, t) {
    const zone = zoneOf(order);
    let ms;
    if (!str(pickupTime, 10) && !str(pickupDate, 10)) {
      ms = Math.ceil((t + DEFAULT_PICKUP_IN_MS) / MIN) * MIN;
    } else {
      const hhmm = requireTime(pickupTime, 'pickup time');
      let day = str(pickupDate, 10) ? requireDate(pickupDate, 'pickup date') : '';
      if (!day) {
        // '2:00 PM' for a ride to the hotel means arrival day while that is still ahead and the guest is not in yet.
        const arrival = (rideKind === 'airport_pickup' || rideKind === 'to_hotel') && order.checkIn > todayIn(zone, t) && !stayRec(order);
        day = arrival ? order.checkIn : nextDateFor(hhmm, t, zone, MIN);
      }
      ms = zonedTimeMs(day, hhmm, zone);
    }
    if (ms < t - MIN) throw new StayError('invalid_time', 'That pickup time has already passed; pick another time');
    if (ms > t + MAX_PICKUP_AHEAD_DAYS * DAY_MS) throw new StayError('invalid_time', `Rides can be booked up to ${MAX_PICKUP_AHEAD_DAYS} days ahead`);
    return ms;
  }

  /** A ride quote (15 minutes): nothing is booked until the user taps Confirm ride (confirmRide). */
  function quoteRide({ userId, sessionId, orderId, kind, from, to, pickupDate, pickupTime, passengers } = {}) {
    const order = resolveOrder(userId, orderId);
    if (!Object.hasOwn(RIDE_KIND_LABELS, kind)) throw new StayError('invalid_ride_kind', 'The ride needs to be an airport pickup, a ride to the hotel, a ride from the hotel, or a regular ride');
    const hotelName = order.hotel?.name || 'the hotel';
    let start = clean(from, 60);
    let end = clean(to, 60);
    if (HOTEL_WORD_RE.test(start) || (kind === 'from_hotel' && !start)) start = hotelName;
    if (HOTEL_WORD_RE.test(end) || ((kind === 'airport_pickup' || kind === 'to_hotel') && !end)) end = hotelName;
    if (!start) throw new StayError('missing_from', 'Where should the driver pick you up? (from)');
    if (!end) throw new StayError('missing_to', 'Where are you going? (to)');
    if (start.toLowerCase() === end.toLowerCase()) throw new StayError('same_place', 'The pickup and drop-off are the same place; change one of them');
    const n = passengers === undefined || passengers === null || passengers === ''
      ? Math.min(6, partyOf(order))
      : intIn(passengers, 1, 6, 'A ride takes 1–6 passengers');
    const t = nowMs();
    const ride = {
      ...base('ride', order, sessionId, t, 'RD'),
      rideKind: kind,
      from: start,
      to: end,
      pickupAt: iso(pickupMs({ pickupDate, pickupTime }, kind, order, t)),
      passengers: n,
      ...estimateRide(order, kind, start, end, n),
      status: 'quoted',
      expiresAt: iso(t + QUOTE_TTL_MS),
    };
    requests.set(ride.id, ride);
    return rideView(ride, t);
  }

  /** Per ride (route and pickup time): two rides at once get two drivers; a van and a sedan never share a plate. */
  function driverFor(ride) {
    const key = `${ride.orderId}|${ride.rideKind}|${ride.from}|${ride.to}|${ride.pickupAt}`;
    const h = (k) => hashString(`${key}|${k}`);
    const carClass = ride.passengers > 4 ? 'van' : 'sedan';
    const cars = carClass === 'van' ? VANS : SEDANS;
    const [car, color] = cars[h(`${carClass}|car`) % cars.length];
    const p = h(`${carClass}|plate`);
    const letters = [0, 1, 2].map((i) => PLATE_LETTERS[Math.floor(p / PLATE_LETTERS.length ** i) % PLATE_LETTERS.length]).join('');
    return {
      name: `${DRIVER_FIRST[h('name') % DRIVER_FIRST.length]} ${LAST_INITIALS[h('initial') % LAST_INITIALS.length]}.`,
      car,
      color,
      plate: `${1 + (p % 9)}${letters}${String(h('plate-digits') % 1000).padStart(3, '0')}`,
      phone: maskPhone(`+1212555${String(100 + (h('phone') % 100)).padStart(4, '0')}`),
    };
  }

  /**
   * The user's tap on Confirm ride: a driver is assigned at once and the fare is paid (simulated) with the order's
   * payment method. Confirming again returns the same ride.
   */
  function confirmRide({ userId, rideId } = {}) {
    const u = requireUser(userId);
    const ride = ownRequest(u, rideId, 'ride');
    const t = nowMs();
    const status = rideStatus(ride, t);
    if (status === 'expired') throw new StayError('expired', 'That ride quote expired (quotes are good for 15 minutes); let me get you a new one');
    if (status !== 'quoted') return rideView(ride, t);
    const order = requireConfirmed(ownOrder(u, ride.orderId));
    const method = order.payment?.method || 'card';
    const confirmed = {
      ...ride,
      status: 'confirmed',
      confirmedAt: iso(t),
      driver: driverFor(ride),
      payment: { method, paidAt: iso(t), amount: ride.fare, transactionId: idgen.transactionId(method, new Date(t)) },
    };
    requests.set(ride.id, confirmed);
    return rideView(confirmed, t);
  }

  function requestEarlyCheckin({ userId, sessionId, orderId, arrivalTime } = {}) {
    const order = resolveOrder(userId, orderId);
    if (stayRec(order)) throw new StayError('already_checked_in', "You're already checked in, so there's no need for early check-in");
    const hhmm = requireTime(arrivalTime, 'arrival time');
    const t = nowMs();
    const status = hhmm >= EARLY_CHECKIN_FROM ? 'confirmed' : 'pending';
    let note = "That's early, so the hotel will try to have your room ready and let you know; you can leave your bags at the front desk";
    if (hhmm >= STANDARD_CHECKIN) note = `Check-in starts at ${formatTime(STANDARD_CHECKIN)}, so you can check in as soon as you arrive`;
    else if (status === 'confirmed') note = `Confirmed with the hotel: your room will be ready at ${formatTime(hhmm)}`;
    // One request per order: asking again changes the time.
    const existing = requestsOf(order).find((r) => r.kind === 'early_checkin');
    const rec = {
      ...(existing || base('early_checkin', order, sessionId, t, 'EC')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      date: order.checkIn,
      arrivalTime: hhmm,
      status,
      note,
      updatedAt: iso(t),
    };
    requests.set(rec.id, rec);
    return earlyView(rec);
  }

  // ---- check-in and the stay --------------------------------------------------------------------

  /**
   * Puts the guest of a confirmed order in the room assignRoom gives it (the guest's own check-in or the front
   * desk's): the order records the check-in (no more online cancellation) and a pending early check-in is settled.
   */
  function settleCheckIn(order, t) {
    const today = todayIn(zoneOf(order), t);
    if (order.checkOut < today) throw new StayError('stay_over', `This booking's check-out date (${formatDate(order.checkOut)}) has passed, so it can't be checked in`);
    const rec = { orderId: order.id, userId: order.userId, ...assignRoom(order, profileOf(order)), checkedInAt: iso(t), early: today < order.checkIn };
    stays.set(order.id, rec);
    bookings.markCheckedIn?.({ userId: order.userId, orderId: order.id, at: rec.checkedInAt });
    for (const r of requestsOf(order)) {
      if (r.kind === 'early_checkin' && r.status === 'pending') requests.set(r.id, { ...r, status: 'confirmed', note: 'Your room was ready and you are checked in', updatedAt: iso(t) });
    }
    return rec;
  }

  /** Check-in has no date limit in the demo; before the check-in date the stay is marked `early`. */
  function checkIn({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const existing = stayRec(order);
    if (existing?.checkedOutAt) throw new StayError('checked_out', "You already checked out of this stay, so it can't be checked in again");
    if (existing) {
      // A stay from before orders recorded their check-in.
      if (!order.checkedInAt) bookings.markCheckedIn?.({ userId: order.userId, orderId: order.id, at: existing.checkedInAt });
      return { stay: stayView(order, existing), already: true };
    }
    const rec = settleCheckIn(order, nowMs());
    return { stay: stayView(order, rec), already: false };
  }

  function cleanItems(items) {
    const list = Array.isArray(items) ? items : [];
    const merged = new Map();
    for (const item of list) {
      const name = clean(typeof item === 'string' ? item : item?.name, 30);
      if (!name) continue;
      const qty = item?.qty === undefined || item?.qty === null || item?.qty === '' ? 1 : intIn(item.qty, 1, 10, `The quantity of "${name}" needs to be 1–10`);
      const key = name.toLowerCase();
      const prev = merged.get(key);
      merged.set(key, { name: prev?.name || name, qty: Math.min(10, (prev?.qty || 0) + qty) });
    }
    if (!merged.size) throw new StayError('invalid_items', 'What should we bring? Name the items, like "Towels ×2"');
    if (merged.size > 6) throw new StayError('invalid_items', 'Up to 6 different items at a time; split it into two requests');
    return [...merged.values()];
  }

  /** Delivery to the room: accepted → on_the_way (+1 min) → done (+5 min, the eta). */
  function requestService({ userId, sessionId, orderId, items, note } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = requireCheckedIn(order);
    const list = cleanItems(items);
    const t = nowMs();
    const ticket = { ...base('service', order, sessionId, t, 'SV'), roomNumber: rec.roomNumber, items: list, note: clean(note, 100) };
    requests.set(ticket.id, ticket);
    return serviceView(ticket, t);
  }

  function reserveDining({ userId, sessionId, orderId, kind, date, time, people, note } = {}) {
    const order = resolveOrder(userId, orderId);
    requireNotCheckedOut(order);
    const meal = Object.hasOwn(MEALS, kind) ? MEALS[kind] : null;
    if (!meal) throw new StayError('invalid_meal', 'The meal needs to be breakfast, lunch or dinner');
    const hhmm = requireTime(time, 'table time');
    if (hhmm < meal.from || hhmm > meal.to) throw new StayError('invalid_time', `${meal.label} is served ${formatTime(meal.from)}–${formatTime(meal.to)}; pick a time in that window`);
    const t = nowMs();
    const zone = zoneOf(order);
    const day = str(date, 10) ? requireDate(date, 'table date') : nextDateFor(hhmm, t, zone);
    // A guest who checked in before the booked date is already staying.
    const inSince = stayRec(order)?.checkedInAt;
    const inDate = inSince ? dateIn(inSince, zone) : null;
    const first = inDate && inDate < order.checkIn ? inDate : order.checkIn;
    if (day < first || day > order.checkOut) {
      throw new StayError('outside_stay', `${formatDate(day)} isn't during this stay (${formatDate(first)} – ${formatDate(order.checkOut)})`);
    }
    const atMs = zonedTimeMs(day, hhmm, zone);
    if (atMs <= t) throw new StayError('invalid_time', `${formatDate(day)} at ${formatTime(hhmm)} has already passed; pick a later time`);
    const n = people === undefined || people === null || people === '' ? Math.min(10, partyOf(order)) : intIn(people, 1, 10, 'A table takes 1–10 guests');
    const prof = profileOf(order);
    // The rate's breakfast covers its people per room (breakfast for 2 = 2 a room); the rest pay $18 each.
    const covers = kind === 'breakfast' ? (Number(order.rate?.breakfast) || 0) * (Number(order.rooms) || 1) : 0;
    const included = covers >= n;
    const covered = included ? 0 : covers;
    const venue = kind === 'breakfast' ? prof.breakfastVenue : prof.restaurant;
    // One reservation per meal and day: asking again for one still ahead changes it.
    const existing = requestsOf(order).find((r) => r.kind === 'dining' && r.mealKind === kind && r.date === day && Date.parse(r.at) > t);
    const rec = existing ? { ...existing } : base('dining', order, sessionId, t, 'DN');
    Object.assign(rec, {
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      mealKind: kind,
      date: day,
      at: iso(atMs),
      people: n,
      restaurant: venue.restaurant,
      place: venue.place,
      table: rec.table || `Table ${1 + (hashString(`${rec.id}|table`) % 30)}`,
      price: kind === 'breakfast' ? (included ? 0 : BREAKFAST_PRICE) : prof.restaurant.price,
      included,
      covered,
      note: clean(note, 100),
    });
    requests.set(rec.id, rec);
    return diningView(rec, t);
  }

  function setWakeupCall({ userId, sessionId, orderId, time, date } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = requireCheckedIn(order);
    const hhmm = requireTime(time, 'wake-up time');
    const t = nowMs();
    const zone = zoneOf(order);
    const day = str(date, 10) ? requireDate(date, 'wake-up date') : nextDateFor(hhmm, t, zone);
    const atMs = zonedTimeMs(day, hhmm, zone);
    if (atMs <= t) throw new StayError('invalid_time', `${formatDate(day)} at ${formatTime(hhmm)} has already passed; pick a later time`);
    if (day > order.checkOut) throw new StayError('outside_stay', `${formatDate(day)} is after your check-out (${formatDate(order.checkOut)}); pick another day`);
    const at = iso(atMs);
    const same = requestsOf(order).find((r) => r.kind === 'wakeup' && r.at === at);
    if (same) return wakeupView(same, t);
    const call = { ...base('wakeup', order, sessionId, t, 'WK'), roomNumber: rec.roomNumber, at };
    requests.set(call.id, call);
    return wakeupView(call, t);
  }

  function getStayInfo({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const t = nowMs();
    const rec = stayRec(order);
    const prof = profileOf(order);
    const zone = zoneOf(order);
    const checkedIn = Boolean(rec && !rec.checkedOutAt);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name, category: prof.category },
      checkedIn,
      ...(checkedIn ? { roomNumber: rec.roomNumber } : {}),
      wifi: { ...prof.wifi },
      breakfast: { ...prof.breakfast, included: (order.rate?.breakfast || 0) > 0 },
      checkinTime: STANDARD_CHECKIN,
      checkoutTime: CHECKOUT_TIME,
      frontDesk: prof.frontDesk,
      facilities: prof.facilities.map((f) => ({ ...f })),
      timeZone: zone,
      open: requestsOf(order).map((r) => openItem(r, t, zone)).filter(Boolean),
    };
  }

  // ---- extension (needs the user's tap and payment) ----------------------------------------------

  function priceExtension(order, fromDate, toDate) {
    try {
      return hotels.priceCheck({
        hotelId: order.hotel.id, rateId: order.rate.rateId, checkIn: fromDate, checkOut: toDate,
        rooms: order.rooms, adults: order.adults, children: order.children ?? 0,
      });
    } catch (err) {
      if (err?.name === 'BookingError' && (err.code === 'sold_out' || err.code === 'rate_not_found')) {
        throw new StayError('sold_out', `The ${order.room?.name || 'room'} is sold out for ${plural(nightsBetween(fromDate, toDate), 'more night')} from ${formatDate(fromDate)}; try fewer nights?`);
      }
      if (err?.name === 'BookingError' && err.code === 'invalid_dates') throw new StayError('invalid_dates', err.message);
      throw err;
    }
  }

  /** A quote for N more nights of the same room and rate (15 minutes); the order changes only in confirmExtension. */
  function prepareExtension({ userId, sessionId, orderId, nights } = {}) {
    const order = resolveOrder(userId, orderId);
    requireNotCheckedOut(order);
    const n = nights === undefined || nights === null || nights === '' ? 1 : intIn(nights, 1, 7, 'An extension can be 1–7 nights');
    const t = nowMs();
    if (order.checkOut < todayIn(zoneOf(order), t)) throw new StayError('stay_over', "This booking's check-out date has passed, so it can't be extended; I can book a new stay");
    const fromDate = order.checkOut;
    const toDate = addDays(fromDate, n);
    const { rate } = priceExtension(order, fromDate, toDate);
    // Only the newest quote of an order can be confirmed.
    for (const old of requestsOf(order)) {
      if (old.kind === 'extension' && extensionStatus(old, t) === 'pending') requests.set(old.id, { ...old, status: 'expired' });
    }
    const ext = {
      ...base('extension', order, sessionId, t, 'EX'),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      room: order.room?.name || '',
      rateId: order.rate.rateId,
      fromDate,
      toDate,
      nights: n,
      nightly: rate.nightly.map((x) => ({ date: x.date, price: x.price })),
      price: rate.totalPrice,
      taxesAndFees: Number.isFinite(rate.taxesAndFees) ? rate.taxesAndFees : 0,
      status: 'pending',
      expiresAt: iso(t + QUOTE_TTL_MS),
    };
    requests.set(ext.id, ext);
    return extensionView(ext, t);
  }

  /** The user's tap on Confirm extension plus the simulated payment: the order's check-out, nights and total move. */
  function confirmExtension({ userId, extensionId, method } = {}) {
    const u = requireUser(userId);
    const ext = ownRequest(u, extensionId, 'extension');
    const t = nowMs();
    const status = extensionStatus(ext, t);
    if (status === 'confirmed') return { extension: extensionView(ext, t), order: toPublicOrder(bookings.getOrder(u, ext.orderId)) };
    if (status === 'expired') throw new StayError('expired', 'That extension quote expired (quotes are good for 15 minutes); let me price it again');
    const m = normalizeMethod(method);
    if (!m) throw new StayError('invalid_payment_method', 'Please choose a credit or debit card or Apple Pay');
    const order = requireConfirmed(ownOrder(u, ext.orderId));
    requireNotCheckedOut(order);
    if (order.checkOut !== ext.fromDate) throw new StayError('superseded', 'The check-out date of this booking changed, so this extension quote no longer applies; please get a new one');
    const { rate } = priceExtension(order, ext.fromDate, ext.toDate);
    if (rate.totalPrice !== ext.price) {
      throw new StayError('price_changed', `The extension price changed: it was ${formatUsd(ext.price)} and is now ${formatUsd(rate.totalPrice)}; please confirm again`, { oldPrice: ext.price, newPrice: rate.totalPrice });
    }
    const payment = { method: m, paidAt: iso(t), amount: ext.price, transactionId: idgen.transactionId(m, new Date(t)) };
    const updated = bookings.extendOrder({
      userId: u, orderId: order.id, fromDate: ext.fromDate, toDate: ext.toDate, nightly: rate.nightly, amount: ext.price,
      taxesAndFees: Number.isFinite(rate.taxesAndFees) ? rate.taxesAndFees : 0, payment, extensionId: ext.id,
    });
    const confirmed = { ...ext, status: 'confirmed', confirmedAt: iso(t), payment };
    requests.set(ext.id, confirmed);
    return { extension: extensionView(confirmed, t), order: toPublicOrder(updated) };
  }

  // ---- check-out, receipt, points, review -------------------------------------------------------

  /**
   * Room nights, extensions and confirmed rides were paid when the user tapped for them; meals already served went
   * on the room bill and are settled with the order's payment method at check-out.
   */
  function buildBill(order, rec, t) {
    const methodLabel = (m) => PAYMENT_METHOD_LABELS[m] || 'Card on file';
    const exts = Array.isArray(order.extensions) ? order.extensions : [];
    const roomNights = order.nights - sum(exts, (e) => e.nights);
    const paid = [{
      label: `Room (${order.room?.name || 'room'} · ${plural(roomNights, 'night')}${order.rooms > 1 ? ` × ${order.rooms} rooms` : ''})`,
      amount: money(order.totalPrice - sum(exts, (e) => e.amount)),
      note: `Prepaid (${methodLabel(order.payment?.method)})`,
    }];
    for (const e of exts) paid.push({ label: `Extension (${plural(e.nights, 'night')})`, amount: money(e.amount), note: `Prepaid (${methodLabel(e.payment?.method)})` });
    const charged = [];
    for (const r of requestsOf(order)) {
      if (r.kind === 'ride' && r.payment) {
        const kindLabel = r.rideKind === 'taxi' || !RIDE_KIND_LABELS[r.rideKind] ? '' : ` (${RIDE_KIND_LABELS[r.rideKind]})`;
        paid.push({ label: `Ride${kindLabel}`, amount: money(r.fare), note: `Paid (${methodLabel(r.payment.method)})` });
      }
      const payers = r.kind === 'dining' ? r.people - (Number(r.covered) || 0) : 0;
      if (r.kind === 'dining' && r.status !== 'cancelled' && r.price > 0 && payers > 0 && Date.parse(r.at) <= t) {
        const label = `${MEALS[r.mealKind]?.label || 'Dining'} (${plural(r.people, 'guest')}${r.covered > 0 ? `, ${r.covered} included in the rate` : ''})`;
        charged.push({ label, amount: money(r.price * payers), note: 'Charged to the room' });
      }
    }
    const prepaid = sum(paid, (l) => l.amount);
    const extras = sum(charged, (l) => l.amount);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      roomNumber: rec.roomNumber,
      checkIn: order.checkIn,
      checkOut: order.checkOut,
      nights: order.nights,
      lines: [...paid, ...charged],
      prepaid,
      extras,
      due: extras,
      currency: 'USD',
      // Shown as "Due now (Apple Pay)": just the method.
      settledBy: extras > 0 ? methodLabel(order.payment?.method) : 'Nothing due',
      // $1 actually paid = 1 point.
      pointsEarned: Math.floor(prepaid + extras),
      checkedOutAt: iso(t),
    };
  }

  function checkOut({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = stayRec(order);
    if (!rec) throw new StayError('not_checked_in', "You haven't checked in yet, so there's nothing to check out of");
    if (rec.checkedOutAt) return { bill: structuredClone(rec.bill), already: true };
    const t = nowMs();
    const bill = buildBill(order, rec, t);
    stays.set(order.id, { ...rec, checkedOutAt: bill.checkedOutAt, bill });
    // What was booked for after the guest left will not happen: no meal served off the bill, no call to an empty room.
    for (const r of requestsOf(order)) {
      const later = (r.kind === 'dining' || r.kind === 'wakeup') && r.status !== 'cancelled' && Date.parse(r.at) > t;
      if (later || (r.kind === 'early_checkin' && r.status === 'pending')) requests.set(r.id, { ...r, status: 'cancelled', cancelledAt: iso(t) });
    }
    return { bill: structuredClone(bill), already: false };
  }

  /**
   * Emails the order's receipt (one per order; asking again re-sends it, to a new address if one is given). The
   * address defaults to the booking's email.
   */
  function requestReceipt({ userId, sessionId, orderId, email } = {}) {
    const order = resolveOrder(userId, orderId, { afterStay: true });
    const given = str(email, 254);
    const mail = given ? normalizeEmail(given) : normalizeEmail(order.holder?.email);
    if (given && !mail) throw new StayError('invalid_email', "That email doesn't look right");
    if (!mail) throw new StayError('missing_email', 'Which email should the receipt go to?');
    const t = nowMs();
    const bill = stayRec(order)?.bill;
    const amount = bill ? bill.prepaid + bill.due : money(order.totalPrice);
    const existing = requestsOf(order).find((r) => r.kind === 'receipt');
    if (existing && existing.email === mail && existing.amount === amount && t < sentAtMs(existing)) return receiptView(existing, t);
    const rec = {
      ...(existing || base('receipt', order, sessionId, t, 'RC')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      requestedAt: iso(t),
      email: mail,
      amount,
    };
    requests.set(rec.id, rec);
    return receiptView(rec, t);
  }

  /** Level, points (1 per dollar paid, earned at check-out, kept while the order stands) and the latest stays that earned them. */
  function getMembership(userId) {
    const u = requireUser(userId);
    const done = stays.values()
      .filter((s) => s.userId === u && s.bill && s.checkedOutAt && bookings.getOrder(u, s.orderId)?.status === 'confirmed')
      .sort((a, b) => (a.checkedOutAt < b.checkedOutAt ? 1 : a.checkedOutAt > b.checkedOutAt ? -1 : 0));
    const points = sum(done, (s) => s.bill.pointsEarned);
    let i = 0;
    while (i + 1 < MEMBER_LEVELS.length && points >= MEMBER_LEVELS[i + 1].min) i++;
    const level = MEMBER_LEVELS[i];
    const next = MEMBER_LEVELS[i + 1];
    return {
      program: REWARDS_PROGRAM,
      level: level.name,
      points,
      ...(next ? { nextLevel: next.name, pointsToNext: next.min - points } : {}),
      perks: [...level.perks],
      recent: done.slice(0, 5).map((s) => ({ label: `Checked out of ${s.bill.hotel?.name || 'a hotel'}`, points: s.bill.pointsEarned, at: s.checkedOutAt })),
    };
  }

  function cleanTags(tags) {
    const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,;]+/) : [];
    return [...new Set(list.map((x) => clean(x, 24)).filter(Boolean))].slice(0, 6);
  }

  /** A draft only: it is posted when the user taps Post review (publishReview). One review per order. */
  function draftReview({ userId, sessionId, orderId, rating, text, tags } = {}) {
    const order = resolveOrder(userId, orderId, { afterStay: true });
    const stars = intIn(rating, 1, 5, 'The rating needs to be 1–5 stars');
    const body = cleanText(text);
    if (!body) throw new StayError('invalid_review', 'The review needs some text');
    if (body.length > MAX_REVIEW_CHARS) throw new StayError('invalid_review', `Reviews can be up to ${MAX_REVIEW_CHARS} characters (this one has ${body.length}); make it shorter`);
    const t = nowMs();
    const existing = requestsOf(order).find((r) => r.kind === 'review');
    if (existing?.status === 'published') throw new StayError('already_published', 'You already posted a review for this stay');
    const review = {
      ...(existing || base('review', order, sessionId, t, 'RV')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      rating: stars,
      text: body,
      tags: cleanTags(tags),
      status: 'draft',
      updatedAt: iso(t),
    };
    requests.set(review.id, review);
    return reviewView(review);
  }

  /** The user's tap on Post review. Posting again returns the same review. */
  function publishReview({ userId, reviewId } = {}) {
    const u = requireUser(userId);
    const review = ownRequest(u, reviewId, 'review');
    if (review.status === 'published') return reviewView(review);
    requireConfirmed(ownOrder(u, review.orderId));
    const published = { ...review, status: 'published', publishedAt: iso(nowMs()) };
    requests.set(review.id, published);
    return reviewView(published);
  }

  // ---- reads for the page -----------------------------------------------------------------------

  /** My trips: confirmed orders checking out at most 3 days ago (up to 5, the current one first). */
  function listStays(userId) {
    const u = requireUser(userId);
    const t = nowMs();
    return rankOrders(u, t, { horizon: 3 }).slice(0, 5).map(({ order }) => {
      const rec = stayRec(order);
      return { order: toPublicOrder(order), stay: rec ? stayView(order, rec) : null, requests: requestsOf(order).map((r) => viewOf(r, t)) };
    });
  }

  /** A request as it stands now (for refreshing a card on replay), or null. */
  function getRequest(userId, id) {
    const u = str(userId, 100);
    const r = u ? requests.get(str(id, 80)) : null;
    return r && r.userId === u ? viewOf(r, nowMs()) : null;
  }

  function getStay(userId, orderId) {
    const u = str(userId, 100);
    const order = u ? bookings.getOrder(u, str(orderId, 80)) : null;
    const rec = order ? stayRec(order) : null;
    return rec ? stayView(order, rec) : null;
  }

  /** The chat session a request belongs to (where its notice goes): where it was made, else the order's. */
  function sessionOf(userId, id) {
    const u = str(userId, 100);
    const r = u ? requests.get(str(id, 80)) : null;
    if (!r || r.userId !== u) return null;
    return r.sessionId || bookings.getOrder(u, r.orderId)?.sessionId || null;
  }

  /** Withdraws a ride or extension quote whose turn was stopped before the user saw it. Never throws. */
  function discardQuote({ userId, id } = {}) {
    try {
      const u = str(userId, 100);
      const r = u ? requests.get(str(id, 80)) : null;
      if (!r || r.userId !== u) return null;
      const t = nowMs();
      if ((r.kind === 'ride' && rideStatus(r, t) === 'quoted') || (r.kind === 'extension' && extensionStatus(r, t) === 'pending')) {
        requests.set(r.id, { ...r, status: 'expired' });
      }
      return viewOf(requests.get(r.id), t);
    } catch {
      return null;
    }
  }

  // ---- the hotel's side (merchant.js): any guest's orders at one hotel ------------------------------

  /** An order by its id whoever booked it (the front desk has no user id), refreshed by bookings; null when unknown. */
  function anyOrder(orderId) {
    const raw = orderRecords.get(str(orderId, 80).toUpperCase());
    return raw ? bookings.getOrder(raw.userId, raw.id) : null;
  }

  /** The room an order has (checked in) or will get when it checks in: the same rule, so the hotel's room grid agrees. */
  function roomFor(order) {
    const rec = stayRec(order);
    return rec ? { roomNumber: rec.roomNumber, floor: rec.floor } : assignRoom(order, profileOf(order));
  }

  function confirmedAt(hotelId) {
    return bookings.ordersForHotel ? bookings.ordersForHotel(hotelId).filter((o) => o.status === 'confirmed') : [];
  }

  /**
   * One hotel's confirmed orders, whoever booked them (newest first), each with the room the check-in gives it
   * (`roomNumber`, `floor`) and its stay (null before check-in). Orders come back public: no user id, masked phone.
   * @returns {Array<{ order: object, roomNumber: string, floor: number, stay: object|null }>}
   */
  function listHotelStays(hotelId) {
    return confirmedAt(hotelId).map((order) => {
      const rec = stayRec(order);
      return { order: toPublicOrder(order), ...roomFor(order), stay: rec ? stayView(order, rec) : null };
    });
  }

  /**
   * Every request made for one hotel's confirmed orders (oldest first), as it stands now, with its order (public)
   * and the guest's room (the request's own, else the order's).
   * @returns {Array<{ request: object, order: object, roomNumber: string }>}
   */
  function listHotelRequests(hotelId) {
    const byId = new Map(confirmedAt(hotelId).map((o) => [o.id, o]));
    if (!byId.size) return [];
    const t = nowMs();
    return requests
      .values()
      .filter((r) => byId.get(r.orderId)?.userId === r.userId && VIEWS[r.kind])
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((r) => {
        const order = byId.get(r.orderId);
        return { request: viewOf(r, t), order: toPublicOrder(order), roomNumber: r.roomNumber || roomFor(order).roomNumber };
      });
  }

  /**
   * The front desk checks in the guest of an order arriving today (or earlier): the room the guest's own check-in
   * would give. Returns the stay, and the user and chat session the guest hears about it in.
   */
  function frontDeskCheckIn(orderId) {
    const order = anyOrder(orderId);
    if (!order) throw new StayError('not_found', "Couldn't find that order");
    requireConfirmed(order);
    const existing = stayRec(order);
    if (existing?.checkedOutAt) throw new StayError('checked_out', "This guest already checked out, so they can't be checked in again");
    if (existing) throw new StayError('already_checked_in', `The guest is already checked in (room ${existing.roomNumber})`);
    const t = nowMs();
    if (order.checkIn > todayIn(zoneOf(order), t)) throw new StayError('not_arrived', `This booking checks in on ${formatDate(order.checkIn)}; check the guest in at the desk that day`);
    const rec = settleCheckIn(order, t);
    return { stay: stayView(order, rec), userId: order.userId, sessionId: order.sessionId || null };
  }

  /**
   * The hotel moves a request on: a delivery is taken (`accept`: on its way) or brought (`deliver` / `done`), sooner
   * than the usual pace and never back; a pending early check-in is approved or declined. Anything else is a 409
   * invalid_action. Returns the request as it now stands, and the user and session its guest hears about it in.
   */
  function advanceRequest(requestId, action) {
    const r = requests.get(str(requestId, 80));
    const order = r && (r.kind === 'service' || r.kind === 'early_checkin') ? bookings.getOrder(r.userId, r.orderId) : null;
    if (!order || order.status !== 'confirmed') throw new StayError('not_found', "Couldn't find that request; it may have expired");
    const t = nowMs();
    let next = null;
    let why = "That can't be done right now";
    if (r.kind === 'service') {
      const status = serviceView(r, t).status;
      if (action === 'accept') {
        if (status === 'accepted') next = { ...r, onTheWayAt: iso(t) };
        else why = status === 'done' ? 'This one was already delivered' : 'This one is already on its way';
      } else if (action === 'deliver' || action === 'done') {
        if (status !== 'done') next = { ...r, onTheWayAt: r.onTheWayAt || iso(t), doneAt: iso(t) };
        else why = 'This one was already delivered';
      } else why = 'A delivery can only be accepted, delivered or marked done';
    } else if (action === 'approve' || action === 'decline') {
      if (r.status === 'pending') {
        next = action === 'approve'
          ? { ...r, status: 'confirmed', note: `The hotel confirmed check-in at ${formatTime(r.arrivalTime)}`, decidedAt: iso(t) }
          : { ...r, status: 'declined', note: `The hotel is full that day, so check-in is at ${formatTime(STANDARD_CHECKIN)}`, decidedAt: iso(t) };
      } else why = 'This early check-in request was already answered';
    } else why = 'An early check-in can only be approved or declined';
    if (!next) throw new StayError('invalid_action', why);
    requests.set(r.id, next);
    return { request: viewOf(next, t), userId: r.userId, sessionId: r.sessionId || order.sessionId || null };
  }

  /**
   * The hotel's reply to a published review (1–500 characters): the guest's review card shows it as
   * `reply: { text, at }`. Replying again replaces it; `changed` says whether the text is new.
   */
  function replyReview(reviewId, text) {
    const r = requests.get(str(reviewId, 80));
    if (!r || r.kind !== 'review') throw new StayError('not_found', "Couldn't find that review");
    if (r.status !== 'published') throw new StayError('not_published', "This review isn't posted yet, so it can't be answered");
    const body = cleanText(text);
    if (!body) throw new StayError('invalid_reply', 'The reply needs some text');
    if (body.length > MAX_REPLY_CHARS) throw new StayError('invalid_reply', `Replies can be up to ${MAX_REPLY_CHARS} characters (this one has ${body.length}); make it shorter`);
    const changed = r.reply?.text !== body;
    const updated = changed ? { ...r, reply: { text: body, at: iso(nowMs()) } } : r;
    if (changed) requests.set(r.id, updated);
    const sessionId = r.sessionId || bookings.getOrder(r.userId, r.orderId)?.sessionId || null;
    return { review: reviewView(updated), changed, userId: r.userId, sessionId };
  }

  return {
    planItinerary, quoteRide, confirmRide, requestEarlyCheckin, checkIn, requestService, reserveDining, setWakeupCall,
    getStayInfo, prepareExtension, confirmExtension, checkOut, requestReceipt, getMembership, draftReview, publishReview,
    listStays, getRequest, getStay, sessionOf, discardQuote,
    listHotelStays, listHotelRequests, frontDeskCheckIn, advanceRequest, replyReview,
  };
}
