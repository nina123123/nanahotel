// China-time (Asia/Shanghai) date helpers. China has no DST, so a fixed +08:00 offset is exact.

const CN_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Before this hour (China time) the previous night is still bookable (凌晨入住).
const LATE_NIGHT_CUTOFF_HOURS = 6;

function shifted(now) {
  return new Date(now.getTime() + CN_OFFSET_MS);
}

/** @param {Date} [now] @returns {string} YYYY-MM-DD in China time */
export function todayCN(now = new Date()) {
  return shifted(now).toISOString().slice(0, 10);
}

/** @param {Date} [now] @returns {{ date: string, time: string, weekday: string }} */
export function nowCN(now = new Date()) {
  const iso = shifted(now).toISOString();
  const date = iso.slice(0, 10);
  return { date, time: iso.slice(11, 16), weekday: weekdayCN(date) };
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

function utcMs(date) {
  if (!isValidDate(date)) throw new RangeError(`无效日期: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
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

/** @returns {string} '周五' */
export function weekdayCN(date) {
  return WEEKDAYS[dayOfWeek(date)];
}

/** @returns {number} 1-12 */
export function monthOf(date) {
  return new Date(utcMs(date)).getUTCMonth() + 1;
}

/** '2026-10-30', '18:00' → '2026-10-30T18:00:00+08:00' */
export function toIsoCN(date, hhmm = '00:00') {
  if (!isValidDate(date)) throw new RangeError(`无效日期: ${date}`);
  if (!TIME_RE.test(hhmm)) throw new RangeError(`无效时间: ${hhmm}`);
  return `${date}T${hhmm}:00+08:00`;
}

/** Epoch ms of a China wall-clock time. */
export function cnTimeMs(date, hhmm = '00:00') {
  return Date.parse(toIsoCN(date, hhmm));
}

/** '2026-10-30' → '10月30日' */
export function formatDateCN(date) {
  if (!isValidDate(date)) return String(date);
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/** ISO instant → '10月29日 18:00' in China time. */
export function formatDateTimeCN(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  const s = shifted(new Date(ms)).toISOString();
  return `${formatDateCN(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

/** Night dates of a stay: ['2026-10-30', '2026-10-31'] for 10-30 → 11-01. */
export function stayDates(checkIn, checkOut) {
  const n = nightsBetween(checkIn, checkOut);
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
  return out;
}

/**
 * Earliest check-in date allowed at `now`: until 06:00 China time the night in progress still counts
 * (凌晨入住 — book yesterday's date), so before 06:00 this is yesterday, otherwise today.
 * @param {Date} [now] @returns {string} YYYY-MM-DD
 */
export function earliestCheckIn(now = new Date()) {
  return todayCN(new Date(now.getTime() - LATE_NIGHT_CUTOFF_HOURS * 3600 * 1000));
}

/**
 * Validate a stay against `today` (China date). Missing dates default to tonight → +1 night, where
 * "tonight" is `earliestCheckIn` when given (the night in progress before 06:00), else `today`.
 * @param {{ maxNights?: number, maxAheadDays?: number, allowDefaults?: boolean, earliestCheckIn?: string }} [opts]
 * @returns {{ checkIn, checkOut, nights, datesAssumed } | { error: string }} error is user-facing Chinese
 */
export function checkStay(checkIn, checkOut, today, { maxNights = 30, maxAheadDays = 365, allowDefaults = true, earliestCheckIn: floorOpt } = {}) {
  const floor = isValidDate(floorOpt) && floorOpt < today ? floorOpt : today;
  let ci = typeof checkIn === 'string' ? checkIn.trim() : '';
  let co = typeof checkOut === 'string' ? checkOut.trim() : '';
  let datesAssumed = false;
  if (!ci) {
    if (!allowDefaults) return { error: '需要入住日期（YYYY-MM-DD）' };
    ci = floor;
    datesAssumed = true;
  }
  if (!isValidDate(ci)) return { error: `入住日期「${ci}」不对，请用 YYYY-MM-DD 格式` };
  if (!co) {
    if (!allowDefaults) return { error: '需要离店日期（YYYY-MM-DD）' };
    co = addDays(ci, 1);
    datesAssumed = true;
  }
  if (!isValidDate(co)) return { error: `离店日期「${co}」不对，请用 YYYY-MM-DD 格式` };
  if (ci < floor) {
    const lateNight = floor < today ? `；现在是凌晨，最早可订 ${floor} 入住（凌晨入住，6点前有效）` : '';
    return { error: `入住日期 ${ci} 已经过去了（今天是 ${today}${lateNight}）` };
  }
  if (nightsBetween(today, ci) > maxAheadDays) return { error: `只能预订${maxAheadDays}天以内的日期` };
  const nights = nightsBetween(ci, co);
  if (nights < 1) return { error: '离店日期需要晚于入住日期' };
  if (nights > maxNights) return { error: `单次最多预订${maxNights}晚` };
  return { checkIn: ci, checkOut: co, nights, datesAssumed };
}
