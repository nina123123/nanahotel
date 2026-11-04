// node:crypto subset backed by Web Crypto.
const webCrypto = globalThis.crypto;

export function randomUUID() {
  if (typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  const b = webCrypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** randomInt(max) or randomInt(min, max): an integer in [min, max), without modulo bias (range < 2^48, as in Node). */
export function randomInt(min, max) {
  if (max === undefined) [min, max] = [0, min];
  const range = max - min;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !(range > 0) || range >= 2 ** 48) {
    throw new RangeError('randomInt: invalid range');
  }
  const limit = Math.floor(2 ** 48 / range) * range;
  const buf = new Uint32Array(2);
  let x;
  do {
    webCrypto.getRandomValues(buf);
    x = (buf[0] & 0xffff) * 2 ** 32 + buf[1];
  } while (x >= limit);
  return min + (x % range);
}

export function randomBytes(n) {
  return webCrypto.getRandomValues(new Uint8Array(n));
}

export default { randomUUID, randomInt, randomBytes };
