import { LiveServiceError, createHttpClient, codeForStatus, parseRetryAfterMs, isPlainObject, str, num, createTtlCache, normalizeLogger } from './http.js';

/**
 * Places: turns "near Times Square" into coordinates for the hotel search.
 *
 * - createGooglePlaces: Google Places API (New) Text Search, when GOOGLE_PLACES_API_KEY is set.
 * - createSimGeocoder: the demo landmarks of the simulated supplier (no key, no network).
 * - createPlacesConnector: Google first (cached), the demo landmarks when there is no key or Google fails,
 *   so the app keeps working in demo mode and through a Google outage.
 *
 * Every geocoder has `geocode(text, { city, near, radiusM, signal }) → Promise<Place|null>` where
 * Place = { name, lat, lng, address, types, id?, source: 'google'|'sim' }.
 */

// ---------------------------------------------------------------------------
// VERIFY: assumptions about Google Places API (New) — Text Search (as documented through 2025).
// ---------------------------------------------------------------------------
export const GOOGLE_PLACES = Object.freeze({
  // VERIFY: POST with JSON body { textQuery, languageCode, regionCode, pageSize, locationBias: { circle: { center:
  // { latitude, longitude }, radius (meters, max 50000) } } }. If `pageSize` is rejected ("Unknown name"), use the
  // older `maxResultCount`.
  textSearchUrl: 'https://places.googleapis.com/v1/places:searchText',
  // VERIFY: the key travels in X-Goog-Api-Key; X-Goog-FieldMask is required (no spaces). These fields bill as
  // "Text Search Pro".
  apiKeyHeader: 'X-Goog-Api-Key',
  fieldMaskHeader: 'X-Goog-FieldMask',
  fieldMask: 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
  // VERIFY: answer { places: [{ id, displayName: { text }, formattedAddress, location: { latitude, longitude },
  // types }] }; no match → {} (no `places`). Errors: { error: { code, message, status } } — 400 INVALID_ARGUMENT
  // (also for a bad key: "API key not valid"), 403 PERMISSION_DENIED (API not enabled / key restricted),
  // 429 RESOURCE_EXHAUSTED.
  maxBiasRadiusM: 50000,
});

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function mapPlace(p) {
  if (!isPlainObject(p)) return null;
  const lat = num(p.location?.latitude);
  const lng = num(p.location?.longitude);
  const name = str(p.displayName?.text ?? p.displayName ?? p.name, 120);
  if (lat === null || lng === null || !name) return null;
  return {
    name,
    lat,
    lng,
    address: str(p.formattedAddress, 200),
    types: Array.isArray(p.types) ? p.types.filter((t) => typeof t === 'string').slice(0, 8) : [],
    id: str(p.id, 200),
    source: 'google',
  };
}

/** Google error body → LiveServiceError (an invalid key is a 400 there, not a 401). */
export function classifyGoogleError(status, body, headers) {
  const e = isPlainObject(body?.error) ? body.error : {};
  const message = str(e.message ?? (typeof body === 'string' ? body : ''), 300);
  const gstatus = str(e.status, 40);
  let code = codeForStatus(status);
  if (/api key|api_key_invalid|key not valid|PERMISSION_DENIED|billing|not authorized|disabled/i.test(`${gstatus} ${message}`)) code = 'auth';
  else if (gstatus === 'RESOURCE_EXHAUSTED') code = 'rate_limit';
  return new LiveServiceError('google_places', code, {
    status,
    providerCode: gstatus,
    retryAfterMs: parseRetryAfterMs(headers),
    message: `Google Places ${status} ${gstatus} ${message}`.replace(/\s+/g, ' ').trim(),
  });
}

/**
 * @param {{ apiKey: string, fetch?: typeof fetch, logger?: object|Function, timeoutMs?: number, languageCode?: string,
 *           regionCode?: string, maxRetries?: number, sleep?: Function }} opts
 */
export function createGooglePlaces({ apiKey, fetch, logger, timeoutMs = 8000, languageCode = 'en', regionCode = 'US', maxRetries = 1, sleep } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('createGooglePlaces: apiKey is required');
  const http = createHttpClient({
    service: 'google_places',
    baseUrl: GOOGLE_PLACES.textSearchUrl,
    fetch,
    logger,
    timeoutMs,
    maxRetries,
    sleep,
    secrets: [key],
    headers: { [GOOGLE_PLACES.apiKeyHeader]: key, [GOOGLE_PLACES.fieldMaskHeader]: GOOGLE_PLACES.fieldMask },
    classify: classifyGoogleError,
  });

  /** @returns {Promise<Place[]>} */
  async function searchText(query, { near, radiusM = 30000, limit = 5, signal } = {}) {
    const textQuery = str(query, 200);
    if (!textQuery) return [];
    const body = { textQuery, languageCode, regionCode, pageSize: Math.min(20, Math.max(1, Math.round(limit) || 5)) };
    if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
      body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: Math.min(GOOGLE_PLACES.maxBiasRadiusM, Math.max(100, radiusM)) } };
    }
    // A search reads nothing and changes nothing, so it may be retried.
    const { data } = await http.request({ method: 'POST', body, signal, retry: true });
    return (Array.isArray(data?.places) ? data.places : []).map(mapPlace).filter(Boolean);
  }

  /** "Times Square" in "New York, NY" → the best match, or null. */
  async function geocode(text, { city = '', near = null, radiusM, signal } = {}) {
    const q = str(text, 160);
    if (!q) return null;
    const c = str(city, 80);
    const query = c && !q.toLowerCase().includes(c.split(',')[0].toLowerCase()) ? `${q}, ${c}` : q;
    const [best] = await searchText(query, { near, radiusM, limit: 1, signal });
    return best || null;
  }

  return { source: 'google', live: true, searchText, geocode };
}

/**
 * Demo landmarks through a supplier with resolveLandmark(city, text) → { name, location: { lng, lat }, area, type }
 * (the simulated supplier). Never touches the network.
 */
export function createSimGeocoder(supplier) {
  return {
    source: 'sim',
    live: false,
    async geocode(text, { city = '' } = {}) {
      if (!supplier || typeof supplier.resolveLandmark !== 'function') return null;
      const cityName = String(city || '').split(',')[0].trim();
      const lm = await supplier.resolveLandmark(cityName, String(text || ''));
      if (!lm || !lm.location || !Number.isFinite(lm.location.lat) || !Number.isFinite(lm.location.lng)) return null;
      return { name: lm.name, lat: lm.location.lat, lng: lm.location.lng, address: lm.area || '', types: lm.type ? [lm.type] : [], source: 'sim' };
    },
  };
}

/**
 * The geocoder the app uses: Google when a key is set (results cached for a day), falling back to `fallback`
 * (usually createSimGeocoder(simSupplier)) when there is no key, no match is not an error, and Google fails.
 * @param {{ apiKey?: string, fetch?: typeof fetch, logger?: object|Function, fallback?: { geocode: Function }|null,
 *           timeoutMs?: number, now?: () => number, google?: object }} opts
 */
export function createPlacesConnector({ apiKey, fetch, logger, fallback = null, timeoutMs, now = () => Date.now(), google } = {}) {
  const log = normalizeLogger(logger);
  const primary = google || (apiKey ? createGooglePlaces({ apiKey, fetch, logger, timeoutMs }) : null);
  const cache = createTtlCache({ max: 2000, ttlMs: CACHE_TTL_MS, now });

  async function viaFallback(text, opts) {
    if (!fallback || typeof fallback.geocode !== 'function') return null;
    try {
      return await fallback.geocode(text, opts);
    } catch {
      return null;
    }
  }

  async function geocode(text, opts = {}) {
    const q = str(text, 160);
    if (!q) return null;
    if (!primary) return viaFallback(q, opts);
    const key = `${q.toLowerCase()}|${String(opts.city || '').toLowerCase()}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
      const place = await primary.geocode(q, opts);
      cache.set(key, place, place ? CACHE_TTL_MS : 60 * 60 * 1000);
      return place;
    } catch (err) {
      if (opts.signal?.aborted || err?.name === 'AbortError') throw err;
      log.warn(`[places] Google Places failed (${err?.code || 'error'}); using the demo landmarks`);
      return viaFallback(q, opts);
    }
  }

  return { source: primary ? 'google' : 'sim', live: Boolean(primary), geocode, searchText: primary ? primary.searchText : async () => [] };
}
