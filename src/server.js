import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULTS, DEFAULT_LIMITS, ROOT_DIR } from './config.js';
import { createSseWriter } from './http/sse.js';
import { createStaticHandler } from './http/static.js';
import { isUuid, newId } from './util/ids.js';
import { formatDateCN, formatDateTimeCN, weekdayCN, isValidDate, todayCN } from './util/dates.js';
import { createJsonStore } from './store/json-store.js';
import { guestNameProblem } from './util/names.js';
import { createSimSupplier } from './services/hotels/sim-supplier.js';
import { createHotelService, withPromotions } from './services/hotels/index.js';
import { createPlacesService } from './services/places.js';
import {
  createBookingService, maskPhone, normalizePhone, toPublicOrder, toPublicQuote,
  ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS,
} from './services/bookings.js';
import { createStayService } from './services/stays.js';
import { createMerchantService, createPromotionBook } from './services/merchant.js';
import { createWebSearch } from './services/websearch.js';
import { PROVIDERS } from './llm/providers.js';
import { createLlmClient } from './llm/client.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { MAX_PREFERENCES_CHARS } from './agent/text.js';
import { runAgentTurn } from './agent/agent.js';
import { createTools, createProfileRepo } from './agent/tools.js';

export const CSP = [
  "default-src 'self'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'", "connect-src 'self'",
  // The animated pet runs on Rive's WebAssembly runtime (public/vendor/rive), served from this origin.
  "script-src 'self' 'wasm-unsafe-eval'",
  // Not covered by default-src: an injected <base> or <form action> would otherwise still work.
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

export const NOTICE_PREFIX = '【系统通知，非用户输入】';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_STORED_MESSAGES = 200;
const MAX_DISPLAY_ITEMS = 200;
const MAX_VAULT_ENTRIES = 20;
const EMPTY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MASKED_PHONE_RE = /^1\d{2}\*{4}\d{4}$/;
const FULL_PHONE_RE = /^1[3-9]\d{9}$/;
const AGENT_EVENTS = new Set(['status', 'delta', 'card', 'error', 'retract']);
const MSG_INTERNAL = '服务出了点问题，请稍后再试。';
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
  if (err instanceof HttpError || isClientError(err)) {
    const error = { code: err.code, message: err.message };
    if (err.details && typeof err.details === 'object') error.details = err.details;
    const headers = {};
    if (err.retryAfterSec) headers['Retry-After'] = String(err.retryAfterSec);
    if (err.allow) headers.Allow = err.allow;
    if (err.status === 413) headers.Connection = 'close';
    sendJson(res, err.status, { error }, headers);
    return;
  }
  logger.error(`[http] 未处理的错误：${err?.stack || err}`);
  sendJson(res, 500, { error: { code: 'internal', message: MSG_INTERNAL } });
}

/** Reads a JSON object body, enforcing `limit` bytes without destroying the socket mid-upload. */
function readJsonBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  const tooLarge = () => new HttpError(413, 'body_too_large', `请求内容太大了（上限 ${Math.round(limit / 1024)}KB）`);
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
        return reject(new HttpError(400, 'invalid_json', '请求内容不是有效的 JSON'));
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reject(new HttpError(400, 'invalid_json', '请求内容需要是一个 JSON 对象'));
      }
      resolve(data);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
    // A client that disconnects mid-upload never sends 'end'; settle instead of hanging.
    req.on('close', () => {
      if (!req.complete && !failed) reject(new HttpError(400, 'aborted', '请求被中断了，请重试'));
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

/** The year is written only when it differs from `ref`'s, as in the model-facing stay_text and the cards. */
function yearPrefix(date, ref) {
  return String(ref ?? '').slice(0, 4) === date.slice(0, 4) ? '' : `${date.slice(0, 4)}年`;
}

function dateWithWeekday(date, ref) {
  return isValidDate(date) ? `${yearPrefix(date, ref)}${formatDateCN(date)}（${weekdayCN(date)}）` : String(date ?? '');
}

// The check-out date is read in the check-in's year: '12月30日（周三）入住，2027年1月2日（周六）离店'.
function stayText(order, today) {
  const hotel = order.hotel?.name || '酒店';
  const room = order.room?.name ? ` ${order.room.name}` : '';
  const checkIn = dateWithWeekday(order.checkIn, today);
  const checkOut = dateWithWeekday(order.checkOut, isValidDate(order.checkIn) ? order.checkIn : today);
  return `${hotel}${room}，${checkIn}入住，${checkOut}离店，共${order.nights}晚${order.rooms > 1 ? `${order.rooms}间` : ''}`;
}

function dateTimeText(iso, today) {
  const text = formatDateTimeCN(iso);
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? text : `${yearPrefix(todayCN(new Date(ms)), today)}${text}`;
}

/**
 * Plain-language status line shared by the display notice and the model's history message.
 * @param {'confirmed'|'paid'|'cancelled'} kind
 * @param {string} [today] China date (YYYY-MM-DD) that decides whether dates need their year
 */
export function orderNoticeText(kind, order, today = todayCN()) {
  const status = ORDER_STATUS_LABELS[order.status] || order.status;
  if (kind === 'confirmed') {
    const payBy = order.payBy ? `请在 ${dateTimeText(order.payBy, today)} 前完成模拟支付，超时自动关闭` : '请尽快完成模拟支付';
    return `订单 ${order.id} 已提交，状态：${status}（${payBy}）。${stayText(order, today)}，总价 ¥${order.totalPrice}。`;
  }
  if (kind === 'paid') {
    const method = PAYMENT_METHOD_LABELS[order.payment?.method] || '模拟支付';
    const amount = order.payment?.amount ?? order.totalPrice;
    const conf = order.confirmationNo ? `，酒店确认号 ${order.confirmationNo}` : '';
    return `订单 ${order.id} 已支付成功，状态：${status}。${method}（模拟）¥${amount}${conf}。${stayText(order, today)}。`;
  }
  return `订单 ${order.id} 已取消，状态：${status}。${cancelMoneyText(order)}。`;
}

function cancelMoneyText(order) {
  if (!order.payment) return '订单未支付，没有产生费用';
  const c = order.cancellation || {};
  const penalty = Number(c.penalty) || 0;
  const refund = Number(c.refund) || 0;
  // A non-refundable rate keeps everything: there is nothing to send back.
  if (refund <= 0) return `违约金 ¥${penalty}，不退款（模拟）`;
  const refundText = `退款 ¥${refund}（模拟，原路退回）`;
  return penalty > 0 ? `违约金 ¥${penalty}，${refundText}` : `免费取消，${refundText}`;
}

/** Free text (a place, a review, a reply) inside a notice: one line, no 【】 to pass for another notice, no 「」『』 to close its quote. */
function plain(v, max) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[【】「」『』]/g, '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Free text for the model, always quoted: 「…」 reads as what someone wrote, never as the platform's own account. */
function quoted(v, max) {
  return `「${plain(v, max)}」`;
}

/**
 * The notice for a user's tap on a stay card: `text` is the short line shown in the chat, `modelText` the full
 * account the model gets after NOTICE_PREFIX, `cards` the card that changed.
 * @param {'ride_confirmed'|'extended'|'review_published'} kind
 * @param {{ ride?, extension?, order?, review? }} data  public views (stays.js)
 * @param {string} [today] China date (YYYY-MM-DD) that decides whether dates need their year
 */
export function stayNotice(kind, data, today = todayCN()) {
  if (kind === 'ride_confirmed') {
    const r = data.ride;
    const d = r.driver || {};
    const pickup = todayCN(new Date(Date.parse(r.pickupAt))) === today ? formatDateTimeCN(r.pickupAt).split(' ').pop() : dateTimeText(r.pickupAt, today);
    return {
      text: `已叫车：${d.name} · ${d.plate}，${pickup} 上车`,
      modelText: `用户已确认叫车：${r.kindLabel}，${quoted(r.from, 40)} → ${quoted(r.to, 40)}，${dateTimeText(r.pickupAt, today)} 上车，${r.carType}，`
        + `车费 ¥${r.fare} 已支付（模拟）。司机 ${d.name} ${d.plate}（${d.color}${d.car}），电话 ${d.phone}。`,
      cards: [{ type: 'ride', ride: r }],
    };
  }
  if (kind === 'extended') {
    const { extension: e, order } = data;
    const method = PAYMENT_METHOD_LABELS[e.payment?.method] || '模拟支付';
    return {
      text: `已续住${e.nights}晚，离店改到${dateWithWeekday(e.toDate, today)}`,
      modelText: `用户已续住${e.nights}晚：${e.hotel?.name || '酒店'} ${e.room || ''}，离店日期改为 ${dateWithWeekday(e.toDate, today)}，${method}（模拟）¥${e.price}。`
        + `订单 ${order.id} 现在共${order.nights}晚，总价 ¥${order.totalPrice}。`,
      cards: [{ type: 'extension_quote', extension: e }],
    };
  }
  const r = data.review;
  return {
    text: `点评已发布：${r.rating}星`,
    modelText: `用户已发布点评：${r.hotel?.name || '酒店'} ${r.rating}星${quoted(r.text, 40)}（模拟）。`,
    cards: [{ type: 'review_draft', review: r }],
  };
}

/**
 * The notice for something the hotel did (a merchant.js event): `text` is the short line in the guest's chat,
 * `modelText` the account the model gets after NOTICE_PREFIX, `cards` the card that changed.
 * @param {{ kind: 'front_desk_checkin'|'early_checkin_approved'|'early_checkin_declined'|'review_replied', stay?, request?, review? }} event
 * @param {string} [today] China date (YYYY-MM-DD) that decides whether dates need their year
 */
export function hotelNotice(event, today = todayCN()) {
  if (event.kind === 'front_desk_checkin') {
    const st = event.stay;
    return {
      text: `前台已为你办好入住：${st.roomNumber} 房`,
      modelText: `酒店前台已为用户办好入住：${st.hotel?.name || '酒店'} ${st.roomType || ''}，${st.roomNumber} 房（${st.floor}楼），`
        + `电子房卡有效期至 ${dateTimeText(st.keyValidUntil, today)}，Wi-Fi ${st.wifi?.ssid}，密码 ${st.wifi?.password}（模拟）。`,
      cards: [{ type: 'checkin', stay: st }],
    };
  }
  if (event.kind === 'early_checkin_approved' || event.kind === 'early_checkin_declined') {
    const r = event.request;
    const when = dateWithWeekday(r.date, today);
    return {
      // The request's note is the line for the guest: 「酒店已确认 12:00 可以入住」/「那天房间比较满，按 14:00 入住哦」.
      text: r.note,
      modelText: event.kind === 'early_checkin_approved'
        ? `酒店已确认用户可以提前入住：${r.hotel?.name || '酒店'}，${when} ${r.arrivalTime} 到店就能入住（模拟）。`
        : `酒店婉拒了用户的提前入住申请：${r.hotel?.name || '酒店'} ${when}房间比较满，没法提前到 ${r.arrivalTime}，按 14:00 正常入住（模拟），早到可以先寄存行李。`,
      cards: [{ type: 'early_checkin', request: r }],
    };
  }
  const r = event.review;
  return {
    text: '酒店回复了你的点评',
    modelText: `酒店回复了用户的点评：${r.hotel?.name || '酒店'} ${r.rating}星，酒店的回复是${quoted(r.reply?.text, 60)}（模拟）。`,
    cards: [{ type: 'review_draft', review: r }],
  };
}

// Stay cards that hold one request, by the field it sits in; replays show each with its status as of now.
const STAY_CARD_FIELDS = Object.freeze({
  ride_quote: 'ride', ride: 'ride', early_checkin: 'request', service: 'ticket', dining: 'reservation', wakeup: 'call',
  invoice: 'invoice', extension_quote: 'extension', review_draft: 'review',
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
  return {
    guestName: typeof p?.guestName === 'string' ? p.guestName : '',
    contactPhone: phone ? maskPhone(phone) : '',
    hasPhone: Boolean(phone),
    preferences: Array.isArray(prefs) ? prefs.filter((x) => typeof x === 'string').join('、') : typeof prefs === 'string' ? prefs : '',
    updatedAt: p?.updatedAt || null,
  };
}

function parseProfilePatch(body) {
  const patch = {};
  if (body.guestName !== undefined && body.guestName !== null) {
    if (typeof body.guestName !== 'string') throw new HttpError(400, 'invalid_guest_name', '入住人姓名格式不对');
    const name = body.guestName.trim().replace(/\s+/g, ' ');
    const problem = name ? guestNameProblem(name) : null;
    if (problem === 'format') throw new HttpError(400, 'invalid_guest_name', '入住人姓名需要是 2–20 个字的真实姓名');
    if (problem === 'placeholder') throw new HttpError(400, 'invalid_guest_name', '请填写身份证上的真实姓名，不能用「张先生」「本人」这类称呼');
    patch.guestName = name;
  } else if (body.guestName === null) {
    patch.guestName = '';
  }
  // A masked number echoed back from the form ('138****5678') means "unchanged".
  if (body.contactPhone !== undefined && !(typeof body.contactPhone === 'string' && body.contactPhone.includes('*'))) {
    if (body.contactPhone === null || body.contactPhone === '') {
      patch.contactPhone = '';
    } else {
      const phone = normalizePhone(body.contactPhone);
      if (!phone) throw new HttpError(400, 'invalid_phone', '请输入正确的 11 位中国大陆手机号');
      patch.contactPhone = phone;
    }
  }
  if (body.preferences !== undefined && body.preferences !== null) {
    const raw = Array.isArray(body.preferences)
      ? body.preferences.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).join('、')
      : typeof body.preferences === 'string' ? body.preferences.trim() : null;
    if (raw === null) throw new HttpError(400, 'invalid_preferences', '住宿偏好需要是文字');
    if (raw.length > MAX_PREFERENCES_CHARS) throw new HttpError(400, 'invalid_preferences', `住宿偏好最多 ${MAX_PREFERENCES_CHARS} 个字`);
    patch.preferences = raw;
  } else if (body.preferences === null) {
    patch.preferences = '';
  }
  return patch;
}

function notConfiguredText(llmConfig = {}) {
  const provider = llmConfig.provider || 'deepseek';
  const keyEnv = llmConfig.keyEnv || PROVIDERS?.[provider]?.keyEnv || 'LLM_API_KEY';
  return [
    '还没有配置大模型，我暂时没法帮你查酒店和下单。',
    '',
    '请在服务器的 `hotel-agent/.env` 文件里填写 API Key（可以复制 `.env.example` 改名为 `.env`），例如：',
    `- \`LLM_PROVIDER=${provider}\``,
    `- \`${keyEnv}=你的 API Key\``,
    '',
    '也支持通义千问、Kimi、智谱 GLM、豆包，改 `LLM_PROVIDER` 即可。保存后重启服务就能用了。',
    '想先看看效果，可以运行 `npm run demo` 启动不需要 Key 的脚本演示版。',
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
    clock = systemClock, logger = console,
  } = deps;
  if (!config || !store || !bookings) throw new Error('createApp: config, store and bookings are required');

  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const appName = config.appName || DEFAULTS.appName;
  const profiles = deps.profiles ?? createProfileRepo(store, { clock });
  const stays = deps.stays ?? (hotels ? createStayService({ store, bookings, hotels, clock }) : null);
  const merchant = deps.merchant ?? (stays && hotels ? createMerchantService({ store, bookings, stays, hotels, clock }) : null);
  const tools = deps.tools ?? createTools({
    hotels, places, bookings, stays, webSearch, profiles, clock,
    logger: (err) => logger.error(`[tools] ${err?.stack || err}`),
  });
  const sessions = store.collection('sessions');
  const serveStatic = createStaticHandler({ root: config.publicDir || path.join(ROOT_DIR, 'public') });
  const nowMs = () => clock.now().getTime();
  const limiter = createRateLimiter({ max: limits.chatTurnsPerWindow, windowMs: limits.rateWindowMs, now: nowMs });
  const ipLimiter = limits.writesPerIpPerWindow > 0
    ? createRateLimiter({ max: limits.writesPerIpPerWindow, windowMs: limits.rateWindowMs, now: nowMs })
    : null;
  const busy = new Set();
  /** sessionId → { ac, done, userId, snapshotted, notices } for each running turn. */
  const activeTurns = new Map();
  const llmReady = () => Boolean(llm && typeof llm.chat === 'function') && config.llm?.configured !== false;
  const nowIso = () => clock.now().toISOString();
  // Coverage is static; the prompt lists it so the model only suggests cities that have data.
  const cities = typeof hotels?.listCities === 'function' ? hotels.listCities() : undefined;

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
      throw new HttpError(429, 'rate_limited', '同一网络下使用的人较多，请稍后再试', { retryAfterSec: quota.retryAfterSec });
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
          return q ? { ...card, quote: toPublicQuote(q) } : card;
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
      const { orderId, kind, ...rest } = item;
      // An order notice's kind is internal (it pairs confirm with pay); a stay notice's kind is part of the API.
      const shown = kind && !orderId ? { ...rest, kind } : rest;
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
      ? { role: 'notice', text, cards: [{ type: 'order', order: toPublicOrder(order) }], at, orderId: order.id, kind }
      : { role: 'notice', kind, text, at, cards: (notice.cards || []).map(sanitizeCard) };
    const lastItem = s.display[s.display.length - 1];
    // confirm + pay arrive back to back from one payment sheet; replaying both would show the order twice.
    const paidRightAfterConfirm = order && kind === 'paid' && lastItem?.role === 'notice' && lastItem.orderId === order.id && lastItem.kind === 'confirmed';
    if (paidRightAfterConfirm) s.display[s.display.length - 1] = item;
    else s.display.push(item);

    const modelText = notice.modelText ?? text;
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.startsWith(NOTICE_PREFIX)) {
      s.messages[s.messages.length - 1] = { ...lastMsg, content: `${lastMsg.content}\n${modelText}` };
    } else {
      s.messages.push({ role: 'user', content: `${NOTICE_PREFIX}${modelText}` });
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
  async function appendOrderNotice(userId, kind, order) {
    let sessionId = order.sessionId;
    if (!sessionId && order.quoteId) sessionId = (await bookings.getQuote(userId, order.quoteId))?.sessionId;
    deliverNotice(userId, sessionId, { kind, order, text: orderNoticeText(kind, order, todayCN(clock.now())), at: nowIso() });
  }

  // ---- chat -----------------------------------------------------------------------------------

  async function runTurn({ userId, session, message, sse, signal, turn }) {
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
        profile: profile ? publicProfile(profile) : null,
        features: { webSearch: Boolean(webSearch?.enabled), demoHotels: true },
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
        ctx: { userId, sessionId: session.id, phoneVault: agentSession.phoneVault },
        systemPrompt,
        emit,
        signal,
        now: () => clock.now(),
        logger: (err) => logger.error(`[agent] ${err?.stack || err}`),
      });
      if (result?.aborted) logger.info(`[chat] 本轮已中止（session ${session.id}）`);
    } catch (err) {
      if (signal.aborted) logger.info(`[chat] 客户端断开，已中止本轮（session ${session.id}）`);
      else {
        failed = true;
        logger.error(`[chat] 本轮处理失败：${err?.stack || err}`);
        sse.send('error', { message: MSG_INTERNAL });
      }
    }

    const at = nowIso();
    const agentDisplay = Array.isArray(result?.display) ? result.display : null;
    const fallback = [{ role: 'assistant', text: collected.text, cards: collected.cards }];
    // So a reload shows what the live view showed.
    if (failed) fallback.push({ role: 'notice', text: `（回复中断：${MSG_INTERNAL}）` });
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
    if (!message) throw new HttpError(400, 'invalid_message', '消息不能为空');
    if (message.length > limits.maxMessageChars) {
      throw new HttpError(400, 'invalid_message', `消息太长了，请控制在 ${limits.maxMessageChars} 字以内`);
    }
    if (activeTurns.size >= limits.maxConcurrentTurns) {
      throw new HttpError(503, 'server_busy', '现在使用的人有点多，请稍后再试', { retryAfterSec: 5 });
    }
    // Every check runs before a new session is created, so a rejected request stores nothing.
    let session = null;
    if (!(body.sessionId === undefined || body.sessionId === null || body.sessionId === '')) {
      session = ownSession(userId, body.sessionId);
      if (!session) throw new HttpError(404, 'session_not_found', '这个对话不存在或已失效，请开始新对话');
      if (busy.has(session.id)) throw new HttpError(409, 'busy', '上一条消息还在处理中，请稍等片刻再发送');
    }
    if (turnsOf(userId) >= limits.maxTurnsPerUser) {
      throw new HttpError(409, 'busy', '你还有别的对话正在回复，请等它说完再发送');
    }
    // Each bucket is charged only for an accepted turn: the user's quota is checked first, so a user past it
    // cannot drain the shared address bucket, and an address rejection does not use up the user's turns.
    const quota = limiter.check(userId);
    if (!quota.ok) {
      throw new HttpError(429, 'rate_limited', '发消息太频繁了，请休息几分钟再试', { retryAfterSec: quota.retryAfterSec });
    }
    throttleWrites(req);
    limiter.take(userId);
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
        await runTurn({ userId, session, message, sse, signal: ac.signal, turn });
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
          logger.error(`[chat] 通知保存失败：${err?.stack || err}`);
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
      logger.error(`[store] 保存失败，稍后重试：${err?.message || err}`);
    }
  }

  async function orderAction(userId, kind, run, before) {
    const prevStatus = await before();
    const order = await run();
    if (order && order.status !== prevStatus) await appendOrderNotice(userId, kind, order);
    // The user is about to see 已提交 / 支付成功 / 已取消; don't leave that inside the store's write delay.
    await flushStore();
    return { order: toPublicOrder(order) };
  }

  function requireStays() {
    if (!stays) throw new HttpError(404, 'not_found', '接口不存在');
    return stays;
  }

  /**
   * A user's tap on a stay card (确认叫车 / 确认续住 / 发布): `run` returns { ride } / { extension, order } /
   * { review }; the first change of status also leaves a notice in the session the card came from.
   */
  async function stayAction(userId, id, kind, run) {
    const s = requireStays();
    const before = (await s.getRequest(userId, id))?.status ?? null;
    const out = await run(s);
    const subject = out.ride || out.extension || out.review;
    if (subject && subject.status !== before) {
      const notice = stayNotice(kind, out, todayCN(clock.now()));
      deliverNotice(userId, await s.sessionOf(userId, id), { kind, ...notice, at: nowIso() });
    }
    await flushStore();
    return out;
  }

  function requireMerchant() {
    if (!merchant) throw new HttpError(404, 'not_found', '接口不存在');
    return merchant;
  }

  /** The hotel did something a 小宿 guest should hear about (merchant.js event): a notice in that guest's chat. */
  function deliverHotelEvent(event) {
    if (!event?.userId || !event.sessionId) return;
    deliverNotice(event.userId, event.sessionId, { kind: event.kind, ...hotelNotice(event, todayCN(clock.now())), at: nowIso() });
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
  ].map(([method, re, fn]) => [method, re, fn, { auth: false }]);

  const routes = [
    ...merchantRoutes,
    ['GET', /^\/api\/health$/, async (ctx) => sendJson(ctx.res, 200, {
      ok: true,
      appName,
      llm: { provider: config.llm?.provider || null, model: config.llm?.model || null, configured: llmReady() },
      hotels: 'sim',
      webSearch: Boolean(webSearch?.enabled),
    }), { auth: false }],

    ['POST', /^\/api\/sessions$/, async ({ req, res, userId }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      throttleWrites(req);
      const session = createSession(userId);
      sendJson(res, 201, { sessionId: session.id });
    }],

    ['GET', /^\/api\/sessions\/([^/]+)$/, async ({ res, userId, params }) => {
      const session = ownSession(userId, params[0]);
      if (!session) throw new HttpError(404, 'session_not_found', '这个对话不存在或已失效');
      sendJson(res, 200, { sessionId: session.id, items: await displayItems(userId, session) });
    }],

    ['POST', /^\/api\/chat$/, async ({ req, res, userId }) => handleChat(req, res, userId)],

    ['POST', /^\/api\/quotes\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [quoteId] = params;
      const out = await orderAction(userId, 'confirmed',
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
      const out = await orderAction(userId, 'paid',
        () => bookings.payOrder({ userId, orderId, method: body.method }),
        async () => (await bookings.getOrder(userId, orderId))?.status ?? null);
      sendJson(res, 200, out);
    }],

    ['POST', /^\/api\/orders\/([^/]+)\/cancel$/, async ({ req, res, userId, params }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const [orderId] = params;
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      const out = await orderAction(userId, 'cancelled',
        () => bookings.cancelOrder({ userId, orderId, reason }),
        async () => (await bookings.getOrder(userId, orderId))?.status ?? null);
      sendJson(res, 200, out);
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
      const list = await requireStays().listStays(userId);
      sendJson(res, 200, { stays: list.map((x) => ({ ...x, order: toPublicOrder(x.order) })) });
    }],

    ['POST', /^\/api\/rides\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [rideId] = params;
      const { ride } = await stayAction(userId, rideId, 'ride_confirmed', async (s) => ({ ride: await s.confirmRide({ userId, rideId }) }));
      sendJson(res, 200, { ride });
    }],

    ['POST', /^\/api\/extensions\/([^/]+)\/confirm$/, async ({ req, res, userId, params }) => {
      const body = await readJsonBody(req, limits.maxBodyBytes);
      const [extensionId] = params;
      const { extension, order } = await stayAction(userId, extensionId, 'extended', (s) => s.confirmExtension({ userId, extensionId, method: body.method }));
      sendJson(res, 200, { extension, order: toPublicOrder(order) });
    }],

    ['POST', /^\/api\/reviews\/([^/]+)\/publish$/, async ({ req, res, userId, params }) => {
      await readJsonBody(req, limits.maxBodyBytes);
      const [reviewId] = params;
      const { review } = await stayAction(userId, reviewId, 'review_published', async (s) => ({ review: await s.publishReview({ userId, reviewId }) }));
      sendJson(res, 200, { review });
    }],

    ['GET', /^\/api\/profile$/, async ({ res, userId }) => {
      sendJson(res, 200, { profile: publicProfile(await profiles.get(userId)) });
    }],

    ['PUT', /^\/api\/profile$/, async ({ req, res, userId }) => {
      const patch = parseProfilePatch(await readJsonBody(req, limits.maxBodyBytes));
      throttleWrites(req);
      // Merge here so omitted fields (e.g. a blank phone input) keep their saved values.
      const current = (await profiles.get(userId)) || {};
      const saved = await profiles.save(userId, { ...current, ...patch });
      sendJson(res, 200, { profile: publicProfile(saved ?? (await profiles.get(userId))) });
    }],
  ];

  function identify(req) {
    const raw = req.headers['x-user-id'];
    if (typeof raw !== 'string' || !isUuid(raw.trim())) {
      throw new HttpError(401, 'unauthorized', '缺少或无效的用户标识，请刷新页面后重试');
    }
    return raw.trim().toLowerCase();
  }

  async function handleApi(req, res, rawPath) {
    const matches = routes.filter(([, re]) => re.test(rawPath));
    if (!matches.length) throw new HttpError(404, 'not_found', '接口不存在');
    const route = matches.find(([method]) => method === req.method);
    if (!route) {
      const allow = [...new Set(matches.map(([m]) => m))].join(', ');
      throw new HttpError(405, 'method_not_allowed', '不支持这个请求方法', { allow });
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
      if (!ID_RE.test(id)) throw new HttpError(404, 'not_found', '内容不存在或已失效');
      return id;
    });
    await fn({ req, res, userId, params, query });
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const rawPath = String(req.url || '/').split('?')[0];
    res.once('close', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      // Paths carry only random ids; no query strings, bodies, user ids or phone numbers are logged.
      const shown = rawPath.replace(/[^\x21-\x7e]/g, '?').slice(0, 120);
      logger.info(`[http] ${req.method} ${shown} ${res.statusCode}${res.writableFinished ? '' : ' (aborted)'} ${ms}ms`);
    });
    try {
      if (!rawPath.startsWith('/')) throw new HttpError(400, 'bad_request', '请求地址无效');
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
      const body = '404 页面不存在';
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
 * Real dependencies: JSON store under DATA_DIR (`dataDir: null` = in memory), simulated hotels (priced with the
 * hotels' promotions), bookings, stays and the hotel's console, optional web search and the LLM client. Pass
 * `llm` / `webSearch` to use those instead of building them.
 */
export async function buildDeps(config, { fetch = globalThis.fetch, clock = systemClock, logger = console, llm, webSearch } = {}) {
  const store = createJsonStore({ dir: config.dataDir ?? null, onError: (err) => logger.error(`[store] ${err.message}`) });
  await store.load();
  const supplier = createSimSupplier();
  // The hotels' own promotions discount the nights they cover wherever a price comes from (merchant.js).
  const promotions = createPromotionBook({ store, clock });
  const hotels = createHotelService({ supplier, clock, promotions });
  const places = createPlacesService({ supplier, clock, pricing: withPromotions(promotions) });
  const bookings = createBookingService({ store, hotels, clock });
  const stays = createStayService({ store, bookings, hotels, clock });
  const merchant = createMerchantService({ store, bookings, stays, hotels, clock, promotions });
  return {
    config,
    store,
    hotels,
    places,
    bookings,
    stays,
    merchant,
    webSearch: webSearch ?? createWebSearch({ provider: config.webSearch?.provider || 'bocha', apiKey: config.webSearch?.apiKey, fetch }),
    llm: llm !== undefined ? llm : config.llm?.configured ? createLlmClient({ ...config.llm, fetch }) : null,
    clock,
    logger,
  };
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
  console.info(`[server] ${config.appName} 已启动：${running.url}`);
  console.info(`[server] 大模型：${llm.label || llm.provider} / ${llm.model}${llm.configured ? '' : '（未配置 API Key，对话会提示如何配置）'}`);
  for (const w of llm.warnings || []) console.warn(`[config] ${w}`);
  console.info(`[server] 联网搜索：${config.webSearch.enabled ? '已开启（博查）' : '未开启'} · 数据目录：${config.dataDir}`);

  let exiting = false;
  const shutdown = (signal) => {
    if (exiting) return;
    exiting = true;
    console.info(`[server] 收到 ${signal}，正在保存数据并退出…`);
    running.close().then(() => process.exit(0), (err) => {
      console.error(`[server] 退出时出错：${err?.stack || err}`);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[server] 启动失败：${err?.stack || err}`);
    process.exit(1);
  });
}
