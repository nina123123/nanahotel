import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomOffer, lowestNightly, dayFactor, findRate, PRICE_DISCLAIMER } from '../src/services/hotels/pricing.js';
import { HOLIDAYS, holidayOn, isHolidayEve, isMakeupWorkday, upcomingHolidays, findHoliday, describeHoliday, describeUpcomingHolidays, holidayStartingOn } from '../src/services/hotels/holidays.js';
import { CITIES, findCity } from '../src/services/hotels/sim-cities.js';
import { generateHotels } from '../src/services/hotels/sim-hotels.js';
import { addDays, dayOfWeek, todayCN } from '../src/util/dates.js';

const hz = findCity('杭州');
const sy = findCity('三亚');
const bj = findCity('北京');
const hzHotels = generateHotels(hz);
const allHotels = CITIES.flatMap((c) => generateHotels(c).map((h) => ({ h, c })));
const byCat = (cat) => hzHotels.find((h) => h.category === cat);

function r1Nr(hotel, date, city) {
  const offer = buildRoomOffer(hotel, { checkIn: date, checkOut: addDays(date, 1), city });
  return offer.roomTypes[0].rates.find((r) => r.rateId === 'R1-BF0-NR').nightly[0].price;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

test('offer shape matches the RoomOffer contract', () => {
  const hotel = byCat('premium');
  const offer = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-12', adults: 2, rooms: 1, city: hz });
  assert.equal(offer.hotelId, hotel.id);
  assert.equal(offer.nights, 2);
  assert.equal(offer.demo, true);
  assert.equal(offer.priceDisclaimer, PRICE_DISCLAIMER);
  assert.equal(offer.priceDisclaimer, '价格为模拟数据，仅供演示');
  for (const rt of offer.roomTypes) {
    assert.match(rt.roomId, /^R\d$/);
    for (const k of ['name', 'bed', 'floor']) assert.equal(typeof rt[k], 'string');
    assert.ok(['有窗', '无窗', '落地窗'].includes(rt.window));
    assert.ok(Number.isInteger(rt.areaSqm) && rt.areaSqm >= 14);
    assert.ok(rt.maxOccupancy >= 2);
    assert.ok(rt.rates.length >= 2 && rt.rates.length <= 3);
    for (const r of rt.rates) {
      assert.ok(r.rateId.startsWith(`${rt.roomId}-`));
      assert.ok([0, 1, 2].includes(r.breakfast));
      assert.equal(r.payment, 'prepay');
      assert.equal(r.nightly.length, 2);
      assert.deepEqual(r.nightly.map((n) => n.date), ['2026-11-10', '2026-11-11']);
      assert.ok(r.nightly.every((n) => Number.isInteger(n.price) && n.price > 0));
      assert.equal(r.totalPrice, r.nightly.reduce((s, n) => s + n.price, 0));
      assert.equal(typeof r.available, 'boolean');
      assert.ok(['free', 'limited', 'none'].includes(r.cancelPolicy.type));
    }
  }
});

test('same inputs give identical offers (deterministic)', () => {
  const hotel = byCat('luxury');
  const opts = { checkIn: '2026-12-24', checkOut: '2026-12-27', adults: 2, rooms: 2, city: hz };
  assert.deepEqual(buildRoomOffer(hotel, opts), buildRoomOffer(hotel, opts));
  assert.deepEqual(generateHotels(hz), hzHotels);
  assert.equal(lowestNightly(hotel, opts), lowestNightly(hotel, opts));
});

test('room types per category: economy 2, comfort 3, premium 4, luxury 4 with a suite', () => {
  const counts = { economy: 2, comfort: 3, premium: 4, luxury: 4 };
  for (const { h, c } of allHotels) {
    const offer = buildRoomOffer(h, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: c });
    assert.equal(offer.roomTypes.length, counts[h.category], `${h.id} ${h.category}`);
    const ids = offer.roomTypes.flatMap((rt) => rt.rates.map((r) => r.rateId));
    assert.ok(ids.includes('R1-BF0-NR') && ids.includes('R1-BF2-FC'), `${h.id} has the two universal rate ids`);
    if (h.category === 'luxury') {
      assert.ok(offer.roomTypes.some((rt) => rt.name.includes('套房')), `${h.id} has a 套房`);
      assert.ok(ids.includes('R1-BF2-LC'), `${h.id} has 含双早·限时取消`);
    }
  }
});

test('rate ladder: 不可取消 is cheapest; 含早·免费取消 costs +12–25%', () => {
  for (const { h, c } of allHotels.slice(0, 120)) {
    const offer = buildRoomOffer(h, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: c });
    for (const rt of offer.roomTypes) {
      const nr = rt.rates.find((r) => r.rateId.endsWith('BF0-NR'));
      const fc = rt.rates.find((r) => r.rateId.endsWith('BF2-FC'));
      assert.equal(nr.name, '不含早 · 不可取消');
      assert.equal(fc.name, '含双早 · 免费取消');
      for (const r of rt.rates) assert.ok(r.totalPrice >= nr.totalPrice, `${h.id} ${r.rateId}`);
      const uplift = fc.totalPrice / nr.totalPrice;
      assert.ok(uplift >= 1.09 && uplift <= 1.28, `${h.id} ${rt.roomId} uplift ${uplift}`);
    }
  }
});

test('cancel policies: free = day before check-in 18:00 +08:00, limited = 3 days before, none = null', () => {
  const lux = byCat('luxury');
  const offer = buildRoomOffer(lux, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: hz });
  const rates = offer.roomTypes[0].rates;
  const free = rates.find((r) => r.cancelPolicy.type === 'free');
  const limited = rates.find((r) => r.cancelPolicy.type === 'limited');
  const none = rates.find((r) => r.cancelPolicy.type === 'none');
  assert.equal(free.cancelPolicy.freeUntil, '2026-11-09T18:00:00+08:00');
  assert.match(free.cancelPolicy.text, /11月9日 18:00前可免费取消/);
  assert.equal(limited.cancelPolicy.freeUntil, '2026-11-07T18:00:00+08:00');
  assert.match(limited.cancelPolicy.text, /^限时取消/);
  assert.equal(limited.name, '含双早 · 限时取消');
  assert.equal(none.cancelPolicy.freeUntil, null);
  assert.match(none.cancelPolicy.text, /不可取消/);
});

test('once the free-cancel deadline has passed the wording says so (prices unchanged)', () => {
  const hotel = byCat('comfort');
  const opts = { checkIn: '2026-10-25', checkOut: '2026-10-26', city: hz };
  const before = buildRoomOffer(hotel, opts);
  const after = buildRoomOffer(hotel, { ...opts, now: new Date('2026-10-25T10:00:00+08:00') });
  const fcBefore = findRate(before, 'R1-BF2-FC').rate;
  const fcAfter = findRate(after, 'R1-BF2-FC').rate;
  assert.equal(fcBefore.name, '含双早 · 免费取消');
  assert.equal(fcAfter.name, '含双早 · 取消收首晚');
  assert.match(fcAfter.cancelPolicy.text, /已过/);
  assert.equal(fcAfter.totalPrice, fcBefore.totalPrice);
});

test('weekend nights: Friday +15%, Saturday +25% over weekday nights', () => {
  assert.equal(dayFactor('2026-11-13', 'tier1'), 1.15); // Fri
  assert.equal(dayFactor('2026-11-14', 'tier1'), 1.25); // Sat
  assert.equal(dayFactor('2026-11-15', 'tier1'), 1); // Sun
  assert.equal(dayFactor('2026-11-11', 'tier1'), 1); // Wed
  const ratios = allHotels.filter(({ c }) => !c.season).map(({ h, c }) => r1Nr(h, '2026-11-13', c) / r1Nr(h, '2026-11-11', c));
  const avg = mean(ratios);
  assert.ok(avg > 1.1 && avg < 1.2, `avg Friday ratio ${avg}`);
});

test('a Saturday is never cheaper than the Friday before it (jitter is per week, not per night)', () => {
  let pairs = 0;
  for (const { h, c } of allHotels) {
    for (let w = 0; w < 12; w++) {
      const fri = addDays('2026-11-06', w * 7);
      if (dayFactor(fri, c.tier) !== 1.15 || dayFactor(addDays(fri, 1), c.tier) !== 1.25) continue; // holidays / 调休
      for (const rt of buildRoomOffer(h, { checkIn: fri, checkOut: addDays(fri, 2), city: c }).roomTypes) {
        const [f, sat] = rt.rates[0].nightly.map((n) => n.price);
        assert.ok(sat >= f, `${h.id} ${rt.roomId} ${fri}: Fri ${f} > Sat ${sat}`);
        pairs++;
      }
    }
  }
  assert.ok(pairs > 3000, String(pairs));
});

test('holiday nights cost ×1.3–1.8; the eve is a peak night, the last night is ordinary; 调休 eves have no weekend premium', () => {
  assert.equal(dayFactor('2027-10-02', 'new_tier1'), 1.6); // 国庆
  assert.equal(dayFactor('2027-10-02', 'tourist'), 1.8);
  assert.equal(dayFactor('2027-02-07', 'tier1'), 1.3); // 春节
  assert.equal(dayFactor('2027-09-30', 'tier1'), 1.6); // eve of 国庆 (Thursday): the peak departure night
  assert.equal(dayFactor('2027-09-30', 'tourist'), 1.8);
  assert.equal(dayFactor('2027-10-07', 'tier1'), 1, 'last night of 国庆: everyone is heading home');
  assert.equal(dayFactor('2027-10-07', 'tourist'), 1);
  assert.equal(dayFactor('2027-02-13', 'tier1'), 1, 'last night of 春节, a Saturday before a 调休 Sunday');
  assert.equal(dayFactor('2027-06-09', 'tier1'), 1.3, 'a one-day holiday keeps its premium');
  assert.equal(dayFactor('2026-10-09', 'tier1'), 1); // Friday before 调休 Saturday 10-10
  assert.equal(dayFactor('2027-10-08', 'tier1'), 1); // Friday before 调休 Saturday 2027-10-09
  for (const h of HOLIDAYS) {
    for (const tier of ['tier1', 'tourist']) {
      const f = dayFactor(h.start, tier);
      assert.ok(f >= 1.3 && f <= 1.8, `${h.name} ${h.start} ${tier} ${f}`);
    }
  }
  // 国庆 Saturday vs an ordinary Saturday two weeks later: ≈ 1.6 / 1.25
  const ratios = allHotels.filter(({ c }) => !c.season).map(({ h, c }) => r1Nr(h, '2027-10-02', c) / r1Nr(h, '2027-10-16', c));
  const avg = mean(ratios);
  assert.ok(avg > 1.2 && avg < 1.36, `avg holiday ratio ${avg}`);
});

test('tourist cities are seasonal and stacked peaks are capped', () => {
  const syHotels = generateHotels(sy);
  // Mid-week January (peak) vs mid-week June (low season) in 三亚
  const ratio = mean(syHotels.map((h) => r1Nr(h, '2027-01-13', sy) / r1Nr(h, '2027-06-16', sy)));
  assert.ok(ratio > 1.5 && ratio < 1.9, `三亚 season ratio ${ratio}`);
  // 春节 (×1.8) in February (×1.4) would be ×2.52; the cap keeps it at ×2.3 of the anchor ±8% jitter.
  for (const h of syHotels) {
    const price = r1Nr(h, '2027-02-07', sy);
    assert.ok(price <= h.priceHint * 2.3 * 1.08 + 10, `${h.id} ${price} vs hint ${h.priceHint}`);
  }
});

test('weekday prices stay within ±8% jitter of the anchor (plus rounding)', () => {
  for (const { h, c } of allHotels.filter(({ c }) => !c.season)) {
    const p = r1Nr(h, '2026-11-11', c);
    assert.ok(p >= h.priceHint * 0.92 - 10 && p <= h.priceHint * 1.08 + 10, `${h.id} ${p} vs ${h.priceHint}`);
    assert.ok(/[89]$/.test(String(p)), `${p} ends in 8 or 9`);
  }
});

test('realistic RMB anchors by tier and category (RESEARCH-booking §3.2 bands)', () => {
  const ranges = {
    tier1: { economy: [180, 420], comfort: [320, 720], premium: [500, 1150], luxury: [900, 3200] },
    new_tier1: { economy: [130, 320], comfort: [200, 520], premium: [380, 880], luxury: [600, 2000] },
    tourist: { economy: [120, 330], comfort: [220, 560], premium: [400, 1100], luxury: [700, 2600] },
  };
  for (const { h, c } of allHotels) {
    const [lo, hi] = ranges[c.tier][h.category];
    assert.ok(h.priceHint >= lo && h.priceHint <= hi, `${h.id} ${c.tier} ${h.category} ${h.priceHint}`);
  }
  // Medians stay close to the ADR-anchored §3.2 values, so the inflation (1.3–2.7×) cannot creep back.
  const anchors = { tier1: [250, 420, 700, 1200], new_tier1: [180, 320, 500, 850], tourist: [180, 300, 600, 1100] };
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const med = (tier, cat) => median(allHotels.filter(({ h, c }) => c.tier === tier && h.category === cat).map(({ h }) => h.priceHint));
  ['economy', 'comfort', 'premium', 'luxury'].forEach((cat, i) => {
    for (const tier of Object.keys(anchors)) {
      const ratio = med(tier, cat) / anchors[tier][i];
      assert.ok(ratio >= 0.9 && ratio <= (cat === 'luxury' ? 1.9 : 1.4), `${tier} ${cat} median ${med(tier, cat)} vs ${anchors[tier][i]}`);
    }
    assert.ok(med('tier1', cat) >= med('new_tier1', cat), `tier1 ${cat} ≥ new_tier1`);
  });
  assert.ok(med('tourist', 'luxury') <= med('tier1', 'luxury'), 'tourist luxury not above tier1 luxury');
  const avgTier1Eco = mean(allHotels.filter(({ h, c }) => c.tier === 'tier1' && h.category === 'economy').map(({ h }) => h.priceHint));
  const avgNewEco = mean(allHotels.filter(({ h, c }) => c.tier === 'new_tier1' && h.category === 'economy').map(({ h }) => h.priceHint));
  assert.ok(avgNewEco < avgTier1Eco, 'new_tier1 a bit below tier1');
});

test('about 10% of (hotel, date, room type) combos are sold out, deterministically', () => {
  let total = 0;
  let soldOut = 0;
  for (const { h, c } of allHotels.filter((_, i) => i % 3 === 0)) {
    for (let i = 0; i < 40; i++) {
      const date = addDays('2026-11-02', i);
      if (holidayOn(date)) continue;
      const offer = buildRoomOffer(h, { checkIn: date, checkOut: addDays(date, 1), city: c });
      for (const rt of offer.roomTypes) {
        total++;
        if (!rt.rates[0].available) {
          soldOut++;
          assert.equal(rt.rates[0].remaining, 0);
          assert.equal(rt.rates[0].unavailableReason, 'sold_out');
        }
      }
    }
  }
  const share = soldOut / total;
  assert.ok(share > 0.07 && share < 0.13, `sold-out share ${share}`);
});

test('maxOccupancy: rooms × maxOcc must cover adults', () => {
  const hotel = byCat('premium');
  const three = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 3, rooms: 1, city: hz });
  for (const rt of three.roomTypes) {
    for (const r of rt.rates) {
      if (rt.maxOccupancy < 3) {
        assert.equal(r.available, false);
        assert.equal(r.unavailableReason, 'occupancy', 'does not fit is not 满房');
      }
    }
  }
  const twoRooms = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 3, rooms: 2, city: hz });
  assert.ok(twoRooms.roomTypes.some((rt) => rt.maxOccupancy === 2 && rt.rates.some((r) => r.available)));
  assert.equal(lowestNightly(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 7, rooms: 1, city: hz }), null);
});

test('children count as occupants but do not change the price', () => {
  const hotel = byCat('premium');
  const opts = { checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 2, rooms: 1, city: hz };
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
  assert.ok(withChild.roomTypes.some((rt) => rt.maxOccupancy === 3 && rt.rates.some((r) => r.available || r.unavailableReason === 'sold_out')), 'the family room is offered');
});

test('long stays are usually bookable: sell-outs come in runs, not independent nights', () => {
  for (const c of [hz, bj, sy]) {
    const list = generateHotels(c);
    const bookable = list.filter((h) => lowestNightly(h, { checkIn: '2026-11-09', checkOut: '2026-12-09', city: c }) !== null);
    assert.ok(bookable.length >= list.length * 0.6, `${c.name} 30 nights: ${bookable.length}/${list.length}`);
  }
});

test('inn-area hotels get low-rise rooms whatever their name (丽江古城, 鼓浪屿, 古镇)', () => {
  let n = 0;
  for (const { h, c } of allHotels) {
    if (c.areas.find((a) => a.name === h.businessArea).kind !== 'inn') continue;
    n++;
    for (const rt of buildRoomOffer(h, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: c }).roomTypes) {
      assert.match(rt.floor, /^1-[23]层$/, `${h.id} ${h.name} ${rt.name} ${rt.floor}`);
    }
  }
  assert.ok(n >= 20);
  const lj = generateHotels(findCity('丽江')).find((h) => h.id === 'sim-lj-002');
  assert.equal(lj.businessArea, '大研古城');
  const tops = buildRoomOffer(lj, { checkIn: '2026-11-10', checkOut: '2026-11-11' }).roomTypes.map((rt) => Number(/-(\d+)层/.exec(rt.floor)[1]));
  assert.ok(tops.every((t) => t <= 3), tops.join());
});

test('rooms multiply the total; lowestNightly is the cheapest bookable per-room average', () => {
  const hotel = byCat('comfort');
  const one = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', rooms: 1, city: hz });
  const two = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', rooms: 2, adults: 4, city: hz });
  const r1 = findRate(one, 'R1-BF0-NR').rate;
  const r2 = findRate(two, 'R1-BF0-NR').rate;
  assert.equal(r2.totalPrice, r1.totalPrice * 2);
  const avgs = one.roomTypes.flatMap((rt) => rt.rates.filter((r) => r.available).map((r) => Math.round(r.totalPrice / 3)));
  assert.equal(lowestNightly(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-13', city: hz }), Math.min(...avgs));
});

test('city may be passed as a name or omitted (looked up from hotel.city)', () => {
  const hotel = bjHotel();
  const a = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: bj });
  const b = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: '北京' });
  const c = buildRoomOffer(hotel, { checkIn: '2026-11-10', checkOut: '2026-11-11' });
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.throws(() => buildRoomOffer(hotel, { checkIn: '2026-11-11', checkOut: '2026-11-10' }), RangeError);
});

function bjHotel() {
  return generateHotels(bj)[0];
}

test('view tags turn into view room names', () => {
  const lakeHotel = hzHotels.find((h) => h.tags.includes('湖景房'));
  assert.ok(lakeHotel, 'a lake-view hotel exists in 杭州');
  const offer = buildRoomOffer(lakeHotel, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: hz });
  assert.ok(offer.roomTypes.some((rt) => rt.name.startsWith('湖景')), offer.roomTypes.map((r) => r.name).join());
});

test('every view tag has a matching view room, and a hotel has at most one view tag', () => {
  const words = [['海景房', '海景'], ['湖景房', '湖景'], ['江景房', '江景'], ['河景房', '河景'], ['山景房', '山景']];
  let tagged = 0;
  for (const { h, c } of allHotels) {
    const views = words.filter(([tag]) => h.tags.includes(tag));
    assert.ok(views.length <= 1, `${h.id} ${h.tags.join()}`);
    if (!views.length) continue;
    tagged++;
    assert.notEqual(h.category, 'economy', `${h.id} economy rooms have no view template`);
    const names = buildRoomOffer(h, { checkIn: '2026-11-10', checkOut: '2026-11-11', city: c }).roomTypes.map((r) => r.name);
    assert.ok(names.some((n) => n.includes(views[0][1])), `${h.id} ${h.name} ${views[0][0]}: ${names.join()}`);
  }
  assert.ok(tagged > 50, String(tagged));
});

test('holidays: 2026 official windows, 2027 flagged as estimated', () => {
  const national2026 = HOLIDAYS.find((h) => h.key === 'national' && h.year === 2026);
  assert.deepEqual([national2026.start, national2026.end, national2026.days], ['2026-10-01', '2026-10-07', 7]);
  const spring2026 = HOLIDAYS.find((h) => h.key === 'spring' && h.year === 2026);
  assert.deepEqual([spring2026.start, spring2026.end, spring2026.days], ['2026-02-15', '2026-02-23', 9]);
  assert.equal(spring2026.festival, '2026-02-17');
  for (const h of HOLIDAYS) {
    assert.equal(h.estimated, h.year >= 2027, `${h.name} ${h.year}`);
    assert.ok(h.start <= h.festival && h.festival <= h.end || h.key === 'spring', `${h.name} festival inside window`);
  }
  const keys = new Set(HOLIDAYS.filter((h) => h.year === 2027).map((h) => h.key));
  assert.deepEqual([...keys].sort(), ['dragonboat', 'labor', 'midautumn', 'national', 'newyear', 'qingming', 'spring']);
  assert.equal(HOLIDAYS.find((h) => h.key === 'spring' && h.year === 2027).festival, '2027-02-06');
  assert.equal(HOLIDAYS.find((h) => h.key === 'midautumn' && h.year === 2027).festival, '2027-09-15');
  assert.equal(HOLIDAYS.find((h) => h.key === 'dragonboat' && h.year === 2027).festival, '2027-06-09');
  assert.equal(HOLIDAYS.find((h) => h.key === 'spring' && h.year === 2028).festival, '2028-01-26');
  assert.equal(HOLIDAYS.find((h) => h.key === 'dragonboat' && h.year === 2028).festival, '2028-05-28');
  assert.equal(HOLIDAYS.find((h) => h.key === 'midautumn' && h.year === 2028).festival, '2028-10-03');
});

test('the holiday table covers every year the 365-day booking window can reach', () => {
  const horizon = addDays(todayCN(), 365);
  const years = new Set(HOLIDAYS.map((h) => h.year));
  for (let y = Number(todayCN().slice(0, 4)); y <= Number(horizon.slice(0, 4)); y++) {
    for (const key of ['newyear', 'spring', 'qingming', 'labor', 'dragonboat', 'midautumn', 'national']) {
      assert.ok(HOLIDAYS.some((h) => h.year === y && h.key === key), `${y} ${key} missing: add the next year's holidays`);
    }
  }
  assert.ok(years.has(2028));
  assert.equal(holidayOn('2028-01-27').name, '春节');
  assert.ok(dayFactor('2028-01-27', 'tourist') > 1.5, '2028 春节 is priced as a holiday');
});

test('estimated windows longer than statutory days + weekends carry 调休 workdays', () => {
  // 2025 rules: 春节 4, 劳动节 2, 国庆 3 statutory days (+1 for 中秋 inside the 国庆 window).
  const statutory = { newyear: 1, spring: 4, qingming: 1, labor: 2, dragonboat: 1, midautumn: 1, national: 3 };
  for (const h of HOLIDAYS.filter((x) => x.estimated)) {
    let weekdaysOff = 0;
    for (let i = 0; i < h.days; i++) if (![0, 6].includes(dayOfWeek(addDays(h.start, i)))) weekdaysOff++;
    const shared = HOLIDAYS.filter((x) => x.start === h.start && x.end === h.end);
    const days = shared.reduce((s, x) => s + statutory[x.key], 0);
    // Statutory days falling on a weekend are made up on weekdays, so at most `days` weekdays are free.
    const needed = Math.max(0, weekdaysOff - days);
    assert.equal(h.makeupWorkdays.length, needed, `${h.name} ${h.year}: ${weekdaysOff} weekdays off, ${days} statutory`);
    for (const d of h.makeupWorkdays) assert.ok([0, 6].includes(dayOfWeek(d)), `${d} is a weekend day`);
  }
  assert.deepEqual(HOLIDAYS.find((h) => h.key === 'national' && h.year === 2027).makeupWorkdays, ['2027-09-26', '2027-10-09']);
  assert.match(describeHoliday(HOLIDAYS.find((h) => h.key === 'labor' && h.year === 2027)), /调休上班：2027-04-25（周日）/);
  assert.equal(holidayStartingOn('2027-10-01').key, 'national');
});

test('holiday lookups', () => {
  assert.equal(holidayOn('2026-10-03').name, '国庆节');
  assert.equal(holidayOn('2026-10-08'), null);
  assert.equal(isHolidayEve('2026-09-30'), true);
  assert.equal(isHolidayEve('2026-10-01'), false);
  assert.equal(isMakeupWorkday('2026-10-10'), true);
  assert.equal(dayOfWeek('2026-10-10'), 6);
  assert.equal(findHoliday('国庆去哪玩', '2026-10-25').start, '2027-10-01');
  assert.equal(findHoliday('十一', '2026-10-02').start, '2026-10-01', 'an ongoing holiday still counts');
  assert.equal(findHoliday('五一', '2026-10-25').start, '2027-05-01');
  assert.equal(findHoliday('过年回家', '2026-10-25').key, 'spring');
  assert.equal(findHoliday('十一月去三亚', '2026-10-25'), null);
  assert.equal(findHoliday('五一路附近', '2026-10-25'), null);
  assert.equal(findHoliday('', '2026-10-25'), null);
});

test('holiday descriptions for the prompt are honest about estimates', () => {
  const next = upcomingHolidays('2026-10-25', { count: 3 });
  assert.deepEqual(next.map((h) => h.key), ['newyear', 'spring', 'qingming']);
  const text = describeUpcomingHolidays('2026-10-25');
  assert.match(text, /^元旦：/);
  assert.match(text, /按惯例推算/);
  assert.match(text, /除夕 2027-02-05（周五），正月初一 2027-02-06（周六）/);
  const official = describeHoliday(HOLIDAYS.find((h) => h.key === 'national' && h.year === 2026));
  assert.equal(official, '国庆节：放假 2026-10-01（周四） 至 2026-10-07（周三），共7天；调休上班：2026-09-20（周日）、2026-10-10（周六）');
});
