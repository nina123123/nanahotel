/**
 * Bookings with a live hotel supplier (LiteAPI): the simulator's booking service (bookings.js) keeps every rule it
 * has — validation, quotes and their 15 minutes, one quote per chat, orders and their expiry, who may see what —
 * and this layer adds what is real:
 *
 *   prepareBooking  the rate is re-read from LiteAPI first (its few-minute cache, else a fresh search);
 *   confirmQuote    (the guest's tap) LiteAPI locks the price (prebook) and opens a payment session; the order
 *                   waits for payment. A higher locked price is refused (price_changed: Nana quotes again);
 *   paymentSession  what the page needs to show LiteAPI's card form for that order (only to its owner);
 *   payOrder        after the guest paid in that form: LiteAPI books with the session's transaction id;
 *   cancelOrder     LiteAPI cancels and says what it costs; previewCancellation applies LiteAPI's own policy.
 *
 * The payment session (its client secret) is kept in its own collection, never on the order, so no order view
 * (the page, the model, the hotel console) can carry it. Every method is async.
 */
import { createBookingService, BookingError } from './bookings.js';
import { penaltyAt } from '../live/liteapi.js';
import { formatUsd } from '../util/money.js';
import { cleanName } from '../util/names.js';

// LiteAPI's price lock lasts longer than this; the guest gets 30 minutes to pay in the card form.
const LIVE_PAY_TTL_MS = 30 * 60 * 1000;
// A booking request that never answered: after this long another attempt may be made.
const BOOK_IN_FLIGHT_MS = 2 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;

const STATUS = { already_paid: 409, payment_unavailable: 409, payment_processing: 409, booking_failed: 409, payment_incomplete: 402 };

/** A BookingError with this layer's own HTTP status for its new codes. */
function fail(code, message, details) {
  const e = new BookingError(code, message, details);
  if (STATUS[code]) e.status = STATUS[code];
  return e;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// Same reading of the guest list as bookings.js, so the party priced here is the one it validates.
function parseGuests(guests) {
  const list = Array.isArray(guests) ? guests : typeof guests === 'string' ? guests.split(/[,;\n]+|\s+and\s+|\s*&\s*/) : [];
  return list.map((g) => cleanName(g)).filter(Boolean);
}

/** A LiveServiceError from the supplier as a BookingError the page and the model understand. */
export function toBookingError(err) {
  if (err instanceof BookingError) return err;
  if (err?.name !== 'LiveServiceError') return err;
  const map = {
    price_changed: 'price_changed', sold_out: 'sold_out', not_found: 'rate_not_found', bad_request: 'invalid_request',
    payment_failed: 'payment_incomplete', expired: 'expired', not_cancellable: 'not_cancellable',
  };
  const code = map[err.code] || 'supplier_unavailable';
  const e = new BookingError(code, err.userMessage || "The hotel service isn't answering right now. Please try again in a minute.", err.details && typeof err.details === 'object' ? err.details : undefined);
  if (code === 'supplier_unavailable') e.status = 503;
  e.retryable = Boolean(err.retryable);
  return e;
}

/**
 * @param {{ store, hotels: ReturnType<import('./hotels/live-service.js').createLiveHotelService>,
 *           supplier: ReturnType<import('../live/liteapi.js').createLiteApiSupplier>,
 *           mailer?: { enabled: boolean, sendBookingConfirmation: Function }, clock?, ids?, logger? }} deps
 */
export function createLiveBookingService({ store, hotels, supplier, mailer = null, clock = { now: () => new Date() }, ids, logger = console } = {}) {
  if (!store || !hotels || !supplier) throw new Error('createLiveBookingService: store, hotels and supplier are required');
  // bookings.js reads the hotel and the rate synchronously; they are fetched here just before each call, and the
  // call runs to its end without waiting, so it reads exactly the values set for it.
  let prefetched = null;
  const syncHotels = {
    getHotel: (id) => (prefetched?.hotel && prefetched.hotel.id === id ? prefetched.hotel : null),
    priceCheck: () => {
      if (!prefetched?.check) throw new BookingError('internal', 'Something went wrong checking the price. Please try again.');
      return prefetched.check;
    },
    zoneOfHotel: (h) => hotels.zoneOfHotel(h),
  };
  const base = createBookingService({ store, hotels: syncHotels, clock, ids });
  const quotes = store.collection('quotes');
  const orders = store.collection('orders');
  const sessions = store.collection('payment_sessions');
  const nowMs = () => clock.now().getTime();
  const iso = (ms) => new Date(ms).toISOString();

  function withPrefetch(value, fn) {
    prefetched = value;
    try {
      return fn();
    } finally {
      prefetched = null;
    }
  }

  function requireUser(userId) {
    const u = str(userId, 100);
    if (!u) throw new BookingError('unauthorized', 'Your user id is missing; please reload the page and try again');
    return u;
  }

  function loadOrder(userId, orderId) {
    const o = base.getOrder(requireUser(userId), orderId);
    if (!o) throw new BookingError('not_found', "Couldn't find that order");
    return o;
  }

  async function prepareBooking(input = {}) {
    const hotelId = str(input.hotelId, 80);
    const rateId = str(input.rateId, 40);
    let value = null;
    if (hotelId && rateId) {
      const rooms = intOrNull(input.rooms) ?? 1;
      const children = intOrNull(input.children) ?? 0;
      const guests = parseGuests(input.guests);
      const adults = intOrNull(input.adults) ?? Math.max(2, rooms, guests.length - children);
      const check = await hotels.priceCheck({ hotelId, rateId, checkIn: input.checkIn, checkOut: input.checkOut, rooms, adults, children });
      value = { hotel: check.hotel, check };
    }
    const quote = withPrefetch(value, () => base.prepareBooking(input));
    const rate = value?.check.rate;
    const photo = value?.hotel?.photos?.find((u) => typeof u === 'string' && u.startsWith('https://'));
    const live = {
      ...quote,
      hotel: { ...quote.hotel, ...(photo ? { photos: [photo] } : {}), ...(value?.hotel?.checkInTime ? { checkInTime: value.hotel.checkInTime, checkOutTime: value.hotel.checkOutTime } : {}) },
      rate: {
        ...quote.rate,
        ...(rate?.boardType ? { boardType: rate.boardType } : {}),
        refundable: rate ? rate.refundable !== false : quote.rate.cancelPolicy?.type !== 'none',
        ...(rate?.payAtProperty ? { payAtProperty: { ...rate.payAtProperty } } : {}),
      },
      live: { provider: supplier.source || 'liteapi', sandbox: Boolean(supplier.sandbox) },
    };
    quotes.set(live.id, live);
    return live;
  }

  async function confirmQuote({ userId, quoteId } = {}) {
    const u = requireUser(userId);
    const quote = base.getQuote(u, quoteId);
    // Not pending (missing, confirmed, expired, replaced): the simulator's answer, before anything is locked.
    if (!quote || quote.status !== 'pending') return withPrefetch(null, () => base.confirmQuote({ userId: u, quoteId }));
    // The free-cancellation deadline passed since the quote: bookings.js refuses it (terms_changed) before any lock.
    const deadline = Date.parse(quote.rate?.cancelPolicy?.freeUntil);
    if (Number.isFinite(deadline) && Date.parse(quote.createdAt) < deadline && nowMs() >= deadline) {
      return withPrefetch(null, () => base.confirmQuote({ userId: u, quoteId }));
    }

    let pb;
    try {
      pb = await supplier.prebook({
        hotelId: quote.hotel.id, rateId: quote.rate.rateId, checkIn: quote.checkIn, checkOut: quote.checkOut,
        adults: quote.adults, children: quote.children ?? 0, rooms: quote.rooms,
      });
    } catch (err) {
      if (err?.code === 'price_changed' || err?.code === 'sold_out') hotels.invalidate?.(quote.hotel.id);
      throw toBookingError(err);
    }
    const locked = Number.isFinite(pb.price) ? round2(pb.price) : quote.totalPrice;
    const termsMoved = pb.rateChanged || pb.boardChanged || pb.cancellationChanged;
    if (locked > quote.totalPrice + 0.009 || termsMoved) {
      // The next quote reads LiteAPI afresh, so it shows what can really be booked.
      hotels.invalidate?.(quote.hotel.id);
      throw new BookingError('price_changed', termsMoved
        ? 'The room or its terms changed at the hotel since this quote; please confirm the new terms'
        : `The price changed: it was ${formatUsd(quote.totalPrice)} and is now ${formatUsd(locked)}; please confirm again`, {
        oldPrice: quote.totalPrice, newPrice: locked,
      });
    }
    if (!pb.payment?.secretKey || !pb.payment?.transactionId) {
      throw fail('payment_unavailable', "The card form isn't available for this hotel right now. Please try again in a minute or pick another room.");
    }

    // The order itself: the simulator's, over the rate as quoted (LiteAPI's lock is never above it).
    const check = {
      hotel: null,
      roomType: { roomId: quote.room.roomId, name: quote.room.name, bed: quote.room.bed, maxOccupancy: Math.max(1, quote.adults + (quote.children ?? 0)) },
      rate: { ...quote.rate, totalPrice: quote.totalPrice, available: true },
    };
    const order = withPrefetch({ check }, () => base.confirmQuote({ userId: u, quoteId }));
    const t = nowMs();
    const live = {
      ...order,
      totalPrice: locked,
      ...(locked < quote.totalPrice - 0.009 ? { priceDropped: { from: quote.totalPrice } } : {}),
      rate: { ...order.rate, ...(pb.cancelPolicy ? { cancelPolicy: { ...pb.cancelPolicy } } : {}) },
      payBy: iso(Math.max(Date.parse(order.payBy), t + LIVE_PAY_TTL_MS)),
      live: { provider: supplier.source || 'liteapi', sandbox: Boolean(pb.sandbox ?? supplier.sandbox), environment: pb.payment.environment, bookingId: null },
    };
    orders.set(live.id, live);
    sessions.set(live.id, {
      id: live.id,
      userId: u,
      prebookId: pb.prebookId,
      transactionId: pb.payment.transactionId,
      secretKey: pb.payment.secretKey,
      environment: pb.payment.environment,
      scriptUrl: pb.payment.scriptUrl,
      createdAt: iso(t),
      bookingStartedAt: null,
    });
    return live;
  }

  /**
   * What the card form needs for one order, for its owner only and only while it waits for payment.
   * @returns {{ provider, environment, secretKey, scriptUrl, amount, currency, payBy, sandbox, testCard }}
   */
  function paymentSession(userId, orderId) {
    const order = loadOrder(userId, orderId);
    if (order.status === 'confirmed') throw fail('already_paid', 'This booking is already paid');
    if (order.status !== 'pending_payment') throw new BookingError('order_closed', 'This order is no longer waiting for payment; I can book it again if you like');
    const s = sessions.get(order.id);
    if (!order.live || !s?.secretKey) throw fail('payment_unavailable', "The card form isn't available for this order; please get a new quote");
    return {
      provider: order.live.provider,
      environment: s.environment,
      secretKey: s.secretKey,
      scriptUrl: s.scriptUrl,
      amount: order.totalPrice,
      currency: order.currency || 'USD',
      payBy: order.payBy,
      sandbox: Boolean(order.live.sandbox),
      testCard: order.live.sandbox ? '4242 4242 4242 4242' : null,
    };
  }

  function sendConfirmation(order) {
    if (!mailer?.enabled || !order?.holder?.email) return;
    const hotel = order.hotel || {};
    Promise.resolve()
      .then(() => mailer.sendBookingConfirmation({ order, to: order.holder.email, checkInTime: hotel.checkInTime, checkOutTime: hotel.checkOutTime, timeZone: hotel.timeZone, test: Boolean(order.live?.sandbox) }))
      .catch((err) => logger?.warn?.(`[bookings] confirmation email for ${order.id} not sent: ${err?.code || ''} ${err?.message || err}`));
  }

  /** After the guest paid in LiteAPI's form: books with the stored transaction id (never one from the browser). */
  async function payOrder({ userId, orderId, method } = {}) {
    const u = requireUser(userId);
    const raw = orders.get(str(orderId, 80));
    if (!raw || raw.userId !== u) throw new BookingError('not_found', "Couldn't find that order");
    if (!raw.live) return base.payOrder({ userId: u, orderId, method });
    if (raw.status === 'confirmed') return base.getOrder(u, raw.id);
    if (raw.status === 'cancelled') throw new BookingError('order_cancelled', "This order was cancelled and can't be paid");
    // A closed order may still be booked: the guest may have paid just before its time ran out.
    const s = sessions.get(raw.id);
    if (!s?.prebookId || !s.transactionId) throw fail('payment_unavailable', "This order can't be paid anymore; please get a new quote");
    const t = nowMs();
    if (s.bookingStartedAt && t - Date.parse(s.bookingStartedAt) < BOOK_IN_FLIGHT_MS) {
      throw fail('payment_processing', 'Still confirming this booking with the hotel; give it a moment');
    }
    sessions.set(s.id, { ...s, bookingStartedAt: iso(t) });

    let b;
    try {
      b = await supplier.book({
        prebookId: s.prebookId,
        transactionId: s.transactionId,
        holder: { ...raw.holder, ...(raw.contactPhone ? { phone: raw.contactPhone } : {}) },
        guests: raw.guests,
        rooms: raw.rooms,
        clientReference: raw.id,
      });
    } catch (err) {
      sessions.set(s.id, { ...sessions.get(s.id), bookingStartedAt: null, lastError: err?.code || 'error' });
      const e = toBookingError(err);
      if (['invalid_request', 'rate_not_found', 'payment_incomplete'].includes(e.code)) {
        e.code = 'payment_incomplete';
        e.message = "The payment didn't go through, so nothing was booked. Please try the card again.";
        e.status = 402;
      }
      throw e;
    }
    if (b.status === 'failed' || b.status === 'cancelled') {
      sessions.set(s.id, { ...sessions.get(s.id), bookingStartedAt: null, lastError: b.status });
      throw fail('booking_failed', "The hotel couldn't confirm this booking, so nothing was booked. Want to try another room?");
    }
    const done = nowMs();
    const amount = Number.isFinite(b.price) ? b.price : raw.totalPrice;
    const paid = {
      ...raw,
      status: 'confirmed',
      totalPrice: amount,
      payment: { method: 'card', provider: raw.live.provider, paidAt: iso(done), amount, transactionId: b.bookingId },
      confirmationNo: b.hotelConfirmationCode && !/^test$/i.test(b.hotelConfirmationCode) ? b.hotelConfirmationCode : b.bookingId,
      live: { ...raw.live, bookingId: b.bookingId, supplierStatus: b.supplierStatus, hotelConfirmationCode: b.hotelConfirmationCode || '', awaitingHotel: b.status === 'pending' },
      updatedAt: iso(done),
    };
    orders.set(paid.id, paid);
    // The secret is no longer needed once the booking exists.
    sessions.set(s.id, { ...sessions.get(s.id), secretKey: null, bookingStartedAt: null, bookedAt: iso(done) });
    sendConfirmation(paid);
    return paid;
  }

  /** LiteAPI's own cancellation policy for a live booking (the simulator's rules decide whether it can be cancelled). */
  async function previewCancellation({ userId, orderId } = {}) {
    const preview = base.previewCancellation({ userId, orderId });
    const order = preview.order;
    if (!order.live?.bookingId || order.status !== 'confirmed' || !preview.cancellable) return preview;
    const total = order.totalPrice;
    const policy = order.rate?.cancelPolicy || { type: 'none' };
    const penalty = penaltyAt(policy, nowMs(), total);
    const refund = round2(Math.max(0, total - penalty));
    let policyText;
    if (penalty <= 0) policyText = `Free cancellation right now: cancelling refunds the full ${formatUsd(total)}`;
    else if (policy.type === 'none' || penalty >= total - 0.009) policyText = `This rate is non-refundable now: cancelling forfeits the full ${formatUsd(total)}, with no refund`;
    else policyText = `Cancelling now costs ${formatUsd(penalty)} and refunds ${formatUsd(refund)}`;
    return { ...preview, penalty, refund, policyText };
  }

  async function cancelOrder({ userId, orderId, reason } = {}) {
    const order = loadOrder(userId, orderId);
    if (!order.live?.bookingId || order.status !== 'confirmed') {
      const out = base.cancelOrder({ userId, orderId, reason });
      if (out.status === 'cancelled') {
        const s = sessions.get(out.id);
        if (s?.secretKey) sessions.set(s.id, { ...s, secretKey: null });
      }
      return out;
    }
    const preview = await previewCancellation({ userId, orderId });
    if (!preview.cancellable) throw new BookingError('not_cancellable', preview.policyText);
    let c;
    try {
      c = await supplier.cancelBooking(order.live.bookingId);
    } catch (err) {
      throw toBookingError(err);
    }
    if (!c.cancelled) throw new BookingError('not_cancellable', "The hotel didn't accept the cancellation online; please contact the hotel directly");
    const t = nowMs();
    const penalty = Number.isFinite(c.penalty) ? c.penalty : preview.penalty;
    const cancelled = {
      ...order,
      status: 'cancelled',
      cancellation: { cancelledAt: iso(t), penalty, refund: Number.isFinite(c.refund) ? c.refund : round2(Math.max(0, order.totalPrice - penalty)), reason: str(reason, 200) },
      live: { ...order.live, supplierStatus: c.supplierStatus },
      updatedAt: iso(t),
    };
    orders.set(cancelled.id, cancelled);
    return cancelled;
  }

  return {
    ...base,
    live: true,
    prepareBooking,
    confirmQuote,
    paymentSession,
    payOrder,
    previewCancellation,
    cancelOrder,
    // Read-only and the stay's own helpers stay the simulator's (they never touch prices).
    listOrders: base.listOrders,
    getOrder: base.getOrder,
    getQuote: base.getQuote,
    supersedeQuote: base.supersedeQuote,
  };
}
