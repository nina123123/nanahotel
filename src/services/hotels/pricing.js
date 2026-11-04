import { addDays, dayOfWeek, monthOf, toIsoCN, formatDateCN, stayDates, isValidDate } from '../../util/dates.js';
import { holidayOn, holidayStartingOn, isMakeupWorkday } from './holidays.js';
import { hash01 } from './sim-hotels.js';
import { findCity } from './sim-cities.js';

/**
 * Simulated room types and rates. Pure and deterministic: the same hotel + stay always yields the same
 * prices and availability (everything is a hash of hotel.id + room + date). `now` only changes the
 * wording of cancellation terms whose free-cancel deadline has already passed.
 */

export const PRICE_DISCLAIMER = '价格为模拟数据，仅供演示';
const SOLD_OUT_RATE = 0.1;
// Extra chance that a room type is sold out for a whole holiday, so a holiday night is ~22% sold out overall.
const HOLIDAY_EXTRA_SOLD_OUT_RATE = 1 - (1 - 0.22) / (1 - SOLD_OUT_RATE);
// Sell-outs come in runs (a conference, a tour group) rather than independent nights, so long stays stay bookable.
const SOLD_OUT_BLOCK_NIGHTS = 7;
const FRIDAY_FACTOR = 1.15;
const SATURDAY_FACTOR = 1.25;
// Peak season × holiday can stack (三亚 at 春节); capped so the simulator stays believable.
const MAX_DATE_FACTOR = 2.3;

const ROOMS = {
  economy: [
    { roomId: 'R1', name: '高级大床房', beds: ['1张1.5米大床', '1张1.8米大床'], area: [15, 20], occ: 2, factor: 1.0, noWindowP: 0.35 },
    { roomId: 'R2', name: '高级双床房', beds: ['2张1.2米单人床'], area: [18, 23], occ: 2, factor: 1.06 },
  ],
  comfort: [
    { roomId: 'R1', name: '舒适大床房', beds: ['1张1.8米大床'], area: [22, 26], occ: 2, factor: 1.0, noWindowP: 0.12 },
    { roomId: 'R2', name: '舒适双床房', beds: ['2张1.35米床'], area: [24, 28], occ: 2, factor: 1.06 },
    { roomId: 'R3', name: '豪华大床房', view: '大床房', beds: ['1张1.8米大床'], area: [28, 34], occ: 2, factor: 1.28, bigWindow: true },
  ],
  premium: [
    { roomId: 'R1', name: '高级大床房', beds: ['1张1.8米大床'], area: [30, 36], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: '高级双床房', beds: ['2张1.35米床'], area: [32, 38], occ: 2, factor: 1.05 },
    { roomId: 'R3', name: '豪华大床房', view: '大床房', beds: ['1张2米大床'], area: [38, 45], occ: 2, factor: 1.32, bigWindow: true },
    { roomId: 'R4', name: '家庭房', beds: ['1张1.8米大床+1张1.2米床'], area: [42, 50], occ: 3, factor: 1.5 },
  ],
  luxury: [
    { roomId: 'R1', name: '豪华大床房', beds: ['1张2米大床'], area: [42, 50], occ: 2, factor: 1.0, bigWindow: true },
    { roomId: 'R2', name: '豪华双床房', beds: ['2张1.35米床'], area: [44, 52], occ: 2, factor: 1.04, bigWindow: true },
    { roomId: 'R3', name: '行政大床房', view: '行政大床房', beds: ['1张2米大床'], area: [52, 62], occ: 2, factor: 1.38, bigWindow: true },
    { roomId: 'R4', name: '行政套房', beds: ['1张2米大床'], area: [85, 120], occ: 3, factor: 2.3, bigWindow: true },
  ],
};

const INN_ROOMS = {
  economy: [
    { roomId: 'R1', name: '标准大床房', beds: ['1张1.5米大床'], area: [14, 18], occ: 2, factor: 1.0, noWindowP: 0.2 },
    { roomId: 'R2', name: '标准双床房', beds: ['2张1.2米单人床'], area: [16, 20], occ: 2, factor: 1.05 },
  ],
  comfort: [
    { roomId: 'R1', name: '庭院大床房', beds: ['1张1.8米大床'], area: [20, 25], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: '温馨双床房', beds: ['2张1.35米床'], area: [22, 26], occ: 2, factor: 1.06 },
    { roomId: 'R3', name: '景观大床房', view: '大床房', beds: ['1张1.8米大床'], area: [26, 32], occ: 2, factor: 1.3, bigWindow: true },
  ],
  premium: [
    { roomId: 'R1', name: '庭院大床房', beds: ['1张1.8米大床'], area: [28, 34], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: '景观双床房', beds: ['2张1.35米床'], area: [30, 36], occ: 2, factor: 1.08 },
    { roomId: 'R3', name: '露台景观房', view: '露台房', beds: ['1张2米大床'], area: [36, 44], occ: 2, factor: 1.35, bigWindow: true },
    { roomId: 'R4', name: '亲子家庭房', beds: ['1张1.8米大床+1张1.2米床'], area: [40, 50], occ: 3, factor: 1.5 },
  ],
};

const FLOORS = { economy: [2, 6], comfort: [3, 10], premium: [5, 18], luxury: [12, 30] };
const BREAKFAST_LABELS = ['不含早', '含单早', '含双早'];

/**
 * Rate plans per category. Every hotel offers R1-BF0-NR and R1-BF2-FC, so those two ids always exist.
 * factor: [min, max] uplift over the 不含早·不可取消 price, picked per hotel by hash.
 */
const PLANS = {
  economy: [
    { code: 'BF0-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BF2-FC', breakfast: 2, cancel: 'free', factor: [1.12, 1.2] },
  ],
  comfort: [
    { code: 'BF0-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BF2-FC', breakfast: 2, cancel: 'free', factor: [1.12, 1.25] },
  ],
  premium: [
    { code: 'BF0-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BF0-FC', breakfast: 0, cancel: 'free', factor: [1.06, 1.1] },
    { code: 'BF2-FC', breakfast: 2, cancel: 'free', factor: [1.14, 1.25] },
  ],
  luxury: [
    { code: 'BF0-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BF2-LC', breakfast: 2, cancel: 'limited', factor: [1.08, 1.12] },
    { code: 'BF2-FC', breakfast: 2, cancel: 'free', factor: [1.16, 1.25] },
  ],
};

const VIEW_WORDS = [['湖景房', '湖景'], ['海景房', '海景'], ['江景房', '江景'], ['河景房', '河景'], ['山景房', '山景']];

/** Inn-style (courtyard, low-rise) by the hotel's area, not its name: '望庐·大研古城' is in 丽江古城 too. */
function isInn(hotel) {
  const area = findCity(hotel.city)?.areas.find((a) => a.name === hotel.businessArea);
  return area ? area.kind === 'inn' : /民宿|客栈|小院|院子/.test(hotel.name);
}

function resolveCityInfo(hotel, city) {
  if (city && typeof city === 'object' && city.tier) return city;
  return findCity(typeof city === 'string' ? city : hotel.city) || { tier: 'tier2', season: null };
}

function roomTemplates(hotel) {
  const cat = ROOMS[hotel.category] ? hotel.category : 'comfort';
  return (isInn(hotel) && INN_ROOMS[cat]) || ROOMS[cat];
}

function roomType(hotel, t) {
  const h = (k) => hash01(`${hotel.id}|${t.roomId}|${k}`);
  const view = VIEW_WORDS.find(([tag]) => hotel.tags.includes(tag));
  const name = t.view && view ? `${view[1]}${t.view}` : t.name;
  const [aLo, aHi] = t.area;
  let window = '有窗';
  if (t.bigWindow) window = '落地窗';
  else if (t.noWindowP && h('window') < t.noWindowP) window = '无窗';
  const [fLo, fHi] = isInn(hotel) ? [1, 3] : FLOORS[hotel.category] || FLOORS.comfort;
  const top = Math.max(fLo + 1, Math.round(fHi - h('floor') * (fHi - fLo) * 0.4));
  return {
    roomId: t.roomId,
    name,
    bed: t.beds[Math.floor(h('bed') * t.beds.length)],
    areaSqm: aLo + Math.floor(h('area') * (aHi - aLo + 1)),
    maxOccupancy: t.occ,
    window,
    floor: `${fLo}-${top}层`,
  };
}

function holidayMultiplier(h, tier) {
  return tier === 'tourist' ? h.touristMultiplier : h.multiplier;
}

/**
 * Night multiplier. Holiday nights carry the holiday premium, and so does the eve of a long break (the
 * peak departure night); the last night of a multi-day break is when everyone has gone home, so it is
 * priced as an ordinary night. Saturday > Friday > other nights, and a night before a 调休 workday has no
 * weekend premium.
 */
export function dayFactor(date, tier) {
  const holiday = holidayOn(date);
  if (holiday && !(holiday.days > 1 && date === holiday.end)) return holidayMultiplier(holiday, tier);
  const next = addDays(date, 1);
  const upcoming = holiday ? null : holidayStartingOn(next);
  if (upcoming) return upcoming.days >= 3 ? holidayMultiplier(upcoming, tier) : FRIDAY_FACTOR;
  if (isMakeupWorkday(next)) return 1;
  const dow = dayOfWeek(date);
  if (dow === 5) return FRIDAY_FACTOR;
  if (dow === 6) return SATURDAY_FACTOR;
  return 1;
}

function seasonFactor(date, cityInfo) {
  return Array.isArray(cityInfo.season) ? cityInfo.season[monthOf(date) - 1] || 1 : 1;
}

/** ±8%: mostly a per-week level (demand moves by the week) plus a little per-night noise. */
function jitter(hotelId, date) {
  const monday = addDays(date, -((dayOfWeek(date) + 6) % 7));
  const week = hash01(`${hotelId}|${monday}|jitter`) * 2 - 1;
  const night = hash01(`${hotelId}|${date}|jitter`) * 2 - 1;
  return 1 + week * 0.06 + night * 0.02;
}

function roundPrice(x, ending) {
  return Math.max(ending === 9 ? 99 : 98, Math.round(x / 10) * 10 - (ending === 9 ? 1 : 2));
}

/** Rooms left of one room type on one night (0 = 满房). */
function inventory(hotelId, roomId, date) {
  const key = `${hotelId}|${roomId}`;
  const phase = Math.floor(hash01(`${key}|phase`) * SOLD_OUT_BLOCK_NIGHTS);
  const block = Math.floor((Date.parse(`${date}T00:00:00Z`) / 86400000 + phase) / SOLD_OUT_BLOCK_NIGHTS);
  if (hash01(`${key}|${block}|inv`) < SOLD_OUT_RATE) return 0;
  const holiday = holidayOn(date);
  if (holiday && hash01(`${key}|${holiday.key}${holiday.year}|inv`) < HOLIDAY_EXTRA_SOLD_OUT_RATE) return 0;
  const left = 1 + Math.floor(hash01(`${key}|${block}|left`) * 10);
  return Math.max(1, left - Math.floor(hash01(`${key}|${date}|left`) * 2));
}

function cancelPolicy(type, checkIn, now) {
  if (type === 'none') {
    return { type, freeUntil: null, text: '预订成功后不可取消、不可修改，取消将收取全部房费' };
  }
  const deadlineDate = addDays(checkIn, type === 'limited' ? -3 : -1);
  const freeUntil = toIsoCN(deadlineDate, '18:00');
  const when = `${formatDateCN(deadlineDate)} 18:00`;
  const passed = now && now.getTime() >= Date.parse(freeUntil);
  if (passed) return { type, freeUntil, text: `免费取消时间（${when}）已过，现在取消将收取首晚房费` };
  const prefix = type === 'limited' ? '限时取消：' : '';
  return { type, freeUntil, text: `${prefix}${when}前可免费取消，逾期取消收取首晚房费` };
}

function rateName(breakfast, policy, now) {
  const bf = BREAKFAST_LABELS[breakfast];
  if (policy.type === 'none') return `${bf} · 不可取消`;
  if (now && now.getTime() >= Date.parse(policy.freeUntil)) return `${bf} · 取消收首晚`;
  return `${bf} · ${policy.type === 'limited' ? '限时取消' : '免费取消'}`;
}

/**
 * Children count as occupants (beds) but do not change the price.
 * A rate that is not bookable has `unavailableReason` 'occupancy' (party does not fit) or 'sold_out'
 * (fewer rooms left than requested; `remaining` says how many).
 * @param {object} hotel  a Hotel with priceHint
 * @param {{ checkIn: string, checkOut: string, adults?: number, children?: number, rooms?: number, city?: object|string, now?: Date }} opts
 * @returns RoomOffer
 */
export function buildRoomOffer(hotel, { checkIn, checkOut, adults = 2, children = 0, rooms = 1, city, now } = {}) {
  if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
    throw new RangeError(`invalid stay ${checkIn} → ${checkOut}`);
  }
  const nights = stayDates(checkIn, checkOut);
  const base = {
    hotelId: hotel.id, checkIn, checkOut, nights: nights.length, adults, children, rooms,
    roomTypes: [], demo: true, priceDisclaimer: PRICE_DISCLAIMER,
  };
  if (!Number.isFinite(hotel.priceHint)) return base;

  const info = resolveCityInfo(hotel, city);
  const ending = hash01(`${hotel.id}|ending`) < 0.5 ? 8 : 9;
  const nightBase = nights.map((date) => {
    const dateFactor = Math.min(MAX_DATE_FACTOR, dayFactor(date, info.tier) * seasonFactor(date, info));
    return hotel.priceHint * dateFactor * jitter(hotel.id, date);
  });
  const plans = PLANS[hotel.category] || PLANS.comfort;

  base.roomTypes = roomTemplates(hotel).map((t) => {
    const rt = roomType(hotel, t);
    const remainingNights = nights.map((date) => inventory(hotel.id, t.roomId, date));
    const minLeft = Math.min(...remainingNights);
    const fits = rooms * rt.maxOccupancy >= adults + children;
    const rates = plans.map((plan) => {
      const [fLo, fHi] = plan.factor;
      const planFactor = fLo + (fHi - fLo) * hash01(`${hotel.id}|${plan.code}|plan`);
      const policy = cancelPolicy(plan.cancel, checkIn, now);
      const nightly = nights.map((date, i) => ({ date, price: roundPrice(nightBase[i] * t.factor * planFactor, ending) }));
      const perRoom = nightly.reduce((sum, n) => sum + n.price, 0);
      const available = fits && minLeft >= rooms;
      let unavailableReason = null;
      if (!fits) unavailableReason = 'occupancy';
      else if (!available) unavailableReason = 'sold_out';
      return {
        rateId: `${t.roomId}-${plan.code}`,
        name: rateName(plan.breakfast, policy, now),
        breakfast: plan.breakfast,
        cancelPolicy: policy,
        payment: 'prepay',
        nightly,
        totalPrice: perRoom * rooms,
        available,
        remaining: available ? (minLeft <= 5 ? minLeft : null) : (fits ? minLeft : null),
        unavailableReason,
      };
    });
    return { ...rt, rates };
  });
  return base;
}

/** Find a rate inside an offer. */
export function findRate(offer, rateId) {
  for (const rt of offer.roomTypes) {
    const rate = rt.rates.find((r) => r.rateId === rateId);
    if (rate) return { roomType: rt, rate };
  }
  return null;
}

/** Lowest bookable average nightly price per room in a RoomOffer, or null when nothing is bookable (满房). */
export function lowestNightlyOf(offer) {
  let best = null;
  for (const rt of offer.roomTypes) {
    for (const r of rt.rates) {
      if (!r.available) continue;
      const avg = Math.round(r.totalPrice / offer.rooms / offer.nights);
      if (best === null || avg < best) best = avg;
    }
  }
  return best;
}

/** Lowest bookable average nightly price per room for the stay, or null when nothing is bookable (满房). */
export function lowestNightly(hotel, opts) {
  return lowestNightlyOf(buildRoomOffer(hotel, opts));
}
