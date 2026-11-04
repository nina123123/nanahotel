import * as defaultIds from '../util/ids.js';
import { todayCN, addDays, isValidDate, nightsBetween, cnTimeMs, formatDateCN } from '../util/dates.js';
import { PAYMENT_METHOD_LABELS, maskPhone, normalizeMethod, toPublicOrder } from './bookings.js';
import { hashString } from './hotels/sim-hotels.js';
import { findCity } from './hotels/sim-cities.js';
import { buildRoomOffer } from './hotels/pricing.js';

/**
 * The guest journey after a booking is paid: rides and airport pickups, early check-in, check-in (room, e-key,
 * Wi-Fi), deliveries to the room, dining reservations, wake-up calls, stay extensions, the check-out bill,
 * invoices, membership points and reviews. All simulated: room numbers, drivers and plates derive from the
 * order id, Wi-Fi, breakfast and facilities from the hotel id, so the same order always gets the same ones.
 *
 * Same style as bookings.js: synchronous methods, the injected clock, and statuses worked out whenever a record
 * is read (a delivery is on its way after a minute, a ride quote expires after 15), so there are no timers.
 * Spending money and publishing need the user's own tap: the agent only prepares ride and extension quotes and
 * review drafts; confirmRide, confirmExtension and publishReview are called from the HTTP routes.
 *
 * Every request record and view carries `kind`, its category (ride, early_checkin, service, dining, wakeup,
 * invoice, extension, review); a ride's own type is `rideKind`, a meal's `mealKind`, an invoice's `invoiceKind`.
 *
 * The hotel's side (merchant.js, docs/MERCHANT.md) reads a hotel's stays and requests whoever booked them, checks
 * guests in at the front desk (the same room as their own check-in), moves deliveries on and answers early
 * check-ins (sooner than the usual pace, never back), and replies to published reviews.
 */

const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;
const QUOTE_TTL_MS = 15 * MIN;
const DELIVERY_ON_THE_WAY_MS = MIN;
const DELIVERY_DONE_MS = 5 * MIN;
const INVOICE_ISSUE_MS = 2 * MIN;
const DRIVER_ASSIGN_MS = 90 * 1000;
const DRIVER_EARLY_MS = 5 * MIN;
const DEFAULT_PICKUP_IN_MS = 15 * MIN;
const MAX_PICKUP_AHEAD_DAYS = 60;
const EARLY_CHECKIN_FROM = '11:00';
const STANDARD_CHECKIN = '14:00';
const CHECKOUT_TIME = '12:00';
const BREAKFAST_HOURS = '07:00–10:00';
const BREAKFAST_PRICE = 68;
const MAX_REVIEW_CHARS = 300;
const MAX_REPLY_CHARS = 300;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const TAX_ID_RE = /^(?:[0-9A-Z]{15}|[0-9A-Z]{18}|[0-9A-Z]{20})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMPANY_RE = /公司|集团|有限|研究院|研究所|事务所|工作室|中心|学校|大学|学院|医院|银行|协会|委员会|基金会/;
const HOTEL_WORD_RE = /^(?:酒店|宾馆|饭店|旅馆|民宿|住处|住的地方|我住的(?:酒店|地方)|hotel)$/i;

const STATUS = {
  unauthorized: 401, not_found: 404, no_order: 404, expired: 410,
  sold_out: 409, price_changed: 409, superseded: 409, order_not_confirmed: 409, not_checked_in: 409,
  checked_out: 409, already_checked_in: 409, already_published: 409, stay_over: 409,
  invalid_action: 409, not_arrived: 409, not_published: 409,
};

/** Typed stay error; `message` is user-facing Chinese. */
export class StayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StayError';
    this.code = code;
    this.status = STATUS[code] || 400;
    if (details) this.details = details;
  }
}

export const RIDE_KIND_LABELS = Object.freeze({ airport_pickup: '接机', to_hotel: '去酒店', from_hotel: '从酒店出发', taxi: '打车' });
export const MEALS = Object.freeze({
  breakfast: Object.freeze({ label: '早餐', from: '07:00', to: '10:00' }),
  lunch: Object.freeze({ label: '午餐', from: '11:30', to: '14:00' }),
  dinner: Object.freeze({ label: '晚餐', from: '17:30', to: '21:30' }),
});
// Simulated perks only: nothing here changes a price the user sees.
export const MEMBER_LEVELS = Object.freeze([
  Object.freeze({ name: '银卡', min: 0, perks: Object.freeze(['退房按实付金额累积积分（1元=1积分）', '延迟退房至13:00（视房态）']) }),
  Object.freeze({ name: '金卡', min: 2000, perks: Object.freeze(['延迟退房至14:00（视房态）', '优先安排高楼层、安静房间', '入住欢迎水果']) }),
  Object.freeze({ name: '铂金卡', min: 8000, perks: Object.freeze(['延迟退房至16:00（视房态）', '免费升级房型（视房态）', '行政酒廊礼遇', '专属客服']) }),
]);

const CATEGORIES = ['economy', 'comfort', 'premium', 'luxury'];
const FLOORS = { economy: [2, 8], comfort: [3, 12], premium: [5, 20], luxury: [12, 32] };
const INN_FLOORS = [1, 3];
const UNLUCKY_FLOORS = new Set([4, 13, 14]);
const BREAKFAST_VENUES = {
  economy: [['1楼', '早餐厅'], ['2楼', '早餐厅']],
  comfort: [['2楼', '自助餐厅'], ['1楼', '全日餐厅'], ['3楼', '自助餐厅']],
  premium: [['2楼', '全日餐厅'], ['3楼', '自助餐厅'], ['1楼', '咖啡厅']],
  luxury: [['2楼', '全日餐厅'], ['1楼', '大堂餐厅'], ['3楼', '自助餐厅']],
  inn: [['1楼', '庭院餐厅'], ['1楼', '茶室']],
};
const RESTAURANTS = { economy: ['简餐厅', 58], comfort: ['全日餐厅', 88], premium: ['中餐厅', 168], luxury: ['中餐厅', 288] };

// Wi-Fi names come from the brand stems of the simulated hotels (sim-hotels.js BRANDS); others get XiaoSu-Guest.
const STEM_PINYIN = {
  悦途: 'YueTu', 简居: 'JianJu', 青舍: 'QingShe', 拾光: 'ShiGuang', 憩园: 'QiYuan', 行舍: 'XingShe', 小栈: 'XiaoZhan', 禾宿: 'HeSu', 朴宿: 'PuSu', 途悠: 'TuYou',
  栖云: 'QiYun', 漫居: 'ManJu', 云舍: 'YunShe', 素履: 'SuLv', 星屿: 'XingYu', 屿见: 'YuJian', 晴舍: 'QingShe', 松间: 'SongJian', 溪岸: 'XiAn', 木禾: 'MuHe',
  观潮: 'GuanChao', 澜庭: 'LanTing', 听松: 'TingSong', 映月: 'YingYue', 清岚: 'QingLan', 临水: 'LinShui', 若水: 'RuoShui', 揽月: 'LanYue', 映岚: 'YingLan', 叠翠: 'DieCui',
  隐庐: 'YinLu', 静庐: 'JingLu', 臻园: 'ZhenYuan', 澄庐: 'ChengLu', 观止: 'GuanZhi', 揽胜: 'LanSheng', 云麓: 'YunLu', 鹤庐: 'HeLu', 山澜: 'ShanLan', 望庐: 'WangLu',
  竹篱: 'ZhuLi', 花溪: 'HuaXi', 青檐: 'QingYan', 慢屿: 'ManYu', 南风: 'NanFeng', 归园: 'GuiYuan', 素心: 'SuXin', 听雨: 'TingYu', 木心: 'MuXin', 檐下: 'YanXia',
};
export const WIFI_STEMS = Object.freeze(Object.keys(STEM_PINYIN));

const SURNAMES = ['张', '王', '李', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '胡', '朱', '郭', '何', '林', '罗', '高'];
const CARS = [['比亚迪汉EV', '白色'], ['比亚迪秦PLUS', '白色'], ['广汽埃安S', '蓝色'], ['吉利几何A', '银色'], ['大众ID.4', '黑色']];
const VANS = [['别克GL8', '黑色'], ['广汽传祺M8', '银色']];
const PLATE_PREFIX = {
  北京: '京A', 上海: '沪A', 广州: '粤A', 深圳: '粤B', 杭州: '浙A', 成都: '川A', 重庆: '渝A', 西安: '陕A',
  南京: '苏A', 苏州: '苏E', 厦门: '闽D', 三亚: '琼B', 青岛: '鲁B', 长沙: '湘A', 武汉: '鄂A', 丽江: '云P',
};

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
}

/** One line of model/user text: no control characters, and no 【】 that could pass for a platform notice. */
function clean(v, max) {
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[【】]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Free text (a review): line breaks kept, nothing cut, so the caller can refuse an over-long one. */
function cleanText(v) {
  return (typeof v === 'string' ? v : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[【】]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function money(n) {
  return Math.round(Number(n) || 0);
}

function sum(list, pick) {
  return list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);
}

function intIn(v, min, max, message) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new StayError('invalid_number', message);
  return n;
}

/** 'HH:MM' (or 'H:MM') → zero-padded 'HH:MM'. */
function requireTime(v, what) {
  const m = TIME_RE.exec(str(v, 10).replace('：', ':'));
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) throw new StayError('invalid_time', `${what}需要是 HH:MM 格式，如 07:30`);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function requireDate(v, what) {
  const d = str(v, 10);
  if (!isValidDate(d)) throw new StayError('invalid_date', `${what}需要是 YYYY-MM-DD 格式的有效日期`);
  return d;
}

function cityOf(order) {
  return String(order?.hotel?.city || '').replace(/市$/, '');
}

function partyOf(order) {
  return (Number(order.adults) || 1) + (Number(order.children) || 0);
}

/** A ride's statuses over time: the quote expires after 15 minutes; once confirmed the driver comes and goes. */
function rideTimes(r) {
  const pickup = Date.parse(r.pickupAt);
  const arrivingAt = Math.max(Date.parse(r.confirmedAt) + DRIVER_ASSIGN_MS, pickup - DRIVER_EARLY_MS);
  // Confirmed after the pickup time: the trip starts when the driver gets there.
  return { arrivingAt, completedAt: Math.max(pickup, arrivingAt) + r.minutes * MIN };
}

function rideStatus(r, t) {
  if (r.status === 'quoted') return t >= Date.parse(r.expiresAt) ? 'expired' : 'quoted';
  if (r.status !== 'confirmed') return r.status;
  const { arrivingAt, completedAt } = rideTimes(r);
  if (t >= completedAt) return 'completed';
  return t >= arrivingAt ? 'arriving' : 'confirmed';
}

function extensionStatus(r, t) {
  return r.status === 'pending' && t >= Date.parse(r.expiresAt) ? 'expired' : r.status;
}

/** accepted → on_the_way → done; the hotel's 接单 / 送达 (onTheWayAt / doneAt) can come sooner than the usual pace, never later. */
function deliverySteps(r) {
  const created = Date.parse(r.createdAt);
  const done = Math.min(created + DELIVERY_DONE_MS, r.doneAt ? Date.parse(r.doneAt) : Infinity);
  const onTheWay = Math.min(created + DELIVERY_ON_THE_WAY_MS, r.onTheWayAt ? Date.parse(r.onTheWayAt) : Infinity, done);
  return [['accepted', created], ['on_the_way', onTheWay], ['done', done]];
}

function issuedAtMs(r) {
  return Date.parse(r.requestedAt || r.createdAt) + INVOICE_ISSUE_MS;
}

/** `kind: 'ride'` is the request category; the ride's own type is rideKind. */
function rideView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'ride', rideKind: r.rideKind, kindLabel: RIDE_KIND_LABELS[r.rideKind] || r.rideKind,
    from: r.from, to: r.to, pickupAt: r.pickupAt, passengers: r.passengers, carType: r.carType, fare: r.fare, minutes: r.minutes,
    status: rideStatus(r, t), expiresAt: r.expiresAt, createdAt: r.createdAt,
    ...(r.confirmedAt ? { confirmedAt: r.confirmedAt } : {}),
    ...(r.driver ? { driver: { ...r.driver } } : {}),
  };
}

function earlyView(r) {
  return {
    id: r.id, orderId: r.orderId, kind: 'early_checkin', hotel: { ...r.hotel }, date: r.date, arrivalTime: r.arrivalTime,
    status: r.status, note: r.note, createdAt: r.createdAt,
  };
}

function serviceView(r, t) {
  const reached = deliverySteps(r).filter(([, at], i) => i === 0 || t >= at);
  const [, , [, doneAt]] = deliverySteps(r);
  return {
    id: r.id, orderId: r.orderId, kind: 'service', roomNumber: r.roomNumber, items: r.items.map((i) => ({ ...i })),
    ...(r.note ? { note: r.note } : {}),
    status: reached[reached.length - 1][0], createdAt: r.createdAt, eta: new Date(doneAt).toISOString(),
    timeline: reached.map(([status, at]) => ({ status, at: new Date(at).toISOString() })),
  };
}

/** `kind: 'dining'` is the request category; breakfast / lunch / dinner is mealKind. */
function diningView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'dining', mealKind: r.mealKind, kindLabel: MEALS[r.mealKind]?.label || r.mealKind,
    restaurant: r.restaurant, place: r.place, at: r.at, people: r.people, table: r.table, price: r.price, included: r.included,
    ...(r.covered > 0 ? { covered: r.covered } : {}),
    ...(r.note ? { note: r.note } : {}),
    status: r.status === 'cancelled' ? 'cancelled' : t < Date.parse(r.at) ? 'reserved' : 'done', createdAt: r.createdAt,
  };
}

function wakeupView(r, t) {
  const status = r.status === 'cancelled' ? 'cancelled' : t >= Date.parse(r.at) ? 'done' : 'set';
  return { id: r.id, orderId: r.orderId, kind: 'wakeup', roomNumber: r.roomNumber, at: r.at, status, createdAt: r.createdAt };
}

/** `kind: 'invoice'` is the request category; the invoice type (电子普通发票) is invoiceKind. */
function invoiceView(r, t) {
  const issued = t >= issuedAtMs(r);
  return {
    id: r.id, orderId: r.orderId, kind: 'invoice', invoiceKind: '电子普通发票', title: r.title,
    ...(r.taxId ? { taxId: r.taxId } : {}),
    ...(r.email ? { email: r.email } : {}),
    amount: r.amount, status: issued ? 'issued' : 'issuing',
    ...(issued ? { issuedAt: new Date(issuedAtMs(r)).toISOString() } : {}),
    createdAt: r.createdAt,
  };
}

function extensionView(r, t) {
  return {
    id: r.id, orderId: r.orderId, kind: 'extension', hotel: { ...r.hotel }, room: r.room, fromDate: r.fromDate, toDate: r.toDate,
    nights: r.nights, price: r.price, status: extensionStatus(r, t), expiresAt: r.expiresAt, createdAt: r.createdAt,
    ...(r.confirmedAt ? { confirmedAt: r.confirmedAt, payment: { ...r.payment } } : {}),
  };
}

function reviewView(r) {
  return {
    id: r.id, orderId: r.orderId, kind: 'review', hotel: { ...r.hotel }, rating: r.rating, text: r.text, tags: [...r.tags],
    status: r.status, createdAt: r.createdAt,
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    ...(r.reply ? { reply: { text: r.reply.text, at: r.reply.at } } : {}),
  };
}

const VIEWS = {
  ride: rideView, early_checkin: earlyView, service: serviceView, dining: diningView, wakeup: wakeupView,
  invoice: invoiceView, extension: extensionView, review: reviewView,
};

function viewOf(r, t) {
  return VIEWS[r.kind] ? VIEWS[r.kind](r, t) : null;
}

/** '10月30日 14:00' in China time. */
function cnWhen(iso) {
  const s = new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString();
  return `${formatDateCN(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

/** An in-progress request for stay_info.open: { kind, id, label, status }, or null when it is settled. */
function openItem(r, t) {
  const v = viewOf(r, t);
  if (!v) return null;
  const item = (label) => ({ kind: r.kind, id: r.id, label, status: v.status });
  switch (r.kind) {
    case 'ride': return ['quoted', 'confirmed', 'arriving'].includes(v.status) ? item(`${v.kindLabel} · ${cnWhen(v.pickupAt)}`) : null;
    case 'early_checkin': return v.status === 'pending' ? item(`提前入住 · ${v.arrivalTime}`) : null;
    case 'service': return v.status !== 'done' ? item(v.items.map((i) => `${i.name}×${i.qty}`).join('、')) : null;
    case 'dining': return v.status === 'reserved' ? item(`${v.kindLabel} · ${cnWhen(v.at)} · ${v.people}位`) : null;
    case 'wakeup': return v.status === 'set' ? item(`叫醒 · ${cnWhen(v.at)}`) : null;
    case 'invoice': return v.status === 'issuing' ? item(`发票 · ${v.title}`) : null;
    case 'extension': return v.status === 'pending' ? item(`续住${v.nights}晚 · 待确认`) : null;
    case 'review': return v.status === 'draft' ? item('点评草稿 · 待发布') : null;
    default: return null;
  }
}

/** Hotels in a 民宿/客栈 area are low-rise; below luxury they are courtyard inns without gym or pool (as in the simulator). */
function innArea(hotel) {
  if (!hotel) return false;
  const area = findCity(hotel.city)?.areas.find((a) => a.name === hotel.businessArea);
  return area ? area.kind === 'inn' : /民宿|客栈|小院|院子/.test(hotel.name || '');
}

function stemOf(name) {
  let best = null;
  for (const stem of WIFI_STEMS) {
    const at = name.indexOf(stem);
    if (at >= 0 && (!best || at < best.at)) best = { at, stem };
  }
  return best ? STEM_PINYIN[best.stem] : null;
}

/**
 * @param {{ store: { collection(name: string) },
 *           bookings: { getOrder, listOrders, extendOrder, ordersForHotel?, markCheckedIn? }, hotels: { getHotel, priceCheck },
 *           clock?: { now: () => Date }, ids?: Partial<typeof defaultIds> }} deps
 */
export function createStayService({ store, bookings, hotels, clock = { now: () => new Date() }, ids } = {}) {
  if (!store) throw new Error('createStayService: store is required');
  if (!bookings) throw new Error('createStayService: bookings is required');
  if (!hotels) throw new Error('createStayService: hotels is required');
  const idgen = { ...defaultIds, ...(ids || {}) };
  const stays = store.collection('stays');
  const requests = store.collection('stay_requests');
  // Read only, to find a front-desk order by its id (bookings.js owns the collection; the front desk has no user id).
  const orderRecords = store.collection('orders');
  const nowMs = () => clock.now().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const profiles = new Map();

  function requireUser(userId) {
    const u = str(userId, 100);
    if (!u) throw new StayError('unauthorized', '缺少用户身份，请刷新页面后重试');
    return u;
  }

  // ---- hotel facts (deterministic per hotel id) ---------------------------------------------

  function profileOf(order) {
    const hotelId = order.hotel?.id || '';
    if (profiles.has(hotelId)) return profiles.get(hotelId);
    let hotel = null;
    try {
      hotel = hotels.getHotel?.(hotelId) || null;
    } catch {
      hotel = null;
    }
    const h = (k) => hashString(`${hotelId}|${k}`);
    const between = (k, lo, hi) => lo + (h(k) % (hi - lo + 1));
    const category = CATEGORIES.includes(hotel?.category) ? hotel.category : 'comfort';
    const lowRise = innArea(hotel);
    const courtyard = lowRise && category !== 'luxury';
    const pinyin = stemOf(hotel?.name || order.hotel?.name || '');
    const initials = pinyin ? pinyin.replace(/[a-z]/g, '').toLowerCase() : 'xs';
    const venues = BREAKFAST_VENUES[lowRise ? 'inn' : category];
    const [bfPlace, bfName] = venues[h('breakfast') % venues.length];
    const [restaurant, price] = RESTAURANTS[category];
    const telCode = findCity(hotel?.city || order.hotel?.city)?.telCode || '400';
    let facilities;
    if (courtyard) {
      facilities = [{ name: '公共茶室', hours: '08:00–22:00', place: '1楼' }, { name: '自助洗衣', hours: '24小时', place: '1楼' }];
    } else if (category === 'luxury' || category === 'premium') {
      const outdoor = (hotel?.amenities || []).includes('室外泳池');
      facilities = [
        { name: outdoor ? '室外泳池' : '室内泳池', hours: '06:30–22:00', place: outdoor ? '1楼 花园' : `${between('pool', 3, 6)}楼` },
        { name: '健身房', hours: '24小时', place: `${between('gym', 3, 6)}楼` },
        { name: '行政酒廊', hours: '07:00–22:00', place: `${category === 'luxury' ? between('lounge', 25, 32) : between('lounge', 15, 20)}楼` },
      ];
    } else if (category === 'comfort') {
      facilities = [
        { name: '健身房', hours: '06:00–23:00', place: `${between('gym', 2, 5)}楼` },
        { name: '洗衣房', hours: '24小时', place: `${between('laundry', 2, 5)}楼` },
      ];
    } else {
      facilities = [{ name: '自助洗衣', hours: '24小时', place: `${between('laundry', 1, 3)}楼` }];
    }
    const profile = {
      hotel,
      category,
      lowRise,
      wifi: { ssid: `${pinyin || 'XiaoSu'}-Guest`, password: `${initials}${String(h('wifi') % 1e6).padStart(6, '0')}` },
      breakfast: { time: BREAKFAST_HOURS, place: `${bfPlace} ${bfName}`, price: BREAKFAST_PRICE },
      breakfastVenue: { restaurant: bfName, place: bfPlace },
      restaurant: { restaurant: courtyard ? '私房菜餐厅' : restaurant, place: lowRise ? '1楼' : `${between('restaurant', 2, 3)}楼`, price },
      // The simulator's 0000 numbers cannot reach anyone real.
      frontDesk: hotel?.tel || `${telCode}-0000${String(h('tel') % 1e4).padStart(4, '0')}`,
      facilities,
    };
    profiles.set(hotelId, profile);
    return profile;
  }

  /** The floors the rooms card showed for the booked room type ('5-14层'), else the hotel's usual range. */
  function floorRange(order, prof) {
    try {
      const offer = prof.hotel ? buildRoomOffer(prof.hotel, { checkIn: order.checkIn, checkOut: order.checkOut }) : null;
      const m = /^(\d+)-(\d+)层$/.exec(offer?.roomTypes.find((rt) => rt.roomId === order.room?.roomId)?.floor || '');
      if (m) return [Number(m[1]), Number(m[2])];
    } catch {
      // not a simulated hotel: use the defaults below
    }
    return prof.lowRise ? INN_FLOORS : FLOORS[prof.category];
  }

  function assignRoom(order, prof) {
    const [lo, hi] = floorRange(order, prof);
    let floors = [];
    for (let f = lo; f <= hi; f++) if (!UNLUCKY_FLOORS.has(f)) floors.push(f);
    if (!floors.length) floors = [lo];
    const h = hashString(`${order.id}|room`);
    const floor = floors[h % floors.length];
    const index = 1 + (Math.floor(h / floors.length) % (prof.lowRise ? 8 : 28));
    return { floor, roomNumber: `${floor}${String(index).padStart(2, '0')}` };
  }

  // ---- orders and stays ------------------------------------------------------------------------

  function ownOrder(u, orderId) {
    const o = bookings.getOrder(u, str(orderId, 80).toUpperCase());
    if (!o) throw new StayError('not_found', '没有找到这个订单');
    return o;
  }

  function requireConfirmed(order) {
    if (order.status === 'confirmed') return order;
    if (order.status === 'cancelled') throw new StayError('order_not_confirmed', '这个订单已经取消了');
    if (order.status === 'pending_payment') throw new StayError('order_not_confirmed', '这个订单还没支付，支付后才能安排');
    throw new StayError('order_not_confirmed', '这个订单已关闭，不能再安排');
  }

  function stayRec(order) {
    const s = stays.get(order.id);
    return s && s.userId === order.userId ? s : null;
  }

  /**
   * The user's confirmed orders whose stay ended at most `horizon` days ago, most current first: checked in and
   * not out; dates covering today; upcoming (soonest first); checked out today or yesterday; then the ones that
   * ended. With `afterStay` (an invoice, a review: what is asked right after leaving) a stay checked out today or
   * yesterday comes right after the checked-in one instead. A stay ends at check-out, else on its check-out date.
   * Ties keep listOrders' newest-first order.
   */
  function rankOrders(u, t, { horizon = 1, afterStay = false } = {}) {
    const today = todayCN(new Date(t));
    const yesterday = addDays(today, -1);
    const oldest = addDays(today, -horizon);
    const ranked = [];
    for (const order of bookings.listOrders(u)) {
      if (order.status !== 'confirmed') continue;
      const rec = stayRec(order);
      const leftOn = rec?.checkedOutAt ? todayCN(new Date(Date.parse(rec.checkedOutAt))) : null;
      const ended = leftOn || order.checkOut;
      if (ended < oldest) continue;
      let tier;
      let key = 0;
      if (rec && !leftOn) {
        tier = 0;
        key = -Date.parse(rec.checkedInAt);
      } else if (leftOn && leftOn >= yesterday) {
        tier = afterStay ? 1 : 4;
        key = -Date.parse(rec.checkedOutAt);
      } else if (!leftOn && order.checkIn <= today && order.checkOut >= today) {
        tier = 2;
      } else if (!leftOn && order.checkIn > today) {
        tier = 3;
        key = nightsBetween(today, order.checkIn);
      } else {
        tier = 5;
        key = nightsBetween(ended, today);
      }
      ranked.push({ order, tier, key });
    }
    return ranked.sort((a, b) => a.tier - b.tier || a.key - b.key);
  }

  function currentOrder(u, opts) {
    const [first] = rankOrders(u, nowMs(), opts);
    if (!first) throw new StayError('no_order', '还没有已确认的订单，订好并支付后我再帮你安排');
    return first.order;
  }

  /** The order a request is about: the one named, else the current one (see rankOrders); it must be confirmed. */
  function resolveOrder(userId, orderId, opts = {}) {
    const u = requireUser(userId);
    return requireConfirmed(str(orderId, 80) ? ownOrder(u, orderId) : currentOrder(u, opts));
  }

  function requireCheckedIn(order) {
    const rec = stayRec(order);
    if (!rec) throw new StayError('not_checked_in', '还没办入住，办好入住后才能安排（可以先帮你办入住）');
    if (rec.checkedOutAt) throw new StayError('checked_out', '这一单已经退房了，住店服务已结束');
    return rec;
  }

  function requireNotCheckedOut(order) {
    if (stayRec(order)?.checkedOutAt) throw new StayError('checked_out', '这一单已经退房了');
  }

  function stayView(order, rec) {
    const prof = profileOf(order);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name, category: prof.category },
      roomType: order.room?.name || '',
      roomNumber: rec.roomNumber,
      floor: rec.floor,
      checkIn: order.checkIn,
      checkOut: order.checkOut,
      nights: order.nights,
      guests: [...(order.guests || [])],
      checkedInAt: rec.checkedInAt,
      early: rec.early,
      // The key stops working at check-out.
      keyValidUntil: rec.checkedOutAt || iso(cnTimeMs(order.checkOut, CHECKOUT_TIME)),
      wifi: { ...prof.wifi },
      breakfast: { ...prof.breakfast, included: (order.rate?.breakfast || 0) > 0 },
      checkoutTime: CHECKOUT_TIME,
      ...(rec.checkedOutAt ? { checkedOutAt: rec.checkedOutAt, bill: structuredClone(rec.bill) } : {}),
    };
  }

  // ---- requests --------------------------------------------------------------------------------

  /** An order's requests in the order they were made (the store keeps insertion order; the sort is stable). */
  function requestsOf(order) {
    return requests
      .values()
      .filter((r) => r.orderId === order.id && r.userId === order.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  function ownRequest(u, id, kind) {
    const r = requests.get(str(id, 80));
    if (!r || r.userId !== u || (kind && r.kind !== kind)) throw new StayError('not_found', '没有找到这个请求，可能已失效');
    return r;
  }

  function base(kind, order, sessionId, t, prefix) {
    return { id: idgen.newId(prefix), kind, userId: order.userId, orderId: order.id, sessionId: str(sessionId, 100) || null, createdAt: iso(t) };
  }

  /** Today when that time is still ahead (by more than `graceMs` ago), else tomorrow. */
  function nextDateFor(hhmm, t, graceMs = 0) {
    const today = todayCN(new Date(t));
    return cnTimeMs(today, hhmm) > t - graceMs ? today : addDays(today, 1);
  }

  // ---- before arrival ---------------------------------------------------------------------------

  /** A day plan for the itinerary card; not stored. The order is optional (it gives the city and the date). */
  function planItinerary({ userId, orderId, title, date, items } = {}) {
    const u = requireUser(userId);
    const t = nowMs();
    const order = str(orderId, 80) ? requireConfirmed(ownOrder(u, orderId)) : rankOrders(u, t)[0]?.order || null;
    const today = todayCN(new Date(t));
    // The arrival day while it is still ahead and the guest is not in yet (an early check-in is already staying).
    const day = date ? requireDate(date, '行程日期') : order && order.checkIn > today && !stayRec(order) ? order.checkIn : today;
    if (day < today) throw new StayError('invalid_date', `${formatDateCN(day)}已经过去了，换个日期吧`);
    const list = Array.isArray(items) ? items : [];
    if (list.length < 2 || list.length > 8) throw new StayError('invalid_items', '行程需要2-8项，每项写上时间和要做的事');
    const out = list.map((item, i) => {
      const what = clean(item?.title, 30);
      if (!what) throw new StayError('invalid_items', `第${i + 1}项缺少内容（title）`);
      const place = clean(item?.place, 30);
      const note = clean(item?.note, 60);
      return { time: requireTime(item?.time, `第${i + 1}项的时间`), title: what, ...(place ? { place } : {}), ...(note ? { note } : {}) };
    });
    out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const city = order ? cityOf(order) : '';
    return { title: clean(title, 30) || `${formatDateCN(day)}行程`, date: day, ...(city ? { city } : {}), items: out };
  }

  function estimateRide(order, rideKind, from, to, passengers) {
    const h = hashString(`${order.id}|${rideKind}|${from}|${to}`);
    const airport = rideKind === 'airport_pickup' || /机场|航站楼/.test(`${from}${to}`);
    const [lo, hi] = airport ? [35, 65] : [12, 40];
    const minutes = lo + (h % (hi - lo + 1));
    const van = passengers > 4;
    const fare = Math.round(((airport ? 30 : 12) + minutes * (airport ? 2.6 : 2.3)) * (van ? 1.5 : 1));
    return { minutes, fare, carType: van ? '商务车（7座）' : '舒适型轿车' };
  }

  function pickupMs({ pickupDate, pickupTime }, rideKind, order, t) {
    let ms;
    if (!str(pickupTime, 10) && !str(pickupDate, 10)) {
      ms = Math.ceil((t + DEFAULT_PICKUP_IN_MS) / MIN) * MIN;
    } else {
      const hhmm = requireTime(pickupTime, '上车时间');
      let day = str(pickupDate, 10) ? requireDate(pickupDate, '上车日期') : '';
      if (!day) {
        // '14:00' for a pickup to the hotel means arrival day when that is still ahead and the guest is not in yet.
        const arrival = (rideKind === 'airport_pickup' || rideKind === 'to_hotel') && order.checkIn > todayCN(new Date(t)) && !stayRec(order);
        day = arrival ? order.checkIn : nextDateFor(hhmm, t, MIN);
      }
      ms = cnTimeMs(day, hhmm);
    }
    if (ms < t - MIN) throw new StayError('invalid_time', '上车时间已经过了，换个时间吧');
    if (ms > t + MAX_PICKUP_AHEAD_DAYS * DAY_MS) throw new StayError('invalid_time', `只能预约${MAX_PICKUP_AHEAD_DAYS}天以内的用车`);
    return ms;
  }

  /** A ride quote (15 minutes): nothing is booked until the user taps 确认叫车 (confirmRide). */
  function quoteRide({ userId, sessionId, orderId, kind, from, to, pickupDate, pickupTime, passengers } = {}) {
    const order = resolveOrder(userId, orderId);
    if (!Object.hasOwn(RIDE_KIND_LABELS, kind)) throw new StayError('invalid_ride_kind', '用车类型需要是接机、去酒店、从酒店出发或打车');
    const hotelName = order.hotel?.name || '酒店';
    let start = clean(from, 40);
    let end = clean(to, 40);
    if (HOTEL_WORD_RE.test(start) || (kind === 'from_hotel' && !start)) start = hotelName;
    if (HOTEL_WORD_RE.test(end) || ((kind === 'airport_pickup' || kind === 'to_hotel') && !end)) end = hotelName;
    if (!start) throw new StayError('missing_from', '从哪里上车？需要出发地（from）');
    if (!end) throw new StayError('missing_to', '要去哪里？需要目的地（to）');
    if (start === end) throw new StayError('same_place', '出发地和目的地是同一个地方，换一下吧');
    const n = passengers === undefined || passengers === null || passengers === ''
      ? Math.min(6, partyOf(order))
      : intIn(passengers, 1, 6, '乘车人数需要在1-6位之间');
    const t = nowMs();
    const ride = {
      ...base('ride', order, sessionId, t, 'RD'),
      rideKind: kind,
      from: start,
      to: end,
      pickupAt: iso(pickupMs({ pickupDate, pickupTime }, kind, order, t)),
      passengers: n,
      ...estimateRide(order, kind, start, end, n),
      status: 'quoted',
      expiresAt: iso(t + QUOTE_TTL_MS),
    };
    requests.set(ride.id, ride);
    return rideView(ride, t);
  }

  /** Per ride (route and pickup time): two rides at once get two drivers; a van and a sedan never share a plate. */
  function driverFor(ride, order) {
    const key = `${ride.orderId}|${ride.rideKind}|${ride.from}|${ride.to}|${ride.pickupAt}`;
    const h = (k) => hashString(`${key}|${k}`);
    const carClass = ride.passengers > 4 ? 'van' : 'sedan';
    const cars = carClass === 'van' ? VANS : CARS;
    const [car, color] = cars[h(`${carClass}|car`) % cars.length];
    return {
      name: `${SURNAMES[h('name') % SURNAMES.length]}师傅`,
      car,
      color,
      plate: `${PLATE_PREFIX[cityOf(order)] || '京A'}·D${String(h(`${carClass}|plate`) % 1e5).padStart(5, '0')}`,
      phone: maskPhone(`1${3 + (h('carrier') % 7)}${String(h('phone') % 1e9).padStart(9, '0')}`),
    };
  }

  /**
   * The user's tap on 确认叫车: a driver is assigned at once and the fare is paid (simulated) with the order's
   * payment method. Confirming again returns the same ride.
   */
  function confirmRide({ userId, rideId } = {}) {
    const u = requireUser(userId);
    const ride = ownRequest(u, rideId, 'ride');
    const t = nowMs();
    const status = rideStatus(ride, t);
    if (status === 'expired') throw new StayError('expired', '这个叫车报价已过期（15分钟内有效），我帮你重新叫一下吧');
    if (status !== 'quoted') return rideView(ride, t);
    const order = requireConfirmed(ownOrder(u, ride.orderId));
    const method = order.payment?.method || 'wechat';
    const confirmed = {
      ...ride,
      status: 'confirmed',
      confirmedAt: iso(t),
      driver: driverFor(ride, order),
      payment: { method, paidAt: iso(t), amount: ride.fare, transactionId: idgen.transactionId(method, new Date(t)) },
    };
    requests.set(ride.id, confirmed);
    return rideView(confirmed, t);
  }

  function requestEarlyCheckin({ userId, sessionId, orderId, arrivalTime } = {}) {
    const order = resolveOrder(userId, orderId);
    if (stayRec(order)) throw new StayError('already_checked_in', '已经办好入住了，不用再申请提前入住');
    const hhmm = requireTime(arrivalTime, '到店时间');
    const t = nowMs();
    const status = hhmm >= EARLY_CHECKIN_FROM ? 'confirmed' : 'pending';
    let note = '这个时间有点早，酒店会尽量提前准备，房间准备好会通知你；可以先寄存行李';
    if (hhmm >= STANDARD_CHECKIN) note = `${STANDARD_CHECKIN} 起就是正常入住时间，到店直接办理就行`;
    else if (status === 'confirmed') note = `已和酒店确认，${hhmm} 到店就能入住`;
    // One request per order: asking again changes the time.
    const existing = requestsOf(order).find((r) => r.kind === 'early_checkin');
    const rec = {
      ...(existing || base('early_checkin', order, sessionId, t, 'EC')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      date: order.checkIn,
      arrivalTime: hhmm,
      status,
      note,
      updatedAt: iso(t),
    };
    requests.set(rec.id, rec);
    return earlyView(rec);
  }

  // ---- check-in and the stay --------------------------------------------------------------------

  /**
   * Puts the guest of a confirmed order in the room assignRoom gives it (the guest's own check-in or the front
   * desk's): the order records the check-in (no more online cancellation) and a pending early check-in is settled.
   */
  function settleCheckIn(order, t) {
    const today = todayCN(new Date(t));
    if (order.checkOut < today) throw new StayError('stay_over', `这一单的离店日期（${formatDateCN(order.checkOut)}）已经过了，不能再办入住`);
    const rec = { orderId: order.id, userId: order.userId, ...assignRoom(order, profileOf(order)), checkedInAt: iso(t), early: today < order.checkIn };
    stays.set(order.id, rec);
    bookings.markCheckedIn?.({ userId: order.userId, orderId: order.id, at: rec.checkedInAt });
    for (const r of requestsOf(order)) {
      if (r.kind === 'early_checkin' && r.status === 'pending') requests.set(r.id, { ...r, status: 'confirmed', note: '房间已准备好，已办理入住', updatedAt: iso(t) });
    }
    return rec;
  }

  /** Check-in has no date limit in the demo; before the check-in date the stay is marked `early`. */
  function checkIn({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const existing = stayRec(order);
    if (existing?.checkedOutAt) throw new StayError('checked_out', '这一单已经退房了，不能再办入住');
    if (existing) {
      // A stay from before orders recorded their check-in.
      if (!order.checkedInAt) bookings.markCheckedIn?.({ userId: order.userId, orderId: order.id, at: existing.checkedInAt });
      return { stay: stayView(order, existing), already: true };
    }
    const rec = settleCheckIn(order, nowMs());
    return { stay: stayView(order, rec), already: false };
  }

  function cleanItems(items) {
    const list = Array.isArray(items) ? items : [];
    const merged = new Map();
    for (const item of list) {
      const name = clean(typeof item === 'string' ? item : item?.name, 20);
      if (!name) continue;
      const qty = item?.qty === undefined || item?.qty === null || item?.qty === '' ? 1 : intIn(item.qty, 1, 10, `「${name}」的数量需要在1-10之间`);
      merged.set(name, Math.min(10, (merged.get(name) || 0) + qty));
    }
    if (!merged.size) throw new StayError('invalid_items', '要送什么？请写明物品，如「毛巾 2条」');
    if (merged.size > 6) throw new StayError('invalid_items', '一次最多送6样东西，分两次叫吧');
    return [...merged].map(([name, qty]) => ({ name, qty }));
  }

  /** Delivery to the room: accepted → on_the_way (+1 min) → done (+5 min, the eta). */
  function requestService({ userId, sessionId, orderId, items, note } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = requireCheckedIn(order);
    const list = cleanItems(items);
    const t = nowMs();
    const ticket = { ...base('service', order, sessionId, t, 'SV'), roomNumber: rec.roomNumber, items: list, note: clean(note, 100) };
    requests.set(ticket.id, ticket);
    return serviceView(ticket, t);
  }

  function reserveDining({ userId, sessionId, orderId, kind, date, time, people, note } = {}) {
    const order = resolveOrder(userId, orderId);
    requireNotCheckedOut(order);
    const meal = Object.hasOwn(MEALS, kind) ? MEALS[kind] : null;
    if (!meal) throw new StayError('invalid_meal', '餐别需要是早餐、午餐或晚餐');
    const hhmm = requireTime(time, '用餐时间');
    if (hhmm < meal.from || hhmm > meal.to) throw new StayError('invalid_time', `${meal.label}时间是 ${meal.from}–${meal.to}，换个时间吧`);
    const t = nowMs();
    const day = str(date, 10) ? requireDate(date, '用餐日期') : nextDateFor(hhmm, t);
    // A guest who checked in before the booked date is already staying.
    const inSince = stayRec(order)?.checkedInAt;
    const first = inSince && todayCN(new Date(Date.parse(inSince))) < order.checkIn ? todayCN(new Date(Date.parse(inSince))) : order.checkIn;
    if (day < first || day > order.checkOut) {
      throw new StayError('outside_stay', `${formatDateCN(day)}不在这次入住期间（${formatDateCN(first)}–${formatDateCN(order.checkOut)}）`);
    }
    const atMs = cnTimeMs(day, hhmm);
    if (atMs <= t) throw new StayError('invalid_time', `${formatDateCN(day)} ${hhmm} 已经过了，换个时间吧`);
    const n = people === undefined || people === null || people === '' ? Math.min(10, partyOf(order)) : intIn(people, 1, 10, '用餐人数需要在1-10位之间');
    const prof = profileOf(order);
    // The rate's breakfast covers its people per room (含双早 = 2 a room); the rest of the party pays ¥68 each.
    const covers = kind === 'breakfast' ? (Number(order.rate?.breakfast) || 0) * (Number(order.rooms) || 1) : 0;
    const included = covers >= n;
    const covered = included ? 0 : covers;
    const venue = kind === 'breakfast' ? prof.breakfastVenue : prof.restaurant;
    // One reservation per meal and day: asking again for one still ahead changes it.
    const existing = requestsOf(order).find((r) => r.kind === 'dining' && r.mealKind === kind && r.date === day && Date.parse(r.at) > t);
    const rec = existing ? { ...existing } : base('dining', order, sessionId, t, 'DN');
    Object.assign(rec, {
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      mealKind: kind,
      date: day,
      at: iso(atMs),
      people: n,
      restaurant: venue.restaurant,
      place: venue.place,
      table: rec.table || `${1 + (hashString(`${rec.id}|table`) % 30)}号桌`,
      price: kind === 'breakfast' ? (included ? 0 : BREAKFAST_PRICE) : prof.restaurant.price,
      included,
      covered,
      note: clean(note, 100),
    });
    requests.set(rec.id, rec);
    return diningView(rec, t);
  }

  function setWakeupCall({ userId, sessionId, orderId, time, date } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = requireCheckedIn(order);
    const hhmm = requireTime(time, '叫醒时间');
    const t = nowMs();
    const day = str(date, 10) ? requireDate(date, '叫醒日期') : nextDateFor(hhmm, t);
    const atMs = cnTimeMs(day, hhmm);
    if (atMs <= t) throw new StayError('invalid_time', `${formatDateCN(day)} ${hhmm} 已经过了，换个时间吧`);
    if (day > order.checkOut) throw new StayError('outside_stay', `${formatDateCN(day)}已经过了离店日（${formatDateCN(order.checkOut)}），换一天吧`);
    const at = iso(atMs);
    const same = requestsOf(order).find((r) => r.kind === 'wakeup' && r.at === at);
    if (same) return wakeupView(same, t);
    const call = { ...base('wakeup', order, sessionId, t, 'WK'), roomNumber: rec.roomNumber, at };
    requests.set(call.id, call);
    return wakeupView(call, t);
  }

  function getStayInfo({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const t = nowMs();
    const rec = stayRec(order);
    const prof = profileOf(order);
    const checkedIn = Boolean(rec && !rec.checkedOutAt);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name, category: prof.category },
      checkedIn,
      ...(checkedIn ? { roomNumber: rec.roomNumber } : {}),
      wifi: { ...prof.wifi },
      breakfast: { ...prof.breakfast, included: (order.rate?.breakfast || 0) > 0 },
      checkoutTime: CHECKOUT_TIME,
      frontDesk: prof.frontDesk,
      facilities: prof.facilities.map((f) => ({ ...f })),
      open: requestsOf(order).map((r) => openItem(r, t)).filter(Boolean),
    };
  }

  // ---- extension (needs the user's tap and payment) ----------------------------------------------

  function priceExtension(order, fromDate, toDate) {
    try {
      return hotels.priceCheck({
        hotelId: order.hotel.id, rateId: order.rate.rateId, checkIn: fromDate, checkOut: toDate,
        rooms: order.rooms, adults: order.adults, children: order.children ?? 0,
      });
    } catch (err) {
      if (err?.name === 'BookingError' && (err.code === 'sold_out' || err.code === 'rate_not_found')) {
        throw new StayError('sold_out', `${formatDateCN(fromDate)}起续住${nightsBetween(fromDate, toDate)}晚，${order.room?.name || '这个房型'}已经订满了，换个晚数试试？`);
      }
      if (err?.name === 'BookingError' && err.code === 'invalid_dates') throw new StayError('invalid_dates', err.message);
      throw err;
    }
  }

  /** A quote for N more nights of the same room and rate (15 minutes); the order changes only in confirmExtension. */
  function prepareExtension({ userId, sessionId, orderId, nights } = {}) {
    const order = resolveOrder(userId, orderId);
    requireNotCheckedOut(order);
    const n = nights === undefined || nights === null || nights === '' ? 1 : intIn(nights, 1, 7, '续住需要在1-7晚之间');
    const t = nowMs();
    if (order.checkOut < todayCN(new Date(t))) throw new StayError('stay_over', '这一单的离店日期已经过了，不能再续住，可以重新预订');
    const fromDate = order.checkOut;
    const toDate = addDays(fromDate, n);
    const { rate } = priceExtension(order, fromDate, toDate);
    // Only the newest quote of an order can be confirmed.
    for (const old of requestsOf(order)) {
      if (old.kind === 'extension' && extensionStatus(old, t) === 'pending') requests.set(old.id, { ...old, status: 'expired' });
    }
    const ext = {
      ...base('extension', order, sessionId, t, 'EX'),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      room: order.room?.name || '',
      rateId: order.rate.rateId,
      fromDate,
      toDate,
      nights: n,
      nightly: rate.nightly.map((x) => ({ date: x.date, price: x.price })),
      price: rate.totalPrice,
      status: 'pending',
      expiresAt: iso(t + QUOTE_TTL_MS),
    };
    requests.set(ext.id, ext);
    return extensionView(ext, t);
  }

  /** The user's tap on 确认续住 plus the simulated payment: the order's check-out, nights and total move. */
  function confirmExtension({ userId, extensionId, method } = {}) {
    const u = requireUser(userId);
    const ext = ownRequest(u, extensionId, 'extension');
    const t = nowMs();
    const status = extensionStatus(ext, t);
    if (status === 'confirmed') return { extension: extensionView(ext, t), order: toPublicOrder(bookings.getOrder(u, ext.orderId)) };
    if (status === 'expired') throw new StayError('expired', '这个续住报价已过期（15分钟内有效），我帮你重新报个价吧');
    const m = normalizeMethod(method);
    if (!m) throw new StayError('invalid_payment_method', '请选择微信支付或支付宝');
    const order = requireConfirmed(ownOrder(u, ext.orderId));
    requireNotCheckedOut(order);
    if (order.checkOut !== ext.fromDate) throw new StayError('superseded', '订单的离店日期已经变了，这个续住报价失效了，请重新报价');
    const { rate } = priceExtension(order, ext.fromDate, ext.toDate);
    if (rate.totalPrice !== ext.price) {
      throw new StayError('price_changed', `续住价格有变动：刚才是 ¥${ext.price}，现在是 ¥${rate.totalPrice}，需要重新确认`, { oldPrice: ext.price, newPrice: rate.totalPrice });
    }
    const payment = { method: m, paidAt: iso(t), amount: ext.price, transactionId: idgen.transactionId(m, new Date(t)) };
    const updated = bookings.extendOrder({
      userId: u, orderId: order.id, fromDate: ext.fromDate, toDate: ext.toDate, nightly: rate.nightly, amount: ext.price, payment, extensionId: ext.id,
    });
    const confirmed = { ...ext, status: 'confirmed', confirmedAt: iso(t), payment };
    requests.set(ext.id, confirmed);
    return { extension: extensionView(confirmed, t), order: toPublicOrder(updated) };
  }

  // ---- check-out, invoice, points, review -------------------------------------------------------

  /**
   * Room nights, extensions and confirmed rides were paid when the user tapped for them; meals already
   * served went on the room bill and are settled with the order's payment method at check-out.
   */
  function buildBill(order, rec, t) {
    const methodLabel = (m) => PAYMENT_METHOD_LABELS[m] || '在线支付';
    const exts = Array.isArray(order.extensions) ? order.extensions : [];
    const paid = [{
      label: `房费（${order.room?.name || '客房'} · ${order.nights - sum(exts, (e) => e.nights)}晚${order.rooms > 1 ? ` × ${order.rooms}间` : ''}）`,
      amount: money(order.totalPrice - sum(exts, (e) => e.amount)),
      note: `已预付（${methodLabel(order.payment?.method)}）`,
    }];
    for (const e of exts) paid.push({ label: `续住（${e.nights}晚）`, amount: money(e.amount), note: `已预付（${methodLabel(e.payment?.method)}）` });
    const charged = [];
    for (const r of requestsOf(order)) {
      if (r.kind === 'ride' && r.payment) {
        paid.push({ label: `${RIDE_KIND_LABELS[r.rideKind] || '用车'}用车`, amount: money(r.fare), note: `已支付（${methodLabel(r.payment.method)}）` });
      }
      const payers = r.kind === 'dining' ? r.people - (Number(r.covered) || 0) : 0;
      if (r.kind === 'dining' && r.status !== 'cancelled' && r.price > 0 && payers > 0 && Date.parse(r.at) <= t) {
        const label = `${MEALS[r.mealKind]?.label || '餐饮'}（${r.people}位${r.covered > 0 ? `，含早${r.covered}位` : ''}）`;
        charged.push({ label, amount: money(r.price * payers), note: '挂房账' });
      }
    }
    const prepaid = sum(paid, (l) => l.amount);
    const extras = sum(charged, (l) => l.amount);
    return {
      orderId: order.id,
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      roomNumber: rec.roomNumber,
      checkIn: order.checkIn,
      checkOut: order.checkOut,
      nights: order.nights,
      lines: [...paid, ...charged],
      prepaid,
      extras,
      due: extras,
      // Shown as 还需支付（微信支付）: just the method.
      settledBy: extras > 0 ? methodLabel(order.payment?.method) : '无需补缴',
      // 1 yuan actually paid = 1 point.
      pointsEarned: prepaid + extras,
      checkedOutAt: iso(t),
    };
  }

  function checkOut({ userId, orderId } = {}) {
    const order = resolveOrder(userId, orderId);
    const rec = stayRec(order);
    if (!rec) throw new StayError('not_checked_in', '还没办入住，不能退房');
    if (rec.checkedOutAt) return { bill: structuredClone(rec.bill), already: true };
    const t = nowMs();
    const bill = buildBill(order, rec, t);
    stays.set(order.id, { ...rec, checkedOutAt: bill.checkedOutAt, bill });
    // What was booked for after the guest left will not happen: no meal served off the bill, no call to an empty room.
    for (const r of requestsOf(order)) {
      const later = (r.kind === 'dining' || r.kind === 'wakeup') && r.status !== 'cancelled' && Date.parse(r.at) > t;
      if (later || (r.kind === 'early_checkin' && r.status === 'pending')) requests.set(r.id, { ...r, status: 'cancelled', cancelledAt: iso(t) });
    }
    return { bill: structuredClone(bill), already: false };
  }

  /** 电子普通发票 for the order (one per order; asking again re-issues it with the new details). */
  function requestInvoice({ userId, sessionId, orderId, title, taxId, email } = {}) {
    const order = resolveOrder(userId, orderId, { afterStay: true });
    const head = clean(title, 50) || clean(order.guests?.[0], 20) || '个人';
    const rawTax = str(taxId, 40).replace(/[\s-]/g, '').toUpperCase();
    if (rawTax && !TAX_ID_RE.test(rawTax)) throw new StayError('invalid_tax_id', '税号格式不对：统一社会信用代码是18位数字或大写字母');
    if (COMPANY_RE.test(head) && !rawTax) throw new StayError('missing_tax_id', `「${head}」是单位抬头，需要税号（统一社会信用代码）才能开票`);
    const mail = str(email, 80);
    if (mail && !EMAIL_RE.test(mail)) throw new StayError('invalid_email', '邮箱格式不对，请检查一下');
    const t = nowMs();
    const bill = stayRec(order)?.bill;
    const amount = bill ? bill.prepaid + bill.due : money(order.totalPrice);
    const existing = requestsOf(order).find((r) => r.kind === 'invoice');
    if (existing && existing.title === head && existing.taxId === rawTax && existing.email === mail && existing.amount === amount) return invoiceView(existing, t);
    const inv = {
      ...(existing || base('invoice', order, sessionId, t, 'IV')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      requestedAt: iso(t),
      title: head,
      taxId: rawTax,
      email: mail,
      amount,
    };
    requests.set(inv.id, inv);
    return invoiceView(inv, t);
  }

  /** Level, points (1 per yuan paid, earned at check-out, kept while the order stands) and the latest stays that earned them. */
  function getMembership(userId) {
    const u = requireUser(userId);
    const done = stays.values()
      .filter((s) => s.userId === u && s.bill && s.checkedOutAt && bookings.getOrder(u, s.orderId)?.status === 'confirmed')
      .sort((a, b) => (a.checkedOutAt < b.checkedOutAt ? 1 : a.checkedOutAt > b.checkedOutAt ? -1 : 0));
    const points = sum(done, (s) => s.bill.pointsEarned);
    let i = 0;
    while (i + 1 < MEMBER_LEVELS.length && points >= MEMBER_LEVELS[i + 1].min) i++;
    const level = MEMBER_LEVELS[i];
    const next = MEMBER_LEVELS[i + 1];
    return {
      level: level.name,
      points,
      ...(next ? { nextLevel: next.name, pointsToNext: next.min - points } : {}),
      perks: [...level.perks],
      recent: done.slice(0, 5).map((s) => ({ label: `${s.bill.hotel?.name || '酒店'} 退房`, points: s.bill.pointsEarned, at: s.checkedOutAt })),
    };
  }

  function cleanTags(tags) {
    const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，、\s]+/) : [];
    return [...new Set(list.map((x) => clean(x, 10)).filter(Boolean))].slice(0, 6);
  }

  /** A draft only: it is published when the user taps 发布 (publishReview). One review per order. */
  function draftReview({ userId, sessionId, orderId, rating, text, tags } = {}) {
    const order = resolveOrder(userId, orderId, { afterStay: true });
    const stars = intIn(rating, 1, 5, '评分需要是1-5星');
    const body = cleanText(text);
    if (!body) throw new StayError('invalid_review', '点评内容不能为空');
    if (body.length > MAX_REVIEW_CHARS) throw new StayError('invalid_review', `点评最多${MAX_REVIEW_CHARS}字（现在${body.length}字），精简一下再起草`);
    const t = nowMs();
    const existing = requestsOf(order).find((r) => r.kind === 'review');
    if (existing?.status === 'published') throw new StayError('already_published', '这一单已经发布过点评了');
    const review = {
      ...(existing || base('review', order, sessionId, t, 'RV')),
      ...(str(sessionId, 100) ? { sessionId: str(sessionId, 100) } : {}),
      hotel: { id: order.hotel?.id, name: order.hotel?.name },
      rating: stars,
      text: body,
      tags: cleanTags(tags),
      status: 'draft',
      updatedAt: iso(t),
    };
    requests.set(review.id, review);
    return reviewView(review);
  }

  /** The user's tap on 发布. Publishing again returns the same review. */
  function publishReview({ userId, reviewId } = {}) {
    const u = requireUser(userId);
    const review = ownRequest(u, reviewId, 'review');
    if (review.status === 'published') return reviewView(review);
    requireConfirmed(ownOrder(u, review.orderId));
    const published = { ...review, status: 'published', publishedAt: iso(nowMs()) };
    requests.set(review.id, published);
    return reviewView(published);
  }

  // ---- reads for the page -----------------------------------------------------------------------

  /** 我的安排: confirmed orders checking out at most 3 days ago (up to 5, the current one first). */
  function listStays(userId) {
    const u = requireUser(userId);
    const t = nowMs();
    return rankOrders(u, t, { horizon: 3 }).slice(0, 5).map(({ order }) => {
      const rec = stayRec(order);
      return { order: toPublicOrder(order), stay: rec ? stayView(order, rec) : null, requests: requestsOf(order).map((r) => viewOf(r, t)) };
    });
  }

  /** A request as it stands now (for refreshing a card on replay), or null. */
  function getRequest(userId, id) {
    const u = str(userId, 100);
    const r = u ? requests.get(str(id, 80)) : null;
    return r && r.userId === u ? viewOf(r, nowMs()) : null;
  }

  function getStay(userId, orderId) {
    const u = str(userId, 100);
    const order = u ? bookings.getOrder(u, str(orderId, 80)) : null;
    const rec = order ? stayRec(order) : null;
    return rec ? stayView(order, rec) : null;
  }

  /** The chat session a request belongs to (where its notice goes): where it was made, else the order's. */
  function sessionOf(userId, id) {
    const u = str(userId, 100);
    const r = u ? requests.get(str(id, 80)) : null;
    if (!r || r.userId !== u) return null;
    return r.sessionId || bookings.getOrder(u, r.orderId)?.sessionId || null;
  }

  /** Withdraws a ride or extension quote whose turn was stopped before the user saw it. Never throws. */
  function discardQuote({ userId, id } = {}) {
    try {
      const u = str(userId, 100);
      const r = u ? requests.get(str(id, 80)) : null;
      if (!r || r.userId !== u) return null;
      const t = nowMs();
      if ((r.kind === 'ride' && rideStatus(r, t) === 'quoted') || (r.kind === 'extension' && extensionStatus(r, t) === 'pending')) {
        requests.set(r.id, { ...r, status: 'expired' });
      }
      return viewOf(requests.get(r.id), t);
    } catch {
      return null;
    }
  }

  // ---- the hotel's side (merchant.js): any guest's orders at one hotel ------------------------------

  /** An order by its id whoever booked it (the front desk has no user id), refreshed by bookings; null when unknown. */
  function anyOrder(orderId) {
    const raw = orderRecords.get(str(orderId, 80).toUpperCase());
    return raw ? bookings.getOrder(raw.userId, raw.id) : null;
  }

  /** The room an order has (checked in) or will get when it checks in: the same rule, so the hotel's room grid agrees. */
  function roomFor(order) {
    const rec = stayRec(order);
    return rec ? { roomNumber: rec.roomNumber, floor: rec.floor } : assignRoom(order, profileOf(order));
  }

  function confirmedAt(hotelId) {
    return bookings.ordersForHotel ? bookings.ordersForHotel(hotelId).filter((o) => o.status === 'confirmed') : [];
  }

  /**
   * One hotel's confirmed orders, whoever booked them (newest first), each with the room the check-in gives it
   * (`roomNumber`, `floor`) and its stay (null before check-in). Orders come back public: no user id, masked phone.
   * @returns {Array<{ order: object, roomNumber: string, floor: number, stay: object|null }>}
   */
  function listHotelStays(hotelId) {
    return confirmedAt(hotelId).map((order) => {
      const rec = stayRec(order);
      return { order: toPublicOrder(order), ...roomFor(order), stay: rec ? stayView(order, rec) : null };
    });
  }

  /**
   * Every request made for one hotel's confirmed orders (oldest first), as it stands now, with its order (public)
   * and the guest's room (the request's own, else the order's).
   * @returns {Array<{ request: object, order: object, roomNumber: string }>}
   */
  function listHotelRequests(hotelId) {
    const byId = new Map(confirmedAt(hotelId).map((o) => [o.id, o]));
    if (!byId.size) return [];
    const t = nowMs();
    return requests
      .values()
      .filter((r) => byId.get(r.orderId)?.userId === r.userId && VIEWS[r.kind])
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((r) => {
        const order = byId.get(r.orderId);
        return { request: viewOf(r, t), order: toPublicOrder(order), roomNumber: r.roomNumber || roomFor(order).roomNumber };
      });
  }

  /**
   * The front desk checks in the guest of an order arriving today (or earlier): the room the guest's own check-in
   * would give. Returns the stay, and the user and chat session the guest hears about it in.
   */
  function frontDeskCheckIn(orderId) {
    const order = anyOrder(orderId);
    if (!order) throw new StayError('not_found', '没有找到这个订单');
    requireConfirmed(order);
    const existing = stayRec(order);
    if (existing?.checkedOutAt) throw new StayError('checked_out', '这一单已经退房了，不能再办入住');
    if (existing) throw new StayError('already_checked_in', `客人已经办好入住了（${existing.roomNumber} 房）`);
    const t = nowMs();
    if (order.checkIn > todayCN(new Date(t))) throw new StayError('not_arrived', `这一单${formatDateCN(order.checkIn)}才入住，到那天再在前台办理`);
    const rec = settleCheckIn(order, t);
    return { stay: stayView(order, rec), userId: order.userId, sessionId: order.sessionId || null };
  }

  /**
   * The hotel moves a request on: a delivery is taken (`accept`: on its way) or brought (`deliver` / `done`), sooner
   * than the usual pace and never back; a pending early check-in is approved or declined. Anything else is a 409
   * invalid_action. Returns the request as it now stands, and the user and session its guest hears about it in.
   */
  function advanceRequest(requestId, action) {
    const r = requests.get(str(requestId, 80));
    const order = r && (r.kind === 'service' || r.kind === 'early_checkin') ? bookings.getOrder(r.userId, r.orderId) : null;
    if (!order || order.status !== 'confirmed') throw new StayError('not_found', '没有找到这个请求，可能已失效');
    const t = nowMs();
    let next = null;
    let why = '这个操作现在做不了';
    if (r.kind === 'service') {
      const status = serviceView(r, t).status;
      if (action === 'accept') {
        if (status === 'accepted') next = { ...r, onTheWayAt: iso(t) };
        else why = status === 'done' ? '这单已经送达了' : '这单已经在配送中了';
      } else if (action === 'deliver' || action === 'done') {
        if (status !== 'done') next = { ...r, onTheWayAt: r.onTheWayAt || iso(t), doneAt: iso(t) };
        else why = '这单已经送达了';
      } else why = '送物工单只能接单、送达或完成';
    } else if (action === 'approve' || action === 'decline') {
      if (r.status === 'pending') {
        next = action === 'approve'
          ? { ...r, status: 'confirmed', note: `酒店已确认 ${r.arrivalTime} 可以入住`, decidedAt: iso(t) }
          : { ...r, status: 'declined', note: `那天房间比较满，按 ${STANDARD_CHECKIN} 入住哦`, decidedAt: iso(t) };
      } else why = '这个提前入住申请已经处理过了';
    } else why = '提前入住只能同意或婉拒';
    if (!next) throw new StayError('invalid_action', why);
    requests.set(r.id, next);
    return { request: viewOf(next, t), userId: r.userId, sessionId: r.sessionId || order.sessionId || null };
  }

  /**
   * The hotel's reply to a published review (1–300 characters): the guest's review card shows it as
   * `reply: { text, at }`. Replying again replaces it; `changed` says whether the text is new.
   */
  function replyReview(reviewId, text) {
    const r = requests.get(str(reviewId, 80));
    if (!r || r.kind !== 'review') throw new StayError('not_found', '没有找到这条点评');
    if (r.status !== 'published') throw new StayError('not_published', '这条点评还没有发布，不能回复');
    const body = cleanText(text);
    if (!body) throw new StayError('invalid_reply', '回复内容不能为空');
    if (body.length > MAX_REPLY_CHARS) throw new StayError('invalid_reply', `回复最多${MAX_REPLY_CHARS}字（现在${body.length}字），精简一下吧`);
    const changed = r.reply?.text !== body;
    const updated = changed ? { ...r, reply: { text: body, at: iso(nowMs()) } } : r;
    if (changed) requests.set(r.id, updated);
    const sessionId = r.sessionId || bookings.getOrder(r.userId, r.orderId)?.sessionId || null;
    return { review: reviewView(updated), changed, userId: r.userId, sessionId };
  }

  return {
    planItinerary, quoteRide, confirmRide, requestEarlyCheckin, checkIn, requestService, reserveDining, setWakeupCall,
    getStayInfo, prepareExtension, confirmExtension, checkOut, requestInvoice, getMembership, draftReview, publishReview,
    listStays, getRequest, getStay, sessionOf, discardQuote,
    listHotelStays, listHotelRequests, frontDeskCheckIn, advanceRequest, replyReview,
  };
}
