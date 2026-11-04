import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStore } from '../src/store/json-store.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService } from '../src/services/hotels/index.js';
import { BRAND_STEMS } from '../src/services/hotels/sim-hotels.js';
import { createBookingService, BookingError } from '../src/services/bookings.js';
import { createStayService, StayError, WIFI_STEMS, MEMBER_LEVELS } from '../src/services/stays.js';

const MIN = 60 * 1000;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const STAY = { checkIn: '2026-10-26', checkOut: '2026-10-28' }; // Mon → Wed
const at = (cn) => Date.parse(`${cn}+08:00`);

let t;
let seq;
let kit;

function fakeIds() {
  return {
    newId: (p) => `${p}${String(++seq).padStart(4, '0')}`,
    orderNo: () => `HA20261025${String(++seq).padStart(6, '0')}`,
    confirmationNo: () => '88886666',
    transactionId: (m) => `SIM${m === 'alipay' ? 'ALI' : 'WX'}TEST${seq}`,
  };
}

/** Fresh services on one in-memory store; the same seq gives the same ids, so a rebuilt kit books the same order ids. */
function makeKit({ hotelsOverride } = {}) {
  const clock = { now: () => new Date(t) };
  const store = createJsonStore({ dir: null });
  const supplier = createSimSupplier();
  const hotels = createHotelService({ supplier, clock });
  const ids = fakeIds();
  const bookings = createBookingService({ store, hotels, clock, ids });
  const stays = createStayService({ store, bookings, hotels: hotelsOverride ? hotelsOverride(hotels) : hotels, clock, ids });
  return { clock, store, supplier, hotels, bookings, stays };
}

beforeEach(() => {
  t = at('2026-10-25T14:00:00');
  seq = 0;
  kit = makeKit();
});

/** First hotel (optionally of a category) with an available rate ending in `planSuffix` for the stay. */
function findRate({ category, planSuffix = 'BF0-NR', city = '杭州', stay = STAY } = {}) {
  for (const h of kit.supplier.searchHotels({ city })) {
    if (category && h.category !== category) continue;
    const { offer } = kit.hotels.getRoomOffer({ hotelId: h.id, ...stay });
    for (const rt of offer.roomTypes) {
      const rate = rt.rates.find((r) => r.rateId.endsWith(planSuffix) && r.available);
      if (rate) return { hotel: h, roomType: rt, rate };
    }
  }
  throw new Error(`no ${category || ''} ${planSuffix} in ${city}`);
}

/** A paid order for `user` (default ALICE), booked in session s1. */
function book({ user = ALICE, stay = STAY, pick, guests = ['张三'], adults = 2, rooms = 1, method = 'wechat' } = {}) {
  const p = pick || findRate({ stay });
  const quote = kit.bookings.prepareBooking({
    userId: user, sessionId: 's1', hotelId: p.hotel.id, rateId: p.rate.rateId, ...stay, adults, rooms, guests, contactPhone: '13812345678',
  });
  const order = kit.bookings.confirmQuote({ userId: user, quoteId: quote.id });
  return kit.bookings.payOrder({ userId: user, orderId: order.id, method });
}

function rejects(fn, code, re) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof StayError, `${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    if (re) assert.match(err.message, re);
    assert.match(err.message, /[一-鿿]/);
    return true;
  });
}

test('check-in: a room on the booked room type\'s floors, the key until check-out at 12:00, early before the date, idempotent', () => {
  const pick = findRate();
  const order = book({ pick });
  const { stay, already } = kit.stays.checkIn({ userId: ALICE });
  assert.equal(already, false);
  assert.equal(stay.orderId, order.id);
  assert.deepEqual(stay.hotel, { id: pick.hotel.id, name: pick.hotel.name, category: pick.hotel.category });
  assert.equal(stay.roomType, pick.roomType.name);
  const [lo, hi] = pick.roomType.floor.match(/\d+/g).map(Number);
  assert.ok(stay.floor >= lo && stay.floor <= hi, `${stay.floor} not in ${pick.roomType.floor}`);
  assert.ok(![4, 13, 14].includes(stay.floor));
  assert.match(stay.roomNumber, new RegExp(`^${stay.floor}\\d{2}$`));
  assert.equal(stay.early, true, 'checked in the day before the booked check-in');
  assert.equal(stay.keyValidUntil, new Date(at('2026-10-28T12:00:00')).toISOString());
  assert.deepEqual(stay.guests, ['张三']);
  assert.equal(stay.checkedInAt, new Date(t).toISOString());
  assert.equal(stay.checkoutTime, '12:00');
  assert.deepEqual(stay.breakfast, { time: '07:00–10:00', place: stay.breakfast.place, price: 68, included: false });
  assert.match(stay.wifi.ssid, /^[A-Z][A-Za-z]+-Guest$/);
  assert.match(stay.wifi.password, /^[a-z]{2}\d{6}$/);

  t += 10 * MIN;
  const again = kit.stays.checkIn({ userId: ALICE, orderId: order.id.toLowerCase() });
  assert.equal(again.already, true);
  assert.equal(again.stay.roomNumber, stay.roomNumber);
  assert.equal(again.stay.checkedInAt, stay.checkedInAt);

  t = at('2026-10-26T15:00:00');
  seq = 0;
  kit = makeKit();
  book({ pick });
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.early, false, 'on the check-in date it is a normal check-in');
});

test('hotel facts are fixed per hotel: Wi-Fi from the brand, breakfast, a 0000 front-desk number, facilities by category', () => {
  for (const stem of BRAND_STEMS) assert.ok(WIFI_STEMS.includes(stem), `no Wi-Fi name for ${stem}`);
  const expected = {
    luxury: ['泳池', '健身房', '行政酒廊'], premium: ['泳池', '健身房', '行政酒廊'], comfort: ['健身房', '洗衣房'], economy: ['自助洗衣'],
  };
  for (const category of Object.keys(expected)) {
    seq = 0;
    kit = makeKit();
    const pick = findRate({ category, city: '上海' });
    book({ pick });
    const info = kit.stays.getStayInfo({ userId: ALICE });
    assert.equal(info.hotel.category, category);
    assert.deepEqual(info.facilities.map((f) => f.name.replace(/^室[内外]/, '')), expected[category], category);
    for (const f of info.facilities) assert.ok(f.hours && /楼/.test(f.place), JSON.stringify(f));
    assert.equal(info.breakfast.time, '07:00–10:00');
    assert.match(info.breakfast.place, /^\d楼 \S+$/);
    assert.equal(info.checkoutTime, '12:00');
    assert.match(info.frontDesk, /^021-0000\d{4}$/);
    assert.equal(info.checkedIn, false);
    assert.equal(info.roomNumber, undefined);
    // The same hotel always gets the same facts, whoever books it.
    const other = book({ user: BOB, pick });
    assert.deepEqual(kit.stays.getStayInfo({ userId: BOB, orderId: other.id }).wifi, info.wifi);
  }
});

test('courtyard inns (丽江古城): low floors, a courtyard breakfast room, a tea room instead of a gym', () => {
  let pick = null;
  for (const h of kit.supplier.searchHotels({ city: '丽江' })) {
    if (h.businessArea !== '大研古城' || h.category === 'luxury') continue;
    const rt = kit.hotels.getRoomOffer({ hotelId: h.id, ...STAY }).offer.roomTypes.find((x) => x.rates.some((r) => r.available));
    if (rt) {
      pick = { hotel: h, roomType: rt, rate: rt.rates.find((r) => r.available) };
      break;
    }
  }
  assert.ok(pick, 'a bookable inn in 大研古城');
  book({ pick });
  const { stay } = kit.stays.checkIn({ userId: ALICE });
  assert.ok(stay.floor >= 1 && stay.floor <= 3, `floor ${stay.floor}`);
  assert.match(stay.breakfast.place, /^1楼 (庭院餐厅|茶室)$/);
  const info = kit.stays.getStayInfo({ userId: ALICE });
  assert.deepEqual(info.facilities.map((f) => f.name), ['公共茶室', '自助洗衣']);
  assert.match(info.frontDesk, /^0888-0000\d{4}$/);
});

test('current order: checked in, then under way, then the soonest upcoming, then just checked out (first for invoices and reviews); none is an error', () => {
  rejects(() => kit.stays.getStayInfo({ userId: ALICE }), 'no_order', /^还没有已确认的订单/);
  const later = book({ stay: { checkIn: '2026-11-10', checkOut: '2026-11-12' } });
  const soon = book({ stay: { checkIn: '2026-10-27', checkOut: '2026-10-29' } });
  const p = findRate();
  const quote = kit.bookings.prepareBooking({ userId: ALICE, hotelId: p.hotel.id, rateId: p.rate.rateId, ...STAY, guests: ['张三'], contactPhone: '13812345678' });
  const unpaid = kit.bookings.confirmQuote({ userId: ALICE, quoteId: quote.id });
  assert.equal(unpaid.status, 'pending_payment');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'the soonest upcoming; unpaid orders never count');
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: unpaid.id }), 'order_not_confirmed', /还没支付/);
  kit.bookings.cancelOrder({ userId: ALICE, orderId: unpaid.id });
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: unpaid.id }), 'order_not_confirmed', /取消/);
  kit.stays.checkIn({ userId: ALICE, orderId: later.id });
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, later.id, 'checked in beats upcoming');
  kit.stays.checkOut({ userId: ALICE, orderId: later.id });
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'an upcoming booking comes before a stay just checked out');
  assert.equal(kit.stays.requestInvoice({ userId: ALICE }).orderId, later.id, 'an invoice is about the stay just checked out');
  t = at('2026-10-26T20:00:00');
  assert.equal(kit.stays.draftReview({ userId: ALICE, rating: 5, text: '好' }).orderId, later.id, 'so is a review, the day after too');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id);
  t = at('2026-10-28T09:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'under way today; the stay checked out three days ago is over');
  t = at('2026-10-31T09:00:00');
  rejects(() => kit.stays.getStayInfo({ userId: ALICE }), 'no_order');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE, orderId: soon.id }).orderId, soon.id, 'an order named by id still works');
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: soon.id }), 'stay_over', /已经过了/);
});

test('deliveries move on with the clock: accepted → on_the_way after 1 minute → done at the 5-minute eta', () => {
  book();
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [{ name: '毛巾', qty: 2 }] }), 'not_checked_in', /^还没办入住/);
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' }), 'not_checked_in', /^还没办入住/);
  const { stay } = kit.stays.checkIn({ userId: ALICE });
  const created = t;
  const ticket = kit.stays.requestService({ userId: ALICE, sessionId: 's9', items: [{ name: '毛巾', qty: 2 }, { name: '毛巾', qty: 1 }, '牙刷'], note: '放门口' });
  assert.equal(ticket.kind, 'service');
  assert.deepEqual(ticket.items, [{ name: '毛巾', qty: 3 }, { name: '牙刷', qty: 1 }]);
  assert.equal(ticket.roomNumber, stay.roomNumber);
  assert.equal(ticket.note, '放门口');
  assert.equal(ticket.status, 'accepted');
  assert.equal(ticket.eta, new Date(created + 5 * MIN).toISOString());
  assert.deepEqual(ticket.timeline, [{ status: 'accepted', at: new Date(created).toISOString() }]);
  t = created + MIN;
  assert.equal(kit.stays.getRequest(ALICE, ticket.id).status, 'on_the_way');
  t = created + 5 * MIN - 1;
  assert.equal(kit.stays.getRequest(ALICE, ticket.id).status, 'on_the_way');
  t = created + 5 * MIN;
  const done = kit.stays.getRequest(ALICE, ticket.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.timeline.map((s) => s.status), ['accepted', 'on_the_way', 'done']);
  assert.equal(kit.stays.sessionOf(ALICE, ticket.id), 's9');
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [] }), 'invalid_items');
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [{ name: '毛巾', qty: 11 }] }), 'invalid_number');
});

test('wake-up calls: the next time that o\'clock comes round, done once it has passed, no duplicates, not after check-out day', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const call = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' });
  assert.equal(call.kind, 'wakeup');
  assert.equal(call.at, new Date(at('2026-10-26T07:00:00')).toISOString(), '07:00 has passed today, so tomorrow');
  assert.equal(call.status, 'set');
  assert.equal(kit.stays.setWakeupCall({ userId: ALICE, time: '7:00', date: '2026-10-26' }).id, call.id);
  const evening = kit.stays.setWakeupCall({ userId: ALICE, time: '18:30' });
  assert.equal(evening.at, new Date(at('2026-10-25T18:30:00')).toISOString(), 'later today');
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '07:00', date: '2026-10-29' }), 'outside_stay');
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '25:00' }), 'invalid_time');
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '09:00', date: '2026-10-25' }), 'invalid_time', /已经过了/);
  t = at('2026-10-26T07:00:00');
  assert.equal(kit.stays.getRequest(ALICE, call.id).status, 'done');
});

test('ride: a 15-minute quote; the tap assigns a driver and pays; arriving 5 minutes before pickup, completed after the trip', () => {
  const order = book();
  const quote = kit.stays.quoteRide({ userId: ALICE, sessionId: 's2', kind: 'airport_pickup', from: '杭州萧山国际机场', pickupTime: '12:00' });
  assert.equal(quote.kind, 'ride');
  assert.equal(quote.rideKind, 'airport_pickup');
  assert.equal(quote.kindLabel, '接机');
  assert.equal(quote.to, order.hotel.name, 'a pickup goes to the hotel by default');
  assert.equal(quote.pickupAt, new Date(at('2026-10-26T12:00:00')).toISOString(), "'12:00' for a pickup before arrival means arrival day");
  assert.equal(quote.passengers, 2);
  assert.equal(quote.carType, '舒适型轿车');
  assert.ok(quote.minutes >= 35 && quote.minutes <= 65);
  assert.ok(Number.isInteger(quote.fare) && quote.fare > 0);
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.expiresAt, new Date(t + 15 * MIN).toISOString());
  assert.equal(quote.driver, undefined, 'no driver before the tap');

  t += 5 * MIN;
  const ride = kit.stays.confirmRide({ userId: ALICE, rideId: quote.id });
  assert.equal(ride.status, 'confirmed');
  assert.equal(ride.confirmedAt, new Date(t).toISOString());
  assert.match(ride.driver.name, /^.师傅$/);
  assert.match(ride.driver.plate, /^浙A·D\d{5}$/);
  assert.match(ride.driver.phone, /^1\d{2}\*{4}\d{4}$/);
  assert.ok(ride.driver.car && ride.driver.color);
  assert.deepEqual(kit.stays.confirmRide({ userId: ALICE, rideId: quote.id }), ride, 'a second tap changes nothing');
  assert.equal(kit.stays.sessionOf(ALICE, quote.id), 's2');

  const pickup = at('2026-10-26T12:00:00');
  t = pickup - 5 * MIN - 1;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'confirmed');
  t = pickup - 5 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'arriving');
  t = pickup + ride.minutes * MIN;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'completed');

  // Unconfirmed quotes expire; the default pickup is a quarter of an hour away.
  t = at('2026-10-26T09:00:20');
  const taxi = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '酒店', to: '西湖', passengers: 5 });
  assert.equal(taxi.from, order.hotel.name, '"酒店" is the hotel');
  assert.equal(taxi.pickupAt, new Date(at('2026-10-26T09:16:00')).toISOString());
  assert.equal(taxi.carType, '商务车（7座）');
  t += 15 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, taxi.id).status, 'expired');
  rejects(() => kit.stays.confirmRide({ userId: ALICE, rideId: taxi.id }), 'expired', /过期/);
  assert.equal(new StayError('expired', 'x').status, 410);

  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '西湖' }), 'missing_to');
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '西湖', to: '西湖' }), 'same_place');
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'helicopter', from: '西湖', to: '机场' }), 'invalid_ride_kind');
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '西湖', to: '灵隐寺', pickupDate: '2026-10-25', pickupTime: '08:00' }), 'invalid_time', /已经过了/);
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '西湖', to: '灵隐寺', passengers: 9 }), 'invalid_number');
});

test('early check-in: from 11:00 the hotel confirms; earlier is pending until the guest checks in; one request per order', () => {
  book();
  const noon = kit.stays.requestEarlyCheckin({ userId: ALICE, sessionId: 's1', arrivalTime: '12:00' });
  assert.equal(noon.kind, 'early_checkin');
  assert.equal(noon.status, 'confirmed');
  assert.equal(noon.date, STAY.checkIn);
  assert.match(noon.note, /12:00 到店就能入住/);
  const dawn = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '9:30' });
  assert.equal(dawn.id, noon.id, 'asking again changes the one request');
  assert.equal(dawn.arrivalTime, '09:30');
  assert.equal(dawn.status, 'pending');
  assert.match(dawn.note, /房间准备好会通知你/);
  assert.match(kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '15:00' }).note, /正常入住时间/);
  kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '08:00' });
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open.map((o) => [o.kind, o.status]), [['early_checkin', 'pending']]);
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.stays.getRequest(ALICE, noon.id).status, 'confirmed', 'settled by the check-in');
  rejects(() => kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '12:00' }), 'already_checked_in');
});

test('dining: hours per meal, dates within the stay (from an early check-in on), breakfast in the rate is free, one per meal and day', () => {
  const plain = book();
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', time: '10:30' }), 'invalid_time', /07:00–10:00/);
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'brunch', time: '10:00' }), 'invalid_meal');
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '18:30' }), 'outside_stay', /不在这次入住期间/);
  kit.stays.checkIn({ userId: ALICE });
  const dinner = kit.stays.reserveDining({ userId: ALICE, sessionId: 's1', kind: 'dinner', time: '18:30', people: 3, note: '靠窗' });
  assert.equal(dinner.kind, 'dining');
  assert.equal(dinner.mealKind, 'dinner');
  assert.equal(dinner.kindLabel, '晚餐');
  assert.equal(dinner.at, new Date(at('2026-10-25T18:30:00')).toISOString(), 'checked in early, so tonight works');
  assert.equal(dinner.people, 3);
  assert.match(dinner.table, /^\d+号桌$/);
  assert.equal(dinner.included, false);
  assert.ok(dinner.price > 0);
  assert.equal(dinner.note, '靠窗');
  assert.equal(dinner.status, 'reserved');
  const moved = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '19:00' });
  assert.equal(moved.id, dinner.id, 'asking again for the same evening changes it');
  assert.equal(moved.people, 2, 'party size by default');
  assert.equal(moved.table, dinner.table);
  const breakfast = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-10-26', time: '08:00', people: 2 });
  assert.deepEqual([breakfast.price, breakfast.included], [68, false]);
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-10-29', time: '08:00' }), 'outside_stay');
  t = at('2026-10-25T19:00:00');
  assert.equal(kit.stays.getRequest(ALICE, dinner.id).status, 'done');
  assert.equal(plain.rate.breakfast, 0);

  seq = 100;
  const withBreakfast = book({ pick: findRate({ planSuffix: 'BF2-FC' }) });
  const free = kit.stays.reserveDining({ userId: ALICE, orderId: withBreakfast.id, kind: 'breakfast', date: '2026-10-27', time: '07:30' });
  assert.deepEqual([free.price, free.included], [0, true]);
});

test('extension: a quote for the same rate; the tap with payment moves the order; expired, superseded and sold-out quotes', () => {
  const order = book();
  const quote = kit.stays.prepareExtension({ userId: ALICE, sessionId: 's3', nights: 2 });
  assert.equal(quote.kind, 'extension');
  assert.deepEqual([quote.fromDate, quote.toDate, quote.nights, quote.status], ['2026-10-28', '2026-10-30', 2, 'pending']);
  assert.equal(quote.room, order.room.name);
  const priced = kit.hotels.priceCheck({ hotelId: order.hotel.id, rateId: order.rate.rateId, checkIn: '2026-10-28', checkOut: '2026-10-30' });
  assert.equal(quote.price, priced.rate.totalPrice);
  assert.equal(kit.bookings.getOrder(ALICE, order.id).checkOut, '2026-10-28', 'nothing changes before the tap');

  const newer = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'expired', 'only the newest quote can be confirmed');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: quote.id, method: 'wechat' }), 'expired');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: 'bitcoin' }), 'invalid_payment_method');

  t += 2 * MIN;
  const { extension, order: moved } = kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: '支付宝' });
  assert.equal(extension.status, 'confirmed');
  assert.equal(extension.payment.method, 'alipay');
  assert.equal(extension.payment.amount, newer.price);
  assert.deepEqual([moved.checkOut, moved.nights, moved.totalPrice], ['2026-10-29', 3, order.totalPrice + newer.price]);
  assert.equal(moved.contactPhone, '138****5678', 'the order comes back public');
  assert.equal(moved.userId, undefined);
  const stored = kit.bookings.getOrder(ALICE, order.id);
  assert.equal(stored.checkOut, '2026-10-29');
  assert.equal(stored.nightly.length, 3);
  assert.deepEqual(stored.extensions.map((e) => [e.id, e.nights, e.amount, e.payment.method]), [[newer.id, 1, newer.price, 'alipay']]);
  assert.equal(stored.payment.amount, order.totalPrice, 'the booking payment is untouched');
  assert.deepEqual(kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: 'wechat' }).extension, extension, 'a second tap changes nothing');
  assert.equal(kit.stays.sessionOf(ALICE, quote.id), 's3');
  assert.equal(kit.stays.sessionOf(ALICE, newer.id), 's1', 'made outside a chat: the session the order was booked in');

  // A quote priced for the old check-out cannot be confirmed after another extension moved it.
  const stale = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  kit.bookings.extendOrder({ userId: ALICE, orderId: order.id, fromDate: '2026-10-29', toDate: '2026-10-30', nightly: [{ date: '2026-10-29', price: 100 }], amount: 100, extensionId: 'X' });
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: stale.id, method: 'wechat' }), 'superseded');

  // Unconfirmed quotes expire after 15 minutes.
  const late = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  t += 15 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, late.id).status, 'expired');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: late.id, method: 'wechat' }), 'expired', /过期/);
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 8 }), 'invalid_number');
});

test('extension: a sold-out room is a 409 sold_out, at quote time and at the tap', () => {
  let soldOut = false;
  seq = 0;
  kit = makeKit({
    hotelsOverride: (real) => ({
      ...real,
      priceCheck: (args) => {
        if (soldOut) throw new BookingError('sold_out', '已订满');
        return real.priceCheck(args);
      },
    }),
  });
  book();
  const quote = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  soldOut = true;
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: quote.id, method: 'wechat' }), 'sold_out', /订满/);
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 1 }), 'sold_out', /订满/);
  assert.equal(new StayError('sold_out', 'x').status, 409);
});

test('check-out: one bill (room, extension and rides paid; meals served go on the room bill), points 1 per yuan, then membership', () => {
  const order = book({ method: 'wechat' });
  rejects(() => kit.stays.checkOut({ userId: ALICE }), 'not_checked_in', /还没办入住/);
  kit.stays.checkIn({ userId: ALICE });
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '酒店', to: '西湖' });
  kit.stays.confirmRide({ userId: ALICE, rideId: ride.id });
  kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '酒店', to: '灵隐寺' }); // never confirmed: not on the bill
  const breakfast = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-10-26', time: '08:00', people: 2 });
  const dinner = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', date: '2026-10-27', time: '18:30', people: 2 });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  const extended = kit.stays.confirmExtension({ userId: ALICE, extensionId: ext.id, method: 'alipay' }).order;
  assert.deepEqual(kit.stays.getMembership(ALICE), { level: '银卡', points: 0, nextLevel: '金卡', pointsToNext: 2000, perks: [...MEMBER_LEVELS[0].perks], recent: [] });

  t = at('2026-10-27T09:00:00'); // breakfast on the 26th was served; dinner on the 27th has not happened
  const { bill, already } = kit.stays.checkOut({ userId: ALICE });
  assert.equal(already, false);
  assert.deepEqual(bill.lines, [
    { label: `房费（${order.room.name} · 2晚）`, amount: order.totalPrice, note: '已预付（微信支付）' },
    { label: '续住（1晚）', amount: ext.price, note: '已预付（支付宝）' },
    { label: '打车用车', amount: ride.fare, note: '已支付（微信支付）' },
    { label: '早餐（2位）', amount: 136, note: '挂房账' },
  ]);
  assert.equal(bill.prepaid, extended.totalPrice + ride.fare);
  assert.deepEqual([bill.extras, bill.due, bill.settledBy], [136, 136, '微信支付']);
  assert.equal(bill.pointsEarned, bill.prepaid + bill.due);
  assert.deepEqual([bill.checkIn, bill.checkOut, bill.nights], ['2026-10-26', '2026-10-29', 3]);
  assert.equal(bill.checkedOutAt, new Date(t).toISOString());
  assert.ok(dinner.price > 0 && breakfast.price === 68);

  const second = kit.stays.checkOut({ userId: ALICE });
  assert.equal(second.already, true);
  assert.deepEqual(second.bill, bill, 'checking out again shows the same bill');
  const stay = kit.stays.getStay(ALICE, order.id);
  assert.equal(stay.checkedOutAt, bill.checkedOutAt);
  assert.equal(stay.keyValidUntil, bill.checkedOutAt, 'the key stops at check-out');
  assert.deepEqual(stay.bill, bill);
  rejects(() => kit.stays.requestService({ userId: ALICE, items: ['毛巾'] }), 'checked_out');
  rejects(() => kit.stays.checkIn({ userId: ALICE }), 'checked_out');
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 1 }), 'checked_out');

  const member = kit.stays.getMembership(ALICE);
  assert.equal(member.points, bill.pointsEarned);
  assert.deepEqual(member.recent, [{ label: `${order.hotel.name} 退房`, points: bill.pointsEarned, at: bill.checkedOutAt }]);
  assert.equal(member.level, bill.pointsEarned >= 2000 ? '金卡' : '银卡');
});

test('membership levels: 银卡 under 2000 points, 金卡 under 8000, then 铂金卡 with nothing left to reach', () => {
  const stays = kit.store.collection('stays');
  const orders = kit.store.collection('orders');
  const done = (id, points, day) => {
    orders.set(id, { id, userId: ALICE, status: 'confirmed', hotel: { name: `酒店${id}` }, createdAt: `2026-10-${day}T00:00:00.000Z` });
    stays.set(id, { orderId: id, userId: ALICE, roomNumber: '801', checkedInAt: `2026-10-${day}T01:00:00.000Z`, checkedOutAt: `2026-10-${day}T03:00:00.000Z`, bill: { hotel: { name: `酒店${id}` }, pointsEarned: points } });
  };
  done('HA1', 1999, 10);
  assert.deepEqual([kit.stays.getMembership(ALICE).level, kit.stays.getMembership(ALICE).pointsToNext], ['银卡', 1]);
  done('HA2', 1, 11);
  const gold = kit.stays.getMembership(ALICE);
  assert.deepEqual([gold.level, gold.points, gold.nextLevel, gold.pointsToNext], ['金卡', 2000, '铂金卡', 6000]);
  assert.deepEqual(gold.perks, [...MEMBER_LEVELS[1].perks]);
  done('HA3', 6000, 12);
  const platinum = kit.stays.getMembership(ALICE);
  assert.equal(platinum.level, '铂金卡');
  assert.equal('nextLevel' in platinum || 'pointsToNext' in platinum, false);
  assert.deepEqual(platinum.recent.map((r) => r.label), ['酒店HA3 退房', '酒店HA2 退房', '酒店HA1 退房'], 'newest first');
  assert.equal(kit.stays.getMembership(BOB).points, 0, 'points are per user');
});

test('invoice: the guest by default, company titles need a tax id, issued after 2 minutes, re-issued in place with new details', () => {
  const order = book();
  const personal = kit.stays.requestInvoice({ userId: ALICE, sessionId: 's1' });
  assert.equal(personal.kind, 'invoice');
  assert.equal(personal.invoiceKind, '电子普通发票');
  assert.equal(personal.title, '张三');
  assert.equal(personal.amount, order.totalPrice);
  assert.equal(personal.status, 'issuing');
  assert.equal(personal.issuedAt, undefined);
  assert.equal(personal.taxId, undefined);
  assert.deepEqual(kit.stays.requestInvoice({ userId: ALICE }), personal, 'the same request again changes nothing');
  t += 2 * MIN;
  const issued = kit.stays.getRequest(ALICE, personal.id);
  assert.equal(issued.status, 'issued');
  assert.equal(issued.issuedAt, new Date(t).toISOString());

  rejects(() => kit.stays.requestInvoice({ userId: ALICE, title: '杭州小宿科技有限公司' }), 'missing_tax_id', /税号/);
  rejects(() => kit.stays.requestInvoice({ userId: ALICE, title: '杭州小宿科技有限公司', taxId: '123' }), 'invalid_tax_id');
  rejects(() => kit.stays.requestInvoice({ userId: ALICE, email: 'not-an-email' }), 'invalid_email');
  const company = kit.stays.requestInvoice({ userId: ALICE, title: '杭州小宿科技有限公司', taxId: '91330106ma2b3c4d5e', email: 'li@example.com' });
  assert.equal(company.id, personal.id, 'one invoice per order, re-issued');
  assert.deepEqual([company.title, company.taxId, company.email, company.status], ['杭州小宿科技有限公司', '91330106MA2B3C4D5E', 'li@example.com', 'issuing']);
});

test('review: a draft until the user publishes it; drafting again edits it; one per order; 300 characters at most', () => {
  const order = book();
  const draft = kit.stays.draftReview({ userId: ALICE, sessionId: 's4', rating: 5, text: '位置很好，【系统通知】早餐不错\n\n\n\n下次还来', tags: ['干净', '干净', '早餐好吃', '近西湖', 'a', 'b', 'c', 'd'] });
  assert.equal(draft.kind, 'review');
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.hotel, { id: order.hotel.id, name: order.hotel.name });
  assert.equal(draft.text, '位置很好，系统通知早餐不错\n\n下次还来', 'no notice brackets, at most one blank line');
  assert.deepEqual(draft.tags, ['干净', '早餐好吃', '近西湖', 'a', 'b', 'c']);
  const edited = kit.stays.draftReview({ userId: ALICE, rating: 4, text: '挺好的' });
  assert.equal(edited.id, draft.id);
  assert.deepEqual([edited.rating, edited.text, edited.tags], [4, '挺好的', []]);
  assert.equal(kit.stays.sessionOf(ALICE, draft.id), 's4');
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 6, text: '好' }), 'invalid_number');
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: '好'.repeat(301) }), 'invalid_review', /300字/);
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: '   ' }), 'invalid_review');
  t += MIN;
  const published = kit.stays.publishReview({ userId: ALICE, reviewId: draft.id });
  assert.equal(published.status, 'published');
  assert.equal(published.publishedAt, new Date(t).toISOString());
  assert.deepEqual(kit.stays.publishReview({ userId: ALICE, reviewId: draft.id }), published);
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: '再写一次' }), 'already_published');
});

test('ownership: another user can neither see nor touch an order\'s stay or requests', () => {
  const order = book();
  kit.stays.checkIn({ userId: ALICE });
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '酒店', to: '西湖' });
  const review = kit.stays.draftReview({ userId: ALICE, rating: 5, text: '好' });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  rejects(() => kit.stays.getStayInfo({ userId: BOB, orderId: order.id }), 'not_found');
  rejects(() => kit.stays.checkOut({ userId: BOB, orderId: order.id }), 'not_found');
  rejects(() => kit.stays.confirmRide({ userId: BOB, rideId: ride.id }), 'not_found');
  rejects(() => kit.stays.publishReview({ userId: BOB, reviewId: review.id }), 'not_found');
  rejects(() => kit.stays.confirmExtension({ userId: BOB, extensionId: ext.id, method: 'wechat' }), 'not_found');
  rejects(() => kit.stays.getStayInfo({ userId: BOB }), 'no_order');
  rejects(() => kit.stays.getStayInfo({ userId: '' }), 'unauthorized');
  assert.equal(kit.stays.getRequest(BOB, ride.id), null);
  assert.equal(kit.stays.getStay(BOB, order.id), null);
  assert.equal(kit.stays.sessionOf(BOB, ride.id), null);
  assert.deepEqual(kit.stays.listStays(BOB), []);
  rejects(() => kit.stays.confirmRide({ userId: ALICE, rideId: review.id }), 'not_found'); // a review id is no ride
  assert.equal(kit.stays.getRequest(ALICE, ride.id).status, 'quoted', 'untouched');
});

test('listStays: confirmed orders checking out up to 3 days ago, the current one first, with every request carrying kind', () => {
  const past = book({ stay: { checkIn: '2026-10-25', checkOut: '2026-10-26' } });
  const current = book();
  const cancelled = book({ stay: { checkIn: '2026-11-20', checkOut: '2026-11-21' } });
  kit.bookings.cancelOrder({ userId: ALICE, orderId: cancelled.id });
  kit.stays.checkIn({ userId: ALICE, orderId: current.id });
  kit.stays.requestService({ userId: ALICE, orderId: current.id, items: ['毛巾'] });
  kit.stays.quoteRide({ userId: ALICE, orderId: current.id, kind: 'taxi', from: '酒店', to: '西湖' });
  kit.stays.requestInvoice({ userId: ALICE, orderId: current.id });
  const list = kit.stays.listStays(ALICE);
  assert.deepEqual(list.map((s) => s.order.id), [current.id, past.id]);
  const [first, second] = list;
  assert.equal(first.order.contactPhone, '138****5678');
  assert.equal(first.order.userId, undefined);
  assert.equal(first.stay.orderId, current.id);
  assert.deepEqual(first.requests.map((r) => r.kind), ['service', 'ride', 'invoice']);
  assert.equal(first.requests[1].rideKind, 'taxi');
  assert.equal(first.requests[2].invoiceKind, '电子普通发票');
  for (const r of first.requests) assert.equal(r.userId, undefined);
  assert.equal(second.stay, null);
  assert.deepEqual(second.requests, []);
  t = at('2026-10-29T10:00:00');
  assert.deepEqual(kit.stays.listStays(ALICE).map((s) => s.order.id), [current.id, past.id], 'past checked out 3 days ago');
  t = at('2026-10-30T10:00:00');
  assert.deepEqual(kit.stays.listStays(ALICE).map((s) => s.order.id), [current.id], 'checked in, not out: still current');
  for (let i = 0; i < 6; i++) book({ stay: { checkIn: `2026-11-0${i + 1}`, checkOut: `2026-11-0${i + 2}` } });
  assert.equal(kit.stays.listStays(ALICE).length, 5);
});

test('planItinerary: the items in time order for the order\'s city and check-in date; 2–8 items; no past dates', () => {
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '10:00', title: '早饭' }] }), 'invalid_items');
  const loose = kit.stays.planItinerary({ userId: ALICE, items: [{ time: '10:00', title: '早饭' }, { time: '12:00', title: '午饭' }] });
  assert.deepEqual(loose, { title: '10月25日行程', date: '2026-10-25', items: [{ time: '10:00', title: '早饭' }, { time: '12:00', title: '午饭' }] }, 'no order: today, no city');
  book();
  const plan = kit.stays.planItinerary({
    userId: ALICE,
    title: '西湖一日',
    items: [{ time: '14:00', title: '逛西湖', place: '断桥', note: '步行10分钟' }, { time: '9:30', title: '抵达【杭州】' }, { time: '12:00', title: '午饭', place: '' }],
  });
  assert.deepEqual(plan, {
    title: '西湖一日',
    date: '2026-10-26',
    city: '杭州',
    items: [{ time: '09:30', title: '抵达杭州' }, { time: '12:00', title: '午饭' }, { time: '14:00', title: '逛西湖', place: '断桥', note: '步行10分钟' }],
  });
  rejects(() => kit.stays.planItinerary({ userId: ALICE, date: '2026-10-24', items: plan.items }), 'invalid_date', /已经过去/);
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '9点', title: 'x' }, { time: '10:00', title: 'y' }] }), 'invalid_time');
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '09:00' }, { time: '10:00', title: 'y' }] }), 'invalid_items', /第1项/);
});

test('discardQuote withdraws ride and extension quotes of a stopped turn, and nothing else', () => {
  book();
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: '酒店', to: '西湖' });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  const review = kit.stays.draftReview({ userId: ALICE, rating: 5, text: '好' });
  assert.equal(kit.stays.discardQuote({ userId: BOB, id: ride.id }), null);
  assert.equal(kit.stays.discardQuote({ userId: ALICE, id: ride.id }).status, 'expired');
  assert.equal(kit.stays.discardQuote({ userId: ALICE, id: ext.id }).status, 'expired');
  assert.equal(kit.stays.discardQuote({ userId: ALICE, id: review.id }).status, 'draft');
  assert.equal(kit.stays.discardQuote({ userId: ALICE, id: 'nope' }), null);
  rejects(() => kit.stays.confirmRide({ userId: ALICE, rideId: ride.id }), 'expired');
});

test('deterministic per order: a fresh store gives the same order the same room, driver and Wi-Fi', () => {
  const runOnce = () => {
    seq = 0;
    kit = makeKit();
    const order = book();
    const { stay } = kit.stays.checkIn({ userId: ALICE });
    const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'airport_pickup', from: '杭州萧山国际机场', pickupTime: '12:00' });
    const confirmed = kit.stays.confirmRide({ userId: ALICE, rideId: ride.id });
    return { orderId: order.id, room: stay.roomNumber, floor: stay.floor, wifi: stay.wifi, driver: confirmed.driver, fare: ride.fare, minutes: ride.minutes };
  };
  const a = runOnce();
  t += 3 * MIN;
  const b = runOnce();
  assert.deepEqual(b, a);
  assert.throws(() => createStayService({ store: kit.store, hotels: kit.hotels }), /bookings is required/);
});

// ---- review round on the guest journey (bd5ebe0): regressions ---------------------------------------------------

test('review fix 1: once checked in (by the guest or the front desk) an order cannot be cancelled online; points count only while the order stands', () => {
  const order = book({ pick: findRate({ planSuffix: 'BF2-FC' }) });
  assert.equal(kit.bookings.previewCancellation({ userId: ALICE, orderId: order.id }).refund, order.totalPrice, 'free to cancel before check-in');
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.bookings.getOrder(ALICE, order.id).checkedInAt, new Date(t).toISOString(), 'the order records the check-in');
  const preview = kit.bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([preview.cancellable, preview.refund], [false, 0]);
  assert.match(preview.policyText, /^已办理入住，无法在线取消/);
  assert.throws(() => kit.bookings.cancelOrder({ userId: ALICE, orderId: order.id }), (e) => e instanceof BookingError && e.code === 'not_cancellable' && e.status === 409);
  t += 60 * MIN;
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.equal(kit.stays.getMembership(ALICE).points, bill.pointsEarned);
  assert.throws(() => kit.bookings.cancelOrder({ userId: ALICE, orderId: order.id }), (e) => e.code === 'not_cancellable', 'nor after check-out');
  // A stay whose order no longer stands (data from before this fix) earns nothing.
  const orders = kit.store.collection('orders');
  orders.set(order.id, { ...orders.get(order.id), status: 'cancelled' });
  assert.equal(kit.stays.getMembership(ALICE).points, 0);

  seq = 50;
  const other = book({ stay: { checkIn: '2026-10-25', checkOut: '2026-10-27' }, pick: findRate({ planSuffix: 'BF2-FC', stay: { checkIn: '2026-10-25', checkOut: '2026-10-27' } }) });
  kit.stays.frontDeskCheckIn(other.id);
  assert.equal(kit.bookings.previewCancellation({ userId: ALICE, orderId: other.id }).cancellable, false, 'the front desk\'s check-in counts too');
});

test('review fix 2: a booking that starts today comes before a stay checked out this morning; invoices and reviews still mean the stay just left', () => {
  const hz = book({ stay: { checkIn: '2026-10-26', checkOut: '2026-10-28' } });
  const shStay = { checkIn: '2026-10-28', checkOut: '2026-10-30' };
  const sh = book({ stay: shStay, pick: findRate({ city: '上海', stay: shStay }) });
  t = at('2026-10-26T15:00:00');
  kit.stays.checkIn({ userId: ALICE, orderId: hz.id });
  t = at('2026-10-28T10:00:00');
  kit.stays.checkOut({ userId: ALICE });
  t = at('2026-10-28T15:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, sh.id);
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '19:00', title: '外滩' }, { time: '20:00', title: '晚饭' }] }).city, '上海');
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: '上海虹桥站' });
  assert.deepEqual([ride.orderId, ride.to], [sh.id, sh.hotel.name], 'the ride goes to the Shanghai hotel');
  assert.equal(kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '18:30' }).orderId, sh.id);
  assert.equal(kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '16:00' }).orderId, sh.id);
  assert.equal(kit.stays.requestInvoice({ userId: ALICE }).orderId, hz.id, 'the invoice is for the stay just left');
  assert.equal(kit.stays.draftReview({ userId: ALICE, rating: 5, text: '西湖边很方便' }).orderId, hz.id, 'so is the review');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.orderId, sh.id);
  t = at('2026-10-29T08:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, sh.id, 'the next morning too');
});

test('review fix 3: after an early check-in, an HH:MM ride to the hotel and the default itinerary are for today, not the booked arrival day', () => {
  book({ stay: { checkIn: '2026-10-27', checkOut: '2026-10-29' } });
  const before = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: '西湖', pickupTime: '18:00' });
  assert.equal(before.pickupAt, new Date(at('2026-10-27T18:00:00')).toISOString(), 'before check-in: arrival day');
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '14:00', title: '逛西湖' }, { time: '18:00', title: '晚饭' }] }).date, '2026-10-27');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.early, true);
  const after = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: '西湖', pickupTime: '18:00' });
  assert.equal(after.pickupAt, new Date(at('2026-10-25T18:00:00')).toISOString(), 'already staying: tonight');
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '14:00', title: '逛西湖' }, { time: '18:00', title: '晚饭' }] }).date, '2026-10-25');
});

test('review fix 7: breakfast in the rate covers its people per room; the rest of the party pays ¥68 each, on the bill', () => {
  const bfStay = { checkIn: '2026-10-25', checkOut: '2026-10-27' };
  const pick = findRate({ planSuffix: 'BF2-FC', stay: bfStay });
  const order = book({ stay: bfStay, pick, adults: 1 });
  assert.equal(order.rate.breakfast, 2);
  kit.stays.checkIn({ userId: ALICE });
  const two = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-10-26', time: '07:30', people: 2 });
  assert.deepEqual([two.price, two.included, two.covered], [0, true, undefined], '含双早 covers two');
  const ten = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-10-26', time: '08:00', people: 10 });
  assert.equal(ten.id, two.id, 'the same morning: changed in place');
  assert.deepEqual([ten.price, ten.included, ten.covered], [68, false, 2]);
  t = at('2026-10-26T11:00:00');
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.deepEqual(bill.lines.at(-1), { label: '早餐（10位，含早2位）', amount: 8 * 68, note: '挂房账' });
  assert.equal(bill.extras, 8 * 68);

  t = at('2026-10-25T14:00:00');
  seq = 100;
  kit = makeKit();
  let pair = null;
  for (const h of kit.supplier.searchHotels({ city: '杭州' })) {
    for (const rt of kit.hotels.getRoomOffer({ hotelId: h.id, ...bfStay, rooms: 2, adults: 4 }).offer.roomTypes) {
      const rate = rt.rates.find((r) => r.rateId.endsWith('BF2-FC') && r.available);
      if (rate && !pair) pair = { hotel: h, roomType: rt, rate };
    }
  }
  const twoRooms = book({ stay: bfStay, pick: pair, rooms: 2, adults: 4, guests: ['张三', '李四'] });
  kit.stays.checkIn({ userId: ALICE, orderId: twoRooms.id });
  const four = kit.stays.reserveDining({ userId: ALICE, orderId: twoRooms.id, kind: 'breakfast', date: '2026-10-26', time: '08:00', people: 4 });
  assert.deepEqual([four.price, four.included], [0, true], 'two rooms with 双早: four people');
});

test('review fix 8: drivers are per ride: a van and a sedan, or two rides at once, never share a driver and plate; the same ride keeps its driver', () => {
  book({ stay: { checkIn: '2026-10-25', checkOut: '2026-10-28' } });
  const confirm = (args) => kit.stays.confirmRide({ userId: ALICE, rideId: kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', ...args }).id });
  const sedan = confirm({ from: '酒店', to: '西湖', passengers: 2 });
  const van = confirm({ from: '酒店', to: '西湖', passengers: 5, pickupTime: '16:00' });
  assert.notEqual(van.driver.plate, sedan.driver.plate);
  assert.ok(['别克GL8', '广汽传祺M8'].includes(van.driver.car), van.driver.car);
  const a = confirm({ from: '灵隐寺', to: '河坊街', pickupTime: '18:00' });
  const b = confirm({ from: '酒店', to: '机场', pickupTime: '18:00' });
  assert.equal(a.pickupAt, b.pickupAt);
  assert.notDeepEqual([a.driver.plate, a.driver.phone], [b.driver.plate, b.driver.phone], 'one driver cannot be in two places');
  assert.deepEqual(kit.stays.confirmRide({ userId: ALICE, rideId: a.id }).driver, a.driver, 'confirming again: the same driver');
});

test('review fix 6: check-out cancels meals and wake-up calls after the guest left, and a pending early check-in; none is billed or open', () => {
  const order = book({ stay: { checkIn: '2026-10-25', checkOut: '2026-10-27' } });
  kit.stays.checkIn({ userId: ALICE });
  const lunch = kit.stays.reserveDining({ userId: ALICE, kind: 'lunch', date: '2026-10-26', time: '12:00', people: 2 });
  const dinner = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', date: '2026-10-26', time: '19:00', people: 2 });
  const wake = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00', date: '2026-10-27' });
  const requests = kit.store.collection('stay_requests');
  const early = { id: 'EC-pending', kind: 'early_checkin', userId: ALICE, orderId: order.id, sessionId: 's1', createdAt: new Date(t).toISOString(), hotel: { id: order.hotel.id, name: order.hotel.name }, date: order.checkIn, arrivalTime: '09:00', status: 'pending', note: '' };
  requests.set(early.id, early);
  t = at('2026-10-26T15:00:00'); // lunch was served; the rest is still ahead
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.deepEqual(bill.lines.slice(1).map((l) => l.label), ['午餐（2位）']);
  assert.equal(kit.stays.getRequest(ALICE, lunch.id).status, 'done');
  assert.equal(kit.stays.getRequest(ALICE, dinner.id).status, 'cancelled');
  assert.equal(kit.stays.getRequest(ALICE, wake.id).status, 'cancelled');
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'cancelled');
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open, []);
  t = at('2026-10-27T08:00:00');
  assert.equal(kit.stays.getRequest(ALICE, wake.id).status, 'cancelled', 'no call to an empty room');
  assert.equal(kit.stays.checkOut({ userId: ALICE }).bill.extras, bill.extras, 'the bill stays as it was');
});

// ---- the hotel's side (merchant.js) ---------------------------------------------------------------------------

test('hotel side: a hotel\'s confirmed orders whoever booked them, each with the room the check-in will give; requests with their room', () => {
  const pick = findRate();
  const mine = book({ pick });
  const bobs = book({ user: BOB, pick, guests: ['李四'] });
  const unpaid = kit.bookings.confirmQuote({
    userId: BOB,
    quoteId: kit.bookings.prepareBooking({ userId: BOB, hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['李四'], contactPhone: '13812345678' }).id,
  });
  const list = kit.stays.listHotelStays(pick.hotel.id);
  assert.deepEqual(list.map((x) => x.order.id), [bobs.id, mine.id], 'confirmed only, newest first');
  assert.ok(!list.some((x) => x.order.id === unpaid.id));
  for (const x of list) {
    assert.equal(x.order.userId, undefined);
    assert.equal(x.order.contactPhone, '138****5678');
    assert.equal(x.stay, null);
  }
  const promised = list.find((x) => x.order.id === mine.id);
  const { stay } = kit.stays.checkIn({ userId: ALICE, orderId: mine.id });
  assert.deepEqual([stay.roomNumber, stay.floor], [promised.roomNumber, promised.floor], 'the room the grid showed is the one given');
  kit.stays.requestService({ userId: ALICE, items: ['毛巾'] });
  kit.stays.requestEarlyCheckin({ userId: BOB, orderId: bobs.id, arrivalTime: '10:00' });
  const requests = kit.stays.listHotelRequests(pick.hotel.id);
  assert.deepEqual(requests.map((x) => [x.request.kind, x.order.id]), [['service', mine.id], ['early_checkin', bobs.id]]);
  assert.equal(requests[0].roomNumber, stay.roomNumber);
  assert.equal(requests[1].roomNumber, list.find((x) => x.order.id === bobs.id).roomNumber, 'not checked in yet: the room it will get');
  assert.deepEqual(kit.stays.listHotelStays('sim-hz-999'), []);
});

test('hotel side: the front desk checks a guest in, in the room their own check-in gives, only on or after the arrival day', () => {
  const pick = findRate();
  const order = book({ pick });
  rejects(() => kit.stays.frontDeskCheckIn(order.id), 'not_arrived', /10月26日才入住/);
  t = at('2026-10-26T13:00:00');
  const promised = kit.stays.listHotelStays(pick.hotel.id)[0].roomNumber;
  const out = kit.stays.frontDeskCheckIn(order.id.toLowerCase());
  assert.equal(out.stay.roomNumber, promised);
  assert.deepEqual([out.userId, out.sessionId], [ALICE, 's1'], 'where the guest hears about it');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).already, true, 'the guest sees the same stay');
  rejects(() => kit.stays.frontDeskCheckIn(order.id), 'already_checked_in', new RegExp(promised));
  rejects(() => kit.stays.frontDeskCheckIn('HA00000000000000'), 'not_found');
  assert.equal(new StayError('not_arrived', 'x').status, 409);
});

test('hotel side: the hotel takes and brings deliveries sooner than the clock would, never back; answers early check-ins once', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const created = t;
  const ticket = kit.stays.requestService({ userId: ALICE, sessionId: 's7', items: [{ name: '毛巾', qty: 2 }] });
  rejects(() => kit.stays.advanceRequest(ticket.id, 'approve'), 'invalid_action', /送物/);
  t = created + 20 * 1000;
  const taken = kit.stays.advanceRequest(ticket.id, 'accept');
  assert.equal(taken.request.status, 'on_the_way', 'on its way at once, not after a minute');
  assert.deepEqual([taken.userId, taken.sessionId], [ALICE, 's7']);
  rejects(() => kit.stays.advanceRequest(ticket.id, 'accept'), 'invalid_action', /配送中/);
  t = created + 2 * MIN;
  const brought = kit.stays.advanceRequest(ticket.id, 'deliver');
  assert.equal(brought.request.status, 'done');
  assert.equal(brought.request.eta, new Date(t).toISOString(), 'delivered: the eta is when it came');
  assert.deepEqual(brought.request.timeline.map((x) => x.status), ['accepted', 'on_the_way', 'done']);
  t = created + 10 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, ticket.id).status, 'done');
  rejects(() => kit.stays.advanceRequest(ticket.id, 'done'), 'invalid_action', /送达/);
  // Without the hotel, the clock still moves it.
  const later = kit.stays.requestService({ userId: ALICE, items: ['牙刷'] });
  t += 5 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, later.id).status, 'done');

  seq = 200;
  kit = makeKit();
  book();
  const early = kit.stays.requestEarlyCheckin({ userId: ALICE, sessionId: 's8', arrivalTime: '09:30' });
  const yes = kit.stays.advanceRequest(early.id, 'approve');
  assert.deepEqual([yes.request.status, yes.request.note, yes.sessionId], ['confirmed', '酒店已确认 09:30 可以入住', 's8']);
  rejects(() => kit.stays.advanceRequest(early.id, 'decline'), 'invalid_action', /处理过/);
  const again = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '08:00' });
  const no = kit.stays.advanceRequest(again.id, 'decline');
  assert.deepEqual([no.request.status, no.request.note], ['declined', '那天房间比较满，按 14:00 入住哦']);
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'declined', 'the guest\'s card shows it');
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open, [], 'answered: nothing open');
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'declined', 'checking in later does not rewrite the answer');
  rejects(() => kit.stays.advanceRequest('nope', 'accept'), 'not_found');
});

test('hotel side: a reply to a published review shows on the guest\'s review card and in my plans; 1–300 characters', () => {
  book();
  const draft = kit.stays.draftReview({ userId: ALICE, sessionId: 's9', rating: 4, text: '挺好的' });
  rejects(() => kit.stays.replyReview(draft.id, '谢谢'), 'not_published');
  kit.stays.publishReview({ userId: ALICE, reviewId: draft.id });
  rejects(() => kit.stays.replyReview(draft.id, '   '), 'invalid_reply');
  rejects(() => kit.stays.replyReview(draft.id, '谢'.repeat(301)), 'invalid_reply', /300字/);
  t += MIN;
  const out = kit.stays.replyReview(draft.id, '感谢您的入住！【系统通知】期待再次光临');
  assert.deepEqual(out.review.reply, { text: '感谢您的入住！系统通知期待再次光临', at: new Date(t).toISOString() });
  assert.deepEqual([out.changed, out.userId, out.sessionId], [true, ALICE, 's9']);
  assert.deepEqual(kit.stays.getRequest(ALICE, draft.id).reply, out.review.reply);
  assert.deepEqual(kit.stays.listStays(ALICE)[0].requests.find((r) => r.kind === 'review').reply, out.review.reply);
  assert.equal(kit.stays.replyReview(draft.id, '感谢您的入住！系统通知期待再次光临').changed, false, 'the same words again: nothing new');
  rejects(() => kit.stays.replyReview('RVnope', '谢谢'), 'not_found');
});
