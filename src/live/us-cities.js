/**
 * Major US cities for the live hotel search: a city the guest names is searched by coordinates + radius around
 * its hotel district (more reliable than name matching), any other US city by name. Coordinates are approximate
 * centers of where visitors stay; radiusM is how far out a city-wide search reaches.
 */
export const US_CITIES = Object.freeze([
  ['New York', 'NY', 40.7549, -73.984, 12000, ['new york city', 'nyc', 'manhattan', 'ny']],
  ['Los Angeles', 'CA', 34.0522, -118.2437, 25000, ['la', 'l a', 'hollywood']],
  ['San Francisco', 'CA', 37.7849, -122.4094, 8000, ['sf', 'san fran', 'frisco']],
  ['Las Vegas', 'NV', 36.1147, -115.1728, 12000, ['vegas', 'lv', 'the strip']],
  ['Miami', 'FL', 25.7617, -80.1918, 15000, []],
  ['Miami Beach', 'FL', 25.7907, -80.13, 6000, ['south beach']],
  ['Orlando', 'FL', 28.481, -81.458, 25000, ['disney world', 'walt disney world']],
  ['Chicago', 'IL', 41.8881, -87.6298, 12000, ['chi town', 'chi-town']],
  ['Seattle', 'WA', 47.6062, -122.3321, 10000, []],
  ['Boston', 'MA', 42.3554, -71.0605, 10000, []],
  ['Washington', 'DC', 38.9001, -77.0369, 10000, ['washington dc', 'washington d c', 'dc', 'd c']],
  ['New Orleans', 'LA', 29.9511, -90.0715, 8000, ['nola']],
  ['Honolulu', 'HI', 21.285, -157.8357, 10000, ['waikiki', 'oahu']],
  ['San Diego', 'CA', 32.7157, -117.1611, 15000, []],
  ['Nashville', 'TN', 36.1627, -86.7816, 12000, []],
  ['Austin', 'TX', 30.2672, -97.7431, 12000, []],
  ['Denver', 'CO', 39.7392, -104.9903, 12000, []],
  ['Philadelphia', 'PA', 39.9526, -75.1652, 10000, ['philly']],
  ['Atlanta', 'GA', 33.749, -84.388, 15000, ['atl']],
  ['Dallas', 'TX', 32.7767, -96.797, 20000, []],
  ['Houston', 'TX', 29.7604, -95.3698, 25000, []],
  ['Phoenix', 'AZ', 33.4484, -112.074, 25000, []],
  ['Scottsdale', 'AZ', 33.4942, -111.9261, 12000, []],
  ['Sedona', 'AZ', 34.8697, -111.761, 10000, []],
  ['San Antonio', 'TX', 29.4241, -98.4936, 15000, []],
  ['Portland', 'OR', 45.5152, -122.6784, 10000, []],
  ['Salt Lake City', 'UT', 40.7608, -111.891, 12000, ['slc']],
  ['Minneapolis', 'MN', 44.9778, -93.265, 12000, []],
  ['Detroit', 'MI', 42.3314, -83.0458, 15000, []],
  ['Charlotte', 'NC', 35.2271, -80.8431, 15000, []],
  ['Raleigh', 'NC', 35.7796, -78.6382, 12000, []],
  ['Tampa', 'FL', 27.9506, -82.4572, 15000, []],
  ['Fort Lauderdale', 'FL', 26.1224, -80.1373, 12000, ['ft lauderdale']],
  ['Key West', 'FL', 24.5551, -81.78, 5000, []],
  ['Jacksonville', 'FL', 30.3322, -81.6557, 20000, []],
  ['St. Louis', 'MO', 38.627, -90.1994, 12000, ['st louis', 'saint louis']],
  ['Kansas City', 'MO', 39.0997, -94.5786, 15000, []],
  ['Pittsburgh', 'PA', 40.4406, -79.9959, 10000, []],
  ['Baltimore', 'MD', 39.2904, -76.6122, 10000, []],
  ['Indianapolis', 'IN', 39.7684, -86.1581, 12000, []],
  ['Columbus', 'OH', 39.9612, -82.9988, 15000, []],
  ['Cleveland', 'OH', 41.4993, -81.6944, 12000, []],
  ['Cincinnati', 'OH', 39.1031, -84.512, 12000, []],
  ['Milwaukee', 'WI', 43.0389, -87.9065, 12000, []],
  ['Sacramento', 'CA', 38.5816, -121.4944, 12000, []],
  ['San Jose', 'CA', 37.3382, -121.8863, 15000, []],
  ['Anaheim', 'CA', 33.8366, -117.9143, 8000, ['disneyland']],
  ['Palm Springs', 'CA', 33.8303, -116.5453, 10000, []],
  ['Santa Barbara', 'CA', 34.4208, -119.6982, 8000, []],
  ['Napa', 'CA', 38.2975, -122.2869, 10000, ['napa valley']],
  ['Savannah', 'GA', 32.0809, -81.0912, 8000, []],
  ['Charleston', 'SC', 32.7765, -79.9311, 8000, []],
  ['Myrtle Beach', 'SC', 33.6891, -78.8867, 12000, []],
  ['Memphis', 'TN', 35.1495, -90.049, 12000, []],
  ['Louisville', 'KY', 38.2527, -85.7585, 12000, []],
  ['Richmond', 'VA', 37.5407, -77.436, 10000, []],
  ['Virginia Beach', 'VA', 36.8529, -75.978, 12000, []],
  ['Atlantic City', 'NJ', 39.3643, -74.4229, 6000, []],
  ['Niagara Falls', 'NY', 43.0962, -79.0377, 8000, []],
  ['Albuquerque', 'NM', 35.0844, -106.6504, 15000, []],
  ['Santa Fe', 'NM', 35.687, -105.9378, 8000, []],
  ['Anchorage', 'AK', 61.2181, -149.9003, 12000, []],
].map(([name, state, lat, lng, radiusM, aliases]) => Object.freeze({ name, state, lat, lng, radiusM, aliases: Object.freeze(aliases) })));

const STATE_NAMES = Object.freeze({
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky',
  la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
});

function norm(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const STATE_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code])));

/** 'downtown austin tx' → { s: 'downtown austin', state: 'tx' }; strips "in", "to", "usa" and a trailing state. */
function stripNoise(q) {
  let s = q.replace(/^(in|to|at|near|around|visiting|the city of|city of)\s+/, '').replace(/\s+(usa|us|united states)$/, '');
  let state = '';
  // Longest state names first, so "west virginia" is not read as "virginia".
  for (const full of Object.keys(STATE_BY_NAME).sort((a, b) => b.length - a.length)) {
    if (s.endsWith(` ${full}`) && s.length > full.length + 2) {
      s = s.slice(0, -full.length - 1);
      state = STATE_BY_NAME[full];
      break;
    }
  }
  const parts = s.split(' ');
  if (!state && parts.length > 1 && Object.hasOwn(STATE_NAMES, parts.at(-1))) {
    state = parts.at(-1);
    s = parts.slice(0, -1).join(' ');
  }
  return { s: s.trim(), state };
}

function keysOf(c) {
  return [norm(c.name), norm(`${c.name} ${c.state}`), norm(`${c.name} ${STATE_NAMES[c.state.toLowerCase()] || ''}`), ...c.aliases.map(norm)];
}

function slug(text) {
  return norm(text).replace(/\s+/g, '-').slice(0, 40);
}

function titleCase(text) {
  return String(text).trim().replace(/\s+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase()).slice(0, 60);
}

function info(c) {
  return {
    name: c.name,
    fullName: `${c.name}, ${c.state}`,
    code: slug(c.name),
    state: c.state,
    countryCode: 'US',
    tier: 'live',
    center: { lng: c.lng, lat: c.lat },
    radiusM: c.radiusM,
    known: true,
  };
}

/**
 * 'NYC' / 'new york, ny' / 'in Vegas' → the city; any other text → a free-text US city (known: false, no center),
 * searched by name. Empty text → null.
 */
export function resolveUsCity(text) {
  const q = norm(text);
  if (!q) return null;
  const { s, state } = stripNoise(q);
  const variants = [...new Set([q, s])].filter(Boolean);
  // A state the guest named must match ("Portland, Maine" is not Portland, OR).
  const stateOk = (c) => !state || c.state.toLowerCase() === state;
  for (const v of variants) {
    const hit = US_CITIES.find((c) => keysOf(c).includes(v) && (v === q || stateOk(c)));
    if (hit) return info(hit);
  }
  // 'downtown austin' / 'a hotel in boston' → the longest city name contained in the text.
  let best = null;
  for (const c of US_CITIES) {
    if (!stateOk(c)) continue;
    for (const k of keysOf(c)) {
      if (k.length < 4) continue;
      if (variants.some((v) => ` ${v} `.includes(` ${k} `)) && (!best || k.length > best.len)) best = { c, len: k.length };
    }
  }
  if (best) return info(best.c);
  const raw = String(text).trim().replace(/^(in|to|at|near)\s+/i, '').replace(/,?\s*(usa|us|united states)$/i, '');
  const cityPart = raw.split(',')[0].trim() || s;
  const city = titleCase(state && norm(cityPart) === q ? s : cityPart);
  const code = state.toUpperCase();
  return {
    name: city,
    fullName: code ? `${city}, ${code}` : city,
    code: slug(city),
    state: code,
    countryCode: 'US',
    tier: 'live',
    center: null,
    radiusM: null,
    known: false,
  };
}
