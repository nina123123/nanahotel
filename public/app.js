// 小宿 — browser client, laid out like a call with 小宿: the thread in the middle, the call bar at the bottom
// (talk, type, call / hang up) and "my plans" under the header. Speech recognition is simulated: the mic offers
// sentences to "say". In a call, replies are read aloud where the browser has a Chinese voice.
// Cards (cards.js) show what the agent found or arranged. Anything that spends money or publishes something waits
// for the user's own tap: a booking, a ride, an extension, a review.
// The guide is 小宿 the capybara (pet.js): it sits in the header with a status line, signs each reply,
// thinks while a reply is on its way, celebrates a paid booking in a hot spring, and dozes when left alone.
// Where it moves (header, welcome, the reply being written, the sticker) the Rive version takes over once it has
// loaded (pet-rive.js); the SVG drawing is the fallback and the still pictures.
// Security rule for this file: server/LLM text reaches the DOM only through Text nodes / textContent,
// or through renderMarkdown(), which HTML-escapes the whole input before adding any tag of its own.
import { petNode } from './pet.js';
import { loadRivePet, mountRivePet, rivePetReady } from './pet-rive.js';
import { icon } from './icons.js';
import { createCards, dayTime, STATUS_LABELS } from './cards.js';

const KEY_USER = 'xiaosu.userId';
const KEY_SESSION = 'xiaosu.sessionId';
const NEAR_BOTTOM_PX = 120;
const MAX_MESSAGE_CHARS = 2000;

const SUGGESTIONS = [
  { emoji: '🏞️', text: '这周五去杭州西湖边，住两晚，预算600' },
  { emoji: '🌃', text: '明晚上海外滩附近，两个大人一个小孩' },
  { emoji: '🌶️', text: '成都春熙路附近，今晚，便宜点' },
];
const WELCOME_SUB = '头顶橘子、情绪稳定的卡皮巴拉。想住哪儿、哪天、预算多少，打给我或者直接说～';
// The home screen's examples once something is booked: what fits where the trip is.
const TRIP_SUGGESTIONS = {
  booked: [{ emoji: '🗺️', text: '帮我规划一下那天的行程' }, { emoji: '🚕', text: '帮我叫车去酒店' }, { emoji: '🛎️', text: '我到了，帮我办入住' }],
  staying: [{ emoji: '🧺', text: '送两条毛巾' }, { emoji: '⏰', text: '明早7点叫醒我' }, { emoji: '🍳', text: '订明天的早餐' }],
  left: [{ emoji: '🧾', text: '开发票' }, { emoji: '⭐', text: '写个好评' }, { emoji: '👑', text: '我的积分' }],
};
// What you could "say" (speech recognition is simulated), by where the trip is.
const VOICE_SAYS = {
  start: SUGGESTIONS.map((s) => s.text),
  booked: ['帮我规划一下那天的行程', '帮我叫车去酒店', '能提前入住吗？中午12点到', '我到了，帮我办入住'],
  staying: ['送两条毛巾', 'Wi-Fi 密码多少', '明早7点叫醒我', '订明天的早餐', '再住一晚', '我要退房'],
  left: ['开发票', '写个好评', '我的积分'],
};
// Requests that move on by themselves; while one is on its way, my plans are refreshed every PLAN_POLL_MS.
// A ride booked for later only starts moving near its pickup time: until then one refresh is set for then.
const PLAN_POLL_MS = 15000;
// While the guest arrives today or is staying, the hotel may act (check them in, deliver, reply): look every 30 s.
const PLAN_IDLE_MS = 30000;
const RIDE_SOON_MS = 30 * 60 * 1000;
const PLAN_WAIT_MAX_MS = 6 * 60 * 60 * 1000;
const MOVING = { ride: ['confirmed', 'arriving'], service: ['accepted', 'on_the_way'], invoice: ['issuing'] };
// Notices from the user's own taps and from the hotel's console (docs/MERCHANT.md).
const NOTICE_KINDS = new Set(['ride_confirmed', 'extended', 'review_published', 'front_desk_checkin', 'early_checkin_approved',
  'early_checkin_declined', 'review_replied']);
const PET_IDLE = '情绪稳定中';
const PET_POKES = ['橘子差点掉了…', '别闹～在帮你看酒店呢', '摸摸头，收到 (｡•ᴗ•｡)', '情绪稳定，继续营业', '我在呢～', '嘿嘿，有点痒'];
const BREAKFAST_LABELS = ['不含早', '含单早', '含双早'];
const PAY_METHODS = { wechat: '微信支付', alipay: '支付宝' };
// Confirm/pay failures that a fresh quote fixes; anything else can simply be retried.
const REQUOTE_CODES = new Set(['expired', 'superseded', 'price_changed', 'sold_out', 'terms_changed', 'invalid_dates',
  'rate_not_found', 'hotel_not_found', 'not_found']);
const MSG_NETWORK = '网络好像断了，检查一下网络再试。';
// Like iMessage: a time line above a message that comes after a pause or on a new day.
const STAMP_GAP_MS = 20 * 60 * 1000;
const MSG_STREAM_CUT = '连接中断了，回复可能不完整。';

// ---------------------------------------------------------------------------
// Pure helpers (exported so they can be unit-tested outside the browser)
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const URL_RE = /https?:\/\/[^\s\u0000　-〿一-鿿＀-￯]+/g;
const URL_TRAIL_RE = /(?:[.,;:!?)\]}*]|&(?:quot|#39|gt|lt);)+$/;

function anchorHtml(url, label) {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// Input is already HTML-escaped, so the only markup in the result is the tags added here.
function inlineMarkdown(escaped) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escaped.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(anchorHtml(url, label)));
  s = s.replace(URL_RE, (url) => {
    const trail = (URL_TRAIL_RE.exec(url) || [''])[0];
    const core = url.slice(0, url.length - trail.length);
    return /^https?:\/\/[^/]+\.[^/]/.test(core) ? keep(anchorHtml(core, core)) + trail : url;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  for (let i = 0; i < 3 && s.includes('\u0000'); i += 1) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? '');
  }
  return s;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// A header row with a pipe, followed by a --- separator row that has a pipe too (GFM).
function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|')
    && lines[i + 1].includes('-') && TABLE_SEP_RE.test(lines[i + 1]);
}

/** Minimal safe Markdown → HTML: paragraphs, line breaks, lists, **bold**, `code`, ``` fences, | tables, http(s) links. */
export function renderMarkdown(text) {
  const source = String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const lines = escapeHtml(source).split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.tag === 'ol' && list.start > 1 ? ` start="${list.start}"` : '';
    const items = list.items.map((item) => `<li>${item.map(inlineMarkdown).join('<br>')}</li>`).join('');
    out.push(`<${list.tag}${start}>${items}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      flushList();
      // An unclosed fence (still streaming) runs to the end of the text.
      const code = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1) code.push(lines[i]);
      out.push(`<pre class="md-pre"><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      flushPara();
      flushList();
      const head = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i += 1) rows.push(tableCells(lines[i]));
      i -= 1;
      const cells = (row, tag) => head.map((_, c) => `<${tag}>${inlineMarkdown(row[c] ?? '')}</${tag}>`).join('');
      out.push(`<div class="md-table"><table><thead><tr>${cells(head, 'th')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = bullet ? null : /^\s*(\d{1,3})(?:[.)]\s+|、\s*)(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [], start: numbered ? Number(numbered[1]) : 1 };
      }
      list.items.push([bullet ? bullet[1] : numbered[2]]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1].push(line.trim());
      continue;
    }
    flushList();
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      out.push(`<p><strong>${inlineMarkdown(heading[1])}</strong></p>`);
      continue;
    }
    const quote = /^\s*&gt;\s?(.*)$/.exec(line);
    para.push(quote ? quote[1] : line);
  }
  flushPara();
  flushList();
  return out.join('');
}

/** Incremental SSE parser: feed decoded text with push(); calls onEvent(event, jsonData) per event. */
export function createSseParser(onEvent) {
  let buffer = '';
  const dispatch = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    onEvent(event, payload ?? {});
  };
  return {
    push(chunk) {
      buffer += chunk;
      // A CRLF pair can be split across chunks; hold a trailing CR until the next chunk.
      const pendingCr = buffer.endsWith('\r');
      let text = (pendingCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
      let idx = text.indexOf('\n\n');
      while (idx !== -1) {
        dispatch(text.slice(0, idx));
        text = text.slice(idx + 2);
        idx = text.indexOf('\n\n');
      }
      buffer = pendingCr ? `${text}\r` : text;
    },
    end() {
      const rest = buffer.replace(/\r\n?/g, '\n').trim();
      buffer = '';
      if (rest) dispatch(rest);
    },
  };
}

/** RFC 4122 v4 UUID; crypto.randomUUID only exists in secure contexts (not on http://192.168.x.x). */
export function newUuid(cryptoObj = globalThis.crypto) {
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // fall through
    }
  }
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatYuan(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `¥${Math.round(n).toLocaleString('zh-CN')}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The current year in China time. */
export function cnYear(nowMs = serverNow()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date(nowMs)));
}

/** '2026-10-30' → '10月30日 周五'; the year is shown only when it differs from refYear. */
export function formatDate(ymd, withWeekday = true, refYear = cnYear()) {
  if (!ISO_DATE_RE.test(String(ymd || ''))) return String(ymd || '');
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y !== refYear ? `${y}年` : ''}${m}月${d}日${withWeekday ? ` ${wd}` : ''}`;
}

/** '10月30日 周五 – 11月1日 周日'; the check-out shows its year when it differs from the check-in's. */
export function formatStay(checkIn, checkOut, refYear = cnYear()) {
  if (!checkIn) return '';
  const inYear = Number(String(checkIn).slice(0, 4)) || refYear;
  return checkOut ? `${formatDate(checkIn, true, refYear)} – ${formatDate(checkOut, true, inYear)}` : formatDate(checkIn, true, refYear);
}

/** A free / limited cancellation whose deadline has passed is no longer free. */
export function policyLapsed(policy, nowMs = serverNow()) {
  if (!policy || !['free', 'limited'].includes(policy.type) || !policy.freeUntil) return false;
  const until = Date.parse(policy.freeUntil);
  return !Number.isNaN(until) && nowMs >= until;
}

/** '+86 138-1234-5678' / full-width digits → '13812345678' (the server applies the same rule). */
export function normalizePhoneInput(value) {
  return String(value ?? '')
    .replace(/[０-９＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-－‐-―()（）]/g, '')
    .replace(/^(\+?86)(?=1\d{10}$)/, '');
}

function stayPhrase(s) {
  const year = cnYear();
  const parts = [];
  if (ISO_DATE_RE.test(String(s.checkIn || ''))) parts.push(`${formatDate(s.checkIn, false, year)}入住`);
  if (ISO_DATE_RE.test(String(s.checkOut || ''))) parts.push(`${formatDate(s.checkOut, false, Number(String(s.checkIn).slice(0, 4)) || year)}离店`);
  const adults = Number(s.adults) || 0;
  const children = Number(s.children) || 0;
  if (adults) parts.push(`${adults}位成人${children ? `，${children}名儿童` : ''}`);
  if (Number(s.rooms)) parts.push(`${Number(s.rooms)}间`);
  return parts.join('，');
}

/** The message a stale confirmation sends to get a fresh quote for the same room (ids and dates verbatim). */
export function requoteMessage(quote = {}) {
  const hotel = quote.hotel || {};
  const room = quote.room || {};
  const rate = quote.rate || {};
  const ids = [
    hotel.id ? `hotel_id: ${hotel.id}` : null,
    rate.rateId ? `rate_id: ${rate.rateId}` : null,
    ISO_DATE_RE.test(String(quote.checkIn || '')) ? `check_in: ${quote.checkIn}` : null,
    ISO_DATE_RE.test(String(quote.checkOut || '')) ? `check_out: ${quote.checkOut}` : null,
  ].filter(Boolean).join('，');
  const what = [room.name, rate.name].filter(Boolean).join(' · ');
  const stay = stayPhrase(quote);
  return `报价失效了，请帮我重新报价：「${hotel.name || ''}」的 ${what}${stay ? `：${stay}` : ''}${ids ? `（${ids}）` : ''}`;
}

// A tap on a hotel or a room sends the model the ids and dates too: 「…」的 房型：11月6日入住…（hotel_id: …）.
const IDS_TAIL_RE = /(?:：[^：\n]*)?（(?:hotel_id|rate_id|check_in): [^）\n]*）\s*$/;

/** A sent message as its bubble shows it: without the ids-and-dates tail a card tap adds for the model. */
export function displayText(text) {
  const s = String(text ?? '');
  const shown = s.replace(IDS_TAIL_RE, '').trim();
  return shown || s.trim();
}

// 回复「订第1家」, 说「好」…: the short answers a reply suggests, offered as buttons under it.
const REPLY_CUE_RE = /(?:回复|回个?|说|发|输入)\s*((?:「[^」\n]{1,16}」\s*(?:[、，,/]|或者?|和|还是)?\s*)+)/g;
const PICK_RE = /第\s*([0-9]+|[NnXx几])\s*(家|个|间|单|晚)/;

/**
 * The quick replies a message offers in 「」 after 回复/说/发 (never 点「…」, which names a button).
 * A single pick like 「订第1家」 under a numbered list of n items becomes one reply per item (up to 4), and a
 * template like 「取消第N单」 is filled in the same way or dropped when there is no list. Picks the message
 * spells out one by one (「第2个」「第3个」) are kept as they are.
 */
export function quickReplies(text, listCount = 0) {
  const phrases = [];
  for (const cue of String(text ?? '').matchAll(REPLY_CUE_RE)) {
    for (const [, raw] of cue[1].matchAll(/「([^」\n]{1,16})」/g)) if (raw.trim()) phrases.push(raw.trim());
  }
  const expand = phrases.filter((p) => PICK_RE.test(p)).length === 1;
  const out = [];
  for (const phrase of phrases) {
    const pick = PICK_RE.exec(phrase);
    const isTemplate = Boolean(pick) && !/\d/.test(pick[1]);
    if (pick && expand && listCount >= (isTemplate ? 1 : 2)) {
      for (let i = 1; i <= Math.min(listCount, 4); i += 1) out.push(phrase.replace(PICK_RE, (_, __, unit) => `第${i}${unit}`));
    } else if (!isTemplate) {
      out.push(phrase);
    }
  }
  return [...new Set(out)].slice(0, 5);
}

/** 小宿's hello for the hour of the day. */
export function greeting(hour = new Date().getHours()) {
  if (hour < 5) return '这么晚还没睡呀';
  if (hour < 11) return '早上好呀';
  if (hour < 14) return '中午好呀';
  if (hour < 18) return '下午好呀';
  return '晚上好呀';
}

export const MAX_PREFERENCES_CHARS = 60;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function mdBlock(text, cls) {
  const el = h('div', { class: cls });
  el.innerHTML = renderMarkdown(text);
  return el;
}

const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

// ---------------------------------------------------------------------------
// State, storage, identity
// ---------------------------------------------------------------------------

const state = {
  userId: '',
  sessionId: null,
  appName: '小宿',
  busy: false,
  abort: null,
  epoch: 0,
  stick: true,
  clockSkewMs: 0,
  llmConfigured: null,
  lastMsgMs: 0,
  call: { live: false, startedAt: 0, timer: 0 },
  voiceOpen: false,
  voiceTimer: 0,
  speaking: false,
  stays: [],
  photos: null,
  merchant: false,
};

let cards = null;

let els = {};

const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // storage disabled / private mode: keep working in memory
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

function loadUserId() {
  const saved = storage.get(KEY_USER);
  if (saved && UUID_RE.test(saved)) return saved;
  const id = newUuid();
  storage.set(KEY_USER, id);
  return id;
}

function setSession(id) {
  state.sessionId = id || null;
  if (id) storage.set(KEY_SESSION, id);
  else storage.remove(KEY_SESSION);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function httpMessage(status) {
  if (status === 409) return '上一条还在处理，稍等一下再发。';
  if (status === 401) return '身份信息无效，请刷新页面后重试。';
  if (status === 404) return '内容不存在或已失效。';
  if (status === 413) return '内容太长了，精简一下再试。';
  if (status === 429) return '操作太频繁了，稍后再试。';
  if (status >= 500) return '服务暂时不可用，稍后再试。';
  return `请求失败（${status}），稍后再试。`;
}

function toApiError(status, data) {
  const err = data && typeof data === 'object' ? data.error : null;
  const message = err && typeof err.message === 'string' && err.message ? err.message : httpMessage(status);
  return new ApiError(status, (err && err.code) || `http_${status}`, message);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function requestHeaders(json, accept = 'application/json') {
  const headers = { 'X-User-Id': state.userId, Accept: accept };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

// Quote expiry and cancellation deadlines use the server clock (Date header), not a possibly wrong phone clock.
function noteServerClock(res) {
  const server = Date.parse(res.headers.get('date') || '');
  if (Number.isNaN(server)) return;
  const skew = server - Date.now();
  state.clockSkewMs = Math.abs(skew) > 3000 ? skew : 0;
}

const serverNow = () => Date.now() + state.clockSkewMs;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: requestHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', MSG_NETWORK);
  }
  noteServerClock(res);
  const data = await readJson(res);
  if (!res.ok) throw toApiError(res.status, data);
  return data && typeof data === 'object' ? data : {};
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Scrolling and busy state
// ---------------------------------------------------------------------------

function isNearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom() {
  els.log.scrollTop = els.log.scrollHeight;
}

// The header, my plans and the call bar float over the thread (it scrolls under their frosted glass); keep it
// padded clear of them.
function bindChrome() {
  const topbar = els.app.querySelector('.topbar');
  const sync = () => {
    els.app.style.setProperty('--top-h', `${topbar.offsetHeight}px`);
    els.app.style.setProperty('--plans-h', `${els.plans.hidden ? 0 : els.plans.offsetHeight}px`);
    els.app.style.setProperty('--bottom-h', `${els.dock.offsetHeight}px`);
    if (state.stick && !document.getElementById('welcome')) scrollToBottom();
  };
  sync();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(sync);
    ro.observe(topbar);
    ro.observe(els.plans);
    ro.observe(els.dock);
  }
}

function bindScroll() {
  els.log.addEventListener('scroll', () => {
    state.stick = isNearBottom();
  }, { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (state.stick && !document.getElementById('welcome')) scrollToBottom();
    }).observe(els.messages);
  }
}

function updateSendButton() {
  els.send.disabled = state.busy ? !state.abort : !els.input.value.trim();
}

function setBusy(busy) {
  state.busy = busy;
  els.messages.setAttribute('aria-busy', String(busy));
  els.send.classList.toggle('is-stop', busy);
  els.send.setAttribute('aria-label', busy ? '停止' : '发送');
  updateSendButton();
  for (const btn of document.querySelectorAll('[data-lock]')) btn.disabled = busy;
  updateCallLine();
}

/** A button that sends a chat message for the user (disabled while a reply is being written). */
function chatButton(label, message, { cls = 'chip', action } = {}) {
  const btn = h('button', { type: 'button', class: cls, 'data-action': action, 'data-lock': '' }, label);
  btn.disabled = state.busy;
  btn.addEventListener('click', () => send(message));
  return btn;
}

// ---------------------------------------------------------------------------
// The pet: one mood shared by every pet that is "on" ([data-live]: the header, the welcome screen, the reply
// being written) and a status line under its name. The base line holds until something replaces it;
// flashes (a tap, 醒啦) last a moment and fall back to it.
// ---------------------------------------------------------------------------

const pet = { mood: 'idle', base: PET_IDLE, beforeSleep: PET_IDLE, flashTimer: 0, sleepTimer: 0, moodTimer: 0, lastPoke: -1 };

function petMood(mood) {
  pet.mood = mood;
  clearTimeout(pet.moodTimer);
  for (const svg of document.querySelectorAll('.pet[data-live]')) {
    svg.dataset.mood = mood;
    svg.closest('[data-pet-poke]')?.petRive?.mood(mood);
  }
  updateCallLine();
}

function showStatus(text) {
  const el = els.petStatus;
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('is-changed');
  void el.offsetWidth;
  el.classList.add('is-changed');
}

/** The status line until something else replaces it. */
function petStatus(text) {
  clearTimeout(pet.flashTimer);
  pet.base = text || PET_IDLE;
  showStatus(pet.base);
}

/** A line shown for a moment, then back to the base line. */
function petFlash(text, ms = 2600) {
  clearTimeout(pet.flashTimer);
  showStatus(text);
  pet.flashTimer = setTimeout(() => showStatus(pet.base), ms);
}

// Left alone for a while (sooner late at night), it dozes off; any touch or key wakes it.
const sleepDelay = () => (new Date().getHours() < 6 ? 30000 : 90000);

function petSleep() {
  if (state.busy || pet.mood !== 'idle' || document.querySelector('dialog[open]') || document.hidden) {
    pet.sleepTimer = setTimeout(petSleep, sleepDelay());
    return;
  }
  pet.beforeSleep = pet.base;
  petMood('sleepy');
  petStatus('打个盹 zZ');
}

function petWake() {
  clearTimeout(pet.sleepTimer);
  pet.sleepTimer = setTimeout(petSleep, sleepDelay());
  if (pet.mood !== 'sleepy') return;
  petMood('idle');
  pet.base = pet.beforeSleep;
  petFlash('醒啦！', 1500);
}

/** A tap on the pet (`host` holds it): it flinches, the orange falls off and goes back on, and it says something. */
function petPoke(host) {
  const svg = host.querySelector('svg.pet');
  if (!svg) return;
  petWake();
  if (host.petRive?.shown()) {
    host.petRive.poke();
  } else {
    clearTimeout(svg.pokeTimer);
    svg.classList.remove('is-poked');
    void svg.getBoundingClientRect();
    svg.classList.add('is-poked');
    svg.pokeTimer = setTimeout(() => svg.classList.remove('is-poked'), 1600);
  }
  let i = Math.floor(Math.random() * PET_POKES.length);
  if (i === pet.lastPoke) i = (i + 1) % PET_POKES.length;
  pet.lastPoke = i;
  const pop = host.querySelector('.pet-pop');
  if (!pop) {
    petFlash(PET_POKES[i]);
    return;
  }
  pop.textContent = PET_POKES[i];
  pop.hidden = false;
  pop.classList.remove('is-changed');
  void pop.offsetWidth;
  pop.classList.add('is-changed');
  clearTimeout(pop.hideTimer);
  pop.hideTimer = setTimeout(() => { pop.hidden = true; }, 2200);
}

/** Booking paid: a happy pet for a few seconds. */
function petCelebrate() {
  petMood('happy');
  petFlash('订好啦！泡温泉去 ♨', 8000);
  pet.moodTimer = setTimeout(() => {
    if (pet.mood === 'happy') petMood('idle');
  }, 8000);
}

function bindPet() {
  const header = petNode('head');
  header.setAttribute('data-live', '');
  document.getElementById('pet-header').append(header);
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-pet-poke]') : null;
    if (target) petPoke(target);
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, petWake, { passive: true, capture: true });
  // Typing: it looks down at what you're writing.
  els.input.addEventListener('input', () => {
    if (state.busy || !['idle', 'listening'].includes(pet.mood)) return;
    petMood(els.input.value.trim() ? 'listening' : 'idle');
  });
  els.input.addEventListener('blur', () => {
    if (pet.mood === 'listening') petMood('idle');
  });
  petWake();
}

// The welcome capybara hops in as an SVG first (style.css); the Rive one takes over once the hop is done.
const WELCOME_HOP_MS = 700;

/** Once Rive has loaded: the header pet, and whatever moving pet is already on screen, switch to it. */
function startRivePet() {
  loadRivePet().then((ok) => {
    if (!ok) return;
    mountRivePet(document.getElementById('pet-header'), 'Head', { mood: pet.mood });
    const welcome = document.querySelector('#welcome .welcome-pet');
    if (welcome) mountRivePet(welcome, 'Body', { mood: pet.mood, showAfter: Math.max(0, WELCOME_HOP_MS - (performance.now() - (welcome.renderedAt || 0))) });
    const live = document.querySelector('.turn-avatar .pet[data-live]')?.closest('.turn-avatar');
    if (live) mountRivePet(live, 'Head', { mood: pet.mood });
  });
}

/** Stops the Rive pets inside `root` (they are about to leave the page). */
function stopRivePets(root) {
  for (const host of root.querySelectorAll('.welcome-pet, .turn-avatar, .sticker')) host.petRive?.destroy();
}

function removeWelcome() {
  const welcome = document.getElementById('welcome');
  if (!welcome) return;
  stopRivePets(welcome);
  welcome.remove();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Appends something that just happened (it eases in; a replayed history does not). */
function append(el) {
  el.classList.add('is-new');
  els.messages.append(el);
  return el;
}

function stampText(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  const date = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}年${date}`;
}

/** The time line for a user message sent at `ms`, or null when it follows the previous one closely. */
function stampFor(ms) {
  if (!Number.isFinite(ms)) return null;
  const last = state.lastMsgMs;
  state.lastMsgMs = ms;
  if (last && ms - last < STAMP_GAP_MS && new Date(ms).toDateString() === new Date(last).toDateString()) return null;
  return h('div', { class: 'stamp', text: stampText(ms) });
}

// The sr-only prefixes tell screen-reader users who is speaking inside the role=log region.
function userTurn(text, prev, { voice = false } = {}) {
  // Back-to-back messages from the user read as one group, like a chat app.
  const cont = prev?.classList.contains('turn-user');
  return h('div', { class: `turn turn-user${cont ? ' is-cont' : ''}` },
    h('span', { class: 'sr-only', text: voice ? '我（语音）：' : '我：' }),
    h('div', { class: `bubble bubble-out${voice ? ' is-voice' : ''}`, text: displayText(text) }));
}

/** 小宿's turn: its avatar beside a column of bubbles. A live turn's avatar follows the pet's mood. */
function assistantTurn({ live = false } = {}) {
  const avatar = petNode('head');
  if (live) avatar.setAttribute('data-live', '');
  return h('div', { class: 'turn turn-in' },
    h('span', { class: 'sr-only', text: `${state.appName}：` }),
    h('div', { class: 'turn-avatar', 'data-pet-poke': '' }, avatar),
    h('div', { class: 'turn-body' }));
}

const turnBody = (turn) => turn.querySelector(':scope > .turn-body') || turn;

/** Adds a bubble to a turn; consecutive text bubbles are drawn as one group. */
function placeIn(turn, node, before = null) {
  const box = turnBody(turn);
  const prev = before ? before.previousElementSibling : box.lastElementChild;
  if (node.classList.contains('bubble-in') && prev?.classList.contains('bubble-in')) node.classList.add('is-cont');
  box.insertBefore(node, before);
  return node;
}

/** The hot-spring sticker 小宿 sends when a booking is paid. */
function stickerTurn() {
  const turn = assistantTurn();
  placeIn(turn, h('div', { class: 'sticker', role: 'img', 'aria-label': '小宿泡在温泉里庆祝' }, petNode('onsen')));
  return turn;
}

const STICKER_PLAY_MS = 12000;

/** A sticker that just arrived plays as Rive for a few seconds, then holds still. */
function playSticker(turn) {
  const sticker = turn.querySelector('.sticker');
  const ctl = sticker && rivePetReady() ? mountRivePet(sticker, 'Onsen') : null;
  if (ctl) setTimeout(() => ctl.pause(), STICKER_PLAY_MS);
}

function clearQuickReplies() {
  for (const el of els.messages.querySelectorAll('.quick')) el.remove();
}

/** Buttons for the answers the turn's last bubble suggests (none while a confirmation waits for its tap). */
function offerQuickReplies(turn) {
  clearQuickReplies();
  const bubbles = turn.querySelectorAll('.bubble-in');
  const last = bubbles[bubbles.length - 1];
  if (!last || turn.querySelector('[data-card][data-status="pending"], [data-card][data-status="open"]')) return [];
  // 「订第1家」 expands over the numbered list in the bubble, or else over the hotels (rooms) on the turn's card.
  const lists = last.querySelectorAll('ol');
  const picks = [...turn.querySelectorAll('[data-card="hotels"], [data-card="rooms"]')].pop();
  const count = lists.length ? lists[lists.length - 1].children.length
    : picks ? picks.querySelectorAll('[data-action="pick-hotel"], .room-block').length : 0;
  const replies = quickReplies(last.textContent, count);
  if (replies.length) {
    turn.after(h('div', { class: 'quick', role: 'group', 'aria-label': '快捷回复' },
      replies.map((r) => chatButton(r, r, { cls: 'quick-chip', action: 'quick-reply' }))));
  }
  return replies;
}

/** What the pet's status line says once a reply is done: the next step, if there is one. */
function guideFor(turn, replies) {
  if (turn.querySelector('[data-card="booking_quote"][data-status="pending"]')) return '核对好就点「确认预订」哦';
  if (turn.querySelector('[data-card="cancel_preview"][data-status="open"]')) return '确定的话点「确认取消」';
  if (turn.querySelector('[data-card="ride_quote"][data-status="quoted"]')) return '没问题就点「确认叫车」';
  if (turn.querySelector('[data-card="extension_quote"][data-status="pending"]')) return '点「确认续住」就续上啦';
  if (turn.querySelector('[data-card="review_draft"][data-status="draft"]')) return '满意的话点「发布点评」';
  if (turn.querySelector('[data-card="hotels"]')) return '点一家看看房型～';
  if (turn.querySelector('[data-card="rooms"]')) return '挑好了点「订」';
  if (replies.length) return '点下面的按钮就能回我～';
  return PET_IDLE;
}

function textBubble(text) {
  return mdBlock(text, 'bubble bubble-in md');
}

function typingDots() {
  return h('div', { class: 'typing', 'aria-label': '正在输入' }, h('span'), h('span'), h('span'));
}

function errorLine(message, retry) {
  const line = h('div', { class: 'error-line', role: 'alert' }, h('span', { text: message || '出了点问题，稍后再试。' }));
  if (retry) {
    const btn = h('button', { type: 'button', class: 'link-btn', 'data-action': 'retry', 'data-lock': '' }, '重新发送');
    btn.disabled = state.busy;
    btn.addEventListener('click', retry);
    line.append(btn);
  }
  return line;
}

/** One reply as it streams in: each run of text becomes a bubble; confirmations arrive as their own bubbles. */
function createReply() {
  const el = assistantTurn({ live: true });
  const body = turnBody(el);
  const dots = typingDots();
  body.append(dots);
  let bubble = null;
  let raw = '';
  let frame = 0;
  let ended = false;
  let errored = false;

  const render = () => {
    frame = 0;
    if (bubble) bubble.innerHTML = renderMarkdown(raw);
  };
  const flush = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      render();
    }
  };
  const closeBubble = () => {
    flush();
    bubble = null;
  };
  // The dots stay at the end of the reply until it is finished.
  const add = (node) => placeIn(el, node, dots);

  return {
    el,
    get errored() { return errored; },
    hasContent: () => el.querySelector('.bubble, .error-line') !== null,
    delta(text) {
      if (ended || typeof text !== 'string' || !text) return;
      if (!bubble) {
        bubble = add(h('div', { class: 'bubble bubble-in md' }));
        raw = '';
      }
      if (pet.mood !== 'talking') {
        petMood('talking');
        petStatus('正在输入…');
      }
      raw += text;
      if (!frame) frame = requestAnimationFrame(render);
    },
    // A tool is running (正在查找杭州西湖附近的酒店…): the pet is busy thinking.
    status(text) {
      if (ended || typeof text !== 'string' || !text.trim()) return;
      petMood('thinking');
      petStatus(text.trim().slice(0, 40));
    },
    card(card) {
      if (ended) return;
      const node = renderCard(card);
      if (!node) return;
      closeBubble();
      add(node);
    },
    error(message, retry) {
      if (ended) return;
      errored = true;
      closeBubble();
      add(errorLine(message, retry));
    },
    stopped() {
      closeBubble();
      add(h('p', { class: 'muted-line', text: '已停止' }));
    },
    // The provider flagged this reply: drop everything it showed before the canned answer arrives.
    retract() {
      if (ended) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      bubble = null;
      raw = '';
      errored = false;
      for (const node of [...body.children]) if (node !== dots) node.remove();
    },
    finish() {
      closeBubble();
      ended = true;
      dots.remove();
      if (!el.querySelector('.bubble, .error-line, .muted-line')) add(h('p', { class: 'muted-line', text: '这次没有收到回复，换个说法再试试。' }));
      // The reply is done: its avatar stops following the pet's mood and goes back to the still drawing.
      const host = el.querySelector('.turn-avatar');
      host?.petRive?.destroy();
      const avatar = host?.querySelector('.pet');
      avatar?.removeAttribute('data-live');
      if (avatar) avatar.dataset.mood = errored ? 'oops' : 'idle';
    },
  };
}

// ---------------------------------------------------------------------------
// Cards: the booking and cancellation confirmations are drawn here, everything else by cards.js.
// ---------------------------------------------------------------------------

const quoteOf = new WeakMap();

function renderCard(card) {
  if (!card || typeof card !== 'object') return null;
  if (card.type === 'booking_quote') return quoteBubble(card);
  if (card.type === 'cancel_preview') return cancelBubble(card);
  return cards ? cards.render(card) : null;
}

function cardRow(label, value, cls = '') {
  if (!value) return null;
  return h('div', { class: `card-row${cls ? ` ${cls}` : ''}` }, h('dt', { text: label }), h('dd', { text: value }));
}

/** 小宿 peeking over the top edge of a confirmation, paws on the edge; its face follows the card's state. */
function peekPet() {
  return h('div', { class: 'card-peek', 'data-pet-poke': '' }, petNode('peek'));
}

function setPeekMood(el, mood) {
  const svg = el.querySelector('.card-peek .pet');
  if (svg) svg.dataset.mood = mood;
}

/** The booking confirmation, laid out like a receipt: what, when, who, cancellation terms, total. */
function quoteBubble(card) {
  const q = card.quote && typeof card.quote === 'object' ? card.quote : {};
  const hotel = q.hotel || {};
  const room = q.room || {};
  const rate = q.rate || {};
  const policy = rate.cancelPolicy;
  const guests = Array.isArray(q.guests) ? q.guests.join('、') : '';
  const inYear = Number(String(q.checkIn || '').slice(0, 4)) || cnYear();
  const el = h('div', { class: 'card has-peek', 'data-card': 'booking_quote', 'data-quote-id': q.id || '' },
    peekPet(),
    h('p', { class: 'card-kicker', text: '确认单' }),
    h('p', { class: 'card-title', text: hotel.name || '预订确认' }),
    h('p', { class: 'card-sub', text: [room.name, BREAKFAST_LABELS[rate.breakfast] || ''].filter(Boolean).join(' · ') }),
    h('dl', { class: 'card-rows' },
      cardRow('入住', formatDate(q.checkIn)),
      cardRow('离店', q.checkOut ? `${formatDate(q.checkOut, true, inYear)} · ${q.nights || 1}晚` : ''),
      cardRow('房间', `${q.rooms || 1}间`),
      cardRow('入住人', [guests, q.contactPhone].filter(Boolean).join(' · ')),
      cardRow('取消', policy?.text, policy && (policy.type === 'none' || policyLapsed(policy)) ? 'is-warn' : '')),
    h('div', { class: 'card-total' }, h('span', { text: '合计' }), h('span', { class: 'card-amount', text: formatYuan(q.totalPrice) })),
    h('div', { class: 'confirm-actions' }));
  quoteOf.set(el, q);
  renderQuoteState(el, q);
  // The server keeps one pending quote per chat: a new one replaces every pending one above it.
  if (q.status === 'pending') {
    for (const old of document.querySelectorAll('[data-card="booking_quote"][data-status="pending"]')) {
      const oq = quoteOf.get(old);
      if (old !== el && oq && oq.id !== q.id) renderQuoteState(old, { ...oq, status: 'superseded' });
    }
  }
  return el;
}

function quoteExpired(q) {
  const at = Date.parse(q.expiresAt);
  return q.status === 'expired' || (q.status === 'pending' && !Number.isNaN(at) && at <= serverNow());
}

function renderQuoteState(el, q, failure = null) {
  const box = el.querySelector('.confirm-actions');
  box.replaceChildren();
  quoteOf.set(el, q);
  const expired = quoteExpired(q);
  el.dataset.status = failure ? 'failed' : expired ? 'expired' : q.status || '';
  // Waiting for you; delighted once it is booked; dozed off if you let it expire.
  setPeekMood(el, failure ? 'oops' : q.status === 'confirmed' ? 'happy' : expired ? 'sleepy' : 'idle');
  if (failure) {
    box.append(h('p', { class: 'confirm-note is-warn', text: failure.message }), chatButton('重新报价', requoteMessage(q), { cls: 'btn btn-secondary', action: 'requote' }));
  } else if (q.status === 'confirmed') {
    box.append(h('p', { class: 'confirm-note' }, icon('paw'), h('span', { text: '已下单' })));
  } else if (q.status === 'superseded') {
    box.append(h('p', { class: 'confirm-note', text: '已换成新的确认单' }));
  } else if (expired) {
    box.append(h('p', { class: 'confirm-note', text: '确认单已过期' }), chatButton('重新报价', requoteMessage(q), { cls: 'btn btn-secondary', action: 'requote' }));
  } else {
    const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'confirm-pay' }, `确认预订 ${formatYuan(q.totalPrice)}`);
    btn.addEventListener('click', () => {
      const current = quoteOf.get(el) || q;
      if (quoteExpired(current)) renderQuoteState(el, { ...current, status: 'expired' });
      else onConfirm(el, current);
    });
    box.append(btn);
  }
}

async function onConfirm(el, quote) {
  const result = await openPaymentSheet(quote);
  if (!result) return;
  if (result.error) {
    renderQuoteState(el, { ...quote, status: result.error.code === 'superseded' ? 'superseded' : quote.status }, result.error);
    if (result.order) await syncNotices();
    if (result.requote) send(requoteMessage(quote));
    return;
  }
  if (result.paid) {
    renderQuoteState(el, { ...quote, status: 'confirmed', orderId: result.order.id });
    refreshPlans();
    await syncNotices({ kind: 'paid', cards: [{ type: 'order', order: result.order }] });
  }
}

/** Resolves null (closed), { order, paid: true } or { order?, error: { code, message }, requote }. */
function openPaymentSheet(quote) {
  const hotel = quote.hotel || {};
  return new Promise((resolve) => {
    let outcome = null;
    let inflight = null;
    let finished = false;
    const ctl = openModal({ title: '支付' });
    const options = payOptions(`pay-${ctl.seq}`);
    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const payBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'pay' }, `支付 ${formatYuan(quote.totalPrice)}`);
    ctl.body.append(
      h('div', { class: 'pay-head' },
        h('p', { class: 'pay-merchant', text: `${state.appName} · 模拟收银台` }),
        h('p', { class: 'pay-amount', text: formatYuan(quote.totalPrice) }),
        h('p', { class: 'pay-desc', text: [hotel.name, `${formatDate(quote.checkIn)}入住`, `${quote.nights || 1}晚`].filter(Boolean).join(' · ') })),
      options,
      h('p', { class: 'pay-note', text: '模拟支付，不会扣款' }),
      errorEl,
      payBtn);

    const busy = (on) => {
      ctl.lock(on);
      payBtn.disabled = on;
      for (const input of options.querySelectorAll('input')) input.disabled = on;
      payBtn.replaceChildren(...(on ? [spinner(), '正在支付…'] : [`支付 ${formatYuan(quote.totalPrice)}`]));
    };
    // Confirming is idempotent on the server, so a retry after a failed payment reuses the same order.
    const run = async () => {
      const method = options.querySelector('input:checked')?.value || 'wechat';
      let order = (await api('POST', `/api/quotes/${enc(quote.id)}/confirm`, {})).order;
      if (!order) throw new ApiError(0, 'bad_response', '下单失败，稍后再试。');
      outcome = { order, paid: false };
      if (order.status === 'pending_payment') order = (await api('POST', `/api/orders/${enc(order.id)}/pay`, { method })).order || order;
      if (order.status !== 'confirmed') throw new ApiError(0, order.status, order.status === 'closed' ? '订单已超时关闭，请重新报价。' : '订单状态变了，请重新报价。');
      return order;
    };
    payBtn.addEventListener('click', async () => {
      if (finished) {
        outcome = { ...outcome, requote: payBtn.dataset.action === 'requote' };
        ctl.close();
        return;
      }
      errorEl.hidden = true;
      busy(true);
      inflight = run();
      try {
        const order = await inflight;
        outcome = { order, paid: true };
        ctl.lock(false);
        ctl.close();
      } catch (err) {
        busy(false);
        errorEl.textContent = err.message || '支付失败，稍后再试。';
        errorEl.hidden = false;
        if (REQUOTE_CODES.has(err.code) || ['closed', 'cancelled'].includes(err.code)) {
          outcome = { ...(outcome?.order ? { order: outcome.order } : {}), error: { code: err.code, message: err.message } };
          finished = true;
          payBtn.dataset.action = 'requote';
          payBtn.textContent = '重新报价';
        } else {
          payBtn.textContent = '重试';
        }
      } finally {
        inflight = null;
      }
    });
    ctl.closed.then(async () => {
      if (inflight) await inflight.catch(() => {});
      resolve(outcome);
    });
    payBtn.focus();
  });
}

/** WeChat Pay / Alipay radio buttons for the simulated checkout. */
function payOptions(group) {
  return h('div', { class: 'pay-options', role: 'radiogroup', 'aria-label': '支付方式' },
    Object.entries(PAY_METHODS).map(([key, label], i) => h('label', { class: 'pay-option', 'data-method': key },
      h('span', { class: `pay-mark pay-mark-${key}`, 'aria-hidden': 'true', text: key === 'wechat' ? '微' : '支' }),
      h('span', { class: 'pay-name', text: label }),
      h('input', { type: 'radio', name: group, value: key, checked: i === 0 }))));
}

/**
 * The simulated checkout for anything other than a booking (an extension…). `run(method)` does the server call;
 * resolves its result, or null when the sheet is closed without paying.
 */
function openPaySheet({ title, amount, desc, run }) {
  return new Promise((resolve) => {
    let result = null;
    let inflight = null;
    let finished = false;
    const ctl = openModal({ title });
    const options = payOptions(`pay-${ctl.seq}`);
    const label = `支付 ${formatYuan(amount)}`;
    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const payBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'pay' }, label);
    ctl.body.append(
      h('div', { class: 'pay-head' },
        h('p', { class: 'pay-merchant', text: `${state.appName} · 模拟收银台` }),
        h('p', { class: 'pay-amount', text: formatYuan(amount) }),
        h('p', { class: 'pay-desc', text: desc || '' })),
      options,
      h('p', { class: 'pay-note', text: '模拟支付，不会扣款' }),
      errorEl,
      payBtn);
    const busy = (on) => {
      ctl.lock(on);
      payBtn.disabled = on;
      for (const input of options.querySelectorAll('input')) input.disabled = on;
      payBtn.replaceChildren(...(on ? [spinner(), '正在支付…'] : [label]));
    };
    payBtn.addEventListener('click', async () => {
      if (finished) {
        ctl.close();
        return;
      }
      errorEl.hidden = true;
      busy(true);
      inflight = Promise.resolve().then(() => run(options.querySelector('input:checked')?.value || 'wechat'));
      try {
        result = await inflight;
        ctl.lock(false);
        ctl.close();
      } catch (err) {
        busy(false);
        errorEl.textContent = err.message || '支付失败，稍后再试。';
        errorEl.hidden = false;
        // Expired or sold out: paying again cannot help.
        finished = [409, 410].includes(err.status);
        payBtn.textContent = finished ? '知道了' : '重试';
      } finally {
        inflight = null;
      }
    });
    ctl.closed.then(async () => {
      if (inflight) await inflight.catch(() => {});
      resolve(result);
    });
    payBtn.focus();
  });
}

/** The simulated digital key: hold the phone to the lock and the door opens. */
function openKeySheet(stay) {
  const ctl = openModal({ title: '电子房卡' });
  const HINT = '把手机靠近门锁';
  const hint = h('span', { class: 'keycard-hint', text: HINT });
  const card = h('div', { class: 'keycard' },
    h('span', { class: 'keycard-hotel', text: stay.hotel?.name || '' }),
    h('span', { class: 'keycard-num', text: stay.roomNumber || '' }),
    h('span', { class: 'keycard-waves', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), icon('key')),
    hint);
  const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'unlock' }, icon('door'), '开门');
  btn.addEventListener('click', () => {
    card.classList.add('is-open');
    hint.textContent = '门开啦，欢迎回来～';
    btn.disabled = true;
    petFlash('门开啦，好好休息～', 3000);
    setTimeout(() => {
      card.classList.remove('is-open');
      hint.textContent = HINT;
      btn.disabled = false;
    }, 3000);
  });
  ctl.body.append(card,
    h('p', { class: 'keycard-note', text: [stay.keyValidUntil ? `有效期至 ${dayTime(stay.keyValidUntil)}` : '', '模拟房卡，演示用'].filter(Boolean).join(' · ') }),
    btn);
}

function cancelBubble(card) {
  const order = card.order && typeof card.order === 'object' ? card.order : {};
  const orderId = card.orderId || order.id;
  const hotel = order.hotel || {};
  const penalty = Number(card.penalty) || 0;
  const refund = Number(card.refund) || 0;
  const el = h('div', { class: 'card has-peek', 'data-card': 'cancel_preview', 'data-order-id': orderId || '' },
    peekPet(),
    h('p', { class: 'card-kicker', text: '取消订单' }),
    h('p', { class: 'card-title', text: hotel.name || '订单' }),
    h('dl', { class: 'card-rows' },
      cardRow('订单号', orderId),
      cardRow('入住', formatDate(order.checkIn)),
      order.payment
        ? [cardRow('违约金', penalty > 0 ? formatYuan(penalty) : '免费取消', penalty > 0 ? 'is-warn' : ''), cardRow('退款', refund > 0 ? formatYuan(refund) : '不退款')]
        : cardRow('费用', '还没付款，取消不收费')),
    h('div', { class: 'confirm-actions' }));
  renderCancelState(el, order.status === 'cancelled' ? 'cancelled' : card.cancellable === false ? 'blocked' : 'open', orderId);
  return el;
}

function renderCancelState(el, status, orderId) {
  const box = el.querySelector('.confirm-actions');
  box.replaceChildren();
  el.dataset.status = status;
  setPeekMood(el, status === 'cancelled' ? 'idle' : 'oops');
  if (status === 'cancelled') box.append(h('p', { class: 'confirm-note' }, icon('check'), h('span', { text: '已取消' })));
  else if (status === 'blocked') box.append(h('p', { class: 'confirm-note is-warn', text: '这单现在不能取消' }));
  else {
    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const btn = h('button', { type: 'button', class: 'btn btn-danger', 'data-action': 'confirm-cancel' }, '确认取消');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.replaceChildren(spinner(), '正在取消…');
      errorEl.hidden = true;
      try {
        const data = await api('POST', `/api/orders/${enc(orderId)}/cancel`, { reason: '用户确认取消' });
        renderCancelState(el, 'cancelled', orderId);
        refreshPlans();
        petFlash('已经帮你取消好啦', 4000);
        await syncNotices(data.order ? { kind: 'cancelled', cards: [{ type: 'order', order: data.order }] } : { kind: 'cancelled', text: '订单已取消。' });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '确认取消';
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
    box.append(errorEl, btn);
  }
}

// ---------------------------------------------------------------------------
// Notices (order paid / cancelled, reply stopped): small centered lines, as stored by the server
// ---------------------------------------------------------------------------

/** Which order event a notice reports, from the server's text (see src/server.js orderNoticeText). */
function noticeKind(text) {
  const s = String(text || '');
  if (/已取消/.test(s)) return 'cancelled';
  if (/支付成功/.test(s)) return 'paid';
  if (/已提交/.test(s)) return 'pending';
  return 'info';
}

const noticeKey = (item) => `${item.at || ''}#${item.text || ''}`;
const noticeOrder = (item) => (Array.isArray(item.cards) ? item.cards.find((c) => c?.type === 'order')?.order : null) || null;

// The server's notice is written for the model (status, payment, dates…); on screen one short line is enough.
function noticeShort(kind, order) {
  if (!order?.id) return '';
  if (kind === 'paid') return `已订好 · 订单号 ${order.id}`;
  if (kind === 'pending') return '已提交订单，等待支付';
  if (kind === 'cancelled') {
    const refund = Number(order.cancellation?.refund) || 0;
    return `订单已取消 · ${refund > 0 ? `退款 ${formatYuan(refund)}（模拟）` : order.payment ? '按取消政策不退款' : '没有产生费用'}`;
  }
  return '';
}

const NOTICE_ICONS = {
  paid: 'paw', ride_confirmed: 'car', extended: 'calendar', review_published: 'star', front_desk_checkin: 'key',
  early_checkin_approved: 'door', early_checkin_declined: 'door', review_replied: 'star',
};

function noticeLine(item) {
  const kind = item.kind || noticeKind(item.text);
  const short = noticeShort(kind, noticeOrder(item));
  const el = h('div', { class: `notice notice-${kind}`, 'data-kind': kind },
    h('div', { class: 'notice-pill' },
      NOTICE_ICONS[kind] ? icon(NOTICE_ICONS[kind], 'icon notice-icon') : null,
      short ? h('p', { class: 'notice-text', text: short }) : mdBlock(item.text || '', 'notice-text')));
  if (item.at) el.dataset.key = noticeKey(item);
  return el;
}

const NOTICE_FLASH = {
  ride_confirmed: '司机师傅接单啦', extended: '续住好啦，多住几天～', review_published: '谢谢你的点评 (｡•ᴗ•｡)',
  front_desk_checkin: '前台帮你办好入住啦', early_checkin_approved: '可以提前入住啦', review_replied: '酒店回复你的点评啦',
};

/** Shows a notice as it happens; a paid booking also gets 小宿's hot-spring sticker. */
function appendNotice(item) {
  const el = append(noticeLine(item));
  if (NOTICE_FLASH[el.dataset.kind]) petFlash(NOTICE_FLASH[el.dataset.kind], 4000);
  if (el.dataset.kind !== 'paid') return el;
  petCelebrate();
  const sticker = append(stickerTurn());
  playSticker(sticker);
  return sticker;
}

// Order actions that finished while a reply was being written: the server stores their notices after it.
let noticesPending = false;

/** Shows the notices (orders, rides, extensions, reviews) stored for this chat that are not on screen yet (or the fallback). */
async function syncNotices(fallback = null) {
  if (state.busy) {
    noticesPending = true;
    return;
  }
  const { epoch, sessionId } = state;
  let items = null;
  try {
    items = sessionId ? (await api('GET', `/api/sessions/${enc(sessionId)}`)).items : null;
  } catch {
    items = null;
  }
  if (epoch !== state.epoch) return;
  if (!Array.isArray(items)) {
    if (fallback) appendNotice(fallback).scrollIntoView({ block: 'nearest' });
    return;
  }
  const shown = new Set([...els.messages.querySelectorAll('.notice[data-key]')].map((el) => el.dataset.key));
  let last = null;
  for (const item of items) {
    const isOrderNotice = Array.isArray(item?.cards) && item.cards.some((c) => c?.type === 'order');
    if (item?.role !== 'notice' || !(isOrderNotice || NOTICE_KINDS.has(item.kind)) || !item.at || shown.has(noticeKey(item))) continue;
    // The server replaces 已提交 with 支付成功 when they arrive back to back.
    last = appendNotice(item);
  }
  if (last) {
    state.stick = true;
    scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// History replay
// ---------------------------------------------------------------------------

function renderHistory(items) {
  const frag = document.createDocumentFragment();
  let turn = null;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.role === 'user') {
      turn = null;
      const stamp = stampFor(Date.parse(item.at));
      if (stamp) frag.append(stamp);
      frag.append(userTurn(String(item.text ?? ''), frag.lastElementChild));
    } else if (item.role === 'assistant') {
      if (!turn) {
        turn = assistantTurn();
        frag.append(turn);
      }
      if (item.text) placeIn(turn, textBubble(item.text));
      for (const card of Array.isArray(item.cards) ? item.cards : []) {
        const node = renderCard(card);
        if (node) placeIn(turn, node);
      }
    } else if (item.role === 'notice') {
      // A stopped or failed reply belongs to its turn; order notices stand on their own.
      if (turn && /^（.*）$/.test(String(item.text || '').trim())) turnBody(turn).append(h('p', { class: 'muted-line', text: String(item.text).trim().slice(1, -1) }));
      else {
        turn = null;
        const notice = frag.appendChild(noticeLine(item));
        if (notice.dataset.kind === 'paid') frag.append(stickerTurn());
      }
    }
  }
  els.messages.prepend(frag);
}

// ---------------------------------------------------------------------------
// Sheets: payment, more menu, 常用入住人
// ---------------------------------------------------------------------------

let modalSeq = 0;

function openModal({ title }) {
  modalSeq += 1;
  const seq = modalSeq;
  const titleId = `sheet-title-${seq}`;
  const previous = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'icon-btn modal-close', 'aria-label': '关闭' }, icon('close'));
  const body = h('div', { class: 'sheet-body' });
  const panel = h('div', { class: 'sheet' },
    h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
    h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', id: titleId, text: title }), closeBtn),
    body);
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': titleId }, panel);
  let locked = false;
  let resolveClosed;
  const ctl = {
    seq,
    dialog,
    body,
    closed: new Promise((resolve) => { resolveClosed = resolve; }),
    lock(value) {
      locked = value;
      closeBtn.disabled = value;
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
  closeBtn.addEventListener('click', () => ctl.close());
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!locked) ctl.close();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && !locked) ctl.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    resolveClosed();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return ctl;
}

function openMenu() {
  const ctl = openModal({ title: '更多' });
  const item = (label, action, fn) => h('button', { type: 'button', class: 'menu-item', 'data-action': action, onclick: () => {
    ctl.close();
    fn();
  } }, label);
  ctl.body.append(h('div', { class: 'menu' },
    item('我的安排', 'open-plans', openPlans),
    item('新对话', 'new-chat', newChat),
    item('常用入住人', 'open-profile', openProfile),
    state.merchant ? item('切换到商家端（演示）', 'open-merchant', () => { location.href = merchantUrl(); }) : null));
}

/** The hotel's console: a page of its own on the server, the same app with ?view=merchant in the phone apps. */
function merchantUrl() {
  return globalThis.xiaosuApp ? '?view=merchant' : 'merchant';
}

function openProfile() {
  buildProfilePane(openModal({ title: '常用入住人' }).body);
}

const PHONE_RE = /^1[3-9]\d{9}$/;
const PHONE_HINT = '酒店联系你用，订单里只显示部分号码。';

function buildProfilePane(pane) {
  const uid = modalSeq;
  const nameInput = h('input', { id: `pf-name-${uid}`, name: 'guestName', type: 'text', maxlength: 20, autocomplete: 'name', placeholder: '与证件一致的姓名' });
  const phoneInput = h('input', { id: `pf-phone-${uid}`, name: 'contactPhone', type: 'tel', inputmode: 'numeric', maxlength: 20, autocomplete: 'tel', placeholder: '11 位手机号' });
  const phoneHint = h('p', { class: 'field-hint', id: `pf-phone-hint-${uid}`, text: PHONE_HINT });
  phoneInput.setAttribute('aria-describedby', phoneHint.id);
  phoneInput.addEventListener('blur', () => {
    const digits = normalizePhoneInput(phoneInput.value);
    if (PHONE_RE.test(digits)) phoneInput.value = digits;
  });
  const clearPhoneBtn = h('button', { type: 'button', class: 'link-btn', 'data-action': 'clear-phone', hidden: true }, '删除已保存的号码');
  const prefInput = h('textarea', { id: `pf-pref-${uid}`, name: 'preferences', rows: 2, maxlength: MAX_PREFERENCES_CHARS, placeholder: '比如：高楼层、安静、无烟房' });
  const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const statusEl = h('p', { class: 'form-status', role: 'status' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', disabled: true }, '保存');
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'form-intro', text: '保存后，订房时自动填好入住人和电话。' }),
    h('div', { class: 'field' }, h('label', { for: nameInput.id, text: '姓名' }), nameInput),
    h('div', { class: 'field' }, h('label', { for: phoneInput.id, text: '手机号' }), phoneInput, phoneHint, clearPhoneBtn),
    h('div', { class: 'field' }, h('label', { for: prefInput.id, text: `住宿偏好（${MAX_PREFERENCES_CHARS} 字以内）` }), prefInput),
    errorEl, saveBtn, statusEl);
  // Only fields the user touched are sent (an omitted field keeps its saved value).
  const dirty = new Set();
  for (const input of [nameInput, phoneInput, prefInput]) input.addEventListener('input', () => dirty.add(input));
  let loading = true;
  const fill = (raw, { keepDirty = false } = {}) => {
    const p = raw && typeof raw === 'object' ? (raw.profile && typeof raw.profile === 'object' ? raw.profile : raw) : {};
    const put = (input, value) => {
      if (!keepDirty || !dirty.has(input)) input.value = value;
    };
    put(nameInput, p.guestName || '');
    put(prefInput, Array.isArray(p.preferences) ? p.preferences.join('、') : p.preferences || '');
    put(phoneInput, '');
    if (!keepDirty) dirty.clear();
    const saved = Boolean(p.hasPhone && p.contactPhone);
    phoneInput.placeholder = saved ? `已保存 ${p.contactPhone}` : '11 位手机号';
    phoneHint.textContent = saved ? '留空表示不修改。' : PHONE_HINT;
    clearPhoneBtn.hidden = !saved;
  };
  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loading) return;
    showError('');
    statusEl.textContent = '';
    const guestName = nameInput.value.trim();
    const phone = normalizePhoneInput(phoneInput.value);
    const preferences = prefInput.value.trim();
    if (dirty.has(nameInput) && guestName && (guestName.length < 2 || guestName.length > 20)) {
      showError('姓名需要 2–20 个字。');
      nameInput.focus();
      return;
    }
    if (phone && !PHONE_RE.test(phone)) {
      showError('请输入正确的 11 位手机号。');
      phoneInput.focus();
      return;
    }
    if (dirty.has(prefInput) && preferences.length > MAX_PREFERENCES_CHARS) {
      showError(`住宿偏好最多 ${MAX_PREFERENCES_CHARS} 个字。`);
      prefInput.focus();
      return;
    }
    const body = {};
    if (dirty.has(nameInput)) body.guestName = guestName;
    if (dirty.has(prefInput)) body.preferences = preferences;
    if (phone) body.contactPhone = phone;
    if (!Object.keys(body).length) {
      statusEl.textContent = '没有需要保存的修改。';
      return;
    }
    saveBtn.disabled = true;
    saveBtn.replaceChildren(spinner(), '保存中…');
    try {
      fill(await api('PUT', '/api/profile', body));
      statusEl.textContent = '已保存';
    } catch (err) {
      showError(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });
  clearPhoneBtn.addEventListener('click', async () => {
    showError('');
    clearPhoneBtn.disabled = true;
    try {
      fill(await api('PUT', '/api/profile', { contactPhone: null }), { keepDirty: true });
      statusEl.textContent = '已删除保存的手机号';
    } catch (err) {
      showError(err.message);
    } finally {
      clearPhoneBtn.disabled = false;
    }
  });
  pane.append(form);
  api('GET', '/api/profile').then((data) => fill(data, { keepDirty: true })).catch((err) => {
    if (err.status !== 404) showError(`没能读取已保存的信息：${err.message}`);
  }).finally(() => {
    loading = false;
    saveBtn.disabled = false;
  });
}

function toast(message) {
  const el = h('div', { class: 'toast', text: message });
  els.toasts.append(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------------------------------------------------------------------------
// My plans: booked stays and whatever is on its way, under the header (GET /api/stays). While a ride, a delivery or
// an invoice is moving, it is refreshed every PLAN_POLL_MS, and the cards for it on screen follow.
// ---------------------------------------------------------------------------

let plansTimer = 0;
let plansSeq = 0;
let plansSignature = '';

const isMoving = (r) => Boolean(MOVING[r?.kind]?.includes(r.status));

function planChip(iconName, text, live) {
  const chip = h('button', { type: 'button', class: `plan-chip${live ? ' is-live' : ''}`, 'data-action': 'open-plans' },
    icon(iconName), h('span', { class: 'plan-chip-text', text }));
  chip.addEventListener('click', openPlans);
  return chip;
}

function movingChip(r) {
  const label = STATUS_LABELS[r.kind]?.[r.status] || '';
  if (r.kind === 'ride') return planChip(r.rideKind === 'airport_pickup' ? 'plane' : 'car', `${r.driver?.name || r.kindLabel || '叫车'} · ${label}`, true);
  if (r.kind === 'service') return planChip('box', `${r.items?.[0]?.name || '客房服务'} · ${label}`, true);
  return planChip('invoice', `发票 · ${label}`, true);
}

function renderPlans() {
  const chips = [];
  for (const { order, stay, requests } of state.stays) {
    const name = order?.hotel?.name || '酒店';
    if (stay && !stay.checkedOutAt) chips.push(planChip('key', `${stay.roomNumber || ''} 房 · ${name}`, false));
    else if (!stay) chips.push(planChip('hotel', `${formatDate(order?.checkIn, false)}入住 · ${name}`, false));
    // After check-out only what still matters shows: an invoice, a ride away from the hotel.
    const left = Boolean(stay?.checkedOutAt);
    for (const r of Array.isArray(requests) ? requests : []) {
      if (!isMoving(r)) continue;
      if (left && (r.kind === 'service' || (r.kind === 'ride' && ['to_hotel', 'airport_pickup'].includes(r.rideKind)))) continue;
      chips.push(movingChip(r));
    }
  }
  els.plans.replaceChildren(...chips);
  els.plans.hidden = !chips.length;
}

async function refreshPlans() {
  clearTimeout(plansTimer);
  const seq = ++plansSeq;
  let stays = null;
  try {
    const data = await api('GET', '/api/stays');
    stays = Array.isArray(data.stays) ? data.stays : [];
  } catch {
    // Keep what is on screen; the next refresh tries again.
  }
  if (seq !== plansSeq) return;
  if (stays) {
    const before = plansSignature;
    state.stays = stays.filter((s) => s && typeof s === 'object');
    plansSignature = JSON.stringify(state.stays);
    renderPlans();
    for (const s of state.stays) for (const r of Array.isArray(s.requests) ? s.requests : []) cards.update(r);
    // Something changed that this page did not do (the front desk checked them in, the hotel replied…): its notice.
    if (before && before !== plansSignature) syncNotices();
  }
  const wait = nextPlansRefresh();
  if (wait != null && !document.hidden) plansTimer = setTimeout(refreshPlans, wait);
}

/** How long until my plans should be looked at again (null: nothing is moving). */
function nextPlansRefresh() {
  const today = new Date(serverNow() + 8 * 3600000).toISOString().slice(0, 10);
  const here = state.stays.some(({ order, stay }) => !stay?.checkedOutAt && order?.checkIn <= today && order?.checkOut >= today);
  let wait = here ? PLAN_IDLE_MS : null;
  for (const s of state.stays) {
    for (const r of Array.isArray(s.requests) ? s.requests : []) {
      if (!isMoving(r)) continue;
      const pickup = r.kind === 'ride' && r.status === 'confirmed' ? Date.parse(r.pickupAt) : NaN;
      const until = Number.isNaN(pickup) ? 0 : pickup - RIDE_SOON_MS - serverNow();
      const next = until > 0 ? Math.min(until, PLAN_WAIT_MAX_MS) : PLAN_POLL_MS;
      wait = wait == null ? next : Math.min(wait, next);
    }
  }
  return wait;
}

/** Everything booked, one group per stay: the stay (with its key once checked in), then its requests, newest first. */
function openPlans() {
  const ctl = openModal({ title: '我的安排' });
  if (!state.stays.length) {
    ctl.body.append(h('p', { class: 'form-intro', text: `还没有订好的酒店。跟${state.appName}说说想住哪儿吧～` }));
  }
  for (const { order, stay, requests } of state.stays) {
    const list = (Array.isArray(requests) ? [...requests] : []).reverse().map((r) => cards.forRequest(r)).filter(Boolean);
    ctl.body.append(h('section', { class: 'plan-group' }, cards.render({ type: 'trip', order, stay }), list));
  }
  refreshPlans();
}

// ---------------------------------------------------------------------------
// The call: 打给小宿 starts it (a timer, the line above the call bar, the mic ready); the red button hangs up.
// Talking is simulated: the mic opens a panel of sentences to "say", typed out as if transcribed, then sent.
// ---------------------------------------------------------------------------

function callClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function updateCallLine() {
  if (!els.callText) return;
  const live = state.call.live;
  const talking = state.speaking || pet.mood === 'talking';
  let text = '';
  if (live) {
    if (state.voiceOpen) text = '通话中';
    else if (talking) text = `${state.appName}在说 · 可以直接插话`;
    else if (state.busy) text = `${state.appName}在想…`;
    else text = '通话中 · 点麦克风说话';
  }
  if (els.callText.textContent !== text) els.callText.textContent = text;
  els.callWave.classList.toggle('is-on', live && (talking || state.voiceOpen));
  els.callTime.textContent = live ? callClock(Date.now() - state.call.startedAt) : '00:00';
}

function startCall() {
  if (state.call.live) return;
  state.call = { live: true, startedAt: Date.now(), timer: setInterval(updateCallLine, 1000) };
  els.app.dataset.call = 'live';
  els.callBtn.setAttribute('aria-label', '挂断');
  petWake();
  petFlash('喂～我在听', 2400);
  // Spoken from the tap itself: iOS only lets a page talk after a tap.
  speak(`喂，我是${state.appName}，想住哪儿呀？`);
  openVoice();
}

function endCall() {
  if (!state.call.live) return;
  const length = callClock(Date.now() - state.call.startedAt);
  clearInterval(state.call.timer);
  state.call = { live: false, startedAt: 0, timer: 0 };
  els.app.dataset.call = 'idle';
  els.callBtn.setAttribute('aria-label', `打给${state.appName}`);
  closeVoice();
  stopSpeaking();
  updateCallLine();
  petFlash(`通话结束 ${length}`, 2400);
  if (!document.getElementById('welcome')) append(h('div', { class: 'stamp', text: `通话结束 · ${length}` }));
}

/** Where the current trip is: start (nothing booked) / booked / staying / left. */
function tripPhase() {
  const current = state.stays[0];
  if (!current) return 'start';
  return current.stay?.checkedOutAt ? 'left' : current.stay ? 'staying' : 'booked';
}

/** What you could say now: the answers the last reply offered, then what fits where the trip is. */
function voiceSays() {
  const says = [...els.messages.querySelectorAll('.quick [data-action="quick-reply"]')].map((b) => b.textContent);
  says.push(...VOICE_SAYS[tripPhase()]);
  return [...new Set(says)].slice(0, 5);
}

let voiceToken = 0;

function openVoice() {
  if (state.voiceOpen) return;
  state.voiceOpen = true;
  els.voiceHeard.textContent = '';
  els.voiceSays.replaceChildren(...voiceSays().map((text) => h('button', {
    type: 'button', class: 'voice-say', 'data-action': 'say', onclick: () => sayIt(text),
  }, text)));
  els.voice.hidden = false;
  els.micBtn.classList.add('is-listening');
  els.micBtn.setAttribute('aria-pressed', 'true');
  petWake();
  if (!state.busy) petMood('listening');
  updateCallLine();
}

function closeVoice() {
  if (!state.voiceOpen) return;
  state.voiceOpen = false;
  voiceToken += 1;
  clearTimeout(state.voiceTimer);
  els.voice.hidden = true;
  els.micBtn.classList.remove('is-listening');
  els.micBtn.setAttribute('aria-pressed', 'false');
  if (pet.mood === 'listening') petMood('idle');
  updateCallLine();
}

/** A sentence "heard": typed out as if transcribed, then sent. Talking over a reply stops it (可以直接插话). */
function sayIt(text) {
  const token = ++voiceToken;
  for (const b of els.voiceSays.querySelectorAll('button')) b.disabled = true;
  const instant = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let shown = 0;
  const step = () => {
    if (token !== voiceToken) return;
    shown = instant ? text.length : shown + 1;
    els.voiceHeard.textContent = text.slice(0, shown);
    if (shown < text.length) state.voiceTimer = setTimeout(step, 55);
    else state.voiceTimer = setTimeout(() => heard(token, text), instant ? 0 : 380);
  };
  step();
}

async function heard(token, text) {
  if (token !== voiceToken) return;
  closeVoice();
  if (state.busy) {
    stopTurn();
    await turnSettled();
  }
  send(text, { voice: true });
}

/** Resolves once the reply being written has wound down (at most a few seconds after it was stopped). */
function turnSettled() {
  const until = Date.now() + 5000;
  return new Promise((resolve) => {
    const check = () => (state.busy && Date.now() < until ? setTimeout(check, 50) : resolve());
    check();
  });
}

// In a call, replies are read aloud where the browser has a Mandarin voice (the Android app's WebView has none).
function mandarinVoice() {
  const synth = globalThis.speechSynthesis;
  if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return null;
  const voices = synth.getVoices();
  return voices.find((v) => /^zh[-_](CN|Hans)/i.test(v.lang)) || voices.find((v) => /^cmn/i.test(v.lang)) || null;
}

/** Plain words to say: no Markdown, links, emoji or kaomoji (｡•ᴗ•｡). */
export function speakable(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[（(][^（）()\p{Script=Han}]{1,16}[）)]/gu, '')
    .replace(/[*`#>|_]/g, '')
    .replace(/[~～]+/g, '，')
    .replace(/\s+/g, ' ')
    .replace(/，(?=[，。！？]|$)/g, '')
    .trim()
    .slice(0, 240);
}

function speak(text) {
  const voice = state.call.live ? mandarinVoice() : null;
  const words = speakable(text);
  if (!voice || !words) return false;
  const synth = globalThis.speechSynthesis;
  synth.cancel();
  const u = new globalThis.SpeechSynthesisUtterance(words);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 1.08;
  u.pitch = 1.2;
  u.onstart = () => {
    state.speaking = true;
    if (!state.busy && pet.mood !== 'listening') petMood('talking');
    updateCallLine();
  };
  u.onend = () => {
    state.speaking = false;
    if (pet.mood === 'talking' && !state.busy) petMood('idle');
    updateCallLine();
  };
  u.onerror = u.onend;
  synth.speak(u);
  return true;
}

function stopSpeaking() {
  const synth = globalThis.speechSynthesis;
  if (synth && (state.speaking || synth.speaking || synth.pending)) synth.cancel();
  state.speaking = false;
}

function bindCall() {
  els.callBtn.addEventListener('click', () => (state.call.live ? endCall() : startCall()));
  els.micBtn.addEventListener('click', () => (state.voiceOpen ? closeVoice() : openVoice()));
  els.input.addEventListener('focus', closeVoice);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.voiceOpen && !document.querySelector('dialog[open]')) closeVoice();
  });
  // Voices load late in some browsers; asking once starts the loading.
  globalThis.speechSynthesis?.getVoices?.();
}

// ---------------------------------------------------------------------------
// Chat turn
// ---------------------------------------------------------------------------

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const data = await api('POST', '/api/sessions', {});
  if (!data.sessionId) throw new ApiError(0, 'bad_response', '创建对话失败，稍后再试。');
  setSession(String(data.sessionId));
  return state.sessionId;
}

async function streamTurn(message, reply, retry, epoch) {
  const ctrl = new AbortController();
  state.abort = ctrl;
  updateSendButton();
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: requestHeaders(true, 'text/event-stream'),
      body: JSON.stringify({ sessionId: state.sessionId, message }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    if (ctrl.signal.aborted) return { aborted: true };
    throw new ApiError(0, 'network', MSG_NETWORK);
  }
  noteServerClock(res);
  if (!res.ok) throw toApiError(res.status, await readJson(res));
  if (!(res.headers.get('content-type') || '').includes('text/event-stream') || !res.body) {
    const data = await readJson(res);
    throw data && data.error ? toApiError(res.status, data) : new ApiError(res.status, 'bad_stream', '服务返回了无法识别的内容，稍后再试。');
  }
  let done = false;
  const parser = createSseParser((event, data) => {
    if (epoch !== state.epoch) return;
    try {
      if (event === 'delta') reply.delta(data.text);
      else if (event === 'status') reply.status(data.text);
      else if (event === 'card') reply.card(data.card);
      else if (event === 'retract') reply.retract();
      else if (event === 'error') reply.error(typeof data.message === 'string' ? data.message : '', retry);
      else if (event === 'session' && typeof data.sessionId === 'string' && data.sessionId) setSession(data.sessionId);
      else if (event === 'done') done = true;
    } catch (err) {
      console.error('处理事件失败', event, err);
    }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch {
    if (ctrl.signal.aborted) return { aborted: true };
    throw new ApiError(0, 'stream_cut', MSG_STREAM_CUT);
  } finally {
    if (state.abort === ctrl) state.abort = null;
  }
  return { done };
}

/** After a reply: a worried pet if it failed; otherwise quick replies under it and the next step in the status line. */
function settlePet(reply, stopped) {
  if (reply.errored) {
    petMood('oops');
    petStatus('出了点小状况…');
    return;
  }
  petMood('idle');
  petStatus(stopped ? PET_IDLE : guideFor(reply.el, offerQuickReplies(reply.el)));
}

async function send(text, { userEl = null, voice = false } = {}) {
  const message = String(text ?? '').trim();
  if (!message || state.busy) return;
  if (message.length > MAX_MESSAGE_CHARS) {
    toast(`消息太长了，请控制在 ${MAX_MESSAGE_CHARS} 字以内。`);
    return;
  }
  removeWelcome();
  closeVoice();
  stopSpeaking();
  clearQuickReplies();
  const epoch = state.epoch;
  let bubble = userEl;
  if (!bubble) {
    const stamp = stampFor(Date.now());
    if (stamp) append(stamp);
    bubble = append(userTurn(message, els.messages.lastElementChild, { voice }));
  }
  const reply = createReply();
  append(reply.el);
  if (rivePetReady()) mountRivePet(reply.el.querySelector('.turn-avatar'), 'Head', { mood: pet.mood });
  state.stick = true;
  setBusy(true);
  scrollToBottom();
  petWake();
  petMood('thinking');
  petStatus('在想…');
  let stopped = false;
  const retry = () => {
    if (state.busy) return;
    if (!reply.el.querySelector('.bubble')) {
      reply.el.remove();
      send(message, { userEl: bubble.isConnected ? bubble : null });
    } else {
      send(message);
    }
  };
  try {
    await ensureSession();
    if (epoch !== state.epoch) return;
    let result;
    try {
      result = await streamTurn(message, reply, retry, epoch);
    } catch (err) {
      if (err.status !== 404 || epoch !== state.epoch) throw err;
      // An in-memory server forgets sessions when it restarts; continue in a fresh one.
      setSession(null);
      await ensureSession();
      result = await streamTurn(message, reply, retry, epoch);
    }
    if (epoch !== state.epoch) return;
    if (result.aborted) {
      stopped = true;
      reply.stopped();
    } else if (!result.done && !reply.errored) reply.error(MSG_STREAM_CUT, retry);
  } catch (err) {
    if (epoch === state.epoch) reply.error(err.message || MSG_NETWORK, retry);
  } finally {
    reply.finish();
    if (epoch === state.epoch) {
      setBusy(false);
      settlePet(reply, stopped);
      // In a call the reply is said out loud; typing, the cursor goes back to the box.
      if (state.call.live) {
        if (!reply.errored && !stopped) speak([...reply.el.querySelectorAll('.bubble-in')].map((b) => b.textContent).join('。'));
      } else if (window.matchMedia?.('(pointer: fine)').matches && !document.querySelector('dialog[open]')) {
        els.input.focus();
      }
      if (noticesPending) {
        noticesPending = false;
        syncNotices();
      }
      // A tool may have booked, arranged or changed something.
      refreshPlans();
    }
  }
}

function stopTurn() {
  if (state.abort) state.abort.abort();
}

// ---------------------------------------------------------------------------
// Welcome, thread note, boot
// ---------------------------------------------------------------------------

/**
 * A line of the welcome balloon, typed out a few characters at a time. The full text is laid out (invisibly)
 * from the start so nothing below jumps, and screen readers get it at once.
 */
function typedLine(tag, cls, text) {
  const typed = h('span', { class: 'typed', 'aria-hidden': 'true' });
  const el = h(tag, { class: cls }, h('span', { class: 'ghost', 'aria-hidden': 'true', text }), typed, h('span', { class: 'sr-only', text }));
  return { el, typed, text };
}

function typeOut(lines, isCurrent) {
  const instant = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let line = 0;
  let shown = 0;
  const step = () => {
    if (!isCurrent()) return;
    const current = lines[line];
    if (!current) return;
    shown = instant ? current.text.length : Math.min(current.text.length, shown + 2);
    current.typed.textContent = current.text.slice(0, shown);
    if (shown >= current.text.length) {
      line += 1;
      shown = 0;
    }
    if (line < lines.length) setTimeout(step, instant ? 0 : 45);
  };
  setTimeout(step, instant ? 0 : 250);
}

function renderWelcome() {
  removeWelcome();
  const big = petNode('body');
  big.setAttribute('data-live', '');
  big.dataset.mood = pet.mood;
  const title = typedLine('h2', 'welcome-title', `${greeting()}，我是${state.appName}`);
  const phase = tripPhase();
  const current = state.stays[0];
  const hotel = current?.order?.hotel?.name || '酒店';
  const subText = {
    start: WELCOME_SUB,
    booked: `${formatDate(current?.order?.checkIn, false)}入住「${hotel}」，规划行程、叫车、提前入住都可以找我～`,
    staying: `住在 ${current?.stay?.roomNumber || ''} 房，要毛巾、叫醒、早餐、续住，跟我说一声就好～`,
    left: '欢迎下次再来～开发票、写点评、查积分都可以找我。',
  }[phase];
  const sub = typedLine('p', 'welcome-sub', subText);
  const el = h('section', { class: 'welcome', id: 'welcome', 'aria-label': '开始' },
    h('button', { type: 'button', class: 'welcome-pet', 'data-pet-poke': '', 'aria-label': `摸摸${state.appName}` },
      big, h('span', { class: 'pet-pop', 'aria-hidden': 'true', hidden: true })),
    h('div', { class: 'welcome-say' }, title.el, sub.el),
    h('button', { type: 'button', class: 'hero-call', 'data-action': 'start-call', onclick: startCall }, icon('phone'), `打给${state.appName}`),
    h('div', { class: 'chips' }, (TRIP_SUGGESTIONS[phase] || SUGGESTIONS).map((s) => chatButton(
      [h('span', { class: 'chip-emoji', 'aria-hidden': 'true', text: s.emoji }), h('span', { text: s.text })],
      s.text, { action: 'suggestion' }))));
  els.messages.prepend(el);
  const petHost = el.querySelector('.welcome-pet');
  petHost.renderedAt = performance.now();
  if (rivePetReady()) mountRivePet(petHost, 'Body', { mood: pet.mood, showAfter: WELCOME_HOP_MS });
  typeOut([title, sub], () => el.isConnected);
}

/** The one line above the conversation: the AI-content label, plus demo mode or a missing-key warning. */
function renderThreadNote() {
  const note = els.threadNote;
  note.replaceChildren(h('span', { text: '内容由 AI 生成 · 酒店、价格与支付均为模拟' }));
  if (globalThis.xiaosuApp?.mode === 'demo') {
    note.append(h('span', { class: 'thread-note-line', 'data-mode': 'demo', text: '演示模式：回复是写好的脚本' }));
  } else if (state.llmConfigured === false) {
    note.append(h('span', { class: 'thread-note-line is-warn', text: '服务端还没有配置大模型 API Key，暂时不能对话（参考 .env.example）。' }));
  }
}

function setAppName(name) {
  const clean = String(name || '').trim().slice(0, 20);
  if (!clean) return;
  state.appName = clean;
  document.title = clean;
  els.appName.textContent = clean;
  document.getElementById('pet-header').setAttribute('aria-label', `摸摸${clean}`);
}

async function loadHealth() {
  try {
    const data = await api('GET', '/api/health');
    if (data.appName) setAppName(data.appName);
    if (data.llm && data.llm.configured === false) {
      state.llmConfigured = false;
      renderThreadNote();
    }
  } catch {
    // informational only
  }
}

async function loadHistory() {
  // 新对话 during the GET bumps the epoch; the old transcript must not land in the new chat.
  const epoch = state.epoch;
  try {
    const data = await api('GET', `/api/sessions/${enc(state.sessionId)}`);
    if (epoch !== state.epoch) return;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      if (!els.messages.childElementCount) renderWelcome();
      return;
    }
    renderHistory(items);
    // Picking up where the chat left off: the last reply's quick replies, if it is still the last word.
    const last = els.messages.lastElementChild;
    if (last?.classList.contains('turn-in') && !state.busy) petStatus(guideFor(last, offerQuickReplies(last)));
    state.stick = true;
    scrollToBottom();
    // The cards replayed above show the request as it was then (a ride still 待确认…); bring them up to date.
    refreshPlans();
  } catch (err) {
    if (epoch !== state.epoch) return;
    if ([401, 403, 404].includes(err.status)) setSession(null);
    else toast(`上次的对话没能加载出来：${err.message}`);
    if (!els.messages.childElementCount) renderWelcome();
  }
}

function newChat() {
  stopTurn();
  closeVoice();
  stopSpeaking();
  state.epoch += 1;
  noticesPending = false;
  state.lastMsgMs = 0;
  setSession(null);
  setBusy(false);
  stopRivePets(els.messages);
  els.messages.replaceChildren();
  els.input.value = '';
  autoGrow();
  updateSendButton();
  petMood('idle');
  petStatus(PET_IDLE);
  renderWelcome();
  els.log.scrollTop = 0;
}

function autoGrow() {
  const input = els.input;
  input.style.height = '';
  if (!input.value) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function bindComposer() {
  els.input.addEventListener('input', () => {
    autoGrow();
    updateSendButton();
  });
  els.input.addEventListener('keydown', (e) => {
    // Enter while picking a Chinese IME candidate must not send.
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (typeof els.composer.requestSubmit === 'function') els.composer.requestSubmit();
    else els.composer.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) {
      stopTurn();
      return;
    }
    const text = els.input.value;
    if (!text.trim()) return;
    els.input.value = '';
    autoGrow();
    updateSendButton();
    send(text);
  });
}

/** Generated hotel and room photos (public/art/photos); the cards use tinted placeholders without them. */
async function loadPhotos() {
  try {
    const res = await fetch(new URL('art/photos/manifest.json', import.meta.url), { cache: 'no-cache' });
    if (res.ok) state.photos = await res.json();
  } catch {
    // placeholders
  }
}

function boot() {
  els = {
    app: document.getElementById('app'),
    plans: document.getElementById('plans'),
    dock: document.getElementById('dock'),
    voice: document.getElementById('voice'),
    voiceHeard: document.getElementById('voice-heard'),
    voiceSays: document.getElementById('voice-says'),
    micBtn: document.getElementById('btn-mic'),
    callBtn: document.getElementById('btn-call'),
    callText: document.getElementById('call-text'),
    callTime: document.getElementById('call-time'),
    callWave: document.getElementById('call-wave'),
    log: document.getElementById('log'),
    messages: document.getElementById('messages'),
    threadNote: document.getElementById('thread-note'),
    composer: document.getElementById('composer'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    appName: document.getElementById('app-name'),
    petStatus: document.getElementById('pet-status'),
    toasts: document.getElementById('toasts'),
  };
  cards = createCards({
    h,
    yuan: formatYuan,
    date: (ymd, withWeekday = true) => formatDate(ymd, withWeekday),
    stayPhrase,
    send: (message) => send(message),
    api,
    pay: async (opts) => {
      const result = await openPaySheet(opts);
      refreshPlans();
      return result;
    },
    toast,
    onAction: () => {
      refreshPlans();
      syncNotices();
    },
    photos: () => state.photos,
    now: serverNow,
    busy: () => state.busy,
    chatButton,
    openKey: openKeySheet,
  });
  state.userId = loadUserId();
  const saved = storage.get(KEY_SESSION);
  state.sessionId = saved && /^[A-Za-z0-9_-]{1,80}$/.test(saved) ? saved : null;
  document.getElementById('btn-menu').addEventListener('click', openMenu);
  bindPet();
  bindChrome();
  bindScroll();
  bindComposer();
  bindCall();
  renderThreadNote();
  updateSendButton();
  loadHealth();
  loadPhotos();
  // The hotel's console is offered in the menu only when this server has it (docs/MERCHANT.md).
  api('GET', '/api/merchant/hotels').then(() => { state.merchant = true; }, () => {});
  // The home screen speaks to where the trip is, so it waits (briefly) for my plans.
  const plans = refreshPlans();
  if (state.sessionId) loadHistory();
  else {
    Promise.race([plans, new Promise((resolve) => { setTimeout(resolve, 600); })]).then(() => {
      if (!els.messages.childElementCount) renderWelcome();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPlans();
  });
  // After the first paint: the runtime and the animation are extras, never in the way of the chat.
  setTimeout(startRivePet, 50);
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
