// en-US formatting shared by the chat (app.js, cards.js) and the hotel console (merchant.js): dates "Fri, Nov 6",
// ranges "Fri, Nov 6 – Sun, Nov 8", 12-hour times "2:30 PM", money "$1,108" / "$42.50", distances "0.3 mi" /
// "800 ft", party phrases and US phone numbers. Calendar dates ('YYYY-MM-DD') are wall dates and never shift;
// instants (ISO strings) are shown in the user's own time zone, or in the zone passed in (a hotel's), when known.

const LOCALE = 'en-US';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** The user's IANA time zone, e.g. 'America/New_York' ('' when the browser cannot tell). Sent as X-Time-Zone. */
export function userTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && ZONE_RE.test(zone) ? zone : '';
  } catch {
    return '';
  }
}

const formatters = new Map();

/** A cached Intl.DateTimeFormat; an unknown zone falls back to the user's own. */
function dtf(options, timeZone) {
  const zone = typeof timeZone === 'string' && ZONE_RE.test(timeZone) ? timeZone : '';
  const key = `${JSON.stringify(options)}|${zone}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(LOCALE, zone ? { ...options, timeZone: zone } : options);
    } catch {
      f = new Intl.DateTimeFormat(LOCALE, options);
    }
    formatters.set(key, f);
  }
  return f;
}

// Some engines put a narrow no-break space before AM/PM; one plain space everywhere keeps text predictable.
const tidy = (s) => s.replace(/[   ]/g, ' ');
const pad = (n) => String(n).padStart(2, '0');

/** This year on the user's clock. */
export function localYear(nowMs = Date.now()) {
  return new Date(nowMs).getFullYear();
}

/** Today on the user's clock, 'YYYY-MM-DD'. */
export function localYmd(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '2026-11-06' → 'Fri, Nov 6' (or 'Nov 6'); the year is added when it differs from refYear. */
export function formatDate(ymd, withWeekday = true, refYear = localYear()) {
  const s = String(ymd || '');
  if (!ISO_DATE_RE.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const options = { month: 'short', day: 'numeric' };
  if (withWeekday) options.weekday = 'short';
  if (y !== refYear) options.year = 'numeric';
  return dtf(options, 'UTC').format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * 'Fri, Nov 6 – Sun, Nov 8'. The year goes at the end when the stay is not this year ('Fri, Jan 8 – Sun, Jan 10,
 * 2027') and on both ends only when the stay crosses from a year other than this one into the next.
 */
export function formatRange(from, to, { weekday = true, sep = ' – ', refYear = localYear() } = {}) {
  if (!ISO_DATE_RE.test(String(from || ''))) return '';
  if (!ISO_DATE_RE.test(String(to || ''))) return formatDate(from, weekday, refYear);
  const y1 = Number(from.slice(0, 4));
  const y2 = Number(to.slice(0, 4));
  const first = formatDate(from, weekday, y1 === y2 || y1 === refYear ? y1 : NaN);
  const last = formatDate(to, weekday, y1 === refYear && y2 === refYear ? refYear : NaN);
  return `${first}${sep}${last}`;
}

function instant(iso) {
  if (iso == null || iso === '') return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An instant as a 12-hour time: '2:30 PM'. */
export function clockTime(iso, timeZone) {
  const d = instant(iso);
  return d ? tidy(dtf({ hour: 'numeric', minute: '2-digit' }, timeZone).format(d)) : '';
}

/** The day of an instant: 'Fri, Nov 6' (with the year when it is not this year there). */
export function dayOf(iso, timeZone) {
  const d = instant(iso);
  if (!d) return '';
  const year = (date) => dtf({ year: 'numeric' }, timeZone).format(date);
  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  if (year(d) !== year(new Date())) options.year = 'numeric';
  return tidy(dtf(options, timeZone).format(d));
}

/** 'Fri, Nov 6, 2:30 PM'. */
export function dayTime(iso, timeZone) {
  const day = dayOf(iso, timeZone);
  return day ? `${day}, ${clockTime(iso, timeZone)}` : '';
}

function clock12(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const hour = Number(m[1]);
  return { time: `${hour % 12 || 12}:${m[2]}`, half: hour < 12 ? 'AM' : 'PM' };
}

/**
 * A wall-clock time at the hotel (an itinerary, opening hours) in 12-hour form: '14:30' → '2:30 PM',
 * '07:00–10:30' → '7:00–10:30 AM', '11:00–14:00' → '11:00 AM–2:00 PM'. Anything else is returned as it is.
 */
export function wallTime(value) {
  const s = String(value ?? '').trim();
  const one = clock12(s);
  if (one) return `${one.time} ${one.half}`;
  const range = /^(\S+)\s*[–—-]\s*(\S+)$/.exec(s);
  const [a, b] = range ? [clock12(range[1]), clock12(range[2])] : [];
  if (!a || !b) return s;
  return a.half === b.half ? `${a.time}–${b.time} ${b.half}` : `${a.time} ${a.half}–${b.time} ${b.half}`;
}

const usdWhole = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** USD: whole dollars from $100 up ('$1,108'), cents below ('$42.50'); '—' for a missing amount. */
export function formatMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const cents = Math.round(n * 100) / 100;
  return Math.abs(cents) >= 100 ? usdWhole.format(Math.round(n)) : usdCents.format(cents);
}

/** What a card is charged, to the cent: $1,681.82 (whole amounts stay whole: $468). */
export function formatMoneyExact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const cents = Math.round(n * 100) / 100;
  return Number.isInteger(cents) ? usdWhole.format(cents) : usdCents.format(cents);
}

/** Meters → '800 ft' under 1,000 feet, then '0.3 mi' (whole miles from 10). */
export function formatDistance(meters) {
  const m = Number(meters);
  if (meters == null || !Number.isFinite(m) || m < 0) return '';
  const feet = Math.max(50, Math.round((m * 3.28084) / 50) * 50);
  if (feet < 1000) return `${feet} ft`;
  const miles = m / 1609.344;
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

/** plural(2, 'night') → '2 nights'; plural(1, 'child', 'children') → '1 child'; plural(1832, 'review') → '1,832 reviews'. */
export function plural(n, one, many = `${one}s`) {
  const count = Number(n);
  return `${Number.isFinite(count) ? count.toLocaleString(LOCALE) : n} ${count === 1 ? one : many}`;
}

/** '2 adults, 1 child, 2 rooms' (rooms only when more than one). The demo script reads these words. */
export function partyPhrase({ adults, children, rooms } = {}) {
  const parts = [];
  const a = Number(adults) || 0;
  const c = Number(children) || 0;
  const r = Number(rooms) || 0;
  if (a) parts.push(plural(a, 'adult'));
  if (c) parts.push(plural(c, 'child', 'children'));
  if (r > 1) parts.push(plural(r, 'room'));
  return parts.join(', ');
}

/** 0.85 → '15% off' ('' for anything that is not a discount). */
export function percentOff(discount) {
  const off = Math.round((1 - Number(discount)) * 100);
  return Number.isFinite(off) && off > 0 && off < 100 ? `${off}% off` : '';
}

/** A US number in E.164 (+1, area code and exchange not starting with 0 or 1). */
export const US_PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * '(415) 555-0123', '415-555-0123', '+1 415 555 0123', full-width digits → '+14155550123' (the server applies the
 * same rule). Anything that is not a 10-digit US number comes back as its digits, so validation can reject it.
 */
export function normalizePhoneInput(value) {
  const raw = String(value ?? '')
    .replace(/[０-９＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .trim();
  const digits = raw.replace(/\D/g, '');
  const international = raw.startsWith('+');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10 && (!international || digits.length === 11)) return `+1${national}`;
  return digits && international ? `+${digits}` : digits;
}

export const isUsPhone = (value) => US_PHONE_RE.test(normalizePhoneInput(value));

/** As typed: '4155550' → '(415) 555-0'. Longer or international input is left alone. */
export function formatPhoneInput(value) {
  const raw = String(value ?? '');
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) {
    if (!digits.startsWith('1')) return raw;
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (!digits || digits.length > 10) return raw;
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
