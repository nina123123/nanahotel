import * as defaultIds from '../util/ids.js';
import { todayCN, earliestCheckIn, addDays, isValidDate, cnTimeMs, formatDateCN, weekdayCN, dayOfWeek, monthOf } from '../util/dates.js';
import { hashString, hash01 } from './hotels/sim-hotels.js';
import { findCity } from './hotels/sim-cities.js';
import { buildRoomOffer, dayFactor } from './hotels/pricing.js';
import { holidayOn } from './hotels/holidays.js';

/**
 * 小宿商家版 (docs/MERCHANT.md): the hotel's console over the same data as the traveler side — the overview, the
 * room grid with front-desk check-in, guests' service tickets, reviews with replies, and the hotel's promotions.
 *
 * The hotel's other guests (rooms, tickets, channels, review history) are simulated, deterministically per hotel id
 * and date (hashes, like pricing.js): a hotel shows the same night whenever it is looked at. What happens in 小宿 —
 * orders, requests, reviews — is layered on top with `source: 'xiaosu'` (simulated items carry `source: 'sim'`).
 * A 小宿 guest's room is the one stays.js gives at check-in (same floors, same numbering), so it is always in the
 * grid; the simulated guest who would have had that room makes way. Guests appear masked (「李*」).
 *
 * The hotel's own changes are stored: a room cleaned or out of order (today only), a simulated ticket handled, a
 * reply to a simulated review, the promotions. Changes that reach a 小宿 guest (front-desk check-in, an early
 * check-in answered, a reply to their review) return an `event` ({ kind, userId, sessionId, ... }) for the server to
 * turn into a notice in the guest's chat; the user id never goes to the console.
 *
 * The hotel's day is the night in progress: until 06:00 it is still the previous date (as for bookings, 凌晨入住),
 * so a guest arriving at 00:30 for "tonight" is an arrival of the night that began yesterday. Dates in and out of
 * the API stay calendar dates; "today" in the room grid shows that night until 06:00.
 *
 * Same style as stays.js: synchronous methods, the injected clock, statuses worked out when read (no timers), and no
 * Node-only imports, so it also runs inside the phone app's page.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ROOM_DAYS_AHEAD = 6;
const FORECAST_DAYS = 14;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 60;
const REVIEW_DAYS = 60;
const MAX_SIM_REVIEWS = 30;
const TICKET_KEEP_MS = 24 * HOUR;
const WAIT_ALERT_MS = 10 * MIN;
const MAX_PROMOTIONS = 5;
const PROMO_AHEAD_DAYS = 60;
const MIN_DISCOUNT = 0.5;
const MAX_DISCOUNT = 0.95;
const MAX_TITLE_CHARS = 20;
const MAX_REPLY_CHARS = 300;
const MAX_ARRIVALS = 20;
// A simulated stay never runs past this many nights (every room has a fixed day in the cycle when guests change).
const STAY_CYCLE_DAYS = 14;
// Any date: a hotel's room types and their floors do not depend on it.
const REF_DATE = '2026-01-05';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HHMM_RE = /^([01]?\d|2[0-3])[:：]([0-5]\d)$/;

const STATUS = {
  hotel_not_found: 404, not_found: 404, room_not_found: 404,
  invalid_action: 409, wrong_room: 409, too_many_promotions: 409, order_not_confirmed: 409,
};

/** Typed merchant error; `message` is user-facing Chinese. A stays.js error keeps its own code and status. */
export class MerchantError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'MerchantError';
    this.code = code;
    this.status = status || STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const CHANNEL_LABELS = Object.freeze({ xiaosu: '小宿', ctrip: '携程', meituan: '美团', fliggy: '飞猪', direct: '直订' });
const CHANNELS = Object.freeze(Object.keys(CHANNEL_LABELS));
export const ROOM_ACTIONS = Object.freeze(['clean', 'ooo', 'release', 'check_in']);
export const TICKET_ACTIONS = Object.freeze(['accept', 'deliver', 'done', 'approve', 'decline']);

const CATEGORIES = ['economy', 'comfort', 'premium', 'luxury'];
// stays.js assignRoom: the booked room type's floors (its defaults when a hotel has no room types), skipping
// unlucky floors, rooms 01–28 a floor (01–08 in a courtyard inn).
const FLOORS = { economy: [2, 8], comfort: [3, 12], premium: [5, 20], luxury: [12, 32] };
const INN_FLOORS = [1, 3];
const UNLUCKY_FLOORS = new Set([4, 13, 14]);
// How common each room type is on a floor (R1 大床 the most, R4 家庭房 / 套房 the fewest).
const TYPE_WEIGHTS = [0.4, 0.32, 0.18, 0.1];
const BASE_OCCUPANCY = { economy: 0.8, comfort: 0.76, premium: 0.71, luxury: 0.66 };
const FNB_PER_ROOM = { economy: 8, comfort: 30, premium: 85, luxury: 210 };
const FALLBACK_PRICE = { economy: 228, comfort: 398, premium: 658, luxury: 1288 };
const BUSINESS_KINDS = new Set(['cbd', 'station', 'airport', 'university']);
const LONG_STAY_KINDS = new Set(['resort', 'beach', 'inn']);
const CHANNEL_MIX = { ctrip: 0.44, meituan: 0.24, fliggy: 0.1, direct: 0.22 };

// Common surnames, most frequent first (picked with a bias towards the front).
const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗',
  '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭', '曾', '肖', '田', '董', '袁', '潘', '于', '蒋', '蔡',
];
const COMPOUND_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '令狐', '慕容', '尉迟', '长孙', '宇文', '司徒', '夏侯', '公孙', '端木', '独孤', '南宫'];

// Simulated requests the front desk takes by phone.
const SIM_ITEMS = [['毛巾', 2], ['浴巾', 1], ['矿泉水', 2], ['牙刷', 2], ['拖鞋', 2], ['枕头', 1], ['被子', 1], ['吹风机', 1], ['充电器', 1], ['衣架', 4], ['卫生纸', 2], ['打扫房间', 1]];
const SIM_NOTES = ['放门口就行', '麻烦尽快', '要软一点的', '孩子要用', '急用，谢谢'];
const TASK_RE = /打扫|清洁|整理|收拾|维修|修理|检修|换床|铺床|开夜床|消毒|加床/;

// What simulated reviews praise: [key, tag, phrases]; `${lm}` is the area's landmark, `${view}` the hotel's view.
const PRAISE = {
  location: ['位置好', ['位置很好，离${lm}走路就几分钟', '地段方便，出门就是${lm}', '去${lm}很方便，晚上散步回来也不远']],
  clean: ['干净卫生', ['房间很干净，床品都有消毒封条', '卫生做得很好，卫生间也很干净', '打扫得很干净，没有异味']],
  service: ['服务热情', ['前台很热情，入住办得很快', '服务很周到，主动帮忙拿行李', '前台帮忙寄存行李、推荐吃的，很贴心']],
  breakfast: ['早餐丰富', ['早餐品种挺多，有现做的面条和小笼包', '早餐不错，中西式都有']],
  bed: ['床很舒服', ['床很舒服，睡得很好', '枕头有软硬两种可以选，睡得很香']],
  quiet: ['安静', ['晚上很安静，睡得踏实', '房间很安静，一夜好眠']],
  value: ['性价比高', ['这个价格很值', '性价比很高，下次还会选']],
  view: ['景观好', ['${view}很美，拉开窗帘就能看到', '房间的${view}很惊艳']],
  transit: ['交通方便', ['离车站很近，赶车很方便', '去机场很方便，适合赶早班机']],
  facility: ['设施好', ['泳池和健身房都不错', '设施很新，房间设计感很强']],
  family: ['亲子友好', ['带孩子住很方便，还送了小玩具', '亲子房布置得很用心，孩子很喜欢']],
};
// What they complain about: label (as in 「3 条点评提到隔音」), tag, phrases, how text mentions it, the hotel's
// remedy (for a drafted reply) and advice (for the overview).
const ISSUES = {
  noise: {
    label: '隔音', tag: '隔音一般', re: /隔音|吵|噪音|噪声/,
    phrases: ['隔音一般，晚上能听到走廊的声音', '临街的房间有点吵，隔音不太好', '隔壁说话声听得很清楚，隔音需要改进'],
    remedy: '我们正在为临街房间更换隔音窗，入住时也可以优先为您安排安静的高楼层房间',
    advice: '可以优先给在意的客人排安静的高楼层，回复时说明隔音改造的安排',
  },
  breakfast: {
    label: '早餐', tag: '早餐一般', re: /早餐/,
    phrases: ['早餐品种少，去晚了基本没什么吃的', '早餐比较单调，几天都一样'],
    remedy: '早餐会增加现做的品种，并在高峰时段及时补餐',
    advice: '可以看看早餐高峰的补餐节奏，增加一两样现做的品种',
  },
  parking: {
    label: '停车', tag: '停车难', re: /停车|车位/,
    phrases: ['停车位太少，绕了好几圈才停好', '停车不太方便，要停到隔壁'],
    remedy: '我们已和周边停车场合作，入住时前台可以帮您登记优惠停车',
    advice: '可以在订单确认时提示附近的合作停车场',
  },
  aircon: {
    label: '空调', tag: '空调一般', re: /空调/,
    phrases: ['空调声音有点大', '空调制冷效果一般'],
    remedy: '工程部已经逐间检修空调',
    advice: '可以安排工程部集中检修一轮空调',
  },
  bathroom: {
    label: '卫浴', tag: '卫浴待改进', re: /卫生间|淋浴|热水|水压|浴室/,
    phrases: ['卫生间有点小，淋浴水压不稳', '淋浴的热水要放很久才来'],
    remedy: '我们已经安排检修热水和淋浴水压',
    advice: '可以检查一下热水循环和淋浴水压',
  },
  dated: {
    label: '设施老旧', tag: '设施有点旧', re: /设施.{0,2}旧|老旧|陈旧|装修.{0,2}旧|地毯/,
    phrases: ['设施有点旧，地毯有点味道', '房间装修偏旧，和图片有差距'],
    remedy: '酒店正在分批升级客房，会优先为您安排已经翻新的房间',
    advice: '可以把翻新过的房间优先排给新订单，房型照片也更新一下',
  },
  frontdesk: {
    label: '前台效率', tag: '办理慢', re: /排队|等了|办理慢|效率/,
    phrases: ['前台办入住排队等了二十多分钟', '退房的时候等了很久'],
    remedy: '高峰时段我们会增加前台人手，也可以提前在线办理入住',
    advice: '可以在入住高峰（16:00–19:00）多排一位前台',
  },
  wifi: {
    label: '网络', tag: 'Wi-Fi不稳', re: /wi-?fi|网络|网速|信号/i,
    phrases: ['Wi-Fi 时断时续，开视频会议很卡', '房间里网速很慢'],
    remedy: '网络已经扩容升级，如果还有问题可以随时联系前台',
    advice: '可以测一下客房楼层的 Wi-Fi 覆盖',
  },
};
const LIKED = [['location', /位置|地段|离.{0,8}近|方便/, '位置'], ['clean', /干净|卫生/, '房间卫生'], ['service', /服务|前台|热情|贴心/, '服务'],
  ['breakfast', /早餐/, '早餐'], ['bed', /床|睡/, '睡眠体验'], ['view', /景|窗外|风景/, '景观']];

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
}

/** One line of the hotel's text (a promotion title): no control characters, no 【】 that could pass for a notice. */
function clean(v, max) {
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[【】]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Free text (a reply): line breaks kept, nothing cut, so an over-long one can be refused. */
function cleanText(v) {
  return (typeof v === 'string' ? v : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[【】]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const iso = (ms) => new Date(ms).toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const round = (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const cnDate = (isoText) => todayCN(new Date(Date.parse(isoText)));
const dayIndex = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const fill = (template, vars) => template.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/** 'HH:MM' in China time of an ISO instant. */
function hhmmOf(isoText) {
  return new Date(Date.parse(isoText) + 8 * HOUR).toISOString().slice(11, 16);
}

function hhmm(minutes) {
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

/** '李明' → '李*', '欧阳娜娜' → '欧阳*', 'John Smith' → 'Smith*': the console only shows a guest's surname. */
export function maskName(name) {
  const s = String(name ?? '').trim();
  if (!s) return '客人';
  if (/^[一-鿿]/.test(s)) return `${(s.length > 2 && COMPOUND_SURNAMES.find((c) => s.startsWith(c))) || s[0]}*`;
  const words = s.split(/\s+/);
  return `${words[words.length - 1].slice(0, 20)}*`;
}

/** Largest-remainder split of `n` slots by weight; every weight gets at least one while slots last. */
function splitByWeight(n, weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (w / sum) * n);
  const counts = exact.map((x) => Math.max(n >= weights.length ? 1 : 0, Math.floor(x)));
  let left = n - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++;
  for (let k = counts.length - 1; left < 0 && k >= 0; k--) {
    while (left < 0 && counts[k] > 1) {
      counts[k]--;
      left++;
    }
  }
  return counts;
}

/** Index into a list picked with a bias towards its front (the list's most common entries). */
function biasedPick(list, u, power = 1.6) {
  return list[Math.min(list.length - 1, Math.floor(list.length * u ** power))];
}

/** '晴舍精品酒店（杭州湖滨店）' → '晴舍精品酒店' (a reply signs with the short name). */
function shortName(name) {
  return String(name || '酒店').replace(/（[^）]*）$/, '') || '酒店';
}

function requireDate(v, what) {
  const d = str(v, 10);
  if (!isValidDate(d)) throw new MerchantError('invalid_date', `${what}需要是 YYYY-MM-DD 格式的有效日期`);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Promotions (shared with the hotel service, which prices with them)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The hotels' own promotions, stored in `merchant_promotions`. The hotel service reads `activeFor` to discount the
 * nights they cover (search, rooms, quotes, orders); the merchant service lists, creates and switches them.
 * @param {{ store: { collection(name: string) }, clock?: { now: () => Date }, ids?: Partial<typeof defaultIds> }} deps
 */
export function createPromotionBook({ store, clock = { now: () => new Date() }, ids } = {}) {
  if (!store) throw new Error('createPromotionBook: store is required');
  const idgen = { ...defaultIds, ...(ids || {}) };
  const col = store.collection('merchant_promotions');
  const nowMs = () => clock.now().getTime();

  /** Promotions switched on, as the hotel service prices with them: [{ id, title, discount, from, to }]. */
  function activeFor(hotelId) {
    const out = [];
    for (const p of col.values()) if (p.hotelId === hotelId && p.active) out.push({ id: p.id, title: p.title, discount: p.discount, from: p.from, to: p.to });
    return out;
  }

  /** Every promotion of a hotel (stored records), newest first. */
  function listFor(hotelId) {
    return col.values().filter((p) => p.hotelId === hotelId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }

  function get(hotelId, id) {
    const p = col.get(str(id, 80));
    return p && p.hotelId === hotelId ? p : null;
  }

  /**
   * A new promotion, switched on: title 1–20 characters, discount 0.5–0.95 (0.85 = 85折), nights `from`–`to`
   * (inclusive) between today and 60 days ahead; at most 5 per hotel that have not ended.
   */
  function create(hotelId, { title, discount, from, to } = {}) {
    const t = nowMs();
    const today = todayCN(new Date(t));
    // Until 06:00 the night in progress can still be booked (凌晨入住), so it can be discounted too.
    const earliest = earliestCheckIn(new Date(t));
    const name = clean(title, MAX_TITLE_CHARS + 1);
    if (!name) throw new MerchantError('invalid_title', '特惠需要一个名称，如「限时特惠」');
    if (name.length > MAX_TITLE_CHARS) throw new MerchantError('invalid_title', `特惠名称最多${MAX_TITLE_CHARS}个字`);
    const d = typeof discount === 'number' ? discount : typeof discount === 'string' && discount.trim() ? Number(discount) : NaN;
    if (!Number.isFinite(d) || d < MIN_DISCOUNT || d > MAX_DISCOUNT) {
      throw new MerchantError('invalid_discount', `折扣需要在 ${MIN_DISCOUNT}–${MAX_DISCOUNT} 之间（0.85 就是 85 折）`);
    }
    const first = requireDate(from, '开始日期（from）');
    const last = requireDate(to, '结束日期（to）');
    const latest = addDays(today, PROMO_AHEAD_DAYS);
    if (first < earliest) throw new MerchantError('invalid_date', `开始日期 ${first} 已经过去了，最早从今天（${today}）开始`);
    if (last > latest) throw new MerchantError('invalid_date', `只能设置今天起 ${PROMO_AHEAD_DAYS} 天内的特惠（最晚 ${latest}）`);
    if (last < first) throw new MerchantError('invalid_date', '结束日期不能早于开始日期');
    const running = col.values().filter((p) => p.hotelId === hotelId && p.to >= earliest).length;
    if (running >= MAX_PROMOTIONS) {
      throw new MerchantError('too_many_promotions', `每家酒店最多同时有 ${MAX_PROMOTIONS} 个没结束的特惠，等一个结束后再新建`);
    }
    const at = iso(t);
    const rec = {
      id: idgen.newId('PM'), hotelId, title: name, discount: round(d, 2), from: first, to: last,
      active: true, createdAt: at, updatedAt: at, activeSince: at, activeMs: 0,
    };
    col.set(rec.id, rec);
    return rec;
  }

  /** Switches a promotion on or off (`active` true / false); the time it was on is kept for its view count. */
  function setActive(hotelId, id, active) {
    const p = get(hotelId, id);
    if (!p) throw new MerchantError('not_found', '没有找到这个特惠活动');
    const on = active === true || active === 'true' ? true : active === false || active === 'false' ? false : null;
    if (on === null) throw new MerchantError('invalid_active', 'active 需要是 true（开启）或 false（关闭）');
    if (on === p.active) return p;
    const t = nowMs();
    const next = on
      ? { ...p, active: true, activeSince: iso(t), updatedAt: iso(t) }
      : { ...p, active: false, activeSince: null, activeMs: (p.activeMs || 0) + Math.max(0, t - Date.parse(p.activeSince || iso(t))), updatedAt: iso(t) };
    col.set(p.id, next);
    return next;
  }

  return { activeFor, listFor, get, create, setActive };
}

// ---------------------------------------------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{ store: { collection(name: string) },
 *           bookings: { ordersForHotel }, stays: { listHotelStays, listHotelRequests, frontDeskCheckIn, advanceRequest, replyReview },
 *           hotels: { getHotel }, clock?: { now: () => Date }, promotions?: ReturnType<typeof createPromotionBook>,
 *           ids?: Partial<typeof defaultIds> }} deps
 *   promotions defaults to a promotion book over the same store (the one the hotel service prices with).
 */
export function createMerchantService({ store, bookings, stays, hotels, clock = { now: () => new Date() }, promotions, ids } = {}) {
  if (!store) throw new Error('createMerchantService: store is required');
  if (!bookings) throw new Error('createMerchantService: bookings is required');
  if (!stays) throw new Error('createMerchantService: stays is required');
  if (!hotels) throw new Error('createMerchantService: hotels is required');
  const promos = promotions || createPromotionBook({ store, clock, ids });
  const roomMarks = store.collection('merchant_rooms');
  const ticketMarks = store.collection('merchant_tickets');
  const replies = store.collection('merchant_replies');
  // Read only: which hotels 小宿 guests booked (bookings.js owns the collection).
  const orderRecords = store.collection('orders');
  const nowMs = () => clock.now().getTime();
  const models = new Map();

  /** A stays.js error keeps its code, status and Chinese message. */
  function viaStays(fn) {
    try {
      return fn();
    } catch (err) {
      if (err?.name === 'StayError') throw new MerchantError(err.code, err.message, err.details, err.status);
      throw err;
    }
  }

  // ---- the hotel and its rooms (deterministic per hotel id) ------------------------------------------------

  function requireHotel(hotelId) {
    const id = str(hotelId, 80);
    let hotel = null;
    try {
      hotel = ID_RE.test(id) ? hotels.getHotel(id) : null;
    } catch {
      hotel = null;
    }
    if (!hotel) throw new MerchantError('hotel_not_found', '没有找到这家酒店，请重新选择');
    return hotel;
  }

  function modelOf(hotel) {
    let m = models.get(hotel.id);
    if (m) return m;
    const category = CATEGORIES.includes(hotel.category) ? hotel.category : 'comfort';
    const city = findCity(hotel.city);
    const area = city?.areas.find((a) => a.name === hotel.businessArea) || null;
    const lowRise = area ? area.kind === 'inn' : /民宿|客栈|小院|院子/.test(hotel.name || '');
    const kind = area?.kind || 'shopping';
    let offer = null;
    try {
      offer = buildRoomOffer(hotel, { checkIn: REF_DATE, checkOut: addDays(REF_DATE, 1) });
    } catch {
      offer = null;
    }
    const [dLo, dHi] = lowRise ? INN_FLOORS : FLOORS[category];
    let types = (offer?.roomTypes || []).map((rt) => {
      const f = /^(\d+)-(\d+)层$/.exec(rt.floor || '');
      return { roomId: rt.roomId, name: rt.name, lo: f ? Number(f[1]) : dLo, hi: f ? Number(f[2]) : dHi };
    });
    if (!types.length) types = [{ roomId: 'R1', name: '标准间', lo: dLo, hi: dHi }];
    const perFloor = lowRise ? 8 : 28;
    const rooms = [];
    const bottom = Math.min(...types.map((t) => t.lo));
    const top = Math.max(...types.map((t) => t.hi));
    for (let f = bottom; f <= top; f++) {
      if (UNLUCKY_FLOORS.has(f)) continue;
      let here = types.filter((t) => t.lo <= f && f <= t.hi);
      if (!here.length) here = [types.reduce((a, b) => (b.hi > a.hi ? b : a))];
      const counts = splitByWeight(perFloor, here.map((t) => TYPE_WEIGHTS[types.indexOf(t)] ?? 0.1));
      let index = 1;
      here.forEach((type, i) => {
        for (let k = 0; k < counts[i]; k++, index++) rooms.push(makeRoom(hotel.id, f, index, type));
      });
    }
    if (!rooms.length) for (let i = 1; i <= perFloor; i++) rooms.push(makeRoom(hotel.id, bottom, i, types[0]));
    const issues = Object.keys(ISSUES).filter((k) => !(lowRise && k === 'aircon'));
    const weak = [issues[hashString(`${hotel.id}|weak1`) % issues.length]];
    const second = issues[hashString(`${hotel.id}|weak2`) % issues.length];
    if (second !== weak[0]) weak.push(second);
    const view = (hotel.tags || []).find((t) => /景房$/.test(t));
    m = {
      id: hotel.id,
      hotel,
      category,
      lowRise,
      kind,
      tier: city?.tier || 'tier2',
      season: Array.isArray(city?.season) ? city.season : null,
      business: BUSINESS_KINDS.has(kind),
      // Leisure stays are longer than business trips.
      cont: LONG_STAY_KINDS.has(kind) ? 0.72 : BUSINESS_KINDS.has(kind) ? 0.5 : 0.6,
      baseOcc: BASE_OCCUPANCY[category] + (hash01(`${hotel.id}|occ`) - 0.5) * 0.1 + ((Number(hotel.rating) || 4.5) - 4.5) * 0.08,
      types,
      rooms,
      byNumber: new Map(rooms.map((r) => [r.number, r])),
      landmark: area?.landmarks?.[0]?.name || area?.short || '景点',
      view: view ? view.replace(/房$/, '') : '',
      weak,
      occCache: new Map(),
      priceCache: new Map(),
    };
    models.set(hotel.id, m);
    return m;
  }

  function makeRoom(hotelId, floor, index, type) {
    const number = `${floor}${pad2(index)}`;
    return { number, floor, type, cycleDay: hashString(`${hotelId}|${number}|cycle`) % STAY_CYCLE_DAYS };
  }

  function modelFor(hotelId) {
    return modelOf(requireHotel(hotelId));
  }

  /**
   * Share of rooms sold on the night of `date`: the category's level, then demand — leisure hotels fill up on
   * weekends and holidays (pricing.js dayFactor), business hotels on weekdays — the city's season and a weekly wobble.
   */
  function occRate(m, date) {
    const hit = m.occCache.get(date);
    if (hit !== undefined) return hit;
    let demand;
    if (m.business) {
      const dow = dayOfWeek(date);
      demand = holidayOn(date) ? (m.kind === 'cbd' ? 0.86 : 1.08) : dow === 5 ? 0.93 : dow === 6 ? 0.86 : 1.05;
    } else {
      demand = 1 + (dayFactor(date, m.tier) - 1) * 0.8;
    }
    const season = m.season ? 1 + ((m.season[monthOf(date) - 1] || 1) - 1) * 0.6 : 1;
    const monday = addDays(date, -((dayOfWeek(date) + 6) % 7));
    const wobble = 1 + (hash01(`${m.id}|${monday}|occ`) - 0.5) * 0.08 + (hash01(`${m.id}|${date}|occ`) - 0.5) * 0.04;
    const v = clamp(m.baseOcc * demand * season * wobble, 0.28, 0.97);
    if (m.occCache.size > 800) m.occCache.clear();
    m.occCache.set(date, v);
    return v;
  }

  /** Each room type's price on the night of `date` (the plain rate, as other channels sell it). */
  function pricesOn(m, date) {
    const hit = m.priceCache.get(date);
    if (hit) return hit;
    const prices = new Map();
    try {
      for (const rt of buildRoomOffer(m.hotel, { checkIn: date, checkOut: addDays(date, 1) }).roomTypes) prices.set(rt.roomId, rt.rates[0]?.nightly[0]?.price);
    } catch {
      // no simulated prices: the fallback below
    }
    const fallback = Math.round((Number(m.hotel.priceHint) || FALLBACK_PRICE[m.category]) * dayFactor(date, m.tier));
    const out = (roomId) => prices.get(roomId) || fallback;
    if (m.priceCache.size > 800) m.priceCache.clear();
    m.priceCache.set(date, out);
    return out;
  }

  // ---- the simulated guests: one decision per room and night, hashed ---------------------------------------

  const simOcc = (m, room, date) => hash01(`${m.id}|${room.number}|${date}|o`) < occRate(m, date);
  /** The guest of the night before stays on (never across the room's changeover day). */
  const continues = (m, room, date) => dayIndex(date) % STAY_CYCLE_DAYS !== room.cycleDay && hash01(`${m.id}|${room.number}|${date}|c`) < m.cont;
  /** A 小宿 guest holds this room on `date` (from arrival through the day they leave). */
  const heldByXiaosu = (real, number, date) => (real.byRoom.get(number) || []).some((r) => r.start <= date && date <= r.end);
  const occAt = (m, real, room, date) => !heldByXiaosu(real, room.number, date) && simOcc(m, room, date);

  function guestName(m, room, start) {
    return `${biasedPick(SURNAMES, hash01(`${m.id}|${room.number}|${start}|name`))}*`;
  }

  /** The simulated guest staying the night of `date` (which must be occupied): arrival, departure, masked name. */
  function simStay(m, real, room, date) {
    let start = date;
    for (let i = 0; i < STAY_CYCLE_DAYS && continues(m, room, start) && occAt(m, real, room, addDays(start, -1)); i++) start = addDays(start, -1);
    let last = date;
    for (let i = 0; i < STAY_CYCLE_DAYS; i++) {
      const next = addDays(last, 1);
      if (!(continues(m, room, next) && occAt(m, real, room, next))) break;
      last = next;
    }
    return { checkIn: start, checkOut: addDays(last, 1), name: guestName(m, room, start) };
  }

  /** Today's times of a simulated room: the leaving guest goes 07:00–12:00, housekeeping follows, arrivals 14:00–22:00. */
  function departAt(m, room, date) {
    return cnTimeMs(date, '07:00') + Math.round(300 * Math.sqrt(hash01(`${m.id}|${room.number}|${date}|dep`))) * MIN;
  }

  function cleanedAt(m, room, date) {
    return departAt(m, room, date) + (20 + Math.round(90 * hash01(`${m.id}|${room.number}|${date}|cln`))) * MIN;
  }

  function etaOf(m, room, date) {
    const minutes = Math.round((14 * 60 + 480 * hash01(`${m.id}|${room.number}|${date}|eta`) ** 1.3) / 30) * 30;
    return { at: cnTimeMs(date, '00:00') + minutes * MIN, time: hhmm(minutes) };
  }

  // ---- 小宿 guests --------------------------------------------------------------------------------------------

  /** This hotel's confirmed 小宿 orders with their rooms (stays.js), and the days each holds its room. */
  function realOf(m, today) {
    const list = viaStays(() => stays.listHotelStays(m.id)).map(({ order, roomNumber, floor, stay }) => {
      // On the hotel's business day: a check-in at 05:20 belongs to the night in progress, like the grid's today.
      const inDate = stay?.checkedInAt ? earliestCheckIn(new Date(stay.checkedInAt)) : null;
      const outDate = stay?.checkedOutAt ? cnDate(stay.checkedOutAt) : null;
      // Still in after the check-out date: the room is theirs until they leave.
      const end = outDate || (stay && today > order.checkOut ? today : order.checkOut);
      return { order, roomNumber, floor, stay, inDate, outDate, start: inDate && inDate < order.checkIn ? inDate : order.checkIn, end, nightsUntil: outDate || order.checkOut };
    });
    const byRoom = new Map();
    for (const r of list) {
      if (!byRoom.has(r.roomNumber)) byRoom.set(r.roomNumber, []);
      byRoom.get(r.roomNumber).push(r);
    }
    return { list, byRoom };
  }

  /** The 小宿 stay holding a room on `date`: in the room first, then expected, then just left. */
  function holderOf(real, number, date) {
    const rank = (r) => (r.stay && !r.outDate ? 0 : !r.stay ? 1 : 2);
    let best = null;
    for (const r of real.byRoom.get(number) || []) if (r.start <= date && date <= r.end && (!best || rank(r) < rank(best))) best = r;
    return best;
  }

  /**
   * Everything one call needs about now: the hotel's day (`today`: the night in progress, so before 06:00 the
   * previous date), 小宿 stays and requests, the day's room marks, the tickets.
   */
  function dayContext(m, t) {
    const today = earliestCheckIn(new Date(t));
    const marks = new Map();
    for (const mk of roomMarks.values()) if (mk.hotelId === m.id && mk.date === today) marks.set(mk.number, mk);
    const ctx = { today, now: t, real: realOf(m, today), requests: viaStays(() => stays.listHotelRequests(m.id)), marks };
    ctx.tickets = ticketList(m, ctx);
    ctx.openTickets = new Map();
    for (const tk of ctx.tickets) if (tk.status === 'new' || tk.status === 'doing') ctx.openTickets.set(tk.roomNumber, (ctx.openTickets.get(tk.roomNumber) || 0) + 1);
    return ctx;
  }

  /** The grid's rooms plus any room a 小宿 guest was given outside it (never for simulated hotels). */
  function gridRooms(m, ctx) {
    const extra = [];
    for (const r of ctx.real.list) {
      if (m.byNumber.has(r.roomNumber) || extra.some((x) => x.number === r.roomNumber)) continue;
      extra.push({ number: r.roomNumber, floor: r.floor, type: { roomId: r.order.room?.roomId, name: r.order.room?.name || '客房' }, cycleDay: 0 });
    }
    return extra.length ? [...m.rooms, ...extra] : m.rooms;
  }

  function findRoom(m, ctx, number) {
    const n = str(number, 10);
    return gridRooms(m, ctx).find((r) => r.number === n) || null;
  }

  // ---- room status -------------------------------------------------------------------------------------------

  function roomView(m, ctx, room, date) {
    const holder = holderOf(ctx.real, room.number, date);
    let view;
    if (holder) view = xiaosuRoom(holder, room, date, ctx);
    else if (date === ctx.today && ctx.marks.get(room.number)?.ooo) view = { number: room.number, roomType: room.type.name, status: 'ooo' };
    else view = simRoom(m, ctx, room, date);
    const open = date === ctx.today ? ctx.openTickets.get(room.number) : 0;
    if (open) view.tickets = open;
    return view;
  }

  function xiaosuRoom(r, room, date, ctx) {
    const { order, stay } = r;
    const base = { number: room.number, roomType: order.room?.name || room.type.name };
    if (r.outDate) {
      // Left today: dirty until housekeeping (the front desk's 打扫) has been.
      const mark = date === ctx.today ? ctx.marks.get(room.number) : null;
      const cleaned = mark?.cleanedAt && Date.parse(mark.cleanedAt) >= Date.parse(stay.checkedOutAt);
      return { ...base, roomType: room.type.name, status: cleaned ? 'vacant' : 'dirty' };
    }
    let status;
    if (stay) status = date >= order.checkOut ? 'departing' : 'occupied';
    else if (date > ctx.today) status = date === order.checkIn ? 'arriving' : date >= order.checkOut ? 'departing' : 'occupied';
    // Today: expected (or late); on the check-out day a guest who never came is not coming.
    else status = date < order.checkOut ? 'arriving' : null;
    if (!status) return { ...base, roomType: room.type.name, status: 'vacant' };
    return {
      ...base,
      status,
      guest: { name: maskName(order.guests?.[0]), orderId: order.id, checkIn: order.checkIn, checkOut: order.checkOut, source: 'xiaosu' },
    };
  }

  function simRoom(m, ctx, room, date) {
    const base = { number: room.number, roomType: room.type.name };
    const prev = addDays(date, -1);
    const was = occAt(m, ctx.real, room, prev);
    const is = occAt(m, ctx.real, room, date);
    const guestOf = (night) => {
      const s = simStay(m, ctx.real, room, night);
      return { name: s.name, checkIn: s.checkIn, checkOut: s.checkOut, source: 'sim' };
    };
    if (was && is && continues(m, room, date)) return { ...base, status: 'occupied', guest: guestOf(date) };
    if (date !== ctx.today) {
      if (was) return { ...base, status: 'departing', guest: guestOf(prev) };
      if (is) return { ...base, status: 'arriving', guest: guestOf(date) };
      return { ...base, status: 'vacant' };
    }
    if (was) {
      const leaves = departAt(m, room, date);
      if (ctx.now < leaves) return { ...base, status: 'departing', guest: guestOf(prev) };
      const mark = ctx.marks.get(room.number);
      const cleaned = (mark?.cleanedAt && Date.parse(mark.cleanedAt) >= leaves) || ctx.now >= cleanedAt(m, room, date);
      if (!cleaned) return { ...base, status: 'dirty' };
    }
    if (is) return { ...base, status: ctx.now < etaOf(m, room, date).at ? 'arriving' : 'occupied', guest: guestOf(date) };
    return { ...base, status: 'vacant' };
  }

  /**
   * GET rooms: the grid by floor for `date` (today by default, up to 6 days ahead), each room's status and guest.
   * @returns {{ date, counts: { vacant, dirty, occupied, arriving, departing, ooo }, floors: [{ floor, rooms }] }}
   */
  function rooms(hotelId, { date } = {}) {
    const m = modelFor(hotelId);
    const t = nowMs();
    const today = todayCN(new Date(t));
    const last = addDays(today, ROOM_DAYS_AHEAD);
    const day = date === undefined || date === null || date === '' ? today : requireDate(date, '房态日期');
    const ctx = dayContext(m, t);
    if (day < ctx.today || day > last) {
      throw new MerchantError('invalid_date', `房态只能看今天到 ${ROOM_DAYS_AHEAD} 天后（${formatDateCN(today)}–${formatDateCN(last)}）`);
    }
    // Before 06:00 "today" is the night still in progress.
    const night = day <= today ? ctx.today : day;
    const counts = { vacant: 0, dirty: 0, occupied: 0, arriving: 0, departing: 0, ooo: 0 };
    const byFloor = new Map();
    for (const room of gridRooms(m, ctx)) {
      const view = roomView(m, ctx, room, night);
      counts[view.status]++;
      if (!byFloor.has(room.floor)) byFloor.set(room.floor, []);
      byFloor.get(room.floor).push(view);
    }
    const floors = [...byFloor.entries()].sort((a, b) => a[0] - b[0])
      .map(([floor, list]) => ({ floor, rooms: list.sort((a, b) => Number(a.number) - Number(b.number)) }));
    return { date: day, counts, floors };
  }

  /**
   * POST rooms/:number: `clean` (空脏 → 空净), `ooo` (an empty room → 维修), `release` (维修 → 空净) for today, or
   * `check_in` a 小宿 order at the front desk — in the room stays.js gives it (else 409 wrong_room with the right one).
   * @returns {{ room, event? }}  event: { kind: 'front_desk_checkin', userId, sessionId, stay }
   */
  function roomAction(hotelId, number, body = {}) {
    const m = modelFor(hotelId);
    const action = str(body.action, 20);
    if (!ROOM_ACTIONS.includes(action)) throw new MerchantError('unknown_action', '房间操作需要是 clean（打扫）、ooo（维修）、release（恢复可售）或 check_in（办入住）');
    const t = nowMs();
    const ctx = dayContext(m, t);
    const { today } = ctx;
    const room = findRoom(m, ctx, number);
    if (!room) throw new MerchantError('room_not_found', `这家酒店没有 ${str(number, 10)} 房`);
    if (action === 'check_in') return frontDeskCheckIn(m, ctx, room, body.orderId);
    const view = roomView(m, ctx, room, today);
    const key = `${m.id}|${today}|${room.number}`;
    const mark = roomMarks.get(key) || { hotelId: m.id, date: today, number: room.number };
    if (action === 'clean') {
      if (view.status !== 'dirty') throw new MerchantError('invalid_action', `${room.number} 房不是空脏房，不用打扫`);
      roomMarks.set(key, { ...mark, cleanedAt: iso(t) });
    } else if (action === 'ooo') {
      if (view.status !== 'vacant' && view.status !== 'dirty') throw new MerchantError('invalid_action', `${room.number} 房有客人，只有空房才能设为维修`);
      roomMarks.set(key, { ...mark, ooo: true, oooAt: iso(t) });
    } else {
      if (view.status !== 'ooo') throw new MerchantError('invalid_action', `${room.number} 房不在维修中`);
      roomMarks.set(key, { ...mark, ooo: false, cleanedAt: iso(t) });
    }
    return { room: roomView(m, dayContext(m, t), room, today) };
  }

  function frontDeskCheckIn(m, ctx, room, orderIdRaw) {
    const orderId = str(orderIdRaw, 80).toUpperCase();
    if (!orderId || !ID_RE.test(orderId)) throw new MerchantError('invalid_order', '办入住需要订单号（orderId）');
    const entry = ctx.real.list.find((r) => r.order.id === orderId);
    if (!entry) {
      const other = bookings.ordersForHotel(m.id).find((o) => o.id === orderId);
      if (!other) throw new MerchantError('not_found', '这家酒店没有这个订单');
      throw new MerchantError('order_not_confirmed', other.status === 'cancelled' ? '这个订单已经取消了，不能办入住' : '这个订单还没支付或已关闭，不能办入住');
    }
    if (entry.roomNumber !== room.number) {
      throw new MerchantError('wrong_room', `这一单的房号是 ${entry.roomNumber}，请在 ${entry.roomNumber} 房办理`, { roomNumber: entry.roomNumber });
    }
    const out = viaStays(() => stays.frontDeskCheckIn(orderId));
    const fresh = dayContext(m, nowMs());
    return {
      room: roomView(m, fresh, room, fresh.today),
      event: { kind: 'front_desk_checkin', userId: out.userId, sessionId: out.sessionId, stay: out.stay },
    };
  }

  // ---- tickets -----------------------------------------------------------------------------------------------

  const RANK = { new: 0, doing: 1, done: 2, declined: 2 };

  function serviceTitle(items) {
    return items.map((i) => (TASK_RE.test(i.name) && i.qty <= 1 ? i.name : `${i.name} ×${i.qty}`)).join('、');
  }

  function actionsFor(kind, status, title) {
    if (kind === 'service') {
      const finish = TASK_RE.test(title) ? 'done' : 'deliver';
      return status === 'new' ? ['accept', finish] : status === 'doing' ? [finish] : [];
    }
    return kind === 'early_checkin' && status === 'new' ? ['approve', 'decline'] : [];
  }

  /** A 小宿 guest's request as a ticket (null for kinds the hotel does not handle, or ones cancelled at check-out). */
  function xiaosuTicket(r, order, roomNumber) {
    const common = { id: r.id, roomNumber, guest: maskName(order.guests?.[0]), source: 'xiaosu', orderId: order.id };
    let ticket = null;
    if (r.kind === 'service') {
      const status = { accepted: 'new', on_the_way: 'doing', done: 'done' }[r.status];
      ticket = { kind: 'service', title: serviceTitle(r.items), ...(r.note ? { note: r.note } : {}), createdAt: r.createdAt, dueAt: r.eta, status };
    } else if (r.kind === 'early_checkin') {
      const status = { pending: 'new', confirmed: 'done', declined: 'declined' }[r.status];
      if (!status) return null;
      ticket = {
        kind: 'early_checkin', title: `提前入住 ${r.arrivalTime}`, note: `${formatDateCN(r.date)}（${weekdayCN(r.date)}）到店`,
        createdAt: r.createdAt, dueAt: iso(cnTimeMs(r.date, r.arrivalTime)), status,
      };
    } else if (r.kind === 'wakeup' && r.status !== 'cancelled') {
      ticket = { kind: 'wakeup', title: `叫醒 ${hhmmOf(r.at)}`, createdAt: r.createdAt, dueAt: r.at, status: r.status === 'done' ? 'done' : 'doing' };
    } else if (r.kind === 'dining' && r.status !== 'cancelled') {
      ticket = {
        kind: 'dining', title: `${r.kindLabel} ${r.people}位 ${hhmmOf(r.at)}`, note: [r.note, `${r.place} ${r.restaurant} · ${r.table}`].filter(Boolean).join(' · '),
        createdAt: r.createdAt, dueAt: r.at, status: r.status === 'done' ? 'done' : 'doing',
      };
    }
    return ticket && { ...common, ...ticket, actions: actionsFor(ticket.kind, ticket.status, ticket.title) };
  }

  /**
   * The front desk's simulated requests created on `day` (by phone): 4–12 a day by hotel size, in rooms whose
   * simulated guests are in (an early check-in: a guest arriving that day). Each moves on with the clock — a
   * delivery waits 2–30 minutes for someone to take it — unless the console moved it first.
   */
  function simTickets(m, ctx, day) {
    const prev = addDays(day, -1);
    const inHouse = [];
    const arriving = [];
    for (const room of m.rooms) {
      if (!simOcc(m, room, day) || heldByXiaosu(ctx.real, room.number, day) || heldByXiaosu(ctx.real, room.number, prev)) continue;
      (simOcc(m, room, prev) && continues(m, room, day) ? inHouse : arriving).push(room);
    }
    const h = (i, k) => hash01(`${m.id}|${day}|t${i}|${k}`);
    const n = clamp(Math.round(m.rooms.length * occRate(m, day) * 0.045 * (0.7 + 0.6 * hash01(`${m.id}|${day}|tickets`))), 4, 12);
    const at = (hhmmText, minutes) => cnTimeMs(day, hhmmText) + Math.round(minutes) * MIN;
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = h(i, 'kind');
      const kind = u < 0.55 ? 'service' : u < 0.73 ? 'wakeup' : u < 0.88 ? 'dining' : 'early_checkin';
      const pool = kind === 'early_checkin' ? arriving : inHouse;
      if (!pool.length) continue;
      const room = pool[Math.floor(h(i, 'room') * pool.length)];
      const guest = simStay(m, ctx.real, room, day).name;
      const id = `T-${m.id}-${day.replace(/-/g, '')}-${i + 1}`;
      let ticket;
      let timeStatus;
      if (kind === 'service') {
        const [name, qty] = SIM_ITEMS[Math.floor(h(i, 'item') * SIM_ITEMS.length)];
        const created = at('07:30', 930 * h(i, 'at'));
        const taken = created + (2 + Math.round(28 * h(i, 'wait') ** 1.5)) * MIN;
        const brought = taken + (5 + Math.round(10 * h(i, 'walk'))) * MIN;
        const note = h(i, 'note') < 0.3 ? SIM_NOTES[Math.floor(h(i, 'which') * SIM_NOTES.length)] : '';
        ticket = { kind, title: serviceTitle([{ name, qty }]), ...(note ? { note } : {}), createdAt: iso(created), dueAt: iso(brought) };
        timeStatus = ctx.now < taken ? 'new' : ctx.now < brought ? 'doing' : 'done';
      } else if (kind === 'wakeup') {
        const due = cnTimeMs(addDays(day, 1), '06:00') + Math.round(10 * h(i, 'due')) * 15 * MIN;
        ticket = { kind, title: `叫醒 ${hhmmOf(iso(due))}`, createdAt: iso(at('20:00', 210 * h(i, 'at'))), dueAt: iso(due) };
        timeStatus = ctx.now < due ? 'doing' : 'done';
      } else if (kind === 'dining') {
        const breakfast = h(i, 'meal') < 0.3;
        const due = breakfast
          ? cnTimeMs(addDays(day, 1), '07:00') + Math.round(4 * h(i, 'due')) * 30 * MIN
          : cnTimeMs(day, '18:00') + Math.round(5 * h(i, 'due')) * 30 * MIN;
        const people = 1 + Math.floor(4 * h(i, 'people'));
        ticket = { kind, title: `${breakfast ? '早餐' : '晚餐'} ${people}位 ${hhmmOf(iso(due))}`, createdAt: iso(at('09:00', 540 * h(i, 'at'))), dueAt: iso(due) };
        timeStatus = ctx.now < due ? 'doing' : 'done';
      } else {
        const created = at('07:00', 180 * h(i, 'at'));
        const due = Math.max(cnTimeMs(day, '09:00') + Math.round(6 * h(i, 'due')) * 30 * MIN, Math.ceil((created + 30 * MIN) / (30 * MIN)) * 30 * MIN);
        ticket = { kind, title: `提前入住 ${hhmmOf(iso(due))}`, note: `${formatDateCN(day)}（${weekdayCN(day)}）到店`, createdAt: iso(created), dueAt: iso(due) };
        // Nobody answered before the guest came: the front desk sorted it out on arrival.
        timeStatus = ctx.now < due ? 'new' : 'done';
      }
      const mark = ticketMarks.get(id);
      const status = mark && mark.hotelId === m.id && RANK[mark.status] >= RANK[timeStatus] ? mark.status : timeStatus;
      out.push({ id, kind, roomNumber: room.number, guest, source: 'sim', ...ticket, status, actions: actionsFor(kind, status, ticket.title) });
    }
    return out;
  }

  /** Tickets newest first: 小宿 guests' requests and the simulated ones; finished ones only from the last 24 hours. */
  function ticketList(m, ctx) {
    const out = [];
    for (const { request, order, roomNumber } of ctx.requests) {
      const ticket = xiaosuTicket(request, order, roomNumber);
      if (ticket) out.push(ticket);
    }
    for (const day of [addDays(ctx.today, -1), ctx.today]) out.push(...simTickets(m, ctx, day));
    const t = ctx.now;
    return out
      .filter((tk) => Date.parse(tk.createdAt) <= t && (RANK[tk.status] < 2 || Date.parse(tk.createdAt) >= t - TICKET_KEEP_MS))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  }

  /** GET tickets → { tickets }. */
  function tickets(hotelId) {
    const m = modelFor(hotelId);
    return { tickets: dayContext(m, nowMs()).tickets };
  }

  function whyNot(ticket, action) {
    if (ticket.kind === 'wakeup' || ticket.kind === 'dining') return '叫醒和订餐到时间会自动完成，不用处理';
    if (ticket.kind === 'early_checkin') return ticket.status === 'new' ? '提前入住只能同意或婉拒' : '这个提前入住申请已经处理过了';
    if (ticket.status === 'done') return '这单已经完成了';
    if (action === 'accept') return '这单已经接过了，正在配送';
    return '送物工单只能接单、送达或完成';
  }

  /**
   * POST tickets/:id: a delivery `accept` (→ doing; the guest's card says 配送中) or `deliver` / `done` (→ done;
   * 已送达); an early check-in `approve` / `decline`. Anything the ticket cannot do now is a 409 invalid_action.
   * @returns {{ ticket, event? }}  event: { kind: 'early_checkin_approved' | 'early_checkin_declined', userId, sessionId, request }
   */
  function ticketAction(hotelId, ticketId, body = {}) {
    const m = modelFor(hotelId);
    const action = str(body.action, 20);
    if (!TICKET_ACTIONS.includes(action)) throw new MerchantError('unknown_action', '工单操作需要是 accept（接单）、deliver（送达）、done（完成）、approve（同意）或 decline（婉拒）');
    const t = nowMs();
    const id = str(ticketId, 80);
    const ticket = dayContext(m, t).tickets.find((tk) => tk.id === id);
    if (!ticket) throw new MerchantError('not_found', '没有找到这张工单（完成超过 24 小时的不再显示）');
    const finish = ticket.actions.find((a) => a === 'deliver' || a === 'done');
    const allowed = ticket.actions.includes(action) || (finish && (action === 'deliver' || action === 'done'));
    if (!allowed) throw new MerchantError('invalid_action', whyNot(ticket, action));
    let event;
    if (ticket.source === 'xiaosu') {
      const out = viaStays(() => stays.advanceRequest(id, action));
      if (ticket.kind === 'early_checkin') {
        event = { kind: action === 'approve' ? 'early_checkin_approved' : 'early_checkin_declined', userId: out.userId, sessionId: out.sessionId, request: out.request };
      }
    } else {
      const status = action === 'accept' ? 'doing' : action === 'decline' ? 'declined' : 'done';
      ticketMarks.set(id, { id, hotelId: m.id, status, action, at: iso(t) });
    }
    const fresh = dayContext(m, t).tickets.find((tk) => tk.id === id) || ticket;
    return { ticket: fresh, ...(event ? { event } : {}) };
  }

  // ---- reviews -----------------------------------------------------------------------------------------------

  /** Shares of 5…1 stars for a hotel rated `rating` (4.0 → mostly 4–5 stars, 4.9 → nearly all 5). */
  function starShares(rating) {
    const x = clamp(((Number(rating) || 4.5) - 4.0) / 0.9, 0, 1);
    return { 5: 0.45 + 0.48 * x, 4: 0.3 - 0.25 * x, 3: 0.13 - 0.12 * x, 2: 0.07 - 0.065 * x, 1: 0.05 - 0.045 * x };
  }

  function praiseKeys(m) {
    const keys = ['location', 'clean', 'service', 'bed', 'quiet'];
    if (m.category !== 'economy') keys.push('breakfast');
    if (m.category === 'economy' || m.category === 'comfort') keys.push('value');
    if (m.view) keys.push('view');
    if (m.kind === 'station' || m.kind === 'airport') keys.push('transit');
    if (m.category === 'premium' || m.category === 'luxury') keys.push('facility');
    if ((m.hotel.tags || []).includes('亲子')) keys.push('family');
    return keys;
  }

  /** The simulated reviews of the last 60 days (0–2 a day by how popular the hotel is), newest first. */
  function simReviews(m, today, t) {
    const out = [];
    const shares = starShares(m.hotel.rating);
    const perDay = clamp((Number(m.hotel.reviewCount) || 500) / 1800, 0.25, 1.5);
    const keys = praiseKeys(m);
    const vars = { lm: m.landmark, view: m.view || '景观' };
    for (let i = 0; i < REVIEW_DAYS && out.length < MAX_SIM_REVIEWS; i++) {
      const day = addDays(today, -i);
      const count = (hash01(`${m.id}|${day}|rv1`) < perDay * 0.7 ? 1 : 0) + (hash01(`${m.id}|${day}|rv2`) < perDay * 0.3 ? 1 : 0);
      for (let k = 0; k < count && out.length < MAX_SIM_REVIEWS; k++) {
        const h = (key) => hash01(`${m.id}|${day}|rv${k}|${key}`);
        const atMs = cnTimeMs(day, '08:00') + Math.round(930 * h('at')) * MIN;
        if (atMs > t) continue;
        let u = h('stars');
        let rating = 5;
        for (const s of [5, 4, 3, 2, 1]) {
          if (u < shares[s]) {
            rating = s;
            break;
          }
          u -= shares[s];
          rating = s;
        }
        const pickPraise = (n) => {
          const chosen = [];
          for (let j = 0; chosen.length < n && j < 8; j++) {
            const key = keys[Math.floor(h(`p${j}`) * keys.length)];
            if (!chosen.includes(key)) chosen.push(key);
          }
          return chosen;
        };
        const pickIssue = (j) => {
          const all = Object.keys(ISSUES);
          return h(`i${j}`) < 0.7 ? m.weak[Math.floor(h(`w${j}`) * m.weak.length)] : all[Math.floor(h(`a${j}`) * all.length)];
        };
        const say = (list, key) => fill(list[Math.floor(h(`say-${key}`) * list.length)], vars);
        let praise = [];
        let issues = [];
        let text;
        if (rating === 5) {
          praise = pickPraise(2 + (h('n') < 0.4 ? 1 : 0));
          text = `${praise.map((key) => say(PRAISE[key][1], key)).join('，')}。${['下次来还住这里。', '推荐！', '整体非常满意。', '会推荐给朋友。', ''][Math.floor(h('end') * 5)]}`;
        } else if (rating === 4) {
          praise = pickPraise(2);
          issues = h('minor') < 0.5 ? [pickIssue(0)] : [];
          text = `${praise.map((key) => say(PRAISE[key][1], key)).join('，')}${issues.length ? `，就是${say(ISSUES[issues[0]].phrases, issues[0])}` : ''}。`;
        } else if (rating === 3) {
          praise = pickPraise(1);
          issues = [pickIssue(0)];
          text = `${say(PRAISE[praise[0]][1], praise[0])}，不过${say(ISSUES[issues[0]].phrases, issues[0])}，整体还行。`;
        } else {
          issues = [...new Set([pickIssue(0), pickIssue(1)])];
          text = `${issues.map((key) => say(ISSUES[key].phrases, key)).join('，')}，${rating === 1 ? '体验很差，不会再来了。' : '有点失望。'}`;
        }
        const id = `R-${m.id}-${day.replace(/-/g, '')}-${k + 1}`;
        const review = {
          id, source: 'sim', guest: `${biasedPick(SURNAMES, h('name'))}*`, rating, text,
          tags: [...praise.map((key) => PRAISE[key][0]), ...issues.map((key) => ISSUES[key].tag)].slice(0, 3),
          roomType: m.types[Math.min(m.types.length - 1, Math.floor(m.types.length * h('room') ** 1.8))].name,
          at: iso(atMs), issues,
        };
        // Hotels answer most reviews within a day or two, complaints first.
        const repliedAt = atMs + Math.round((2 + 28 * h('replyAt')) * 60) * MIN;
        if (h('reply') < (rating <= 3 ? 0.85 : 0.6) && repliedAt <= t) review.reply = { text: draftText(m, review), at: iso(repliedAt) };
        out.push(review);
      }
    }
    return out;
  }

  /** Issue keys a review mentions: a simulated one says; a guest's text is read for them (complaints only). */
  function issuesOf(review) {
    if (Array.isArray(review.issues)) return review.issues;
    if (review.rating > 3) return [];
    return Object.keys(ISSUES).filter((key) => ISSUES[key].re.test(review.text || ''));
  }

  function reviewList(m, t, requests = viaStays(() => stays.listHotelRequests(m.id))) {
    const real = requests
      .filter(({ request }) => request.kind === 'review' && request.status === 'published')
      .map(({ request: r, order }) => ({
        id: r.id, source: 'xiaosu', guest: maskName(order.guests?.[0]), rating: r.rating, text: r.text, tags: [...(r.tags || [])],
        roomType: order.room?.name || undefined, at: r.publishedAt, ...(r.reply ? { reply: { ...r.reply } } : {}),
      }));
    const sim = simReviews(m, todayCN(new Date(t)), t).map((rv) => {
      const own = replies.get(rv.id);
      return own && own.hotelId === m.id ? { ...rv, reply: { text: own.text, at: own.at } } : rv;
    });
    return [...real, ...sim].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  function publicReview(rv) {
    const { issues, ...out } = rv;
    if (!out.roomType) delete out.roomType;
    return out;
  }

  /** Rating, count, star distribution and tags: the hotel's whole history (simulated) plus 小宿 guests' reviews. */
  function reviewSummary(m, list) {
    const real = list.filter((rv) => rv.source === 'xiaosu');
    const base = Math.max(0, Math.round(Number(m.hotel.reviewCount) || 0));
    const shares = starShares(m.hotel.rating);
    const exact = [5, 4, 3, 2, 1].map((s) => shares[s] * base);
    const counts = exact.map(Math.floor);
    let left = base - counts.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; left > 0; k = (k + 1) % 5, left--) counts[order[k][1]]++;
    const distribution = { 5: counts[0], 4: counts[1], 3: counts[2], 2: counts[3], 1: counts[4] };
    for (const rv of real) distribution[rv.rating] = (distribution[rv.rating] || 0) + 1;
    const count = base + real.length;
    const rating = count ? round(((Number(m.hotel.rating) || 4.5) * base + real.reduce((s, rv) => s + rv.rating, 0)) / count, 1) : Number(m.hotel.rating) || null;
    const tagCounts = new Map();
    praiseKeys(m).forEach((key, i) => tagCounts.set(PRAISE[key][0], Math.round(base * (0.06 + 0.16 * hash01(`${m.id}|tag|${key}`)) * (i < 3 ? 1.3 : 1))));
    for (const key of m.weak) tagCounts.set(ISSUES[key].tag, Math.round(base * (shares[3] + shares[2]) * (0.25 + 0.2 * hash01(`${m.id}|tag|${key}`))));
    for (const rv of real) for (const tag of rv.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const tags = [...tagCounts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([tag, n]) => ({ tag, count: n }));
    return { rating, count, distribution, tags };
  }

  /** GET reviews → { summary, reviews } (newest first). */
  function reviews(hotelId) {
    const m = modelFor(hotelId);
    const list = reviewList(m, nowMs());
    return { summary: reviewSummary(m, list), reviews: list.map(publicReview) };
  }

  function findReview(m, reviewId) {
    const id = str(reviewId, 80);
    const review = ID_RE.test(id) ? reviewList(m, nowMs()).find((rv) => rv.id === id) : null;
    if (!review) throw new MerchantError('not_found', '没有找到这条点评');
    return review;
  }

  /** A reply by template from the rating and what the review praised or complained about (no LLM). */
  function draftText(m, review) {
    const name = shortName(m.hotel.name);
    const v = hashString(`${review.id}|draft`) % 2;
    const [issue] = issuesOf(review);
    const fix = issue ? `关于${ISSUES[issue].label}，${ISSUES[issue].remedy}。` : '';
    if (review.rating >= 4) {
      const liked = LIKED.find(([key, re]) => (review.tags || []).includes(PRAISE[key]?.[0]) || re.test(review.text || ''))?.[2] || '服务';
      return v
        ? `感谢您的好评！很高兴您喜欢我们的${liked}。${fix}期待您下次再来，${name}随时为您服务～`
        : `谢谢您的认可！${liked}得到您的肯定，是对我们团队最大的鼓励。${fix}欢迎再次光临${name}。`;
    }
    if (review.rating === 3) return `感谢您的入住和中肯的评价。${fix || '您提到的问题我们已经反馈给相关部门改进。'}希望下次能给您更好的体验，${name}期待再次为您服务。`;
    return `非常抱歉这次没能让您满意。${fix || '我们已经把您的反馈转给值班经理跟进。'}如果方便，欢迎联系前台，我们一定认真处理，期待有机会弥补。`;
  }

  /** POST reviews/:id/draft-reply → { text }: a reply drafted from the review, for the hotel to edit. */
  function draftReply(hotelId, reviewId) {
    const m = modelFor(hotelId);
    return { text: draftText(m, findReview(m, reviewId)) };
  }

  /**
   * POST reviews/:id/reply { text } (1–300 characters) → { review }. A 小宿 guest's review carries the reply on
   * their review card too, and they hear about it (event, when the text is new).
   * @returns {{ review, event? }}  event: { kind: 'review_replied', userId, sessionId, review }
   */
  function replyReview(hotelId, reviewId, body = {}) {
    const m = modelFor(hotelId);
    const text = cleanText(body.text);
    if (!text) throw new MerchantError('invalid_reply', '回复内容不能为空');
    if (text.length > MAX_REPLY_CHARS) throw new MerchantError('invalid_reply', `回复最多${MAX_REPLY_CHARS}字（现在${text.length}字），精简一下吧`);
    const review = findReview(m, reviewId);
    if (review.source === 'xiaosu') {
      const out = viaStays(() => stays.replyReview(review.id, text));
      const updated = { ...review, reply: { ...out.review.reply } };
      const event = out.changed ? { kind: 'review_replied', userId: out.userId, sessionId: out.sessionId, review: out.review } : null;
      return { review: publicReview(updated), ...(event ? { event } : {}) };
    }
    const at = iso(nowMs());
    replies.set(review.id, { id: review.id, hotelId: m.id, text, at });
    return { review: publicReview({ ...review, reply: { text, at } }) };
  }

  // ---- promotions --------------------------------------------------------------------------------------------

  /** Views accrue while a promotion is on (until it ends), more for bigger hotels and deeper discounts; 小宿 orders are real. */
  function promotionView(m, p, t, xiaosuOrders) {
    const endMs = cnTimeMs(addDays(p.to, 1), '00:00');
    const onMs = (p.activeMs || 0) + (p.active && p.activeSince ? Math.max(0, Math.min(t, endMs) - Date.parse(p.activeSince)) : 0);
    const perHour = (4 + 10 * hash01(`${p.id}|views`)) * (1 + (1 - p.discount) * 2) * clamp(m.rooms.length / 200, 0.4, 2);
    const views = Math.floor((onMs / HOUR) * perHour);
    const orders = xiaosuOrders.filter((o) => o.rate?.promo?.id === p.id).length + Math.floor(views * (0.02 + 0.03 * hash01(`${p.id}|conv`)));
    return { id: p.id, title: p.title, discount: p.discount, from: p.from, to: p.to, active: Boolean(p.active), createdAt: p.createdAt, stats: { views, orders } };
  }

  function confirmedOrders(m) {
    return bookings.ordersForHotel(m.id).filter((o) => o.status === 'confirmed');
  }

  /** GET promotions → { promotions } (newest first). */
  function listPromotions(hotelId) {
    const m = modelFor(hotelId);
    const t = nowMs();
    const orders = confirmedOrders(m);
    return { promotions: promos.listFor(m.id).map((p) => promotionView(m, p, t, orders)) };
  }

  /** POST promotions { title, discount, from, to } → { promotion }. */
  function createPromotion(hotelId, body = {}) {
    const m = modelFor(hotelId);
    const p = promos.create(m.id, body || {});
    return { promotion: promotionView(m, p, nowMs(), confirmedOrders(m)) };
  }

  /** POST promotions/:id { active } → { promotion }. */
  function setPromotion(hotelId, promotionId, body = {}) {
    const m = modelFor(hotelId);
    const p = promos.setActive(m.id, promotionId, body?.active);
    return { promotion: promotionView(m, p, nowMs(), confirmedOrders(m)) };
  }

  // ---- overview ----------------------------------------------------------------------------------------------

  /** Rooms sold, room revenue, F&B and 小宿 room nights for the night of `date`; channels when asked. */
  function nightStats(m, real, date, channels) {
    const price = pricesOn(m, date);
    const rate = occRate(m, date);
    let sold = 0;
    let revenue = 0;
    for (const room of m.rooms) {
      if (heldByXiaosu(real, room.number, date) || hash01(`${m.id}|${room.number}|${date}|o`) >= rate) continue;
      sold++;
      revenue += price(room.type.roomId) * (0.9 + 0.2 * hash01(`${m.id}|${room.number}|${date}|rate`));
      if (channels) {
        const ch = pickChannel(m, hash01(`${m.id}|${room.number}|${date}|ch`));
        channels[ch] = (channels[ch] || 0) + 1;
      }
    }
    let xiaosu = 0;
    for (const r of real.list) {
      if (!(r.start <= date && date < r.nightsUntil)) continue;
      const rooms = Number(r.order.rooms) || 1;
      sold += rooms;
      const night = (r.order.nightly || []).find((n) => n.date === date);
      if (night) {
        revenue += night.price * rooms;
        xiaosu += rooms;
      }
    }
    if (channels) channels.xiaosu = (channels.xiaosu || 0) + xiaosu;
    const fnb = sold * FNB_PER_ROOM[m.category] * (0.75 + 0.5 * hash01(`${m.id}|${date}|fnb`));
    return { sold, occupancy: Math.min(1, sold / m.rooms.length), roomRevenue: revenue, fnb, xiaosu };
  }

  function channelWeights(m) {
    const w = { ...CHANNEL_MIX };
    if (m.category === 'economy') Object.assign(w, { meituan: w.meituan + 0.12, ctrip: w.ctrip - 0.04, direct: w.direct - 0.08 });
    if (m.category === 'luxury') Object.assign(w, { direct: w.direct + 0.1, meituan: w.meituan - 0.12, ctrip: w.ctrip + 0.02 });
    if (['scenic', 'resort', 'beach', 'inn'].includes(m.kind)) Object.assign(w, { fliggy: w.fliggy + 0.06, direct: w.direct - 0.06 });
    if (m.kind === 'cbd') Object.assign(w, { direct: w.direct + 0.06, fliggy: w.fliggy - 0.04 });
    for (const k of Object.keys(w)) w[k] = Math.max(0.02, w[k] * (0.85 + 0.3 * hash01(`${m.id}|mix|${k}`)));
    return w;
  }

  function pickChannel(m, u) {
    m.mix ??= channelWeights(m);
    const total = Object.values(m.mix).reduce((a, b) => a + b, 0);
    let x = u * total;
    for (const [k, w] of Object.entries(m.mix)) {
      if (x < w) return k;
      x -= w;
    }
    return 'ctrip';
  }

  /** Today's arrivals: 小宿 guests first, then the simulated ones by arrival time. */
  function arrivalsToday(m, ctx) {
    const out = [];
    for (const r of ctx.real.list) {
      const { order, stay } = r;
      const arriving = !stay && order.checkIn <= ctx.today && order.checkOut > ctx.today;
      const arrivedToday = stay && order.checkIn === ctx.today;
      if (!arriving && !arrivedToday) continue;
      const early = ctx.requests.find((x) => x.order.id === order.id && x.request.kind === 'early_checkin' && x.request.status !== 'cancelled')?.request;
      const eta = HHMM_RE.test(order.arrivalTime || '') ? order.arrivalTime.replace('：', ':').padStart(5, '0') : early?.arrivalTime;
      out.push({
        orderId: order.id, guest: maskName(order.guests?.[0]), roomType: order.room?.name || '', nights: order.nights,
        ...(eta ? { eta } : {}), source: 'xiaosu', status: stay ? 'checked_in' : 'arriving',
      });
    }
    const sim = [];
    const prev = addDays(ctx.today, -1);
    for (const room of m.rooms) {
      if (!occAt(m, ctx.real, room, ctx.today)) continue;
      if (occAt(m, ctx.real, room, prev) && continues(m, room, ctx.today)) continue;
      if (ctx.marks.get(room.number)?.ooo) continue;
      const s = simStay(m, ctx.real, room, ctx.today);
      const eta = etaOf(m, room, ctx.today);
      sim.push({
        guest: s.name, roomType: room.type.name, nights: Math.max(1, Math.round((Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 86400000)),
        eta: eta.time, source: 'sim', status: ctx.now >= eta.at ? 'checked_in' : 'arriving',
      });
    }
    sim.sort((a, b) => (a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0));
    return { list: [...out, ...sim], count: out.length + sim.length };
  }

  function whenText(date, today) {
    if (date === today) return '今晚';
    if (date === addDays(today, 1)) return '明天';
    if (date <= addDays(today, 6)) return weekdayCN(date);
    return formatDateCN(date);
  }

  /** 2–4 suggestions from rules over the numbers, the tickets and the reviews. */
  function buildInsights(m, ctx, { forecast, arrivals, reviewsList, orders }) {
    const out = [];
    const today = ctx.today;
    const waiting = ctx.tickets.filter((tk) => tk.status === 'new' && ctx.now - Date.parse(tk.createdAt) >= WAIT_ALERT_MS);
    if (waiting.length) {
      const oldest = waiting.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      out.push({
        id: 'tickets-waiting', level: 'warn', title: `${waiting.length} 张工单还没人接`,
        text: `最早一张已经等了 ${Math.round((ctx.now - Date.parse(oldest.createdAt)) / MIN)} 分钟：${oldest.roomNumber} 房 ${oldest.title}`,
        action: { tab: 'tickets', label: '去处理' },
      });
    }
    const since = ctx.now - 30 * 24 * HOUR;
    const mentions = new Map();
    for (const rv of reviewsList) {
      if (Date.parse(rv.at) < since || rv.rating > 3) continue;
      for (const key of issuesOf(rv)) mentions.set(key, (mentions.get(key) || 0) + 1);
    }
    const [topIssue] = [...mentions.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (topIssue && topIssue[1] >= 2) {
      const issue = ISSUES[topIssue[0]];
      out.push({
        id: `reviews-${topIssue[0]}`, level: 'warn', title: `${topIssue[1]} 条点评提到${issue.label}`,
        text: `最近 30 天的中差评里有 ${topIssue[1]} 条提到${issue.label}，${issue.advice}。`, action: { tab: 'reviews', label: '去回复' },
      });
    }
    const xiaosuWaiting = arrivals.filter((a) => a.source === 'xiaosu' && a.status === 'arriving');
    if (xiaosuWaiting.length) {
      out.push({
        id: 'xiaosu-arrivals', level: 'tip', title: `今天有 ${xiaosuWaiting.length} 位小宿客人到店`,
        text: `${xiaosuWaiting[0].guest} · ${xiaosuWaiting[0].roomType}${xiaosuWaiting[0].eta ? `，预计 ${xiaosuWaiting[0].eta} 到` : ''}；到店后在房态里点房间就能办入住。`,
        action: { tab: 'rooms', label: '去房态' },
      });
    }
    const full = forecast.find((f) => f.occupancy >= 0.9);
    if (full) {
      out.push({
        id: `full-${full.date}`, level: 'tip', title: `${whenText(full.date, today)}预计满房`,
        text: `${formatDateCN(full.date)}（${weekdayCN(full.date)}）预测入住率 ${Math.round(full.occupancy * 100)}%，可以把${m.types[0].name}上调 8–12%，低价渠道少放几间。`,
        action: { tab: 'reviews', label: '去营销' },
      });
    }
    const active = promos.activeFor(m.id);
    const low = forecast.slice(0, 7).filter((f) => f.occupancy < 0.55 && !active.some((p) => p.from <= f.date && f.date <= p.to))
      .sort((a, b) => a.occupancy - b.occupancy)[0];
    if (low) {
      out.push({
        id: `low-${low.date}`, level: 'tip', title: `${whenText(low.date, today)}入住率偏低`,
        text: `${formatDateCN(low.date)}（${weekdayCN(low.date)}）预测只有 ${Math.round(low.occupancy * 100)}%，可以开一个限时特惠（如 85 折），小宿的旅客搜索时就能看到。`,
        action: { tab: 'reviews', label: '开特惠' },
      });
    }
    const week = (from, to) => orders.filter((o) => {
      const at = Date.parse(o.createdAt);
      return at >= from && at < to;
    });
    const thisWeek = week(ctx.now - 7 * 24 * HOUR, ctx.now + 1);
    const lastWeek = week(ctx.now - 14 * 24 * HOUR, ctx.now - 7 * 24 * HOUR);
    if (thisWeek.length > lastWeek.length) {
      const nights = thisWeek.reduce((s, o) => s + (Number(o.nights) || 0) * (Number(o.rooms) || 1), 0);
      out.push({
        id: 'xiaosu-up', level: 'good', title: `小宿订单本周 +${thisWeek.length - lastWeek.length} 单`,
        text: `本周来自小宿的订单 ${thisWeek.length} 单（上周 ${lastWeek.length} 单），共 ${nights} 间夜。`,
      });
    }
    const unreplied = reviewsList.filter((rv) => !rv.reply && Date.parse(rv.at) >= ctx.now - 7 * 24 * HOUR);
    if (unreplied.length) {
      out.push({
        id: 'reviews-unreplied', level: 'tip', title: `${unreplied.length} 条新点评还没回复`,
        text: '及时回复差评能挽回不少印象分，好评也值得一句感谢；可以让小宿先起草一段。', action: { tab: 'reviews', label: '去回复' },
      });
    }
    const recent = reviewsList.filter((rv) => Date.parse(rv.at) >= since);
    const good = recent.filter((rv) => rv.rating >= 4).length;
    out.push({
      id: 'reviews-good', level: 'good', title: recent.length ? `近 30 天好评率 ${Math.round((good / recent.length) * 100)}%` : `评分 ${m.hotel.rating}`,
      text: recent.length ? `${recent.length} 条新点评里 ${good} 条 4 星以上，保持住～` : '最近还没有新点评，可以在客人退房时提醒他们写一写。',
    });
    return out.slice(0, 4);
  }

  /**
   * GET overview?days=30: today's KPIs, the last `days` nights (old → new, today last), the next 14 nights'
   * forecast, the channel mix over those days, today's arrivals and 2–4 suggestions. See docs/MERCHANT.md §2.
   */
  function overview(hotelId, { days } = {}) {
    const m = modelFor(hotelId);
    let n = DEFAULT_DAYS;
    if (!(days === undefined || days === null || days === '')) {
      n = typeof days === 'number' ? days : Number(String(days).trim());
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new MerchantError('invalid_days', `days 需要是 1–${MAX_DAYS} 之间的整数`);
    }
    const t = nowMs();
    const ctx = dayContext(m, t);
    // Tonight is the night in progress (before 06:00 the one that began yesterday); `date` is the calendar date.
    const { today } = ctx;
    const total = m.rooms.length;
    const dining = diningByDate(ctx.requests);
    const diningOn = (date) => dining.get(date) || 0;
    const channels = {};
    const series = [];
    for (let i = n - 1; i >= 0; i--) {
      const date = addDays(today, -i);
      const s = nightStats(m, ctx.real, date, channels);
      series.push({
        date, occupancy: round(s.occupancy, 3), revenue: Math.round(s.roomRevenue + s.fnb + diningOn(date)),
        adr: s.sold ? Math.round(s.roomRevenue / s.sold) : 0, xiaosu: s.xiaosu,
      });
    }
    const forecast = [];
    for (let i = 1; i <= FORECAST_DAYS; i++) {
      const date = addDays(today, i);
      forecast.push({ date, occupancy: round(nightStats(m, ctx.real, date).occupancy, 3) });
    }
    const tonight = nightStats(m, ctx.real, today);
    const lastWeek = nightStats(m, ctx.real, addDays(today, -7));
    const revenue = tonight.roomRevenue + tonight.fnb + diningOn(today);
    const revenueLastWeek = lastWeek.roomRevenue + lastWeek.fnb + diningOn(addDays(today, -7));
    const grid = gridRooms(m, ctx).map((room) => roomView(m, ctx, room, today));
    const arrivals = arrivalsToday(m, ctx);
    const prev = addDays(today, -1);
    let departures = 0;
    for (const room of m.rooms) {
      if (occAt(m, ctx.real, room, prev) && !(occAt(m, ctx.real, room, today) && continues(m, room, today))) departures++;
    }
    departures += ctx.real.list.filter((r) => r.stay && (r.outDate ? r.outDate === today : r.order.checkOut === today)).length;
    const list = reviewList(m, t, ctx.requests);
    const summary = reviewSummary(m, list);
    const nightsTotal = Object.values(channels).reduce((a, b) => a + b, 0) || 1;
    return {
      hotel: { id: m.id, name: m.hotel.name, city: String(m.hotel.city || '').replace(/市$/, ''), category: m.category, rating: m.hotel.rating ?? null, rooms: total },
      date: todayCN(new Date(t)),
      kpis: {
        occupancy: round(tonight.occupancy, 3),
        revenue: Math.round(revenue),
        adr: tonight.sold ? Math.round(tonight.roomRevenue / tonight.sold) : 0,
        revpar: Math.round(tonight.roomRevenue / total),
        arrivals: arrivals.count,
        departures,
        inHouse: grid.filter((r) => r.status === 'occupied' || r.status === 'departing').length,
        openTickets: ctx.tickets.filter((tk) => tk.status === 'new' || tk.status === 'doing').length,
        rating: summary.rating,
        reviewCount: summary.count,
        vsLastWeek: {
          occupancy: lastWeek.occupancy ? round((tonight.occupancy - lastWeek.occupancy) / lastWeek.occupancy, 3) : 0,
          revenue: revenueLastWeek ? round((revenue - revenueLastWeek) / revenueLastWeek, 3) : 0,
        },
      },
      series,
      forecast,
      channels: CHANNELS.map((key) => ({ key, label: CHANNEL_LABELS[key], share: round((channels[key] || 0) / nightsTotal, 3), nights: channels[key] || 0 })),
      arrivals: arrivals.list.slice(0, MAX_ARRIVALS),
      insights: buildInsights(m, ctx, { forecast, arrivals: arrivals.list, reviewsList: list, orders: confirmedOrders(m) }),
    };
  }

  /** 小宿 guests' meals served, on the room bill, by date (simulated F&B is in nightStats). */
  function diningByDate(requests) {
    const byDate = new Map();
    for (const { request: r } of requests) {
      if (r.kind !== 'dining' || r.status !== 'done' || !(r.price > 0)) continue;
      const date = cnDate(r.at);
      byDate.set(date, (byDate.get(date) || 0) + r.price * Math.max(0, r.people - (Number(r.covered) || 0)));
    }
    return byDate;
  }

  // ---- hotels ------------------------------------------------------------------------------------------------

  /** The first simulated hotel of a city (by code) that `pred` accepts, or null (not the simulator's ids). */
  function firstHotel(code, pred) {
    for (let i = 1; i <= 40; i++) {
      let hotel = null;
      try {
        hotel = hotels.getHotel(`sim-${code}-${String(i).padStart(3, '0')}`);
      } catch {
        hotel = null;
      }
      if (!hotel) return null;
      if (pred(hotel)) return hotel;
    }
    return null;
  }

  /** 杭州西湖边的第一家模拟酒店: the console's hotel before anyone has booked. */
  function demoHotel() {
    const area = findCity('杭州')?.areas.find((a) => a.landmarks.some((l) => l.name === '西湖'));
    return firstHotel('hz', (h) => !area || h.businessArea === area.name);
  }

  /**
   * GET hotels → { hotels: [{ id, name, city, category, rating, rooms, hasGuests }], current }: hotels 小宿 guests
   * booked (most recent first), the demo hotel and a few other kinds (a luxury hotel, a courtyard inn, an economy
   * one). `current` is the hotel of the latest confirmed order, else the demo hotel.
   */
  function listHotels() {
    const t = nowMs();
    const today = todayCN(new Date(t));
    const latest = new Map();
    const guests = new Set();
    for (const o of orderRecords.values()) {
      if (o.status !== 'confirmed' || !o.hotel?.id) continue;
      const at = o.payment?.paidAt || o.updatedAt || o.createdAt || '';
      if (!latest.has(o.hotel.id) || latest.get(o.hotel.id) < at) latest.set(o.hotel.id, at);
      if (o.checkOut >= today) guests.add(o.hotel.id);
    }
    const booked = [...latest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([id]) => id);
    const demo = demoHotel();
    const samples = [
      demo,
      firstHotel('sh', (h) => h.category === 'luxury'),
      firstHotel('lj', (h) => h.businessArea === '大研古城' && h.category === 'comfort'),
      firstHotel('cd', (h) => h.category === 'economy'),
    ].filter(Boolean).map((h) => h.id);
    const list = [];
    for (const id of [...booked, ...samples]) {
      if (list.some((x) => x.id === id)) continue;
      let hotel = null;
      try {
        hotel = hotels.getHotel(id);
      } catch {
        hotel = null;
      }
      if (!hotel) continue;
      const m = modelOf(hotel);
      list.push({
        id: hotel.id, name: hotel.name, city: String(hotel.city || '').replace(/市$/, ''), category: m.category,
        rating: hotel.rating ?? null, rooms: m.rooms.length, hasGuests: guests.has(hotel.id),
      });
    }
    const current = booked.find((id) => list.some((x) => x.id === id)) || demo?.id || list[0]?.id || null;
    return { hotels: list, current };
  }

  return {
    listHotels, overview, rooms, roomAction, tickets, ticketAction, reviews, draftReply, replyReview,
    listPromotions, createPromotion, setPromotion,
  };
}
