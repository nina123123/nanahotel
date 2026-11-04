import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStore } from '../src/store/json-store.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService } from '../src/services/hotels/index.js';
import { BRAND_STEMS } from '../src/services/hotels/sim-hotels.js';
import { createBookingService, BookingError } from '../src/services/bookings.js';
import {
  createStayService, StayError, MEMBER_LEVELS, REWARDS_PROGRAM, MEALS, RIDE_KIND_LABELS, CHECKOUT_TIME, STANDARD_CHECKIN, EARLY_CHECKIN_FROM, BREAKFAST_PRICE,
} from '../src/services/stays.js';

const MIN = 60 * 1000;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const STAY = { checkIn: '2026-11-05', checkOut: '2026-11-07' }; // Thu → Sat
/** A wall-clock time in New York (EST in November). */
const at = (local) => Date.parse(`${local}-05:00`);
/** The same in Los Angeles (PST). */
const atLA = (local) => Date.parse(`${local}-08:00`);
const isoAt = (local) => new Date(at(local)).toISOString();

let t;
let seq;
let kit;

function fakeIds() {
  return {
    newId: (p) => `${p}${String(++seq).padStart(4, '0')}`,
    orderNo: () => `HA20261104${String(++seq).padStart(6, '0')}`,
    confirmationNo: () => '88886666',
    transactionId: (m) => `SIM${m === 'apple_pay' ? 'APAY' : 'CARD'}TEST${seq}`,
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
  t = at('2026-11-04T14:00:00'); // Wed 2 PM in New York
  seq = 0;
  kit = makeKit();
});

/** First hotel (optionally of a category) with an available rate ending in `planSuffix` for the stay. */
function findRate({ category, planSuffix = 'RO-NR', city = 'New York', stay = STAY, rooms = 1, adults = 2, where } = {}) {
  for (const h of kit.supplier.searchHotels({ city })) {
    if (category && h.category !== category) continue;
    if (where && !where(h)) continue;
    const { offer } = kit.hotels.getRoomOffer({ hotelId: h.id, ...stay, rooms, adults });
    for (const rt of offer.roomTypes) {
      const rate = rt.rates.find((r) => r.rateId.endsWith(planSuffix) && r.available);
      if (rate) return { hotel: h, roomType: rt, rate };
    }
  }
  throw new Error(`no ${category || ''} ${planSuffix} in ${city}`);
}

/** A paid order for `user` (default ALICE), booked in session s1. */
function book({ user = ALICE, stay = STAY, pick, guests = ['Sarah Miller'], adults = 2, rooms = 1, method = 'card', email = 'sarah@example.com' } = {}) {
  const p = pick || findRate({ stay });
  const quote = kit.bookings.prepareBooking({
    userId: user, sessionId: 's1', hotelId: p.hotel.id, rateId: p.rate.rateId, ...stay, adults, rooms, guests, email, contactPhone: '(415) 555-0123',
  });
  const order = kit.bookings.confirmQuote({ userId: user, quoteId: quote.id });
  return kit.bookings.payOrder({ userId: user, orderId: order.id, method });
}

function rejects(fn, code, re) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof StayError, `${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    if (re) assert.match(err.message, re);
    assert.doesNotMatch(err.message, /[㐀-鿿]/, 'English');
    return true;
  });
}

test('check-in: a room on the booked room type\'s floors (no 13th), the key until 11 AM check-out, early before the date, idempotent', () => {
  const pick = findRate();
  const order = book({ pick });
  const { stay, already } = kit.stays.checkIn({ userId: ALICE });
  assert.equal(already, false);
  assert.equal(stay.orderId, order.id);
  assert.deepEqual(stay.hotel, { id: pick.hotel.id, name: pick.hotel.name, category: pick.hotel.category });
  assert.equal(stay.roomType, pick.roomType.name);
  const [lo, hi] = pick.roomType.floor.match(/\d+/g).map(Number);
  assert.ok(stay.floor >= lo && stay.floor <= hi, `${stay.floor} not in ${pick.roomType.floor}`);
  assert.notEqual(stay.floor, 13);
  assert.match(stay.roomNumber, new RegExp(`^${stay.floor}\\d{2}$`));
  assert.equal(stay.early, true, 'checked in the day before the booked check-in');
  assert.equal(stay.keyValidUntil, isoAt('2026-11-07T11:00:00'));
  assert.equal(stay.timeZone, 'America/New_York');
  assert.deepEqual(stay.guests, ['Sarah Miller']);
  assert.equal(stay.checkedInAt, new Date(t).toISOString());
  assert.equal(stay.checkoutTime, '11:00');
  assert.equal(CHECKOUT_TIME, '11:00');
  assert.deepEqual(stay.breakfast, { time: '7:00 AM–10:30 AM', place: stay.breakfast.place, price: 18, included: false });
  assert.match(stay.wifi.ssid, /^[A-Z][A-Za-z]+-Guest$/);
  assert.match(stay.wifi.password, /^[a-z]{4}\d{4}$/);

  t += 10 * MIN;
  const again = kit.stays.checkIn({ userId: ALICE, orderId: order.id.toLowerCase() });
  assert.equal(again.already, true);
  assert.equal(again.stay.roomNumber, stay.roomNumber);
  assert.equal(again.stay.checkedInAt, stay.checkedInAt);

  t = at('2026-11-05T15:00:00');
  seq = 0;
  kit = makeKit();
  book({ pick });
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.early, false, 'on the check-in date it is a normal check-in');
});

test('hotel facts are fixed per hotel: Wi-Fi from the brand, breakfast, a 555-01xx front desk, facilities from the amenities', () => {
  for (const category of ['budget', 'midscale', 'upscale', 'luxury']) {
    seq = 0;
    kit = makeKit();
    const pick = findRate({ category });
    book({ pick });
    const info = kit.stays.getStayInfo({ userId: ALICE });
    assert.equal(info.hotel.category, category);
    assert.ok(info.facilities.length >= 1, category);
    for (const f of info.facilities) assert.ok(f.name && f.hours && f.place, JSON.stringify(f));
    if (category === 'upscale' || category === 'luxury') assert.ok(info.facilities.some((f) => f.name === 'Fitness center'), category);
    const pool = pick.hotel.amenities.find((a) => / pool$/i.test(a));
    assert.equal(info.facilities.some((f) => f.name === pool), Boolean(pool), `${category}: a pool only when the hotel has one`);
    assert.equal(info.facilities.some((f) => f.name === 'Spa'), pick.hotel.amenities.includes('Spa'));
    assert.equal(info.breakfast.time, '7:00 AM–10:30 AM');
    assert.match(info.breakfast.place, /^[A-Z][^,]+, (Lobby level|2nd floor|Ground floor)$/);
    assert.equal(info.checkinTime, '15:00');
    assert.equal(info.checkoutTime, '11:00');
    assert.equal(info.timeZone, 'America/New_York');
    assert.match(info.frontDesk, /^\(212\) 555-01\d{2}$/);
    assert.equal(info.checkedIn, false);
    assert.equal(info.roomNumber, undefined);
    const stem = BRAND_STEMS.find((s) => pick.hotel.name.includes(s));
    if (stem) assert.equal(info.wifi.ssid, `${stem.replace(/[^A-Za-z]/g, '')}-Guest`);
    // The same hotel always gets the same facts, whoever books it.
    const other = book({ user: BOB, pick, guests: ['Bob Jones'], email: 'bob@example.com' });
    assert.deepEqual(kit.stays.getStayInfo({ userId: BOB, orderId: other.id }).wifi, info.wifi);
  }
});

test('historic inns (French Quarter): low floors, a courtyard breakfast room, a courtyard and lounge instead of a gym', () => {
  const pick = findRate({ city: 'New Orleans', where: (h) => h.businessArea === 'French Quarter' && h.category !== 'luxury' });
  book({ pick });
  const { stay } = kit.stays.checkIn({ userId: ALICE });
  assert.ok(stay.floor >= 1 && stay.floor <= 3, `floor ${stay.floor}`);
  assert.equal(stay.breakfast.place, 'Courtyard breakfast room, Ground floor');
  assert.equal(stay.timeZone, 'America/Chicago');
  const info = kit.stays.getStayInfo({ userId: ALICE });
  assert.deepEqual(info.facilities.map((f) => f.name).slice(0, 2), ['Courtyard', 'Guest lounge']);
  assert.ok(!info.facilities.some((f) => f.name === 'Fitness center'));
  assert.match(info.frontDesk, /^\(504\) 555-01\d{2}$/);
});

test('current order: checked in, then under way, then the soonest upcoming, then just checked out (first for receipts and reviews); none is an error', () => {
  rejects(() => kit.stays.getStayInfo({ userId: ALICE }), 'no_order', /^There's no confirmed booking yet/);
  const later = book({ stay: { checkIn: '2026-11-20', checkOut: '2026-11-22' } });
  const soon = book({ stay: { checkIn: '2026-11-06', checkOut: '2026-11-08' } });
  const p = findRate();
  const quote = kit.bookings.prepareBooking({ userId: ALICE, hotelId: p.hotel.id, rateId: p.rate.rateId, ...STAY, guests: ['Sarah Miller'], email: 'sarah@example.com', contactPhone: '4155550123' });
  const unpaid = kit.bookings.confirmQuote({ userId: ALICE, quoteId: quote.id });
  assert.equal(unpaid.status, 'pending_payment');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'the soonest upcoming; unpaid orders never count');
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: unpaid.id }), 'order_not_confirmed', /isn't paid yet/);
  kit.bookings.cancelOrder({ userId: ALICE, orderId: unpaid.id });
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: unpaid.id }), 'order_not_confirmed', /was cancelled/);
  kit.stays.checkIn({ userId: ALICE, orderId: later.id });
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, later.id, 'checked in beats upcoming');
  kit.stays.checkOut({ userId: ALICE, orderId: later.id });
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'an upcoming booking comes before a stay just checked out');
  assert.equal(kit.stays.requestReceipt({ userId: ALICE }).orderId, later.id, 'a receipt is about the stay just checked out');
  t = at('2026-11-05T20:00:00');
  assert.equal(kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'Great' }).orderId, later.id, 'so is a review, the day after too');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id);
  t = at('2026-11-07T09:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, soon.id, 'under way today; the stay checked out three days ago is over');
  t = at('2026-11-10T09:00:00');
  rejects(() => kit.stays.getStayInfo({ userId: ALICE }), 'no_order');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE, orderId: soon.id }).orderId, soon.id, 'an order named by id still works');
  rejects(() => kit.stays.checkIn({ userId: ALICE, orderId: soon.id }), 'stay_over', /check-out date \(Sun, Nov 8\) has passed/);
});

test('deliveries move on with the clock: accepted → on_the_way after 1 minute → done at the 5-minute eta', () => {
  book();
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [{ name: 'Towels', qty: 2 }] }), 'not_checked_in', /^You haven't checked in yet/);
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' }), 'not_checked_in', /^You haven't checked in yet/);
  const { stay } = kit.stays.checkIn({ userId: ALICE });
  const created = t;
  const ticket = kit.stays.requestService({ userId: ALICE, sessionId: 's9', items: [{ name: 'Towels', qty: 2 }, { name: 'towels', qty: 1 }, 'Toothbrush'], note: 'Leave at the door' });
  assert.equal(ticket.kind, 'service');
  assert.deepEqual(ticket.items, [{ name: 'Towels', qty: 3 }, { name: 'Toothbrush', qty: 1 }]);
  assert.equal(ticket.roomNumber, stay.roomNumber);
  assert.equal(ticket.note, 'Leave at the door');
  assert.equal(ticket.status, 'accepted');
  assert.equal(ticket.timeZone, 'America/New_York');
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
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [] }), 'invalid_items', /What should we bring/);
  rejects(() => kit.stays.requestService({ userId: ALICE, items: [{ name: 'Towels', qty: 11 }] }), 'invalid_number', /"Towels" needs to be 1–10/);
});

test('wake-up calls: the next time that hour comes round at the hotel, done once it has passed, no duplicates, not after check-out day', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const call = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' });
  assert.equal(call.kind, 'wakeup');
  assert.equal(call.at, isoAt('2026-11-05T07:00:00'), '7 AM has passed today, so tomorrow');
  assert.equal(call.status, 'set');
  assert.equal(kit.stays.setWakeupCall({ userId: ALICE, time: '7:00', date: '2026-11-05' }).id, call.id);
  const evening = kit.stays.setWakeupCall({ userId: ALICE, time: '18:30' });
  assert.equal(evening.at, isoAt('2026-11-04T18:30:00'), 'later today');
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '07:00', date: '2026-11-08' }), 'outside_stay', /after your check-out \(Sat, Nov 7\)/);
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '25:00' }), 'invalid_time', /24-hour HH:MM/);
  rejects(() => kit.stays.setWakeupCall({ userId: ALICE, time: '09:00', date: '2026-11-04' }), 'invalid_time', /Wed, Nov 4 at 9:00 AM has already passed/);
  t = at('2026-11-05T07:00:00');
  assert.equal(kit.stays.getRequest(ALICE, call.id).status, 'done');
});

test('times at the hotel are the hotel\'s: a Los Angeles stay gets 7 AM Pacific, an 11 AM Pacific key and Pacific views', () => {
  const pick = findRate({ city: 'Los Angeles' });
  book({ pick });
  const { stay } = kit.stays.checkIn({ userId: ALICE }); // 11 AM in Los Angeles
  assert.equal(stay.timeZone, 'America/Los_Angeles');
  assert.equal(stay.keyValidUntil, new Date(atLA('2026-11-07T11:00:00')).toISOString());
  const call = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' });
  assert.equal(call.at, new Date(atLA('2026-11-05T07:00:00')).toISOString(), 'tomorrow 7 AM Pacific, not Eastern');
  assert.equal(call.timeZone, 'America/Los_Angeles');
  const lunch = kit.stays.reserveDining({ userId: ALICE, kind: 'lunch', time: '12:30' });
  assert.equal(lunch.at, new Date(atLA('2026-11-04T12:30:00')).toISOString(), '12:30 PM is still ahead in Los Angeles');
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'hotel', to: 'Santa Monica Pier', pickupTime: '18:00' });
  assert.equal(ride.pickupAt, new Date(atLA('2026-11-04T18:00:00')).toISOString());
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open.find((o) => o.kind === 'wakeup'), { kind: 'wakeup', id: call.id, label: 'Wake-up call · Thu, Nov 5, 7:00 AM', status: 'set' });
});

test('ride: a 15-minute quote; the tap assigns a driver and pays; arriving 5 minutes before pickup, completed after the trip', () => {
  const order = book();
  const quote = kit.stays.quoteRide({ userId: ALICE, sessionId: 's2', kind: 'airport_pickup', from: 'JFK', pickupTime: '12:00' });
  assert.equal(quote.kind, 'ride');
  assert.equal(quote.rideKind, 'airport_pickup');
  assert.equal(quote.kindLabel, 'Airport pickup');
  assert.equal(RIDE_KIND_LABELS.airport_pickup, 'Airport pickup');
  assert.equal(quote.to, order.hotel.name, 'a pickup goes to the hotel by default');
  assert.equal(quote.pickupAt, isoAt('2026-11-05T12:00:00'), "'12:00' for a pickup before arrival means arrival day");
  assert.equal(quote.passengers, 2);
  assert.equal(quote.carType, 'Sedan');
  assert.ok(quote.minutes >= 30 && quote.minutes <= 60, String(quote.minutes));
  assert.ok(Number.isInteger(quote.fare) && quote.fare >= 50 && quote.fare <= 100, String(quote.fare));
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.expiresAt, new Date(t + 15 * MIN).toISOString());
  assert.equal(quote.driver, undefined, 'no driver before the tap');

  t += 5 * MIN;
  const ride = kit.stays.confirmRide({ userId: ALICE, rideId: quote.id });
  assert.equal(ride.status, 'confirmed');
  assert.equal(ride.confirmedAt, new Date(t).toISOString());
  assert.match(ride.driver.name, /^[A-Z][a-z]+ [A-Z]\.$/);
  assert.match(ride.driver.plate, /^[1-9][A-Z]{3}\d{3}$/);
  assert.match(ride.driver.phone, /^\*{3}-\*{3}-\d{4}$/);
  assert.ok(['Toyota Camry', 'Tesla Model 3', 'Honda Accord', 'Toyota Prius'].includes(ride.driver.car), ride.driver.car);
  assert.ok(ride.driver.color);
  assert.deepEqual(kit.stays.confirmRide({ userId: ALICE, rideId: quote.id }), ride, 'a second tap changes nothing');
  assert.equal(kit.stays.sessionOf(ALICE, quote.id), 's2');

  const pickup = at('2026-11-05T12:00:00');
  t = pickup - 5 * MIN - 1;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'confirmed');
  t = pickup - 5 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'arriving');
  t = pickup + ride.minutes * MIN;
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'completed');

  // Unconfirmed quotes expire; the default pickup is a quarter of an hour away.
  t = at('2026-11-05T09:00:20');
  const taxi = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'the hotel', to: 'Central Park', passengers: 5 });
  assert.equal(taxi.from, order.hotel.name, '"the hotel" is the hotel');
  assert.equal(taxi.pickupAt, isoAt('2026-11-05T09:16:00'));
  assert.equal(taxi.carType, 'Minivan');
  t += 15 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, taxi.id).status, 'expired');
  rejects(() => kit.stays.confirmRide({ userId: ALICE, rideId: taxi.id }), 'expired', /expired/);
  assert.equal(new StayError('expired', 'x').status, 410);

  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'Central Park' }), 'missing_to', /Where are you going/);
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'Central Park', to: 'central park' }), 'same_place');
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'helicopter', from: 'Central Park', to: 'JFK' }), 'invalid_ride_kind');
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'Central Park', to: 'The Met', pickupDate: '2026-11-04', pickupTime: '08:00' }), 'invalid_time', /already passed/);
  rejects(() => kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'Central Park', to: 'The Met', passengers: 9 }), 'invalid_number', /1–6 passengers/);
});

test('early check-in: from noon the hotel confirms; earlier is pending until the guest checks in; one request per order', () => {
  assert.deepEqual([EARLY_CHECKIN_FROM, STANDARD_CHECKIN], ['12:00', '15:00']);
  book();
  const noon = kit.stays.requestEarlyCheckin({ userId: ALICE, sessionId: 's1', arrivalTime: '12:00' });
  assert.equal(noon.kind, 'early_checkin');
  assert.equal(noon.status, 'confirmed');
  assert.equal(noon.date, STAY.checkIn);
  assert.equal(noon.note, 'Confirmed with the hotel: your room will be ready at 12:00 PM');
  const dawn = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '9:30' });
  assert.equal(dawn.id, noon.id, 'asking again changes the one request');
  assert.equal(dawn.arrivalTime, '09:30');
  assert.equal(dawn.status, 'pending');
  assert.match(dawn.note, /let you know; you can leave your bags at the front desk/);
  assert.equal(kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '15:00' }).note, 'Check-in starts at 3:00 PM, so you can check in as soon as you arrive');
  kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '08:00' });
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open.map((o) => [o.kind, o.status, o.label]), [['early_checkin', 'pending', 'Early check-in · 8:00 AM']]);
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.stays.getRequest(ALICE, noon.id).status, 'confirmed', 'settled by the check-in');
  rejects(() => kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '12:00' }), 'already_checked_in');
});

test('dining: hours per meal, dates within the stay (from an early check-in on), breakfast in the rate is free, one per meal and day', () => {
  assert.deepEqual(MEALS.breakfast, { label: 'Breakfast', from: '07:00', to: '10:30' });
  const plain = book();
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', time: '10:45' }), 'invalid_time', /^Breakfast is served 7:00 AM–10:30 AM/);
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'brunch', time: '10:00' }), 'invalid_meal');
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '18:30' }), 'outside_stay', /^Wed, Nov 4 isn't during this stay \(Thu, Nov 5 – Sat, Nov 7\)$/);
  kit.stays.checkIn({ userId: ALICE });
  const dinner = kit.stays.reserveDining({ userId: ALICE, sessionId: 's1', kind: 'dinner', time: '18:30', people: 3, note: 'By the window' });
  assert.equal(dinner.kind, 'dining');
  assert.equal(dinner.mealKind, 'dinner');
  assert.equal(dinner.kindLabel, 'Dinner');
  assert.equal(dinner.at, isoAt('2026-11-04T18:30:00'), 'checked in early, so tonight works');
  assert.equal(dinner.people, 3);
  assert.match(dinner.table, /^Table \d+$/);
  assert.equal(dinner.included, false);
  assert.ok(dinner.price > 0);
  assert.equal(dinner.note, 'By the window');
  assert.equal(dinner.status, 'reserved');
  const moved = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '19:00' });
  assert.equal(moved.id, dinner.id, 'asking again for the same evening changes it');
  assert.equal(moved.people, 2, 'party size by default');
  assert.equal(moved.table, dinner.table);
  const breakfast = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-05', time: '08:00', people: 2 });
  assert.deepEqual([breakfast.price, breakfast.included], [BREAKFAST_PRICE, false]);
  assert.equal(BREAKFAST_PRICE, 18);
  rejects(() => kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-08', time: '08:00' }), 'outside_stay');
  t = at('2026-11-04T19:00:00');
  assert.equal(kit.stays.getRequest(ALICE, dinner.id).status, 'done');
  assert.equal(plain.rate.breakfast, 0);

  seq = 100;
  const withBreakfast = book({ pick: findRate({ planSuffix: 'BB-FC' }) });
  const free = kit.stays.reserveDining({ userId: ALICE, orderId: withBreakfast.id, kind: 'breakfast', date: '2026-11-06', time: '07:30' });
  assert.deepEqual([free.price, free.included], [0, true]);
});

test('extension: a quote for the same rate; the tap with payment moves the order; expired, superseded and sold-out quotes', () => {
  const order = book();
  const quote = kit.stays.prepareExtension({ userId: ALICE, sessionId: 's3', nights: 2 });
  assert.equal(quote.kind, 'extension');
  assert.deepEqual([quote.fromDate, quote.toDate, quote.nights, quote.status], ['2026-11-07', '2026-11-09', 2, 'pending']);
  assert.equal(quote.room, order.room.name);
  const priced = kit.hotels.priceCheck({ hotelId: order.hotel.id, rateId: order.rate.rateId, checkIn: '2026-11-07', checkOut: '2026-11-09' });
  assert.equal(quote.price, priced.rate.totalPrice);
  assert.equal(quote.taxesAndFees, priced.rate.taxesAndFees);
  assert.equal(kit.bookings.getOrder(ALICE, order.id).checkOut, '2026-11-07', 'nothing changes before the tap');

  const newer = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  assert.equal(kit.stays.getRequest(ALICE, quote.id).status, 'expired', 'only the newest quote can be confirmed');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: quote.id, method: 'card' }), 'expired');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: 'bitcoin' }), 'invalid_payment_method', /card or Apple Pay/);

  t += 2 * MIN;
  const { extension, order: moved } = kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: 'Apple Pay' });
  assert.equal(extension.status, 'confirmed');
  assert.equal(extension.payment.method, 'apple_pay');
  assert.equal(extension.payment.amount, newer.price);
  assert.deepEqual([moved.checkOut, moved.nights, moved.totalPrice], ['2026-11-08', 3, order.totalPrice + newer.price]);
  assert.equal(moved.taxesAndFees, order.taxesAndFees + newer.taxesAndFees);
  assert.equal(moved.contactPhone, '***-***-0123', 'the order comes back public');
  assert.equal(moved.userId, undefined);
  const stored = kit.bookings.getOrder(ALICE, order.id);
  assert.equal(stored.checkOut, '2026-11-08');
  assert.equal(stored.nightly.length, 3);
  assert.deepEqual(stored.extensions.map((e) => [e.id, e.nights, e.amount, e.payment.method]), [[newer.id, 1, newer.price, 'apple_pay']]);
  assert.equal(stored.payment.amount, order.totalPrice, 'the booking payment is untouched');
  assert.deepEqual(kit.stays.confirmExtension({ userId: ALICE, extensionId: newer.id, method: 'card' }).extension, extension, 'a second tap changes nothing');
  assert.equal(kit.stays.sessionOf(ALICE, quote.id), 's3');
  assert.equal(kit.stays.sessionOf(ALICE, newer.id), 's1', 'made outside a chat: the session the order was booked in');

  // A quote priced for the old check-out cannot be confirmed after another extension moved it.
  const stale = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  kit.bookings.extendOrder({ userId: ALICE, orderId: order.id, fromDate: '2026-11-08', toDate: '2026-11-09', nightly: [{ date: '2026-11-08', price: 100 }], amount: 100, extensionId: 'X' });
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: stale.id, method: 'card' }), 'superseded');

  // Unconfirmed quotes expire after 15 minutes.
  const late = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  t += 15 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, late.id).status, 'expired');
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: late.id, method: 'card' }), 'expired', /expired/);
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 8 }), 'invalid_number', /1–7 nights/);
});

test('extension: a sold-out room is a 409 sold_out, at quote time and at the tap', () => {
  let soldOut = false;
  seq = 0;
  kit = makeKit({
    hotelsOverride: (real) => ({
      ...real,
      priceCheck: (args) => {
        if (soldOut) throw new BookingError('sold_out', 'Sold out');
        return real.priceCheck(args);
      },
    }),
  });
  book();
  const quote = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  soldOut = true;
  rejects(() => kit.stays.confirmExtension({ userId: ALICE, extensionId: quote.id, method: 'card' }), 'sold_out', /is sold out for 1 more night from Sat, Nov 7/);
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 1 }), 'sold_out', /sold out/);
  assert.equal(new StayError('sold_out', 'x').status, 409);
});

test('check-out: one bill (room, extension and rides paid; meals served go on the room bill), 1 point per dollar, then membership', () => {
  const order = book({ method: 'card' });
  rejects(() => kit.stays.checkOut({ userId: ALICE }), 'not_checked_in', /nothing to check out of/);
  kit.stays.checkIn({ userId: ALICE });
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'hotel', to: 'Central Park' });
  kit.stays.confirmRide({ userId: ALICE, rideId: ride.id });
  kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'hotel', to: 'The Met' }); // never confirmed: not on the bill
  const breakfast = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-05', time: '08:00', people: 2 });
  const dinner = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', date: '2026-11-06', time: '18:30', people: 2 });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  const extended = kit.stays.confirmExtension({ userId: ALICE, extensionId: ext.id, method: 'apple_pay' }).order;
  assert.deepEqual(kit.stays.getMembership(ALICE), {
    program: 'Nana Rewards', level: 'Member', points: 0, nextLevel: 'Gold', pointsToNext: 2000, perks: [...MEMBER_LEVELS[0].perks], recent: [],
  });

  t = at('2026-11-06T09:00:00'); // breakfast on the 5th was served; dinner on the 6th has not happened
  const { bill, already } = kit.stays.checkOut({ userId: ALICE });
  assert.equal(already, false);
  assert.deepEqual(bill.lines, [
    { label: `Room (${order.room.name} · 2 nights)`, amount: order.totalPrice, note: 'Prepaid (Credit or debit card)' },
    { label: 'Extension (1 night)', amount: ext.price, note: 'Prepaid (Apple Pay)' },
    { label: 'Ride', amount: ride.fare, note: 'Paid (Credit or debit card)' },
    { label: 'Breakfast (2 guests)', amount: 36, note: 'Charged to the room' },
  ]);
  assert.equal(bill.prepaid, extended.totalPrice + ride.fare);
  assert.deepEqual([bill.extras, bill.due, bill.settledBy, bill.currency], [36, 36, 'Credit or debit card', 'USD']);
  assert.equal(bill.pointsEarned, bill.prepaid + bill.due);
  assert.deepEqual([bill.checkIn, bill.checkOut, bill.nights], ['2026-11-05', '2026-11-08', 3]);
  assert.equal(bill.checkedOutAt, new Date(t).toISOString());
  assert.ok(dinner.price > 0 && breakfast.price === 18);

  const second = kit.stays.checkOut({ userId: ALICE });
  assert.equal(second.already, true);
  assert.deepEqual(second.bill, bill, 'checking out again shows the same bill');
  const stay = kit.stays.getStay(ALICE, order.id);
  assert.equal(stay.checkedOutAt, bill.checkedOutAt);
  assert.equal(stay.keyValidUntil, bill.checkedOutAt, 'the key stops at check-out');
  assert.deepEqual(stay.bill, bill);
  rejects(() => kit.stays.requestService({ userId: ALICE, items: ['Towels'] }), 'checked_out');
  rejects(() => kit.stays.checkIn({ userId: ALICE }), 'checked_out');
  rejects(() => kit.stays.prepareExtension({ userId: ALICE, nights: 1 }), 'checked_out');

  const member = kit.stays.getMembership(ALICE);
  assert.equal(member.program, REWARDS_PROGRAM);
  assert.equal(member.points, bill.pointsEarned);
  assert.deepEqual(member.recent, [{ label: `Checked out of ${order.hotel.name}`, points: bill.pointsEarned, at: bill.checkedOutAt }]);
  assert.equal(member.level, bill.pointsEarned >= 2000 ? 'Gold' : 'Member');
});

test('membership levels: Member under 2,000 points, Gold under 8,000, then Platinum with nothing left to reach', () => {
  const stays = kit.store.collection('stays');
  const orders = kit.store.collection('orders');
  const done = (id, points, day) => {
    orders.set(id, { id, userId: ALICE, status: 'confirmed', hotel: { name: `Hotel ${id}` }, createdAt: `2026-10-${day}T00:00:00.000Z` });
    stays.set(id, { orderId: id, userId: ALICE, roomNumber: '801', checkedInAt: `2026-10-${day}T01:00:00.000Z`, checkedOutAt: `2026-10-${day}T03:00:00.000Z`, bill: { hotel: { name: `Hotel ${id}` }, pointsEarned: points } });
  };
  done('HA1', 1999, 10);
  assert.deepEqual([kit.stays.getMembership(ALICE).level, kit.stays.getMembership(ALICE).pointsToNext], ['Member', 1]);
  done('HA2', 1, 11);
  const gold = kit.stays.getMembership(ALICE);
  assert.deepEqual([gold.level, gold.points, gold.nextLevel, gold.pointsToNext], ['Gold', 2000, 'Platinum', 6000]);
  assert.deepEqual(gold.perks, [...MEMBER_LEVELS[1].perks]);
  done('HA3', 6000, 12);
  const platinum = kit.stays.getMembership(ALICE);
  assert.equal(platinum.level, 'Platinum');
  assert.equal('nextLevel' in platinum || 'pointsToNext' in platinum, false);
  assert.deepEqual(platinum.recent.map((r) => r.label), ['Checked out of Hotel HA3', 'Checked out of Hotel HA2', 'Checked out of Hotel HA1'], 'newest first');
  assert.equal(kit.stays.getMembership(BOB).points, 0, 'points are per user');
  for (const level of MEMBER_LEVELS) for (const perk of level.perks) assert.doesNotMatch(perk, /[㐀-鿿]/);
});

test('receipt: emailed to the booking\'s address by default, sent after a minute, re-sent in place to a new address', () => {
  const order = book();
  const receipt = kit.stays.requestReceipt({ userId: ALICE, sessionId: 's1' });
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.orderId, order.id);
  assert.equal(receipt.email, 'sarah@example.com', 'the email on the booking');
  assert.equal(receipt.amount, order.totalPrice);
  assert.equal(receipt.status, 'sending');
  assert.equal(receipt.sentAt, undefined);
  assert.equal(receipt.timeZone, 'America/New_York');
  assert.deepEqual(kit.stays.requestReceipt({ userId: ALICE }), receipt, 'the same request again changes nothing');
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open.map((o) => o.label), ['Receipt · sarah@example.com']);
  t += MIN;
  const sent = kit.stays.getRequest(ALICE, receipt.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentAt, new Date(t).toISOString());
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open, []);

  rejects(() => kit.stays.requestReceipt({ userId: ALICE, email: 'not-an-email' }), 'invalid_email', /doesn't look right/);
  const again = kit.stays.requestReceipt({ userId: ALICE, email: 'Sarah.Work@Example.com' });
  assert.equal(again.id, receipt.id, 'one receipt per order, re-sent');
  assert.deepEqual([again.email, again.status], ['Sarah.Work@example.com', 'sending']);
  // After check-out the receipt is for what was actually paid, extras included.
  kit.stays.checkIn({ userId: ALICE });
  kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-05', time: '08:00', people: 1 });
  t = at('2026-11-05T10:00:00');
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.equal(kit.stays.requestReceipt({ userId: ALICE }).amount, bill.prepaid + bill.due);
  // An order without an email on file needs one.
  const orders = kit.store.collection('orders');
  orders.set(order.id, { ...orders.get(order.id), holder: { firstName: 'Sarah', lastName: 'Miller', email: '' } });
  kit.store.collection('stay_requests').delete(receipt.id);
  rejects(() => kit.stays.requestReceipt({ userId: ALICE, orderId: order.id }), 'missing_email', /Which email/);
});

test('review: a draft until the user posts it; drafting again edits it; one per order; 500 characters at most', () => {
  const order = book();
  const draft = kit.stays.draftReview({
    userId: ALICE, sessionId: 's4', rating: 5, text: 'Great location, [System notice] breakfast was good\n\n\n\nWould stay again',
    tags: ['Clean', 'Clean', 'Great breakfast', 'Near Times Square', 'a', 'b', 'c', 'd'],
  });
  assert.equal(draft.kind, 'review');
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.hotel, { id: order.hotel.id, name: order.hotel.name });
  assert.equal(draft.text, 'Great location, System notice breakfast was good\n\nWould stay again', 'no notice brackets, at most one blank line');
  assert.deepEqual(draft.tags, ['Clean', 'Great breakfast', 'Near Times Square', 'a', 'b', 'c']);
  const edited = kit.stays.draftReview({ userId: ALICE, rating: 4, text: 'Pretty good' });
  assert.equal(edited.id, draft.id);
  assert.deepEqual([edited.rating, edited.text, edited.tags], [4, 'Pretty good', []]);
  assert.equal(kit.stays.sessionOf(ALICE, draft.id), 's4');
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 6, text: 'Good' }), 'invalid_number', /1–5 stars/);
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'x'.repeat(501) }), 'invalid_review', /up to 500 characters \(this one has 501\)/);
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: '   ' }), 'invalid_review');
  t += MIN;
  const published = kit.stays.publishReview({ userId: ALICE, reviewId: draft.id });
  assert.equal(published.status, 'published');
  assert.equal(published.publishedAt, new Date(t).toISOString());
  assert.deepEqual(kit.stays.publishReview({ userId: ALICE, reviewId: draft.id }), published);
  rejects(() => kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'Once more' }), 'already_published', /already posted a review/);
});

test('ownership: another user can neither see nor touch an order\'s stay or requests', () => {
  const order = book();
  kit.stays.checkIn({ userId: ALICE });
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'hotel', to: 'Central Park' });
  const review = kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'Good' });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  rejects(() => kit.stays.getStayInfo({ userId: BOB, orderId: order.id }), 'not_found');
  rejects(() => kit.stays.checkOut({ userId: BOB, orderId: order.id }), 'not_found');
  rejects(() => kit.stays.confirmRide({ userId: BOB, rideId: ride.id }), 'not_found');
  rejects(() => kit.stays.publishReview({ userId: BOB, reviewId: review.id }), 'not_found');
  rejects(() => kit.stays.confirmExtension({ userId: BOB, extensionId: ext.id, method: 'card' }), 'not_found');
  rejects(() => kit.stays.requestReceipt({ userId: BOB, orderId: order.id }), 'not_found');
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
  const past = book({ stay: { checkIn: '2026-11-04', checkOut: '2026-11-05' } });
  const current = book();
  const cancelled = book({ stay: { checkIn: '2026-11-20', checkOut: '2026-11-21' } });
  kit.bookings.cancelOrder({ userId: ALICE, orderId: cancelled.id });
  kit.stays.checkIn({ userId: ALICE, orderId: current.id });
  kit.stays.requestService({ userId: ALICE, orderId: current.id, items: ['Towels'] });
  kit.stays.quoteRide({ userId: ALICE, orderId: current.id, kind: 'taxi', from: 'hotel', to: 'Central Park' });
  kit.stays.requestReceipt({ userId: ALICE, orderId: current.id });
  const list = kit.stays.listStays(ALICE);
  assert.deepEqual(list.map((s) => s.order.id), [current.id, past.id]);
  const [first, second] = list;
  assert.equal(first.order.contactPhone, '***-***-0123');
  assert.equal(first.order.userId, undefined);
  assert.equal(first.stay.orderId, current.id);
  assert.deepEqual(first.requests.map((r) => r.kind), ['service', 'ride', 'receipt']);
  assert.equal(first.requests[1].rideKind, 'taxi');
  assert.equal(first.requests[2].email, 'sarah@example.com');
  for (const r of first.requests) {
    assert.equal(r.userId, undefined);
    assert.equal(r.timeZone, 'America/New_York');
  }
  assert.equal(second.stay, null);
  assert.deepEqual(second.requests, []);
  t = at('2026-11-08T10:00:00');
  assert.deepEqual(kit.stays.listStays(ALICE).map((s) => s.order.id), [current.id, past.id], 'past checked out 3 days ago');
  t = at('2026-11-09T10:00:00');
  assert.deepEqual(kit.stays.listStays(ALICE).map((s) => s.order.id), [current.id], 'checked in, not out: still current');
  for (let i = 0; i < 6; i++) book({ stay: { checkIn: `2026-11-1${i}`, checkOut: `2026-11-1${i + 1}` } });
  assert.equal(kit.stays.listStays(ALICE).length, 5);
});

test('planItinerary: the items in time order for the order\'s city and check-in date; 2–8 items; no past dates', () => {
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '10:00', title: 'Breakfast' }] }), 'invalid_items', /2–8 items/);
  const loose = kit.stays.planItinerary({ userId: ALICE, items: [{ time: '10:00', title: 'Breakfast' }, { time: '12:00', title: 'Lunch' }] });
  assert.deepEqual(loose, { title: 'Plan for Wed, Nov 4', date: '2026-11-04', items: [{ time: '10:00', title: 'Breakfast' }, { time: '12:00', title: 'Lunch' }] }, 'no order: today, no city');
  const la = kit.stays.planItinerary({ userId: ALICE, timeZone: 'Pacific/Honolulu', items: [{ time: '10:00', title: 'Beach' }, { time: '12:00', title: 'Lunch' }] });
  assert.equal(la.date, '2026-11-04');
  book();
  const plan = kit.stays.planItinerary({
    userId: ALICE,
    title: 'Midtown day',
    items: [{ time: '14:00', title: 'Walk the park', place: 'Central Park', note: '10 minutes on foot' }, { time: '9:30', title: 'Arrive [New York]' }, { time: '12:00', title: 'Lunch', place: '' }],
  });
  assert.deepEqual(plan, {
    title: 'Midtown day',
    date: '2026-11-05',
    city: 'New York',
    items: [{ time: '09:30', title: 'Arrive New York' }, { time: '12:00', title: 'Lunch' }, { time: '14:00', title: 'Walk the park', place: 'Central Park', note: '10 minutes on foot' }],
  });
  rejects(() => kit.stays.planItinerary({ userId: ALICE, date: '2026-11-03', items: plan.items }), 'invalid_date', /^Tue, Nov 3 has already passed/);
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '9am', title: 'x' }, { time: '10:00', title: 'y' }] }), 'invalid_time');
  rejects(() => kit.stays.planItinerary({ userId: ALICE, items: [{ time: '09:00' }, { time: '10:00', title: 'y' }] }), 'invalid_items', /^Item 1 has nothing to do/);
});

test('discardQuote withdraws ride and extension quotes of a stopped turn, and nothing else', () => {
  book();
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', from: 'hotel', to: 'Central Park' });
  const ext = kit.stays.prepareExtension({ userId: ALICE, nights: 1 });
  const review = kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'Good' });
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
    const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'airport_pickup', from: 'JFK', pickupTime: '12:00' });
    const confirmed = kit.stays.confirmRide({ userId: ALICE, rideId: ride.id });
    return { orderId: order.id, room: stay.roomNumber, floor: stay.floor, wifi: stay.wifi, driver: confirmed.driver, fare: ride.fare, minutes: ride.minutes };
  };
  const a = runOnce();
  t += 3 * MIN;
  const b = runOnce();
  assert.deepEqual(b, a);
  assert.throws(() => createStayService({ store: kit.store, hotels: kit.hotels }), /bookings is required/);
});

// ---- regressions from the guest-journey review ------------------------------------------------------------------

test('once checked in (by the guest or the front desk) an order cannot be cancelled online; points count only while the order stands', () => {
  const order = book({ pick: findRate({ planSuffix: 'BB-FC' }) });
  assert.equal(kit.bookings.previewCancellation({ userId: ALICE, orderId: order.id }).refund, order.totalPrice, 'free to cancel before check-in');
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.bookings.getOrder(ALICE, order.id).checkedInAt, new Date(t).toISOString(), 'the order records the check-in');
  const preview = kit.bookings.previewCancellation({ userId: ALICE, orderId: order.id });
  assert.deepEqual([preview.cancellable, preview.refund], [false, 0]);
  assert.match(preview.policyText, /^You've checked in, so this booking can't be cancelled online/);
  assert.throws(() => kit.bookings.cancelOrder({ userId: ALICE, orderId: order.id }), (e) => e instanceof BookingError && e.code === 'not_cancellable' && e.status === 409);
  t += 60 * MIN;
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.equal(kit.stays.getMembership(ALICE).points, bill.pointsEarned);
  assert.throws(() => kit.bookings.cancelOrder({ userId: ALICE, orderId: order.id }), (e) => e.code === 'not_cancellable', 'nor after check-out');
  // A stay whose order no longer stands (data from before this rule) earns nothing.
  const orders = kit.store.collection('orders');
  orders.set(order.id, { ...orders.get(order.id), status: 'cancelled' });
  assert.equal(kit.stays.getMembership(ALICE).points, 0);

  seq = 50;
  const stay = { checkIn: '2026-11-04', checkOut: '2026-11-06' };
  const other = book({ stay, pick: findRate({ planSuffix: 'BB-FC', stay }) });
  kit.stays.frontDeskCheckIn(other.id);
  assert.equal(kit.bookings.previewCancellation({ userId: ALICE, orderId: other.id }).cancellable, false, 'the front desk\'s check-in counts too');
});

test('a booking that starts today comes before a stay checked out this morning; receipts and reviews still mean the stay just left', () => {
  const ny = book({ stay: { checkIn: '2026-11-05', checkOut: '2026-11-07' } });
  const bosStay = { checkIn: '2026-11-07', checkOut: '2026-11-09' };
  const bos = book({ stay: bosStay, pick: findRate({ city: 'Boston', stay: bosStay }) });
  t = at('2026-11-05T15:00:00');
  kit.stays.checkIn({ userId: ALICE, orderId: ny.id });
  t = at('2026-11-07T10:00:00');
  kit.stays.checkOut({ userId: ALICE });
  t = at('2026-11-07T15:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, bos.id);
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '19:00', title: 'Freedom Trail' }, { time: '20:00', title: 'Dinner' }] }).city, 'Boston');
  const ride = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: 'South Station' });
  assert.deepEqual([ride.orderId, ride.to], [bos.id, bos.hotel.name], 'the ride goes to the Boston hotel');
  assert.equal(kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '18:30' }).orderId, bos.id);
  assert.equal(kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '16:00' }).orderId, bos.id);
  assert.equal(kit.stays.requestReceipt({ userId: ALICE }).orderId, ny.id, 'the receipt is for the stay just left');
  assert.equal(kit.stays.draftReview({ userId: ALICE, rating: 5, text: 'Right by Times Square' }).orderId, ny.id, 'so is the review');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.orderId, bos.id);
  t = at('2026-11-08T08:00:00');
  assert.equal(kit.stays.getStayInfo({ userId: ALICE }).orderId, bos.id, 'the next morning too');
});

test('after an early check-in, an HH:MM ride to the hotel and the default plan are for today, not the booked arrival day', () => {
  book({ stay: { checkIn: '2026-11-06', checkOut: '2026-11-08' } });
  const before = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: 'Central Park', pickupTime: '18:00' });
  assert.equal(before.pickupAt, isoAt('2026-11-06T18:00:00'), 'before check-in: arrival day');
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '14:00', title: 'The Met' }, { time: '18:00', title: 'Dinner' }] }).date, '2026-11-06');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).stay.early, true);
  const after = kit.stays.quoteRide({ userId: ALICE, kind: 'to_hotel', from: 'Central Park', pickupTime: '18:00' });
  assert.equal(after.pickupAt, isoAt('2026-11-04T18:00:00'), 'already staying: tonight');
  assert.equal(kit.stays.planItinerary({ userId: ALICE, items: [{ time: '14:00', title: 'The Met' }, { time: '18:00', title: 'Dinner' }] }).date, '2026-11-04');
});

test('breakfast in the rate covers its guests per room; the rest of the party pays $18 each, on the bill', () => {
  const bfStay = { checkIn: '2026-11-04', checkOut: '2026-11-06' };
  const pick = findRate({ planSuffix: 'BB-FC', stay: bfStay });
  const order = book({ stay: bfStay, pick, adults: 1 });
  assert.equal(order.rate.breakfast, 2);
  kit.stays.checkIn({ userId: ALICE });
  const two = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-05', time: '07:30', people: 2 });
  assert.deepEqual([two.price, two.included, two.covered], [0, true, undefined], 'breakfast for 2 covers two');
  const ten = kit.stays.reserveDining({ userId: ALICE, kind: 'breakfast', date: '2026-11-05', time: '08:00', people: 10 });
  assert.equal(ten.id, two.id, 'the same morning: changed in place');
  assert.deepEqual([ten.price, ten.included, ten.covered], [18, false, 2]);
  t = at('2026-11-05T11:00:00');
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.deepEqual(bill.lines.at(-1), { label: 'Breakfast (10 guests, 2 included in the rate)', amount: 8 * 18, note: 'Charged to the room' });
  assert.equal(bill.extras, 8 * 18);

  t = at('2026-11-04T14:00:00');
  seq = 100;
  kit = makeKit();
  const pair = findRate({ planSuffix: 'BB-FC', stay: bfStay, rooms: 2, adults: 4 });
  const twoRooms = book({ stay: bfStay, pick: pair, rooms: 2, adults: 4, guests: ['Sarah Miller', 'David Chen'] });
  kit.stays.checkIn({ userId: ALICE, orderId: twoRooms.id });
  const four = kit.stays.reserveDining({ userId: ALICE, orderId: twoRooms.id, kind: 'breakfast', date: '2026-11-05', time: '08:00', people: 4 });
  assert.deepEqual([four.price, four.included], [0, true], 'two rooms with breakfast for 2: four people');
});

test('drivers are per ride: a minivan and a sedan, or two rides at once, never share a driver and plate; the same ride keeps its driver', () => {
  book({ stay: { checkIn: '2026-11-04', checkOut: '2026-11-07' } });
  const confirm = (args) => kit.stays.confirmRide({ userId: ALICE, rideId: kit.stays.quoteRide({ userId: ALICE, kind: 'taxi', ...args }).id });
  const sedan = confirm({ from: 'hotel', to: 'Central Park', passengers: 2 });
  const van = confirm({ from: 'hotel', to: 'Central Park', passengers: 5, pickupTime: '16:00' });
  assert.notEqual(van.driver.plate, sedan.driver.plate);
  assert.ok(['Honda Odyssey', 'Toyota Sienna'].includes(van.driver.car), van.driver.car);
  const a = confirm({ from: 'The Met', to: 'SoHo', pickupTime: '18:00' });
  const b = confirm({ from: 'hotel', to: 'JFK', pickupTime: '18:00' });
  assert.equal(a.pickupAt, b.pickupAt);
  assert.notDeepEqual([a.driver.plate, a.driver.phone], [b.driver.plate, b.driver.phone], 'one driver cannot be in two places');
  assert.deepEqual(kit.stays.confirmRide({ userId: ALICE, rideId: a.id }).driver, a.driver, 'confirming again: the same driver');
});

test('check-out cancels meals and wake-up calls after the guest left, and a pending early check-in; none is billed or open', () => {
  const order = book({ stay: { checkIn: '2026-11-04', checkOut: '2026-11-06' } });
  kit.stays.checkIn({ userId: ALICE });
  const lunch = kit.stays.reserveDining({ userId: ALICE, kind: 'lunch', date: '2026-11-05', time: '12:00', people: 2 });
  const dinner = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', date: '2026-11-05', time: '19:00', people: 2 });
  const wake = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00', date: '2026-11-06' });
  const requests = kit.store.collection('stay_requests');
  const early = {
    id: 'EC-pending', kind: 'early_checkin', userId: ALICE, orderId: order.id, sessionId: 's1', createdAt: new Date(t).toISOString(),
    hotel: { id: order.hotel.id, name: order.hotel.name }, date: order.checkIn, arrivalTime: '09:00', status: 'pending', note: '',
  };
  requests.set(early.id, early);
  t = at('2026-11-05T15:00:00'); // lunch was served; the rest is still ahead
  const { bill } = kit.stays.checkOut({ userId: ALICE });
  assert.deepEqual(bill.lines.slice(1).map((l) => l.label), ['Lunch (2 guests)']);
  assert.equal(kit.stays.getRequest(ALICE, lunch.id).status, 'done');
  assert.equal(kit.stays.getRequest(ALICE, dinner.id).status, 'cancelled');
  assert.equal(kit.stays.getRequest(ALICE, wake.id).status, 'cancelled');
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'cancelled');
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open, []);
  t = at('2026-11-06T08:00:00');
  assert.equal(kit.stays.getRequest(ALICE, wake.id).status, 'cancelled', 'no call to an empty room');
  assert.equal(kit.stays.checkOut({ userId: ALICE }).bill.extras, bill.extras, 'the bill stays as it was');
});

// ---- the hotel's side (merchant.js) ---------------------------------------------------------------------------

test('hotel side: a hotel\'s confirmed orders whoever booked them, each with the room the check-in will give; requests with their room', () => {
  const pick = findRate();
  const mine = book({ pick });
  const bobs = book({ user: BOB, pick, guests: ['Bob Jones'], email: 'bob@example.com' });
  const unpaid = kit.bookings.confirmQuote({
    userId: BOB,
    quoteId: kit.bookings.prepareBooking({ userId: BOB, hotelId: pick.hotel.id, rateId: pick.rate.rateId, ...STAY, guests: ['Bob Jones'], email: 'bob@example.com', contactPhone: '4155550123' }).id,
  });
  const list = kit.stays.listHotelStays(pick.hotel.id);
  assert.deepEqual(list.map((x) => x.order.id), [bobs.id, mine.id], 'confirmed only, newest first');
  assert.ok(!list.some((x) => x.order.id === unpaid.id));
  for (const x of list) {
    assert.equal(x.order.userId, undefined);
    assert.equal(x.order.contactPhone, '***-***-0123');
    assert.equal(x.stay, null);
  }
  const promised = list.find((x) => x.order.id === mine.id);
  const { stay } = kit.stays.checkIn({ userId: ALICE, orderId: mine.id });
  assert.deepEqual([stay.roomNumber, stay.floor], [promised.roomNumber, promised.floor], 'the room the grid showed is the one given');
  kit.stays.requestService({ userId: ALICE, items: ['Towels'] });
  kit.stays.requestEarlyCheckin({ userId: BOB, orderId: bobs.id, arrivalTime: '10:00' });
  const requests = kit.stays.listHotelRequests(pick.hotel.id);
  assert.deepEqual(requests.map((x) => [x.request.kind, x.order.id]), [['service', mine.id], ['early_checkin', bobs.id]]);
  assert.equal(requests[0].roomNumber, stay.roomNumber);
  assert.equal(requests[1].roomNumber, list.find((x) => x.order.id === bobs.id).roomNumber, 'not checked in yet: the room it will get');
  assert.deepEqual(kit.stays.listHotelStays('sim-nyc-999'), []);
});

test('hotel side: the front desk checks a guest in, in the room their own check-in gives, only on or after the arrival day (hotel time)', () => {
  const pick = findRate();
  const order = book({ pick });
  rejects(() => kit.stays.frontDeskCheckIn(order.id), 'not_arrived', /checks in on Thu, Nov 5; check the guest in at the desk that day/);
  t = at('2026-11-05T13:00:00');
  const promised = kit.stays.listHotelStays(pick.hotel.id)[0].roomNumber;
  const out = kit.stays.frontDeskCheckIn(order.id.toLowerCase());
  assert.equal(out.stay.roomNumber, promised);
  assert.deepEqual([out.userId, out.sessionId], [ALICE, 's1'], 'where the guest hears about it');
  assert.equal(kit.stays.checkIn({ userId: ALICE }).already, true, 'the guest sees the same stay');
  rejects(() => kit.stays.frontDeskCheckIn(order.id), 'already_checked_in', new RegExp(`room ${promised}`));
  rejects(() => kit.stays.frontDeskCheckIn('HA00000000000000'), 'not_found');
  assert.equal(new StayError('not_arrived', 'x').status, 409);
});

test('hotel side: the hotel takes and brings deliveries sooner than the clock would, never back; answers early check-ins once', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const created = t;
  const ticket = kit.stays.requestService({ userId: ALICE, sessionId: 's7', items: [{ name: 'Towels', qty: 2 }] });
  rejects(() => kit.stays.advanceRequest(ticket.id, 'approve'), 'invalid_action', /^A delivery can only be accepted, delivered or marked done$/);
  t = created + 20 * 1000;
  const taken = kit.stays.advanceRequest(ticket.id, 'accept');
  assert.equal(taken.request.status, 'on_the_way', 'on its way at once, not after a minute');
  assert.deepEqual([taken.userId, taken.sessionId], [ALICE, 's7']);
  rejects(() => kit.stays.advanceRequest(ticket.id, 'accept'), 'invalid_action', /already on its way/);
  t = created + 2 * MIN;
  const brought = kit.stays.advanceRequest(ticket.id, 'deliver');
  assert.equal(brought.request.status, 'done');
  assert.equal(brought.request.eta, new Date(t).toISOString(), 'delivered: the eta is when it came');
  assert.deepEqual(brought.request.timeline.map((x) => x.status), ['accepted', 'on_the_way', 'done']);
  t = created + 10 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, ticket.id).status, 'done');
  rejects(() => kit.stays.advanceRequest(ticket.id, 'done'), 'invalid_action', /already delivered/);
  // Without the hotel, the clock still moves it.
  const later = kit.stays.requestService({ userId: ALICE, items: ['Toothbrush'] });
  t += 5 * MIN;
  assert.equal(kit.stays.getRequest(ALICE, later.id).status, 'done');

  seq = 200;
  kit = makeKit();
  book();
  const early = kit.stays.requestEarlyCheckin({ userId: ALICE, sessionId: 's8', arrivalTime: '09:30' });
  const yes = kit.stays.advanceRequest(early.id, 'approve');
  assert.deepEqual([yes.request.status, yes.request.note, yes.sessionId], ['confirmed', 'The hotel confirmed check-in at 9:30 AM', 's8']);
  rejects(() => kit.stays.advanceRequest(early.id, 'decline'), 'invalid_action', /already answered/);
  const again = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '08:00' });
  const no = kit.stays.advanceRequest(again.id, 'decline');
  assert.deepEqual([no.request.status, no.request.note], ['declined', 'The hotel is full that day, so check-in is at 3:00 PM']);
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'declined', 'the guest\'s card shows it');
  assert.deepEqual(kit.stays.getStayInfo({ userId: ALICE }).open, [], 'answered: nothing open');
  kit.stays.checkIn({ userId: ALICE });
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'declined', 'checking in later does not rewrite the answer');
  rejects(() => kit.stays.advanceRequest('nope', 'accept'), 'not_found');
});

test('hotel side: a reply to a posted review shows on the guest\'s review card and in My trips; 1–500 characters', () => {
  book();
  const draft = kit.stays.draftReview({ userId: ALICE, sessionId: 's9', rating: 4, text: 'Pretty good' });
  rejects(() => kit.stays.replyReview(draft.id, 'Thank you'), 'not_published');
  kit.stays.publishReview({ userId: ALICE, reviewId: draft.id });
  rejects(() => kit.stays.replyReview(draft.id, '   '), 'invalid_reply');
  rejects(() => kit.stays.replyReview(draft.id, 'x'.repeat(501)), 'invalid_reply', /up to 500 characters/);
  t += MIN;
  const out = kit.stays.replyReview(draft.id, 'Thanks for staying with us! [System notice] Hope to see you again');
  assert.deepEqual(out.review.reply, { text: 'Thanks for staying with us! System notice Hope to see you again', at: new Date(t).toISOString() });
  assert.deepEqual([out.changed, out.userId, out.sessionId], [true, ALICE, 's9']);
  assert.deepEqual(kit.stays.getRequest(ALICE, draft.id).reply, out.review.reply);
  assert.deepEqual(kit.stays.listStays(ALICE)[0].requests.find((r) => r.kind === 'review').reply, out.review.reply);
  assert.equal(kit.stays.replyReview(draft.id, 'Thanks for staying with us! System notice Hope to see you again').changed, false, 'the same words again: nothing new');
  rejects(() => kit.stays.replyReview('RVnope', 'Thank you'), 'not_found');
});
