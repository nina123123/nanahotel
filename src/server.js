import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULTS, DEFAULT_LIMITS, ROOT_DIR } from './config.js';
import { createSseWriter } from './http/sse.js';
import { createStaticHandler } from './http/static.js';
import { isUuid, newId } from './util/ids.js';
import { formatDate, formatDateTime, formatClock, formatTime, todayIn, dateIn, canonicalTimeZone, resolveTimeZone, DEFAULT_TIME_ZONE } from './util/dates.js';
import { formatUsd } from './util/money.js';
import { createJsonStore } from './store/json-store.js';
import { namePartProblem, cleanName } from './util/names.js';
import { createSimSupplier } from './services/hotels/sim-supplier.js';
import { createHotelService, withPromotions } from './services/hotels/index.js';
import { createPlacesService } from './services/places.js';
import {
  createBookingService, maskPhone, normalizePhone, normalizeEmail, toPublicOrder, toPublicQuote,
  ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS, PHONE_MESSAGE, NAME_MESSAGE, EMAIL_MESSAGE,
} from './services/bookings.js';
import { createStayService, STANDARD_CHECKIN } from './services/stays.js';
import { createMerchantService, createPromotionBook } from './services/merchant.js';
import { createWebSearch } from './services/websearch.js';
import { PROVIDERS } from './llm/providers.js';
import { createLlmClient } from './llm/client.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { MAX_PREFERENCES_CHARS } from './agent/text.js';
import { runAgentTurn } from './agent/agent.js';
import { createTools, createProfileRepo } from './agent/tools.js';
import { createLiveServices, describeLiveConfig } from './live/index.js';
import { createLiveHotelService } from './services/hotels/live-service.js';
import { createLiveBookingService } from './services/live-bookings.js';

export const CSP = [
  "default-src 'self'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'", "connect-src 'self'",
  // The animated pet runs on Rive's WebAssembly runtime (public/vendor/rive), served from this origin.
  "script-src 'self' 'wasm-unsafe-eval'",
  // Not covered by default-src: an injected <base> or <form action> would otherwise still work.
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

/**
 * With live hotels: also the hotels' photos (any https host) and LiteAPI's card form, which runs on Stripe
 * (its scripts and frames, plus the hCaptcha check Stripe adds). Seen live in LiteAPI's sandbox.
 */
export const LIVE_CSP = [
  "default-src 'self'", "img-src 'self' data: https:", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://payment-wrapper.liteapi.travel https://api.stripe.com https://*.stripe.com https://m.stripe.network https://hcaptcha.com https://*.hcaptcha.com",
  "script-src 'self' 'wasm-unsafe-eval' https://payment-wrapper.liteapi.travel https://js.stripe.com https://*.js.stripe.com https://hcaptcha.com https://*.hcaptcha.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://b.stripecdn.com https://m.stripe.network https://hcaptcha.com https://*.hcaptcha.com",
  "object-src 'none'", "base-uri 'none'", "form-action 'self' https://hooks.stripe.com", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

const CONSOLE_COOKIE = 'nanahotel_console';
const CONSOLE_SESSION_MS = 12 * 60 * 60 * 1000;

/** Every notice in the model's history starts with this (then a space and the account). */
export const NOTICE_PREFIX = '[System notice — not from the user]';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_STORED_MESSAGES = 200;
const MAX_DISPLAY_ITEMS = 200;
const MAX_VAULT_ENTRIES = 20;
const EMPTY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MASKED_PHONE_RE = /^\*\*\*-\*\*\*-\d{4}$/;
const FULL_PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const AGENT_EVENTS = new Set(['status', 'delta', 'card', 'error', 'retract']);
const MSG_INTERNAL = 'Something went wrong on our side. Please try again in a moment.';
const systemClock = { now: () => new Date() };

/** Error that maps straight to `{ error: { code, message } }` with an HTTP status. */
export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// BookingError / HotelError / HttpError all carry { status, code, message }.
function isClientError(err) {
  return err && typeof err.code === 'string' && Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function sendError(res, err, logger) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  // A typed error from a service (BookingError, HotelError…): its status and message; a hotel supplier that
  // isn't answering is a 503 with a message the guest can read.
  if (err instanceof HttpError || isClientError(err) || (err && typeof err.code === 'string' && [502, 503, 504].includes(err.status))) {
    const error = { code: err.code, message: err.message };
    if (err.details && typeof err.details === 'object') error.details = err.details;
    const headers = {};
    if (err.retryAfterSec) headers['Retry-After'] = String(err.retryAfterSec);
    if (err.allow) headers.Allow = err.allow;
    if (err.status === 413) headers.Connection = 'close';
    sendJson(res, err.status, { error }, headers);
    return;
  }
  logger.error(`[http] unhandled error: ${err?.stack || err}`);
  sendJson(res, 500, { error: { code: 'internal', message: MSG_INTERNAL } });
}

/** Reads a JSON object body, enforcing `limit` bytes without destroying the socket mid-upload. */
function readJsonBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  const tooLarge = () => new HttpError(413, 'body_too_large', `The request is too large (the limit is ${Math.round(limit / 1024)} KB)`);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (failed) {
        // Keep draining so the 413 reaches the client, but stop absurd uploads outright.
        if (size > limit * 32) req.destroy();
        return;
      }
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'invalid_json', "The request body isn't valid JSON"));
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reject(new HttpError(400, 'invalid_json', 'The request body needs to be a JSON object'));
      }
      resolve(data);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
    // A client that disconnects mid-upload never sends 'end'; settle instead of hanging.
    req.on('close', () => {
      if (!req.complete && !failed) reject(new HttpError(400, 'aborted', 'The request was cut off; please try again'));
    });
  });
}

/** Sliding-window limiter keyed by user id or client address; memory is swept once per window. */
function createRateLimiter({ max, windowMs, now }) {
  const hits = new Map();
  let nextSweep = 0;
  function recent(key, t) {
    if (t >= nextSweep) {
      for (const [k, list] of hits) if (!list.length || list[list.length - 1] <= t - windowMs) hits.delete(k);
      nextSweep = t + windowMs;
    }
    const list = (hits.get(key) || []).filter((x) => x > t - windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }
  function verdict(list, t) {
    return list.length >= max ? { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) } : { ok: true };
  }
  return {
    /** Same answer as take() without using up a hit, for a request that other checks may still reject. */
    check(key) {
      const t = now();
      return verdict(recent(key, t), t);
    },
    take(key) {
      const t = now();
      const list = recent(key, t);
      const out = verdict(list, t);
      if (out.ok) {
        list.push(t);
        hits.set(key, list);
      }
      return out;
    },
  };
}

/** Keeps at most `max` messages and starts on a user message, so no tool result loses its call. */
function trimHistory(messages, max) {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role !== 'user') start++;
  return messages.slice(start);
}

/** The address rate limits key on. Behind a trusted proxy, the last X-Forwarded-For hop is the one it saw. */
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const hops = typeof raw === 'string' ? raw.split(',').map((h) => h.trim()).filter(Boolean) : [];
    // Hops to the left of the proxy's own entry are whatever the client sent.
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Keeps only well-formed masked → full phone entries (the agent fills this; it never leaves the server).
 * null marks a mask the user typed for two different numbers: it must outlive the turn and replace an
 * older number under that mask, or a later turn would quietly book with the older one.
 */
function cleanVault(vault) {
  const out = {};
  if (!vault || typeof vault !== 'object') return out;
  for (const [masked, full] of Object.entries(vault).slice(-MAX_VAULT_ENTRIES)) {
    if (!MASKED_PHONE_RE.test(masked)) continue;
    if (full === null || (typeof full === 'string' && FULL_PHONE_RE.test(full))) out[masked] = full;
  }
  return out;
}

/** The hotel's time zone (orders and requests carry it), for times at the hotel. */
function zoneOfHotel(hotel) {
  return resolveTimeZone(hotel?.timeZone, DEFAULT_TIME_ZONE);
}

function nightsText(n) {
  return `${n} night${n === 1 ? '' : 's'}`;
}

// The year is written only when it differs from today's: 'Wed, Dec 30 – Sat, Jan 2, 2027'.
function stayText(order, today) {
  const hotel = order.hotel?.name || 'the hotel';
  const room = order.room?.name ? `, ${order.room.name}` : '';
  const rooms = order.rooms > 1 ? `, ${order.rooms} rooms` : '';
  return `${hotel}${room}, check-in ${formatDate(order.checkIn, today)}, check-out ${formatDate(order.checkOut, today)}, ${nightsText(order.nights)}${rooms}`;
}

/** An instant as text at the hotel: 'Thu, Nov 5, 3:00 PM EST' (the zone is named, since the reader may be elsewhere). */
function dateTimeText(iso, zone, today) {
  return formatDateTime(iso, zone, { ref: today, abbr: true });
}

function cancelMoney(order) {
  if (!order.payment) return { line: 'no charge', model: "It wasn't paid, so there's no charge" };
  const c = order.cancellation || {};
  const penalty = Number(c.penalty) || 0;
  const refund = Number(c.refund) || 0;
  // A non-refundable rate keeps everything: there is nothing to send back.
  if (refund <= 0) return { line: 'non-refundable, no refund', model: `Cancellation fee ${formatUsd(penalty)}; no refund (test mode)` };
  const back = `refund ${formatUsd(refund)} to the original payment method (test mode)`;
  return penalty > 0
    ? { line: `${formatUsd(refund)} refunded`, model: `Cancellation fee ${formatUsd(penalty)}; ${back}` }
    : { line: `${formatUsd(refund)} refunded`, model: `Free cancellation; ${back}` };
}

/**
 * The notice for a confirm / pay / cancel tap: `text` is the short line shown in the chat, `modelText` the full
 * account the model gets after NOTICE_PREFIX.
 * @param {'pending'|'paid'|'cancelled'} kind
 * @param {string} [today] the user's date (YYYY-MM-DD), which decides whether dates need their year
 */
export function orderNotice(kind, order, today = todayIn()) {
  const status = ORDER_STATUS_LABELS[order.status] || order.status;
  const zone = zoneOfHotel(order.hotel);
  if (kind === 'pending') {
    const payBy = order.payBy ? dateTimeText(order.payBy, zone, today) : '';
    return {
      text: payBy ? `Booking placed: pay by ${formatClock(order.payBy, zone, { abbr: true })}` : 'Booking placed: complete the payment',
      modelText: `Order ${order.id} was placed and is ${status.toLowerCase()} (${payBy ? `complete the test payment by ${payBy}, or it closes automatically` : 'complete the test payment soon'}). ${stayText(order, today)}, ${formatUsd(order.totalPrice)} in total.`,
    };
  }
  if (kind === 'paid') {
    const method = PAYMENT_METHOD_LABELS[order.payment?.method] || 'Test payment';
    const amount = order.payment?.amount ?? order.totalPrice;
    const conf = order.confirmationNo ? `; hotel confirmation number ${order.confirmationNo}` : '';
    return {
      text: order.confirmationNo ? `Booked! Confirmation #${order.confirmationNo}` : 'Booked!',
      modelText: `Order ${order.id} was paid and is ${status.toLowerCase()}. ${method} (test mode), ${formatUsd(amount)}${conf}. ${stayText(order, today)}.`,
    };
  }
  const money = cancelMoney(order);
  return {
    text: `Booking cancelled: ${money.line}`,
    modelText: `Order ${order.id} was cancelled and is ${status.toLowerCase()}. ${money.model}.`,
  };
}

/** The model's account of an order notice (orderNotice(...).modelText). */
export function orderNoticeText(kind, order, today) {
  return orderNotice(kind, order, today).modelText;
}

/** Free text (a place, a review, a reply) inside a notice: one line, no brackets to pass for another notice, no quotes to close its own. */
function plain(v, max) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[[\]【】「」『』"“”]/g, '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Free text for the model, always quoted: “…” reads as what someone wrote, never as the platform's own account. */
function quoted(v, max) {
  return `“${plain(v, max)}”`;
}

/**
 * The notice for a user's tap on a stay card: `text` is the short line shown in the chat, `modelText` the full
 * account the model gets after NOTICE_PREFIX, `cards` the card that changed.
 * @param {'ride_confirmed'|'extended'|'review_published'} kind
 * @param {{ ride?, extension?, order?, review? }} data  public views (stays.js)
 * @param {string} [today] the user's date (YYYY-MM-DD) that decides whether dates need their year
 */
export function stayNotice(kind, data, today = todayIn()) {
  if (kind === 'ride_confirmed') {
    const r = data.ride;
    const d = r.driver || {};
    const zone = resolveTimeZone(r.timeZone, DEFAULT_TIME_ZONE);
    const sameDay = dateIn(r.pickupAt, zone) === today;
    const pickup = sameDay ? formatClock(r.pickupAt, zone) : formatDateTime(r.pickupAt, zone, { ref: today });
    return {
      text: `Ride booked: ${d.name} · ${d.plate}, pickup ${pickup}`,
      modelText: `The user confirmed the ride: ${r.kindLabel}, ${quoted(r.from, 60)} → ${quoted(r.to, 60)}, pickup ${dateTimeText(r.pickupAt, zone, today)}, ${r.carType}, `
        + `fare ${formatUsd(r.fare)} paid (test mode). Driver ${d.name} in a ${d.color} ${d.car}, plate ${d.plate}, phone ${d.phone}.`,
      cards: [{ type: 'ride', ride: r }],
    };
  }
  if (kind === 'extended') {
    const { extension: e, order } = data;
    const method = PAYMENT_METHOD_LABELS[e.payment?.method] || 'Test payment';
    return {
      text: `Extended ${nightsText(e.nights)}: check-out is now ${formatDate(e.toDate, today)}`,
      modelText: `The user extended the stay by ${nightsText(e.nights)}: ${e.hotel?.name || 'the hotel'}${e.room ? `, ${e.room}` : ''}; check-out is now ${formatDate(e.toDate, today)}; ${method} (test mode), ${formatUsd(e.price)}. `
        + `Order ${order.id} now has ${nightsText(order.nights)}, ${formatUsd(order.totalPrice)} in total.`,
      cards: [{ type: 'extension_quote', extension: e }],
    };
  }
  const r = data.review;
  return {
    text: `Review posted: ${r.rating} star${r.rating === 1 ? '' : 's'}`,
    modelText: `The user posted a review of ${r.hotel?.name || 'the hotel'}: ${r.rating} star${r.rating === 1 ? '' : 's'}, ${quoted(r.text, 80)} (simulated).`,
    cards: [{ type: 'review_draft', review: r }],
  };
}

/**
 * The notice for something the hotel did (a merchant.js event): `text` is the short line in the guest's chat,
 * `modelText` the account the model gets after NOTICE_PREFIX, `cards` the card that changed.
 * @param {{ kind: 'front_desk_checkin'|'early_checkin_approved'|'early_checkin_declined'|'review_replied', stay?, request?, review? }} event
 * @param {string} [today] the user's date (YYYY-MM-DD) that decides whether dates need their year
 */
export function hotelNotice(event, today = todayIn()) {
  if (event.kind === 'front_desk_checkin') {
    const st = event.stay;
    const zone = resolveTimeZone(st.timeZone, DEFAULT_TIME_ZONE);
    return {
      text: `The front desk checked you in: room ${st.roomNumber}`,
      modelText: `The front desk checked the user in: ${st.hotel?.name || 'the hotel'}${st.roomType ? `, ${st.roomType}` : ''}, room ${st.roomNumber} (floor ${st.floor}); `
        + `the digital key works until ${dateTimeText(st.keyValidUntil, zone, today)}; Wi-Fi ${st.wifi?.ssid}, password ${st.wifi?.password} (simulated).`,
      cards: [{ type: 'checkin', stay: st }],
    };
  }
  if (event.kind === 'early_checkin_approved' || event.kind === 'early_checkin_declined') {
    const r = event.request;
    const when = formatDate(r.date, today);
    return {
      // The request's note is the line for the guest: "The hotel confirmed check-in at 12:00 PM" / "The hotel is full that day …".
      text: r.note,
      modelText: event.kind === 'early_checkin_approved'
        ? `The hotel confirmed early check-in for the user: ${r.hotel?.name || 'the hotel'}, ${when} at ${formatTime(r.arrivalTime)} (simulated).`
        : `The hotel declined the user's early check-in: ${r.hotel?.name || 'the hotel'} is full on ${when}, so check-in is at ${formatTime(STANDARD_CHECKIN)} as usual (simulated); the user can leave bags at the front desk.`,
      cards: [{ type: 'early_checkin', request: r }],
    };
  }
  const r = event.review;
  return {
    text: 'The hotel replied to your review',
    modelText: `The hotel replied to the user's review of ${r.hotel?.name || 'the hotel'} (${r.rating} star${r.rating === 1 ? '' : 's'}): ${quoted(r.reply?.text, 120)} (simulated).`,
    cards: [{ type: 'review_draft', review: r }],
  };
}

// Stay cards that hold one request, by the field it sits in; replays show each with its status as of now.
const STAY_CARD_FIELDS = Object.freeze({
  ride_quote: 'ride', ride: 'ride', early_checkin: 'request', service: 'ticket', dining: 'reservation', wakeup: 'call',
  receipt: 'receipt', extension_quote: 'extension', review_draft: 'review',
});

// Defense in depth: whatever a tool put in a card, the browser never gets a userId or a full phone.
function sanitizeCard(card) {
  if (!card || typeof card !== 'object') return card;
  switch (card.type) {
    case 'booking_quote':
      return card.quote ? { ...card, quote: toPublicQuote(card.quote) } : card;
    case 'order':
    case 'cancel_preview':
      return card.order ? { ...card, order: toPublicOrder(card.order) } : card;
    case 'orders':
      return Array.isArray(card.orders) ? { ...card, orders: card.orders.map(toPublicOrder) } : card;
    default:
      return card;
  }
}

function publicProfile(p) {
  const phone = typeof p?.contactPhone === 'string' ? p.contactPhone : '';
  const prefs = p?.preferences;
  const text = (v) => (typeof v === 'string' ? v : '');
  return {
    firstName: text(p?.firstName),
    lastName: text(p?.lastName),
    email: text(p?.email),
    contactPhone: phone ? maskPhone(phone) : '',
    hasPhone: Boolean(phone),
    preferences: Array.isArray(prefs) ? prefs.filter((x) => typeof x === 'string').join(', ') : text(prefs),
    updatedAt: p?.updatedAt || null,
  };
}

/** A name part from the form: undefined = unchanged, '' = delete, else a usable first or last name. */
function nameField(v) {
  if (v === undefined) return undefined;
  if (v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_name', NAME_MESSAGE);
  const name = cleanName(v);
  if (name && namePartProblem(name)) throw new HttpError(400, 'invalid_name', NAME_MESSAGE);
  return name;
}

/** PUT /api/profile: any subset of the fields; omitted = unchanged, null (or '') = delete. */
function parseProfilePatch(body) {
  const patch = {};
  const first = nameField(body.firstName);
  const last = nameField(body.lastName);
  if (first !== undefined) patch.firstName = first;
  if (last !== undefined) patch.lastName = last;
  if (body.email !== undefined) {
    if (body.email === null || body.email === '') patch.email = '';
    else {
      const email = typeof body.email === 'string' ? normalizeEmail(body.email) : null;
      if (!email) throw new HttpError(400, 'invalid_email', EMAIL_MESSAGE);
      patch.email = email;
    }
  }
  // A masked number echoed back from the form ('***-***-0123') means "unchanged".
  if (body.contactPhone !== undefined && !(typeof body.contactPhone === 'string' && body.contactPhone.includes('*'))) {
    if (body.contactPhone === null || body.contactPhone === '') {
      patch.contactPhone = '';
    } else {
      const phone = typeof body.contactPhone === 'string' ? normalizePhone(body.contactPhone) : null;
      if (!phone) throw new HttpError(400, 'invalid_phone', PHONE_MESSAGE);
      patch.contactPhone = phone;
    }
  }
  if (body.preferences !== undefined && body.preferences !== null) {
    const raw = Array.isArray(body.preferences)
      ? body.preferences.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).join(', ')
      : typeof body.preferences === 'string' ? body.preferences.trim() : null;
    if (raw === null) throw new HttpError(400, 'invalid_preferences', 'Stay preferences need to be text');
    if (raw.length > MAX_PREFERENCES_CHARS) throw new HttpError(400, 'invalid_preferences', `Stay preferences can be up to ${MAX_PREFERENCES_CHARS} characters`);
    patch.preferences = raw;
  } else if (body.preferences === null) {
    patch.preferences = '';
  }
  return patch;
}

function notConfiguredText(llmConfig = {}) {
  const provider = llmConfig.provider || 'the provider';
  const keyEnv = llmConfig.keyEnv || PROVIDERS?.[llmConfig.provider]?.keyEnv || 'LLM_API_KEY';
  return [
    "I'm not connected to a language model yet, so I can't look up hotels or book anything for now.",
    '',
    'Add an API key to the `.env` file on the server (copy `.env.example` to `.env`), for example:',
    `- \`LLM_PROVIDER=${provider}\``,
    `- \`${keyEnv}=your API key\``,
    '',
    'Save it and restart the server. To try it without a key, run `npm run demo` for the scripted demo.',
  ].join('\n');
}

/**
 * HTTP app: JSON API + SSE chat + static H5. Pure wiring over injected services, so tests can listen on port 0.
 *
 * @param {{ config: object, llm: { chat: Function } | null, hotels: object, places: object, bookings: object,
 *   stays?: object, merchant?: object, webSearch?: { enabled: boolean }, store: { collection(name: string) }, clock?: { now: () => Date },
 *   tools?: object, profiles?: { get(userId), save(userId, patch) }, logger?: Pick<Console, 'info'|'warn'|'error'> }} deps
 *   stays defaults to a stay service over the same store, bookings and hotels; merchant (the hotel's console,
 *   /api/merchant/*) to a merchant service over those.
 * @returns {{ server: import('node:http').Server, handler: (req, res) => Promise<void>, close: (opts?: { graceMs?: number }) => Promise<void> }}
 */
export function createApp(deps) {
  const {
    config, llm = null, hotels, places, bookings, webSearch = { enabled: false }, store,
    clock = systemClock, logger = console, live = null, rides = null,
  } = deps;
  if (!config || !store || !bookings) throw new Error('createApp: config, store and bookings are required');

  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const appName = config.appName || DEFAULTS.appName;
  // The zone of a request without a valid X-Time-Zone header (the app shells may build config without one).
  const defaultZone = resolveTimeZone(config.timeZone, DEFAULT_TIME_ZONE);
  const profiles = deps.profiles ?? createProfileRepo(store, { clock });
  // `stays: null` / `merchant: null` switch them off (live hotels: nobody can send towels to a real hotel).
  const stays = Object.hasOwn(deps, 'stays') ? deps.stays : (hotels ? createStayService({ store, bookings, hotels, clock }) : null);
  const merchant = Object.hasOwn(deps, 'merchant') ? deps.merchant : (stays && hotels ? createMerchantService({ store, bookings, stays, hotels, clock }) : null);
  const tools = deps.tools ?? createTools({
    hotels, places, bookings, stays, webSearch, profiles, clock, rides,
    logger: (err) => logger.error(`[tools] ${err?.stack || err}`),
  });
  const securityHeaders = live ? { ...SECURITY_HEADERS, 'Content-Security-Policy': LIVE_CSP } : SECURITY_HEADERS;
  // The hotel's console: open (this computer only, or tests), behind a password, or off (a public server
  // without MERCHANT_PASSWORD). Sign-ins last until the server restarts.
  const merchantPassword = typeof config.merchantPassword === 'string' ? config.merchantPassword : '';
  const merchantAccess = config.merchantAccess || (merchantPassword ? 'password' : 'open');
  const consoleTokens = new Map();
  // Nana's turns today, server-wide (AI_TURNS_PER_DAY; 0 = no cap): one more brake on the AI bill.
  const aiDay = { date: '', turns: 0 };
  const sessions = store.collection('sessions');
  const serveStatic = createStaticHandler({ root: config.publicDir || path.join(ROOT_DIR, 'public') });
  const nowMs = () => clock.now().getTime();
  const limiter = createRateLimiter({ max: limits.chatTurnsPerWindow, windowMs: limits.rateWindowMs, now: nowMs });
  // Console password tries per client address.
  const loginLimiter = createRateLimiter({ max: 10, windowMs: limits.rateWindowMs, now: nowMs });
  const ipLimiter = limits.writesPerIpPerWindow > 0
    ? createRateLimiter({ max: limits.writesPerIpPerWindow, windowMs: limits.rateWindowMs, now: nowMs })
    : null;
  const busy = new Set();
  /** sessionId → { ac, done, userId, snapshotted, notices } for each running turn. */
  const activeTurns = new Map();
  const llmReady = () => Boolean(llm && typeof llm.chat === 'function') && config.llm?.configured !== false;
  const nowIso = () => clock.now().toISOString();
  // Coverage is static; the prompt lists it so the model only suggests cities that have data.
  const cities = !live && typeof hotels?.listCities === 'function' ? hotels.listCities() : undefined;

  /** The user's IANA time zone: a valid X-Time-Zone header, else the configured default (America/New_York). */
  function requestZone(req) {
    const raw = req?.headers?.['x-time-zone'];
    return (typeof raw === 'string' && canonicalTimeZone(raw)) || defaultZone;
  }

  /** The user's date (YYYY-MM-DD) for a request: it decides whether dates in a notice need their year. */
  function userToday(req) {
    return todayIn(requestZone(req), clock.now());
  }

  // Abandoned empty sessions (e.g. left by a flood of POST /api/sessions) should not outlive a restart.
  const staleBefore = nowMs() - EMPTY_SESSION_TTL_MS;
  for (const s of sessions.values()) {
    if (s?.id && !s.display?.length && !s.messages?.length && Date.parse(s.updatedAt) < staleBefore) sessions.delete(s.id);
  }

  // ---- sessions -------------------------------------------------------------------------------

  function createSession(userId) {
    const t = nowIso();
    const session = { id: newId('S'), userId, createdAt: t, updatedAt: t, messages: [], display: [] };
    sessions.set(session.id, session);
    // Bounded retention per user; a session with a turn running is never dropped mid-turn.
    const others = sessions.find((s) => s.userId === userId && s.id !== session.id && !busy.has(s.id));
    const excess = others.length - (limits.maxSessionsPerUser - 1);
    if (excess > 0) {
      others.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      for (const old of others.slice(0, excess)) sessions.delete(old.id);
    }
    return session;
  }

  /** Per client address, on top of the per-user limits (the user id is whatever the client sends). */
  function throttleWrites(req) {
    const quota = ipLimiter?.take(clientAddress(req, config.trustProxy));
    if (quota && !quota.ok) {
      // Usually many people behind one NAT, not this user's doing.
      throw new HttpError(429, 'rate_limited', 'A lot of people on this network are using the app right now; please try again in a moment', { retryAfterSec: quota.retryAfterSec });
    }
  }

  function ownSession(userId, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const s = sessions.get(id);
    return s && s.userId === userId ? s : null;
  }

  /** Read-modify-write on the stored record (synchronous, so concurrent requests cannot interleave). */
  function updateSession(id, fn) {
    const current = sessions.get(id);
    if (!current) return null;
    const draft = { ...current, messages: [...(current.messages || [])], display: [...(current.display || [])] };
    fn(draft);
    draft.messages = trimHistory(draft.messages, MAX_STORED_MESSAGES);
    if (draft.display.length > MAX_DISPLAY_ITEMS) draft.display = draft.display.slice(-MAX_DISPLAY_ITEMS);
    draft.updatedAt = nowIso();
    sessions.set(id, draft);
    return draft;
  }

  async function refreshCard(userId, card) {
    try {
      if (stays && Object.hasOwn(STAY_CARD_FIELDS, card?.type)) {
        const field = STAY_CARD_FIELDS[card.type];
        const fresh = card[field]?.id ? await stays.getRequest(userId, card[field].id) : null;
        return fresh ? { ...card, [field]: fresh } : card;
      }
      switch (card?.type) {
        case 'booking_quote': {
          const q = card.quote?.id ? await bookings.getQuote(userId, card.quote.id) : null;
          if (!q) return card;
          // A confirmed quote may still wait for payment (the live card form), or have timed out unpaid.
          const order = q.orderId ? await bookings.getOrder(userId, q.orderId) : null;
          return { ...card, quote: { ...toPublicQuote(q), ...(order ? { orderStatus: order.status } : {}) } };
        }
        case 'order': {
          const o = card.order?.id ? await bookings.getOrder(userId, card.order.id) : null;
          return o ? { ...card, order: toPublicOrder(o) } : card;
        }
        case 'orders': {
          if (!Array.isArray(card.orders)) return card;
          const orders = await Promise.all(card.orders.map(async (o) => {
            const fresh = o?.id ? await bookings.getOrder(userId, o.id) : null;
            return fresh ? toPublicOrder(fresh) : o;
          }));
          return { ...card, orders };
        }
        case 'cancel_preview': {
          const orderId = card.orderId || card.order?.id;
          if (!orderId) return card;
          const p = await bookings.previewCancellation({ userId, orderId });
          return { ...card, orderId, penalty: p.penalty, refund: p.refund, policyText: p.policyText, cancellable: p.cancellable, order: toPublicOrder(p.order) };
        }
        case 'checkin': {
          const stay = stays && card.stay?.orderId ? await stays.getStay(userId, card.stay.orderId) : null;
          return stay ? { ...card, stay } : card;
        }
        default:
          return card;
      }
    } catch {
      return card;
    }
  }

  async function displayItems(userId, session) {
    return Promise.all((session.display || []).map(async (item) => {
      // Every notice carries its kind (docs/US-CONTRACT.md §6); the order id only pairs a placed order with its payment.
      const { orderId, ...shown } = item;
      if (!Array.isArray(item.cards) || !item.cards.length) return shown;
      return { ...shown, cards: await Promise.all(item.cards.map((c) => refreshCard(userId, c))) };
    }));
  }

  /**
   * Adds one notice to a session draft: the display item and the model's history message. An order notice
   * carries `order`; a stay notice its own `cards` and a fuller `modelText` for the model.
   */
  function applyNotice(s, notice) {
    const { kind, order, text, at } = notice;
    const item = order
      ? { role: 'notice', kind, text, cards: [{ type: 'order', order: toPublicOrder(order) }], at, orderId: order.id }
      : { role: 'notice', kind, text, at, cards: (notice.cards || []).map(sanitizeCard) };
    const lastItem = s.display[s.display.length - 1];
    // confirm + pay arrive back to back from one payment sheet; replaying both would show the order twice.
    const paidRightAfterPlaced = order && kind === 'paid' && lastItem?.role === 'notice' && lastItem.orderId === order.id && lastItem.kind === 'pending';
    if (paidRightAfterPlaced) s.display[s.display.length - 1] = item;
    else s.display.push(item);

    const modelText = notice.modelText ?? text;
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.startsWith(NOTICE_PREFIX)) {
      s.messages[s.messages.length - 1] = { ...lastMsg, content: `${lastMsg.content}\n${modelText}` };
    } else {
      s.messages.push({ role: 'user', content: `${NOTICE_PREFIX} ${modelText}` });
    }
  }

  function deliverNotice(userId, sessionId, notice) {
    if (!sessionId || !ownSession(userId, sessionId)) return;
    const turn = activeTurns.get(sessionId);
    // That turn already read its history: storing the notice now would put it before the turn's own
    // messages, so the model would read "paid" and then its older "please pay". It is added after the turn.
    if (turn?.snapshotted) {
      turn.notices.push(notice);
      return;
    }
    updateSession(sessionId, (s) => applyNotice(s, notice));
  }

  /** After confirm/pay/cancel: tell the user (display) and the model (history) what happened. */
  async function appendOrderNotice(userId, kind, order, today) {
    let sessionId = order.sessionId;
    if (!sessionId && order.quoteId) sessionId = (await bookings.getQuote(userId, order.quoteId))?.sessionId;
    deliverNotice(userId, sessionId, { kind, order, ...orderNotice(kind, order, today), at: nowIso() });
  }

  // ---- chat -----------------------------------------------------------------------------------

  async function runTurn({ userId, session, message, sse, signal, turn, timeZone }) {
    const collected = { text: '', cards: [] };
    const emit = (event, data) => {
      if (!AGENT_EVENTS.has(event)) return;
      let payload = data ?? {};
      if (event === 'retract') {
        // The provider flagged this turn: nothing it showed so far may stay, live or in the fallback display.
        collected.text = '';
        collected.cards = [];
        payload = {};
      }
      if (event === 'delta' && typeof payload.text === 'string') collected.text += payload.text;
      if (event === 'card') {
        payload = { ...payload, card: sanitizeCard(payload.card) };
        if (payload.card) collected.cards.push(payload.card);
      }
      sse.send(event, payload);
    };
    let result = null;
    let failed = false;
    // The agent masks phone numbers typed in chat and records masked → full here (C9); tools read it via ctx.
    const agentSession = { id: session.id, userId, messages: [], phoneVault: {} };
    try {
      const profile = await profiles.get(userId);
      const systemPrompt = buildSystemPrompt({
        appName,
        now: clock.now(),
        timeZone,
        profile: profile ? publicProfile(profile) : null,
        features: {
          webSearch: Boolean(webSearch?.enabled),
          demoHotels: !live,
          liveHotels: live ? { sandbox: Boolean(live.sandbox) } : null,
          stays: Boolean(stays),
          places: Boolean(places),
          rides: Boolean(rides),
        },
        cities,
      });
      // Re-read: an order notice may have landed while the prompt was being built.
      const stored = sessions.get(session.id);
      agentSession.messages = [...(stored?.messages || [])];
      agentSession.phoneVault = cleanVault(stored?.phoneVault);
      // From here on, order notices wait until this turn's messages are stored (see appendOrderNotice).
      if (turn) turn.snapshotted = true;
      result = await runAgentTurn({
        llm,
        tools,
        session: agentSession,
        userText: message,
        ctx: { userId, sessionId: session.id, phoneVault: agentSession.phoneVault, timeZone },
        systemPrompt,
        emit,
        signal,
        now: () => clock.now(),
        logger: (err) => logger.error(`[agent] ${err?.stack || err}`),
      });
      if (result?.aborted) logger.info(`[chat] turn stopped (session ${session.id})`);
    } catch (err) {
      if (signal.aborted) logger.info(`[chat] client went away, turn stopped (session ${session.id})`);
      else {
        failed = true;
        logger.error(`[chat] turn failed: ${err?.stack || err}`);
        sse.send('error', { message: MSG_INTERNAL });
      }
    }

    const at = nowIso();
    const agentDisplay = Array.isArray(result?.display) ? result.display : null;
    const fallback = [{ role: 'assistant', text: collected.text, cards: collected.cards }];
    // So a reload shows what the live view showed.
    if (failed) fallback.push({ role: 'notice', text: `(Reply interrupted: ${MSG_INTERNAL})` });
    const display = (agentDisplay || fallback)
      .filter((d) => d && (d.text || (Array.isArray(d.cards) && d.cards.length)))
      .map((d) => ({
        role: d.role === 'notice' ? 'notice' : 'assistant',
        text: typeof d.text === 'string' ? d.text : '',
        cards: Array.isArray(d.cards) ? d.cards.map(sanitizeCard) : [],
        at: d.at || at,
      }));
    // Persisted even when the client went away or the turn failed (C7): the agent returns what completed.
    const newMessages = Array.isArray(result?.messages) ? result.messages : [];
    const vault = cleanVault(agentSession.phoneVault);
    updateSession(session.id, (s) => {
      s.messages.push(...newMessages);
      s.display.push(...display);
      if (Object.keys(vault).length) s.phoneVault = cleanVault({ ...s.phoneVault, ...vault });
    });
  }

  function turnsOf(userId) {
    let n = 0;
    for (const t of activeTurns.values()) if (t.userId === userId) n++;
    return n;
  }

  async function handleChat(req, res, userId) {
    const body = await readJsonBody(req, limits.maxBodyBytes);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new HttpError(400, 'invalid_message', 'The message is empty');
    if (message.length > limits.maxMessageChars) {
      throw new HttpError(400, 'invalid_message', `The message is too long; keep it under ${limits.maxMessageChars} characters`);
    }
    if (activeTurns.size >= limits.maxConcurrentTurns) {
      throw new HttpError(503, 'server_busy', 'Lots of people are chatting right now; please try again in a moment', { retryAfterSec: 5 });
    }
    // Every check runs before a new session is created, so a rejected request stores nothing.
    let session = null;
    if (!(body.sessionId === undefined || body.sessionId === null || body.sessionId === '')) {
      session = ownSession(userId, body.sessionId);
      if (!session) throw new HttpError(404, 'session_not_found', "This chat doesn't exist anymore; please start a new one");
      if (busy.has(session.id)) throw new HttpError(409, 'busy', "I'm still answering your last message; send this one in a moment");
    }
    if (turnsOf(userId) >= limits.maxTurnsPerUser) {
      throw new HttpError(409, 'busy', "I'm still answering you in another chat; send this once that reply is done");
    }
    // Each bucket is charged only for an accepted turn: the user's quota is checked first, so a user past it
    // cannot drain the shared address bucket, and an address rejection does not use up the user's turns.
    const quota = limiter.check(userId);
    if (!quota.ok) {
      throw new HttpError(429, 'rate_limited', "That's a lot of messages in a short time; please take a break for a few minutes", { retryAfterSec: quota.retryAfterSec });
    }
    const cap = limits.aiTurnsPerDay || 0;
    if (cap > 0 && llmReady()) {
      const today = new Date(nowMs()).toISOString().slice(0, 10);
      if (aiDay.date !== today) Object.assign(aiDay, { date: today, turns: 0 });
      if (aiDay.turns >= cap) throw new HttpError(429, 'daily_limit', "Nana has talked a lot today and is resting. Please come back tomorrow.");
    }
    throttleWrites(req);
    limiter.take(userId);
    if (cap > 0) aiDay.turns += 1;
    session ??= createSession(userId);

    const sse = createSseWriter(res);
    const ac = new AbortController();
    let finished = false;
    let settle;
    const turn = { ac, done: new Promise((r) => { settle = r; }), userId, snapshotted: false, notices: [] };
    busy.add(session.id);
    activeTurns.set(session.id, turn);
    sse.onClose(() => {
      if (!finished) ac.abort();
    });
    try {
      sse.send('session', { sessionId: session.id });
      updateSession(session.id, (s) => {
        s.display.push({ role: 'user', text: message, at: nowIso() });
      });
      if (!llmReady()) {
        const text = notConfiguredText(config.llm);
        sse.send('delta', { text });
        updateSession(session.id, (s) => {
          s.display.push({ role: 'assistant', text, cards: [], at: nowIso() });
        });
      } else {
        await runTurn({ userId, session, message, sse, signal: ac.signal, turn, timeZone: requestZone(req) });
      }
    } finally {
      finished = true;
      busy.delete(session.id);
      activeTurns.delete(session.id);
      // Same tick as the delete: a notice either queued above or goes straight in, never neither.
      if (turn.notices.length) {
        try {
          updateSession(session.id, (s) => {
            for (const n of turn.notices) applyNotice(s, n);
          });
        } catch (err) {
          logger.error(`[chat] could not store a notice: ${err?.stack || err}`);
        }
      }
      sse.send('done', {});
      sse.end();
      settle();
    }
  }

  // ---- routes ---------------------------------------------------------------------------------

  async function flushStore() {
    try {
      await store.flush?.();
    } catch (err) {
      logger.error(`[store] save failed, will retry: ${err?.message || err}`);
    }
  }

  async function orderAction(req, userId, kind, run, before) {
    const prevStatus = await before();
    const order = await run();
    if (order && order.status !== prevStatus) await appendOrderNotice(userId, kind, order, userToday(req));
    // The user is about to see "placed", "booked" or "cancelled"; don't leave that inside the store's write delay.
    await flushStore();
    return { order: toPublicOrder(order) };
  }

  function requireStays() {
    if (!stays) throw new HttpError(404, 'not_found', 'No such API');
    return stays;
  }

  /**
   * A user's tap on a stay card (Confirm ride / Confirm extension / Post review): `run` returns { ride } /
   * { extension, order } / { review }; the first change of status also leaves a notice in the session the card came from.
   */
  async function stayAction(req, userId, id, kind, run) {
    const s = requireStays();
    const before = (await s.getRequest(userId, id))?.status ?? null;
    const out = await run(s);
    const subject = out.ride || out.extension || out.review;
    if (subject && subject.status !== before) {
      const notice = stayNotice(kind, out, userToday(req));
      deliverNotice(userId, await s.sessionOf(userId, id), { kind, ...notice, at: nowIso() });
    }
    await flushStore();
    return out;
  }

  function requireMerchant() {
    if (!merchant || merchantAccess === 'off') throw new HttpError(404, 'not_found', 'No such API');
    return merchant;
  }

  function cookieOf(req, name) {
    for (const part of String(req.headers?.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  /** Same-length strings compared in constant time (no early exit on the first difference). */
  function sameSecret(a, b) {
    const x = String(a);
    const y = String(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
  }

  function consoleSignedIn(req) {
    if (merchantAccess !== 'password') return true;
    const token = cookieOf(req, CONSOLE_COOKIE);
    const t = token && consoleTokens.get(token);
    if (!t) return false;
    if (nowMs() > t) {
      consoleTokens.delete(token);
      return false;
    }
    return true;
  }

  /** The console's routes: 404 when off, 401 (sign in) when the password is set and missing. */
  function guardConsole(req) {
    requireMerchant();
    if (!consoleSignedIn(req)) throw new HttpError(401, 'login_required', 'Sign in to the hotel console');
  }

  /** The hotel did something a NanaHotel guest should hear about (merchant.js event): a notice in that guest's chat. */
  function deliverHotelEvent(event) {
    if (!event?.userId || !event.sessionId) return;
    // The console has no user zone; the guest's stay is at this hotel, so its date decides the year.
    const zone = resolveTimeZone(event.stay?.timeZone || event.request?.timeZone, defaultZone);
    deliverNotice(event.userId, event.sessionId, { kind: event.kind, ...hotelNotice(event, todayIn(zone, clock.now())), at: nowIso() });
  }

  /** A console action: the hotel's change is stored, the guest it touches told, and the store flushed. */
  async function merchantWrite(req, res, run, status = 200) {
    const body = await readJsonBody(req, limits.maxBodyBytes);
    throttleWrites(req);
    const { event, ...out } = await run(requireMerchant(), body);
    deliverHotelEvent(event);
    await flushStore();
    sendJson(res, status, out);
  }

  // The hotel's console (docs/MERCHANT.md): no X-User-Id, it is the hotel's side and never shows a guest's id.
  const merchantRoutes = [
    ['GET', /^\/api\/merchant\/hotels$/, async ({ res }) => sendJson(res, 200, requireMerchant().listHotels())],
    ['GET', /^\/api\/merchant\/([^/]+)\/overview$/, async ({ res, params, query }) => {
      sendJson(res, 200, requireMerchant().overview(params[0], { days: query.get('days') ?? undefined }));
    }],
    ['GET', /^\/api\/merchant\/([^/]+)\/rooms$/, async ({ res, params, query }) => {
      sendJson(res, 200, requireMerchant().rooms(params[0], { date: query.get('date') ?? undefined }));
    }],
    ['POST', /^\/api\/merchant\/([^/]+)\/rooms\/([^/]+)$/, async ({ req, res, params: [hotelId, number] }) => {
      await merchantWrite(req, res, (m, body) => m.roomAction(hotelId, number, body));
    }],
    ['GET', /^\/api\/merchant\/([^/]+)\/tickets$/, async ({ res, params }) => sendJson(res, 200, requireMerchant().tickets(params[0]))],
    ['POST', /^\/api\/merchant\/([^/]+)\/tickets\/([^/]+)$/, async ({ req, res, params: [hotelId, id] }) => {
      await merchantWrite(req, res, (m, body) => m.ticketAction(hotelId, id, body));
    }],
    ['GET', /^\/api\/merchant\/([^/]+)\/reviews$/, async ({ res, params }) => sendJson(res, 200, requireMerchant().reviews(params[0]))],
    ['POST', /^\/api\/merchant\/([^/]+)\/reviews\/([^/]+)\/reply$/, async ({ req, res, params: [hotelId, id] }) => {
      await merchantWrite(req, res, (m, body) => m.replyReview(hotelId, id, body));
    }],
    ['POST', /^\/api\/merchant\/([^/]+)\/reviews\/([^/]+)\/draft-reply$/, async ({ req, res, params: [hotelId, id] }) => {
      await merchantWrite(req, res, (m) => m.draftReply(hotelId, id));
    }],
    ['GET', /^\/api\/merchant\/([^/]+)\/promotions$/, async ({ res, params }) => sendJson(res, 200, requireMerchant().listPromotions(params[0]))],
    ['POST', /^\/api\/merchant\/([^/]+)\/promotions$/, async ({ req, res, params: [hotelId] }) => {
      await merchantWrite(req, res, (m, body) => m.createPromotion(hotelId, body), 201);
    }],
    ['POST', /^\/api\/merchant\/([^/]+)\/promotions\/([^/]+)$/, async ({ req, res, params: [hotelId, id] }) => {
      await merchantWrite(req, res, (m, body) => m.setPromotion(hotelId, id, body));
    }],
  ].map(([method, re, fn]) => [method, re, async (ctx) => {
    guardConsole(ctx.req);
    await fn(ctx);
  }, { auth: false }]);

  const routes = [
    ...merchantRoutes,
    ['POST', /^\/api\/merchant-login$/, async ({ req, res }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      requireMerchant();
      throttleWrites(req);
      if (merchantAccess === 'password') {
        const quota = loginLimiter.take(clientAddress(req, config.trustProxy));
        if (!quota.ok) throw new HttpError(429, 'rate_limited', 'Too many tries; wait a few minutes and try again', { retryAfterSec: quota.retryAfterSec });
        if (typeof body.password !== 'string' || !merchantPassword || !sameSecret(body.password, merchantPassword)) {
          throw new HttpError(401, 'wrong_password', "That password isn't right");
        }
        const token = `${newId('C')}${newId()}`;
        if (consoleTokens.size > 500) consoleTokens.clear();
        consoleTokens.set(token, nowMs() + CONSOLE_SESSION_MS);
        res.setHeader('Set-Cookie', `${CONSOLE_COOKIE}=${token}; Path=/api/merchant; HttpOnly; SameSite=Strict; Max-Age=${CONSOLE_SESSION_MS / 1000}${req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted ? '; Secure' : ''}`);
      }
      sendJson(res, 200, { ok: true });
    }, { auth: false }],
    ['GET', /^\/api\/health$/, async (ctx) => sendJson(ctx.res, 200, {
      ok: true,
      appName,
      llm: { provider: config.llm?.provider || null, model: config.llm?.model || null, configured: llmReady() },
      hotels: live ? 'liteapi' : 'sim',
      webSearch: Boolean(webSearch?.enabled),
      defaultTimeZone: defaultZone,
      live: live ? {
        hotels: 'liteapi',
        sandbox: Boolean(live.sandbox),
        payments: 'liteapi',
        email: Boolean(live.email),
        places: Boolean(live.places),
        stays: Boolean(stays),
      } : null,
      console: merchant ? merchantAccess : 'off',
    }), { auth: false }],

    ['POST', /^\/api\/sessions$/, async ({ req, res, userId }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      throttleWrites(req);
      const session = createSession(userId);
      sendJson(res, 201, { sessionId: session.id });
    }],

    ['GET', /^\/api\/sessions\/([^/]+)$/, async ({ res, userId, params }) => {
      const session = ownSession(userId, params[0]);
      if (!session) throw new HttpError(404, 'session_not_found', "This chat doesn't exist anymore");
      sendJson(res, 200, { sessionId: session.id, items: await displayItems(userId, session) });
    }],

    ['POST', /^\/api\/chat$/, async ({ req, res, userId }) => handleChat(req, res, userId)],

    ['POST', /^\/api\/quotes\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [quoteId] = params;
      const out = await orderAction(req, userId, 'pending',
        () => bookings.confirmQuote({ userId, quoteId }),
        async () => {
          const q = await bookings.getQuote(userId, quoteId);
          if (q?.status !== 'confirmed' || !q.orderId) return null;
          // Re-confirming returns the existing order; only a status change deserves a notice.
          return (await bookings.getOrder(userId, q.orderId))?.status ?? null;
        });
      sendJson(res, 200, out);
    }],

    ['POST', /^\/api\/orders\/([^/]+)\/pay$/, async ({ req, res, userId, params }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const [orderId] = params;
      const out = await orderAction(req, userId, 'paid',
        () => bookings.payOrder({ userId, orderId, method: body.method }),
        async () => (await bookings.getOrder(userId, orderId))?.status ?? null);
      sendJson(res, 200, out);
    }],

    ['POST', /^\/api\/orders\/([^/]+)\/cancel$/, async ({ req, res, userId, params }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const [orderId] = params;
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      const out = await orderAction(req, userId, 'cancelled',
        () => bookings.cancelOrder({ userId, orderId, reason }),
        async () => (await bookings.getOrder(userId, orderId))?.status ?? null);
      sendJson(res, 200, out);
    }],

    // LiteAPI's card form for one order (live hotels): its client secret goes to the order's owner only.
    ['GET', /^\/api\/orders\/([^/]+)\/payment$/, async ({ res, userId, params }) => {
      if (typeof bookings.paymentSession !== 'function') throw new HttpError(404, 'not_found', 'No such API');
      const session = await bookings.paymentSession(userId, params[0]);
      sendJson(res, 200, session);
    }],

    ['GET', /^\/api\/orders\/([^/]+)\/cancel-preview$/, async ({ res, userId, params }) => {
      const p = await bookings.previewCancellation({ userId, orderId: params[0] });
      sendJson(res, 200, {
        orderId: p.order.id, penalty: p.penalty, refund: p.refund, policyText: p.policyText,
        cancellable: p.cancellable, order: toPublicOrder(p.order),
      });
    }],

    ['GET', /^\/api\/orders$/, async ({ res, userId }) => {
      const orders = await bookings.listOrders(userId);
      sendJson(res, 200, { orders: orders.map(toPublicOrder) });
    }],

    ['GET', /^\/api\/stays$/, async ({ res, userId }) => {
      if (!stays) {
        // Live hotels (no simulated stay): My trips lists the confirmed bookings that aren't over yet.
        const today = todayIn(defaultZone, clock.now());
        const orders = (await bookings.listOrders(userId)).filter((o) => o.status === 'confirmed' && o.checkOut >= today);
        orders.sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));
        sendJson(res, 200, { stays: orders.slice(0, 5).map((o) => ({ order: toPublicOrder(o), stay: null, requests: [] })) });
        return;
      }
      const list = await requireStays().listStays(userId);
      sendJson(res, 200, { stays: list.map((x) => ({ ...x, order: toPublicOrder(x.order) })) });
    }],

    ['POST', /^\/api\/rides\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [rideId] = params;
      const { ride } = await stayAction(req, userId, rideId, 'ride_confirmed', async (s) => ({ ride: await s.confirmRide({ userId, rideId }) }));
      sendJson(res, 200, { ride });
    }],

    ['POST', /^\/api\/extensions\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const [extensionId] = params;
      const { extension, order } = await stayAction(req, userId, extensionId, 'extended', (s) => s.confirmExtension({ userId, extensionId, method: body.method }));
      sendJson(res, 200, { extension, order: toPublicOrder(order) });
    }],

    ['POST', /^\/api\/reviews\/([^/]+)\/publish$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [reviewId] = params;
      const { review } = await stayAction(req, userId, reviewId, 'review_published', async (s) => ({ review: await s.publishReview({ userId, reviewId }) }));
      sendJson(res, 200, { review });
    }],

    ['GET', /^\/api\/profile$/, async ({ res, userId }) => {
      sendJson(res, 200, { profile: publicProfile(await profiles.get(userId)) });
    }],

    ['PUT', /^\/api\/profile$/, async ({ req, res, userId }) => {
      const patch = parseProfilePatch(await readJsonBody(req, limits.maxBodyBytes));
      // Merge here so omitted fields (e.g. a blank phone input) keep their saved values.
      const current = (await profiles.get(userId)) || {};
      const merged = { ...current, ...patch };
      // A name is a first and a last name, or none at all.
      if (Boolean(merged.firstName) !== Boolean(merged.lastName)) throw new HttpError(400, 'invalid_name', NAME_MESSAGE);
      throttleWrites(req);
      const saved = await profiles.save(userId, merged);
      sendJson(res, 200, { profile: publicProfile(saved ?? (await profiles.get(userId))) });
    }],
  ];

  function identify(req) {
    const raw = req.headers['x-user-id'];
    if (typeof raw !== 'string' || !isUuid(raw.trim())) {
      throw new HttpError(401, 'unauthorized', 'Your user id is missing or invalid; please reload the page and try again');
    }
    return raw.trim().toLowerCase();
  }

  async function handleApi(req, res, rawPath) {
    const matches = routes.filter(([, re]) => re.test(rawPath));
    if (!matches.length) throw new HttpError(404, 'not_found', 'No such API');
    const route = matches.find(([method]) => method === req.method);
    if (!route) {
      const allow = [...new Set(matches.map(([m]) => m))].join(', ');
      throw new HttpError(405, 'method_not_allowed', "That method isn't supported here", { allow });
    }
    const [, re, fn, opts = {}] = route;
    const userId = opts.auth === false ? null : identify(req);
    let query;
    try {
      query = new URL(String(req.url || '/'), 'http://localhost').searchParams;
    } catch {
      query = new URLSearchParams();
    }
    const params = re.exec(rawPath).slice(1).map((p) => {
      let id;
      try {
        id = decodeURIComponent(p);
      } catch {
        id = '';
      }
      if (!ID_RE.test(id)) throw new HttpError(404, 'not_found', "That doesn't exist or has expired");
      return id;
    });
    await fn({ req, res, userId, params, query });
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    const rawPath = String(req.url || '/').split('?')[0];
    res.once('close', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      // Paths carry only random ids; no query strings, bodies, user ids or phone numbers are logged.
      const shown = rawPath.replace(/[^\x21-\x7e]/g, '?').slice(0, 120);
      logger.info(`[http] ${req.method} ${shown} ${res.statusCode}${res.writableFinished ? '' : ' (aborted)'} ${ms}ms`);
    });
    try {
      if (!rawPath.startsWith('/')) throw new HttpError(400, 'bad_request', 'Invalid request path');
      if (rawPath === '/api' || rawPath.startsWith('/api/')) {
        await handleApi(req, res, rawPath);
        return;
      }
      // The hotel's console: its page uses paths relative to the site root (public/…), like '/'.
      if (rawPath === '/merchant' && (await serveStatic(req, res, '/public/merchant.html'))) return;
      if (rawPath === '/merchant/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(301, { Location: `/merchant${String(req.url || '').slice(rawPath.length)}`, 'Content-Length': 0, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (await serveStatic(req, res, rawPath)) return;
      const body = '404 Not found';
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      sendError(res, err, logger);
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => sendError(res, err, logger));
  });

  /**
   * Aborts running chat turns (their partial results are still saved) and stops the server.
   * Connections still open after `graceMs` (e.g. a client's spare keep-alive socket) are cut.
   */
  async function close({ graceMs = 1000 } = {}) {
    const pending = [...activeTurns.values()];
    for (const t of pending) t.ac.abort();
    await Promise.all(pending.map((t) => t.done));
    if (!server.listening) return;
    await new Promise((resolve) => {
      const force = setTimeout(() => server.closeAllConnections?.(), graceMs);
      force.unref?.();
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }

  return { server, handler, close };
}

/**
 * Real dependencies: JSON store under DATA_DIR (`dataDir: null` = in memory), the LLM client, optional web search,
 * and either
 *   - the demo: simulated hotels (priced with the hotels' promotions), bookings, the stay and the hotel's console; or
 *   - live hotels, when config.live has a LiteAPI key (src/live/, docs/LIVE.md): LiteAPI search, price lock, card
 *     form, booking and cancellation, Google Places for "near …", Resend for confirmations and Uber/Lyft links. The
 *     simulated stay (towels, room keys, the front desk) is off, because a real hotel never hears of it; the hotel
 *     console stays a demo over the simulated hotels.
 * Pass `llm` / `webSearch` to use those instead of building them.
 */
export async function buildDeps(config, { fetch = globalThis.fetch, clock = systemClock, logger = console, llm, webSearch } = {}) {
  const store = createJsonStore({ dir: config.dataDir ?? null, onError: (err) => logger.error(`[store] ${err.message}`) });
  await store.load();
  const supplier = createSimSupplier();
  // The hotels' own promotions discount the nights they cover wherever a price comes from (merchant.js).
  const promotions = createPromotionBook({ store, clock });
  const simHotels = createHotelService({ supplier, clock, promotions });
  const simBookings = createBookingService({ store, hotels: simHotels, clock });
  const simStays = createStayService({ store, bookings: simBookings, hotels: simHotels, clock });
  const merchant = createMerchantService({ store, bookings: simBookings, stays: simStays, hotels: simHotels, clock, promotions });
  const common = {
    config,
    store,
    merchant,
    webSearch: webSearch ?? createWebSearch({ provider: config.webSearch?.provider || 'bocha', apiKey: config.webSearch?.apiKey, fetch }),
    llm: llm !== undefined ? llm : config.llm?.configured ? createLlmClient({ ...config.llm, fetch }) : null,
    clock,
    logger,
  };
  if (config.live?.hotels?.enabled) {
    const services = createLiveServices(config.live, { fetch, clock, logger, simSupplier: supplier, appName: config.appName });
    const hotels = createLiveHotelService({ supplier: services.hotels, clock, logger });
    const bookings = createLiveBookingService({ store, hotels, supplier: services.hotels, mailer: services.email, clock, logger });
    return {
      ...common,
      hotels,
      places: null,
      bookings,
      stays: null,
      rides: { links: services.rides.links, geocoder: services.places },
      live: { sandbox: Boolean(services.hotels.sandbox), email: Boolean(services.email.enabled), places: Boolean(config.live.places?.enabled) },
    };
  }
  const places = createPlacesService({ supplier, clock, pricing: withPromotions(promotions) });
  return { ...common, hotels: simHotels, places, bookings: simBookings, stays: simStays };
}

function displayUrl(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Builds real deps, listens on config.host:config.port, and returns a `close()` that stops the server
 * and flushes the store. `llm` / `webSearch` overrides replace the real ones (the scripted demo uses this).
 * @param {{ config?: object, logger?: Console, llm?: object|null, webSearch?: object, clock?: { now: () => Date } }} [opts]
 */
export async function startServer({ config = loadConfig(), logger = console, llm, webSearch, clock } = {}) {
  const deps = await buildDeps(config, { logger, llm, webSearch, clock });
  const app = createApp(deps);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  const { port } = app.server.address();
  const url = displayUrl(config.host, port);
  let closing = null;
  const close = (opts) => {
    closing ??= (async () => {
      await app.close(opts);
      await deps.store.close();
    })();
    return closing;
  };
  return { ...app, url, port, close, store: deps.store };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  const running = await startServer({ config });
  const { llm } = config;
  console.info(`[server] ${config.appName} is running at ${running.url}`);
  console.info(`[server] LLM: ${llm.label || llm.provider} / ${llm.model}${llm.configured ? '' : ' (no API key: the chat explains how to add one)'}`);
  for (const w of llm.warnings || []) console.warn(`[config] ${w}`);
  console.info(`[server] Web search: ${config.webSearch.enabled ? 'on (Bocha)' : 'off'} · default time zone: ${config.timeZone || DEFAULT_TIME_ZONE} · data: ${config.dataDir}`);
  for (const line of describeLiveConfig(config.live)) console.info(`[live] ${line}`);
  for (const w of config.live?.warnings || []) console.warn(`[live] ${w}`);
  console.info(`[server] Hotel console: ${config.merchantAccess === 'password' ? 'at /merchant, behind MERCHANT_PASSWORD' : config.merchantAccess === 'open' ? 'at /merchant (this computer only)' : 'off (set MERCHANT_PASSWORD to use it on a public address)'}`);
  if (config.limits?.aiTurnsPerDay) console.info(`[server] AI turns per day: at most ${config.limits.aiTurnsPerDay}`);

  let exiting = false;
  const shutdown = (signal) => {
    if (exiting) return;
    exiting = true;
    console.info(`[server] got ${signal}, saving data and shutting down…`);
    running.close().then(() => process.exit(0), (err) => {
      console.error(`[server] error while shutting down: ${err?.stack || err}`);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[server] failed to start: ${err?.stack || err}`);
    process.exit(1);
  });
}
