/**
 * Hotel supplier interface. The hotel service (index.js) only talks to a supplier through these
 * methods, so a real source (高德 POI for hotel facts + 携程/美团/飞猪 分销 API for rooms and rates)
 * can replace the simulator later without touching the agent, tools or bookings.
 *
 * All methods are synchronous for the simulator. A networked supplier would make them async; the
 * hotel service would then await them (bookings and places already treat results as plain values).
 *
 * @typedef {{ lng: number, lat: number }} LngLat
 * @typedef {'economy'|'comfort'|'premium'|'luxury'} Category
 *
 * @typedef {object} Hotel  see docs/SPEC.md "Shared domain types"
 *
 * @typedef {object} CityInfo
 * @property {string} name        short name, e.g. '杭州'
 * @property {string} fullName    e.g. '杭州市' (matches Hotel.city)
 * @property {string} code        short code used in ids, e.g. 'hz'
 * @property {'tier1'|'new_tier1'|'tourist'|'tier2'} tier
 * @property {LngLat} center
 * @property {number[]|null} [season]  optional 12 monthly price factors
 *
 * @typedef {object} ResolvedPlace
 * @property {string} name        canonical landmark (or area) name, e.g. '西湖'
 * @property {LngLat} location
 * @property {string} area        商圈 the place belongs to, '' if unknown
 * @property {string} [type]      景点 / 交通枢纽 / 购物 / 商圈 …
 * @property {number} [extentM]  rough radius of an extended place (lake, beach); distances are measured from its edge
 * @property {'exact'|'partial'} [matched]  how the text matched (partial = fuzzy containment)
 *
 * @typedef {object} AreaGuide
 * @property {string} name
 * @property {string} district
 * @property {string} reason      one-line 住这里的理由
 * @property {LngLat} location    area center
 * @property {Array<{ name: string, type: string, location: LngLat, aliases: string[], extentM?: number, district?: string }>} landmarks
 *
 * @typedef {object} HotelSupplier
 * @property {string} source                                   'sim'
 * @property {() => Array<{ name: string, tier: string }>} listCities
 * @property {(text: string) => CityInfo|null} resolveCity      tolerant: '杭州市', 'hz', 'Hangzhou', '去杭州'
 * @property {(city: string, text: string) => ResolvedPlace|null} resolveLandmark   '西湖边' → 西湖
 * @property {(q: { city: string, keyword?: string, location?: LngLat, radiusM?: number, categories?: Category[] }) => Hotel[]} searchHotels
 *           unpriced, unsorted; filters by radius (when location given), categories and keyword
 * @property {(id: string) => Hotel|null} getHotel
 * @property {(city: string) => AreaGuide[]} [listAreas]         optional city guide (used by places.js)
 */

export const CATEGORIES = Object.freeze(['economy', 'comfort', 'premium', 'luxury']);
export const CATEGORY_LABELS = Object.freeze({ economy: '经济型', comfort: '舒适型', premium: '高档型', luxury: '豪华型' });

const CATEGORY_WORDS = [
  ['economy', ['经济型', '经济', '快捷酒店', '快捷']],
  ['comfort', ['舒适型', '舒适']],
  ['premium', ['高档型', '高档', '四星级', '四星']],
  ['luxury', ['豪华型', '豪华', '五星级', '五星', '奢华', '顶级']],
];

/** 'economy' | '经济型' | '五星' → category, else null. */
export function normalizeCategory(x) {
  const s = String(x || '').trim().toLowerCase();
  if (!s) return null;
  if (CATEGORIES.includes(s)) return s;
  for (const [cat, words] of CATEGORY_WORDS) if (words.includes(s)) return cat;
  return null;
}

const STOP_WORDS = ['酒店', '宾馆', '住宿', '旅馆', '附近', '一点', '一些', '比较', '最好', '的', '要', '想'];
const SYNONYMS = new Map([
  ['早餐', '含早'], ['带早', '含早'], ['含早餐', '含早'], ['双早', '含早'], ['单早', '含早'], ['游泳池', '泳池'], ['停车场', '停车'], ['能停车', '停车'],
  ['带娃', '亲子'], ['带孩子', '亲子'], ['儿童', '亲子'], ['小孩', '亲子'], ['家庭', '亲子'], ['湖景', '湖景'],
  ['地铁站', '近地铁'], ['地铁', '近地铁'], ['新开', '新开业'], ['新酒店', '新开业'], ['健身', '健身房'], ['spa', 'SPA'],
  ['临河', '河景'], ['河景房', '河景'],
]);

/**
 * Split a free-text hotel keyword into match tokens plus any category words it contains.
 * '亲子 带泳池的酒店' → { tokens: ['亲子', '泳池'], categories: [] }; '五星 江景' → { tokens: ['江景'], categories: ['luxury'] }.
 */
export function parseKeyword(keyword, { ignore = [] } = {}) {
  const tokens = [];
  const categories = [];
  const raw = String(keyword || '').split(/[\s,，、;；/|+]+/).filter(Boolean)
    // '亲子和泳池' is two wishes, but '温和' / '和平' are single words: split on 和 only between 2+ char parts.
    .flatMap((t) => { const parts = t.split('和'); return parts.length > 1 && parts.every((x) => x.length >= 2) ? parts : [t]; });
  for (let t of raw) {
    const cat = normalizeCategory(t);
    if (cat) {
      if (!categories.includes(cat)) categories.push(cat);
      continue;
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const w of STOP_WORDS) {
        if (t.length > w.length && (t.endsWith(w) || t.startsWith(w))) {
          t = t.endsWith(w) ? t.slice(0, -w.length) : t.slice(w.length);
          changed = true;
        }
      }
      if (/^[带有含近]/.test(t) && t.length > 2 && !t.startsWith('含早') && !t.startsWith('近地铁')) {
        t = t.slice(1);
        changed = true;
      }
    }
    // Single characters ('湖', '好') match almost everything, so they are not useful filters.
    if (t.length < 2 || STOP_WORDS.includes(t) || ignore.includes(t)) continue;
    t = SYNONYMS.get(t.toLowerCase()) || t;
    if (t && !tokens.includes(t)) tokens.push(t);
  }
  return { tokens, categories };
}

/**
 * Preference tokens that belong to rate plans rather than to the hotel (every hotel sells some 含早 rate),
 * so the hotel service matches them against the priced room offer instead of the hotel's text.
 */
export const RATE_TOKENS = Object.freeze(new Set(['含早']));

/** True when every token appears in the hotel's name / 商圈 / district / tags / amenities / category label. */
export function hotelMatchesKeyword(hotel, tokens) {
  if (!tokens || !tokens.length) return true;
  const hay = [hotel.name, hotel.businessArea, hotel.district, ...(hotel.tags || []), ...(hotel.amenities || []), CATEGORY_LABELS[hotel.category] || '']
    .join('|')
    .toLowerCase();
  return tokens.every((t) => hay.includes(String(t).toLowerCase()));
}
