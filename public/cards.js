// Cards for everything the agent finds or arranges: hotels, rooms, places, orders, and the stay after booking
// (itinerary, ride, check-in key, room service, dining, wake-up, hotel info, extension, bill, invoice,
// membership, review). Field names follow docs/JOURNEY.md. Server/LLM text reaches the DOM only through
// textContent (h() with `text`), never as markup.
import { icon } from './icons.js';

const TZ = 'Asia/Shanghai';
const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric' });

/** '2026-11-06T06:30:00Z' → '14:30' (China time). */
export function clockTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

/** '2026-11-06T06:30:00Z' → '11月6日 14:30'. */
export function dayTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const part = (type) => dayFmt.formatToParts(d).find((p) => p.type === type)?.value;
  return `${part('month')}月${part('day')}日 ${timeFmt.format(d)}`;
}

const CATEGORY_LABELS = { economy: '经济型', comfort: '舒适型', premium: '高档型', luxury: '豪华型' };

export const STATUS_LABELS = {
  ride: { quoted: '待确认', confirmed: '已派车', arriving: '即将到达', completed: '已完成', expired: '已过期', cancelled: '已取消' },
  service: { accepted: '已接单', on_the_way: '配送中', done: '已送达' },
  invoice: { issuing: '开具中', issued: '已开具' },
  wakeup: { set: '已设置', done: '已叫醒', cancelled: '已取消' },
  extension: { pending: '待确认', confirmed: '已续住', expired: '已过期' },
  review: { draft: '草稿', published: '已发布' },
  early_checkin: { confirmed: '已确认', pending: '待安排', declined: '已满房', cancelled: '已取消' },
  dining: { reserved: '已订位', done: '已用餐', cancelled: '已取消' },
};

const DONE = new Set(['completed', 'done', 'issued', 'confirmed', 'published']);
// A ride that is 已派车 is still on its way, not done.
const tone = (kind, status) => (DONE.has(status) && !(kind === 'ride' && status === 'confirmed') ? 'ok'
  : ['expired', 'cancelled', 'declined'].includes(status) ? 'muted' : 'live');

function hashOf(s) {
  let x = 2166136261;
  for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return x >>> 0;
}

/** 0.85 → '85折', 0.9 → '9折'. */
export function zheText(discount) {
  const n = Math.round(Number(discount) * 100);
  return Number.isFinite(n) && n > 0 && n < 100 ? `${n % 10 ? n : n / 10}折` : '';
}

/** A cancellation policy in two or three words; a free-cancel deadline that has passed no longer counts as free. */
export function cancelLabel(policy, nowMs = Date.now()) {
  if (!policy || policy.type === 'none') return { text: '不可取消', free: false };
  const until = Date.parse(policy.freeUntil);
  if (!Number.isNaN(until) && nowMs >= until) return { text: '取消收首晚', free: false };
  return policy.type === 'limited' ? { text: '限时取消', free: false } : { text: '免费取消', free: true };
}

/**
 * @param kit everything the cards need from the page: h, yuan, date (YYYY-MM-DD → 11月6日 周五), stayPhrase,
 *   send (chat message), api (method, path, body), pay ({ title, amount, desc, run(method) }) → result|null,
 *   toast, onAction (after a tap changed something server-side), photos () → manifest or null, now () → server ms,
 *   busy (), chatButton, openKey (stay).
 */
export function createCards(kit) {
  const { h, yuan, date } = kit;
  // Cards whose request moves on by itself (a ride, a delivery, an invoice…): `${kind}:${id}` → every copy on screen.
  const live = new Map();
  const track = (key, el, draw) => {
    if (!live.has(key)) live.set(key, new Set());
    live.get(key).add({ el, draw });
  };

  const pill = (text, t = 'live') => h('span', { class: `pill pill-${t}`, text });
  const statusPill = (kind, status) => pill(STATUS_LABELS[kind]?.[status] || status || '', tone(kind, status));

  function shell(kind, { badge, kicker, title, sub, status, active = false, attrs = {} }, ...body) {
    return h('div', { class: `card card-${kind}${active ? ' is-active' : ''}`, 'data-card': kind, ...attrs },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-badge', 'aria-hidden': 'true' }, icon(badge)),
        h('div', { class: 'card-heads' },
          kicker ? h('p', { class: 'card-kicker', text: kicker }) : null,
          h('p', { class: 'card-title', text: title }),
          sub ? h('p', { class: 'card-sub', text: sub }) : null),
        status || null),
      ...body);
  }

  const row = (label, value, extra = null) => (value || extra ? h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: label }), h('span', { class: 'kv-v', text: value || '' }), extra) : null);

  function copyButton(text, label) {
    return h('button', { type: 'button', class: 'mini-btn', 'aria-label': `复制${label}`, onclick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        kit.toast(`${label}已复制`);
      } catch {
        kit.toast(text);
      }
    } }, icon('copy', 'icon icon-xs'), '复制');
  }

  // ---- Photos: generated pictures when public/art/photos has them, a tinted placeholder until then. ----

  function pickPhoto(kind, key, seed) {
    const manifest = kit.photos?.();
    const list = manifest?.[kind]?.[key];
    if (!Array.isArray(list) || !list.length) return null;
    return new URL(`art/photos/${list[hashOf(seed) % list.length]}`, import.meta.url).href;
  }

  function hotelPhotoKey(hotel) {
    const text = `${hotel.name || ''}${(hotel.tags || []).join('')}${hotel.businessArea || ''}`;
    if (/湖/.test(text)) return 'lake';
    if (/江|外滩|滨江|海/.test(text)) return 'city';
    if (/庭|院|民宿|精品/.test(text) && hashOf(hotel.id) % 2) return 'courtyard';
    return hotel.category || 'comfort';
  }

  function roomPhotoKey(name, category) {
    if (/双床/.test(name)) return 'twin';
    if (/家庭|亲子/.test(name)) return 'family';
    if (/套/.test(name)) return 'suite';
    if (/豪华|行政/.test(name)) return 'king-deluxe';
    return category === 'economy' ? 'king-economy' : 'king-comfort';
  }

  function photo(kind, key, seed, { label = '', badge = '', big = false } = {}) {
    const src = pickPhoto(kind, key, seed);
    const el = h('div', { class: `photo photo-${kind}${big ? ' is-big' : ''}${src ? '' : ` is-placeholder ph-${key}`}`, role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true' },
      src ? h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : icon(kind === 'rooms' ? 'bed' : 'hotel', 'icon photo-icon'),
      badge ? h('span', { class: 'photo-badge', text: badge }) : null);
    return el;
  }

  // ---- Search results ----

  function hotelsCard(card) {
    const q = card.query || {};
    const list = (card.hotels || []).slice(0, 5);
    if (!list.length) return null;
    const near = card.landmark?.name;
    const people = `${q.adults || 2}人${q.children ? `+${q.children}童` : ''}`;
    const rows = list.map((hotel, i) => {
      const meta = [`★ ${hotel.rating}`, near && hotel.distanceM != null ? `离${near}${hotel.distanceM < 1000 ? `${hotel.distanceM}米` : `${(hotel.distanceM / 1000).toFixed(1)}公里`}` : hotel.businessArea].filter(Boolean).join(' · ');
      const soldOut = hotel.lowestPrice == null;
      const btn = h('button', { type: 'button', class: 'pick-row', 'data-action': 'pick-hotel', 'data-lock': '', 'data-hotel-id': hotel.id },
        photo('covers', hotelPhotoKey(hotel), hotel.id, { badge: String(i + 1) }),
        h('span', { class: 'pick-main' },
          h('span', { class: 'pick-name', text: hotel.name }),
          h('span', { class: 'pick-meta', text: meta }),
          h('span', { class: 'pick-tags' },
            hotel.promo ? h('span', { class: 'tag tag-promo', text: `${hotel.promo.title || '特惠'} ${zheText(hotel.promo.discount)}` }) : null,
            [CATEGORY_LABELS[hotel.category], ...(hotel.tags || []).slice(0, hotel.promo ? 1 : 2)].filter(Boolean).map((t) => h('span', { class: 'tag', text: t })))),
        h('span', { class: 'pick-price' },
          soldOut ? h('span', { class: 'pick-off', text: hotel.fitsParty === false ? '住不下' : '满房' })
            : [h('span', { class: 'price', text: yuan(hotel.lowestPrice) }), h('span', { class: 'per', text: '起/晚' })]));
      btn.disabled = kit.busy();
      btn.addEventListener('click', () => kit.send(`看看「${hotel.name}」的房型：${kit.stayPhrase(q)}（hotel_id: ${hotel.id}，check_in: ${q.checkIn}，check_out: ${q.checkOut}）`));
      return btn;
    });
    return shell('hotels', {
      badge: 'hotel',
      kicker: `${q.city || ''}${near ? ` · ${near}附近` : ''}`,
      title: `为你找到 ${list.length} 家`,
      sub: `${date(q.checkIn, false)}入住 · ${q.nights || 1}晚 · ${people}`,
    }, h('div', { class: 'pick-list' }, rows));
  }

  // The plans worth showing: the cheapest one still free to cancel, and the cheapest overall.
  function bestRates(rates) {
    const open = (rates || []).filter((r) => r.available);
    const byPrice = [...open].sort((a, b) => a.totalPrice - b.totalPrice);
    const free = byPrice.find((r) => cancelLabel(r.cancelPolicy, kit.now?.()).free);
    return [...new Set([free, byPrice[0]].filter(Boolean))];
  }

  function roomsCard(card) {
    const hotel = card.hotel || {};
    const offer = card.offer || {};
    const types = (offer.roomTypes || []).filter((rt) => bestRates(rt.rates).length).slice(0, 3);
    if (!types.length) return null;
    const BREAKFAST = ['不含早', '含单早', '含双早'];
    const blocks = types.map((rt) => {
      const rates = bestRates(rt.rates).map((rate) => {
        const cancel = cancelLabel(rate.cancelPolicy, kit.now?.());
        const btn = h('button', { type: 'button', class: 'rate-row', 'data-action': 'pick-rate', 'data-lock': '', 'data-rate-id': rate.rateId },
          h('span', { class: 'rate-main' },
            h('span', { class: 'rate-name' }, BREAKFAST[rate.breakfast] || rate.name, rate.promo ? h('span', { class: 'tag tag-promo', text: `特惠 ${zheText(rate.promo.discount)}` }) : null),
            h('span', { class: `rate-cancel${cancel.free ? ' is-free' : ''}`, text: cancel.text })),
          h('span', { class: 'rate-price' }, h('span', { class: 'price', text: yuan(rate.totalPrice) }), h('span', { class: 'per', text: `共${offer.nights || 1}晚` })),
          h('span', { class: 'rate-go', text: '订' }));
        btn.disabled = kit.busy();
        btn.addEventListener('click', () => kit.send(`订「${hotel.name}」的 ${rt.name} · ${rate.name}：${kit.stayPhrase({ ...offer, checkIn: offer.checkIn, checkOut: offer.checkOut })}（hotel_id: ${hotel.id}，rate_id: ${rate.rateId}，check_in: ${offer.checkIn}，check_out: ${offer.checkOut}）`));
        return btn;
      });
      return h('div', { class: 'room-block' },
        h('div', { class: 'room-top' },
          photo('rooms', roomPhotoKey(rt.name, hotel.category), `${hotel.id}-${rt.roomId}`),
          h('div', { class: 'room-info' },
            h('p', { class: 'room-name', text: rt.name }),
            h('p', { class: 'room-meta', text: [rt.bed, rt.areaSqm ? `${rt.areaSqm}㎡` : '', rt.window].filter(Boolean).join(' · ') }))),
        h('div', { class: 'rate-list' }, rates));
    });
    return shell('rooms', {
      badge: 'bed',
      kicker: hotel.name,
      title: '可以订的房型',
      sub: `${date(offer.checkIn, false)} – ${date(offer.checkOut, false)} · ${offer.nights || 1}晚`,
    }, h('div', { class: 'room-list' }, blocks));
  }

  function placesCard(card) {
    const list = (card.places || []).slice(0, 6);
    if (!list.length) return null;
    return shell('places', { badge: 'pin', kicker: card.city, title: `${card.keyword || '附近'} · ${list.length} 个地方` },
      h('ul', { class: 'line-list' }, list.map((p) => h('li', {},
        h('span', { class: 'line-main', text: p.name }),
        h('span', { class: 'line-sub', text: [p.type, p.area].filter(Boolean).join(' · ') }),
        p.nearbyHotelCount ? h('span', { class: 'line-end', text: `附近 ${p.nearbyHotelCount} 家酒店` }) : null))));
  }

  function areasCard(card) {
    const list = (card.areas || []).slice(0, 5);
    if (!list.length) return null;
    return shell('areas', { badge: 'pin', kicker: card.city, title: '住哪片方便' },
      h('ul', { class: 'line-list' }, list.map((a) => h('li', {},
        h('span', { class: 'line-main', text: a.name }),
        h('span', { class: 'line-sub', text: a.reason || '' }),
        a.priceFrom != null ? h('span', { class: 'line-end', text: `${yuan(a.priceFrom)}起` }) : null))));
  }

  function webCard(card) {
    const list = (card.results || []).slice(0, 5);
    if (!list.length) return null;
    return shell('web', { badge: 'list', kicker: '联网搜索', title: card.query || '搜索结果' },
      h('ul', { class: 'line-list' }, list.map((r) => h('li', {},
        /^https?:\/\//.test(r.url || '') ? h('a', { class: 'line-main', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.title || r.url }) : h('span', { class: 'line-main', text: r.title || '' }),
        h('span', { class: 'line-sub', text: r.siteName || r.source || '' })))));
  }

  const ORDER_LABELS = { pending_payment: '待支付', confirmed: '已确认', cancelled: '已取消', closed: '已关闭' };

  function ordersCard(card) {
    const list = (card.orders || []).slice(0, 5);
    return shell('orders', { badge: 'receipt', kicker: '我的订单', title: list.length ? `共 ${card.orders.length} 单` : '还没有订单' },
      list.length ? h('ul', { class: 'line-list' }, list.map((o) => h('li', {},
        h('span', { class: 'line-main', text: o.hotel?.name || '订单' }),
        h('span', { class: 'line-sub', text: `${date(o.checkIn, false)} · ${o.nights || 1}晚 · ${yuan(o.totalPrice)}` }),
        h('span', { class: `line-end pill pill-${o.status === 'confirmed' ? 'ok' : 'muted'}`, text: ORDER_LABELS[o.status] || o.status })))) : null);
  }

  // ---- My plans: one booked stay ----

  function tripCard(card) {
    const o = card.order || {};
    const s = card.stay;
    const hotel = o.hotel || {};
    const status = s?.checkedOutAt ? pill('已退房', 'muted') : s ? pill(`已入住 · ${s.roomNumber || ''}`, 'ok') : pill('待入住', 'live');
    return shell('trip', {
      badge: 'hotel', kicker: o.id ? `订单 ${o.id}` : '订单', title: hotel.name || '酒店',
      sub: `${date(o.checkIn, false)} – ${date(o.checkOut, false)} · ${o.nights || 1}晚`, status,
    }, h('div', { class: 'trip-top' },
      photo('covers', hotelPhotoKey(hotel), hotel.id || o.id || ''),
      h('div', { class: 'kvs trip-kvs' },
        row('房型', [o.room?.name, o.rooms > 1 ? `${o.rooms}间` : ''].filter(Boolean).join(' · ')),
        row('入住人', (o.guests || []).join('、')),
        row('地址', hotel.address || ''))),
    // Checked in: the room number and the key, right here.
    s && !s.checkedOutAt ? [roomKey(s), h('div', { class: 'card-actions' }, keyButton(s))] : null);
  }

  // ---- Before arrival ----

  function itineraryCard(card) {
    const it = card.itinerary || {};
    const items = it.items || [];
    if (!items.length) return null;
    return shell('itinerary', { badge: 'route', kicker: [it.city, it.date ? date(it.date) : ''].filter(Boolean).join(' · '), title: it.title || '行程安排' },
      h('ol', { class: 'timeline' }, items.map((x) => h('li', {},
        h('span', { class: 'tl-time', text: x.time || '' }),
        h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'tl-body' },
          h('span', { class: 'tl-title', text: x.title || '' }),
          x.place || x.note ? h('span', { class: 'tl-sub', text: [x.place, x.note].filter(Boolean).join(' · ') }) : null)))));
  }

  function rideSteps(status) {
    const order = ['confirmed', 'arriving', 'completed'];
    const at = order.indexOf(status);
    return h('ol', { class: 'steps' }, ['已派车', '即将到达', '已完成'].map((label, i) => h('li', { class: i < at ? 'is-done' : i === at ? 'is-current' : '' }, h('span', { text: label }))));
  }

  function rideCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (ride) => {
      const quoted = ride.status === 'quoted';
      const body = [
        h('div', { class: 'route-box' },
          h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-from', 'aria-hidden': 'true' }), h('span', { text: ride.from || '' })),
          h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-to', 'aria-hidden': 'true' }), h('span', { text: ride.to || '' }))),
      ];
      if (ride.driver) {
        body.push(h('div', { class: 'driver' },
          h('span', { class: 'driver-face', 'aria-hidden': 'true', text: (ride.driver.name || '司').slice(0, 1) }),
          h('span', { class: 'driver-main' },
            h('span', { class: 'driver-name', text: ride.driver.name || '' }),
            h('span', { class: 'driver-car', text: [ride.driver.color, ride.driver.car].filter(Boolean).join(' · ') })),
          h('span', { class: 'plate', text: ride.driver.plate || '' })));
        body.push(rideSteps(ride.status));
      }
      const actions = h('div', { class: 'card-actions' });
      if (quoted) {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'confirm-ride' }, `确认叫车 ${yuan(ride.fare)}`);
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const data = await kit.api('POST', `/api/rides/${encodeURIComponent(ride.id)}/confirm`, {});
            if (data.ride) draw(data.ride);
            kit.onAction();
          } catch (err) {
            btn.disabled = false;
            kit.toast(err.message);
            if (err.status === 410) draw({ ...ride, status: 'expired' });
          }
        });
        actions.append(h('p', { class: 'card-note', text: '模拟叫车，不会真的派车' }), btn);
      } else if (ride.status === 'expired') {
        actions.append(kit.chatButton('重新叫车', ride.rideKind === 'airport_pickup' ? '重新帮我叫接机' : '重新帮我叫车', { cls: 'btn btn-secondary', action: 'requote-ride' }));
      }
      el.replaceChildren(shell(quoted || ride.status === 'expired' ? 'ride_quote' : 'ride', {
        badge: ride.rideKind === 'airport_pickup' ? 'plane' : 'car',
        kicker: ride.kindLabel || '叫车',
        title: `${clockTime(ride.pickupAt)} 上车`,
        sub: [ride.carType, ride.passengers ? `${ride.passengers}人` : '', ride.minutes ? `约${ride.minutes}分钟` : '',
          quoted ? `约${yuan(ride.fare)}` : ride.payment ? `已付${yuan(ride.fare)}` : ''].filter(Boolean).join(' · '),
        status: statusPill('ride', ride.status),
        active: quoted,
        attrs: { 'data-id': ride.id, 'data-status': ride.status },
      }, ...body, actions.childElementCount ? actions : null));
    };
    draw(card.ride || {});
    if (card.ride?.id) track(`ride:${card.ride.id}`, el, draw);
    return el;
  }

  function earlyCard(card) {
    const r = card.request || {};
    const when = [r.date ? date(r.date, false) : '', r.arrivalTime].filter(Boolean).join(' ');
    return shell('early_checkin', { badge: 'door', kicker: r.hotel?.name, title: `提前入住 · ${when}到店`, status: statusPill('early_checkin', r.status) },
      r.note ? h('p', { class: 'card-text', text: r.note }) : null);
  }

  // ---- Check-in and the stay ----

  const breakfastText = (b) => [b.time, b.place, b.included ? '含早' : b.price ? `${yuan(b.price)}/人` : ''].filter(Boolean).join(' · ');

  function roomKey(s) {
    return h('div', { class: 'roomkey' },
      h('div', { class: 'roomkey-no' }, h('span', { class: 'roomkey-label', text: '房间' }), h('span', { class: 'roomkey-num', text: s.roomNumber || '' })),
      h('div', { class: 'roomkey-side' },
        h('span', { text: s.floor ? `${s.floor} 层` : '' }),
        h('span', { text: s.roomType || '' })));
  }

  function keyButton(s) {
    const key = h('button', { type: 'button', class: 'btn btn-primary key-btn', 'data-action': 'open-key' }, icon('key', 'icon'), '电子房卡');
    key.addEventListener('click', () => kit.openKey(s));
    return key;
  }

  function checkinCard(card) {
    const s = card.stay || {};
    return shell('checkin', { badge: 'key', kicker: s.hotel?.name, title: '入住办好啦', sub: `${date(s.checkIn, false)} – ${date(s.checkOut, false)} · ${s.nights || 1}晚`, status: s.early ? pill('提前办理', 'live') : pill('已入住', 'ok') },
      roomKey(s),
      h('div', { class: 'kvs' },
        s.wifi ? row('Wi-Fi', `${s.wifi.ssid} / ${s.wifi.password}`, copyButton(s.wifi.password, 'Wi-Fi 密码')) : null,
        s.breakfast ? row('早餐', breakfastText(s.breakfast)) : null,
        row('退房', s.checkoutTime ? `${date(s.checkOut, false)} ${s.checkoutTime} 前` : '')),
      h('div', { class: 'card-actions' }, keyButton(s)));
  }

  function serviceSteps(status) {
    const order = ['accepted', 'on_the_way', 'done'];
    const at = order.indexOf(status);
    return h('ol', { class: 'steps' }, ['已接单', '配送中', '已送达'].map((label, i) => h('li', { class: i < at ? 'is-done' : i === at ? 'is-current' : '' }, h('span', { text: label }))));
  }

  function serviceCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (t) => {
      const what = (t.items || []).map((x) => `${x.name}${x.qty > 1 ? ` ×${x.qty}` : ''}`).join('、') || '客房服务';
      el.replaceChildren(shell('service', {
        badge: 'box', kicker: t.roomNumber ? `送到 ${t.roomNumber} 房` : '客房服务', title: what,
        sub: t.status === 'done' ? `${clockTime(t.timeline?.find((x) => x.status === 'done')?.at || t.eta)} 已送到` : `预计 ${clockTime(t.eta)} 送到`,
        status: statusPill('service', t.status), attrs: { 'data-id': t.id, 'data-status': t.status },
      }, serviceSteps(t.status), t.note ? h('p', { class: 'card-text', text: t.note }) : null));
    };
    draw(card.ticket || {});
    if (card.ticket?.id) track(`service:${card.ticket.id}`, el, draw);
    return el;
  }

  function diningCard(card) {
    const r = card.reservation || {};
    return shell('dining', { badge: 'dining', kicker: r.restaurant, title: `${r.kindLabel || '用餐'} · ${clockTime(r.at)}`, sub: [dayTime(r.at).split(' ')[0], r.place].filter(Boolean).join(' · '), status: statusPill('dining', r.status || 'reserved') },
      h('div', { class: 'kvs' },
        row('人数', r.people ? `${r.people} 位` : ''),
        row('桌号', r.table || ''),
        row('费用', r.included ? '含早，免费'
          : r.covered ? `含早${r.covered}位，其余${yuan(r.price)}/人 · 记到房账`
            : r.price ? `${yuan(r.price)}/人 · 记到房账` : '')));
  }

  function wakeupCard(card) {
    const c = card.call || {};
    return shell('wakeup', { badge: 'alarm', kicker: c.roomNumber ? `${c.roomNumber} 房` : '叫醒服务', title: '叫醒服务', status: statusPill('wakeup', c.status) },
      h('div', { class: 'bigtime' }, h('span', { class: 'bigtime-num', text: clockTime(c.at) }), h('span', { class: 'bigtime-sub', text: dayTime(c.at).split(' ')[0] })));
  }

  function infoCard(card) {
    const i = card.info || {};
    const tel = i.frontDesk ? h('a', { class: 'mini-btn', href: `tel:${String(i.frontDesk).replace(/[^\d+]/g, '')}` }, icon('phone', 'icon icon-xs'), '拨打') : null;
    return shell('stay_info', { badge: 'wifi', kicker: i.hotel?.name, title: i.roomNumber ? `${i.roomNumber} 房 · 住店信息` : '住店信息', status: i.checkedIn ? pill('已入住', 'ok') : pill('未入住', 'muted') },
      h('div', { class: 'kvs' },
        i.wifi ? row('Wi-Fi', `${i.wifi.ssid} / ${i.wifi.password}`, copyButton(i.wifi.password, 'Wi-Fi 密码')) : null,
        i.breakfast ? row('早餐', breakfastText(i.breakfast)) : null,
        row('退房', i.checkoutTime ? `${i.checkoutTime} 前` : ''),
        row('前台', i.frontDesk || '', tel)),
      (i.facilities || []).length ? h('div', { class: 'tags' }, i.facilities.map((f) => h('span', { class: 'tag', text: [f.name, f.hours].filter(Boolean).join(' ') }))) : null);
  }

  function extensionCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (x) => {
      const actions = h('div', { class: 'card-actions' });
      if (x.status === 'pending') {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'confirm-extension' }, `确认续住 ${yuan(x.price)}`);
        btn.addEventListener('click', async () => {
          const result = await kit.pay({
            title: '续住',
            amount: x.price,
            desc: [x.hotel?.name, `续住${x.nights}晚`, `${date(x.toDate, false)}离店`].filter(Boolean).join(' · '),
            run: (method) => kit.api('POST', `/api/extensions/${encodeURIComponent(x.id)}/confirm`, { method }),
          });
          if (result?.extension) draw(result.extension);
          if (result) kit.onAction();
        });
        actions.append(btn);
      }
      el.replaceChildren(shell('extension_quote', {
        badge: 'calendar', kicker: x.hotel?.name, title: `续住 ${x.nights || 1} 晚`, sub: `${x.room || ''}${x.room ? ' · ' : ''}${date(x.fromDate, false)} – ${date(x.toDate, false)}`,
        status: statusPill('extension', x.status), active: x.status === 'pending', attrs: { 'data-id': x.id, 'data-status': x.status },
      }, h('div', { class: 'card-total' }, h('span', { text: x.status === 'confirmed' ? '已支付' : '合计' }), h('span', { class: 'card-amount', text: yuan(x.price) })),
      actions.childElementCount ? actions : null));
    };
    draw(card.extension || {});
    if (card.extension?.id) track(`extension:${card.extension.id}`, el, draw);
    return el;
  }

  // ---- Leaving ----

  function billCard(card) {
    const b = card.bill || {};
    return shell('bill', { badge: 'receipt', kicker: b.hotel?.name, title: '退房账单', sub: `${b.roomNumber ? `${b.roomNumber} 房 · ` : ''}${date(b.checkIn, false)} – ${date(b.checkOut, false)} · ${b.nights || 1}晚`, status: pill('已退房', 'ok') },
      h('dl', { class: 'bill-lines' }, (b.lines || []).map((l) => h('div', { class: 'bill-line' },
        h('dt', {}, h('span', { text: l.label }), l.note ? h('span', { class: 'bill-note', text: l.note }) : null),
        h('dd', { text: yuan(l.amount) })))),
      h('div', { class: 'card-total' }, h('span', { text: b.due > 0 ? `离店结清（${b.settledBy}）` : '无需补缴' }), h('span', { class: 'card-amount', text: yuan(b.due || 0) })),
      b.pointsEarned ? h('p', { class: 'points-earned' }, icon('sparkle', 'icon icon-xs'), h('span', { text: `本次获得 ${b.pointsEarned.toLocaleString('zh-CN')} 积分` })) : null);
  }

  function invoiceCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (v) => {
      el.replaceChildren(shell('invoice', { badge: 'invoice', kicker: v.invoiceKind || '电子普通发票', title: v.title || '发票', status: statusPill('invoice', v.status), attrs: { 'data-id': v.id, 'data-status': v.status } },
        h('div', { class: 'kvs' }, row('金额', yuan(v.amount)), row('税号', v.taxId || ''), row('发送到', v.email || ''), v.issuedAt ? row('开具时间', dayTime(v.issuedAt)) : null)));
    };
    draw(card.invoice || {});
    if (card.invoice?.id) track(`invoice:${card.invoice.id}`, el, draw);
    return el;
  }

  function membershipCard(card) {
    const m = card.member || {};
    const total = (m.points || 0) + (m.pointsToNext || 0);
    const pct = m.nextLevel && total ? Math.min(100, Math.round(((m.points || 0) / total) * 100)) : 100;
    return shell('membership', { badge: 'crown', kicker: '小宿会员', title: m.level || '会员', status: pill(`${(m.points || 0).toLocaleString('zh-CN')} 积分`, 'ok') },
      h('div', { class: `level level-${{ 银卡: 'silver', 金卡: 'gold', 铂金卡: 'platinum' }[m.level] || 'silver'}` },
        h('span', { class: 'level-name', text: m.level || '' }),
        h('span', { class: 'level-points', text: (m.points || 0).toLocaleString('zh-CN') }),
        h('span', { class: 'level-bar' }, h('span', { class: 'level-fill', style: `width:${pct}%` })),
        h('span', { class: 'level-next', text: m.nextLevel ? `再 ${(m.pointsToNext || 0).toLocaleString('zh-CN')} 积分升${m.nextLevel}` : '已是最高等级' })),
      (m.perks || []).length ? h('div', { class: 'tags' }, m.perks.map((p) => h('span', { class: 'tag', text: p }))) : null,
      (m.recent || []).length ? h('ul', { class: 'line-list' }, m.recent.slice(0, 4).map((r) => h('li', {},
        h('span', { class: 'line-main', text: r.label }),
        h('span', { class: 'line-end', text: `${r.points > 0 ? '+' : ''}${r.points}` })))) : null);
  }

  function stars(rating) {
    return h('span', { class: 'stars', role: 'img', 'aria-label': `${rating} 星` }, [1, 2, 3, 4, 5].map((n) => icon('star', `icon star${n <= rating ? ' is-on' : ''}`)));
  }

  function reviewCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (r) => {
      const actions = h('div', { class: 'card-actions' });
      if (r.status === 'draft') {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'publish-review' }, '发布点评');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const data = await kit.api('POST', `/api/reviews/${encodeURIComponent(r.id)}/publish`, {});
            draw(data.review || { ...r, status: 'published' });
            kit.onAction();
          } catch (err) {
            btn.disabled = false;
            kit.toast(err.message);
          }
        });
        actions.append(h('p', { class: 'card-note', text: '点了才会发布' }), btn);
      }
      el.replaceChildren(shell('review_draft', { badge: 'star', kicker: r.hotel?.name, title: r.status === 'published' ? '点评已发布' : '点评草稿', status: statusPill('review', r.status), active: r.status === 'draft', attrs: { 'data-id': r.id, 'data-status': r.status } },
        stars(r.rating || 5),
        h('p', { class: 'card-text', text: r.text || '' }),
        r.reply?.text ? h('div', { class: 'card-reply' }, h('span', { class: 'card-reply-who', text: '酒店回复' }), h('span', { text: r.reply.text })) : null,
        (r.tags || []).length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag', text: t }))) : null,
        actions.childElementCount ? actions : null));
    };
    draw(card.review || {});
    if (card.review?.id) track(`review:${card.review.id}`, el, draw);
    return el;
  }

  const RENDER = {
    hotels: hotelsCard,
    rooms: roomsCard,
    places: placesCard,
    areas: areasCard,
    web: webCard,
    orders: ordersCard,
    itinerary: itineraryCard,
    ride_quote: rideCard,
    ride: rideCard,
    early_checkin: earlyCard,
    checkin: checkinCard,
    service: serviceCard,
    dining: diningCard,
    wakeup: wakeupCard,
    stay_info: infoCard,
    extension_quote: extensionCard,
    bill: billCard,
    invoice: invoiceCard,
    membership: membershipCard,
    review_draft: reviewCard,
    trip: tripCard,
  };

  // A request from GET /api/stays, as the card the chat shows for it.
  const REQUEST_CARDS = {
    ride: (r) => ({ type: 'ride', ride: r }),
    early_checkin: (r) => ({ type: 'early_checkin', request: r }),
    service: (r) => ({ type: 'service', ticket: r }),
    dining: (r) => ({ type: 'dining', reservation: r }),
    wakeup: (r) => ({ type: 'wakeup', call: r }),
    invoice: (r) => ({ type: 'invoice', invoice: r }),
    extension: (r) => ({ type: 'extension_quote', extension: r }),
    review: (r) => ({ type: 'review_draft', review: r }),
  };

  return {
    /** The card element, or null for a card this page does not draw. */
    render(card) {
      const fn = card && RENDER[card.type];
      return fn ? fn(card) : null;
    },
    /** The card for a request from GET /api/stays (null for a kind this page does not draw). */
    forRequest(request) {
      const make = request && REQUEST_CARDS[request.kind];
      return make ? this.render(make(request)) : null;
    },
    /** Redraws every copy on screen of the card for a request that moved on (from GET /api/stays). */
    update(request) {
      const copies = live.get(`${request?.kind}:${request?.id}`);
      if (!copies) return;
      for (const copy of [...copies]) {
        if (copy.el.isConnected) copy.draw(request);
        else copies.delete(copy);
      }
    },
    photo,
    hotelPhotoKey,
  };
}
