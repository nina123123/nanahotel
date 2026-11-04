import { offsetPoint } from '../../util/geo.js';

/**
 * Deterministic generator of FICTIONAL hotels around the real areas in sim-cities.js.
 * Every value derives from seeded PRNGs keyed by city code + hotel index, so ids, names and
 * price anchors are identical across restarts. Name parts are deliberately generic words, never
 * real hotel brands (see test/hotels.test.js for the brand blocklist).
 */

/** 32-bit string hash (FNV-1a + murmur3 finalizer so neighbouring ids land far apart). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) derived from a string. */
export function hash01(str) {
  return hashString(str) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATS = ['economy', 'comfort', 'premium', 'luxury'];

/** Per area kind: hotel count weight, category mix and a price factor relative to the city tier. */
const KINDS = {
  scenic: { count: 4, mix: [0.12, 0.3, 0.33, 0.25], priceFactor: 1.12 },
  cbd: { count: 4, mix: [0.1, 0.3, 0.32, 0.28], priceFactor: 1.08 },
  shopping: { count: 4, mix: [0.22, 0.4, 0.26, 0.12], priceFactor: 1.0 },
  oldtown: { count: 4, mix: [0.28, 0.42, 0.22, 0.08], priceFactor: 0.97 },
  nightlife: { count: 3, mix: [0.25, 0.42, 0.25, 0.08], priceFactor: 1.0 },
  university: { count: 3, mix: [0.4, 0.4, 0.2, 0], priceFactor: 0.92 },
  inn: { count: 4, mix: [0.2, 0.45, 0.3, 0.05], priceFactor: 1.05, inn: true },
  resort: { count: 3, mix: [0.08, 0.3, 0.35, 0.27], priceFactor: 1.05, resort: true },
  beach: { count: 4, mix: [0.08, 0.27, 0.33, 0.32], priceFactor: 1.05, resort: true },
  station: { count: 2, mix: [0.5, 0.38, 0.12, 0], priceFactor: 0.88 },
  airport: { count: 2, mix: [0.4, 0.45, 0.15, 0], priceFactor: 0.9 },
};

/**
 * Weekday base price ranges (RMB, lowest room, no breakfast) by city tier × category, calibrated to the
 * ADR-anchored bands in RESEARCH-booking.md §3.2 (area kind, rating and city.priceLevel add a little).
 */
export const PRICE_RANGES = Object.freeze({
  tier1: { economy: [220, 360], comfort: [360, 600], premium: [580, 1000], luxury: [1000, 2600] },
  new_tier1: { economy: [160, 260], comfort: [260, 440], premium: [420, 750], luxury: [700, 1700] },
  tourist: { economy: [150, 280], comfort: [260, 480], premium: [450, 950], luxury: [800, 2200] },
  tier2: { economy: [120, 200], comfort: [220, 350], premium: [330, 600], luxury: [550, 1100] },
});

const RATING = { economy: [4.0, 4.6], comfort: [4.3, 4.8], premium: [4.5, 4.9], luxury: [4.6, 4.9] };
const YEARS = { economy: [2012, 2025], comfort: [2015, 2025], premium: [2010, 2025], luxury: [2006, 2024] };
const REVIEWS = { economy: [400, 4800], comfort: [600, 7000], premium: [500, 6500], luxury: [300, 4500] };
const NEWEST_YEAR = 2025;

// Invented stems; a stem that is a real chain (驿居, 云栖, 永乐半山 …) must not appear. Positions are kept
// when a stem is replaced so other hotels' names and draws do not move.
const BRANDS = {
  economy: ['悦途', '简居', '青舍', '拾光', '憩园', '行舍', '小栈', '禾宿', '朴宿', '途悠'],
  comfort: ['栖云', '漫居', '云舍', '素履', '星屿', '屿见', '晴舍', '松间', '溪岸', '木禾'],
  premium: ['观潮', '澜庭', '听松', '映月', '清岚', '临水', '若水', '揽月', '映岚', '叠翠'],
  luxury: ['隐庐', '静庐', '臻园', '澄庐', '观止', '揽胜', '云麓', '鹤庐', '山澜', '望庐'],
  inn: ['竹篱', '花溪', '青檐', '慢屿', '南风', '归园', '素心', '听雨', '木心', '檐下'],
};

/** Every brand stem the generator uses (tests check none is a real chain and none repeats within an area). */
export const BRAND_STEMS = Object.freeze([...new Set(Object.values(BRANDS).flat())]);

// Area names that are trademarks: '迪士尼度假区澄庐' would read like an official on-site hotel.
const TRADEMARK_RE = /迪士尼|长隆|欢乐谷|世界之窗|华侨城|环球影城|方特|海昌/;

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/** Whole yuan ending in 8 (Chinese hotels love 8). */
function priceEnding8(x) {
  return Math.max(98, Math.round(x / 10) * 10 - 2);
}

/** Largest-remainder split of `n` hotels over the 4 categories, with seeded wobble so areas differ. */
function categoryDeck(n, mix, rng) {
  const w = mix.map((m) => (m > 0 ? Math.max(0, m + (rng() - 0.5) * 0.16) : 0));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const exact = w.map((x) => (x / sum) * n);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  const deck = [];
  counts.forEach((c, i) => { for (let j = 0; j < c; j++) deck.push(CATS[i]); });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Hotel counts per area: kind weights scaled so each city ends up with 18–30 hotels. */
function areaCounts(city) {
  const weights = city.areas.map((a) => (KINDS[a.kind] || KINDS.shopping).count);
  const total = weights.reduce((a, b) => a + b, 0);
  const target = Math.min(30, Math.max(18, total));
  const exact = weights.map((w) => (w / total) * target);
  const counts = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = target - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  return counts;
}

function placeName(city, area) {
  return area.short.startsWith(city.name) ? area.short : `${city.name}${area.short}`;
}

/** @returns {{ brand: string, list: string[] }} the brand stem drawn and the name patterns using it */
function nameCandidates(rng, { city, area, category, inn, resort }) {
  const place = placeName(city, area);
  const s = area.short;
  if (inn && category !== 'luxury') {
    const b = pick(rng, BRANDS.inn);
    if (category === 'premium') return { brand: b, list: [`${s}${b}精品酒店`, `${b}·${s}院子`, `${s}${b}精品民宿`] };
    return { brand: b, list: [`${s}${b}民宿`, `${b}客栈（${s}店）`, `${s}${b}小院`, `${b}精品民宿（${s}店）`] };
  }
  const b = pick(rng, BRANDS[category]);
  const list = (() => {
    switch (category) {
      case 'economy':
        return [`${b}酒店（${place}店）`, `${b}公寓酒店（${place}店）`, `${b}精选酒店（${s}店）`];
      case 'comfort':
        return [`${b}酒店（${place}店）`, `${b}设计酒店（${s}店）`, `${b}精品酒店（${place}店）`];
      case 'premium':
        if (TRADEMARK_RE.test(place)) return [`${b}度假酒店（${place}店）`, `${b}酒店（${place}店）`];
        return resort
          ? [`${place}${b}度假酒店`, `${b}度假酒店（${place}店）`, `${s}${b}酒店`]
          : [`${place}${b}酒店`, `${b}酒店（${place}店）`, `${city.name}${b}艺术酒店`, `${place}${b}精品酒店`];
      default:
        if (TRADEMARK_RE.test(place)) return [`${b}度假酒店（${place}店）`, `${city.name}${b}度假酒店`];
        if (inn) return [`${s}${b}`, `${b}·${s}`, `${place}${b}精品酒店`];
        return resort
          ? [`${place}${b}度假酒店`, `${city.name}${b}度假酒店`, `${s}${b}`]
          : [`${city.name}${b}酒店`, `${place}${b}大酒店`, `${s}${b}`];
    }
  })();
  return { brand: b, list };
}

/** Unique within the city, and no brand stem twice in one area ('晴舍设计酒店（钟楼店）' next to '晴舍酒店（西安钟楼店）'). */
function uniqueName(rng, ctx, used, areaBrands) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { brand, list } = nameCandidates(rng, ctx);
    const name = list[Math.floor(rng() * list.length)];
    if (!used.has(name) && (attempt >= 40 || !areaBrands.has(brand))) {
      used.add(name);
      areaBrands.add(brand);
      return name;
    }
  }
  const fallback = `${nameCandidates(rng, ctx).list[0]}${used.size}`;
  used.add(fallback);
  return fallback;
}

function makeAmenities(rng, { category, kind, area, inn }) {
  const out = new Set();
  const add = (x, p = 1) => { if (rng() < p) out.add(x); };
  const f = area.features;
  // Courtyard 民宿/客栈 have no gym, pool, meeting rooms or delivery robots (those need a big building with lifts).
  if (inn && category !== 'luxury') {
    add('行李寄存'); add('免费WiFi'); add('公共休息区', 0.7); add('庭院', 0.6); add('茶室', 0.4);
    add('管家服务', category === 'premium' ? 0.8 : 0.3); add('代订门票', 0.5);
    if (category === 'economy') add('自助洗衣房', 0.3);
    else if (category === 'comfort') { add('洗衣服务', 0.5); add('早餐', 0.5); add('露台', 0.4); }
    else { add('私房菜餐厅', 0.6); add('露台', 0.6); add('洗衣服务', 0.6); add('接站服务', 0.5); }
  } else {
    add('24小时前台'); add('行李寄存'); add('免费WiFi');
    if (category === 'economy') {
      add('自助洗衣房', 0.5);
    } else if (category === 'comfort') {
      add('洗衣房', 0.6); add('机器人送物', 0.5); add('健身房', 0.3); add('自助早餐厅', 0.5);
    } else if (category === 'premium') {
      add('健身房'); add('餐厅'); add('会议室', 0.6); add('洗衣房', 0.6); add('机器人送物', 0.5);
      add(kind.resort ? '室外泳池' : '室内泳池', kind.resort ? 0.8 : 0.35);
    } else {
      add('健身房'); add(kind.resort ? '室外泳池' : '室内泳池'); add('SPA'); add('行政酒廊');
      add('中餐厅'); add('管家服务', 0.7); add('接机服务', 0.5);
    }
  }
  if (kind.resort && (category === 'luxury' || category === 'premium') && f.includes('sea')) add('私人沙滩', 0.5);
  if (f.includes('family') || kind.resort) { add('儿童乐园', category === 'economy' ? 0.1 : 0.55); add('亲子房', 0.5); }
  else if (category !== 'economy') add('亲子房', 0.25);
  if (area.kind === 'airport') add('免费接送机', 0.75);
  // Probabilities go to 0 rather than skipping the draw, so car-free areas keep the same random stream.
  const carfree = f.includes('carfree');
  const parkingP = carfree ? 0 : f.includes('subway') ? 0.3 : 0.7;
  if (category === 'luxury' || category === 'premium') add(rng() < 0.4 ? '免费停车' : '停车场', carfree ? 0 : 0.9);
  else add('免费停车', parkingP);
  if (carfree) add('码头行李接送', 0.5);
  return [...out];
}

function makeTags(rng, { category, area, amenities, openedYear }) {
  const tags = [];
  const f = area.features;
  const upscale = category === 'premium' || category === 'luxury';
  const add = (t, p) => { if (tags.length < 4 && !tags.includes(t) && rng() < p) tags.push(t); };
  // A view tag only where a view room exists (economy templates have none), and at most one, since the
  // view room is named after it. p = 0 instead of skipping keeps the random stream for later tags.
  const canView = category !== 'economy';
  const view = (t, p) => add(t, canView && !tags.some((x) => /景房$/.test(x)) ? p : 0);
  if (openedYear >= NEWEST_YEAR) add('新开业', 1);
  if (f.includes('lake')) view('湖景房', upscale ? 0.7 : 0.3);
  if (f.includes('river')) view('江景房', upscale ? 0.6 : 0.25);
  if (f.includes('canal')) view('河景房', upscale ? 0.6 : 0.25);
  if (f.includes('sea')) view('海景房', upscale ? 0.8 : 0.4);
  if (f.includes('mountain')) view('山景房', 0.3);
  if (area.kind === 'station') add(/南站|东站|北站|西站|虹桥/.test(area.name) ? '近高铁站' : '近火车站', 0.9);
  if (area.kind === 'airport') add('近机场', 0.9);
  if (amenities.includes('免费接送机')) add('免费接送机', 0.9);
  if (amenities.includes('亲子房') || f.includes('family')) add('亲子', 0.7);
  if (f.includes('subway')) add('近地铁', 0.6);
  if (area.kind === 'scenic' || area.kind === 'oldtown' || area.kind === 'inn') add('步行到景点', 0.4);
  if (f.includes('quiet')) add('安静', 0.5);
  if (f.includes('night')) add('网红', 0.3);
  if (area.kind === 'cbd') add('商务出行', 0.45);
  if (amenities.includes('室外泳池') || amenities.includes('室内泳池')) add('带泳池', 0.35);
  if (amenities.includes('免费停车')) add('免费停车', 0.5);
  if (category === 'economy' || category === 'comfort') add('含早划算', 0.25);
  if (category === 'economy') add('性价比高', 0.35);
  if (!tags.length) tags.push(upscale ? '服务好' : '干净卫生');
  return tags;
}

function makeHotel(city, area, category, index, used, areaBrands) {
  const id = `sim-${city.code}-${String(index).padStart(3, '0')}`;
  const rng = mulberry32(hashString(`${id}|${area.name}|${category}`));
  const kind = KINDS[area.kind] || KINDS.shopping;
  const inn = !!kind.inn;

  const [b0, b1] = area.bearings;
  const bearing = b0 + rng() * (b1 - b0);
  const dist = 150 + (area.spreadM - 150) * rng() ** 1.15;
  const location = offsetPoint(area.center, dist, bearing % 360);

  const name = uniqueName(rng, { city, area, category, inn, resort: !!kind.resort }, used, areaBrands);

  const [rLo, rHi] = RATING[category];
  const rating = round1(rLo + (rHi - rLo) * rng() ** 0.7);

  const [yLo, yHi] = YEARS[category];
  const openedYear = rng() < 0.12 ? Math.min(yHi, NEWEST_YEAR) : yLo + Math.floor(rng() * (yHi - yLo + 1));

  const [cLo, cHi] = REVIEWS[category];
  const age = Math.max(1, NEWEST_YEAR + 1 - openedYear);
  const reviewCount = Math.max(36, Math.round((cLo + (cHi - cLo) * rng()) * Math.min(1, 0.2 + age / 8)));

  const [pLo, pHi] = (PRICE_RANGES[city.tier] || PRICE_RANGES.tier2)[category];
  const ratingLift = 0.94 + 0.12 * ((rating - rLo) / (rHi - rLo || 1));
  const priceHint = priceEnding8((pLo + (pHi - pLo) * rng() ** 1.25) * kind.priceFactor * ratingLift * (city.priceLevel || 1));

  const amenities = makeAmenities(rng, { category, kind, area, inn });
  const tags = makeTags(rng, { category, area, amenities, openedYear });
  const tel = rng() < 0.2 ? '' : `${city.telCode}-0000${String(Math.floor(rng() * 10000)).padStart(4, '0')}`;

  return {
    id,
    name,
    city: city.fullName,
    district: area.district,
    address: `${area.district}·${area.short}附近（模拟地址）`,
    location,
    tel,
    rating,
    reviewCount,
    openedYear,
    amenities,
    category,
    businessArea: area.name,
    tags,
    photos: [],
    priceHint,
    source: 'sim',
  };
}

function freezeHotel(h) {
  Object.freeze(h.location);
  Object.freeze(h.amenities);
  Object.freeze(h.tags);
  Object.freeze(h.photos);
  return Object.freeze(h);
}

/** All fictional hotels of one city (stable order and ids). Pure: no caching here. */
export function generateHotels(city) {
  const counts = areaCounts(city);
  const used = new Set();
  const hotels = [];
  let index = 1;
  city.areas.forEach((area, ai) => {
    const kind = KINDS[area.kind] || KINDS.shopping;
    const deckRng = mulberry32(hashString(`deck|${city.code}|${area.name}`));
    const areaBrands = new Set();
    for (const category of categoryDeck(counts[ai], kind.mix, deckRng)) {
      hotels.push(freezeHotel(makeHotel(city, area, category, index++, used, areaBrands)));
    }
  });
  return Object.freeze(hotels);
}
