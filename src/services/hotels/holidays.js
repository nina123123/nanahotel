import { isValidDate, nightsBetween, formatDate } from '../../util/dates.js';

/**
 * US holidays and big weekends that raise simulated prices (and that the system prompt mentions). Each entry is a
 * run of hotel NIGHTS (`start` … `end`, inclusive: a Memorial Day weekend is the Friday, Saturday and Sunday nights)
 * with the day itself in `festival`. The dates follow the federal rules (third Monday of January, fourth Thursday of
 * November …) and, for Mardi Gras, Easter; spring break is an approximate window. `cities` limits an entry to some
 * demo cities (by code); the rest apply everywhere.
 *
 * multipliers: the nightly price factor on top of the usual weekday factor, by the city's market — business
 * cities empty out on family holidays while leisure ones fill up.
 * The table must cover today plus the 365-day booking horizon.
 */
const RAW = [
  { key: 'newyear', start: '2025-12-30', end: '2026-01-01', festival: '2026-01-01' },
  { key: 'mlk', start: '2026-01-16', end: '2026-01-18', festival: '2026-01-19' },
  { key: 'mardigras', start: '2026-02-13', end: '2026-02-17', festival: '2026-02-17', cities: ['nola'] },
  { key: 'presidents', start: '2026-02-13', end: '2026-02-15', festival: '2026-02-16' },
  { key: 'springbreak', start: '2026-03-06', end: '2026-04-04', festival: '2026-03-14', cities: ['mia', 'orl', 'lv'] },
  { key: 'memorial', start: '2026-05-22', end: '2026-05-24', festival: '2026-05-25' },
  { key: 'july4', start: '2026-07-03', end: '2026-07-05', festival: '2026-07-04' },
  { key: 'labor', start: '2026-09-04', end: '2026-09-06', festival: '2026-09-07' },
  { key: 'thanksgiving', start: '2026-11-25', end: '2026-11-28', festival: '2026-11-26' },
  { key: 'christmas', start: '2026-12-19', end: '2026-12-29', festival: '2026-12-25' },
  { key: 'newyear', start: '2026-12-30', end: '2027-01-01', festival: '2027-01-01' },
  { key: 'mlk', start: '2027-01-15', end: '2027-01-17', festival: '2027-01-18' },
  { key: 'mardigras', start: '2027-02-05', end: '2027-02-09', festival: '2027-02-09', cities: ['nola'] },
  { key: 'presidents', start: '2027-02-12', end: '2027-02-14', festival: '2027-02-15' },
  { key: 'springbreak', start: '2027-03-05', end: '2027-04-03', festival: '2027-03-13', cities: ['mia', 'orl', 'lv'] },
  { key: 'memorial', start: '2027-05-28', end: '2027-05-30', festival: '2027-05-31' },
  { key: 'july4', start: '2027-07-02', end: '2027-07-04', festival: '2027-07-04' },
  { key: 'labor', start: '2027-09-03', end: '2027-09-05', festival: '2027-09-06' },
  { key: 'thanksgiving', start: '2027-11-24', end: '2027-11-27', festival: '2027-11-25' },
  { key: 'christmas', start: '2027-12-18', end: '2027-12-29', festival: '2027-12-25' },
  { key: 'newyear', start: '2027-12-30', end: '2028-01-01', festival: '2028-01-01' },
];

const KEY_INFO = {
  newyear: { name: "New Year's", aliases: ["new year's eve", 'new years eve', 'new year', 'nye', "new year's"], multipliers: { business: 1.25, mixed: 1.6, leisure: 1.7 } },
  mlk: { name: 'Martin Luther King Jr. Day weekend', aliases: ['mlk', 'martin luther king'], multipliers: { business: 1.05, mixed: 1.05, leisure: 1.15 } },
  mardigras: { name: 'Mardi Gras', aliases: ['mardi gras', 'fat tuesday', 'carnival'], multipliers: { business: 1.8, mixed: 1.8, leisure: 1.8 } },
  presidents: { name: "Presidents' Day weekend", aliases: ["presidents' day", 'presidents day', "president's day"], multipliers: { business: 1.05, mixed: 1.05, leisure: 1.15 } },
  springbreak: { name: 'Spring break', aliases: ['spring break'], multipliers: { business: 1.3, mixed: 1.3, leisure: 1.3 }, long: true },
  memorial: { name: 'Memorial Day weekend', aliases: ['memorial day'], multipliers: { business: 1.05, mixed: 1.15, leisure: 1.3 } },
  july4: { name: 'Fourth of July', aliases: ['fourth of july', '4th of july', 'july 4th', 'july 4', 'july fourth', 'independence day', 'the fourth'], multipliers: { business: 1.1, mixed: 1.2, leisure: 1.35 } },
  labor: { name: 'Labor Day weekend', aliases: ['labor day', 'labour day'], multipliers: { business: 1.05, mixed: 1.15, leisure: 1.3 } },
  thanksgiving: { name: 'Thanksgiving', aliases: ['thanksgiving', 'turkey day', 'black friday'], multipliers: { business: 1.05, mixed: 1.25, leisure: 1.3 } },
  christmas: { name: 'Christmas', aliases: ['christmas', 'xmas', 'the holidays', 'holiday season'], multipliers: { business: 1.05, mixed: 1.25, leisure: 1.35 } },
};

/** @type {ReadonlyArray<{ key, name, year, start, end, nights, festival, cities: string[]|null, aliases, multipliers, long: boolean }>} */
export const HOLIDAYS = Object.freeze(RAW.map((h) => {
  const info = KEY_INFO[h.key];
  return Object.freeze({
    key: h.key,
    name: info.name,
    year: Number(h.festival.slice(0, 4)),
    start: h.start,
    end: h.end,
    nights: nightsBetween(h.start, h.end) + 1,
    festival: h.festival,
    cities: h.cities ? Object.freeze([...h.cities]) : null,
    aliases: Object.freeze([...info.aliases]),
    multipliers: Object.freeze({ ...info.multipliers }),
    long: Boolean(info.long),
  });
}));

function appliesTo(h, cityCode) {
  return !h.cities || (cityCode && h.cities.includes(cityCode));
}

/**
 * The holiday whose nights include the night of `date`, or null. A city-specific window (Mardi Gras, spring
 * break) counts only for its cities; without a `cityCode` only the nationwide ones count.
 */
export function holidayOn(date, cityCode) {
  if (!isValidDate(date)) return null;
  let best = null;
  for (const h of HOLIDAYS) {
    if (h.start <= date && date <= h.end && appliesTo(h, cityCode) && (!best || (h.cities && !best.cities))) best = h;
  }
  return best;
}

/** The price factor of a holiday for a city's market ('business' | 'mixed' | 'leisure'). */
export function holidayMultiplier(h, market = 'mixed') {
  return h?.multipliers?.[market] ?? h?.multipliers?.mixed ?? 1;
}

/** Holidays whose nights have not all passed as of `fromDate`, soonest first (city-specific ones only with `cityCode`, or all with `allCities`). */
export function upcomingHolidays(fromDate, { count = 3, cityCode, allCities = false } = {}) {
  return HOLIDAYS.filter((h) => h.end >= fromDate && (allCities || appliesTo(h, cityCode))).slice(0, count);
}

/** The next (not yet over) holiday matching free text like 'Thanksgiving', 'July 4th', 'spring break'; null if none. */
export function findHoliday(text, fromDate) {
  const q = ` ${String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ')} `;
  if (!q.trim()) return null;
  const pool = fromDate ? HOLIDAYS.filter((h) => h.end >= fromDate) : HOLIDAYS;
  return pool.find((h) => h.aliases.some((a) => new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(q))) || null;
}

/** One English line about a holiday, for the prompt: "Thanksgiving (Thu, Nov 26): busy nights Wed, Nov 25 – Sat, Nov 28". */
export function describeHoliday(h, ref) {
  const nights = h.start === h.end ? `the night of ${formatDate(h.start, ref)}` : `nights ${formatDate(h.start, ref)} – ${formatDate(h.end, ref)}`;
  const where = h.cities ? ` in ${h.cities.map((c) => CITY_NAMES[c] || c).join(', ')}` : '';
  const day = h.long ? '' : ` (${formatDate(h.festival, ref)})`;
  return `${h.name}${day}${where}: ${nights}`;
}

// Names for the city-specific windows (sim-cities.js owns the cities; this avoids an import cycle).
const CITY_NAMES = { nola: 'New Orleans', mia: 'Miami', orl: 'Orlando', lv: 'Las Vegas' };

/** Multi-line summary of the next few holidays, for the system prompt. */
export function describeUpcomingHolidays(fromDate, { count = 3 } = {}) {
  return upcomingHolidays(fromDate, { count, allCities: true }).map((h) => describeHoliday(h, fromDate)).join('\n');
}
