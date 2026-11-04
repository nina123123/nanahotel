import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStore } from '../src/store/json-store.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService } from '../src/services/hotels/index.js';
import {
  createBookingService, BookingError, maskPhone, normalizePhone, normalizeEmail, formatPhone, normalizeMethod, toPublicQuote, toPublicOrder,
  ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS, PHONE_MESSAGE, NAME_MESSAGE, EMAIL_MESSAGE,
} from '../src/services/bookings.js';
import { addDays } from '../src/util/dates.js';

const MIN = 60 * 1000;
const START = Date.parse('2026-11-04T10:00:00-05:00'); // Wed, Nov 4, 10 AM in New York
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
    orderNo: () => `HA20261104${String(++seq).padStart(6, '0')}`,
    confirmationNo: () => '88886666',
    transactionId: (m) => `SIM${m === 'apple_pay' ? 'APAY' : 'CARD'}TEST${seq}`,
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
function findBookable(planSuffix, { city = 'New York', category, rooms = 1, adults = 2, children = 0, stay = STAY, minOccupancy = 0 } = {}) {
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
  const pick = overrides.pick || findBookable('BB-FC');
  return bookings.prepareBooking({
    userId: ALICE,
    sessionId: 's1',
    hotelId: pick.hotel.id,
    rateId: pick.rate.rateId,
    ...STAY,
    rooms: 1,
    adults: 2,
    guests: ['Sarah Miller'],
    email: 'sarah@example.com',
    contactPhone: '(415) 555-0123',
    arrivalTime: 'around 6 PM',
    specialRequests: 'High floor, quiet room',
    ...overrides,
  });
}

function bookAndPay(pick, overrides = {}) {
  const quote = prepare({ pick, ...overrides });
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: quote.id });
  return bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `${err.name}: ${err.message}`);
    assert.doesNotMatch(err.message, /[㐀-鿿]/, 'the message is English');
    assert.match(err.message, /^["A-Z0-9]/, err.message);
    return err.code;
  }
  return 'ok';
}

test('US phone numbers: normalized to E.164, masked as ***-***-0123', () => {
  for (const typed of ['(415) 555-0123', '415-555-0123', '415.555.0123', '+1 415 555 0123', '1-415-555-0123', '4155550123', '１ (４１５) ５５５－０１２３', '（４１５）５５５－０１２３', '415‐555‐0123']) {
    assert.equal(normalizePhone(typed), '+14155550123', typed);
  }
  // Not a US number: too short, too long, another country, an area code or exchange starting with 0 or 1, letters.
  for (const bad of ['555-0123', '41555501234', '+44 20 7946 0958', '(015) 555-0123', '(415) 155-0123', '415-555-01ab', '', null, undefined]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
  assert.equal(maskPhone('+14155550123'), '***-***-0123');
  assert.equal(maskPhone('(415) 555-0123'), '***-***-0123');
  assert.equal(maskPhone('***-***-0123'), '***-***-0123', 'masking twice changes nothing');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone(null), '');
  assert.equal(maskPhone('12345'), '****');
  assert.equal(formatPhone('+14155550123'), '(415) 555-0123');
  assert.equal(PHONE_MESSAGE, 'Please enter a 10-digit US phone number');
});

test('emails are checked and their domain lower-cased', () => {
  assert.equal(normalizeEmail('  Sarah.Miller+trip@Example.COM '), 'Sarah.Miller+trip@example.com');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
  for (const bad of ['sarah', 'sarah@', '@example.com', 'sarah@example', 'sarah miller@example.com', 'sarah@exa_mple.com', '<a@b.com>', '', null]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  assert.equal(normalizeEmail(`${'x'.repeat(250)}@example.com`), null, 'at most 254 characters');
  assert.equal(EMAIL_MESSAGE, "That email doesn't look right");
});

test('payment methods: card or Apple Pay', () => {
  assert.deepEqual(PAYMENT_METHOD_LABELS, { card: 'Credit or debit card', apple_pay: 'Apple Pay' });
  for (const m of ['card', 'Credit card', 'debit card', 'Visa', 'Mastercard', 'AMEX']) assert.equal(normalizeMethod(m), 'card', m);
  for (const m of ['apple_pay', 'Apple Pay', 'applepay']) assert.equal(normalizeMethod(m), 'apple_pay', m);
  for (const m of ['paypal', 'wechat', 'alipay', 'cash', '']) assert.equal(normalizeMethod(m), null, m);
});

test('prepareBooking stores a pending quote that expires in 15 minutes', () => {
  const pick = findBookable('BB-FC');
  const q = prepare({ pick });
  assert.equal(q.id, 'Q0001');
  assert.equal(q.status, 'pending');
  assert.equal(q.userId, ALICE);
  assert.equal(q.sessionId, 's1');
  assert.deepEqual(q.hotel, {
    id: pick.hotel.id, name: pick.hotel.name, address: pick.hotel.address, tel: pick.hotel.tel, city: 'New York', state: 'NY',
    district: pick.hotel.district, timeZone: 'America/New_York',
  });
  assert.deepEqual(q.room, { roomId: pick.roomType.roomId, name: pick.roomType.name, bed: pick.roomType.bed });
  assert.equal(q.rate.rateId, pick.rate.rateId);
  assert.equal(q.rate.cancelPolicy.type, 'free');
  assert.equal(q.nights, 2);
  assert.deepEqual(q.nightly, pick.rate.nightly);
  assert.equal(q.totalPrice, pick.rate.totalPrice);
  assert.equal(q.taxesAndFees, pick.rate.taxesAndFees);
  assert.equal(q.currency, 'USD');
  assert.equal(q.contactPhone, '+14155550123');
  assert.deepEqual(q.guests, ['Sarah Miller']);
  assert.deepEqual(q.holder, { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' }, 'the first guest books, with the email given');
  assert.equal(q.arrivalTime, 'around 6 PM');
  assert.equal(q.specialRequests, 'High floor, quiet room');
  assert.equal(q.orderId, null);
  assert.equal(Date.parse(q.expiresAt) - Date.parse(q.createdAt), 15 * MIN);
  assert.deepEqual(store.collection('quotes').get(q.id), q);
});

test('the holder is the saved traveler when given, else the first guest', () => {
  const pick = findBookable('BB-FC');
  const saved = prepare({ pick, guests: ['David Chen'], holder: { firstName: 'Sarah', lastName: 'Miller', email: 'Sarah@Example.com' }, email: undefined });
  assert.deepEqual(saved.holder, { firstName: 'Sarah', lastName: 'Miller', email: 'Sarah@example.com' });
  assert.deepEqual(saved.guests, ['David Chen']);
  const firstGuest = prepare({ pick, guests: ['Mary Ann van der Berg'], email: 'mary@example.org' });
  assert.deepEqual(firstGuest.holder, { firstName: 'Mary', lastName: 'Ann van der Berg', email: 'mary@example.org' });
  assert.equal(codeOf(() => prepare({ pick, email: '' })), 'missing_email');
  assert.equal(codeOf(() => prepare({ pick, email: 'sarah@' })), 'invalid_email');
  assert.equal(codeOf(() => prepare({ pick, holder: { firstName: 'Sarah', lastName: '', email: 'sarah@example.com' } })), 'invalid_name');
  assert.equal(codeOf(() => prepare({ pick, holder: { firstName: 'Mr', lastName: 'Miller', email: 'sarah@example.com' } })), 'invalid_name');
  assert.throws(() => prepare({ pick, holder: { firstName: 'Sarah', lastName: '' } }), (e) => e.message === NAME_MESSAGE);
});

test('public serializers drop userId and mask the phone', () => {
  const q = prepare();
  const pub = toPublicQuote(q);
  assert.equal(pub.userId, undefined);
  assert.equal(pub.contactPhone, '***-***-0123');
  assert.equal(pub.id, q.id);
  assert.equal(q.contactPhone, '+14155550123', 'original untouched');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  const po = toPublicOrder(order);
  assert.equal(po.userId, undefined);
  assert.equal(po.contactPhone, '***-***-0123');
  assert.equal(toPublicQuote(null), null);
  assert.equal(toPublicOrder(undefined), null);
  assert.ok(!JSON.stringify(po).includes('4155550123') && !JSON.stringify(po).includes('555-0123'));
  assert.deepEqual(toPublicQuote(pub), pub, 'serializing twice is harmless');
});

test('prepareBooking validation errors', () => {
  const pick = findBookable('BB-FC');
  const cases = [
    [{ contactPhone: '555-0123' }, 'invalid_phone'],
    [{ contactPhone: '' }, 'invalid_phone'],
    [{ contactPhone: '+44 20 7946 0958' }, 'invalid_phone'],
    [{ contactPhone: '(015) 555-0123' }, 'invalid_phone'],
    [{ guests: [] }, 'missing_guest'],
    [{ guests: ['Sarah'] }, 'invalid_guest_name'],
    [{ guests: ['Sarah <script>'] }, 'invalid_guest_name'],
    [{ guests: ['x'.repeat(61)] }, 'invalid_guest_name'],
    [{ rooms: 2, adults: 2, guests: ['Sarah Miller'] }, 'need_more_guests'],
    [{ rooms: 6 }, 'invalid_rooms'],
    [{ rooms: 0 }, 'invalid_rooms'],
    [{ adults: 0 }, 'invalid_guests'],
    [{ adults: 5, rooms: 1 }, 'too_many_guests'],
    [{ checkIn: '2026-11-03', checkOut: '2026-11-05' }, 'invalid_dates'],
    [{ checkIn: '2026-11-10', checkOut: '2026-12-11' }, 'invalid_dates'],
    [{ checkIn: '2027-11-10', checkOut: '2027-11-11' }, 'invalid_dates'],
    [{ checkOut: undefined }, 'invalid_dates'],
    [{ hotelId: '' }, 'invalid_request'],
    [{ rateId: '' }, 'invalid_request'],
    [{ hotelId: 'sim-nyc-999' }, 'hotel_not_found'],
    [{ rateId: 'R9-NOPE' }, 'rate_not_found'],
    [{ userId: '' }, 'unauthorized'],
    // every room needs an adult; the named guests must fit the stated party and the room
    [{ rooms: 3, adults: 1, guests: ['Sarah Miller', 'David Chen', 'Maria Lopez'] }, 'invalid_guests'],
    [{ adults: undefined, guests: ['Sarah Miller', 'David Chen', 'Maria Lopez'] }, 'too_many_guests'],
    [{ adults: 2, guests: ['Sarah Miller', 'David Chen', 'Maria Lopez', 'James Brown', 'Emma Davis', 'Noah Wilson'] }, 'guest_count_mismatch'],
    [{ adults: 2, children: 1, guests: ['Sarah Miller', 'David Chen', 'Lily Chen'] }, 'too_many_guests'],
    [{ children: 7 }, 'invalid_guests'],
    [{ children: -1 }, 'invalid_guests'],
    // titles and stand-ins are not names the front desk can match to an ID
    [{ guests: ['Mr. Smith'] }, 'invalid_guest_name'],
    [{ guests: ['Guest'] }, 'invalid_guest_name'],
    [{ guests: ['my wife'] }, 'invalid_guest_name'],
    [{ guests: ['test'] }, 'invalid_guest_name'],
    [{ email: 'not an email' }, 'invalid_email'],
  ];
  for (const [o, code] of cases) assert.equal(codeOf(() => prepare({ pick, ...o })), code, JSON.stringify(o));
  assert.throws(() => prepare({ pick, contactPhone: '555-0123' }), (e) => e.message === PHONE_MESSAGE);
  assert.throws(() => prepare({ pick, guests: ['Sarah'] }), (e) => e.message === '"Sarah" needs a last name too: each guest needs a first and last name');
  assert.throws(() => prepare({ pick, guests: ['Mr. Smith'] }), (e) => /as on their ID/.test(e.message));
  // one name per room is enough; "Sarah Miller and David Chen" is two names
  const pick2 = findBookable('BB-FC', { rooms: 2, adults: 3 });
  const two = prepare({ pick: pick2, rooms: 2, adults: 3, guests: 'Sarah Miller and David Chen' });
  assert.deepEqual(two.guests, ['Sarah Miller', 'David Chen']);
  assert.equal(two.totalPrice, pick2.rate.totalPrice);
  assert.equal(two.totalPrice, two.nightly.reduce((s, n) => s + n.price, 0) * 2);
  assert.deepEqual(prepare({ pick, guests: 'Sarah Miller, David Chen' }).guests, ['Sarah Miller', 'David Chen']);
  for (const name of ["Liam O'Brien", 'José García', 'Nguyễn Văn An']) assert.equal(prepare({ pick, guests: [name] }).guests[0], name);
  // adults omitted: every named guest counts, defaults stay at 2 for one name
  assert.equal(prepare({ pick, adults: undefined, guests: ['Sarah Miller'] }).adults, 2);
  assert.equal(prepare({ pick: pick2, rooms: 2, adults: 4, guests: ['Sarah Miller', 'David Chen'] }).adults, 4);
  assert.equal(prepare({ pick, contactPhone: '+1 212 555 0199' }).contactPhone, '+12125550199');
});

test('children: occupy a bed, price unchanged, carried on quote and order', () => {
  const pick = findBookable('RO-NR', { category: 'upscale', adults: 2, children: 1, minOccupancy: 3 });
  assert.equal(pick.roomType.maxOccupancy, 4);
  const q = prepare({ pick, adults: 2, children: 1, guests: ['Sarah Miller', 'David Chen'] });
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

test('terms_changed: the free-cancel deadline (3 PM hotel time) passing between quote and confirm/pay is caught', () => {
  const stay = { checkIn: '2026-11-05', checkOut: '2026-11-06' }; // free cancellation until Nov 4, 3:00 PM EST
  setTime('2026-11-04T14:52:00-05:00');
  const pick = findBookable('BB-FC', { stay });
  const q = prepare({ pick, ...stay });
  assert.equal(q.rate.name, 'Breakfast included · Free cancellation');
  assert.equal(q.rate.cancelPolicy.freeUntil, '2026-11-04T15:00:00-05:00');
  setTime('2026-11-04T15:01:00-05:00');
  assert.throws(() => bookings.confirmQuote({ userId: ALICE, quoteId: q.id }), (e) => {
    assert.equal(e.code, 'terms_changed');
    assert.equal(e.status, 409);
    assert.equal(e.message, 'The free cancellation deadline has passed since this quote, so the terms changed; please get a new quote');
    return true;
  });
  assert.deepEqual([bookings.getQuote(ALICE, q.id).status, bookings.getQuote(ALICE, q.id).orderId], ['pending', null]);
  assert.deepEqual(bookings.listOrders(ALICE), []);

  // confirmed in time, but the 15-minute pay window crosses the deadline
  setTime('2026-11-04T14:50:00-05:00');
  const q2 = prepare({ pick, ...stay, sessionId: 's2' });
  setTime('2026-11-04T14:59:00-05:00');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q2.id });
  setTime('2026-11-04T15:05:00-05:00');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' })), 'terms_changed');
  assert.notEqual(bookings.getOrder(ALICE, order.id).status, 'confirmed');

  // quoted after the deadline: the terms shown already say a fee applies, so nothing changed
  setTime('2026-11-04T15:01:00-05:00');
  const q3 = prepare({ pick, ...stay, sessionId: 's3' });
  assert.equal(q3.rate.name, 'Breakfast included · Cancellation fee applies');
  setTime('2026-11-04T15:05:00-05:00');
  const o3 = bookings.confirmQuote({ userId: ALICE, quoteId: q3.id });
  assert.equal(o3.rate.name, 'Breakfast included · Cancellation fee applies');
  assert.equal(bookings.payOrder({ userId: ALICE, orderId: o3.id, method: 'card' }).status, 'confirmed');

  // non-refundable rates have no deadline to cross
  setTime('2026-11-04T14:55:00-05:00');
  const nr = prepare({ pick: findBookable('RO-NR', { stay }), ...stay, sessionId: 's4' });
  setTime('2026-11-04T15:02:00-05:00');
  const o4 = bookings.confirmQuote({ userId: ALICE, quoteId: nr.id });
  assert.equal(bookings.payOrder({ userId: ALICE, orderId: o4.id, method: 'apple_pay' }).status, 'confirmed');
});

test('after midnight (before 6 AM hotel time) the night in progress can be booked, paid and is cancellable by its rules', () => {
  const stay = { checkIn: '2026-11-04', checkOut: '2026-11-05' };
  setTime('2026-11-05T01:30:00-05:00');
  const pick = findBookable('RO-NR', { stay });
  const q = prepare({ pick, ...stay, arrivalTime: '2:00 AM' });
  assert.equal(q.status, 'pending');
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  const paid = bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' });
  assert.equal(paid.status, 'confirmed');
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([p.cancellable, p.penalty], [true, paid.totalPrice], 'not "the stay has ended" while the night is in progress');

  setTime('2026-11-05T06:30:00-05:00');
  assert.equal(codeOf(() => prepare({ pick, ...stay, sessionId: 's2' })), 'invalid_dates');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).cancellable, false);

  // a quote for the night in progress that is confirmed / paid after 6 AM is rejected as invalid_dates
  setTime('2026-11-05T05:50:00-05:00');
  const late = prepare({ pick, ...stay, sessionId: 's3' });
  setTime('2026-11-05T06:01:00-05:00');
  assert.equal(codeOf(() => bookings.confirmQuote({ userId: ALICE, quoteId: late.id })), 'invalid_dates');
  setTime('2026-11-05T05:40:00-05:00');
  const late2 = prepare({ pick, ...stay, sessionId: 's4' });
  setTime('2026-11-05T05:50:00-05:00');
  const o2 = bookings.confirmQuote({ userId: ALICE, quoteId: late2.id });
  setTime('2026-11-05T06:01:00-05:00');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: o2.id, method: 'card' })), 'invalid_dates');
});

test('dates are checked in the hotel\'s zone: at 7:30 AM in New York a Los Angeles night in progress is still bookable', () => {
  const stay = { checkIn: '2026-11-04', checkOut: '2026-11-05' };
  setTime('2026-11-05T07:30:00-05:00'); // 4:30 AM in Los Angeles
  const laPick = findBookable('RO-NR', { city: 'Los Angeles', stay });
  const q = prepare({ pick: laPick, ...stay });
  assert.equal(q.hotel.timeZone, 'America/Los_Angeles');
  assert.equal(bookings.confirmQuote({ userId: ALICE, quoteId: q.id }).status, 'pending_payment');
  // In New York that night ended at 6 AM.
  setTime('2026-11-05T07:30:00-05:00');
  const nyPick = findBookable('RO-NR', { stay: { checkIn: '2026-11-05', checkOut: '2026-11-06' } });
  assert.equal(codeOf(() => prepare({ pick: nyPick, ...stay, sessionId: 's2' })), 'invalid_dates');
  // A Los Angeles hotel's free-cancel deadline is 3 PM Pacific.
  setTime('2026-11-04T10:00:00-05:00');
  const laFree = findBookable('BB-FC', { city: 'Los Angeles' });
  const order = bookAndPay(laFree, { sessionId: 's3' });
  assert.equal(order.rate.cancelPolicy.freeUntil, '2026-11-09T15:00:00-08:00');
  assert.match(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).policyText, /^Free cancellation until Mon, Nov 9, 3:00 PM PST: cancelling now refunds the full \$/);
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
  assert.equal(ORDER_STATUS_LABELS[order.status], 'Awaiting payment');
  assert.equal(order.quoteId, q.id);
  assert.equal(order.userId, ALICE);
  assert.equal(order.sessionId, 's1');
  assert.equal(order.totalPrice, q.totalPrice);
  assert.equal(order.taxesAndFees, q.taxesAndFees);
  assert.equal(order.currency, 'USD');
  assert.deepEqual(order.holder, q.holder);
  assert.deepEqual(order.hotel, q.hotel);
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
  const pick = findBookable('BB-FC');
  let mode = 'same';
  const wrapped = {
    ...hotels,
    priceCheck(args) {
      const res = hotels.priceCheck(args);
      if (mode === 'pricier') return { ...res, rate: { ...res.rate, totalPrice: res.rate.totalPrice + 100 } };
      if (mode === 'gone') throw new BookingError('sold_out', 'Sold out');
      return res;
    },
  };
  const svc = createBookingService({ store, hotels: wrapped, clock, ids: fakeIds() });
  const base = { userId: ALICE, sessionId: 's9', hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['Sarah Miller'], email: 'sarah@example.com', contactPhone: '4155550123' };
  const q1 = svc.prepareBooking(base);
  mode = 'pricier';
  assert.throws(() => svc.confirmQuote({ userId: ALICE, quoteId: q1.id }), (e) => {
    assert.equal(e.code, 'price_changed');
    assert.deepEqual(e.details, { oldPrice: q1.totalPrice, newPrice: q1.totalPrice + 100 });
    assert.match(e.message, /^The price changed: it was \$[\d,]+ and is now \$[\d,]+; please confirm again$/);
    return true;
  });
  mode = 'same';
  const q2 = svc.prepareBooking(base);
  mode = 'gone';
  assert.equal(codeOf(() => svc.confirmQuote({ userId: ALICE, quoteId: q2.id })), 'sold_out');
});

test('payOrder confirms with a simulated card or Apple Pay payment and is idempotent', () => {
  const q = prepare();
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'paypal' })), 'invalid_payment_method');
  assert.equal(codeOf(() => bookings.payOrder({ userId: BOB, orderId: order.id, method: 'card' })), 'not_found');
  advance(5 * MIN);
  const paid = bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'Apple Pay' });
  assert.equal(paid.status, 'confirmed');
  assert.equal(ORDER_STATUS_LABELS[paid.status], 'Confirmed');
  assert.equal(paid.payment.method, 'apple_pay');
  assert.equal(paid.payment.amount, order.totalPrice);
  assert.equal(paid.payment.paidAt, new Date(t).toISOString());
  assert.match(paid.payment.transactionId, /^SIMAPAY/);
  assert.equal(paid.confirmationNo, '88886666');
  advance(MIN);
  assert.deepEqual(bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' }), paid);
  const card = bookAndPay(findBookable('BB-FC'), { sessionId: 's2' });
  assert.equal(card.payment.method, 'card');
  assert.match(card.payment.transactionId, /^SIMCARD/);
});

test('unpaid orders close lazily after 15 minutes', () => {
  const q = prepare();
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: q.id });
  advance(15 * MIN + 1);
  assert.equal(bookings.getOrder(ALICE, order.id).status, 'closed');
  assert.equal(bookings.listOrders(ALICE)[0].status, 'closed');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' })), 'order_closed');
  const preview = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(preview.cancellable, false);
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: ALICE, orderId: order.id })), 'not_cancellable');
  assert.equal(bookings.confirmQuote({ userId: ALICE, quoteId: q.id }).status, 'closed', 'confirm stays idempotent');
});

test('cancelling an unpaid order costs nothing', () => {
  const order = bookings.confirmQuote({ userId: ALICE, quoteId: prepare().id });
  const preview = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([preview.cancellable, preview.penalty, preview.refund], [true, 0, 0]);
  assert.equal(preview.policyText, "This order hasn't been paid, so cancelling costs nothing");
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id, reason: 'Plans changed' });
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(c.cancellation, { cancelledAt: new Date(t).toISOString(), penalty: 0, refund: 0, reason: 'Plans changed' });
  assert.deepEqual(bookings.cancelOrder({ userId: ALICE, orderId: order.id }), c, 'cancel is idempotent');
  assert.equal(codeOf(() => bookings.payOrder({ userId: ALICE, orderId: order.id, method: 'card' })), 'order_cancelled');
});

test('free-cancel policy: free before 3 PM hotel time the day before, first night after', () => {
  const order = bookAndPay(findBookable('BB-FC'));
  assert.equal(order.rate.cancelPolicy.freeUntil, '2026-11-09T15:00:00-05:00');
  const early = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([early.cancellable, early.penalty, early.refund], [true, 0, order.totalPrice]);
  assert.match(early.policyText, /^Free cancellation until Mon, Nov 9, 3:00 PM EST: cancelling now refunds the full \$[\d,]+$/);

  setTime('2026-11-09T14:59:00-05:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).penalty, 0);
  setTime('2026-11-09T15:00:00-05:00');
  const late = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  const firstNight = order.nightly[0].price * order.rooms;
  assert.deepEqual([late.cancellable, late.penalty, late.refund], [true, firstNight, order.totalPrice - firstNight]);
  assert.match(late.policyText, /deadline \(Mon, Nov 9, 3:00 PM EST\) has passed: cancelling now costs the first night/);
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id, reason: 'New dates' });
  assert.equal(c.cancellation.penalty, firstNight);
  assert.equal(c.cancellation.refund, order.totalPrice - firstNight);
});

test('limited policy (luxury, cancel by 3 days before): free until then, then the first night', () => {
  const pick = findBookable('BB-LC', { category: 'luxury', rooms: 2, adults: 4 });
  const order = bookAndPay(pick, { rooms: 2, adults: 4, guests: ['Sarah Miller', 'David Chen'] });
  assert.equal(order.rate.cancelPolicy.type, 'limited');
  assert.equal(order.rate.cancelPolicy.freeUntil, '2026-11-07T15:00:00-05:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).penalty, 0);
  setTime('2026-11-08T09:00:00-05:00');
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(p.penalty, order.nightly[0].price * 2, 'first night for both rooms');
  assert.equal(p.refund, order.totalPrice - p.penalty);
});

test('non-refundable policy: still cancellable, penalty = total, refund 0', () => {
  const order = bookAndPay(findBookable('RO-NR'));
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([p.cancellable, p.penalty, p.refund], [true, order.totalPrice, 0]);
  assert.match(p.policyText, /^This rate is non-refundable: cancelling now forfeits the full \$[\d,]+, with no refund$/);
  const c = bookings.cancelOrder({ userId: ALICE, orderId: order.id });
  assert.deepEqual([c.status, c.cancellation.penalty, c.cancellation.refund], ['cancelled', order.totalPrice, 0]);
});

test('after the check-in date has passed an order can no longer be cancelled online', () => {
  const order = bookAndPay(findBookable('BB-FC'));
  setTime('2026-11-10T21:00:00-05:00');
  assert.equal(bookings.previewCancellation({ userId: ALICE, orderId: order.id }).cancellable, true, 'check-in day itself is still ok');
  setTime(`${addDays(STAY.checkIn, 1)}T09:00:00-05:00`);
  const p = bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.equal(p.cancellable, false);
  assert.match(p.policyText, /check-in date has passed/);
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: ALICE, orderId: order.id })), 'not_cancellable');
});

test('listOrders: newest first, own orders only; getOrder ownership', () => {
  const o1 = bookings.confirmQuote({ userId: ALICE, quoteId: prepare({ sessionId: 'a' }).id });
  advance(MIN);
  const o2 = bookings.confirmQuote({ userId: ALICE, quoteId: prepare({ sessionId: 'b' }).id });
  advance(MIN);
  const bobQuote = prepare({ userId: BOB, sessionId: 'c', guests: ['Bob Jones'], email: 'bob@example.com', contactPhone: '(312) 555-0188' });
  const o3 = bookings.confirmQuote({ userId: BOB, quoteId: bobQuote.id });
  assert.deepEqual(bookings.listOrders(ALICE).map((o) => o.id), [o2.id, o1.id]);
  assert.deepEqual(bookings.listOrders(BOB).map((o) => o.id), [o3.id]);
  assert.equal(bookings.getOrder(BOB, o1.id), null);
  assert.equal(bookings.getOrder(ALICE, o1.id).id, o1.id);
  assert.equal(bookings.getOrder('', o1.id), null);
  assert.equal(codeOf(() => bookings.previewCancellation({ userId: BOB, orderId: o1.id })), 'not_found');
  assert.equal(codeOf(() => bookings.cancelOrder({ userId: BOB, orderId: o1.id })), 'not_found');
  assert.equal(codeOf(() => bookings.listOrders('')), 'unauthorized');
  assert.deepEqual(bookings.ordersForHotel(o1.hotel.id).map((o) => o.id).sort(), [o1, o2, o3].filter((o) => o.hotel.id === o1.hotel.id).map((o) => o.id).sort());
});

test('full lifecycle survives a store reload (plain JSON values)', () => {
  const order = bookAndPay(findBookable('BB-FC'));
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
  const pick = findBookable('BB-FC');
  const q = svc.prepareBooking({ userId: ALICE, hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['Sarah Miller'], email: 'sarah@example.com', contactPhone: '(415) 555-0123' });
  assert.match(q.id, /^Q[0-9a-f]{16}$/);
  assert.equal(q.sessionId, null);
  assert.equal(q.adults, 2);
  const o = svc.confirmQuote({ userId: ALICE, quoteId: q.id });
  assert.match(o.id, /^HA20261104\d{6}$/);
  const paid = svc.payOrder({ userId: ALICE, orderId: o.id, method: 'card' });
  assert.match(paid.confirmationNo, /^\d{8}$/);
  assert.match(paid.payment.transactionId, /^SIMCARD20261104\d{10}$/);
});
