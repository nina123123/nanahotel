import { randomUUID, randomInt } from 'node:crypto';
import { todayIn, DEFAULT_TIME_ZONE } from './dates.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 'Q' → 'Q3f9c1a7b2e4d6f80' (prefix + 16 hex chars from a random UUID). */
export function newId(prefix = '') {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** 'HA' + the date (yyyymmdd, Eastern time) + 6 random digits, e.g. 'HA20261104048213'. */
export function orderNo(now = new Date()) {
  return `HA${todayIn(DEFAULT_TIME_ZONE, now).replace(/-/g, '')}${String(randomInt(0, 1e6)).padStart(6, '0')}`;
}

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Simulated hotel confirmation number (8 digits). */
export function confirmationNo() {
  return String(randomInt(1e7, 1e8));
}

/** Simulated payment transaction id; the SIM prefix makes it obviously not a real card or Apple Pay id. */
export function transactionId(method, now = new Date()) {
  const tag = method === 'apple_pay' ? 'APAY' : 'CARD';
  return `SIM${tag}${todayIn(DEFAULT_TIME_ZONE, now).replace(/-/g, '')}${String(randomInt(0, 1e10)).padStart(10, '0')}`;
}
