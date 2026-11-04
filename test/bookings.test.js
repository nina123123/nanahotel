import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStore } from '../src/store/json-store.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService } from '../src/services/hotels/index.js';
import {
  createBookingService, BookingError, maskPhone, normalizePhone, toPublicQuote, toPublicOrder, ORDER_STATUS_LABELS,
} from '../src/services/bookings.js';
import { addDays } from '../src/util/dates.js';

const MIN = 60 * 1000;
const START = Date.parse('2026-10-25T10:00:00+08:00');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const STAY = { checkIn: '2026-11-10', checkOut: '2026-11-12' }; // Tue → Thu

let t;
let clock;
let store;
let hotels;
let bookings;
let seq;

function fakeIds() {
  return {
    newId: (p) => `${p}${String(++seq).padStart(4, '0')}`,
    orderNo: () => `HA20261025${String(++seq).padStart(6, '0')}`,
    confirmationNo: () => '88886666',
    transactionId: (m) => `SIM${m === 'alipay' ? 'ALI' : 'WX'}TEST${seq}`,
  };
}

beforeEach(() => {
  t = START;
  seq = 0;
  clock = { now: () => new Date(t) };
  store = createJsonStore({ dir: null });
  hotels = createHotelService({ supplier: createSimSupplier(), clock });
  bookings = createBookingService({ store, hotels, clock, ids: fakeIds() });
});

function advance(ms) {
  t += ms;
}

function setTime(iso) {
  t = Date.parse(iso);
}

/** First hotel in a city with an available rate of `planSuffix` for `stay` (default STAY). */
function findBookable(planSuffix, { city = '杭州', category, rooms = 1, adults = 2, children = 0, stay = STAY, minOccupancy = 0 } = {}) {
  const list = createSimSupplier().searchHotels({ city });
  for (const h of list) {
    if (category && h.category !== category) continue;
    const { offer } = hotels.getRoomOffer({ hotelId: h.id, ...stay, adults, rooms, children });
    for (const rt of offer.roomTypes) {
      if (rt.maxOccupancy < minOccupancy) continue;
      const rate = rt.rates.find((r) => r.rateId.endsWith(planSuffix) && r.available);
      if (rate) return { hotel: h, roomType: rt, rate };
    }
  }
  throw new Error(`no bookable ${planSuffix}`);
}

function prepare(overrides = {}) {
  const pick = overrides.pick || findBookable('BF2-FC');
  return bookings.prepareBooking({
    userId: ALICE,
    sessionId: 's1',
    hotelId: pick.hotel.id,
    rateId: pick.rate.rateId,
    ...STAY,
    rooms: 1,
    adults: 2,
    guests: ['张三'],
    contactPhone: '13812345678',
    arrivalTime: '18:00前',
    specialRequests: '高楼层，安静',
    ...overrides,
  });
}

function bookAndPay(pick, overrides = {}) {
  const quote = prepare({ pick, ...overrides });
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: quote.id });
  return bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `${err.name}: ${err.message}`);
    assert.match(err.message, /[一-龥]/, 'message is Chinese');
    return err.code;
  }
  return 'ok';
}

test('maskPhone / normalizePhone', () => {
  assert.equal(maskPhone('13812345678'), '138****5678');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone(null), '');
  assert.equal(maskPhone('12345'), '****');
  assert.equal(normalizePhone('+86 138-1234-5678'), '13812345678');
  assert.equal(normalizePhone('＋８６ １３８－１２３４－５６７８'), '13812345678');
  assert.equal(normalizePhone('138‐1234‐5678'), '13812345678');
  assert.equal(normalizePhone('8613812345678'), '13812345678');
  assert.equal(normalizePhone('12812345678'), null);
  assert.equal(normalizePhone('1381234567'), null);
});

test('prepareBooking stores a pending quote that expires in 15 minutes', () => {
  const pick = findBookable('BF2-FC');
  const q = prepare({ pick });
  assert.equal(q.id, 'Q0001');
  assert.equal(q.status, 'pending');
  assert.equal(q.userId, ALICE);
  assert.equal(q.sessionId, 's1');
  assert.deepEqual(q.hotel, { id: pick.hotel.id, name: pick.hotel.name, address: pick.hotel.address, tel: pick.hotel.tel, city: pick.hotel.city, district: pick.hotel.district });
  assert.deepEqual(q.room, { roomId: pick.roomType.roomId, name: pick.roomType.name, bed: pick.roomType.bed });
  assert.equal(q.rate.rateId, pick.rate.rateId);
  assert.equal(q.rate.cancelPolicy.type, 'free');
  assert.equal(q.nights, 2);
  assert.deepEqual(q.nightly, pick.rate.nightly);
  assert.equal(q.totalPrice, pick.rate.totalPrice);
  assert.equal(q.contactPhone, '13812345678');
  assert.deepEqual(q.guests, ['张三']);
  assert.equal(q.arrivalTime, '18:00前');
  assert.equal(q.orderId, null);
  assert.equal(Date.parse(q.expiresAt) - Date.parse(q.createdAt), 15 * MIN);
  assert.deepEqual(store.collection('quotes').get(q.id), q);
});

test('public serializers drop userId and mask the phone', () => {
  const q = prepare();
  const pub = toPublicQuote(q);
  assert.equal(pub.userId, undefined);
  assert.equal(pub.contactPhone, '138****5678');
  assert.equal(pub.id, q.id);
  assert.equal(q.contactPhone, '13812345678', 'original untouched');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  const po = toPublicOrder(order);
  assert.equal(po.userId, undefined);
  assert.equal(po.contactPhone, '138****5678');
  assert.equal(toPublicQuote(null), null);
  assert.equal(toPublicOrder(undefined), null);
  assert.ok(!JSON.stringify(po).includes('13812345678'));
});

test('prepareBooking validation errors', () => {
  const pick = findBookable('BF2-FC');
  const cases = [
    [{ contactPhone: '1234' }, 'invalid_phone'],
    [{ contactPhone: '' }, 'invalid_phone'],
    [{ guests: [] }, 'missing_guest'],
    [{ guests: ['李'] }, 'invalid_guest_name'],
    [{ guests: ['张三<script>'] }, 'invalid_guest_name'],
    [{ guests: ['x'.repeat(21)] }, 'invalid_guest_name'],
    [{ rooms: 2, adults: 2, guests: ['张三'] }, 'need_more_guests'],
    [{ rooms: 6 }, 'invalid_rooms'],
    [{ rooms: 0 }, 'invalid_rooms'],
    [{ adults: 0 }, 'invalid_guests'],
    [{ adults: 5, rooms: 1 }, 'too_many_guests'],
    [{ checkIn: '2026-10-24', checkOut: '2026-10-26' }, 'invalid_dates'],
    [{ checkIn: '2026-11-10', checkOut: '2026-12-11' }, 'invalid_dates'],
    [{ checkIn: '2027-10-27', checkOut: '2027-10-28' }, 'invalid_dates'],
    [{ checkOut: undefined }, 'invalid_dates'],
    [{ hotelId: '' }, 'invalid_request'],
    [{ rateId: '' }, 'invalid_request'],
    [{ hotelId: 'sim-hz-999' }, 'hotel_not_found'],
    [{ rateId: 'R9-NOPE' }, 'rate_not_found'],
    [{ userId: '' }, 'unauthorized'],
    // every room needs an adult; the named guests must fit the stated party and the room
    [{ rooms: 3, adults: 1, guests: ['张三', '李四', '王五'] }, 'invalid_guests'],
    [{ adults: undefined, guests: ['张三', '李四', '王五'] }, 'too_many_guests'],
    [{ adults: 2, guests: ['张三', '李四', '王五', '赵六', '钱七', '孙八'] }, 'guest_count_mismatch'],
    [{ adults: 2, children: 1, guests: ['张三', '李四', '张小宝'] }, 'too_many_guests'],
    [{ children: 7 }, 'invalid_guests'],
    [{ children: -1 }, 'invalid_guests'],
    // honorifics and stand-ins are not 实名
    [{ guests: ['张先生'] }, 'invalid_guest_name'],
    [{ guests: ['王女士'] }, 'invalid_guest_name'],
    [{ guests: ['本人'] }, 'invalid_guest_name'],
    [{ guests: ['test'] }, 'invalid_guest_name'],
  ];
  for (const [o, code] of cases) assert.equal(codeOf(() => prepare({ pick, ...o })), code, JSON.stringify(o));
  // one name per room is enough; comma-separated strings are accepted
  const pick2 = findBookable('BF2-FC', { rooms: 2, adults: 3 });
  const two = prepare({ pick: pick2, rooms: 2, adults: 3, guests: '张三，李四' });
  assert.deepEqual(two.guests, ['张三', '李四']);
  assert.equal(two.totalPrice, pick2.rate.totalPrice);
  assert.equal(two.totalPrice, two.nightly.reduce((s, n) => s + n.price, 0) * 2);
  assert.equal(prepare({ pick, guests: ['John Smith'] }).guests[0], 'John Smith');
  for (const name of ['欧阳娜娜', 'Li Wei']) assert.equal(prepare({ pick, guests: [name] }).guests[0], name);
  assert.throws(() => prepare({ pick, guests: ['李小姐'] }), (e) => /身份证一致的全名/.test(e.message));
  // adults omitted: every named guest counts, defaults stay at 2 for one name
  assert.equal(prepare({ pick, adults: undefined, guests: ['张三'] }).adults, 2);
  assert.equal(prepare({ pick: pick2, rooms: 2, adults: 4, guests: ['张三', '李四'] }).adults, 4);
  assert.equal(prepare({ pick, contactPhone: '+86 139 0000 1111' }).contactPhone, '13900001111');
});

test('children: occupy a bed, price unchanged, carried on quote and order', () => {
  const pick = findBookable('BF0-NR', { category: 'premium', adults: 2, children: 1, minOccupancy: 3 });
  assert.equal(pick.roomType.maxOccupancy, 3);
  const q = prepare({ pick, adults: 2, children: 1, guests: ['张三', '李四'] });
  assert.equal(q.children, 1);
  assert.equal(q.totalPrice, pick.rate.totalPrice);
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.equal(order.children, 1);
  assert.equal(prepare({ pick }).children, 0);
});

test('supersedeQuote retires a pending quote and never throws', () => {
  const q = prepare();
  assert.equal(bookings.supersedeQuote({ userId: ALICE, quoteId: q.id }).status, 'superseded');
  assert.equal(bookings.getQuote(ALICE, q.id).status, 'superseded');
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: q.id })), 'superseded');
  const q2 = prepare({ sessionId: 's2' });
  bookings.confirmQuote({ userId: ALICE, quoteId: q2.id });
  assert.equal(bookings.supersedeQuote({ userId: ALICE, quoteId: q2.id }).status, 'confirmed', 'a confirmed quote is left alone');
  assert.equal(bookings.supersedeQuote({ userId: BOB, quoteId: q2.id }), null);
  assert.equal(bookings.supersedeQuote({ userId: ALICE, quoteId: 'Q-nope' }), null);
  assert.equal(bookings.supersedeQuote({}), null);
});

test('terms_changed: the free-cancel deadline passing between quote and confirm/pay is caught', () => {
  const stay = { checkIn: '2026-10-26', checkOut: '2026-10-27' }; // free cancel until 10-25 18:00
  setTime('2026-10-25T17:52:00+08:00');
  const pick = findBookable('BF2-FC', { stay });
  const q = prepare({ pick, ...stay });
  assert.equal(q.rate.name, '含双早 · 免费取消');
  setTime('2026-10-25T18:01:00+08:00');
  assert.throws(() => bookings.confirmQuote({ userId: ALICE, quoteId: q.id }), (e) => {
    assert.equal(e.code, 'terms_changed');
    assert.equal(e.status, 409);
    assert.equal(e.message, '免费取消时间已过，取消政策已变化，请重新报价');
    return true;
  });
  assert.deepEqual([bookings.getQuote(ALICE, q.id).status, bookings.getQuote(ALICE, q.id).orderId], ['pending', null]);
  assert.deepEqual(bookings.listOrders(ALICE), []);

  // confirmed in time, but the 15-minute pay window crosses the deadline
  setTime('2026-10-25T17:50:00+08:00');
  const q2 = prepare({ pick, ...stay, sessionId: 's2' });
  setTime('2026-10-25T17:59:00+08:00');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q2.id });
  setTime('2026-10-25T18:05:00+08:00');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' })), 'terms_changed');
  assert.notEqual(bookings.getOrder(ALICE, order.id).status, 'confirmed');

  // quoted after the deadline: the terms shown already say 取消收首晚, so nothing changed
  setTime('2026-10-25T18:01:00+08:00');
  const q3 = prepare({ pick, ...stay, sessionId: 's3' });
  assert.equal(q3.rate.name, '含双早 · 取消收首晚');
  setTime('2026-10-25T18:05:00+08:00');
  const o3 = bookings.confirmQuote({ userId: ALICE, quoteId: q3.id });
  assert.equal(o3.rate.name, '含双早 · 取消收首晚');
  assert.equal(bookings.payOrder({ userId: ALICE, orderId: o3.id, method: 'wechat' }).status, 'confirmed');

  // non-refundable rates have no deadline to cross
  setTime('2026-10-25T17:55:00+08:00');
  const nr = prepare({ pick: findBookable('BF0-NR', { stay }), ...stay, sessionId: 's4' });
  setTime('2026-10-25T18:02:00+08:00');
  const o4 = bookings.confirmQuote({ userId: ALICE, quoteId: nr.id });
  assert.equal(bookings.payOrder({ userId: ALICE, orderId: o4.id, method: 'alipay' }).status, 'confirmed');
});

test('凌晨入住: before 06:00 the night in progress can be booked, paid and is cancellable by its rules', () => {
  const stay = { checkIn: '2026-10-25', checkOut: '2026-10-26' };
  setTime('2026-10-26T01:30:00+08:00');
  const pick = findBookable('BF0-NR', { stay });
  const q = prepare({ pick, ...stay, arrivalTime: '02:00' });
  assert.equal(q.status, 'pending');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  const paid = bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' });
  assert.equal(paid.status, 'confirmed');
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([p.cancellable, p.penalty], [true, paid.totalPrice], 'not "已过离店日期" while the night is in progress');

  setTime('2026-10-26T06:30:00+08:00');
  assert.equal(codeOf(() => prepare({ pick, ...stay, sessionId: 's2' })), 'invalid_dates');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).cancellable, false);

  // a quote for the night in progress that is confirmed / paid after 06:00 is rejected as invalid_dates
  setTime('2026-10-26T05:50:00+08:00');
  const late = prepare({ pick, ...stay, sessionId: 's3' });
  setTime('2026-10-26T06:01:00+08:00');
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: late.id })), 'invalid_dates');
  setTime('2026-10-26T05:40:00+08:00');
  const late2 = prepare({ pick, ...stay, sessionId: 's4' });
  setTime('2026-10-26T05:50:00+08:00');
  const o2 = bookings.confirmQuote({ userId: ALICE, quoteId: late2.id });
  setTime('2026-10-26T06:01:00+08:00');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: o2.id, method: 'wechat' })), 'invalid_dates');
});

test('a new quote supersedes the same session’s pending quotes only', () => {
  const q1 = prepare();
  const q2 = prepare();
  const other = prepare({ sessionId: 's2' });
  assert.equal(bookings.getQuote(ALICE, q1.id).status, 'superseded');
  assert.equal(bookings.getQuote(ALICE, q2.id).status, 'pending');
  assert.equal(bookings.getQuote(ALICE, other.id).status, 'pending');
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: q1.id })), 'superseded');
});

test('confirmQuote creates a pending_payment order (15 min to pay) and is idempotent', () => {
  const q = prepare();
  advance(2 * MIN);
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.match(order.id, /^HA\d{8}\d{6}$/);
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.quoteId, q.id);
  assert.equal(order.userId, ALICE);
  assert.equal(order.sessionId, 's1');
  assert.equal(order.totalPrice, q.totalPrice);
  assert.deepEqual(order.nightly, q.nightly);
  assert.equal(order.payment, null);
  assert.equal(order.confirmationNo, null);
  assert.equal(order.cancellation, null);
  assert.equal(Date.parse(order.payBy) - Date.parse(order.createdAt), 15 * MIN);
  const quote = bookings.getQuote(ALICE, q.id);
  assert.equal(quote.status, 'confirmed');
  assert.equal(quote.orderId, order.id);

  advance(MIN);
  const again = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.deepEqual(again, order, 'double confirm returns the same order');
  assert.equal(store.collection('orders').size, 1);
});

test('confirmQuote rejects other users’ quotes and expired quotes', () => {
  const q = prepare();
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: BOB, quoteId: q.id })), 'not_found');
  assert.equal(bookings.getQuote(BOB, q.id), null);
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: 'Q-nope' })), 'not_found');
  advance(15 * MIN);
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: q.id })), 'expired');
  assert.equal(bookings.getQuote(ALICE, q.id).status, 'expired');
  assert.equal(store.collection('quotes').get(q.id).status, 'expired', 'lazy expiry is persisted');
});

test('confirmQuote re-checks price and availability', () => {
  const pick = findBookable('BF2-FC');
  let mode = 'same';
  const wrapped = {
    ...hotels,
    priceCheck(args) {
      const res = hotels.priceCheck(args);
      if (mode === 'pricier') return { ...res, rate: { ...res.rate, totalPrice: res.rate.totalPrice + 100 } };
      if (mode === 'gone') throw new BookingError('sold_out', '满房');
      return res;
    },
  };
  const svc = createBookingService({ store, hotels: wrapped, clock, ids: fakeIds() });
  const base = { userId: ALICE, sessionId: 's9', hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['张三'], contactPhone: '13812345678' };
  const q1 = svc.prepareBooking(base);
  mode = 'pricier';
  assert.throws(() => svc.confirmQuote({ userId: ALICE, quoteId: q1.id }), (e) => {
    assert.equal(e.code, 'price_changed');
    assert.deepEqual(e.details, { oldPrice: q1.totalPrice, newPrice: q1.totalPrice + 100 });
    return true;
  });
  mode = 'same';
  const q2 = svc.prepareBooking(base);
  mode = 'gone';
  assert.equal(codeOf(() => svc.confirmQuote({ userId: ALICE, quoteId: q2.id })), 'sold_out');
});

test('payOrder confirms with a simulated payment and is idempotent', () => {
  const q = prepare();
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'paypal' })), 'invalid_payment_method');
  assert.equal(codeOf(() => bookings.payOrder({ userId: BOB, orderId: order.id, method: 'wechat' })), 'not_found');
  advance(5 * MIN);
  const paid = bookings.payOrder({ userId: ALICE, orderId: order.id, method: '支付宝' });
  assert.equal(paid.status, 'confirmed');
  assert.equal(ORDER_STATUS_LABELS[paid.status], '已确认');
  assert.equal(paid.payment.method, 'alipay');
  assert.equal(paid.payment.amount, order.totalPrice);
  assert.equal(paid.payment.paidAt, new Date(t).toISOString());
  assert.match(paid.payment.transactionId, /^SIMALI/);
  assert.equal(paid.confirmationNo, '88886666');
  advance(MIN);
  assert.deepEqual(bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' }), paid);
});

test('unpaid orders close lazily after 15 minutes', () => {
  const q = prepare();
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  advance(15 * MIN + 1);
  assert.equal(bookings.getOrder(ALICE, order.id).status, 'closed');
  assert.equal(bookings.listOrders(ALICE)[0].status, 'closed');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' })), 'order_closed');
  const preview = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(preview.cancellable, false);
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: ALICE, orderId: order.id })), 'not_cancellable');
  assert.equal(bookings.confirmQuote({ userId: ALICE, quoteId: q.id }).status, 'closed', 'confirm stays idempotent');
});

test('cancelling an unpaid order costs nothing', () => {
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: prepare().id });
  const preview = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([preview.cancellable, preview.penalty, preview.refund], [true, 0, 0]);
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id, reason: '行程有变' });
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(c.cancellation, { cancelledAt: new Date(t).toISOString(), penalty: 0, refund: 0, reason: '行程有变' });
  assert.deepEqual(bookings.cancelOrder({ userId: ALICE, orderId: order.id }), c, 'cancel is idempotent');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'wechat' })), 'order_cancelled');
});

test('free-cancel policy: free before the day-before-18:00 deadline, first night after', () => {
  const order = bookAndPay(findBookable('BF2-FC'));
  assert.equal(order.rate.cancelPolicy.freeUntil, '2026-11-09T18:00:00+08:00');
  const early = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([early.cancellable, early.penalty, early.refund], [true, 0, order.totalPrice]);
  assert.match(early.policyText, /11月9日 18:00前可免费取消/);

  setTime('2026-11-09T17:59:00+08:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).penalty, 0);
  setTime('2026-11-09T18:00:00+08:00');
  const late = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  const firstNight = order.nightly[0].price * order.rooms;
  assert.deepEqual([late.cancellable, late.penalty, late.refund], [true, firstNight, order.totalPrice - firstNight]);
  assert.match(late.policyText, /首晚/);
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id, reason: '改期' });
  assert.equal(c.cancellation.penalty, firstNight);
  assert.equal(c.cancellation.refund, order.totalPrice - firstNight);
});

test('limited policy (luxury 含双早·限时取消): free until 3 days before, then first night', () => {
  const pick = findBookable('BF2-LC', { category: 'luxury', rooms: 2, adults: 4 });
  const order = bookAndPay(pick, { rooms: 2, adults: 4, guests: ['张三', '李四'] });
  assert.equal(order.rate.cancelPolicy.type, 'limited');
  assert.equal(order.rate.cancelPolicy.freeUntil, '2026-11-07T18:00:00+08:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).penalty, 0);
  setTime('2026-11-08T09:00:00+08:00');
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(p.penalty, order.nightly[0].price * 2, 'first night for both rooms');
  assert.equal(p.refund, order.totalPrice - p.penalty);
});

test('non-refundable policy: still cancellable, penalty = total, refund 0', () => {
  const order = bookAndPay(findBookable('BF0-NR'));
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([p.cancellable, p.penalty, p.refund], [true, order.totalPrice, 0]);
  assert.match(p.policyText, /不可取消/);
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id });
  assert.deepEqual([c.status, c.cancellation.penalty, c.cancellation.refund], ['cancelled', order.totalPrice, 0]);
});

test('after the check-in date has passed an order can no longer be cancelled online', () => {
  const order = bookAndPay(findBookable('BF2-FC'));
  setTime('2026-11-10T21:00:00+08:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).cancellable, true, 'check-in day itself is still ok');
  setTime(`${addDays(STAY.checkIn, 1)}T09:00:00+08:00`);
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(p.cancellable, false);
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: ALICE, orderId: order.id })), 'not_cancellable');
});

test('listOrders: newest first, own orders only; getOrder ownership', () => {
  const o1 = bookings.confirmQuote({ userId: ALICE, quoteId: prepare({ sessionId: 'a' }).id });
  advance(MIN);
  const o2 = bookings.confirmQuote({ userId: ALICE, quoteId: prepare({ sessionId: 'b' }).id });
  advance(MIN);
  const bobQuote = prepare({ userId: BOB, sessionId: 'c', contactPhone: '13900001111' });
  const o3 = bookings.confirmQuote({ userId: BOB, quoteId: bobQuote.id });
  assert.deepEqual(bookings.listOrders(ALICE).map((o) => o.id), [o2.id, o1.id]);
  assert.deepEqual(bookings.listOrders(BOB).map((o) => o.id), [o3.id]);
  assert.equal(bookings.getOrder(BOB, o1.id), null);
  assert.equal(bookings.getOrder(ALICE, o1.id).id, o1.id);
  assert.equal(bookings.getOrder('', o1.id), null);
  assert.equal(codeOf(() => bookings.previewCancellation({ userId: BOB, orderId: o1.id })), 'not_found');
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: BOB, orderId: o1.id })), 'not_found');
  assert.equal(codeOf(() => bookings.listOrders('')), 'unauthorized');
});

test('full lifecycle survives a store reload (plain JSON values)', () => {
  const order = bookAndPay(findBookable('BF2-FC'));
  const snapshot = JSON.parse(JSON.stringify(store.collection('orders').values()));
  const store2 = createJsonStore({ dir: null });
  for (const o of snapshot) store2.collection('orders').set(o.id, o);
  const svc2 = createBookingService({ store: store2, hotels, clock });
  assert.deepEqual(svc2.getOrder(ALICE, order.id), order);
  const c = svc2.cancelOrder({ userId: ALICE, orderId: order.id });
  assert.equal(c.status, 'cancelled');
});

test('createBookingService requires store and hotels; default ids produce real formats', () => {
  assert.throws(() => createBookingService({ hotels }), /store/);
  assert.throws(() => createBookingService({ store }), /hotels/);
  const svc = createBookingService({ store, hotels, clock });
  const pick = findBookable('BF2-FC');
  const q = svc.prepareBooking({ userId: ALICE, hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['张三'], contactPhone: '13812345678' });
  assert.match(q.id, /^Q[0-9a-f]{16}$/);
  assert.equal(q.sessionId, null);
  assert.equal(q.adults, 2);
  const o = svc.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.match(o.id, /^HA20261025\d{6}$/);
  const paid = svc.payOrder({ userId: ALICE, orderId: o.id, method: 'wechat' });
  assert.match(paid.confirmationNo, /^\d{8}$/);
  assert.match(paid.payment.transactionId, /^SIMWX20261025\d{10}$/);
});
