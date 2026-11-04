import { randomUUID, randomInt } from 'node:crypto';
import { todayCN } from './dates.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 'Q' → 'Q3f9c1a7b2e4d6f80' (prefix + 16 hex chars from a random UUID). */
export function newId(prefix = '') {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** 'HA' + China date yyyymmdd + 6 random digits, e.g. 'HA20261025048213'. */
export function orderNo(now = new Date()) {
  return `HA${todayCN(now).replace(/-/g, '')}${String(randomInt(0, 1e6)).padStart(6, '0')}`;
}

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Simulated hotel confirmation number (8 digits). */
export function confirmationNo() {
  return String(randomInt(1e7, 1e8));
}

/** Simulated payment transaction id; the SIM prefix makes it obviously not a real 微信/支付宝 id. */
export function transactionId(method, now = new Date()) {
  const tag = method === 'alipay' ? 'ALI' : 'WX';
  return `SIM${tag}${todayCN(now).replace(/-/g, '')}${String(randomInt(0, 1e10)).padStart(10, '0')}`;
}
