import { addDays, dayOfWeek, monthOf, toIsoInZone, formatDate, formatTime, zoneAbbr, stayDates, isValidDate, DEFAULT_TIME_ZONE } from '../../util/dates.js';
import { holidayOn, holidayMultiplier } from './holidays.js';
import { hash01 } from './sim-hotels.js';
import { findCity } from './sim-cities.js';

/**
 * Simulated room types and rates in US dollars. Pure and deterministic: the same hotel + stay always yields the same
 * prices and availability (everything is a hash of hotel.id + room + date). `now` only changes the wording of
 * cancellation terms whose free-cancel deadline has already passed.
 *
 * Every nightly price is ALL-IN: the room rate plus the city's hotel taxes and, where the area charges one, the daily
 * resort fee, rounded to whole dollars. So `totalPrice` (nightly × rooms) is what the guest pays; `taxesAndFees` says
 * how much of it is taxes and fees.
 */

export const PRICE_DISCLAIMER = 'Simulated prices for the demo; totals include taxes and fees';
export const CURRENCY = 'USD';
const SOLD_OUT_RATE = 0.1;
// Extra chance that a room type is sold out for a whole holiday weekend, so a holiday night is ~22% sold out overall.
const HOLIDAY_EXTRA_SOLD_OUT_RATE = 1 - (1 - 0.22) / (1 - SOLD_OUT_RATE);
// Sell-outs come in runs (a convention, a wedding block) rather than independent nights, so long stays stay bookable.
const SOLD_OUT_BLOCK_NIGHTS = 7;
// Weekend × season × holiday can stack (Vegas on New Year's Eve); capped so the simulator stays believable.
const MAX_DATE_FACTOR = 2.3;
const MIN_DATE_FACTOR = 0.55;
// The free-cancel deadline: 24 hours before the usual 3 PM check-in (72 for the limited rate), hotel time.
export const CANCEL_DEADLINE_TIME = '15:00';
const SQFT_PER_SQM = 10.7639;
const DEFAULT_WEEKDAYS = {
  business: [0.9, 1, 1.08, 1.08, 1.05, 0.95, 1],
  mixed: [0.95, 1, 1, 1, 1, 1.1, 1.15],
  leisure: [0.95, 0.95, 0.95, 0.95, 1, 1.25, 1.35],
};
// The daily resort fee where an area charges one (the Las Vegas Strip, Waikiki, South Beach …).
const RESORT_FEES = { budget: 30, midscale: 35, upscale: 42, luxury: 49 };

const ROOMS = {
  budget: [
    { roomId: 'R1', name: 'Standard Queen', beds: ['1 Queen Bed'], sqft: [220, 280], occ: 2, factor: 1.0, noWindowP: 0.06 },
    { roomId: 'R2', name: 'Two Queen Beds', beds: ['2 Queen Beds', '2 Double Beds'], sqft: [280, 340], occ: 4, factor: 1.1 },
  ],
  midscale: [
    { roomId: 'R1', name: 'King Room', beds: ['1 King Bed'], sqft: [280, 330], occ: 2, factor: 1.0, noWindowP: 0.02 },
    { roomId: 'R2', name: 'Two Queen Room', beds: ['2 Queen Beds'], sqft: [310, 360], occ: 4, factor: 1.08 },
    { roomId: 'R3', name: 'King Suite', view: 'King Suite', beds: ['1 King Bed + Sofa Bed'], sqft: [400, 480], occ: 4, factor: 1.3, bigWindow: true },
  ],
  upscale: [
    { roomId: 'R1', name: 'Deluxe King', beds: ['1 King Bed'], sqft: [330, 380], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: 'Deluxe Two Queens', beds: ['2 Queen Beds'], sqft: [360, 410], occ: 4, factor: 1.06 },
    { roomId: 'R3', name: 'Premier King', view: 'King', beds: ['1 King Bed'], sqft: [400, 460], occ: 2, factor: 1.3, bigWindow: true },
    { roomId: 'R4', name: 'One-Bedroom Suite', beds: ['1 King Bed + Sofa Bed'], sqft: [600, 750], occ: 4, factor: 1.75 },
  ],
  luxury: [
    { roomId: 'R1', name: 'Deluxe King', beds: ['1 King Bed'], sqft: [420, 500], occ: 2, factor: 1.0, bigWindow: true },
    { roomId: 'R2', name: 'Deluxe Two Queens', beds: ['2 Queen Beds'], sqft: [450, 520], occ: 4, factor: 1.05, bigWindow: true },
    { roomId: 'R3', name: 'Premier King', view: 'King', beds: ['1 King Bed'], sqft: [520, 600], occ: 2, factor: 1.35, bigWindow: true },
    { roomId: 'R4', name: 'One-Bedroom Suite', beds: ['1 King Bed + Sofa Bed'], sqft: [800, 1100], occ: 4, factor: 2.3, bigWindow: true },
  ],
};

// Historic inns and B&Bs: smaller, older rooms in a low building.
const INN_ROOMS = {
  budget: [
    { roomId: 'R1', name: 'Cozy Queen', beds: ['1 Queen Bed'], sqft: [170, 220], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: 'Classic Double', beds: ['1 Double Bed', '2 Twin Beds'], sqft: [180, 230], occ: 2, factor: 1.04 },
  ],
  midscale: [
    { roomId: 'R1', name: 'Courtyard Queen', beds: ['1 Queen Bed'], sqft: [230, 280], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: 'Classic King', beds: ['1 King Bed'], sqft: [250, 300], occ: 2, factor: 1.08 },
    { roomId: 'R3', name: 'Balcony King', view: 'Balcony King', beds: ['1 King Bed'], sqft: [280, 340], occ: 2, factor: 1.28, bigWindow: true },
  ],
  upscale: [
    { roomId: 'R1', name: 'Courtyard King', beds: ['1 King Bed'], sqft: [280, 330], occ: 2, factor: 1.0 },
    { roomId: 'R2', name: 'Garden Two Queens', beds: ['2 Queen Beds'], sqft: [320, 370], occ: 4, factor: 1.08 },
    { roomId: 'R3', name: 'Balcony Suite', view: 'Balcony Suite', beds: ['1 King Bed'], sqft: [380, 450], occ: 2, factor: 1.35, bigWindow: true },
    { roomId: 'R4', name: 'Carriage House Suite', beds: ['1 King Bed + Sofa Bed'], sqft: [480, 600], occ: 4, factor: 1.55 },
  ],
};

const FLOORS = { budget: [2, 6], midscale: [2, 12], upscale: [4, 24], luxury: [8, 40] };
const INN_FLOORS = [1, 3];
const WINDOW = { window: 'Window', interior: 'Interior (no window)', big: 'Floor-to-ceiling windows' };

/**
 * Rate plans per category. Every hotel's first plan is non-refundable (the cheapest) and one plan can be cancelled
 * for free. factor: [min, max] uplift over the non-refundable price, picked per hotel by hash. A hotel with free
 * breakfast for everyone sells breakfast with every rate.
 */
const PLANS = {
  budget: [
    { code: 'RO-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'RO-FC', breakfast: 0, cancel: 'free', factor: [1.08, 1.12] },
  ],
  midscale: [
    { code: 'RO-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BB-FC', breakfast: 2, cancel: 'free', factor: [1.12, 1.22] },
  ],
  upscale: [
    { code: 'RO-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'RO-FC', breakfast: 0, cancel: 'free', factor: [1.06, 1.1] },
    { code: 'BB-FC', breakfast: 2, cancel: 'free', factor: [1.15, 1.25] },
  ],
  luxury: [
    { code: 'RO-NR', breakfast: 0, cancel: 'none', factor: [1, 1] },
    { code: 'BB-LC', breakfast: 2, cancel: 'limited', factor: [1.08, 1.12] },
    { code: 'BB-FC', breakfast: 2, cancel: 'free', factor: [1.16, 1.25] },
  ],
};
const FREE_BREAKFAST_PLANS = [
  { code: 'BB-NR', breakfast: 2, cancel: 'none', factor: [1, 1] },
  { code: 'BB-FC', breakfast: 2, cancel: 'free', factor: [1.08, 1.14] },
];

const VIEW_WORDS = [['Ocean view', 'Ocean View'], ['Harbor view', 'Harbor View'], ['Bay view', 'Bay View'], ['Lake view', 'Lake View'], ['River view', 'River View'],
  ['Park view', 'Park View'], ['Mountain view', 'Mountain View'], ['City view', 'City View']];

function areaOf(hotel) {
  return findCity(hotel.city)?.areas.find((a) => a.name === hotel.businessArea) || null;
}

/** Inn-style (historic, low-rise) by the hotel's area, not its name: a luxury hotel in the French Quarter too. */
export function isInn(hotel) {
  const area = areaOf(hotel);
  return area ? area.kind === 'inn' : /\b(?:Inn|Bed & Breakfast|Guesthouse|Manor)\b/.test(hotel.name || '') && !/Inn & Suites|Airport Inn/.test(hotel.name || '');
}

function resolveCityInfo(hotel, city) {
  if (city && typeof city === 'object' && city.market) return city;
  return findCity(typeof city === 'string' ? city : hotel.city) || { code: '', market: 'mixed', season: null, weekdays: null, tax: { rate: 0.15, perNight: 0 }, zone: hotel.timeZone || DEFAULT_TIME_ZONE };
}

function roomTemplates(hotel) {
  const cat = ROOMS[hotel.category] ? hotel.category : 'midscale';
  return (isInn(hotel) && INN_ROOMS[cat]) || ROOMS[cat];
}

function planList(hotel) {
  if ((hotel.amenities || []).includes('Free breakfast')) return FREE_BREAKFAST_PLANS;
  return PLANS[hotel.category] || PLANS.midscale;
}

function roomType(hotel, t) {
  const h = (k) => hash01(`${hotel.id}|${t.roomId}|${k}`);
  const view = VIEW_WORDS.find(([tag]) => (hotel.tags || []).includes(tag));
  const name = t.view && view ? `${view[1]} ${t.view}` : t.name;
  const [aLo, aHi] = t.sqft;
  const sqft = Math.round((aLo + h('area') * (aHi - aLo)) / 10) * 10;
  let window = WINDOW.window;
  if (t.bigWindow) window = WINDOW.big;
  else if (t.noWindowP && h('window') < t.noWindowP) window = WINDOW.interior;
  const [fLo, fHi] = isInn(hotel) ? INN_FLOORS : FLOORS[hotel.category] || FLOORS.midscale;
  const top = Math.max(fLo + 1, Math.round(fHi - h('floor') * (fHi - fLo) * 0.4));
  return {
    roomId: t.roomId,
    name,
    bed: t.beds[Math.floor(h('bed') * t.beds.length)],
    areaSqft: sqft,
    areaSqm: Math.round(sqft / SQFT_PER_SQM),
    maxOccupancy: t.occ,
    window,
    floor: `Floors ${fLo}–${top}`,
  };
}

/** The floor range of a room type's `floor` text ('Floors 4–18' → [4, 18]), or null. */
export function parseFloors(text) {
  const m = /(\d+)\s*[–-]\s*(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Night multiplier before the season: the city's usual factor for that night of the week (leisure cities peak on
 * Friday and Saturday, business cities midweek), times the holiday's multiplier for the city's market on the
 * nights of a holiday or big weekend (holidays.js).
 * @param {string} date
 * @param {'business'|'mixed'|'leisure'} [market]
 * @param {{ code?: string, weekdays?: number[] }} [city]
 */
export function dayFactor(date, market = 'mixed', city) {
  const weekdays = Array.isArray(city?.weekdays) ? city.weekdays : DEFAULT_WEEKDAYS[market] || DEFAULT_WEEKDAYS.mixed;
  let f = weekdays[dayOfWeek(date)] ?? 1;
  const holiday = holidayOn(date, city?.code);
  if (holiday) f *= holidayMultiplier(holiday, market);
  return f;
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

/** Room rate before taxes: whole dollars ending in 9. */
function roundRate(x) {
  return Math.max(59, Math.round(x / 10) * 10 - 1);
}

/** Rooms left of one room type on one night (0 = sold out). */
function inventory(hotelId, roomId, date, cityCode) {
  const key = `${hotelId}|${roomId}`;
  const phase = Math.floor(hash01(`${key}|phase`) * SOLD_OUT_BLOCK_NIGHTS);
  const block = Math.floor((Date.parse(`${date}T00:00:00Z`) / 86400000 + phase) / SOLD_OUT_BLOCK_NIGHTS);
  if (hash01(`${key}|${block}|inv`) < SOLD_OUT_RATE) return 0;
  const holiday = holidayOn(date, cityCode);
  // A month-long window (spring break) raises prices, but does not sell rooms out night after night.
  if (holiday && !holiday.long && hash01(`${key}|${holiday.key}${holiday.year}|inv`) < HOLIDAY_EXTRA_SOLD_OUT_RATE) return 0;
  const left = 1 + Math.floor(hash01(`${key}|${block}|left`) * 10);
  return Math.max(1, left - Math.floor(hash01(`${key}|${date}|left`) * 2));
}

/** '3:00 PM EST on Thu, Nov 5' for a deadline at the hotel. */
function deadlineText(date, iso, zone) {
  return `${formatTime(CANCEL_DEADLINE_TIME)} ${zoneAbbr(iso, zone)} on ${formatDate(date)}`;
}

/**
 * The cancellation terms of a rate: free until 3:00 PM hotel time the day before check-in ('limited': three days
 * before), then the first night is charged; 'none' is non-refundable. `freeUntil` is an ISO instant with the hotel's
 * UTC offset.
 */
export function cancelPolicy(type, checkIn, now, zone = DEFAULT_TIME_ZONE) {
  if (type === 'none') {
    return { type, freeUntil: null, text: "Non-refundable: this rate can't be cancelled or changed, and cancelling forfeits the full amount." };
  }
  const deadlineDate = addDays(checkIn, type === 'limited' ? -3 : -1);
  const freeUntil = toIsoInZone(deadlineDate, CANCEL_DEADLINE_TIME, zone);
  const when = deadlineText(deadlineDate, freeUntil, zone);
  const passed = now && now.getTime() >= Date.parse(freeUntil);
  if (passed) return { type, freeUntil, text: `The free cancellation deadline (${when}) has passed; cancelling now costs the first night.` };
  const prefix = type === 'limited' ? 'Limited cancellation: f' : 'F';
  return { type, freeUntil, text: `${prefix}ree cancellation until ${when} (hotel time); after that the first night is charged.` };
}

function rateName(breakfast, policy, now) {
  const bf = breakfast > 0 ? 'Breakfast included' : 'Room only';
  if (policy.type === 'none') return `${bf} · Non-refundable`;
  if (now && now.getTime() >= Date.parse(policy.freeUntil)) return `${bf} · Cancellation fee applies`;
  return `${bf} · ${policy.type === 'limited' ? 'Cancel by 3 days before' : 'Free cancellation'}`;
}

/** A night's all-in price from its room rate: (rate + resort fee) × (1 + tax) + flat fees, whole dollars. */
function allIn(rate, resortFee, tax) {
  return Math.round((rate + resortFee) * (1 + (tax?.rate || 0)) + (tax?.perNight || 0));
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
    roomTypes: [], currency: CURRENCY, demo: true, priceDisclaimer: PRICE_DISCLAIMER,
  };
  if (!Number.isFinite(hotel.priceHint)) return base;

  const info = resolveCityInfo(hotel, city);
  const zone = hotel.timeZone || info.zone || DEFAULT_TIME_ZONE;
  const resortFee = areaOf(hotel)?.features.includes('resortfee') ? RESORT_FEES[hotel.category] || 0 : 0;
  const nightBase = nights.map((date) => {
    const factor = Math.min(MAX_DATE_FACTOR, Math.max(MIN_DATE_FACTOR, dayFactor(date, info.market, info) * seasonFactor(date, info)));
    return hotel.priceHint * factor * jitter(hotel.id, date);
  });
  const plans = planList(hotel);

  base.roomTypes = roomTemplates(hotel).map((t) => {
    const rt = roomType(hotel, t);
    const remainingNights = nights.map((date) => inventory(hotel.id, t.roomId, date, info.code));
    const minLeft = Math.min(...remainingNights);
    const fits = rooms * rt.maxOccupancy >= adults + children;
    // The cheapest plan's room rates: every other plan costs at least $10 a night more (rounding to $10 steps
    // would otherwise make free cancellation free on a $69 room).
    const floorRates = nights.map((date, i) => roundRate(nightBase[i] * t.factor));
    const rates = plans.map((plan) => {
      const [fLo, fHi] = plan.factor;
      const planFactor = fLo + (fHi - fLo) * hash01(`${hotel.id}|${plan.code}|plan`);
      const policy = cancelPolicy(plan.cancel, checkIn, now, zone);
      const roomRates = nights.map((date, i) => {
        const r = roundRate(nightBase[i] * t.factor * planFactor);
        return fLo > 1 ? Math.max(r, floorRates[i] + 10) : r;
      });
      const nightly = nights.map((date, i) => ({ date, price: allIn(roomRates[i], resortFee, info.tax) }));
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
        taxesAndFees: (perRoom - roomRates.reduce((s, r) => s + r, 0)) * rooms,
        ...(resortFee ? { resortFee } : {}),
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

/** Lowest bookable average nightly price per room in a RoomOffer, or null when nothing is bookable (sold out). */
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

/** Lowest bookable average nightly price per room for the stay, or null when nothing is bookable (sold out). */
export function lowestNightly(hotel, opts) {
  return lowestNightlyOf(buildRoomOffer(hotel, opts));
}
