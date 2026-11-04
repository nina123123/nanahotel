import { isValidDate, weekdayCN, nightsBetween, addDays } from '../../util/dates.js';

/**
 * China statutory holidays used for simulated price multipliers and for the system prompt.
 *
 * 2026: per 国务院办公厅 2026 年部分节假日安排 (published Nov 2025).
 * 2027–2028: NOT officially published yet — festival dates are astronomical/lunar facts, but the
 * 放假/调休 windows below are 按惯例推算 and flagged `estimated: true`; the prompt must say so.
 * Estimates follow the 2025 rules (春节 4 statutory days, 劳动节 2, 国庆 3) and the 调休 pattern of a
 * year with the same calendar (2027 ↔ 2021); a window longer than its statutory days plus weekends
 * needs that many 调休 workdays. The table must cover today + the booking horizon (365 days).
 *
 * multiplier: nightly price factor for ordinary cities; touristMultiplier: for 三亚/丽江/厦门 type cities.
 */
const RAW = [
  { key: 'newyear', name: '元旦', start: '2026-01-01', end: '2026-01-03', festival: '2026-01-01', makeup: ['2026-01-04'] },
  { key: 'spring', name: '春节', start: '2026-02-15', end: '2026-02-23', festival: '2026-02-17', eve: '2026-02-16', makeup: ['2026-02-14', '2026-02-28'] },
  { key: 'qingming', name: '清明节', start: '2026-04-04', end: '2026-04-06', festival: '2026-04-05', makeup: [] },
  { key: 'labor', name: '劳动节', start: '2026-05-01', end: '2026-05-05', festival: '2026-05-01', makeup: ['2026-05-09'] },
  { key: 'dragonboat', name: '端午节', start: '2026-06-19', end: '2026-06-21', festival: '2026-06-19', makeup: [] },
  { key: 'midautumn', name: '中秋节', start: '2026-09-25', end: '2026-09-27', festival: '2026-09-25', makeup: [] },
  { key: 'national', name: '国庆节', start: '2026-10-01', end: '2026-10-07', festival: '2026-10-01', makeup: ['2026-09-20', '2026-10-10'] },
  // 2027 — 按惯例推算（官方安排尚未公布）；节日本身的日期是确定的。
  { key: 'newyear', name: '元旦', start: '2027-01-01', end: '2027-01-03', festival: '2027-01-01', makeup: [], estimated: true },
  { key: 'spring', name: '春节', start: '2027-02-05', end: '2027-02-13', festival: '2027-02-06', eve: '2027-02-05', makeup: ['2027-01-31', '2027-02-14'], estimated: true },
  { key: 'qingming', name: '清明节', start: '2027-04-03', end: '2027-04-05', festival: '2027-04-05', makeup: [], estimated: true },
  { key: 'labor', name: '劳动节', start: '2027-05-01', end: '2027-05-05', festival: '2027-05-01', makeup: ['2027-04-25'], estimated: true },
  { key: 'dragonboat', name: '端午节', start: '2027-06-09', end: '2027-06-09', festival: '2027-06-09', makeup: [], estimated: true },
  { key: 'midautumn', name: '中秋节', start: '2027-09-15', end: '2027-09-15', festival: '2027-09-15', makeup: [], estimated: true },
  { key: 'national', name: '国庆节', start: '2027-10-01', end: '2027-10-07', festival: '2027-10-01', makeup: ['2027-09-26', '2027-10-09'], estimated: true },
  // 2028 — 按惯例推算。闰五月 puts 中秋 (10-03) inside the 国庆 window, as in 2020: one 8-day break.
  { key: 'newyear', name: '元旦', start: '2028-01-01', end: '2028-01-03', festival: '2028-01-01', makeup: [], estimated: true },
  { key: 'spring', name: '春节', start: '2028-01-25', end: '2028-02-01', festival: '2028-01-26', eve: '2028-01-25', makeup: ['2028-01-23', '2028-02-05'], estimated: true },
  { key: 'qingming', name: '清明节', start: '2028-04-02', end: '2028-04-04', festival: '2028-04-04', makeup: ['2028-04-01'], estimated: true },
  { key: 'labor', name: '劳动节', start: '2028-04-29', end: '2028-05-03', festival: '2028-05-01', makeup: ['2028-05-06'], estimated: true },
  { key: 'dragonboat', name: '端午节', start: '2028-05-27', end: '2028-05-29', festival: '2028-05-28', makeup: [], estimated: true },
  { key: 'national', name: '国庆节', start: '2028-10-01', end: '2028-10-08', festival: '2028-10-01', makeup: ['2028-09-30'], estimated: true },
  { key: 'midautumn', name: '中秋节', start: '2028-10-01', end: '2028-10-08', festival: '2028-10-03', makeup: ['2028-09-30'], estimated: true },
];

const KEY_INFO = {
  newyear: { aliases: ['元旦', '新年', '跨年', '元旦节'], multiplier: 1.3, touristMultiplier: 1.5 },
  spring: { aliases: ['春节', '过年', '新春', '除夕', '大年三十', '大年初一', '年假'], multiplier: 1.3, touristMultiplier: 1.8 },
  qingming: { aliases: ['清明', '清明节'], multiplier: 1.3, touristMultiplier: 1.4 },
  labor: { aliases: ['劳动节', '五一', '五一假期', '五一劳动节'], multiplier: 1.5, touristMultiplier: 1.7 },
  dragonboat: { aliases: ['端午', '端午节'], multiplier: 1.3, touristMultiplier: 1.4 },
  midautumn: { aliases: ['中秋', '中秋节'], multiplier: 1.3, touristMultiplier: 1.5 },
  national: { aliases: ['国庆', '国庆节', '十一', '十一黄金周', '黄金周', '国庆假期'], multiplier: 1.6, touristMultiplier: 1.8 },
};

/** @type {ReadonlyArray<{ key, name, year, start, end, days, festival, eve?, makeupWorkdays, estimated, aliases, multiplier, touristMultiplier }>} */
export const HOLIDAYS = Object.freeze(RAW.map((h) => {
  const info = KEY_INFO[h.key];
  return Object.freeze({
    key: h.key,
    name: h.name,
    year: Number(h.start.slice(0, 4)),
    start: h.start,
    end: h.end,
    days: nightsBetween(h.start, h.end) + 1,
    festival: h.festival,
    ...(h.eve ? { eve: h.eve } : {}),
    makeupWorkdays: Object.freeze([...h.makeup]),
    estimated: !!h.estimated,
    aliases: Object.freeze([...info.aliases]),
    multiplier: info.multiplier,
    touristMultiplier: info.touristMultiplier,
  });
}));

/** Holiday whose 放假 window contains `date`, or null. */
export function holidayOn(date) {
  if (!isValidDate(date)) return null;
  return HOLIDAYS.find((h) => h.start <= date && date <= h.end) || null;
}

/** Holiday whose 放假 window starts on `date`, or null. */
export function holidayStartingOn(date) {
  return HOLIDAYS.find((h) => h.start === date) || null;
}

/** True when `date` is the day right before a holiday window (the night everyone leaves town). */
export function isHolidayEve(date) {
  if (!isValidDate(date)) return false;
  const next = addDays(date, 1);
  return HOLIDAYS.some((h) => h.start === next);
}

/** 调休上班日 (a weekend day that is a working day). */
export function isMakeupWorkday(date) {
  return HOLIDAYS.some((h) => h.makeupWorkdays.includes(date));
}

/** Holidays that have not ended yet as of `fromDate`, soonest first. */
export function upcomingHolidays(fromDate, { count = 3 } = {}) {
  return HOLIDAYS.filter((h) => h.end >= fromDate).slice(0, count);
}

/** Next (not yet ended) holiday matching free text like '国庆', '五一', '过年'; null if none. */
export function findHoliday(text, fromDate) {
  // '十一月'/'十一点' and '五一路' are not holidays, so strip those before alias matching.
  const q = String(text || '').replace(/\s+/g, '').replace(/(十一|五一)(?=[月点日号路])/g, '');
  if (!q) return null;
  const pool = fromDate ? HOLIDAYS.filter((h) => h.end >= fromDate) : HOLIDAYS;
  return pool.find((h) => h.aliases.some((a) => q.includes(a))) || null;
}

function fmt(date) {
  return `${date}（${weekdayCN(date)}）`;
}

/** One line of Chinese describing a holiday window, honest about 2027 estimates. */
export function describeHoliday(h) {
  const range = h.start === h.end ? `${fmt(h.start)}，共1天` : `${fmt(h.start)} 至 ${fmt(h.end)}，共${h.days}天`;
  const festival = h.key === 'spring'
    ? `除夕 ${fmt(h.eve)}，正月初一 ${fmt(h.festival)}；`
    : (h.festival !== h.start ? `节日当天 ${fmt(h.festival)}；` : '');
  const makeup = h.makeupWorkdays.length ? `；调休上班：${h.makeupWorkdays.map(fmt).join('、')}` : '';
  const note = h.estimated ? '（官方放假安排尚未公布，按惯例推算，以国务院通知为准）' : '';
  return `${h.name}：${festival}${h.estimated ? '预计放假' : '放假'} ${range}${makeup}${note}`;
}

/** Multi-line summary of the next few holidays, for the system prompt. */
export function describeUpcomingHolidays(fromDate, { count = 3 } = {}) {
  return upcomingHolidays(fromDate, { count }).map(describeHoliday).join('\n');
}
