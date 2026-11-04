/**
 * "Open in Uber" / "Open in Lyft" for the ride card: deep links that open the rider app (or its website) with the
 * pickup and drop-off filled in. No API keys, no network; the guest books and pays in Uber or Lyft.
 *
 * A point is { name?, lat?, lng?, address? }. A missing pickup means "where I am now". Uber can take a drop-off
 * by name/address alone; Lyft needs coordinates (without them its link opens with only the pickup set).
 */

// ---------------------------------------------------------------------------
// VERIFY: deep-link formats (Uber "Ride Requests deep links" and Lyft "Deep links" developer docs, as of 2025).
// ---------------------------------------------------------------------------
export const RIDE_LINKS = Object.freeze({
  // VERIFY: universal link; opens the app when installed, m.uber.com otherwise. Params: action=setPickup,
  // pickup=my_location | pickup[latitude]=&pickup[longitude]=&pickup[nickname]=&pickup[formatted_address]=,
  // dropoff[latitude]=&dropoff[longitude]=&dropoff[nickname]=&dropoff[formatted_address]=, client_id (optional).
  uber: 'https://m.uber.com/ul/',
  // VERIFY: id=lyft (ride type), pickup[latitude]=&pickup[longitude]=, destination[latitude]=&destination[longitude]=,
  // partner=<client id> (optional). Web link and app scheme take the same query.
  lyftWeb: 'https://lyft.com/ride',
  lyftApp: 'lyft://ridetype',
});

function coord(v, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 1e6) / 1e6 : null;
}

/** { name, lat, lng, address } with coordinates validated; null for nothing usable. */
export function ridePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = coord(p.lat ?? p.latitude ?? p.location?.lat, 90);
  const lng = coord(p.lng ?? p.longitude ?? p.location?.lng, 180);
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '';
  const address = typeof p.address === 'string' ? p.address.trim().slice(0, 160) : '';
  const hasCoords = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  if (!hasCoords && !name && !address) return null;
  return { name, address, lat: hasCoords ? lat : null, lng: hasCoords ? lng : null };
}

function query(pairs) {
  // Bracketed keys are written as the docs show them; values are percent-encoded.
  return pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

function pointParams(prefix, p) {
  if (!p) return [];
  return [
    [`${prefix}[latitude]`, p.lat],
    [`${prefix}[longitude]`, p.lng],
    [`${prefix}[nickname]`, p.name],
    [`${prefix}[formatted_address]`, p.address],
  ];
}

/** @param {{ pickup?: object|null, dropoff: object, clientId?: string }} trip */
export function buildUberLink({ pickup, dropoff, clientId } = {}) {
  const from = ridePoint(pickup);
  const to = ridePoint(dropoff);
  const pairs = [['action', 'setPickup']];
  if (clientId) pairs.push(['client_id', clientId]);
  if (from && from.lat !== null) pairs.push(...pointParams('pickup', from));
  else pairs.push(['pickup', 'my_location']);
  if (to) pairs.push(...pointParams('dropoff', to));
  return `${RIDE_LINKS.uber}?${query(pairs)}`;
}

/** @param {{ pickup?: object|null, dropoff: object, partner?: string, app?: boolean }} trip */
export function buildLyftLink({ pickup, dropoff, partner, app = false } = {}) {
  const from = ridePoint(pickup);
  const to = ridePoint(dropoff);
  const pairs = [['id', 'lyft']];
  if (from && from.lat !== null) pairs.push(['pickup[latitude]', from.lat], ['pickup[longitude]', from.lng]);
  if (to && to.lat !== null) pairs.push(['destination[latitude]', to.lat], ['destination[longitude]', to.lng]);
  if (partner) pairs.push(['partner', partner]);
  return `${app ? RIDE_LINKS.lyftApp : RIDE_LINKS.lyftWeb}?${query(pairs)}`;
}

/**
 * Both buttons for a ride card.
 * @param {{ pickup?: object|null, dropoff: object, uberClientId?: string, lyftPartner?: string }} trip
 * @returns {{ uber: { label: string, url: string }, lyft: { label: string, url: string, appUrl: string, exact: boolean } } | null}
 *   null when the drop-off is unusable; lyft.exact is false when Lyft could not get the drop-off (no coordinates).
 */
export function buildRideLinks({ pickup = null, dropoff, uberClientId, lyftPartner } = {}) {
  const to = ridePoint(dropoff);
  if (!to) return null;
  return {
    uber: { label: 'Open in Uber', url: buildUberLink({ pickup, dropoff: to, clientId: uberClientId }) },
    lyft: {
      label: 'Open in Lyft',
      url: buildLyftLink({ pickup, dropoff: to, partner: lyftPartner }),
      appUrl: buildLyftLink({ pickup, dropoff: to, partner: lyftPartner, app: true }),
      exact: to.lat !== null,
    },
  };
}
