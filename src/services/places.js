import { distanceM } from '../util/geo.js';
import { todayCN, earliestCheckIn, checkStay } from '../util/dates.js';
import { HotelError } from './hotels/index.js';
import * as simPricing from './hotels/pricing.js';

/**
 * City guide over the supplier's areas (商圈) and landmarks: "where is X", "what's near Y",
 * "which area should I stay in". Only real places from the guide; no weather or other live facts.
 */

const NEARBY_RADIUS_M = 3000;

/** Generic keywords → which guide entries they should surface ('火车站' → stations, '寺庙' → temples …). */
const TYPE_HINTS = [
  [/高铁|火车|车站|站$/, (p) => p.type === '交通枢纽' && /站/.test(p.name)],
  [/机场|航站楼|飞机/, (p) => p.type === '交通枢纽' && /机场|航站楼/.test(p.name)],
  [/交通|枢纽/, (p) => p.type === '交通枢纽'],
  [/景点|景区|好玩|玩的|打卡|名胜/, (p) => p.type === '景点'],
  [/博物|展览|看展/, (p) => p.type === '博物馆' || p.type === '会展' || /博物/.test(p.name)],
  [/会展|展会|展馆/, (p) => p.type === '会展'],
  [/海滩|沙滩|海边|游泳|看海/, (p) => p.type === '海滩' || /海水浴场|海滩|沙滩/.test(p.name)],
  [/乐园|游乐|主题公园|亲子|带娃|孩子/, (p) => p.type === '主题乐园'],
  [/小吃|美食|夜市|吃|老街/, (p) => p.type === '美食街区'],
  [/购物|商场|逛街|买/, (p) => p.type === '购物'],
  [/大学|高校|学校/, (p) => p.type === '高校' || /大学/.test(p.name)],
  [/寺|庙|祠|拜佛|烧香/, (p) => /寺|庙|祠|宫$/.test(p.name)],
  [/公园|散步/, (p) => /公园|湿地/.test(p.name)],
  [/古镇|古城|古街|老城/, (p) => /古镇|古城|古街|老街/.test(p.name)],
  [/湖/, (p) => /湖/.test(p.name)],
  [/商圈|区域|片区|住哪/, (p) => p.type === '商圈'],
];

// On equal scores, sights beat hubs, and hubs beat malls (so '熊猫' finds 熊猫基地 before a mall alias).
const TYPE_PRIORITY = { 景点: 3, 主题乐园: 3, 博物馆: 3, 海滩: 3, 交通枢纽: 2, 美食街区: 2, 地标: 2, 商圈: 1, 购物: 1, 高校: 1, 会展: 1 };

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * @param {{ supplier, pricing?: { lowestNightly }, clock?: { now: () => Date } }} deps  pricing defaults to the
 *        simulator's, the same default the hotel service uses
 */
export function createPlacesService({ supplier, pricing = simPricing, clock = { now: () => new Date() } } = {}) {
  if (!supplier) throw new Error('createPlacesService: supplier is required');

  function requireCity(cityText) {
    const raw = String(cityText || '').trim();
    if (!raw) throw new HotelError('city_required', '请告诉我是哪个城市');
    const city = supplier.resolveCity(raw);
    if (!city) {
      const names = supplier.listCities().map((c) => c.name).join('、');
      throw new HotelError('city_not_supported', `演示版暂时只覆盖：${names}。「${raw}」还没有数据`, { city: raw });
    }
    return city;
  }

  function guide(city) {
    const areas = typeof supplier.listAreas === 'function' ? supplier.listAreas(city.name) : [];
    const hotels = supplier.searchHotels({ city: city.name });
    return { areas, hotels };
  }

  function nearbyCount(hotels, location, extentM = 0) {
    return hotels.filter((h) => (distanceM(h.location, location) ?? Infinity) <= NEARBY_RADIUS_M + extentM).length;
  }

  /** @returns {Array<{ name, area, type, location, nearbyHotelCount, district, reason? }>} */
  function searchPlaces({ city, keyword, limit = 8 } = {}) {
    const c = requireCity(city);
    const { areas, hotels } = guide(c);
    const max = Math.min(20, Math.max(1, Math.round(Number(limit) || 8)));
    const q = norm(keyword).replace(new RegExp(`^${c.name}`), '').replace(/(附近|周边|一带|在哪里?|在哪儿?|怎么样)$/, '');

    const entries = [];
    for (const a of areas) {
      entries.push({ name: a.name, area: a.name, type: '商圈', location: a.location, district: a.district, reason: a.reason, keys: [a.name, ...a.name.split(/[/·]/), a.short, ...a.aliases], parentKeys: [], text: a.reason });
      for (const l of a.landmarks) {
        entries.push({ name: l.name, area: a.name, type: l.type, location: l.location, extentM: l.extentM || 0, district: l.district || a.district, keys: [l.name, ...l.aliases], parentKeys: [a.name, ...a.name.split(/[/·]/), a.short, ...a.aliases], text: a.reason });
      }
    }

    const typeTests = TYPE_HINTS.filter(([re]) => re.test(q)).map(([, test]) => test);
    const scored = [];
    for (const e of entries) {
      const keys = e.keys.map(norm).filter(Boolean);
      const parents = e.parentKeys.map(norm).filter(Boolean);
      let score = 0;
      if (!q) score = e.type === '商圈' ? 50 : 0;
      else if (keys.includes(q)) score = 100;
      else if (keys.some((k) => k.length >= 2 && (k.startsWith(q) || q.includes(k)))) score = 80;
      else if (keys.some((k) => k.includes(q))) score = 60;
      else if (typeTests.some((t) => t(e))) score = 45;
      else if (parents.some((k) => k.length >= 2 && (k === q || q.includes(k) || k.includes(q)))) score = 35;
      else if (q.length >= 2 && norm(e.text).includes(q)) score = 20;
      if (score > 0) scored.push({ e, score });
    }

    const seen = new Set();
    return scored
      .map(({ e, score }) => ({ e, score, count: nearbyCount(hotels, e.location, e.extentM) }))
      .sort((a, b) => b.score - a.score || (TYPE_PRIORITY[b.e.type] || 0) - (TYPE_PRIORITY[a.e.type] || 0) || b.count - a.count)
      .filter(({ e }) => (seen.has(e.name) ? false : seen.add(e.name)))
      .slice(0, max)
      .map(({ e, count }) => ({
        name: e.name,
        area: e.area,
        type: e.type,
        location: { ...e.location },
        nearbyHotelCount: count,
        district: e.district,
        ...(e.type === '商圈' ? { reason: e.reason } : {}),
      }));
  }

  /**
   * 住哪儿 advice: every area with its landmarks, simulated hotel count and 参考起价.
   * With dates, priceFrom is the cheapest bookable nightly price for that stay (seasons and holidays
   * included; null when all sold out) and priceBasis is 'dates'. Without dates it is the weekday anchor
   * (no weekend/holiday/season premium) and priceBasis is 'weekday'.
   */
  function listAreas(city, { checkIn, checkOut, adults, rooms, children } = {}) {
    const c = requireCity(city);
    const { areas, hotels } = guide(c);
    let stay = null;
    if (checkIn || checkOut) {
      const now = clock.now();
      const s = checkStay(checkIn, checkOut, todayCN(now), { allowDefaults: !!checkIn, earliestCheckIn: earliestCheckIn(now) });
      if (s.error) throw new HotelError('invalid_dates', s.error);
      stay = { checkIn: s.checkIn, checkOut: s.checkOut, adults: adults ?? 2, rooms: rooms ?? 1, children: children ?? 0, city: c, now };
    }
    return areas.map((a) => {
      const inArea = hotels.filter((h) => h.businessArea === a.name);
      const prices = stay
        ? inArea.map((h) => pricing.lowestNightly(h, stay)).filter(Number.isFinite)
        : inArea.map((h) => h.priceHint).filter(Number.isFinite);
      return {
        name: a.name,
        district: a.district,
        reason: a.reason,
        location: { ...a.location },
        landmarks: a.landmarks.map((l) => l.name),
        hotelCount: inArea.length,
        priceFrom: prices.length ? Math.min(...prices) : null,
        priceBasis: stay ? 'dates' : 'weekday',
        ...(stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut } : {}),
      };
    });
  }

  return { searchPlaces, listAreas };
}
