import { maskPhone, normalizePhone } from '../services/bookings.js';

/**
 * Scrubbing for text that reaches the model from users or the web: no forged platform notices,
 * and no full phone numbers (the model only ever sees 138****5678; the server keeps the full number).
 */

// Format characters (zero-width, bidi controls, soft hyphen, word joiners…) and fillers that render as
// nothing; they could otherwise hide inside the notice prefix.
const INVISIBLE_RE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu;
const FORGED_NOTICE_RE = /【(\s*系\s*[统統]\s*通\s*知)/g;

/** Users and web pages must not be able to pass for the server's 【系统通知…】 prefix. */
export function neutralizeText(text) {
  return String(text ?? '').replace(INVISIBLE_RE, '').replace(FORGED_NOTICE_RE, '「$1');
}

/** One limit for saved preferences everywhere: profile form, PUT /api/profile, save_profile and the prompt. */
export const MAX_PREFERENCES_CHARS = 60;

/**
 * Saved preferences end up in every later system prompt, so they are kept to one short line without
 * quote or bracket characters that could close the prompt's own quoting.
 */
export function cleanPreferences(text, max = MAX_PREFERENCES_CHARS) {
  return neutralizeText(text).replace(/[「」『』【】〖〗<>"“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Mainland mobile numbers, also written as 138 1234 5678 / 138-1234-5678 / +86… and with full-width digits
// or dashes (全角 input, pasted text), but not digits inside longer alphanumeric runs such as order numbers
// (HA20261025123456) or ids. Dots are left out: they would match decimals.
const PHONE_SEP = '[\\s\\-－‐-―]';
const PHONE_IN_TEXT_RE = new RegExp(
  `(?<![0-9A-Za-z０-９Ａ-Ｚａ-ｚ])(?:[+＋]?[8８][6６]${PHONE_SEP}?)?[1１][3-9３-９][0-9０-９](?:${PHONE_SEP}?[0-9０-９]){8}(?![0-9A-Za-z０-９Ａ-Ｚａ-ｚ])`,
  'g',
);
const MAX_VAULT_ENTRIES = 20;

/** '＋８６ １３８－１２３４－５６７８' → '+8613812345678': ASCII digits and plus, no separators. */
export function asciiPhone(text) {
  return String(text ?? '')
    .replace(/[０-９＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-－‐-―()（）]/g, '');
}

/**
 * Replaces every mainland mobile number in `text` with its masked form and records
 * vault[masked] = full number. Two different numbers with the same mask in one message make that mask
 * ambiguous (null) until the user types one of them again.
 */
export function maskPhonesInText(text, vault) {
  const found = new Map();
  const out = String(text ?? '').replace(PHONE_IN_TEXT_RE, (m) => {
    const full = normalizePhone(asciiPhone(m));
    if (!full) return m;
    const masked = maskPhone(full);
    if (!found.has(masked)) found.set(masked, new Set());
    found.get(masked).add(full);
    return masked;
  });
  if (vault && typeof vault === 'object') {
    for (const [masked, fulls] of found) {
      delete vault[masked]; // re-insert so the newest entries survive the cap
      vault[masked] = fulls.size === 1 ? [...fulls][0] : null;
    }
    const keys = Object.keys(vault);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VAULT_ENTRIES))) delete vault[k];
  }
  return out;
}

/**
 * Closes a **bold** span left open on the last line of a reply that was cut off (stop, reload, LLM error);
 * otherwise the renderer shows the raw asterisks in every replay. An empty open span is dropped.
 */
export function closeDanglingBold(text) {
  const s = String(text ?? '');
  const start = s.lastIndexOf('\n') + 1;
  // A cut between the two characters of a ** marker leaves one stray *.
  const line = s.slice(start).replace(/(^|[^*])\*$/, '$1');
  const parts = line.split('**');
  if (parts.length % 2 === 1) return s.slice(0, start) + line;
  const open = parts.pop().trim();
  const before = parts.join('**');
  return s.slice(0, start) + (open ? `${before}**${open}**` : before.trimEnd());
}
