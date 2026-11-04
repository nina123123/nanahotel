const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export function isPoint(p) {
  return !!p && Number.isFinite(p.lng) && Number.isFinite(p.lat);
}

/** Haversine distance in whole meters; null when either point is missing. */
export function distanceM(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Point `meters` away from `origin` along `bearingDeg` (0 = north, clockwise).
 * Equirectangular approximation: fine for the few-km offsets used by the simulator.
 */
export function offsetPoint(origin, meters, bearingDeg) {
  const b = bearingDeg * RAD;
  const dLat = (meters * Math.cos(b)) / EARTH_RADIUS_M / RAD;
  const dLng = (meters * Math.sin(b)) / (EARTH_RADIUS_M * Math.cos(origin.lat * RAD)) / RAD;
  return { lng: round6(origin.lng + dLng), lat: round6(origin.lat + dLat) };
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}
