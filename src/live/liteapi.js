import {
  LiveServiceError, createHttpClient, codeForStatus, parseRetryAfterMs, isPlainObject, str, num, round2, distanceMeters, createTtlCache, shortHash,
} from './http.js';
import { resolveUsCity, US_CITIES } from './us-cities.js';

/**
 * LiteAPI (Nuitée) hotel supplier for the US edition: live hotels, rooms and USD rates mapped to the same Hotel /
 * RoomOffer shapes the simulator returns (src/services/hotels/sim-supplier.js, pricing.js), plus the booking calls
 * (prebook = price lock + payment session, book, getBooking, cancel).
 *
 * Unlike the simulator every method is async (it returns a Promise) and search results come back already priced
 * (`hotel.offer`, `hotel.lowestPrice`), because rates are only known per stay and party. Sandbox vs production is
 * chosen by the key: sandbox keys start with "sand_" (or "sandbox_"); there the payment form takes the test card
 * 4242 4242 4242 4242 and nothing is charged.
 */

// ---------------------------------------------------------------------------
// VERIFY: every assumption about LiteAPI lives in this block (written from LiteAPI v3.0 docs as remembered; the
// docs at docs.liteapi.travel could not be reached from the build sandbox). scripts/smoke-live.mjs checks them.
// ---------------------------------------------------------------------------
export const LITEAPI = Object.freeze({
  // VERIFY: static data and rates live on api.liteapi.travel, booking calls on book.liteapi.travel, both /v3.0.
  dataBaseUrl: 'https://api.liteapi.travel/v3.0',
  bookBaseUrl: 'https://book.liteapi.travel/v3.0',
  // Confirmed (owner's LiteAPI dashboard): the private key goes in the X-API-Key header (no Bearer).
  apiKeyHeader: 'X-API-Key',
  paths: Object.freeze({
    // VERIFY: GET ?countryCode=US&cityName=… | ?latitude=&longitude=&radius=<meters>, &limit= → { data: [hotel] }
    // hotel: { id, name, address, city, zip, country, latitude, longitude, stars, rating (0–10), reviewCount,
    //          main_photo, thumbnail, chain, deletedAt }
    hotels: '/data/hotels',
    // VERIFY: GET ?hotelId= → { data: { id, name, hotelDescription, checkinCheckoutTimes: { checkin, checkout },
    //          hotelImages: [{ url, urlHd, defaultImage, order }], location: { latitude, longitude }, address,
    //          starRating, rating, reviewCount, hotelFacilities: [string], phone?, rooms: [{ id, roomName,
    //          roomSizeSquare, roomSizeUnit, maxOccupancy, bedTypes: [{ quantity, bedType }], photos }] } }
    hotel: '/data/hotel',
    // VERIFY: POST { hotelIds, occupancies: [{ adults, children: [ages] }], currency, guestNationality, checkin,
    //          checkout, timeout (s), roomMapping } → { data: [{ hotelId, roomTypes: [{ offerId, offerRetailRate:
    //          { amount, currency }, suggestedSellingPrice, rates: [{ name, boardType, boardName, maxOccupancy,
    //          adultCount, childCount, mappedRoomId, retailRate: { total: [{ amount, currency }],
    //          suggestedSellingPrice, taxesAndFees: [{ included, amount, currency }] }, cancellationPolicies:
    //          { refundableTag: 'RFN'|'NRFN', cancelPolicyInfos: [{ cancelTime, amount, currency, timezone }] } }] }] }] }
    //          No availability: { error: { code: 2001, description: 'no availability found' } } (also on HTTP 200).
    rates: '/hotels/rates',
    // VERIFY (book host): POST { offerId, usePaymentSdk: true } → { data: { prebookId, price, currency,
    //          priceDifferencePercent, cancellationChanged, boardChanged, roomTypes: [{ rates: [...] }],
    //          termsAndConditions, transactionId, secretKey } } — secretKey/transactionId feed the payment SDK.
    prebook: '/rates/prebook',
    // VERIFY (book host): POST { prebookId, holder: { firstName, lastName, email, phone? }, payment: { method:
    //          'TRANSACTION_ID', transactionId } (sandbox without the SDK: { method: 'ACC_CREDIT_CARD' }),
    //          guests: [{ occupancyNumber, firstName, lastName, email }], clientReference? }
    //          → { data: { bookingId, status, hotelConfirmationCode, supplierBookingId, hotel: { hotelId, name },
    //          checkin, checkout, price, currency, cancellationPolicies, bookedRooms } }
    book: '/rates/book',
    // VERIFY (book host): GET /bookings/{id} → { data: booking }; PUT /bookings/{id} cancels → { data: {
    //          bookingId, status: 'CANCELLED'|'CANCELLED_WITH_CHARGES', cancellation_fee, refund_amount, currency } }
    booking: '/bookings',
  }),
  // VERIFY: booking statuses.
  statuses: Object.freeze({
    CONFIRMED: 'confirmed', PENDING: 'pending', IN_PROGRESS: 'pending', ON_REQUEST: 'pending',
    CANCELLED: 'cancelled', CANCELED: 'cancelled', CANCELLED_WITH_CHARGES: 'cancelled', FAILED: 'failed', REJECTED: 'failed',
  }),
  // VERIFY: board codes.
  boards: Object.freeze({
    RO: ['Room only', false], BB: ['Breakfast included', true], BI: ['Breakfast included', true], HB: ['Half board', true],
    FB: ['Full board', true], AI: ['All inclusive', true],
  }),
  // Confirmed (owner's dashboard): sandbox private keys start with "sand_" ("sandbox_" is accepted too).
  sandboxKeyPrefixes: Object.freeze(['sand_', 'sandbox_']),
  sandboxTestCard: '4242 4242 4242 4242',
  paymentSdk: Object.freeze({
    // VERIFY: the payment SDK script the front end loads (see docs/LIVE.md, "The payment form").
    scriptUrl: 'https://payment-wrapper.liteapi.travel/dist/liteAPIPayment.js?v=a1',
    // Confirmed (owner's dashboard, "Payment SDK keys"): the form also needs a Stripe *publishable* key, one for
    // sandbox and one for production, read from LITEAPI_PAYMENT_KEY; it is safe to send to the browser.
    // VERIFY: publishable keys start with pk_test_ (sandbox) / pk_live_ (production), and the SDK's
    // environment flag is 'sandbox' / 'live'.
    publishableKeyPrefixes: Object.freeze({ sandbox: 'pk_test_', live: 'pk_live_' }),
    sandboxEnvironment: 'sandbox',
    liveEnvironment: 'live',
  }),
  // VERIFY: no ages given → this age is sent for each child (LiteAPI needs ages).
  defaultChildAge: 8,
  // VERIFY: seconds LiteAPI waits for its suppliers in a rates search.
  ratesTimeoutSeconds: 8,
});

const MAX_ROOM_TYPES = 8;
const MAX_RATES_PER_ROOM = 4;
const MAX_STATIC = 200;
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_TTL_MS = 3 * 60 * 1000;
const EMPTY_RATES_TTL_MS = 60 * 1000;
const OFFER_REF_TTL_MS = 25 * 60 * 1000;

export function isLiteApiSandboxKey(key) {
  const k = String(key || '').trim().toLowerCase();
  return LITEAPI.sandboxKeyPrefixes.some((p) => k.startsWith(p));
}

// ---------------------------------------------------------------------------
// Formatting helpers (en-US)
// ---------------------------------------------------------------------------

/** $1,108 from $100 up (whole dollars), $85.50 below (docs/US-CONTRACT.md §2). */
export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const whole = Math.abs(v) >= 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(v);
}

function validTimeZone(tz) {
  const t = String(tz || '').trim();
  if (!t || /^(gmt|utc|z)$/i.test(t)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch {
    return 'UTC';
  }
}

function tzOffsetMs(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000;
}

/** '2026-12-02 23:59:59' (+ timezone) or an ISO string → ISO instant; null when unreadable. */
export function liteApiTimeToIso(value, timezone) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const tz = validTimeZone(timezone);
    const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    if (!Number.isFinite(naive)) return null;
    let utc = naive;
    if (tz !== 'UTC') {
      utc = naive - tzOffsetMs(naive, tz);
      const again = naive - tzOffsetMs(utc, tz);
      if (again !== utc) utc = again;
    }
    return new Date(utc).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function formatDeadline(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: validTimeZone(timeZone), timeZoneName: 'short',
  }).format(new Date(iso));
}

function plainText(html, max = 800) {
  const s = String(html ?? '')
    .replace(/<(br|\/p|\/li|\/div)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function isUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim());
}

function dedupe(list) {
  return [...new Set(list)];
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** '3:00 PM' / '15:00' / '15:00:00' → '15:00'; '' when unreadable. */
export function to24h(value) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(String(value ?? '').trim());
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Hotels
// ---------------------------------------------------------------------------

/** Star rating → US edition category (docs/US-CONTRACT.md §11). */
export function categoryForStars(stars) {
  const s = num(stars);
  if (s === null || s <= 0) return 'midscale';
  if (s >= 4.5) return 'luxury';
  if (s >= 3.5) return 'upscale';
  if (s >= 2.5) return 'midscale';
  return 'budget';
}

/** Guest rating on 0–5 with one decimal (LiteAPI reports 0–10). */
function toFive(rating) {
  const r = num(rating);
  if (r === null || r <= 0) return null;
  return Math.round((r > 5 ? r / 2 : r) * 10) / 10;
}

function composeAddress(raw, cityName) {
  let a = str(raw.address, 200);
  const city = str(raw.city, 80) || cityName || '';
  const zip = str(raw.zip ?? raw.postalCode, 20);
  if (city && a && !a.toLowerCase().includes(city.toLowerCase())) a = `${a}, ${city}`;
  if (!a) a = city;
  if (zip && !a.includes(zip)) a = `${a} ${zip}`;
  return a.trim();
}

/** One hotel of a /data/hotels list (or the base of a /data/hotel detail) → Hotel; null when unusable. */
export function mapLiteApiHotel(raw, { city } = {}) {
  if (!isPlainObject(raw) || raw.deletedAt) return null;
  const id = str(raw.id ?? raw.hotelId, 80);
  const name = plainText(raw.name, 120);
  if (!id || !name) return null;
  const lat = num(raw.latitude ?? raw.location?.latitude);
  const lng = num(raw.longitude ?? raw.location?.longitude);
  const stars = num(raw.stars ?? raw.starRating);
  const chain = str(raw.chain, 60);
  const facilities = Array.isArray(raw.hotelFacilities) ? raw.hotelFacilities : [];
  return {
    id,
    name,
    city: str(raw.city, 80) || city?.name || '',
    district: '',
    address: composeAddress(raw, city?.name),
    location: lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lng, lat } : null,
    tel: str(raw.phone ?? raw.phoneNumber, 40),
    rating: toFive(raw.rating),
    reviewCount: int(raw.reviewCount) ?? 0,
    openedYear: null,
    amenities: dedupe(facilities.map((f) => str(f, 60)).filter(Boolean)).slice(0, 20),
    category: categoryForStars(stars),
    stars: stars !== null && stars > 0 ? stars : null,
    businessArea: '',
    tags: chain && !/^not available$/i.test(chain) ? [chain] : [],
    photos: dedupe([raw.main_photo, raw.thumbnail].filter(isUrl)).slice(0, 2),
    priceHint: null,
    source: 'liteapi',
    countryCode: str(raw.country, 4).toUpperCase() || 'US',
  };
}

function bedText(bedTypes) {
  const beds = (Array.isArray(bedTypes) ? bedTypes : []).filter(isPlainObject).map((b) => {
    const q = int(b.quantity) || 1;
    const type = str(b.bedType ?? b.type, 40).replace(/\s*bed$/i, '');
    return type ? `${q} ${type} bed${q > 1 ? 's' : ''}` : '';
  }).filter(Boolean);
  return beds.join(' + ');
}

function mapRoomInfo(r) {
  const id = str(r.id ?? r.roomId, 40);
  if (!id) return null;
  const size = num(r.roomSizeSquare ?? r.roomSize);
  const unit = String(r.roomSizeUnit ?? '').toLowerCase();
  const sqm = size === null ? null : /f/.test(unit) ? Math.round(size / 10.7639) : Math.round(size);
  return {
    id,
    name: plainText(r.roomName ?? r.name, 100),
    bed: bedText(r.bedTypes),
    areaSqm: sqm,
    areaSqft: sqm === null ? null : Math.round(sqm * 10.7639),
    maxOccupancy: int(r.maxOccupancy),
    photos: (Array.isArray(r.photos) ? r.photos : []).map((p) => (isPlainObject(p) ? p.hd_url ?? p.urlHd ?? p.url : p)).filter(isUrl).slice(0, 4),
  };
}

/** /data/hotel detail → Hotel with photos, amenities, description, phone, check-in/out times and room info. */
export function mapLiteApiHotelDetails(raw, { city } = {}) {
  const base = mapLiteApiHotel(raw, { city });
  if (!base) return null;
  const images = (Array.isArray(raw.hotelImages) ? raw.hotelImages : [])
    .filter(isPlainObject)
    .sort((a, b) => (b.defaultImage === true) - (a.defaultImage === true) || (num(a.order) ?? 999) - (num(b.order) ?? 999))
    .map((i) => i.urlHd || i.url)
    .filter(isUrl);
  const facilities = Array.isArray(raw.hotelFacilities) ? raw.hotelFacilities.map((f) => str(f, 60))
    : Array.isArray(raw.facilities) ? raw.facilities.map((f) => str(isPlainObject(f) ? f.name : f, 60)) : [];
  const times = isPlainObject(raw.checkinCheckoutTimes) ? raw.checkinCheckoutTimes : {};
  const checkIn = to24h(times.checkin ?? times.checkinStart ?? times.checkIn);
  const checkOut = to24h(times.checkout ?? times.checkOut);
  return {
    ...base,
    tel: str(raw.phone ?? raw.phoneNumber ?? raw.contactPhone, 40) || base.tel,
    photos: dedupe([...images, ...base.photos]).slice(0, 10),
    amenities: dedupe(facilities.filter(Boolean)).slice(0, 20),
    description: plainText(raw.hotelDescription, 800),
    importantInformation: plainText(raw.hotelImportantInformation, 600),
    // Times are 24-hour "HH:MM" in the hotel's zone; the US defaults apply when the hotel gives none.
    checkInTime: checkIn || '15:00',
    checkOutTime: checkOut || '11:00',
    timesFromHotel: Boolean(checkIn || checkOut),
    rooms: (Array.isArray(raw.rooms) ? raw.rooms : []).filter(isPlainObject).map(mapRoomInfo).filter(Boolean).slice(0, 40),
  };
}

// ---------------------------------------------------------------------------
// Rates → RoomOffer
// ---------------------------------------------------------------------------

function moneyOf(v) {
  if (Array.isArray(v)) return v.length ? moneyOf(v[0]) : null;
  if (isPlainObject(v)) return num(v.amount);
  return num(v);
}

function sum(values) {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function feesExcluded(list) {
  return (Array.isArray(list) ? list : []).filter((f) => isPlainObject(f) && f.included === false).reduce((s, f) => s + (num(f.amount) || 0), 0);
}

function boardOf(type, name) {
  const code = String(type || '').trim().toUpperCase();
  const known = LITEAPI.boards[code];
  if (known) return { code, label: known[0], breakfast: known[1] };
  const n = String(name || '');
  if (/breakfast/i.test(n)) return { code: code || 'BB', label: 'Breakfast included', breakfast: true };
  if (/all.?inclusive/i.test(n)) return { code: code || 'AI', label: 'All inclusive', breakfast: true };
  return { code: code || 'RO', label: plainText(n, 40) || 'Room only', breakfast: false };
}

/**
 * LiteAPI cancellationPolicies → { type: 'free'|'none', freeUntil (ISO)|null, label, text, penalties: [{ from, amount }] }.
 * `penalties` lists what cancelling costs from each time on (USD for the whole offer); penaltyAt() reads it.
 */
export function mapCancelPolicy(cp, { total = null, now = Date.now() } = {}) {
  const tag = String(cp?.refundableTag ?? '').trim().toUpperCase();
  const steps = (Array.isArray(cp?.cancelPolicyInfos) ? cp.cancelPolicyInfos : [])
    .filter(isPlainObject)
    .map((i) => ({ at: liteApiTimeToIso(i.cancelTime, i.timezone), amount: num(i.amount), tz: i.timezone }))
    .filter((i) => i.at && i.amount !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const refundable = tag === 'RFN' || (tag !== 'NRFN' && steps.length > 0);
  if (!refundable) {
    return { type: 'none', freeUntil: null, label: 'Non-refundable', text: 'Non-refundable: there\'s no refund if you cancel.', penalties: total !== null ? [{ from: null, amount: round2(total) }] : [] };
  }
  const firstPaid = steps.find((s) => s.amount > 0);
  if (!firstPaid) {
    return { type: 'free', freeUntil: null, label: 'Free cancellation', text: 'Free cancellation. The exact deadline is shown before you pay.', penalties: [] };
  }
  const when = formatDeadline(firstPaid.at, firstPaid.tz);
  const fee = total !== null && firstPaid.amount >= total - 0.009 ? 'the full price' : formatUsd(firstPaid.amount);
  const passed = now >= Date.parse(firstPaid.at);
  return {
    type: 'free',
    freeUntil: firstPaid.at,
    label: passed ? 'Cancellation fee applies' : 'Free cancellation',
    text: passed ? `Free cancellation ended ${when}. Cancelling now costs ${fee}.` : `Free cancellation until ${when}. After that, cancelling costs ${fee}.`,
    penalties: steps.map((s) => ({ from: s.at, amount: round2(s.amount) })),
  };
}

/** What cancelling costs at `atMs` under a policy from mapCancelPolicy (never more than `total`). */
export function penaltyAt(policy, atMs, total) {
  const cap = Number.isFinite(total) ? total : Infinity;
  if (policy?.type === 'none') return Number.isFinite(total) ? round2(total) : 0;
  let p = 0;
  for (const s of policy?.penalties || []) if (!s.from || Date.parse(s.from) <= atMs) p = s.amount;
  return round2(Math.min(cap, p));
}

function combinePolicies(policies) {
  if (policies.length === 1) return policies[0];
  if (policies.some((p) => p.type === 'none')) return policies.find((p) => p.type === 'none');
  const times = [...new Set(policies.flatMap((p) => p.penalties.map((s) => s.from)).filter(Boolean))].sort((a, b) => Date.parse(a) - Date.parse(b));
  const penalties = times.map((t) => ({ from: t, amount: round2(policies.reduce((s, p) => s + penaltyAt(p, Date.parse(t), Infinity), 0)) }));
  const earliest = policies.filter((p) => p.freeUntil).sort((a, b) => Date.parse(a.freeUntil) - Date.parse(b.freeUntil))[0] || policies[0];
  return { ...earliest, penalties };
}

function stayNights(checkIn, checkOut) {
  const out = [];
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let t = start; t < end && out.length < 60; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** An even per-night split of a per-room total, to the cent (the last night takes the rounding). */
function splitNightly(perRoom, nights) {
  if (!nights.length) return [];
  const cents = Math.round(perRoom * 100);
  const base = Math.floor(cents / nights.length);
  return nights.map((date, i) => ({ date, price: (i === nights.length - 1 ? cents - base * (nights.length - 1) : base) / 100 }));
}

/** Lowest bookable average nightly price per room (USD, cents), or null when nothing is bookable. */
export function lowestNightly(offer) {
  let best = null;
  for (const rt of offer?.roomTypes || []) {
    for (const r of rt.rates) {
      if (!r.available) continue;
      const avg = round2(r.totalPrice / (offer.rooms || 1) / (offer.nights || 1));
      if (best === null || avg < best) best = avg;
    }
  }
  return best;
}

/** Same as pricing.findRate for live offers. */
export function findRate(offer, rateId) {
  for (const rt of offer?.roomTypes || []) {
    const rate = rt.rates.find((r) => r.rateId === rateId);
    if (rate) return { roomType: rt, rate };
  }
  return null;
}

/**
 * One hotel's entry of a /hotels/rates answer → { offer: RoomOffer, refs: Map(rateId → { offerId, total }) }.
 * Each LiteAPI roomType is one bookable offer; offers of the same room become rates of one room type. rateId is a
 * short hash of what the guest picks (room, board, cancellation terms), so it survives a re-search of the same stay
 * while the long offerId stays server-side.
 */
export function mapLiteApiRates(entry, { hotelId, checkIn, checkOut, adults = 2, children = 0, rooms = 1, now = Date.now(), sandbox = false } = {}) {
  const nights = stayNights(checkIn, checkOut);
  const id = str(entry?.hotelId ?? entry?.id, 80) || hotelId;
  const offer = {
    hotelId: id, checkIn, checkOut, nights: nights.length, adults, children, rooms, roomTypes: [],
    currency: 'USD', live: true, demo: false, sandbox: Boolean(sandbox),
    priceDisclaimer: sandbox ? 'Sandbox prices (test mode): nothing is charged' : 'Live prices in USD for the whole stay, taxes included unless noted',
  };
  const refs = new Map();
  const fitOcc = Math.ceil((adults + children) / Math.max(1, rooms));
  const adultsPerRoom = Math.ceil(adults / Math.max(1, rooms));
  const groups = new Map();
  for (const rt of Array.isArray(entry?.roomTypes) ? entry.roomTypes : []) {
    if (!isPlainObject(rt)) continue;
    const offerId = str(rt.offerId, 8000);
    const rates = (Array.isArray(rt.rates) ? rt.rates : []).filter(isPlainObject);
    if (!offerId || !rates.length) continue;
    const total = moneyOf(rt.offerRetailRate) ?? sum(rates.map((r) => moneyOf(r.retailRate?.total)));
    if (!(total > 0)) continue;
    const first = rates[0];
    const roomName = plainText(first.name, 100) || 'Room';
    const mapped = str(first.mappedRoomId, 40);
    const roomKey = mapped ? `m${mapped}` : `n${roomName.toLowerCase()}`;
    const board = boardOf(first.boardType, first.boardName);
    const policy = combinePolicies(rates.map((r) => mapCancelPolicy(r.cancellationPolicies, { total: rates.length === 1 ? total : moneyOf(r.retailRate?.total), now })));
    const excluded = rates.reduce((s, r) => s + feesExcluded(r.retailRate?.taxesAndFees), 0);
    const ssp = moneyOf(rt.suggestedSellingPrice) ?? sum(rates.map((r) => moneyOf(r.retailRate?.suggestedSellingPrice)));
    const maxOcc = Math.max(0, ...rates.map((r) => int(r.maxOccupancy) || (int(r.adultCount) || 0) + (int(r.childCount) || 0)));
    const rateId = `L${shortHash([id, roomKey, board.code, policy.type, policy.freeUntil || '', rates.length].join('|'))}`;
    const rate = {
      rateId,
      name: `${board.label} · ${policy.label}`,
      breakfast: board.breakfast ? Math.min(2, Math.max(1, adultsPerRoom)) : 0,
      boardType: board.code,
      cancelPolicy: { type: policy.type, freeUntil: policy.freeUntil, text: policy.text, penalties: policy.penalties },
      refundable: policy.type !== 'none',
      payment: 'prepay',
      nightly: splitNightly(total / Math.max(1, rooms), nights),
      totalPrice: round2(total),
      currency: 'USD',
      ...(excluded > 0 ? { payAtProperty: { amount: round2(excluded), currency: 'USD', text: `Plus ${formatUsd(excluded)} in fees paid at the hotel` } } : {}),
      ...(ssp && ssp > total ? { publicPrice: round2(ssp) } : {}),
      available: true,
      remaining: null,
      unavailableReason: null,
    };
    const g = groups.get(roomKey) || { roomKey, name: roomName, mappedRoomId: mapped || null, maxOccupancy: 0, rates: new Map() };
    const prev = g.rates.get(rateId);
    // The same room, board and terms from two suppliers: the cheaper one is offered.
    if (!prev || rate.totalPrice < prev.rate.totalPrice) g.rates.set(rateId, { rate, offerId });
    g.maxOccupancy = Math.max(g.maxOccupancy, maxOcc);
    groups.set(roomKey, g);
  }
  for (const g of groups.values()) {
    const kept = [...g.rates.values()].sort((a, b) => a.rate.totalPrice - b.rate.totalPrice).slice(0, MAX_RATES_PER_ROOM);
    for (const { rate, offerId } of kept) refs.set(rate.rateId, { offerId, total: rate.totalPrice });
    offer.roomTypes.push({
      roomId: `R${shortHash(g.roomKey).slice(0, 8)}`,
      name: g.name,
      bed: '',
      areaSqm: null,
      // Rates come back for the party asked about, so they always fit it.
      maxOccupancy: Math.max(g.maxOccupancy, fitOcc),
      window: '',
      floor: '',
      mappedRoomId: g.mappedRoomId,
      photos: [],
      rates: kept.map((x) => x.rate),
    });
  }
  offer.roomTypes.sort((a, b) => a.rates[0].totalPrice - b.rates[0].totalPrice);
  offer.roomTypes = offer.roomTypes.slice(0, MAX_ROOM_TYPES);
  return { offer, refs };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function mapStatus(s) {
  const key = String(s || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (LITEAPI.statuses[key]) return LITEAPI.statuses[key];
  if (/CANCEL/.test(key)) return 'cancelled';
  if (/CONFIRM/.test(key)) return 'confirmed';
  if (/FAIL|REJECT|ERROR/.test(key)) return 'failed';
  return 'pending';
}

/** /bookings and /rates/book answers → a booking summary (no card data; guest names only as given). */
export function mapLiteApiBooking(raw, { now = Date.now() } = {}) {
  const b = isPlainObject(raw) ? raw : {};
  const price = num(b.price ?? b.totalAmount ?? moneyOf(b.retailRate?.total));
  const hotel = isPlainObject(b.hotel) ? b.hotel : {};
  const holder = isPlainObject(b.holder) ? b.holder : {};
  return {
    bookingId: str(b.bookingId ?? b.id, 80),
    status: mapStatus(b.status),
    supplierStatus: str(b.status, 40),
    hotelConfirmationCode: str(b.hotelConfirmationCode ?? b.confirmationCode, 80),
    supplierBookingId: str(b.supplierBookingId, 80),
    clientReference: str(b.clientReference, 80),
    hotel: { id: str(hotel.hotelId ?? hotel.id ?? b.hotelId, 80), name: plainText(hotel.name ?? b.hotelName, 120) },
    checkIn: str(b.checkin ?? b.checkIn, 10),
    checkOut: str(b.checkout ?? b.checkOut, 10),
    price: price === null ? null : round2(price),
    currency: str(b.currency, 4) || 'USD',
    holder: { firstName: str(holder.firstName, 60), lastName: str(holder.lastName, 60), email: str(holder.email, 120) },
    rooms: (Array.isArray(b.bookedRooms) ? b.bookedRooms : []).filter(isPlainObject).map((r) => ({
      name: plainText(r.roomType?.name ?? r.name, 100),
      adults: int(r.adults) ?? null,
      children: int(r.children) ?? null,
      board: plainText(r.rate?.boardName ?? r.boardName, 40),
    })),
    cancelPolicy: mapCancelPolicy(b.cancellationPolicies, { total: price, now }),
    createdAt: str(b.createdAt, 40),
  };
}

export function mapLiteApiCancellation(raw, { bookingId } = {}) {
  const c = isPlainObject(raw) ? raw : {};
  const status = mapStatus(c.status);
  return {
    bookingId: str(c.bookingId ?? bookingId, 80),
    status,
    supplierStatus: str(c.status, 40),
    cancelled: status === 'cancelled',
    penalty: round2(num(c.cancellation_fee ?? c.cancellationFee) ?? 0),
    refund: num(c.refund_amount ?? c.refundAmount) === null ? null : round2(num(c.refund_amount ?? c.refundAmount)),
    currency: str(c.currency, 4) || 'USD',
  };
}

function splitName(full) {
  const parts = String(full ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts.slice(0, -1).join(' ').slice(0, 60), lastName: parts.at(-1).slice(0, 60) };
}

function personOf(g) {
  if (typeof g === 'string') return splitName(g);
  if (isPlainObject(g)) {
    const firstName = str(g.firstName, 60);
    const lastName = str(g.lastName, 60);
    if (firstName && lastName) return { firstName, lastName };
    if (g.name) return splitName(g.name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const SOLD_OUT_RE = /no availability|not available|sold ?out|no longer available|no rooms? available|offer (has )?expired|offer.{0,20}not (found|valid)/i;
const NOT_FOUND_RE = /not found|does not exist|unknown (hotel|booking)|invalid (hotel|booking) ?id/i;
const PRICE_RE = /price (has )?changed|price change/i;
const EXPIRED_RE = /prebook.{0,40}(expired|not found|invalid)|session expired/i;
const PAYMENT_RE = /payment|card|declined|transaction|insufficient funds|3ds|authori[sz]ation/i;
const NOT_CANCELLABLE_RE = /not cancell?able|cannot be cancell?ed|can't be cancell?ed|already cancell?ed|non-?refundable/i;

function errorInfo(body) {
  if (body == null) return { code: '', message: '' };
  if (typeof body === 'string') return { code: '', message: body.replace(/<[^>]*>/g, ' ').slice(0, 300) };
  const e = isPlainObject(body.error) ? body.error : body;
  const message = typeof body.error === 'string' ? body.error : e.description ?? e.message ?? body.message ?? '';
  return { code: String(e.code ?? body.code ?? ''), message: String(message).slice(0, 300) };
}

/** HTTP status (200 = an error inside a 200 body) + LiteAPI error body → LiveServiceError. */
export function classifyLiteApiError(status, body, headers) {
  const info = errorInfo(body);
  let code = status && status !== 200 ? codeForStatus(status) : 'bad_request';
  if (code === 'bad_request' || code === 'not_found') {
    if (info.code === '2001' || SOLD_OUT_RE.test(info.message)) code = 'sold_out';
    else if (PRICE_RE.test(info.message)) code = 'price_changed';
    else if (NOT_FOUND_RE.test(info.message)) code = 'not_found';
  }
  return new LiveServiceError('liteapi', code, {
    status,
    providerCode: info.code,
    retryAfterMs: parseRetryAfterMs(headers),
    message: `LiteAPI ${status || ''} ${info.code} ${info.message}`.replace(/\s+/g, ' ').trim(),
  });
}

/** The same failure means different things per call: a 400 on book about the card is a failed payment. */
function refine(err, op) {
  if (!(err instanceof LiveServiceError) || !['bad_request', 'not_found', 'sold_out'].includes(err.code)) return err;
  let code = null;
  if (op === 'book' && PAYMENT_RE.test(err.message)) code = 'payment_failed';
  else if ((op === 'book' || op === 'prebook') && EXPIRED_RE.test(err.message)) code = 'expired';
  else if (op === 'cancel' && NOT_CANCELLABLE_RE.test(err.message)) code = 'not_cancellable';
  if (!code || code === err.code) return err;
  return new LiveServiceError('liteapi', code, { status: err.status, providerCode: err.providerCode, message: err.message, cause: err });
}

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

function clampInt(v, min, max, dflt) {
  const n = num(v);
  if (n === null) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Rooms of the party: adults spread evenly (each room ≥ 1), children too, with ages. */
export function buildOccupancies({ adults = 2, children = 0, rooms = 1, childAges = [] } = {}) {
  const r = clampInt(rooms, 1, 9, 1);
  const a = Math.max(r, clampInt(adults, 1, 36, 2));
  const c = clampInt(children, 0, 18, 0);
  const ages = Array.from({ length: c }, (_, i) => clampInt(childAges?.[i], 0, 17, LITEAPI.defaultChildAge));
  return Array.from({ length: r }, (_, i) => ({
    adults: Math.floor(a / r) + (i < a % r ? 1 : 0),
    children: ages.filter((_, k) => k % r === i),
  }));
}

function stayOf({ checkIn, checkOut, adults = 2, children = 0, rooms = 1, childAges } = {}) {
  const ci = str(checkIn, 10);
  const co = str(checkOut, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co) || co <= ci) {
    throw new LiveServiceError('liteapi', 'bad_request', { message: `LiteAPI: invalid stay ${ci} → ${co}`, userMessage: 'Those dates don\'t work. Please pick a check-in date before the check-out date.' });
  }
  const occupancies = buildOccupancies({ adults, children, rooms, childAges });
  const a = occupancies.reduce((s, o) => s + o.adults, 0);
  const c = occupancies.reduce((s, o) => s + o.children.length, 0);
  return { checkIn: ci, checkOut: co, adults: a, children: c, rooms: occupancies.length, occupancies, occKey: JSON.stringify(occupancies) };
}

function unwrap(body) {
  return isPlainObject(body) && 'data' in body ? body.data : body;
}

/**
 * @param {{ apiKey: string, paymentKey?: string, fetch?: typeof fetch, clock?: { now: () => Date }, logger?: object|Function,
 *           geocoder?: { geocode(text: string, opts: object): Promise<{ name, lat, lng, address, types }|null> },
 *           sandbox?: boolean, timeoutMs?: number, maxRetries?: number, sleep?: Function, guestNationality?: string }} opts
 *   paymentKey: the publishable "Payment SDK" key (LITEAPI_PAYMENT_KEY, via readLiveConfig) the card form needs.
 *   geocoder: src/live/places.js createPlacesConnector(), used by resolveLandmark ("near Times Square").
 */
export function createLiteApiSupplier({
  apiKey, paymentKey = '', fetch, clock = { now: () => new Date() }, logger, geocoder = null, sandbox, timeoutMs, maxRetries = 2, sleep,
  guestNationality = 'US',
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('createLiteApiSupplier: apiKey is required');
  const isSandbox = sandbox ?? isLiteApiSandboxKey(key);
  const publishableKey = String(paymentKey || '').trim() || null;
  const environment = isSandbox ? LITEAPI.paymentSdk.sandboxEnvironment : LITEAPI.paymentSdk.liveEnvironment;
  const nowMs = () => clock.now().getTime();
  const common = {
    fetch,
    logger,
    sleep,
    maxRetries,
    secrets: [key],
    headers: { [LITEAPI.apiKeyHeader]: key },
    classify: classifyLiteApiError,
    checkBody: (body) => (isPlainObject(body) && isPlainObject(body.error) ? classifyLiteApiError(200, body) : null),
  };
  const dataApi = createHttpClient({ service: 'liteapi', baseUrl: LITEAPI.dataBaseUrl, timeoutMs: timeoutMs ?? 20000, ...common });
  const bookApi = createHttpClient({ service: 'liteapi', baseUrl: LITEAPI.bookBaseUrl, timeoutMs: timeoutMs ?? 60000, ...common });

  const staticCache = createTtlCache({ max: 200, ttlMs: STATIC_TTL_MS, now: nowMs });
  const detailCache = createTtlCache({ max: 1000, ttlMs: DETAILS_TTL_MS, now: nowMs });
  const rateCache = createTtlCache({ max: 2000, ttlMs: RATES_TTL_MS, now: nowMs });
  const offerRefs = createTtlCache({ max: 20000, ttlMs: OFFER_REF_TTL_MS, now: nowMs });
  const refKey = (hotelId, stay, rateId) => `${hotelId}|${stay.checkIn}|${stay.checkOut}|${stay.occKey}|${rateId}`;

  /** Static hotel list; a circle already fetched with a radius at least as large is reused (filtered by the caller). */
  async function listHotels({ city, center, radiusM, signal }) {
    const radius = clampInt(radiusM, 1000, 50000, 5000);
    const query = center
      ? { latitude: center.lat.toFixed(5), longitude: center.lng.toFixed(5), radius, limit: MAX_STATIC }
      : { countryCode: 'US', cityName: city.name, limit: MAX_STATIC };
    const cacheKey = center ? `geo|${query.latitude}|${query.longitude}` : `city|${city.name.toLowerCase()}`;
    const hit = staticCache.get(cacheKey);
    if (hit && (!center || hit.radius >= radius)) return hit.list;
    const { data } = await dataApi.request({ path: LITEAPI.paths.hotels, query, signal });
    const raw = unwrap(data);
    const list = (Array.isArray(raw) ? raw : []).map((h) => mapLiteApiHotel(h, { city })).filter(Boolean);
    staticCache.set(cacheKey, { list, radius });
    return list;
  }

  async function getHotel(hotelId, { signal } = {}) {
    const id = str(hotelId, 80);
    if (!id) return null;
    const hit = detailCache.get(id);
    if (hit !== undefined) return hit;
    try {
      const { data } = await dataApi.request({ path: LITEAPI.paths.hotel, query: { hotelId: id }, signal });
      const hotel = mapLiteApiHotelDetails(unwrap(data));
      detailCache.set(id, hotel);
      return hotel;
    } catch (err) {
      if (err instanceof LiveServiceError && (err.code === 'not_found' || err.code === 'sold_out')) {
        detailCache.set(id, null, 10 * 60 * 1000);
        return null;
      }
      throw err;
    }
  }

  async function ratesFor(hotelIds, stay, { signal, fresh = false } = {}) {
    const out = new Map();
    const missing = [];
    for (const id of hotelIds) {
      const k = `${id}|${stay.checkIn}|${stay.checkOut}|${stay.occKey}`;
      const hit = fresh ? undefined : rateCache.get(k);
      // Copies: callers may change an offer (promotions), as they can with the simulator's fresh ones.
      if (hit) out.set(id, structuredClone(hit));
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      let entries = [];
      try {
        const { data } = await dataApi.request({
          method: 'POST',
          path: LITEAPI.paths.rates,
          body: {
            hotelIds: batch,
            occupancies: stay.occupancies,
            currency: 'USD',
            guestNationality,
            checkin: stay.checkIn,
            checkout: stay.checkOut,
            timeout: LITEAPI.ratesTimeoutSeconds,
            roomMapping: true,
          },
          signal,
          // A guest is waiting on this: one retry at most (LiteAPI itself waits `timeout` seconds for suppliers).
          retry: true,
          maxRetries: Math.min(1, maxRetries),
          timeoutMs: timeoutMs ?? 20000,
        });
        const raw = unwrap(data);
        entries = Array.isArray(raw) ? raw.filter(isPlainObject) : [];
      } catch (err) {
        // "No availability" is an answer, not a failure.
        if (!(err instanceof LiveServiceError && err.code === 'sold_out')) throw err;
      }
      const byId = new Map(entries.map((e) => [str(e.hotelId ?? e.id, 80), e]));
      for (const id of batch) {
        const { offer, refs } = mapLiteApiRates(byId.get(id) || { hotelId: id, roomTypes: [] }, { ...stay, hotelId: id, now: nowMs(), sandbox: isSandbox });
        for (const [rateId, ref] of refs) offerRefs.set(refKey(id, stay, rateId), ref);
        rateCache.set(`${id}|${stay.checkIn}|${stay.checkOut}|${stay.occKey}`, offer, offer.roomTypes.length ? RATES_TTL_MS : EMPTY_RATES_TTL_MS);
        out.set(id, structuredClone(offer));
      }
    }
    return out;
  }

  /** Room details (bed, size, photos) from /data/hotel added to the offer's room types. */
  function enrich(offer, hotel) {
    if (!hotel?.rooms?.length) return offer;
    const byId = new Map(hotel.rooms.map((r) => [r.id, r]));
    return {
      ...offer,
      roomTypes: offer.roomTypes.map((rt) => {
        const info = rt.mappedRoomId ? byId.get(rt.mappedRoomId) : null;
        if (!info) return rt;
        return { ...rt, bed: info.bed || rt.bed, areaSqm: info.areaSqm ?? rt.areaSqm, areaSqft: info.areaSqft ?? null, photos: info.photos.length ? info.photos : rt.photos };
      }),
    };
  }

  /**
   * City-wide or around a point. With dates every hotel comes back priced: `offer` (RoomOffer) and `lowestPrice`
   * (USD per room per night, null = no availability). Without dates: unpriced (offer null).
   * @param {{ city: string, location?: { lng: number, lat: number }, radiusM?: number, categories?: string[],
   *           checkIn?: string, checkOut?: string, adults?: number, children?: number, rooms?: number,
   *           childAges?: number[], limit?: number, signal?: AbortSignal }} q
   */
  async function searchHotels({ city, location, radiusM, categories, checkIn, checkOut, adults = 2, children = 0, rooms = 1, childAges, limit = 30, signal } = {}) {
    const c = resolveUsCity(city);
    if (!c) return [];
    const point = location && Number.isFinite(location.lat) && Number.isFinite(location.lng) ? { lat: location.lat, lng: location.lng } : null;
    const center = point || (c.center ? { lat: c.center.lat, lng: c.center.lng } : null);
    // Around a landmark a wider circle is fetched once (cached), so a relaxed radius needs no new request.
    const fetchRadius = point ? Math.max(5000, Math.min(20000, (Number.isFinite(radiusM) ? radiusM : 3000) * 2)) : c.radiusM || 15000;
    let list = await listHotels({ city: c, center, radiusM: fetchRadius, signal });
    const withDistance = list.map((h) => ({ h, d: point && h.location ? distanceMeters({ lat: h.location.lat, lng: h.location.lng }, point) : null }));
    let pool = point && Number.isFinite(radiusM) ? withDistance.filter((x) => x.d !== null && x.d <= radiusM) : withDistance;
    if (Array.isArray(categories) && categories.length) pool = pool.filter((x) => categories.includes(x.h.category));
    // Pricing is one request for the nearest (or best known) hotels, not for every hotel in the city.
    pool.sort(point
      ? (a, b) => (a.d === null) - (b.d === null) || (a.d ?? 0) - (b.d ?? 0)
      : (a, b) => (b.h.stars ?? 0) - (a.h.stars ?? 0) || (b.h.rating ?? 0) - (a.h.rating ?? 0) || b.h.reviewCount - a.h.reviewCount);
    const picked = pool.slice(0, clampInt(limit, 1, 50, 30));
    list = picked.map((x) => ({ ...x.h, distanceM: x.d }));
    if (!checkIn || !checkOut) return list.map((h) => ({ ...h, offer: null, lowestPrice: null }));
    const stay = stayOf({ checkIn, checkOut, adults, children, rooms, childAges });
    const offers = list.length ? await ratesFor(list.map((h) => h.id), stay, { signal }) : new Map();
    return list.map((h) => {
      const offer = offers.get(h.id) || mapLiteApiRates({ hotelId: h.id, roomTypes: [] }, { ...stay, hotelId: h.id, sandbox: isSandbox }).offer;
      return { ...h, offer, lowestPrice: lowestNightly(offer) };
    });
  }

  /** @returns {Promise<{ hotel, offer: RoomOffer }>} throws LiveServiceError not_found for an unknown hotel. */
  async function getRoomOffer({ hotelId, checkIn, checkOut, adults = 2, children = 0, rooms = 1, childAges, signal, fresh = false } = {}) {
    const id = str(hotelId, 80);
    const stay = stayOf({ checkIn, checkOut, adults, children, rooms, childAges });
    const [hotel, offers] = await Promise.all([getHotel(id, { signal }), ratesFor([id], stay, { signal, fresh })]);
    if (!hotel) throw new LiveServiceError('liteapi', 'not_found', { message: `LiteAPI hotel ${id} not found` });
    return { hotel, offer: enrich(offers.get(id), hotel) };
  }

  /**
   * Price lock + payment session for one rate of a stay. The rate is found again by its short rateId (from the
   * cache, else a fresh rates search). Nothing is charged.
   * @returns {Promise<{ prebookId, hotelId, rateId, price, currency, expectedPrice, priceChanged, cancellationChanged,
   *   boardChanged, cancelPolicy, termsAndConditions, payment: { provider, transactionId, secretKey, publishableKey, environment, scriptUrl }|null, sandbox }>}
   */
  async function prebook({ hotelId, rateId, checkIn, checkOut, adults = 2, children = 0, rooms = 1, childAges, usePaymentSdk = true, signal } = {}) {
    const id = str(hotelId, 80);
    const rid = str(rateId, 40);
    const stay = stayOf({ checkIn, checkOut, adults, children, rooms, childAges });
    const lookup = () => offerRefs.get(refKey(id, stay, rid));
    let ref = lookup();
    const fromCache = Boolean(ref);
    if (!ref) {
      await ratesFor([id], stay, { signal, fresh: true });
      ref = lookup();
    }
    if (!ref) throw new LiveServiceError('liteapi', 'sold_out', { message: `LiteAPI rate ${rid} of ${id} is no longer offered` });
    const lock = async (offerId) => {
      try {
        return await bookApi.request({ method: 'POST', path: LITEAPI.paths.prebook, body: { offerId, usePaymentSdk: Boolean(usePaymentSdk) }, signal, retry: false, timeoutMs: timeoutMs ?? 45000 });
      } catch (err) {
        throw refine(err, 'prebook');
      }
    };
    let res;
    try {
      res = await lock(ref.offerId);
    } catch (err) {
      // Offers expire after a while: a remembered one gets one fresh search, and the same room/board/terms is locked.
      if (!(fromCache && err instanceof LiveServiceError && err.code === 'sold_out')) throw err;
      await ratesFor([id], stay, { signal, fresh: true });
      const again = lookup();
      if (!again || again.offerId === ref.offerId) throw err;
      ref = again;
      res = await lock(ref.offerId);
    }
    const d = unwrap(res.data);
    const prebookId = str(d?.prebookId, 200);
    if (!prebookId) throw new LiveServiceError('liteapi', 'unavailable', { message: 'LiteAPI prebook returned no prebookId' });
    const firstRates = (Array.isArray(d.roomTypes) ? d.roomTypes : []).flatMap((rt) => (Array.isArray(rt?.rates) ? rt.rates : [])).filter(isPlainObject);
    const price = num(d.price) ?? sum(firstRates.map((r) => moneyOf(r.retailRate?.total)));
    const policies = firstRates.map((r) => mapCancelPolicy(r.cancellationPolicies, { total: firstRates.length === 1 ? price : moneyOf(r.retailRate?.total), now: nowMs() }));
    const pct = num(d.priceDifferencePercent) ?? 0;
    const secretKey = str(d.secretKey, 500);
    const transactionId = str(d.transactionId, 200);
    return {
      prebookId,
      hotelId: str(d.hotelId, 80) || id,
      rateId: rid,
      price: price === null ? null : round2(price),
      currency: str(d.currency, 4) || 'USD',
      expectedPrice: ref.total,
      priceChanged: (price !== null && Math.abs(price - ref.total) >= 0.01) || pct !== 0,
      cancellationChanged: d.cancellationChanged === true,
      boardChanged: d.boardChanged === true,
      cancelPolicy: policies.length ? combinePolicies(policies) : null,
      termsAndConditions: plainText(d.termsAndConditions, 2000),
      // Everything the card form needs for this order: secretKey is per prebook (send it only to this guest's
      // page, never log it); publishableKey is the account's Payment SDK key (null when LITEAPI_PAYMENT_KEY is unset).
      payment: secretKey && transactionId ? {
        provider: 'liteapi',
        transactionId,
        secretKey,
        publishableKey,
        environment,
        scriptUrl: LITEAPI.paymentSdk.scriptUrl,
      } : null,
      sandbox: isSandbox,
    };
  }

  /**
   * Confirms a prebook once the guest paid in LiteAPI's payment form (transactionId from prebook). Never retried
   * automatically: a timeout here means "check getBooking before trying again".
   * @param {{ prebookId: string, transactionId?: string, holder: { firstName, lastName, email, phone? },
   *           guests?: Array<string|{ firstName, lastName }>, rooms?: number, clientReference?: string,
   *           paymentMethod?: 'TRANSACTION_ID'|'ACC_CREDIT_CARD', signal?: AbortSignal }} b
   */
  async function book({ prebookId, transactionId, holder, guests = [], rooms = 1, clientReference, paymentMethod = 'TRANSACTION_ID', signal } = {}) {
    const pid = str(prebookId, 200);
    const h = isPlainObject(holder) ? holder : {};
    const firstName = str(h.firstName, 60);
    const lastName = str(h.lastName, 60);
    const email = str(h.email, 120);
    const bad = (message, userMessage) => new LiveServiceError('liteapi', 'bad_request', { message, userMessage });
    if (!pid) throw bad('LiteAPI book: prebookId is required', 'That price hold is missing. Let me get you a fresh price.');
    if (!firstName || !lastName) throw bad('LiteAPI book: holder name is required', 'Please enter a first and last name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('LiteAPI book: holder email is invalid', 'That email doesn\'t look right');
    const tid = str(transactionId, 200);
    if (paymentMethod === 'TRANSACTION_ID' && !tid) throw bad('LiteAPI book: transactionId is required', 'The payment isn\'t finished yet.');
    const count = clampInt(rooms, 1, 9, 1);
    const people = (Array.isArray(guests) ? guests : []).map(personOf).filter(Boolean);
    const body = {
      prebookId: pid,
      holder: { firstName, lastName, email, ...(str(h.phone, 20) ? { phone: str(h.phone, 20) } : {}) },
      payment: paymentMethod === 'TRANSACTION_ID' ? { method: 'TRANSACTION_ID', transactionId: tid } : { method: paymentMethod },
      guests: Array.from({ length: count }, (_, i) => ({ occupancyNumber: i + 1, ...(people[i] || { firstName, lastName }), email })),
      ...(str(clientReference, 80) ? { clientReference: str(clientReference, 80) } : {}),
    };
    let res;
    try {
      res = await bookApi.request({ method: 'POST', path: LITEAPI.paths.book, body, signal, retry: false, timeoutMs: timeoutMs ?? 120000 });
    } catch (err) {
      throw refine(err, 'book');
    }
    const booking = mapLiteApiBooking(unwrap(res.data), { now: nowMs() });
    if (!booking.bookingId) throw new LiveServiceError('liteapi', 'unavailable', { message: 'LiteAPI book returned no bookingId' });
    if (booking.status === 'failed') {
      throw new LiveServiceError('liteapi', 'payment_failed', { message: `LiteAPI booking ${booking.bookingId} failed (${booking.supplierStatus})`, details: { bookingId: booking.bookingId } });
    }
    return booking;
  }

  async function getBooking(bookingId, { signal } = {}) {
    const id = str(bookingId, 80);
    if (!id) return null;
    try {
      const { data } = await bookApi.request({ path: `${LITEAPI.paths.booking}/${encodeURIComponent(id)}`, signal });
      return mapLiteApiBooking(unwrap(data), { now: nowMs() });
    } catch (err) {
      if (err instanceof LiveServiceError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /** @returns {Promise<{ bookingId, status, cancelled, penalty, refund, currency }>} */
  async function cancelBooking(bookingId, { signal } = {}) {
    const id = str(bookingId, 80);
    if (!id) throw new LiveServiceError('liteapi', 'bad_request', { message: 'LiteAPI cancel: bookingId is required' });
    let res;
    try {
      res = await bookApi.request({ method: 'PUT', path: `${LITEAPI.paths.booking}/${encodeURIComponent(id)}`, signal, retry: false });
    } catch (err) {
      throw refine(err, 'cancel');
    }
    return mapLiteApiCancellation(unwrap(res.data), { bookingId: id });
  }

  /** "near Times Square" → ResolvedPlace through the geocoder (Google Places, or the demo landmarks). */
  async function resolveLandmark(cityText, text, { signal } = {}) {
    if (!geocoder || typeof geocoder.geocode !== 'function') return null;
    const q = str(text, 120);
    if (!q) return null;
    const c = resolveUsCity(cityText);
    const place = await geocoder.geocode(q, { city: c?.fullName || c?.name || '', near: c?.center ? { lat: c.center.lat, lng: c.center.lng } : null, signal });
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null;
    return { name: place.name, location: { lng: place.lng, lat: place.lat }, area: place.address || '', type: (place.types || [])[0] || '', extentM: 0, matched: 'exact', source: place.source || '' };
  }

  return {
    source: 'liteapi',
    live: true,
    async: true,
    sandbox: isSandbox,
    paymentSdk: Object.freeze({
      scriptUrl: LITEAPI.paymentSdk.scriptUrl,
      publishableKey,
      environment,
      testCard: isSandbox ? LITEAPI.sandboxTestCard : null,
    }),
    listCities: () => US_CITIES.map((c) => ({ name: c.name, tier: 'live' })),
    resolveCity: (text) => resolveUsCity(text),
    resolveLandmark,
    listAreas: () => [],
    searchHotels,
    getHotel,
    getRoomOffer,
    prebook,
    book,
    getBooking,
    cancelBooking,
    cancel: cancelBooking,
    findRate,
    lowestNightly,
  };
}
