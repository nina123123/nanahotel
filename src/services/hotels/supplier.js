/**
 * Hotel supplier interface. The hotel service (index.js) only talks to a supplier through these methods, so a real
 * source (a hotel content API plus a rates and booking API) can replace the simulator without touching the agent,
 * tools or bookings.
 *
 * All methods are synchronous for the simulator. A networked supplier would make them async; the hotel service
 * would then await them (bookings and places already treat results as plain values).
 *
 * @typedef {{ lng: number, lat: number }} LngLat
 * @typedef {'budget'|'midscale'|'upscale'|'luxury'} Category
 *
 * @typedef {object} Hotel  see docs/SPEC.md "Shared domain types"
 *
 * @typedef {object} CityInfo
 * @property {string} name        e.g. 'New York' (matches Hotel.city)
 * @property {string} state       e.g. 'NY'
 * @property {string} fullName    e.g. 'New York, NY'
 * @property {string} code        short code used in ids, e.g. 'nyc'
 * @property {string} zone        IANA time zone of the city's hotels, e.g. 'America/New_York'
 * @property {'business'|'mixed'|'leisure'} market
 * @property {LngLat} center
 * @property {number[]|null} [season]  optional 12 monthly price factors
 *
 * @typedef {object} ResolvedPlace
 * @property {string} name        canonical landmark (or area) name, e.g. 'Times Square'
 * @property {LngLat} location
 * @property {string} area        area the place belongs to, '' if unknown
 * @property {string} [type]      Sight / Transit hub / Shopping / Neighborhood …
 * @property {number} [extentM]  rough radius of an extended place (park, beach); distances are measured from its edge
 * @property {'exact'|'partial'} [matched]  how the text matched (partial = fuzzy containment)
 *
 * @typedef {object} AreaGuide
 * @property {string} name
 * @property {string} district
 * @property {string} reason      one line on why to stay there
 * @property {LngLat} location    area center
 * @property {Array<{ name: string, type: string, location: LngLat, aliases: string[], extentM?: number, district?: string }>} landmarks
 *
 * @typedef {object} HotelSupplier
 * @property {string} source                                   'sim'
 * @property {() => Array<{ name: string, state: string, zone: string, market: string }>} listCities
 * @property {(text: string) => CityInfo|null} resolveCity      tolerant: 'NYC', 'New York, NY', 'going to Vegas'
 * @property {(city: string, text: string) => ResolvedPlace|null} resolveLandmark   'near Times Square' → Times Square
 * @property {(q: { city: string, keyword?: string, location?: LngLat, radiusM?: number, categories?: Category[] }) => Hotel[]} searchHotels
 *           unpriced, unsorted; filters by radius (when location given), categories and keyword
 * @property {(id: string) => Hotel|null} getHotel
 * @property {(city: string) => AreaGuide[]} [listAreas]         optional city guide (used by places.js)
 */

export const CATEGORIES = Object.freeze(['budget', 'midscale', 'upscale', 'luxury']);
export const CATEGORY_LABELS = Object.freeze({ budget: 'Budget', midscale: 'Midscale', upscale: 'Upscale', luxury: 'Luxury' });

const CATEGORY_WORDS = [
  ['budget', ['budget', 'cheap', 'cheapest', 'inexpensive', 'affordable', 'economy', 'value', 'motel', 'low-cost', 'low cost', '1-star', '2-star', 'one-star', 'two-star', '1 star', '2 star']],
  ['midscale', ['midscale', 'mid-scale', 'mid-range', 'midrange', 'mid range', 'mid-priced', 'moderate', 'moderately priced', '3-star', 'three-star', '3 star']],
  ['upscale', ['upscale', 'upper upscale', 'premium', 'upmarket', '4-star', 'four-star', '4 star']],
  ['luxury', ['luxury', 'luxurious', 'luxe', 'high-end', 'high end', 'five-star', '5-star', '5 star', 'deluxe', 'fancy', 'top-end']],
];

/** 'budget' | 'Budget' | 'cheap' | 'five-star' → category, else null. */
export function normalizeCategory(x) {
  const s = String(x || '').trim().toLowerCase();
  if (!s) return null;
  if (CATEGORIES.includes(s)) return s;
  for (const [cat, words] of CATEGORY_WORDS) if (words.includes(s)) return cat;
  return null;
}

// Multi-word wishes first, so 'free parking' stays one wish; each maps to the word the hotel data uses.
const PHRASES = [
  ['breakfast included', 'breakfast'], ['free breakfast', 'breakfast'], ['complimentary breakfast', 'breakfast'], ['with breakfast', 'breakfast'],
  ['bed and breakfast', 'historic'], ['bed & breakfast', 'historic'], ['b&b', 'historic'],
  ['swimming pool', 'pool'], ['rooftop pool', 'pool'], ['free parking', 'parking'], ['valet parking', 'parking'],
  ['family friendly', 'family'], ['family-friendly', 'family'], ['kid friendly', 'family'], ['kid-friendly', 'family'], ['kids club', 'family'],
  ['fitness center', 'fitness'], ['pet friendly', 'pet'], ['pet-friendly', 'pet'], ['dog friendly', 'pet'], ['dog-friendly', 'pet'],
  ['near the subway', 'transit'], ['near transit', 'transit'], ['near the metro', 'transit'], ['public transit', 'transit'],
  ['newly opened', 'newly opened'], ['brand new', 'newly opened'], ['new hotel', 'newly opened'],
  ['ocean view', 'ocean view'], ['sea view', 'ocean view'], ['oceanfront', 'ocean view'], ['ocean front', 'ocean view'],
  ['harbor view', 'harbor view'], ['harbour view', 'harbor view'],
  ['city view', 'city view'], ['skyline view', 'city view'], ['bay view', 'bay view'], ['lake view', 'lake view'], ['river view', 'river view'],
  ['park view', 'park view'], ['mountain view', 'mountain view'],
  ['airport shuttle', 'shuttle'], ['rooftop bar', 'rooftop'], ['hot tub', 'spa'], ['ev charging', 'ev charging'], ['electric car', 'ev charging'],
  ['on the beach', 'beach'], ['beachfront', 'beach'], ['beach front', 'beach'],
];
const SYNONYMS = new Map([
  ['breakfast', 'breakfast'], ['pool', 'pool'], ['pools', 'pool'], ['swimming', 'pool'],
  ['parking', 'parking'], ['garage', 'parking'], ['kids', 'family'], ['kid', 'family'], ['family', 'family'], ['families', 'family'],
  ['children', 'family'], ['child', 'family'], ['gym', 'fitness'], ['fitness', 'fitness'], ['workout', 'fitness'],
  ['spa', 'spa'], ['jacuzzi', 'spa'], ['pet', 'pet'], ['pets', 'pet'], ['dog', 'pet'], ['dogs', 'pet'],
  ['subway', 'transit'], ['metro', 'transit'], ['transit', 'transit'], ['train', 'transit'],
  ['quiet', 'quiet'], ['peaceful', 'quiet'], ['calm', 'quiet'], ['view', 'view'], ['views', 'view'],
  ['shuttle', 'shuttle'], ['rooftop', 'rooftop'], ['bar', 'bar'], ['restaurant', 'restaurant'], ['kitchen', 'kitchenette'], ['kitchenette', 'kitchenette'],
  ['casino', 'casino'], ['beach', 'beach'], ['historic', 'historic'], ['inn', 'historic'], ['guesthouse', 'historic'], ['boutique', 'boutique'],
  ['trendy', 'trendy'], ['hip', 'trendy'], ['business', 'business'],
]);
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'without', 'near', 'nearby', 'close', 'to', 'in', 'on', 'at', 'for', 'of', 'by', 'from',
  'hotel', 'hotels', 'room', 'rooms', 'stay', 'place', 'places', 'some', 'good', 'nice', 'great', 'really', 'very', 'please',
  'want', 'need', 'looking', 'like', 'that', 'has', 'have', 'having', 'offers', 'one', 'ones', 'something', 'i', 'we', 'me', 'us',
  'is', 'are', 'it', 'its', 'should', 'must', 'would', 'be', 'free', 'included', 'available', 'area',
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a free-text hotel keyword into match tokens plus any category words it contains.
 * 'family-friendly with a pool' → { tokens: ['family', 'pool'], categories: [] };
 * 'five-star ocean view' → { tokens: ['ocean view'], categories: ['luxury'] }.
 */
export function parseKeyword(keyword, { ignore = [] } = {}) {
  const tokens = [];
  const categories = [];
  const add = (t) => {
    if (t && !tokens.includes(t)) tokens.push(t);
  };
  let s = ` ${String(keyword || '').toLowerCase().replace(/[’]/g, "'").replace(/[;,/|+()]+/g, ' , ').replace(/\s+/g, ' ')} `;
  for (const ignored of ignore) {
    const w = String(ignored || '').toLowerCase().trim();
    if (w) s = s.replace(new RegExp(`(^|\\s)${escapeRe(w)}(?=\\s|$)`, 'g'), ' ');
  }
  // Category phrases ('five-star', 'mid-range') are taken out first.
  for (const [cat, words] of CATEGORY_WORDS) {
    for (const w of [...words].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(^|\\s)${escapeRe(w)}(?=\\s|$)`, 'g');
      if (re.test(s)) {
        if (!categories.includes(cat)) categories.push(cat);
        s = s.replace(re, ' , ');
      }
    }
  }
  for (const [phrase, token] of PHRASES) {
    const re = new RegExp(`(^|\\s)${escapeRe(phrase)}(?=\\s|$)`, 'g');
    if (re.test(s)) {
      add(token);
      s = s.replace(re, ' , ');
    }
  }
  for (const raw of s.split(/[\s,]+/)) {
    const w = raw.replace(/^[^a-z0-9&]+|[^a-z0-9&]+$/g, '');
    // Single letters and filler words match almost everything, so they are not useful filters.
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    add(SYNONYMS.get(w) || w);
  }
  return { tokens, categories };
}

/**
 * Preference tokens that belong to rate plans rather than to the hotel (breakfast is sold with a rate, or is free
 * at the hotel), so the hotel service matches them against the priced room offer instead of the hotel's text.
 */
export const RATE_TOKENS = Object.freeze(new Set(['breakfast']));

/**
 * True when every token appears, as whole words, in the hotel's name / area / district / tags / amenities /
 * category label ('pool' matches 'Outdoor pool'; 'bar' does not match 'Harbor').
 */
export function hotelMatchesKeyword(hotel, tokens) {
  if (!tokens || !tokens.length) return true;
  const hay = [hotel.name, hotel.businessArea, hotel.district, ...(hotel.tags || []), ...(hotel.amenities || []), CATEGORY_LABELS[hotel.category] || '']
    .join(' | ')
    .toLowerCase();
  return tokens.every((t) => {
    const token = String(t).toLowerCase();
    // 'view' alone means any view.
    if (token === 'view') return /\bview\b/.test(hay);
    return new RegExp(`(^|[^a-z0-9])${escapeRe(token)}s?($|[^a-z0-9])`).test(hay);
  });
}
