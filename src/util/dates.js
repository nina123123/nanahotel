// Date and time helpers. A date is a 'YYYY-MM-DD' calendar string (no zone); an instant is an ISO string or epoch
// ms. Wall-clock conversions take an IANA time zone: the user's (the X-Time-Zone header) for "today" and "tonight",
// a hotel's for times at that hotel. Intl does the zone math, so daylight saving time is handled; formatters are
// cached per zone. Display strings follow en-US: "Fri, Nov 6", "2:30 PM".

export const DEFAULT_TIME_ZONE = 'America/New_York';

const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// IANA names: 'America/New_York', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+5'.
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
// Before this hour (local time) the previous night is still the night in progress: "tonight" at 1:30 AM is the
// night that began yesterday, and that date can still be booked.
const LATE_NIGHT_CUTOFF_HOURS = 6;
const MAX_ALIASES = 500;

const wallFormatters = new Map();
const nameFormatters = new Map();
const aliases = new Map();

function makeWallFormatter(zone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * The canonical IANA name for `zone` ('america/new_york' → 'America/New_York'), or null when it is not a time
 * zone this runtime knows. Only well-formed names are tried, and the alias cache is bounded, so a client sending
 * odd headers cannot grow memory.
 */
export function canonicalTimeZone(zone) {
  if (typeof zone !== 'string') return null;
  const raw = zone.trim();
  if (!raw || raw.length > 64 || !ZONE_RE.test(raw)) return null;
  if (wallFormatters.has(raw)) return raw;
  if (aliases.has(raw)) return aliases.get(raw);
  let canonical = null;
  try {
    const f = makeWallFormatter(raw);
    canonical = f.resolvedOptions().timeZone;
    if (!wallFormatters.has(canonical)) wallFormatters.set(canonical, canonical === raw ? f : makeWallFormatter(canonical));
  } catch {
    canonical = null;
  }
  if (canonical !== raw) {
    if (aliases.size >= MAX_ALIASES) aliases.clear();
    aliases.set(raw, canonical);
  }
  return canonical;
}

export function isValidTimeZone(zone) {
  return canonicalTimeZone(zone) !== null;
}

/** `zone` when valid, else `fallback` (itself checked), else America/New_York. */
export function resolveTimeZone(zone, fallback = DEFAULT_TIME_ZONE) {
  return canonicalTimeZone(zone) || canonicalTimeZone(fallback) || DEFAULT_TIME_ZONE;
}

function formatterFor(zone) {
  return wallFormatters.get(resolveTimeZone(zone));
}

/** Wall-clock parts of an instant in `zone`. */
function wall(ms, zone) {
  const p = {};
  for (const { type, value } of formatterFor(zone).formatToParts(new Date(ms))) p[type] = value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

const pad2 = (n) => String(n).padStart(2, '0');
const msOf = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

/** Local wall time minus UTC, in ms, at the instant `ms` (e.g. -5 h for New York in winter). */
export function zoneOffsetMs(ms, zone) {
  const w = wall(ms, zone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** Strict YYYY-MM-DD check that also rejects impossible dates like 2026-02-30. */
export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Strict 24-hour 'HH:MM'. */
export function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function utcMs(date) {
  if (!isValidDate(date)) throw new RangeError(`Invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

/** The calendar date in `zone` at `now`: 'YYYY-MM-DD'. */
export function todayIn(zone = DEFAULT_TIME_ZONE, now = new Date()) {
  const w = wall(msOf(now), zone);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
}

/** Date, 24-hour 'HH:MM', weekday and the (canonical) zone at `now`. */
export function nowIn(zone = DEFAULT_TIME_ZONE, now = new Date()) {
  const w = wall(msOf(now), zone);
  const date = `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
  return { date, time: `${pad2(w.h)}:${pad2(w.mi)}`, weekday: weekdayShort(date), zone: resolveTimeZone(zone) };
}

/** The local date of an instant (ISO string, ms or Date) in `zone`; '' when it is not an instant. */
export function dateIn(instant, zone = DEFAULT_TIME_ZONE) {
  const ms = msOf(instant);
  return Number.isFinite(ms) ? todayIn(zone, ms) : '';
}

/** The local 24-hour 'HH:MM' of an instant in `zone`; '' when it is not an instant. */
export function timeIn(instant, zone = DEFAULT_TIME_ZONE) {
  const ms = msOf(instant);
  if (!Number.isFinite(ms)) return '';
  const w = wall(ms, zone);
  return `${pad2(w.h)}:${pad2(w.mi)}`;
}

/** Epoch ms of a wall-clock time in `zone` ('2026-11-05', '15:00', 'America/New_York'). */
export function zonedTimeMs(date, hhmm = '00:00', zone = DEFAULT_TIME_ZONE) {
  if (!isValidDate(date)) throw new RangeError(`Invalid date: ${date}`);
  if (!TIME_RE.test(hhmm)) throw new RangeError(`Invalid time: ${hhmm}`);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = zoneOffsetMs(guess, zone);
  let t = guess - first;
  // Across a DST change the offset at the result differs from the one at the guess.
  const second = zoneOffsetMs(t, zone);
  if (second !== first) t = guess - second;
  return t;
}

function offsetText(offsetMs) {
  const sign = offsetMs < 0 ? '-' : '+';
  const minutes = Math.round(Math.abs(offsetMs) / 60000);
  return `${sign}${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** '2026-11-05', '15:00', 'America/New_York' → '2026-11-05T15:00:00-05:00'. */
export function toIsoInZone(date, hhmm = '00:00', zone = DEFAULT_TIME_ZONE) {
  const ms = zonedTimeMs(date, hhmm, zone);
  return `${date}T${hhmm}:00${offsetText(zoneOffsetMs(ms, zone))}`;
}

/** The short zone name at an instant: 'EST', 'PDT', 'HST' for US zones, otherwise like 'GMT+9'. */
export function zoneAbbr(instant, zone = DEFAULT_TIME_ZONE) {
  const name = resolveTimeZone(zone);
  let f = nameFormatters.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'short' });
    nameFormatters.set(name, f);
  }
  const ms = msOf(instant);
  return f.formatToParts(new Date(Number.isFinite(ms) ? ms : Date.now())).find((p) => p.type === 'timeZoneName')?.value || name;
}

/** @returns {string} date shifted by n calendar days */
export function addDays(date, n) {
  return new Date(utcMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** @returns {number} b - a in days (nights for a check-in/check-out pair) */
export function nightsBetween(a, b) {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** @returns {number} 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date) {
  return new Date(utcMs(date)).getUTCDay();
}

/** @returns {string} 'Fri' */
export function weekdayShort(date) {
  return WEEKDAYS[dayOfWeek(date)];
}

/** @returns {string} 'Friday' */
export function weekdayLong(date) {
  return WEEKDAYS_LONG[dayOfWeek(date)];
}

/** @returns {number} 1-12 */
export function monthOf(date) {
  return new Date(utcMs(date)).getUTCMonth() + 1;
}

/**
 * '2026-11-06' → 'Fri, Nov 6'; the year is added ('Fri, Jan 1, 2027') when it differs from `ref`'s year (a date,
 * usually today). Without `ref` the year is never shown.
 */
export function formatDate(date, ref, { weekday = true } = {}) {
  if (!isValidDate(date)) return String(date ?? '');
  const md = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  const year = ref && String(ref).slice(0, 4) !== date.slice(0, 4) ? `, ${date.slice(0, 4)}` : '';
  return `${weekday ? `${weekdayShort(date)}, ` : ''}${md}${year}`;
}

/** 'Fri, Nov 6 – Sun, Nov 8' (each end shows its year when it is not `ref`'s). */
export function formatRange(checkIn, checkOut, ref) {
  return `${formatDate(checkIn, ref)} – ${formatDate(checkOut, ref)}`;
}

/** '14:30' → '2:30 PM', '00:00' → '12:00 AM', '12:00' → '12:00 PM'. */
export function formatTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return String(hhmm ?? '');
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * An instant as 'Fri, Nov 6, 2:30 PM' in `zone` (with the year when it is not `ref`'s); `abbr: true` adds the
 * zone ('2:30 PM EST') for text read by someone who may be somewhere else.
 */
export function formatDateTime(instant, zone = DEFAULT_TIME_ZONE, { ref, abbr = false } = {}) {
  const ms = msOf(instant);
  if (!Number.isFinite(ms)) return String(instant ?? '');
  return `${formatDate(dateIn(ms, zone), ref)}, ${formatTime(timeIn(ms, zone))}${abbr ? ` ${zoneAbbr(ms, zone)}` : ''}`;
}

/** The local time of an instant: '2:30 PM', or '2:30 PM EST' with `abbr`. */
export function formatClock(instant, zone = DEFAULT_TIME_ZONE, { abbr = false } = {}) {
  const ms = msOf(instant);
  if (!Number.isFinite(ms)) return '';
  return `${formatTime(timeIn(ms, zone))}${abbr ? ` ${zoneAbbr(ms, zone)}` : ''}`;
}

/** Night dates of a stay: ['2026-10-30', '2026-10-31'] for 10-30 → 11-01. */
export function stayDates(checkIn, checkOut) {
  const n = nightsBetween(checkIn, checkOut);
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
  return out;
}

/** True between midnight and 5:59 AM local time, when "tonight" is the night in progress. */
export function isLateNight(now = new Date(), zone = DEFAULT_TIME_ZONE) {
  return wall(msOf(now), zone).h < LATE_NIGHT_CUTOFF_HOURS;
}

/**
 * Earliest check-in date at `now` in `zone`: until 6:00 AM local time the night in progress still counts (a
 * guest arriving at 1:30 AM books the night that began yesterday), so before 6 AM this is yesterday, else today.
 * @returns {string} YYYY-MM-DD
 */
export function earliestCheckIn(now = new Date(), zone = DEFAULT_TIME_ZONE) {
  const today = todayIn(zone, now);
  return isLateNight(now, zone) ? addDays(today, -1) : today;
}

/**
 * Validate a stay against `today` (the hotel's date). Missing dates default to tonight → +1 night: tonight is
 * `defaultCheckIn` when given (the user's tonight, from their own time zone) and still bookable, else
 * `earliestCheckIn` (the night in progress before 6 AM), else `today`.
 * @param {{ maxNights?: number, maxAheadDays?: number, allowDefaults?: boolean, earliestCheckIn?: string, defaultCheckIn?: string }} [opts]
 * @returns {{ checkIn, checkOut, nights, datesAssumed } | { error: string }} error is user-facing English
 */
export function checkStay(checkIn, checkOut, today, {
  maxNights = 30, maxAheadDays = 365, allowDefaults = true, earliestCheckIn: floorOpt, defaultCheckIn,
} = {}) {
  const floor = isValidDate(floorOpt) && floorOpt < today ? floorOpt : today;
  let ci = typeof checkIn === 'string' ? checkIn.trim() : '';
  let co = typeof checkOut === 'string' ? checkOut.trim() : '';
  let datesAssumed = false;
  if (!ci) {
    if (!allowDefaults) return { error: 'A check-in date is needed (YYYY-MM-DD)' };
    // The user's tonight wins while it is still bookable here and not more than a day off (another time zone).
    ci = isValidDate(defaultCheckIn) && defaultCheckIn >= floor && nightsBetween(today, defaultCheckIn) <= 1 ? defaultCheckIn : floor;
    datesAssumed = true;
  }
  if (!isValidDate(ci)) return { error: `The check-in date "${ci.slice(0, 20)}" isn't a valid date; use YYYY-MM-DD` };
  if (!co) {
    if (!allowDefaults) return { error: 'A check-out date is needed (YYYY-MM-DD)' };
    co = addDays(ci, 1);
    datesAssumed = true;
  }
  if (!isValidDate(co)) return { error: `The check-out date "${co.slice(0, 20)}" isn't a valid date; use YYYY-MM-DD` };
  if (ci < floor) {
    const lateNight = floor < today ? `; it's after midnight, so the night in progress (${formatDate(floor)}) can still be booked until 6 AM` : '';
    return { error: `Check-in on ${formatDate(ci, today)} (${ci}) has already passed (today is ${formatDate(today)}, ${today}${lateNight})` };
  }
  if (nightsBetween(today, ci) > maxAheadDays) return { error: `Bookings can only be made up to ${maxAheadDays} days ahead` };
  const nights = nightsBetween(ci, co);
  if (nights < 1) return { error: 'Check-out needs to be after check-in' };
  if (nights > maxNights) return { error: `A single booking can be at most ${maxNights} nights` };
  return { checkIn: ci, checkOut: co, nights, datesAssumed };
}
