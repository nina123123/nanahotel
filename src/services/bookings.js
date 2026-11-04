import * as defaultIds from '../util/ids.js';
import { todayCN, earliestCheckIn, checkStay, formatDateTimeCN, nightsBetween } from '../util/dates.js';
import { guestNameProblem } from '../util/names.js';

/**
 * Quotes → orders → simulated payment → cancellation. Everything is simulated: no money moves.
 * A quote is created only by prepareBooking (agent side) and turned into an order only by an explicit
 * user tap (confirmQuote), so the model can never book on its own.
 *
 * Methods are synchronous (callers may `await` them). Time comes from the injected clock, and expiry
 * is applied lazily whenever a quote/order is read, so there are no timers.
 */

const QUOTE_TTL_MS = 15 * 60 * 1000;
const PAY_TTL_MS = 15 * 60 * 1000;
const PHONE_RE = /^1[3-9]\d{9}$/;
const MAX_CHILDREN = 6;

const STATUS = {
  not_found: 404, hotel_not_found: 404, rate_not_found: 404, unauthorized: 401,
  expired: 410, superseded: 409, price_changed: 409, sold_out: 409, terms_changed: 409,
  order_closed: 409, order_cancelled: 409, not_cancellable: 409,
};

/** Typed booking error; `message` is user-facing Chinese. */
export class BookingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const QUOTE_STATUS_LABELS = Object.freeze({ pending: '待确认', confirmed: '已确认', expired: '已过期', superseded: '已失效' });
export const ORDER_STATUS_LABELS = Object.freeze({ pending_payment: '待支付', confirmed: '已确认', cancelled: '已取消', closed: '已关闭' });
export const PAYMENT_METHOD_LABELS = Object.freeze({ wechat: '微信支付', alipay: '支付宝' });

/** '13812345678' → '138****5678'. Non-phone strings are masked conservatively. */
export function maskPhone(phone) {
  const s = String(phone ?? '').replace(/\s+/g, '');
  if (!s) return '';
  if (s.length >= 7) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  return '****';
}

/** Normalizes '+86 138-1234-5678' → '13812345678'; returns null when not a mainland mobile number. */
export function normalizePhone(phone) {
  // Chinese IMEs often produce full-width digits, plus signs and dashes.
  const s = String(phone ?? '')
    .replace(/[０-９＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-－‐-―()（）]/g, '')
    .replace(/^(\+?86)(?=1\d{10}$)/, '');
  return PHONE_RE.test(s) ? s : null;
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
  const list = Array.isArray(guests) ? guests : typeof guests === 'string' ? guests.split(/[,，、;；\n]+/) : [];
  return list.map((g) => String(g ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** True when the rate's free-cancel deadline fell after `sinceIso` and has now passed: the terms shown no longer hold. */
function termsLapsed(rate, sinceIso, t) {
  const deadline = Date.parse(rate?.cancelPolicy?.freeUntil);
  return Number.isFinite(deadline) && Date.parse(sinceIso) < deadline && t >= deadline;
}

const TERMS_CHANGED_MSG = '免费取消时间已过，取消政策已变化，请重新报价';

/** '微信' / 'WeChat' / '支付宝' … → 'wechat' | 'alipay', or null. */
export function normalizeMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (['wechat', 'weixin', 'wxpay', '微信', '微信支付'].includes(m)) return 'wechat';
  if (['alipay', 'zhifubao', '支付宝'].includes(m)) return 'alipay';
  return null;
}

/**
 * @param {{ store: { collection(name: string) }, hotels: { priceCheck(args): { hotel, roomType, rate } },
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
    if (!u) throw new BookingError('unauthorized', '缺少用户身份，请刷新页面后重试');
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
    if (!q) throw new BookingError('not_found', '没有找到这个预订单');
    return q;
  }

  function loadOrder(userId, orderId) {
    const o = ownOrder(requireUser(userId), orderId);
    if (!o) throw new BookingError('not_found', '没有找到这个订单');
    return o;
  }

  function validateInput(input, now) {
    const hotelId = str(input.hotelId, 80);
    if (!hotelId) throw new BookingError('invalid_request', '缺少酒店编号（hotel_id）');
    const rateId = str(input.rateId, 40);
    if (!rateId) throw new BookingError('invalid_request', '缺少价格方案编号（rate_id），请先查看房型');

    const stay = checkStay(input.checkIn, input.checkOut, todayCN(now), { allowDefaults: false, earliestCheckIn: earliestCheckIn(now) });
    if (stay.error) throw new BookingError('invalid_dates', stay.error);

    const rooms = intOrNull(input.rooms) ?? 1;
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 5) throw new BookingError('invalid_rooms', '房间数需要在1-5间之间');
    const children = intOrNull(input.children) ?? 0;
    if (!Number.isInteger(children) || children < 0 || children > MAX_CHILDREN) throw new BookingError('invalid_guests', `儿童人数需要在0-${MAX_CHILDREN}之间`);

    const guests = parseGuests(input.guests);
    if (!guests.length) throw new BookingError('missing_guest', '需要入住人姓名（每间房至少1位）');
    for (const g of guests) {
      const problem = guestNameProblem(g);
      if (problem === 'placeholder') throw new BookingError('invalid_guest_name', `入住人「${g.slice(0, 20)}」不是完整姓名，请向用户确认与身份证一致的全名`);
      if (problem) throw new BookingError('invalid_guest_name', `入住人姓名「${g.slice(0, 20)}」不正确，需为2-20个字的真实姓名`);
    }
    // Every named guest occupies a bed, so an omitted adult count covers the named people too.
    const adults = intOrNull(input.adults) ?? Math.max(2, rooms, guests.length - children);
    if (!Number.isInteger(adults) || adults < 1) throw new BookingError('invalid_guests', '入住人数至少1位');
    if (adults < rooms) throw new BookingError('invalid_guests', `订${rooms}间房至少需要${rooms}位成人入住（每间至少1位）`);
    if (guests.length < rooms) throw new BookingError('need_more_guests', `订${rooms}间房需要至少${rooms}位入住人姓名（每间1位），现在只有${guests.length}位`);
    if (guests.length > adults + children) {
      throw new BookingError('guest_count_mismatch', `入住人有${guests.length}位，但人数填的是${adults}位成人${children ? `、${children}名儿童` : ''}，请和用户确认实际入住人数`);
    }

    const contactPhone = normalizePhone(input.contactPhone);
    if (!contactPhone) throw new BookingError('invalid_phone', '请提供正确的11位中国大陆手机号');

    return {
      hotelId, rateId, ...stay, rooms, adults, children, guests, contactPhone,
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
      throw new BookingError('too_many_guests', `${roomType.name}每间最多住${roomType.maxOccupancy}人，${occupants}位需要至少${Math.ceil(occupants / roomType.maxOccupancy)}间`);
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
      hotel: { id: hotel.id, name: hotel.name, address: hotel.address, tel: hotel.tel || '', city: hotel.city, district: hotel.district },
      room: { roomId: roomType.roomId, name: roomType.name, bed: roomType.bed },
      rate: {
        rateId: rate.rateId, name: rate.name, breakfast: rate.breakfast, cancelPolicy: { ...rate.cancelPolicy },
        // The hotel's 特惠 that priced some of these nights (merchant.js counts the orders it brought).
        ...(rate.promo ? { promo: { ...rate.promo } } : {}),
      },
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      nights: v.nights,
      rooms: v.rooms,
      adults: v.adults,
      children: v.children,
      guests: v.guests,
      contactPhone: v.contactPhone,
      arrivalTime: v.arrivalTime,
      specialRequests: v.specialRequests,
      nightly: rate.nightly.map((n) => ({ date: n.date, price: n.price })),
      totalPrice: rate.totalPrice,
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
    throw new BookingError('internal', '生成订单号失败，请重试');
  }

  function confirmQuote({ userId, quoteId } = {}) {
    const quote = loadQuote(userId, quoteId);
    if (quote.status === 'confirmed') {
      const existing = quote.orderId ? refreshOrder(orders.get(quote.orderId)) : null;
      if (existing) return existing;
    }
    if (quote.status === 'expired') throw new BookingError('expired', '这个报价已过期（15分钟内有效），我帮你重新查一下最新价格吧');
    if (quote.status === 'superseded') throw new BookingError('superseded', '这个报价已被更新的预订替代，请以最新的为准');
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
        throw new BookingError('sold_out', '刚刚这个房型被订完了，换个房型或日期看看？');
      }
      throw err;
    }
    if (check.rate.totalPrice !== quote.totalPrice) {
      throw new BookingError('price_changed', `价格有变动：刚才是 ¥${quote.totalPrice}，现在是 ¥${check.rate.totalPrice}，需要重新确认`, {
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
      contactPhone: quote.contactPhone,
      arrivalTime: quote.arrivalTime,
      specialRequests: quote.specialRequests,
      nightly: quote.nightly.map((n) => ({ ...n })),
      totalPrice: quote.totalPrice,
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
    if (order.status === 'closed') throw new BookingError('order_closed', '订单已超时关闭（15分钟内未支付），需要的话我帮你重新下单');
    if (order.status === 'cancelled') throw new BookingError('order_cancelled', '订单已取消，不能再支付');
    const t = nowMs();
    if (termsLapsed(order.rate, order.createdAt, t)) {
      throw new BookingError('terms_changed', TERMS_CHANGED_MSG, { freeUntil: order.rate.cancelPolicy.freeUntil });
    }
    if (order.checkIn < earliestCheckIn(new Date(t))) {
      throw new BookingError('invalid_dates', `入住日期 ${order.checkIn} 已经过去了，这个订单不能再支付，请重新预订`);
    }
    const m = normalizeMethod(method);
    if (!m) throw new BookingError('invalid_payment_method', '请选择微信支付或支付宝');
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
      return { cancellable: false, penalty: order.cancellation?.penalty ?? 0, refund: order.cancellation?.refund ?? 0, policyText: '订单已取消' };
    }
    if (order.status === 'closed') return { cancellable: false, penalty: 0, refund: 0, policyText: '订单已超时关闭，无需取消' };
    if (order.status === 'pending_payment') return { cancellable: true, penalty: 0, refund: 0, policyText: '订单还没支付，取消不产生任何费用' };
    // The guest is (or was) in the room: the stay is under way, whatever the dates or the policy say.
    if (order.checkedInAt) return { cancellable: false, penalty: total, refund: 0, policyText: '已办理入住，无法在线取消，如有问题请联系酒店' };

    // Until 06:00 the night in progress still belongs to the previous date (凌晨入住).
    const today = earliestCheckIn(new Date(t));
    if (today >= order.checkOut) return { cancellable: false, penalty: total, refund: 0, policyText: '已过离店日期，订单无法取消' };
    if (today > order.checkIn) return { cancellable: false, penalty: total, refund: 0, policyText: '已过入住日期，无法在线取消，如有问题请联系酒店' };

    const policy = order.rate.cancelPolicy || { type: 'none' };
    if (policy.type === 'none') {
      return { cancellable: true, penalty: total, refund: 0, policyText: `该价格不可取消，现在取消将扣除全部房费 ¥${total}，不退款` };
    }
    const deadline = Date.parse(policy.freeUntil);
    const when = formatDateTimeCN(policy.freeUntil);
    if (Number.isFinite(deadline) && t < deadline) {
      return { cancellable: true, penalty: 0, refund: total, policyText: `${when}前可免费取消，现在取消全额退款 ¥${total}` };
    }
    // Both 免费取消 and 限时取消 charge the first night once their free window has passed.
    const penalty = Math.min(total, (order.nightly[0]?.price ?? 0) * order.rooms);
    return { cancellable: true, penalty, refund: total - penalty, policyText: `已过免费取消时间（${when}），现在取消收取首晚房费 ¥${penalty}，退款 ¥${total - penalty}` };
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
    if (order.status !== 'confirmed') throw new BookingError('order_closed', '只有已确认的订单才能办理入住');
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
  function extendOrder({ userId, orderId, fromDate, toDate, nightly, amount, payment, extensionId } = {}) {
    const order = loadOrder(userId, orderId);
    if (order.status !== 'confirmed') throw new BookingError('order_closed', '只有已确认的订单才能续住');
    // A second extension confirmed in between moved the check-out: this one was priced for the old one.
    if (order.checkOut !== fromDate) throw new BookingError('superseded', '订单的离店日期已经变了，这个续住报价失效了，请重新报价');
    const added = Array.isArray(nightly) ? nightly.map((n) => ({ date: n.date, price: n.price })) : [];
    if (!added.length || nightsBetween(fromDate, toDate) !== added.length) throw new BookingError('invalid_dates', '续住日期不对，请重新报价');
    const t = nowMs();
    const extended = {
      ...order,
      checkOut: toDate,
      nights: order.nights + added.length,
      nightly: [...order.nightly.map((n) => ({ ...n })), ...added],
      totalPrice: order.totalPrice + amount,
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
