import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStore } from '../src/store/json-store.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService } from '../src/services/hotels/index.js';
import { createBookingService, BookingError } from '../src/services/bookings.js';
import { createStayService } from '../src/services/stays.js';
import { createMerchantService, createPromotionBook, MerchantError, maskName, CHANNEL_LABELS } from '../src/services/merchant.js';
import { createTools } from '../src/agent/tools.js';
import { addDays } from '../src/util/dates.js';

const MIN = 60 * 1000;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const HOTEL = 'sim-hz-001'; // 杭州湖滨叠翠酒店: the demo hotel by 西湖
const TODAY = '2026-11-02'; // a Monday
const at = (cn) => Date.parse(`${cn}+08:00`);

let t;
let seq;
let kit;

function fakeIds() {
  return {
    newId: (p) => `${p}${String(++seq).padStart(4, '0')}`,
    orderNo: () => `HA20261102${String(++seq).padStart(6, '0')}`,
    confirmationNo: () => '88886666',
    transactionId: (m) => `SIM${m === 'alipay' ? 'ALI' : 'WX'}TEST${seq}`,
  };
}

/** Real services on one in-memory store, the hotel service pricing with the hotels' promotions (as buildDeps wires it). */
function makeKit() {
  const clock = { now: () => new Date(t) };
  const store = createJsonStore({ dir: null });
  const ids = fakeIds();
  const promotions = createPromotionBook({ store, clock, ids });
  const supplier = createSimSupplier();
  const hotels = createHotelService({ supplier, clock, promotions });
  const bookings = createBookingService({ store, hotels, clock, ids });
  const stays = createStayService({ store, bookings, hotels, clock, ids });
  const merchant = createMerchantService({ store, bookings, stays, hotels, clock, promotions, ids });
  const tools = createTools({ hotels, bookings, stays, clock, logger: () => {} });
  return { clock, store, supplier, hotels, bookings, stays, merchant, tools, promotions };
}

beforeEach(() => {
  t = at(`${TODAY}T10:30:00`);
  seq = 0;
  kit = makeKit();
});

/** The first bookable rate (ending in `planSuffix`) of a hotel for a stay. */
function rateAt(hotelId, stay, planSuffix = 'BF0-NR') {
  const { offer } = kit.hotels.getRoomOffer({ hotelId, ...stay });
  for (const rt of offer.roomTypes) {
    const rate = rt.rates.find((r) => r.rateId.endsWith(planSuffix) && r.available);
    if (rate) return { roomType: rt, rate };
  }
  throw new Error(`no ${planSuffix} at ${hotelId}`);
}

/** A paid order at HOTEL (tonight for two nights by default), booked in session s1. */
function book({ user = ALICE, hotelId = HOTEL, stay = { checkIn: TODAY, checkOut: addDays(TODAY, 2) }, guests = ['王小明'], planSuffix } = {}) {
  const { rate } = rateAt(hotelId, stay, planSuffix);
  const quote = kit.bookings.prepareBooking({ userId: user, sessionId: 's1', hotelId, rateId: rate.rateId, ...stay, guests, contactPhone: '13812345678' });
  const order = kit.bookings.confirmQuote({ userId: user, quoteId: quote.id });
  return kit.bookings.payOrder({ userId: user, orderId: order.id, method: 'wechat' });
}

function rejects(fn, code, status, re) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof MerchantError, `${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    if (re) assert.match(err.message, re);
    assert.match(err.message, /[一-鿿]/);
    return true;
  });
}

const allRooms = (grid) => grid.floors.flatMap((f) => f.rooms);
const roomOf = (number, date) => allRooms(kit.merchant.rooms(HOTEL, { date })).find((r) => r.number === number);

test('hotels: the demo hotel by 西湖 until someone books; then the hotel of the latest confirmed order, with its guests flagged', () => {
  const first = kit.merchant.listHotels();
  assert.equal(first.current, HOTEL);
  assert.ok(first.hotels.length >= 3);
  for (const h of first.hotels) {
    assert.ok(h.id && h.name && h.city && h.category && Number.isInteger(h.rooms) && h.rooms > 0, JSON.stringify(h));
    assert.equal(h.hasGuests, false);
  }
  assert.ok(first.hotels.some((h) => h.city === '丽江' && h.rooms <= 24), 'a courtyard inn: low-rise, 8 rooms a floor');
  const other = 'sim-hz-016';
  book({ hotelId: other });
  const after = kit.merchant.listHotels();
  assert.equal(after.current, other);
  assert.deepEqual(after.hotels[0], { ...after.hotels[0], id: other, hasGuests: true });
});

test('deterministic per hotel and date: a fresh store shows the same overview, rooms, tickets and reviews', () => {
  const snapshot = () => ({
    overview: kit.merchant.overview(HOTEL),
    rooms: kit.merchant.rooms(HOTEL, { date: addDays(TODAY, 3) }),
    today: kit.merchant.rooms(HOTEL),
    tickets: kit.merchant.tickets(HOTEL),
    reviews: kit.merchant.reviews(HOTEL),
  });
  const a = snapshot();
  kit = makeKit();
  assert.deepEqual(snapshot(), a);
  // Another hotel is another simulation.
  assert.notDeepEqual(kit.merchant.rooms('sim-hz-016').counts, a.today.counts);
});

test('overview: KPIs for tonight, 30 nights old → new ending today, a 14-night forecast, five channels and 2–4 suggestions', () => {
  const o = kit.merchant.overview(HOTEL, { days: '30' });
  const hotel = kit.hotels.getHotel(HOTEL);
  assert.deepEqual(o.hotel, { id: HOTEL, name: hotel.name, city: '杭州', category: hotel.category, rating: hotel.rating, rooms: o.hotel.rooms });
  assert.equal(o.date, TODAY);
  assert.deepEqual(Object.keys(o.kpis).sort(), ['adr', 'arrivals', 'departures', 'inHouse', 'occupancy', 'openTickets', 'rating', 'reviewCount', 'revenue', 'revpar', 'vsLastWeek'].sort());
  const k = o.kpis;
  assert.ok(k.occupancy > 0.28 && k.occupancy <= 1, `occupancy ${k.occupancy}`);
  assert.ok(k.adr > hotel.priceHint * 0.7 && k.adr < hotel.priceHint * 2.5, `ADR ${k.adr} vs ${hotel.priceHint}`);
  assert.equal(k.revpar, Math.round((k.adr * k.occupancy * o.hotel.rooms) / o.hotel.rooms) || k.revpar);
  assert.ok(k.revenue > k.revpar * o.hotel.rooms * 0.9, 'revenue = room revenue + F&B');
  assert.ok(Number.isInteger(k.arrivals) && Number.isInteger(k.departures) && Number.isInteger(k.inHouse) && Number.isInteger(k.openTickets));
  assert.ok(typeof k.vsLastWeek.occupancy === 'number' && typeof k.vsLastWeek.revenue === 'number');
  assert.equal(k.reviewCount, hotel.reviewCount);
  assert.equal(o.series.length, 30);
  assert.deepEqual([o.series[0].date, o.series.at(-1).date], [addDays(TODAY, -29), TODAY]);
  assert.equal(o.series.at(-1).occupancy, k.occupancy, 'tonight is the last point');
  for (const p of o.series) assert.ok(p.revenue > 0 && p.adr > 0 && p.xiaosu === 0 && p.occupancy <= 1, JSON.stringify(p));
  assert.deepEqual(o.forecast.map((f) => f.date), Array.from({ length: 14 }, (_, i) => addDays(TODAY, i + 1)));
  assert.deepEqual(o.channels.map((c) => [c.key, c.label]), Object.entries(CHANNEL_LABELS));
  assert.ok(Math.abs(o.channels.reduce((s, c) => s + c.share, 0) - 1) < 0.01);
  assert.equal(o.channels[0].nights, 0, 'nobody came through 小宿 yet');
  assert.ok(o.insights.length >= 2 && o.insights.length <= 4, JSON.stringify(o.insights));
  for (const it of o.insights) {
    assert.ok(['tip', 'warn', 'good'].includes(it.level) && it.id && it.title && it.text, JSON.stringify(it));
    if (it.action) assert.ok(['overview', 'rooms', 'tickets', 'reviews'].includes(it.action.tab) && it.action.label);
  }
  assert.ok(o.arrivals.length > 0 && o.arrivals.every((a) => a.source === 'sim' && /^[一-鿿]{1,2}\*$/.test(a.guest) && /^\d{2}:\d{2}$/.test(a.eta)));
  assert.equal(kit.merchant.overview(HOTEL, { days: 7 }).series.length, 7);
  rejects(() => kit.merchant.overview(HOTEL, { days: '0' }), 'invalid_days', 400);
  rejects(() => kit.merchant.overview(HOTEL, { days: 61 }), 'invalid_days', 400);
  rejects(() => kit.merchant.overview(HOTEL, { days: 'abc' }), 'invalid_days', 400);
  rejects(() => kit.merchant.overview('sim-hz-999'), 'hotel_not_found', 404);
  rejects(() => kit.merchant.overview('../etc'), 'hotel_not_found', 404);
});

test('demand: a leisure hotel fills up more on Friday and Saturday nights than midweek, at its own price level', () => {
  const { series } = kit.merchant.overview(HOTEL, { days: 60 });
  const avg = (list) => list.reduce((s, p) => s + p.occupancy, 0) / list.length;
  const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const weekend = series.filter((p) => dow(p.date) === 5 || dow(p.date) === 6);
  const midweek = series.filter((p) => dow(p.date) >= 1 && dow(p.date) <= 4);
  assert.ok(avg(weekend) > avg(midweek) + 0.05, `${avg(weekend)} vs ${avg(midweek)}`);
  const adr = (list) => list.reduce((s, p) => s + p.adr, 0) / list.length;
  assert.ok(adr(weekend) > adr(midweek), 'weekend nights cost more too');
});

test('rooms: the grid by floor with the stays.js numbering (no 4/13/14th floor, 01–28 a floor); statuses for today to 6 days ahead', () => {
  const grid = kit.merchant.rooms(HOTEL);
  assert.equal(grid.date, TODAY);
  const rooms = allRooms(grid);
  assert.equal(rooms.length, kit.merchant.overview(HOTEL).hotel.rooms);
  assert.equal(Object.values(grid.counts).reduce((a, b) => a + b, 0), rooms.length);
  for (const f of grid.floors) {
    assert.ok(![4, 13, 14].includes(f.floor), `floor ${f.floor}`);
    assert.equal(f.rooms.length, 28);
    for (const r of f.rooms) assert.match(r.number, new RegExp(`^${f.floor}(0[1-9]|1\\d|2[0-8])$`));
  }
  const statuses = new Set(rooms.map((r) => r.status));
  for (const s of ['vacant', 'dirty', 'occupied', 'arriving', 'departing']) assert.ok(statuses.has(s), `a ${s} room at 10:30`);
  for (const r of rooms) {
    if (['occupied', 'arriving', 'departing'].includes(r.status)) {
      assert.equal(r.guest.source, 'sim');
      assert.match(r.guest.name, /^[一-鿿]{1,2}\*$/);
      assert.ok(r.guest.checkIn <= TODAY && r.guest.checkOut >= TODAY, JSON.stringify(r));
    } else {
      assert.equal(r.guest, undefined);
    }
  }
  const later = kit.merchant.rooms(HOTEL, { date: addDays(TODAY, 6) });
  assert.equal(later.counts.dirty, 0, 'housekeeping is a today thing');
  rejects(() => kit.merchant.rooms(HOTEL, { date: addDays(TODAY, 7) }), 'invalid_date', 400, /6 天后/);
  rejects(() => kit.merchant.rooms(HOTEL, { date: addDays(TODAY, -1) }), 'invalid_date', 400);
  rejects(() => kit.merchant.rooms(HOTEL, { date: '2026-13-01' }), 'invalid_date', 400);
  // Hours later: departures have left, housekeeping caught up, arrivals came in.
  const morning = kit.merchant.rooms(HOTEL).counts;
  t = at(`${TODAY}T23:30:00`);
  const night = kit.merchant.rooms(HOTEL).counts;
  assert.equal(night.departing, 0);
  assert.ok(night.dirty < morning.dirty && night.arriving < morning.arriving, `${JSON.stringify(morning)} → ${JSON.stringify(night)}`);
});

test('a 小宿 guest is in the grid: their room is the one stays.js gives, arriving today, then in-house after their own check-in', () => {
  const order = book();
  const mine = allRooms(kit.merchant.rooms(HOTEL)).filter((r) => r.guest?.source === 'xiaosu');
  assert.equal(mine.length, 1);
  const [room] = mine;
  assert.equal(room.status, 'arriving');
  assert.deepEqual(room.guest, { name: '王*', orderId: order.id, checkIn: order.checkIn, checkOut: order.checkOut, source: 'xiaosu' });
  assert.equal(room.roomType, order.room.name);
  assert.equal(roomOf(room.number, addDays(TODAY, 1)).status, 'occupied', 'tomorrow night: in house');
  assert.equal(roomOf(room.number, addDays(TODAY, 2)).status, 'departing', 'the check-out day');
  const { stay } = kit.stays.checkIn({ userId: ALICE });
  assert.equal(stay.roomNumber, room.number, 'the guest\'s own check-in gives the same room');
  assert.equal(roomOf(room.number).status, 'occupied');

  const o = kit.merchant.overview(HOTEL);
  assert.equal(o.series.at(-1).xiaosu, 1, 'one 小宿 room night tonight');
  assert.equal(o.channels[0].nights, 1);
  assert.deepEqual(o.arrivals[0], { orderId: order.id, guest: '王*', roomType: order.room.name, nights: 2, source: 'xiaosu', status: 'checked_in' });
});

test('before 06:00 the hotel\'s day is the night in progress: a 凌晨 guest booked for "tonight" is arriving, then in-house', () => {
  t = at(`${addDays(TODAY, 1)}T00:30:00`); // 00:30 on Tuesday: Monday night is still under way
  const order = book({ stay: { checkIn: TODAY, checkOut: addDays(TODAY, 1) } });
  const grid = kit.merchant.rooms(HOTEL);
  assert.equal(grid.date, addDays(TODAY, 1), 'the calendar date, as the page asked for it');
  const room = allRooms(grid).find((r) => r.guest?.orderId === order.id);
  assert.equal(room.status, 'arriving');
  assert.equal(grid.counts.departing, 0, 'nobody leaves in the middle of the night');
  const o = kit.merchant.overview(HOTEL);
  assert.equal(o.date, addDays(TODAY, 1));
  assert.equal(o.series.at(-1).date, TODAY, 'tonight is the night that began yesterday');
  assert.equal(o.forecast[0].date, addDays(TODAY, 1));
  assert.deepEqual([o.arrivals[0].orderId, o.arrivals[0].status], [order.id, 'arriving']);
  assert.equal(kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in', orderId: order.id }).room.status, 'occupied');
  assert.equal(kit.merchant.createPromotion(HOTEL, { title: '凌晨特惠', discount: 0.9, from: TODAY, to: TODAY }).promotion.from, TODAY, 'that night can still be discounted');
  t = at(`${addDays(TODAY, 1)}T09:00:00`);
  assert.equal(roomOf(room.number).status, 'departing', 'in the morning: due out');
});

test('an early check-in (the demo allows one before the booked night) holds the room from the business day it happened', () => {
  t = at(`${addDays(TODAY, 1)}T05:20:00`); // 05:20 on Tuesday: for the hotel it is still Monday night
  const order = book({ stay: { checkIn: addDays(TODAY, 4), checkOut: addDays(TODAY, 6) } });
  const { stay } = kit.stays.checkIn({ userId: ALICE, orderId: order.id });
  assert.equal(stay.early, true);
  const room = allRooms(kit.merchant.rooms(HOTEL)).find((r) => r.number === stay.roomNumber);
  assert.equal(room.status, 'occupied');
  assert.deepEqual([room.guest?.orderId, room.guest?.source], [order.id, 'xiaosu']);
});

test('room actions today: clean a dirty room, take an empty one out of order and back; anything else is refused', () => {
  const rooms = allRooms(kit.merchant.rooms(HOTEL));
  const dirty = rooms.find((r) => r.status === 'dirty');
  const vacant = rooms.find((r) => r.status === 'vacant');
  const occupied = rooms.find((r) => r.status === 'occupied');
  const cleaned = kit.merchant.roomAction(HOTEL, dirty.number, { action: 'clean' }).room;
  assert.ok(['vacant', 'arriving'].includes(cleaned.status), cleaned.status);
  rejects(() => kit.merchant.roomAction(HOTEL, dirty.number, { action: 'clean' }), 'invalid_action', 409, /不是空脏房/);
  assert.equal(kit.merchant.roomAction(HOTEL, vacant.number, { action: 'ooo' }).room.status, 'ooo');
  assert.equal(roomOf(vacant.number).status, 'ooo');
  assert.equal(roomOf(vacant.number, addDays(TODAY, 1)).status !== 'ooo', true, 'only today');
  rejects(() => kit.merchant.roomAction(HOTEL, vacant.number, { action: 'ooo' }), 'invalid_action', 409);
  rejects(() => kit.merchant.roomAction(HOTEL, occupied.number, { action: 'ooo' }), 'invalid_action', 409, /有客人/);
  rejects(() => kit.merchant.roomAction(HOTEL, occupied.number, { action: 'release' }), 'invalid_action', 409, /不在维修/);
  assert.equal(kit.merchant.roomAction(HOTEL, vacant.number, { action: 'release' }).room.status, 'vacant');
  rejects(() => kit.merchant.roomAction(HOTEL, vacant.number, { action: 'paint' }), 'unknown_action', 400);
  rejects(() => kit.merchant.roomAction(HOTEL, '9999', { action: 'clean' }), 'room_not_found', 404);
  // The hotel's marks are for the day they were made.
  kit.merchant.roomAction(HOTEL, vacant.number, { action: 'ooo' });
  t = at(`${addDays(TODAY, 1)}T10:30:00`);
  assert.notEqual(roomOf(vacant.number).status, 'ooo');
});

test('front-desk check-in: only in the room stays.js gives the order (409 wrong_room names it); the guest gets the stay and an event', () => {
  const order = book();
  const room = allRooms(kit.merchant.rooms(HOTEL)).find((r) => r.guest?.orderId === order.id);
  const other = allRooms(kit.merchant.rooms(HOTEL)).find((r) => r.number !== room.number && r.status === 'vacant');
  assert.throws(() => kit.merchant.roomAction(HOTEL, other.number, { action: 'check_in', orderId: order.id }), (err) => {
    assert.equal(err.code, 'wrong_room');
    assert.equal(err.status, 409);
    assert.deepEqual(err.details, { roomNumber: room.number });
    assert.match(err.message, new RegExp(`房号是 ${room.number}`));
    return true;
  });
  rejects(() => kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in' }), 'invalid_order', 400);
  rejects(() => kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in', orderId: 'HA20990101000000' }), 'not_found', 404);
  const out = kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in', orderId: order.id });
  assert.equal(out.room.status, 'occupied');
  assert.equal(out.room.guest.orderId, order.id);
  assert.equal(out.event.kind, 'front_desk_checkin');
  assert.deepEqual([out.event.userId, out.event.sessionId, out.event.stay.roomNumber], [ALICE, 's1', room.number]);
  assert.equal(kit.stays.getStay(ALICE, order.id).roomNumber, room.number, 'the guest\'s stay');
  assert.equal(kit.bookings.previewCancellation({ userId: ALICE, orderId: order.id }).cancellable, false);
  rejects(() => kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in', orderId: order.id }), 'already_checked_in', 409);

  const future = book({ user: BOB, stay: { checkIn: addDays(TODAY, 3), checkOut: addDays(TODAY, 4) }, guests: ['欧阳娜娜'] });
  const futureRoom = kit.stays.listHotelStays(HOTEL).find((x) => x.order.id === future.id).roomNumber;
  rejects(() => kit.merchant.roomAction(HOTEL, futureRoom, { action: 'check_in', orderId: future.id }), 'not_arrived', 409);
  assert.equal(roomOf(futureRoom, addDays(TODAY, 3)).guest.name, '欧阳*');
  const cancelled = book({ user: BOB, planSuffix: 'BF2-FC', stay: { checkIn: addDays(TODAY, 1), checkOut: addDays(TODAY, 2) } });
  kit.bookings.cancelOrder({ userId: BOB, orderId: cancelled.id });
  rejects(() => kit.merchant.roomAction(HOTEL, room.number, { action: 'check_in', orderId: cancelled.id }), 'order_not_confirmed', 409, /取消/);
});

test('tickets: a 小宿 guest\'s towels are new, then 接单 → doing (配送中 for the guest), 送达 → done; wrong actions are 409', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const asked = kit.stays.requestService({ userId: ALICE, sessionId: 's1', items: [{ name: '毛巾', qty: 2 }], note: '放门口' });
  const list = kit.merchant.tickets(HOTEL).tickets;
  const mine = list.find((x) => x.id === asked.id);
  assert.deepEqual(mine, {
    id: asked.id, roomNumber: asked.roomNumber, guest: '王*', source: 'xiaosu', orderId: asked.orderId, kind: 'service', title: '毛巾 ×2',
    note: '放门口', createdAt: asked.createdAt, dueAt: asked.eta, status: 'new', actions: ['accept', 'deliver'],
  });
  assert.equal(list[0].id, asked.id, 'newest first');
  assert.ok(list.every((x, i) => i === 0 || x.createdAt <= list[i - 1].createdAt));
  rejects(() => kit.merchant.ticketAction(HOTEL, asked.id, { action: 'approve' }), 'invalid_action', 409);
  rejects(() => kit.merchant.ticketAction(HOTEL, asked.id, { action: 'fly' }), 'unknown_action', 400);
  t += 20 * 1000;
  const taken = kit.merchant.ticketAction(HOTEL, asked.id, { action: 'accept' });
  assert.deepEqual([taken.ticket.status, taken.ticket.actions], ['doing', ['deliver']]);
  assert.equal(taken.event, undefined, 'a delivery needs no notice: the guest\'s card moves');
  assert.equal(kit.stays.getRequest(ALICE, asked.id).status, 'on_the_way');
  assert.ok(allRooms(kit.merchant.rooms(HOTEL)).find((r) => r.number === asked.roomNumber).tickets >= 1, 'the room shows an open ticket');
  rejects(() => kit.merchant.ticketAction(HOTEL, asked.id, { action: 'accept' }), 'invalid_action', 409, /接过/);
  t += MIN;
  const done = kit.merchant.ticketAction(HOTEL, asked.id, { action: 'deliver' });
  assert.deepEqual([done.ticket.status, done.ticket.actions], ['done', []]);
  assert.equal(kit.stays.getRequest(ALICE, asked.id).status, 'done');
  rejects(() => kit.merchant.ticketAction(HOTEL, asked.id, { action: 'deliver' }), 'invalid_action', 409, /完成/);
  rejects(() => kit.merchant.ticketAction(HOTEL, 'SVnope', { action: 'accept' }), 'not_found', 404);
  // 打扫 is finished, not delivered.
  const clean = kit.stays.requestService({ userId: ALICE, items: ['打扫房间'] });
  assert.deepEqual(kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === clean.id).actions, ['accept', 'done']);
  // Done tickets stay for 24 hours.
  t += 25 * 60 * MIN;
  assert.equal(kit.merchant.tickets(HOTEL).tickets.some((x) => x.id === asked.id), false);
});

test('tickets: wake-ups and meals are read-only and finish on time; simulated ones can be handled too', () => {
  book();
  kit.stays.checkIn({ userId: ALICE });
  const wake = kit.stays.setWakeupCall({ userId: ALICE, time: '07:00' });
  const dinner = kit.stays.reserveDining({ userId: ALICE, kind: 'dinner', time: '18:30', people: 2 });
  const list = kit.merchant.tickets(HOTEL).tickets;
  const w = list.find((x) => x.id === wake.id);
  const d = list.find((x) => x.id === dinner.id);
  assert.deepEqual([w.kind, w.title, w.status, w.actions, w.dueAt], ['wakeup', '叫醒 07:00', 'doing', [], wake.at]);
  assert.deepEqual([d.kind, d.title, d.status, d.actions], ['dining', '晚餐 2位 18:30', 'doing', []]);
  assert.match(d.note, /号桌/);
  rejects(() => kit.merchant.ticketAction(HOTEL, w.id, { action: 'done' }), 'invalid_action', 409, /自动完成/);

  const sim = list.filter((x) => x.source === 'sim');
  assert.ok(sim.length > 0);
  for (const x of sim) {
    assert.ok(['service', 'early_checkin', 'wakeup', 'dining'].includes(x.kind) && x.title && x.roomNumber && /^[一-鿿]{1,2}\*$/.test(x.guest), JSON.stringify(x));
    assert.ok(Date.parse(x.createdAt) <= t, 'nothing from the future');
    assert.equal(x.orderId, undefined);
  }
  const grid = allRooms(kit.merchant.rooms(HOTEL));
  for (const x of sim.filter((y) => y.status !== 'done')) {
    assert.ok(grid.some((r) => r.number === x.roomNumber), `${x.roomNumber} is in the grid`);
  }
  // Some time in the day a simulated request waits for the front desk; handling it is stored.
  let waiting = null;
  for (let minute = 7 * 60; !waiting && minute < 23 * 60; minute += 10) {
    t = at(`${TODAY}T00:00:00`) + minute * MIN;
    waiting = kit.merchant.tickets(HOTEL).tickets.find((x) => x.source === 'sim' && x.actions.length);
  }
  assert.ok(waiting, 'something to do during the day');
  const handled = kit.merchant.ticketAction(HOTEL, waiting.id, { action: waiting.actions[0] });
  assert.notEqual(handled.ticket.status, waiting.status);
  assert.equal(kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === waiting.id).status, handled.ticket.status, 'stored');
  t += 3 * 60 * MIN;
  assert.equal(kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === waiting.id).status, waiting.kind === 'service' ? 'done' : handled.ticket.status, 'and never goes back');
});

test('tickets: early check-in approve / decline reach the guest (event, card, note); asked from 11:00 it is already confirmed', () => {
  book({ stay: { checkIn: addDays(TODAY, 1), checkOut: addDays(TODAY, 2) } });
  const early = kit.stays.requestEarlyCheckin({ userId: ALICE, sessionId: 's5', arrivalTime: '09:30' });
  const ticket = kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === early.id);
  assert.deepEqual([ticket.kind, ticket.title, ticket.status, ticket.actions], ['early_checkin', '提前入住 09:30', 'new', ['approve', 'decline']]);
  assert.equal(ticket.roomNumber, kit.stays.listHotelStays(HOTEL)[0].roomNumber, 'the room the guest will get');
  assert.equal(ticket.dueAt, new Date(at(`${addDays(TODAY, 1)}T09:30:00`)).toISOString());
  const yes = kit.merchant.ticketAction(HOTEL, early.id, { action: 'approve' });
  assert.equal(yes.ticket.status, 'done');
  assert.deepEqual([yes.event.kind, yes.event.userId, yes.event.sessionId], ['early_checkin_approved', ALICE, 's5']);
  assert.deepEqual([yes.event.request.status, yes.event.request.note], ['confirmed', '酒店已确认 09:30 可以入住']);
  rejects(() => kit.merchant.ticketAction(HOTEL, early.id, { action: 'decline' }), 'invalid_action', 409, /处理过/);

  const again = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '08:00' });
  const no = kit.merchant.ticketAction(HOTEL, again.id, { action: 'decline' });
  assert.deepEqual([no.ticket.status, no.event.kind, no.event.request.note], ['declined', 'early_checkin_declined', '那天房间比较满，按 14:00 入住哦']);
  assert.equal(kit.stays.getRequest(ALICE, early.id).status, 'declined');
  const noon = kit.stays.requestEarlyCheckin({ userId: ALICE, arrivalTime: '12:00' });
  assert.deepEqual(kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === noon.id).actions, [], 'confirmed by itself');
});

test('reviews: the hotel\'s history plus 小宿 guests\' published reviews (newest first); replies and drafted replies', () => {
  const first = kit.merchant.reviews(HOTEL);
  const hotel = kit.hotels.getHotel(HOTEL);
  assert.deepEqual([first.summary.rating, first.summary.count], [hotel.rating, hotel.reviewCount]);
  assert.equal(Object.values(first.summary.distribution).reduce((a, b) => a + b, 0), hotel.reviewCount);
  assert.ok(first.summary.distribution[5] > first.summary.distribution[1]);
  assert.ok(first.summary.tags.length > 0 && first.summary.tags.every((x) => x.tag && x.count > 0));
  assert.ok(first.reviews.length > 0 && first.reviews.every((r) => r.source === 'sim' && Date.parse(r.at) <= t && !/小宿/.test(JSON.stringify(r))));
  for (const r of first.reviews) {
    assert.ok(r.rating >= 1 && r.rating <= 5 && r.text.length <= 300 && /^[一-鿿]{1,2}\*$/.test(r.guest), JSON.stringify(r));
    if (r.reply) assert.ok(r.reply.text && r.reply.at > r.at);
  }

  const order = book();
  kit.stays.checkIn({ userId: ALICE });
  t += 60 * MIN;
  kit.stays.checkOut({ userId: ALICE });
  const draft = kit.stays.draftReview({ userId: ALICE, sessionId: 's6', rating: 2, text: '晚上太吵了，隔音不好' });
  assert.equal(kit.merchant.reviews(HOTEL).reviews.some((r) => r.id === draft.id), false, 'a draft is not public');
  kit.stays.publishReview({ userId: ALICE, reviewId: draft.id });
  const after = kit.merchant.reviews(HOTEL);
  assert.deepEqual(after.reviews[0], { id: draft.id, source: 'xiaosu', guest: '王*', rating: 2, text: '晚上太吵了，隔音不好', tags: [], roomType: order.room.name, at: new Date(t).toISOString() });
  assert.equal(after.summary.count, hotel.reviewCount + 1);
  assert.equal(after.summary.distribution[2], first.summary.distribution[2] + 1);

  const drafted = kit.merchant.draftReply(HOTEL, draft.id).text;
  assert.match(drafted, /抱歉/);
  assert.match(drafted, /隔音/, 'the drafted reply addresses what the guest complained about');
  assert.ok(drafted.length <= 300);
  rejects(() => kit.merchant.replyReview(HOTEL, draft.id, { text: ' ' }), 'invalid_reply', 400);
  rejects(() => kit.merchant.replyReview(HOTEL, draft.id, { text: '谢'.repeat(301) }), 'invalid_reply', 400, /300字/);
  rejects(() => kit.merchant.replyReview(HOTEL, 'RVnope', { text: '谢谢' }), 'not_found', 404);
  t += MIN;
  const out = kit.merchant.replyReview(HOTEL, draft.id, { text: drafted });
  assert.deepEqual(out.review.reply, { text: drafted, at: new Date(t).toISOString() });
  assert.deepEqual([out.event.kind, out.event.userId, out.event.sessionId], ['review_replied', ALICE, 's6']);
  assert.deepEqual(out.event.review.reply, out.review.reply, 'the guest\'s review card carries the reply');
  assert.deepEqual(kit.stays.getRequest(ALICE, draft.id).reply, out.review.reply);
  assert.equal(kit.merchant.replyReview(HOTEL, draft.id, { text: drafted }).event, undefined, 'the same reply again: no new notice');

  const sim = first.reviews.find((r) => !r.reply);
  const simReply = kit.merchant.replyReview(HOTEL, sim.id, { text: '感谢您的入住～' });
  assert.equal(simReply.event, undefined);
  assert.equal(kit.merchant.reviews(HOTEL).reviews.find((r) => r.id === sim.id).reply.text, '感谢您的入住～', 'stored');
  assert.ok(kit.merchant.draftReply(HOTEL, sim.id).text.length > 5);
});

test('promotions: validation, at most 5 running per hotel, switching on and off', () => {
  const ok = { title: '限时特惠', discount: 0.85, from: TODAY, to: addDays(TODAY, 6) };
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, discount: 0.4 }), 'invalid_discount', 400, /0.5/);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, discount: 0.96 }), 'invalid_discount', 400);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, discount: 'abc' }), 'invalid_discount', 400);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, from: addDays(TODAY, -1) }), 'invalid_date', 400, /已经过去/);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, to: addDays(TODAY, 61) }), 'invalid_date', 400, /60 天/);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, from: addDays(TODAY, 3), to: addDays(TODAY, 2) }), 'invalid_date', 400);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, to: '2026-02-30' }), 'invalid_date', 400);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, title: '  ' }), 'invalid_title', 400);
  rejects(() => kit.merchant.createPromotion(HOTEL, { ...ok, title: '特'.repeat(21) }), 'invalid_title', 400);
  rejects(() => kit.merchant.createPromotion('sim-hz-999', ok), 'hotel_not_found', 404);
  const { promotion } = kit.merchant.createPromotion(HOTEL, { ...ok, discount: '0.8', title: '【周末】特惠' });
  assert.deepEqual(promotion, { id: promotion.id, title: '周末特惠', discount: 0.8, from: TODAY, to: addDays(TODAY, 6), active: true, createdAt: new Date(t).toISOString(), stats: { views: 0, orders: 0 } });
  for (let i = 0; i < 4; i++) kit.merchant.createPromotion(HOTEL, ok);
  rejects(() => kit.merchant.createPromotion(HOTEL, ok), 'too_many_promotions', 409, /最多/);
  kit.merchant.createPromotion('sim-hz-016', ok);
  assert.equal(kit.merchant.listPromotions(HOTEL).promotions.length, 5);
  assert.equal(kit.merchant.listPromotions(HOTEL).promotions.at(-1).id, promotion.id, 'newest first');

  t += 120 * MIN;
  const off = kit.merchant.setPromotion(HOTEL, promotion.id, { active: false }).promotion;
  assert.equal(off.active, false);
  assert.ok(off.stats.views > 0, 'two hours on: some views');
  t += 120 * MIN;
  assert.equal(kit.merchant.setPromotion(HOTEL, promotion.id, { active: 'false' }).promotion.stats.views, off.stats.views, 'views stop while off');
  assert.equal(kit.merchant.setPromotion(HOTEL, promotion.id, { active: true }).promotion.active, true);
  rejects(() => kit.merchant.setPromotion(HOTEL, promotion.id, { active: 'yes' }), 'invalid_active', 400);
  rejects(() => kit.merchant.setPromotion(HOTEL, 'PMnope', { active: true }), 'not_found', 404);
  rejects(() => kit.merchant.setPromotion('sim-hz-016', promotion.id, { active: true }), 'not_found', 404, /特惠/);
  // Ended ones no longer count against the limit.
  t = at(`${addDays(TODAY, 7)}T10:00:00`);
  assert.equal(kit.merchant.createPromotion(HOTEL, { ...ok, from: addDays(TODAY, 7), to: addDays(TODAY, 8) }).promotion.active, true);
});

test('promotions: an active one discounts the nights it covers in search, rooms, quotes and orders (the deepest wins); orders already made stay', () => {
  const stay = { checkIn: TODAY, checkOut: addDays(TODAY, 2) };
  const search = () => kit.hotels.searchHotels({ city: '杭州', near: '西湖', ...stay, limit: 10 }).hotels.find((h) => h.id === HOTEL);
  const before = search();
  const old = book();
  assert.equal(before.promo, undefined);
  const { roomType, rate } = rateAt(HOTEL, stay);
  // Covers tonight only: one of the two nights is 85折.
  const { promotion } = kit.merchant.createPromotion(HOTEL, { title: '今晚特惠', discount: 0.85, from: TODAY, to: TODAY });
  const after = search();
  assert.deepEqual(after.promo, { id: promotion.id, title: '今晚特惠', discount: 0.85 });
  assert.ok(after.lowestPrice < before.lowestPrice, `${after.lowestPrice} < ${before.lowestPrice}`);
  const offer = kit.hotels.getRoomOffer({ hotelId: HOTEL, ...stay }).offer;
  const discounted = offer.roomTypes.find((rt) => rt.roomId === roomType.roomId).rates.find((r) => r.rateId === rate.rateId);
  assert.deepEqual(discounted.nightly, [{ date: TODAY, price: Math.round(rate.nightly[0].price * 0.85) }, rate.nightly[1]]);
  assert.equal(discounted.totalPrice, discounted.nightly[0].price + discounted.nightly[1].price);
  assert.deepEqual(discounted.promo, { id: promotion.id, title: '今晚特惠', discount: 0.85 });
  // A deeper one on the same night wins.
  const deeper = kit.merchant.createPromotion(HOTEL, { title: '闪促', discount: 0.7, from: TODAY, to: addDays(TODAY, 1) }).promotion;
  const best = kit.hotels.getRoomOffer({ hotelId: HOTEL, ...stay }).offer.roomTypes.find((rt) => rt.roomId === roomType.roomId).rates.find((r) => r.rateId === rate.rateId);
  assert.deepEqual(best.nightly.map((n) => n.price), rate.nightly.map((n) => Math.round(n.price * 0.7)));
  assert.equal(best.promo.id, deeper.id);
  // The quote charges what the rooms card showed; the order keeps the promotion it used.
  const quote = kit.bookings.prepareBooking({ userId: BOB, sessionId: 's2', hotelId: HOTEL, rateId: rate.rateId, ...stay, guests: ['李四'], contactPhone: '13812345678' });
  assert.equal(quote.totalPrice, best.totalPrice);
  const order = kit.bookings.payOrder({ userId: BOB, orderId: kit.bookings.confirmQuote({ userId: BOB, quoteId: quote.id }).id, method: 'alipay' });
  assert.deepEqual(order.rate.promo, { id: deeper.id, title: '闪促', discount: 0.7 });
  assert.equal(kit.merchant.listPromotions(HOTEL).promotions.find((p) => p.id === deeper.id).stats.orders, 1, 'the order it brought');
  assert.equal(kit.bookings.getOrder(ALICE, old.id).totalPrice, old.totalPrice, 'an order made before keeps its price');
  // Switched off: back to the usual price, and a quote made during the promotion is re-priced at confirm.
  const quote2 = kit.bookings.prepareBooking({ userId: BOB, sessionId: 's3', hotelId: HOTEL, rateId: rate.rateId, ...stay, guests: ['李四'], contactPhone: '13812345678' });
  kit.merchant.setPromotion(HOTEL, deeper.id, { active: false });
  kit.merchant.setPromotion(HOTEL, promotion.id, { active: false });
  assert.equal(search().lowestPrice, before.lowestPrice);
  assert.equal(search().promo, undefined);
  assert.throws(() => kit.bookings.confirmQuote({ userId: BOB, quoteId: quote2.id }), (e) => e instanceof BookingError && e.code === 'price_changed');
  // Another hotel is not touched.
  assert.equal(kit.hotels.searchHotels({ city: '杭州', ...stay, limit: 10 }).hotels.filter((h) => h.promo).length, 0);
});

test('maskName keeps only the surname', () => {
  assert.equal(maskName('李明'), '李*');
  assert.equal(maskName('欧阳娜娜'), '欧阳*');
  assert.equal(maskName('欧阳'), '欧*');
  assert.equal(maskName('John Smith'), 'Smith*');
  assert.equal(maskName(''), '客人');
});

test('end to end: a guest books and pays, asks for towels; the hotel takes and delivers them; a promotion shows in the guest\'s next search', async () => {
  const ctx = { userId: ALICE, sessionId: 'S1' };
  const found = await kit.tools.execute('search_hotels', { city: '杭州', near: '西湖', check_in: TODAY, check_out: addDays(TODAY, 1) }, ctx);
  const pick = found.card.hotels.find((h) => h.id === HOTEL);
  assert.ok(pick && pick.lowestPrice && !pick.promo);
  const rooms = await kit.tools.execute('get_hotel_rooms', { hotel_id: HOTEL, check_in: TODAY, check_out: addDays(TODAY, 1) }, ctx);
  const rate = rooms.card.offer.roomTypes.flatMap((rt) => rt.rates).find((r) => r.available);
  const quote = (await kit.tools.execute('prepare_booking', {
    hotel_id: HOTEL, rate_id: rate.rateId, check_in: TODAY, check_out: addDays(TODAY, 1), guest_names: ['王小明'], contact_phone: '13812345678',
  }, ctx)).card.quote;
  assert.equal(quote.totalPrice, rate.totalPrice);
  const order = kit.bookings.payOrder({ userId: ALICE, orderId: kit.bookings.confirmQuote({ userId: ALICE, quoteId: quote.id }).id, method: 'wechat' });

  // The hotel sees the guest coming and checks them in at the front desk.
  assert.equal(kit.merchant.listHotels().current, HOTEL);
  const arriving = allRooms(kit.merchant.rooms(HOTEL)).find((r) => r.guest?.orderId === order.id);
  assert.equal(arriving.status, 'arriving');
  const desk = kit.merchant.roomAction(HOTEL, arriving.number, { action: 'check_in', orderId: order.id });
  assert.equal(desk.room.status, 'occupied');

  // Towels: the guest asks, the hotel takes the ticket and brings them.
  const asked = await kit.tools.execute('request_service', { items: '送两条毛巾' }, ctx);
  const ticketId = asked.card.ticket.id;
  assert.equal(asked.card.ticket.roomNumber, arriving.number);
  const ticket = kit.merchant.tickets(HOTEL).tickets.find((x) => x.id === ticketId);
  assert.deepEqual([ticket.source, ticket.status, ticket.title, ticket.roomNumber], ['xiaosu', 'new', '毛巾 ×2', arriving.number]);
  t += 15 * 1000;
  kit.merchant.ticketAction(HOTEL, ticketId, { action: 'accept' });
  assert.equal(kit.stays.getRequest(ALICE, ticketId).status, 'on_the_way');
  t += 30 * 1000;
  kit.merchant.ticketAction(HOTEL, ticketId, { action: 'deliver' });
  const plans = kit.stays.listStays(ALICE)[0];
  assert.equal(plans.requests.find((r) => r.id === ticketId).status, 'done', 'the guest\'s request is done, well before the usual 5 minutes');

  // The hotel opens a promotion; the guest's next search shows the 特惠 price and tag.
  kit.merchant.createPromotion(HOTEL, { title: '限时特惠', discount: 0.85, from: TODAY, to: addDays(TODAY, 6) });
  const again = await kit.tools.execute('search_hotels', { city: '杭州', near: '西湖', check_in: TODAY, check_out: addDays(TODAY, 1) }, ctx);
  const promoted = again.card.hotels.find((h) => h.id === HOTEL);
  assert.deepEqual(promoted.promo, { id: promoted.promo.id, title: '限时特惠', discount: 0.85 });
  assert.equal(promoted.lowestPrice, Math.round(pick.lowestPrice * 0.85) || promoted.lowestPrice);
  assert.ok(promoted.lowestPrice < pick.lowestPrice);
  assert.match(again.content.hotels.find((h) => h.hotel_id === HOTEL).promo, /^限时特惠 85折/, 'the model hears about it too');
  const rates = await kit.tools.execute('get_hotel_rooms', { hotel_id: HOTEL, check_in: TODAY, check_out: addDays(TODAY, 1) }, ctx);
  assert.ok(rates.card.offer.roomTypes.flatMap((rt) => rt.rates).every((r) => r.promo?.discount === 0.85), 'every rate carries the promo');
});
