import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomOffer, lowestNightly, dayFactor, findRate, cancelPolicy, parseFloors, PRICE_DISCLAIMER, CURRENCY } from '../src/services/hotels/pricing.js';
import { HOLIDAYS, holidayOn, holidayMultiplier, upcomingHolidays, findHoliday, describeHoliday, describeUpcomingHolidays } from '../src/services/hotels/holidays.js';
import { CITIES, findCity } from '../src/services/hotels/sim-cities.js';
import { generateHotels, PRICE_RANGES } from '../src/services/hotels/sim-hotels.js';
import { addDays, dayOfWeek, todayIn } from '../src/util/dates.js';

const ny = findCity('New York');
const la = findCity('Los Angeles');
const lv = findCity('Las Vegas');
const mia = findCity('Miami');
const nola = findCity('New Orleans');
const nyHotels = generateHotels(ny);
const allHotels = CITIES.flatMap((c) => generateHotels(c).map((h) => ({ h, c })));
const byCat = (cat, list = nyHotels) => list.find((h) => h.category === cat && !h.amenities.includes('Free breakfast'));
const STAY = { checkIn: '2026-11-10', checkOut: '2026-11-11' };

/** The first room type's cheapest (first) rate for one night. */
function firstRate(hotel, date, city) {
  return buildRoomOffer(hotel, { checkIn: date, checkOut: addDays(date, 1), city }).roomTypes[0].rates[0];
}
/** Its room rate before taxes and fees (taxesAndFees includes any resort fee). */
function roomRate(hotel, date, city) {
  const r = firstRate(hotel, date, city);
  return r.totalPrice - r.taxesAndFees;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

test('offer shape matches the RoomOffer contract (USD, all-in nightly prices)', () => {
  const hotel = byCat('upscale');
  const offer = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-12', adults: 2, rooms: 1, city: ny });
  assert.equal(offer.hotelId, hotel.id);
  assert.equal(offer.nights, 2);
  assert.equal(offer.demo, true);
  assert.equal(offer.currency, 'USD');
  assert.equal(CURRENCY, 'USD');
  assert.equal(offer.priceDisclaimer, PRICE_DISCLAIMER);
  assert.equal(PRICE_DISCLAIMER, 'Simulated prices for the demo; totals include taxes and fees');
  for (const rt of offer.roomTypes) {
    assert.match(rt.roomId, /^R\d$/);
    for (const k of ['name', 'bed', 'floor']) assert.equal(typeof rt[k], 'string');
    assert.match(rt.bed, /^\d (?:King|Queen|Double|Twin)/);
    assert.ok(['Window', 'Interior (no window)', 'Floor-to-ceiling windows'].includes(rt.window), rt.window);
    assert.ok(Number.isInteger(rt.areaSqft) && rt.areaSqft >= 150, String(rt.areaSqft));
    assert.equal(rt.areaSqm, Math.round(rt.areaSqft / 10.7639));
    assert.match(rt.floor, /^Floors \d+–\d+$/);
    assert.ok(rt.maxOccupancy >= 2);
    assert.ok(rt.rates.length >= 2 && rt.rates.length <= 3);
    for (const r of rt.rates) {
      assert.ok(r.rateId.startsWith(`${rt.roomId}-`));
      assert.ok([0, 2].includes(r.breakfast));
      assert.equal(r.payment, 'prepay');
      assert.equal(r.nightly.length, 2);
      assert.deepEqual(r.nightly.map((n) => n.date), ['2026-11-10', '2026-11-11']);
      assert.ok(r.nightly.every((n) => Number.isInteger(n.price) && n.price > 0));
      assert.equal(r.totalPrice, r.nightly.reduce((s, n) => s + n.price, 0));
      assert.ok(Number.isInteger(r.taxesAndFees) && r.taxesAndFees > 0 && r.taxesAndFees < r.totalPrice * 0.3, `${r.rateId} taxes ${r.taxesAndFees}`);
      assert.equal(typeof r.available, 'boolean');
      assert.ok(['free', 'limited', 'none'].includes(r.cancelPolicy.type));
      assert.doesNotMatch(`${r.name} ${r.cancelPolicy.text}`, /[㐀-鿿]/);
    }
  }
});

test('every nightly price is all-in: (room rate + resort fee) × (1 + tax) + flat fees', () => {
  for (const { h, c } of allHotels.filter((_, i) => i % 5 === 0)) {
    const r = firstRate(h, '2026-11-10', c);
    const rate = roomRate(h, '2026-11-10', c);
    assert.match(String(rate), /9$/, `${h.id}: room rates end in 9 (${rate})`);
    const expected = Math.round((rate + (r.resortFee || 0)) * (1 + c.tax.rate) + c.tax.perNight);
    assert.ok(Math.abs(r.nightly[0].price - expected) <= 1, `${h.id} ${r.nightly[0].price} vs ${expected}`);
  }
  // New York: 14.75% plus $3.50 a night; New Orleans adds $3; Honolulu is the highest rate.
  assert.deepEqual(ny.tax, { rate: 0.1475, perNight: 3.5 });
  assert.equal(nola.tax.perNight, 3);
  assert.ok(CITIES.every((c) => c.tax.rate > 0.1 && c.tax.rate < 0.2), 'US hotel taxes are 10–20%');
});

test('resort fees only where the area charges them (the Strip, Waikiki, South Beach …)', () => {
  const strip = allHotels.filter(({ h, c }) => c.code === 'lv' && h.businessArea === 'The Strip');
  assert.ok(strip.length > 0);
  for (const { h, c } of strip) {
    const r = firstRate(h, '2026-11-10', c);
    assert.ok(r.resortFee >= 30 && r.resortFee <= 49, `${h.id} resort fee ${r.resortFee}`);
    assert.ok(r.taxesAndFees >= r.resortFee, 'the resort fee is part of taxes and fees');
  }
  for (const { h, c } of allHotels.filter(({ c }) => c.code === 'nyc' || c.code === 'chi')) {
    assert.equal(firstRate(h, '2026-11-10', c).resortFee, undefined, h.id);
  }
});

test('same inputs give identical offers (deterministic)', () => {
  const hotel = byCat('luxury');
  const opts = { checkIn: '2026-12-24', checkOut: '2026-12-27', adults: 2, rooms: 2, city: ny };
  assert.deepEqual(buildRoomOffer(hotel, opts), buildRoomOffer(hotel, opts));
  assert.deepEqual(generateHotels(ny), nyHotels);
  assert.equal(lowestNightly(hotel, opts), lowestNightly(hotel, opts));
});

test('room types per category: budget 2, midscale 3, upscale 4, luxury 4 with a suite', () => {
  const counts = { budget: 2, midscale: 3, upscale: 4, luxury: 4 };
  for (const { h, c } of allHotels) {
    const offer = buildRoomOffer(h, { ...STAY, city: c });
    assert.equal(offer.roomTypes.length, counts[h.category], `${h.id} ${h.category}`);
    const ids = offer.roomTypes[0].rates.map((r) => r.rateId);
    const freeBreakfast = h.amenities.includes('Free breakfast');
    assert.equal(ids[0], freeBreakfast ? 'R1-BB-NR' : 'R1-RO-NR', `${h.id}: the cheapest plan is non-refundable`);
    assert.ok(offer.roomTypes[0].rates.some((r) => r.cancelPolicy.type === 'free'), `${h.id} has a free-cancellation rate`);
    if (h.category === 'luxury') {
      assert.ok(offer.roomTypes.some((rt) => /Suite/.test(rt.name)), `${h.id} has a suite`);
      assert.ok(ids.includes('R1-BB-LC'), `${h.id} has Breakfast included · Cancel by 3 days before`);
    }
  }
});

test('rate ladder: non-refundable is cheapest; free cancellation costs $10+ a night more, breakfast more still', () => {
  for (const { h, c } of allHotels) {
    const offer = buildRoomOffer(h, { ...STAY, city: c });
    for (const rt of offer.roomTypes) {
      const [nr, ...others] = rt.rates;
      assert.equal(nr.cancelPolicy.type, 'none');
      assert.match(nr.name, / · Non-refundable$/);
      for (const r of others) {
        assert.ok(r.totalPrice > nr.totalPrice, `${h.id} ${r.rateId} ${r.totalPrice} vs ${nr.totalPrice}`);
        const uplift = r.totalPrice / nr.totalPrice;
        assert.ok(uplift >= 1.03 && uplift <= 1.3, `${h.id} ${rt.roomId} ${r.rateId} uplift ${uplift}`);
      }
      const fc = rt.rates.find((r) => r.rateId.endsWith('BB-FC'));
      if (fc) assert.equal(fc.name, 'Breakfast included · Free cancellation');
      const ro = rt.rates.find((r) => r.rateId.endsWith('RO-FC'));
      if (ro) assert.equal(ro.name, 'Room only · Free cancellation');
    }
  }
});

test('cancellation terms: free until 3 PM hotel time the day before, limited 3 days before, none = null', () => {
  const lux = byCat('luxury');
  const rates = buildRoomOffer(lux, { ...STAY, city: ny }).roomTypes[0].rates;
  const free = rates.find((r) => r.cancelPolicy.type === 'free');
  const limited = rates.find((r) => r.cancelPolicy.type === 'limited');
  const none = rates.find((r) => r.cancelPolicy.type === 'none');
  assert.equal(free.cancelPolicy.freeUntil, '2026-11-09T15:00:00-05:00');
  assert.equal(free.cancelPolicy.text, 'Free cancellation until 3:00 PM EST on Mon, Nov 9 (hotel time); after that the first night is charged.');
  assert.equal(limited.cancelPolicy.freeUntil, '2026-11-07T15:00:00-05:00');
  assert.match(limited.cancelPolicy.text, /^Limited cancellation: free cancellation until 3:00 PM EST on Sat, Nov 7/);
  assert.equal(limited.name, 'Breakfast included · Cancel by 3 days before');
  assert.equal(none.cancelPolicy.freeUntil, null);
  assert.match(none.cancelPolicy.text, /^Non-refundable/);
  // The deadline is the hotel's own 3 PM: Pacific time in Los Angeles, daylight time in summer.
  const laHotel = byCat('luxury', generateHotels(la));
  const laFree = buildRoomOffer(laHotel, { ...STAY, city: la }).roomTypes[0].rates.find((r) => r.cancelPolicy.type === 'free');
  assert.equal(laFree.cancelPolicy.freeUntil, '2026-11-09T15:00:00-08:00');
  assert.match(laFree.cancelPolicy.text, /3:00 PM PST on Mon, Nov 9/);
  assert.equal(cancelPolicy('free', '2027-07-02', null, 'America/New_York').freeUntil, '2027-07-01T15:00:00-04:00');
  assert.match(cancelPolicy('free', '2027-07-02', null, 'America/New_York').text, /3:00 PM EDT on Thu, Jul 1/);
});

test('once the free-cancel deadline has passed the wording says so (prices unchanged)', () => {
  const hotel = byCat('midscale');
  const opts = { checkIn: '2026-11-10', checkOut: '2026-11-11', city: ny };
  const before = buildRoomOffer(hotel, opts);
  const after = buildRoomOffer(hotel, { ...opts, now: new Date('2026-11-09T20:00:00Z') }); // 3:00 PM EST
  const fcBefore = before.roomTypes[0].rates.find((r) => r.cancelPolicy.type === 'free');
  const fcAfter = findRate(after, fcBefore.rateId).rate;
  assert.match(fcBefore.name, /· Free cancellation$/);
  assert.match(fcAfter.name, /· Cancellation fee applies$/);
  assert.match(fcAfter.cancelPolicy.text, /deadline \(3:00 PM EST on Mon, Nov 9\) has passed; cancelling now costs the first night/);
  assert.equal(fcAfter.totalPrice, fcBefore.totalPrice);
  const justBefore = buildRoomOffer(hotel, { ...opts, now: new Date('2026-11-09T19:59:00Z') });
  assert.match(findRate(justBefore, fcBefore.rateId).rate.name, /Free cancellation$/);
});

test('nights of the week follow the city\'s market: leisure peaks Fri/Sat, business midweek', () => {
  assert.equal(dayFactor('2026-11-14', 'leisure', lv), 1.7); // Sat on the Strip
  assert.equal(dayFactor('2026-11-11', 'leisure', lv), 0.95); // Wed
  assert.equal(dayFactor('2026-11-10', 'leisure', lv), 0.92); // Tue
  assert.equal(dayFactor('2026-11-11'), 1, 'a mixed market without a city: Wednesday is the base');
  assert.equal(dayFactor('2026-11-14', 'leisure'), 1.35);
  const ratio = (city, a, b) => mean(generateHotels(city).map((h) => firstRate(h, a, city).nightly[0].price / firstRate(h, b, city).nightly[0].price));
  const vegas = ratio(lv, '2026-11-14', '2026-11-11');
  assert.ok(vegas > 1.5 && vegas < 1.9, `Las Vegas Sat/Wed ${vegas}`);
  const sf = ratio(findCity('San Francisco'), '2026-11-14', '2026-11-11');
  assert.ok(sf > 0.85 && sf < 0.98, `San Francisco Sat/Wed ${sf} (business travelers go home)`);
});

test('in leisure cities a Saturday is never cheaper than the Friday before it (jitter is per week)', () => {
  let pairs = 0;
  for (const { h, c } of allHotels.filter(({ c }) => c.market === 'leisure')) {
    for (let w = 0; w < 12; w++) {
      const fri = addDays('2026-11-06', w * 7);
      if (holidayOn(fri, c.code) || holidayOn(addDays(fri, 1), c.code)) continue;
      for (const rt of buildRoomOffer(h, { checkIn: fri, checkOut: addDays(fri, 2), city: c }).roomTypes) {
        const [f, sat] = rt.rates[0].nightly.map((n) => n.price);
        assert.ok(sat >= f, `${h.id} ${rt.roomId} ${fri}: Fri ${f} > Sat ${sat}`);
        pairs++;
      }
    }
  }
  assert.ok(pairs > 2000, String(pairs));
});

test('holiday nights cost more, by market; city-specific windows only count in their cities', () => {
  // New Year's Eve, a Thursday, in New York (mixed): 1.05 × 1.6.
  assert.ok(Math.abs(dayFactor('2026-12-31', 'mixed', ny) - 1.05 * 1.6) < 1e-9);
  assert.equal(holidayMultiplier(holidayOn('2026-12-31'), 'business'), 1.25);
  assert.equal(holidayMultiplier(holidayOn('2026-12-31'), 'leisure'), 1.7);
  // Mardi Gras is a New Orleans affair; spring break is Miami, Orlando and Las Vegas.
  assert.equal(holidayOn('2027-02-08', 'nola').key, 'mardigras');
  assert.equal(holidayOn('2027-02-08', 'nyc'), null);
  assert.equal(holidayOn('2027-02-08'), null);
  assert.equal(holidayOn('2027-03-16', 'mia').key, 'springbreak');
  assert.equal(holidayOn('2027-03-16', 'chi'), null);
  assert.ok(dayFactor('2027-02-08', 'leisure', nola) > 1.5);
  assert.equal(dayFactor('2027-02-08', 'mixed', ny), 1, 'a Monday in New York');
  for (const h of HOLIDAYS) {
    for (const market of ['business', 'mixed', 'leisure']) {
      const m = holidayMultiplier(h, market);
      assert.ok(m >= 1.05 && m <= 1.8, `${h.name} ${h.start} ${market} ${m}`);
    }
  }
  // New Year's Eve vs an ordinary Thursday four weeks earlier in New York: ≈ 1.6 × the December season.
  const nye = mean(nyHotels.map((h) => firstRate(h, '2026-12-31', ny).nightly[0].price / firstRate(h, '2026-12-03', ny).nightly[0].price));
  assert.ok(nye > 1.4 && nye < 1.8, `New Year's Eve ratio ${nye}`);
  const mardi = mean(generateHotels(nola).map((h) => firstRate(h, '2027-02-08', nola).nightly[0].price / firstRate(h, '2027-02-22', nola).nightly[0].price));
  assert.ok(mardi > 1.5 && mardi < 2.1, `Mardi Gras ratio ${mardi}`);
});

test('seasons follow each city: Miami peaks in winter, stacked peaks are capped', () => {
  const ratio = mean(generateHotels(mia).map((h) => roomRate(h, '2027-01-13', mia) / roomRate(h, '2027-08-11', mia)));
  assert.ok(ratio > 1.4 && ratio < 1.9, `Miami January/August ${ratio}`);
  // A Saturday New Year's weekend in Las Vegas would stack 1.7 × 1.7; the cap keeps it at 2.3× the anchor (±8%).
  for (const h of generateHotels(lv)) {
    const rate = roomRate(h, '2027-01-01', lv);
    assert.ok(rate <= h.priceHint * 2.3 * 1.08 + 10, `${h.id} ${rate} vs hint ${h.priceHint}`);
  }
});

test('weekday room rates stay within ±8% jitter of the anchor (plus rounding)', () => {
  // A Wednesday in a month whose season factor is 1 for the city.
  for (const { h, c } of allHotels) {
    const date = c.season[4] === 1 ? '2027-05-12' : c.season[3] === 1 ? '2027-04-14' : null;
    if (!date) continue;
    const anchor = h.priceHint * c.weekdays[3];
    const rate = roomRate(h, date, c);
    assert.ok(rate >= anchor * 0.92 - 10 && rate <= anchor * 1.08 + 10, `${h.id} ${rate} vs ${anchor}`);
  }
});

test('realistic USD anchors by category, scaled by the city\'s price level', () => {
  const nonInn = allHotels.filter(({ h, c }) => c.areas.find((a) => a.name === h.businessArea).kind !== 'inn');
  for (const { h, c } of nonInn) {
    const [lo, hi] = PRICE_RANGES[h.category];
    // Area kinds move rates by 0.85–1.12 and the rating by 0.94–1.06.
    assert.ok(h.priceHint >= lo * c.priceLevel * 0.85 * 0.94 - 10 && h.priceHint <= hi * c.priceLevel * 1.12 * 1.06 + 10, `${h.id} ${c.code} ${h.category} ${h.priceHint}`);
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const med = (code, cat) => median(allHotels.filter(({ h, c }) => c.code === code && h.category === cat).map(({ h }) => h.priceHint));
  for (const cat of ['budget', 'midscale', 'upscale', 'luxury']) {
    assert.ok(med('nyc', cat) > med('lv', cat), `New York ${cat} above Las Vegas`);
  }
  assert.ok(med('nyc', 'midscale') >= 200 && med('nyc', 'midscale') <= 320, `NYC midscale median ${med('nyc', 'midscale')}`);
  assert.ok(med('lv', 'midscale') >= 90 && med('lv', 'midscale') <= 170, `Las Vegas midscale median ${med('lv', 'midscale')}`);
  const lux = allHotels.filter(({ h }) => h.category === 'luxury').map(({ h }) => h.priceHint);
  assert.ok(Math.min(...lux) >= 300 && Math.max(...lux) <= 1300, `luxury ${Math.min(...lux)}–${Math.max(...lux)}`);
});

test('about 10% of (hotel, date, room type) combos are sold out, deterministically; more on holidays', () => {
  let total = 0;
  let soldOut = 0;
  let holidayTotal = 0;
  let holidaySold = 0;
  for (const { h, c } of allHotels.filter((_, i) => i % 3 === 0)) {
    for (let i = 0; i < 40; i++) {
      const date = addDays('2026-11-30', i);
      const offer = buildRoomOffer(h, { checkIn: date, checkOut: addDays(date, 1), city: c });
      for (const rt of offer.roomTypes) {
        const sold = !rt.rates[0].available;
        if (sold) {
          assert.equal(rt.rates[0].remaining, 0);
          assert.equal(rt.rates[0].unavailableReason, 'sold_out');
        }
        if (holidayOn(date, c.code)) {
          holidayTotal++;
          if (sold) holidaySold++;
        } else {
          total++;
          if (sold) soldOut++;
        }
      }
    }
  }
  const share = soldOut / total;
  assert.ok(share > 0.07 && share < 0.13, `sold-out share ${share}`);
  const holidayShare = holidaySold / holidayTotal;
  assert.ok(holidayShare > 0.16 && holidayShare < 0.3, `holiday sold-out share ${holidayShare}`);
});

test('maxOccupancy: rooms × maxOccupancy must cover the party', () => {
  const hotel = byCat('upscale');
  const three = buildRoomOffer(hotel, { ...STAY, adults: 3, rooms: 1, city: ny });
  for (const rt of three.roomTypes) {
    for (const r of rt.rates) {
      if (rt.maxOccupancy < 3) {
        assert.equal(r.available, false);
        assert.equal(r.unavailableReason, 'occupancy', 'not fitting is not sold out');
      }
    }
  }
  const twoRooms = buildRoomOffer(hotel, { ...STAY, adults: 3, rooms: 2, city: ny });
  assert.ok(twoRooms.roomTypes.some((rt) => rt.maxOccupancy === 2 && rt.rates.some((r) => r.available)));
  assert.equal(lowestNightly(hotel, { ...STAY, adults: 7, rooms: 1, city: ny }), null);
});

test('children count as occupants but do not change the price', () => {
  const hotel = byCat('upscale');
  const opts = { ...STAY, adults: 2, rooms: 1, city: ny };
  const adultsOnly = buildRoomOffer(hotel, opts);
  const withChild = buildRoomOffer(hotel, { ...opts, children: 1 });
  assert.equal(withChild.children, 1);
  assert.equal(adultsOnly.children, 0);
  for (const [i, rt] of withChild.roomTypes.entries()) {
    for (const [j, r] of rt.rates.entries()) {
      assert.equal(r.totalPrice, adultsOnly.roomTypes[i].rates[j].totalPrice);
      if (rt.maxOccupancy < 3) assert.deepEqual([r.available, r.unavailableReason], [false, 'occupancy']);
    }
  }
  assert.ok(withChild.roomTypes.some((rt) => rt.maxOccupancy === 4 && rt.rates.some((r) => r.available || r.unavailableReason === 'sold_out')), 'a room with two queens is offered');
});

test('long stays are usually bookable: sell-outs come in runs, not independent nights', () => {
  for (const c of [ny, lv, mia]) {
    const list = generateHotels(c);
    const bookable = list.filter((h) => lowestNightly(h, { checkIn: '2026-11-09', checkOut: '2026-12-09', city: c }) !== null);
    assert.ok(bookable.length >= list.length * 0.6, `${c.name} 30 nights: ${bookable.length}/${list.length}`);
  }
});

test('historic inn areas (French Quarter, Garden District) get low-rise rooms whatever the hotel\'s name', () => {
  let n = 0;
  for (const { h, c } of allHotels) {
    if (c.areas.find((a) => a.name === h.businessArea).kind !== 'inn') continue;
    n++;
    for (const rt of buildRoomOffer(h, { ...STAY, city: c }).roomTypes) {
      assert.match(rt.floor, /^Floors 1–[23]$/, `${h.id} ${h.name} ${rt.name} ${rt.floor}`);
      assert.deepEqual(parseFloors(rt.floor).map((x) => x <= 3), [true, true]);
    }
  }
  assert.ok(n >= 6, String(n));
  assert.deepEqual(parseFloors('Floors 4–18'), [4, 18]);
  assert.equal(parseFloors('Ground floor'), null);
});

test('rooms multiply the total; lowestNightly is the cheapest bookable per-room average', () => {
  const hotel = byCat('midscale');
  const one = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', rooms: 1, city: ny });
  const two = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', rooms: 2, adults: 4, city: ny });
  const r1 = findRate(one, 'R1-RO-NR').rate;
  const r2 = findRate(two, 'R1-RO-NR').rate;
  assert.equal(r2.totalPrice, r1.totalPrice * 2);
  assert.equal(r2.taxesAndFees, r1.taxesAndFees * 2);
  const avgs = one.roomTypes.flatMap((rt) => rt.rates.filter((r) => r.available).map((r) => Math.round(r.totalPrice / 3)));
  assert.equal(lowestNightly(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', city: ny }), Math.min(...avgs));
});

test('city may be passed as a name or omitted (looked up from hotel.city)', () => {
  const hotel = nyHotels[0];
  const a = buildRoomOffer(hotel, { ...STAY, city: ny });
  const b = buildRoomOffer(hotel, { ...STAY, city: 'New York' });
  const c = buildRoomOffer(hotel, STAY);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.throws(() => buildRoomOffer(hotel, { checkIn: '2026-11-11', checkOut: '2026-11-10' }), RangeError);
});

test('every view tag has a matching view room, and a hotel has at most one view tag', () => {
  const views = [['Ocean view', 'Ocean View'], ['Bay view', 'Bay View'], ['Lake view', 'Lake View'], ['River view', 'River View'],
    ['Park view', 'Park View'], ['Mountain view', 'Mountain View'], ['City view', 'City View']];
  let tagged = 0;
  for (const { h, c } of allHotels) {
    const mine = views.filter(([tag]) => h.tags.includes(tag));
    assert.ok(mine.length <= 1, `${h.id} ${h.tags.join()}`);
    if (!mine.length) continue;
    tagged++;
    assert.notEqual(h.category, 'budget', `${h.id}: budget rooms have no view template`);
    const names = buildRoomOffer(h, { ...STAY, city: c }).roomTypes.map((r) => r.name);
    assert.ok(names.some((n) => n.startsWith(mine[0][1])), `${h.id} ${h.name} ${mine[0][0]}: ${names.join()}`);
  }
  assert.ok(tagged > 40, String(tagged));
});

test('holidays follow the federal rules for 2026 and 2027', () => {
  const at = (key, year) => HOLIDAYS.find((h) => h.key === key && h.year === year);
  // [festival, first night, last night]
  const expected = {
    mlk: [['2026-01-19', '2026-01-16', '2026-01-18'], ['2027-01-18', '2027-01-15', '2027-01-17']], // third Monday of January
    presidents: [['2026-02-16', '2026-02-13', '2026-02-15'], ['2027-02-15', '2027-02-12', '2027-02-14']], // third Monday of February
    mardigras: [['2026-02-17', '2026-02-13', '2026-02-17'], ['2027-02-09', '2027-02-05', '2027-02-09']], // 47 days before Easter
    memorial: [['2026-05-25', '2026-05-22', '2026-05-24'], ['2027-05-31', '2027-05-28', '2027-05-30']], // last Monday of May
    july4: [['2026-07-04', '2026-07-03', '2026-07-05'], ['2027-07-04', '2027-07-02', '2027-07-04']],
    labor: [['2026-09-07', '2026-09-04', '2026-09-06'], ['2027-09-06', '2027-09-03', '2027-09-05']], // first Monday of September
    thanksgiving: [['2026-11-26', '2026-11-25', '2026-11-28'], ['2027-11-25', '2027-11-24', '2027-11-27']], // fourth Thursday of November
  };
  for (const [key, [y26, y27]] of Object.entries(expected)) {
    for (const [festival, start, end] of [y26, y27]) {
      const h = at(key, Number(festival.slice(0, 4)));
      assert.deepEqual([h.festival, h.start, h.end], [festival, start, end], `${key} ${festival}`);
    }
  }
  for (const h of HOLIDAYS.filter((x) => ['mlk', 'presidents', 'memorial', 'labor'].includes(x.key))) {
    assert.equal(dayOfWeek(h.festival), 1, `${h.name} ${h.festival} is a Monday`);
    assert.equal(dayOfWeek(h.start), 5, `${h.name} starts on a Friday night`);
    assert.equal(h.nights, 3);
  }
  for (const h of HOLIDAYS.filter((x) => x.key === 'thanksgiving')) assert.equal(dayOfWeek(h.festival), 4);
  for (const h of HOLIDAYS) assert.ok(h.start <= h.end && h.nights >= 3, `${h.name} ${h.start}`);
  assert.deepEqual(at('mardigras', 2027).cities, ['nola']);
  assert.deepEqual([...at('springbreak', 2027).cities].sort(), ['lv', 'mia', 'orl']);
  assert.equal(at('springbreak', 2027).long, true);
});

test('the holiday table covers every year the 365-day booking window can reach', () => {
  const keys = ['newyear', 'mlk', 'presidents', 'mardigras', 'springbreak', 'memorial', 'july4', 'labor', 'thanksgiving', 'christmas'];
  for (const year of [2026, 2027]) {
    for (const key of keys) assert.ok(HOLIDAYS.some((h) => h.key === key && h.year === year), `${year} ${key}`);
  }
  // Holidays repeat every year, so a table that runs past the horizon lists every holiday a booking can reach.
  const horizon = addDays(todayIn('America/New_York'), 365);
  const last = HOLIDAYS.map((h) => h.end).sort().pop();
  assert.ok(last >= horizon, `the table ends ${last}, before ${horizon}: add the next year's holidays`);
  assert.equal(holidayOn('2027-12-31').key, 'newyear');
});

test('holiday lookups', () => {
  assert.equal(holidayOn('2026-11-27').name, 'Thanksgiving');
  assert.equal(holidayOn('2026-11-29'), null);
  assert.equal(findHoliday('Thanksgiving in Chicago', '2026-11-04').start, '2026-11-25');
  assert.equal(findHoliday('thanksgiving', '2026-11-27').start, '2026-11-25', 'an ongoing holiday still counts');
  assert.equal(findHoliday('4th of July weekend', '2026-11-04').start, '2027-07-02');
  assert.equal(findHoliday('over July 4th', '2026-11-04').key, 'july4');
  assert.equal(findHoliday("New Year's Eve in Vegas", '2026-11-04').start, '2026-12-30');
  assert.equal(findHoliday('spring break', '2026-11-04').key, 'springbreak');
  assert.equal(findHoliday('Memorial Day', '2026-11-04').year, 2027);
  assert.equal(findHoliday('a laboratory tour', '2026-11-04'), null, 'whole words only');
  assert.equal(findHoliday('next weekend', '2026-11-04'), null);
  assert.equal(findHoliday('', '2026-11-04'), null);
});

test('holiday descriptions for the prompt', () => {
  const next = upcomingHolidays('2026-11-04', { count: 3 });
  assert.deepEqual(next.map((h) => h.key), ['thanksgiving', 'christmas', 'newyear']);
  assert.ok(upcomingHolidays('2027-01-20', { count: 3 }).every((h) => !h.cities), 'nationwide only by default');
  assert.ok(upcomingHolidays('2027-01-20', { count: 3, cityCode: 'nola' }).some((h) => h.key === 'mardigras'));
  const text = describeUpcomingHolidays('2026-11-04');
  assert.match(text, /^Thanksgiving \(Thu, Nov 26\): nights Wed, Nov 25 – Sat, Nov 28/);
  assert.equal(describeHoliday(HOLIDAYS.find((h) => h.key === 'mardigras' && h.year === 2027), '2026-11-04'),
    'Mardi Gras (Tue, Feb 9, 2027) in New Orleans: nights Fri, Feb 5, 2027 – Tue, Feb 9, 2027');
  assert.equal(describeHoliday(HOLIDAYS.find((h) => h.key === 'springbreak' && h.year === 2027), '2027-01-01'),
    'Spring break in Miami, Orlando, Las Vegas: nights Fri, Mar 5 – Sat, Apr 3');
  assert.doesNotMatch(text, /[㐀-鿿]/);
});
