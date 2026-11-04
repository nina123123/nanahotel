import * as defaultIds from '../util/ids.js';
import { todayIn, earliestCheckIn, checkStay, formatDate, formatDateTime, nightsBetween, resolveTimeZone, DEFAULT_TIME_ZONE } from '../util/dates.js';
import { guestNameProblem, namePartProblem, splitFullName, cleanName } from '../util/names.js';
import { formatUsd } from '../util/money.js';

/**
 * Quotes → orders → simulated payment → cancellation. Everything is simulated: no money moves.
 * A quote is created only by prepareBooking (agent side) and turned into an order only by an explicit user tap
 * (confirmQuote), so the model can never book on its own.
 *
 * Methods are synchronous (callers may `await` them). Time comes from the injected clock, and expiry is applied
 * lazily whenever a quote/order is read, so there are no timers. Dates are checked in the hotel's time zone.
 */

const QUOTE_TTL_MS = 15 * 60 * 1000;
const PAY_TTL_MS = 15 * 60 * 1000;
// North American numbers: area code and exchange start with 2–9. Stored as E.164.
const US_PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const EMAIL_RE = /^[^\s@"<>()[\]\\,;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const MAX_CHILDREN = 6;

const STATUS = {
  not_found: 404, hotel_not_found: 404, rate_not_found: 404, unauthorized: 401,
  expired: 410, superseded: 409, price_changed: 409, sold_out: 409, terms_changed: 409,
  order_closed: 409, order_cancelled: 409, not_cancellable: 409,
};

/** Typed booking error; `message` is user-facing English. */
export class BookingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const QUOTE_STATUS_LABELS = Object.freeze({ pending: 'Awaiting confirmation', confirmed: 'Confirmed', expired: 'Expired', superseded: 'Replaced' });
export const ORDER_STATUS_LABELS = Object.freeze({ pending_payment: 'Awaiting payment', confirmed: 'Confirmed', cancelled: 'Cancelled', closed: 'Closed' });
export const PAYMENT_METHOD_LABELS = Object.freeze({ card: 'Credit or debit card', apple_pay: 'Apple Pay' });
export const PHONE_MESSAGE = 'Please enter a 10-digit US phone number';
export const NAME_MESSAGE = 'Please enter a first and last name';
export const EMAIL_MESSAGE = "That email doesn't look right";

/** '+14155550123' → '***-***-0123'. Other strings are masked conservatively. */
export function maskPhone(phone) {
  const raw = String(phone ?? '').trim();
  // Already masked (a public quote passed through again): keep it.
  if (/^\*{3}-\*{3}-\d{4}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length >= 7) return `***-***-${digits.slice(-4)}`;
  return '****';
}

/** '+14155550123' → '(415) 555-0123'. */
export function formatPhone(phone) {
  const s = String(phone ?? '');
  if (!US_PHONE_RE.test(s)) return s;
  return `(${s.slice(2, 5)}) ${s.slice(5, 8)}-${s.slice(8)}`;
}

/**
 * '(415) 555-0123', '415-555-0123', '415.555.0123', '+1 415 555 0123', '1-415-555-0123' → '+14155550123';
 * null when it is not a valid 10-digit US number.
 */
export function normalizePhone(phone) {
  const raw = String(phone ?? '')
    // Full-width digits, signs and brackets come from some keyboards and pasted text.
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .trim();
  if (!raw || /[^\d\s().+\-‐-―]/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  else if (raw.startsWith('+') && !raw.replace(/\s/g, '').startsWith('+1')) return null;
  if (digits.length !== 10) return null;
  const e164 = `+1${digits}`;
  return US_PHONE_RE.test(e164) ? e164 : null;
}

/** A plausible email address, trimmed (the domain lower-cased); null when it does not look like one. */
export function normalizeEmail(email) {
  const s = String(email ?? '').trim();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  const at = s.lastIndexOf('@');
  return `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

/** Quote as sent to the browser / model: no userId, masked phone. */
export function toPublicQuote(quote) {
  if (!quote) return null;
  const { userId, ...rest } = quote;
  return { ...rest, contactPhone: maskPhone(quote.contactPhone) };
}

/** Order as sent to the browser / model: no userId, masked phone. */
export function toPublicOrder(order) {
  if (!order) return null;
  const { userId, ...rest } = order;
  return { ...rest, contactPhone: maskPhone(order.contactPhone) };
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

function parseGuests(guests) {
  const list = Array.isArray(guests) ? guests : typeof guests === 'string' ? guests.split(/[,;\n]+|\s+and\s+|\s*&\s*/) : [];
  return list.map((g) => cleanName(g)).filter(Boolean);
}

function adultsText(adults, children) {
  return `${adults} adult${adults === 1 ? '' : 's'}${children ? ` and ${children} ${children === 1 ? 'child' : 'children'}` : ''}`;
}

/** True when the rate's free-cancel deadline fell after `sinceIso` and has now passed: the terms shown no longer hold. */
function termsLapsed(rate, sinceIso, t) {
  const deadline = Date.parse(rate?.cancelPolicy?.freeUntil);
  return Number.isFinite(deadline) && Date.parse(sinceIso) < deadline && t >= deadline;
}

const TERMS_CHANGED_MSG = 'The free cancellation deadline has passed since this quote, so the terms changed; please get a new quote';

/** 'card' / 'credit card' / 'Visa' / 'Apple Pay' … → 'card' | 'apple_pay', or null. */
export function normalizeMethod(method) {
  const m = String(method || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (['card', 'credit card', 'debit card', 'credit', 'debit', 'credit or debit card', 'visa', 'mastercard', 'amex', 'american express', 'discover'].includes(m)) return 'card';
  if (['apple pay', 'applepay', 'apple'].includes(m)) return 'apple_pay';
  return null;
}

/** The time zone a booking's dates are checked in: its hotel's. */
function zoneOf(order) {
  return resolveTimeZone(order?.hotel?.timeZone, DEFAULT_TIME_ZONE);
}

/**
 * @param {{ store: { collection(name: string) }, hotels: { priceCheck(args): { hotel, roomType, rate }, zoneOfHotel?(hotel) },
 *           clock?: { now: () => Date }, ids?: Partial<typeof defaultIds> }} deps
 */
export function createBookingService({ store, hotels, clock = { now: () => new Date() }, ids } = {}) {
  if (!store) throw new Error('createBookingService: store is required');
  if (!hotels) throw new Error('createBookingService: hotels is required');
  const idgen = { ...defaultIds, ...(ids || {}) };
  const quotes = store.collection('quotes');
  const orders = store.collection('orders');
  const nowMs = () => clock.now().getTime();
  const iso = (ms) => new Date(ms).toISOString();

  function requireUser(userId) {
    const u = str(userId, 100);
    if (!u) throw new BookingError('unauthorized', 'Your user id is missing; please reload the page and try again');
    return u;
  }

  function refreshQuote(q) {
    if (q && q.status === 'pending' && nowMs() >= Date.parse(q.expiresAt)) {
      const expired = { ...q, status: 'expired' };
      quotes.set(q.id, expired);
      return expired;
    }
    return q;
  }

  function refreshOrder(o) {
    if (o && o.status === 'pending_payment' && nowMs() >= Date.parse(o.payBy)) {
      const closed = { ...o, status: 'closed', updatedAt: o.payBy };
      orders.set(o.id, closed);
      return closed;
    }
    return o;
  }

  function ownQuote(userId, quoteId) {
    const q = quotes.get(str(quoteId, 80));
    if (!q || q.userId !== userId) return null;
    return refreshQuote(q);
  }

  function ownOrder(userId, orderId) {
    const o = orders.get(str(orderId, 80));
    if (!o || o.userId !== userId) return null;
    return refreshOrder(o);
  }

  function loadQuote(userId, quoteId) {
    const q = ownQuote(requireUser(userId), quoteId);
    if (!q) throw new BookingError('not_found', "Couldn't find that booking quote");
    return q;
  }

  function loadOrder(userId, orderId) {
    const o = ownOrder(requireUser(userId), orderId);
    if (!o) throw new BookingError('not_found', "Couldn't find that order");
    return o;
  }

  function guestError(g, problem) {
    const name = g.slice(0, 40);
    if (problem === 'placeholder') return new BookingError('invalid_guest_name', `"${name}" isn't a full name; ask the user for each guest's first and last name as on their ID`);
    if (problem === 'incomplete') return new BookingError('invalid_guest_name', `"${name}" needs a last name too: each guest needs a first and last name`);
    return new BookingError('invalid_guest_name', `"${name}" doesn't look like a name; use a first and last name (letters only)`);
  }

  /** The person booking: the given holder, else the first guest; the email is needed for the confirmation. */
  function holderOf(input, guests) {
    const h = input.holder && typeof input.holder === 'object' ? input.holder : {};
    let firstName = cleanName(h.firstName);
    let lastName = cleanName(h.lastName);
    if (!firstName && !lastName) ({ firstName, lastName } = splitFullName(guests[0]));
    if (!firstName || !lastName || namePartProblem(firstName) || namePartProblem(lastName)) throw new BookingError('invalid_name', NAME_MESSAGE);
    const rawEmail = str(h.email ?? input.email, 254);
    if (!rawEmail) throw new BookingError('missing_email', 'An email address is needed for the booking confirmation');
    const email = normalizeEmail(rawEmail);
    if (!email) throw new BookingError('invalid_email', EMAIL_MESSAGE);
    return { firstName, lastName, email };
  }

  function validateInput(input, now) {
    const hotelId = str(input.hotelId, 80);
    if (!hotelId) throw new BookingError('invalid_request', 'The hotel id (hotel_id) is missing');
    const rateId = str(input.rateId, 40);
    if (!rateId) throw new BookingError('invalid_request', 'The rate id (rate_id) is missing; look at the rooms first');

    const hotel = typeof hotels.getHotel === 'function' ? hotels.getHotel(hotelId) : null;
    const zone = resolveTimeZone(hotel?.timeZone, DEFAULT_TIME_ZONE);
    const stay = checkStay(input.checkIn, input.checkOut, todayIn(zone, now), { allowDefaults: false, earliestCheckIn: earliestCheckIn(now, zone) });
    if (stay.error) throw new BookingError('invalid_dates', stay.error);

    const rooms = intOrNull(input.rooms) ?? 1;
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 5) throw new BookingError('invalid_rooms', 'Rooms need to be between 1 and 5');
    const children = intOrNull(input.children) ?? 0;
    if (!Number.isInteger(children) || children < 0 || children > MAX_CHILDREN) throw new BookingError('invalid_guests', `Children need to be between 0 and ${MAX_CHILDREN}`);

    const guests = parseGuests(input.guests);
    if (!guests.length) throw new BookingError('missing_guest', 'A guest name is needed (at least one per room)');
    for (const g of guests) {
      const problem = guestNameProblem(g);
      if (problem) throw guestError(g, problem);
    }
    // Every named guest occupies a bed, so an omitted adult count covers the named people too.
    const adults = intOrNull(input.adults) ?? Math.max(2, rooms, guests.length - children);
    if (!Number.isInteger(adults) || adults < 1) throw new BookingError('invalid_guests', 'At least one adult is needed');
    if (adults < rooms) throw new BookingError('invalid_guests', `${rooms} rooms need at least ${rooms} adults (one per room)`);
    if (guests.length < rooms) throw new BookingError('need_more_guests', `${rooms} rooms need at least ${rooms} guest names (one per room); there ${guests.length === 1 ? 'is 1' : `are ${guests.length}`}`);
    if (guests.length > adults + children) {
      throw new BookingError('guest_count_mismatch', `There are ${guests.length} guest names but the party is ${adultsText(adults, children)}; please check with the user how many people are staying`);
    }

    const contactPhone = normalizePhone(input.contactPhone);
    if (!contactPhone) throw new BookingError('invalid_phone', PHONE_MESSAGE);
    const holder = holderOf(input, guests);

    return {
      hotelId, rateId, ...stay, rooms, adults, children, guests, contactPhone, holder,
      arrivalTime: str(input.arrivalTime, 20),
      specialRequests: str(input.specialRequests, 200),
    };
  }

  function prepareBooking(input = {}) {
    const userId = requireUser(input.userId);
    const sessionId = str(input.sessionId, 100) || null;
    const t = nowMs();
    const v = validateInput(input, new Date(t));
    const { hotel, roomType, rate } = hotels.priceCheck({
      hotelId: v.hotelId, rateId: v.rateId, checkIn: v.checkIn, checkOut: v.checkOut, rooms: v.rooms, adults: v.adults, children: v.children,
    });
    const occupants = v.adults + v.children;
    if (occupants > v.rooms * roomType.maxOccupancy) {
      throw new BookingError('too_many_guests', `The ${roomType.name} sleeps up to ${roomType.maxOccupancy}; ${occupants} people need at least ${Math.ceil(occupants / roomType.maxOccupancy)} rooms`);
    }

    // values().filter rather than find(): works with any store whose collections expose values().
    for (const old of quotes.values().filter((q) => q.userId === userId && q.sessionId === sessionId && q.status === 'pending')) {
      const fresh = refreshQuote(old);
      if (fresh.status === 'pending') quotes.set(fresh.id, { ...fresh, status: 'superseded' });
    }

    const quote = {
      id: idgen.newId('Q'),
      userId,
      sessionId,
      status: 'pending',
      hotel: {
        id: hotel.id, name: hotel.name, address: hotel.address, tel: hotel.tel || '', city: hotel.city, state: hotel.state || '', district: hotel.district,
        timeZone: resolveTimeZone(hotel.timeZone, DEFAULT_TIME_ZONE),
      },
      room: { roomId: roomType.roomId, name: roomType.name, bed: roomType.bed },
      rate: {
        rateId: rate.rateId, name: rate.name, breakfast: rate.breakfast, cancelPolicy: { ...rate.cancelPolicy },
        // The hotel's deal that priced some of these nights (merchant.js counts the orders it brought).
        ...(rate.promo ? { promo: { ...rate.promo } } : {}),
      },
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      nights: v.nights,
      rooms: v.rooms,
      adults: v.adults,
      children: v.children,
      guests: v.guests,
      holder: v.holder,
      contactPhone: v.contactPhone,
      arrivalTime: v.arrivalTime,
      specialRequests: v.specialRequests,
      nightly: rate.nightly.map((n) => ({ date: n.date, price: n.price })),
      totalPrice: rate.totalPrice,
      taxesAndFees: Number.isFinite(rate.taxesAndFees) ? rate.taxesAndFees : 0,
      currency: 'USD',
      createdAt: iso(t),
      expiresAt: iso(t + QUOTE_TTL_MS),
      orderId: null,
    };
    quotes.set(quote.id, quote);
    return quote;
  }

  function newOrderId(t) {
    for (let i = 0; i < 20; i++) {
      const id = idgen.orderNo(new Date(t));
      if (!orders.get(id)) return id;
    }
    throw new BookingError('internal', "Couldn't create an order number; please try again");
  }

  function confirmQuote({ userId, quoteId } = {}) {
    const quote = loadQuote(userId, quoteId);
    if (quote.status === 'confirmed') {
      const existing = quote.orderId ? refreshOrder(orders.get(quote.orderId)) : null;
      if (existing) return existing;
    }
    if (quote.status === 'expired') throw new BookingError('expired', 'This quote expired (quotes are good for 15 minutes); let me get you a fresh price');
    if (quote.status === 'superseded') throw new BookingError('superseded', 'A newer quote replaced this one; please use the latest');
    if (termsLapsed(quote.rate, quote.createdAt, nowMs())) {
      throw new BookingError('terms_changed', TERMS_CHANGED_MSG, { freeUntil: quote.rate.cancelPolicy.freeUntil });
    }

    let check;
    try {
      // Also re-validates the dates against now: a check-in that is no longer bookable throws invalid_dates.
      check = hotels.priceCheck({
        hotelId: quote.hotel.id, rateId: quote.rate.rateId, checkIn: quote.checkIn, checkOut: quote.checkOut,
        rooms: quote.rooms, adults: quote.adults, children: quote.children ?? 0,
      });
    } catch (err) {
      if (err instanceof BookingError && (err.code === 'sold_out' || err.code === 'rate_not_found')) {
        throw new BookingError('sold_out', 'That room just sold out; want to try another room or other dates?');
      }
      throw err;
    }
    if (check.rate.totalPrice !== quote.totalPrice) {
      throw new BookingError('price_changed', `The price changed: it was ${formatUsd(quote.totalPrice)} and is now ${formatUsd(check.rate.totalPrice)}; please confirm again`, {
        oldPrice: quote.totalPrice, newPrice: check.rate.totalPrice,
      });
    }

    const t = nowMs();
    const order = {
      id: newOrderId(t),
      userId: quote.userId,
      quoteId: quote.id,
      sessionId: quote.sessionId,
      status: 'pending_payment',
      hotel: { ...quote.hotel },
      room: { ...quote.room },
      rate: { ...quote.rate, cancelPolicy: { ...quote.rate.cancelPolicy }, ...(quote.rate.promo ? { promo: { ...quote.rate.promo } } : {}) },
      checkIn: quote.checkIn,
      checkOut: quote.checkOut,
      nights: quote.nights,
      rooms: quote.rooms,
      adults: quote.adults,
      children: quote.children ?? 0,
      guests: [...quote.guests],
      holder: { ...quote.holder },
      contactPhone: quote.contactPhone,
      arrivalTime: quote.arrivalTime,
      specialRequests: quote.specialRequests,
      nightly: quote.nightly.map((n) => ({ ...n })),
      totalPrice: quote.totalPrice,
      taxesAndFees: quote.taxesAndFees ?? 0,
      currency: 'USD',
      payment: null,
      confirmationNo: null,
      cancellation: null,
      createdAt: iso(t),
      payBy: iso(t + PAY_TTL_MS),
      updatedAt: iso(t),
    };
    orders.set(order.id, order);
    quotes.set(quote.id, { ...quote, status: 'confirmed', orderId: order.id });
    return order;
  }

  function payOrder({ userId, orderId, method } = {}) {
    const order = loadOrder(userId, orderId);
    if (order.status === 'confirmed') return order;
    if (order.status === 'closed') throw new BookingError('order_closed', "This order closed because it wasn't paid within 15 minutes; I can book it again if you like");
    if (order.status === 'cancelled') throw new BookingError('order_cancelled', "This order was cancelled and can't be paid");
    const t = nowMs();
    if (termsLapsed(order.rate, order.createdAt, t)) {
      throw new BookingError('terms_changed', TERMS_CHANGED_MSG, { freeUntil: order.rate.cancelPolicy.freeUntil });
    }
    if (order.checkIn < earliestCheckIn(new Date(t), zoneOf(order))) {
      throw new BookingError('invalid_dates', `Check-in on ${formatDate(order.checkIn)} has passed, so this order can't be paid anymore; please book again`);
    }
    const m = normalizeMethod(method);
    if (!m) throw new BookingError('invalid_payment_method', 'Please choose a credit or debit card or Apple Pay');
    const paid = {
      ...order,
      status: 'confirmed',
      payment: { method: m, paidAt: iso(t), amount: order.totalPrice, transactionId: idgen.transactionId(m, new Date(t)) },
      confirmationNo: idgen.confirmationNo(),
      updatedAt: iso(t),
    };
    orders.set(paid.id, paid);
    return paid;
  }

  /** Penalty/refund for cancelling `order` at time `t` (ms). */
  function assess(order, t) {
    const total = order.totalPrice;
    if (order.status === 'cancelled') {
      return { cancellable: false, penalty: order.cancellation?.penalty ?? 0, refund: order.cancellation?.refund ?? 0, policyText: 'This order is already cancelled' };
    }
    if (order.status === 'closed') return { cancellable: false, penalty: 0, refund: 0, policyText: 'This order already closed, so there is nothing to cancel' };
    if (order.status === 'pending_payment') return { cancellable: true, penalty: 0, refund: 0, policyText: "This order hasn't been paid, so cancelling costs nothing" };
    // The guest is (or was) in the room: the stay is under way, whatever the dates or the policy say.
    if (order.checkedInAt) return { cancellable: false, penalty: total, refund: 0, policyText: "You've checked in, so this booking can't be cancelled online; please talk to the front desk" };

    const zone = zoneOf(order);
    // Until 6 AM at the hotel the night in progress still belongs to the previous date.
    const today = earliestCheckIn(new Date(t), zone);
    if (today >= order.checkOut) return { cancellable: false, penalty: total, refund: 0, policyText: 'The stay has ended, so this order can no longer be cancelled' };
    if (today > order.checkIn) return { cancellable: false, penalty: total, refund: 0, policyText: "The check-in date has passed, so this booking can't be cancelled online; please contact the hotel" };

    const policy = order.rate.cancelPolicy || { type: 'none' };
    if (policy.type === 'none') {
      return { cancellable: true, penalty: total, refund: 0, policyText: `This rate is non-refundable: cancelling now forfeits the full ${formatUsd(total)}, with no refund` };
    }
    const deadline = Date.parse(policy.freeUntil);
    const when = formatDateTime(policy.freeUntil, zone, { abbr: true });
    if (Number.isFinite(deadline) && t < deadline) {
      return { cancellable: true, penalty: 0, refund: total, policyText: `Free cancellation until ${when}: cancelling now refunds the full ${formatUsd(total)}` };
    }
    // Both the free and the limited rate charge the first night once their free window has passed.
    const penalty = Math.min(total, (order.nightly[0]?.price ?? 0) * order.rooms);
    return {
      cancellable: true, penalty, refund: total - penalty,
      policyText: `The free cancellation deadline (${when}) has passed: cancelling now costs the first night, ${formatUsd(penalty)}, and refunds ${formatUsd(total - penalty)}`,
    };
  }

  function previewCancellation({ userId, orderId } = {}) {
    const order = loadOrder(userId, orderId);
    return { order, ...assess(order, nowMs()) };
  }

  function cancelOrder({ userId, orderId, reason } = {}) {
    const order = loadOrder(userId, orderId);
    if (order.status === 'cancelled') return order;
    const t = nowMs();
    const a = assess(order, t);
    if (!a.cancellable) throw new BookingError('not_cancellable', a.policyText);
    const cancelled = {
      ...order,
      status: 'cancelled',
      cancellation: { cancelledAt: iso(t), penalty: a.penalty, refund: a.refund, reason: str(reason, 200) },
      updatedAt: iso(t),
    };
    orders.set(cancelled.id, cancelled);
    return cancelled;
  }

  function listOrders(userId) {
    const u = requireUser(userId);
    return orders
      .values()
      .filter((o) => o.userId === u)
      .map(refreshOrder)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }

  function getOrder(userId, orderId) {
    const u = str(userId, 100);
    return u ? ownOrder(u, orderId) : null;
  }

  /** Every order of one hotel, whoever booked it, newest first: the hotel's side (merchant.js, stays.js). */
  function ordersForHotel(hotelId) {
    const id = str(hotelId, 80);
    if (!id) return [];
    return orders
      .values()
      .filter((o) => o.hotel?.id === id)
      .map(refreshOrder)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }

  /**
   * Records that the guest of a confirmed order is in the room (stays.js, at check-in by the guest or the front
   * desk): from then on the order can no longer be cancelled online. Marking it again keeps the first time.
   */
  function markCheckedIn({ userId, orderId, at } = {}) {
    const order = loadOrder(userId, orderId);
    if (order.status !== 'confirmed') throw new BookingError('order_closed', 'Only a confirmed order can be checked in');
    if (order.checkedInAt) return order;
    const t = nowMs();
    const marked = { ...order, checkedInAt: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : iso(t), updatedAt: iso(t) };
    orders.set(marked.id, marked);
    return marked;
  }

  function getQuote(userId, quoteId) {
    const u = str(userId, 100);
    return u ? ownQuote(u, quoteId) : null;
  }

  /** Marks a pending quote superseded (e.g. its turn was stopped before the user saw it). Never throws. */
  function supersedeQuote({ userId, quoteId } = {}) {
    const q = getQuote(userId, quoteId);
    if (!q || q.status !== 'pending') return q;
    const superseded = { ...q, status: 'superseded' };
    quotes.set(q.id, superseded);
    return superseded;
  }

  /**
   * Adds nights the user paid for through a stay extension (stays.js confirmExtension) to a confirmed order:
   * check-out, nights, nightly prices and total move; the extension's own payment is kept in `extensions`.
   * `nightly` holds per-room prices like the order's, `amount` is the extension total for all rooms.
   */
  function extendOrder({ userId, orderId, fromDate, toDate, nightly, amount, taxesAndFees = 0, payment, extensionId } = {}) {
    const order = loadOrder(userId, orderId);
    if (order.status !== 'confirmed') throw new BookingError('order_closed', 'Only a confirmed order can be extended');
    // A second extension confirmed in between moved the check-out: this one was priced for the old one.
    if (order.checkOut !== fromDate) throw new BookingError('superseded', 'The check-out date of this order changed, so this extension quote no longer applies; please get a new one');
    const added = Array.isArray(nightly) ? nightly.map((n) => ({ date: n.date, price: n.price })) : [];
    if (!added.length || nightsBetween(fromDate, toDate) !== added.length) throw new BookingError('invalid_dates', 'The extension dates are off; please get a new quote');
    const t = nowMs();
    const extended = {
      ...order,
      checkOut: toDate,
      nights: order.nights + added.length,
      nightly: [...order.nightly.map((n) => ({ ...n })), ...added],
      totalPrice: order.totalPrice + amount,
      taxesAndFees: (order.taxesAndFees || 0) + (Number(taxesAndFees) || 0),
      extensions: [...(order.extensions || []), { id: extensionId, fromDate, toDate, nights: added.length, amount, payment: payment ? { ...payment } : null }],
      updatedAt: iso(t),
    };
    orders.set(extended.id, extended);
    return extended;
  }

  return {
    prepareBooking, confirmQuote, payOrder, previewCancellation, cancelOrder, listOrders, getOrder, getQuote, supersedeQuote, extendOrder,
    ordersForHotel, markCheckedIn,
  };
}
