// Cards for everything the agent finds or arranges: hotels, rooms, places, bookings, and the stay after booking
// (itinerary, ride, check-in key, room service, dining, wake-up, hotel info, extension, bill, receipt,
// rewards, review). Field names follow docs/JOURNEY.md and docs/US-CONTRACT.md. Server/LLM text reaches the DOM
// only through textContent (h() with `text`), never as markup.
// Times at a hotel are instants (…At); they show in the hotel's zone when a card names one (timeZone), else in the
// user's own.
import { icon } from './icons.js';
import {
  clockTime, dayOf, dayTime, formatDate, formatDistance, formatMoney, formatRange, percentOff, plural, wallTime,
} from './format.js';

const CATEGORY_LABELS = { budget: 'Budget', midscale: 'Midscale', upscale: 'Upscale', luxury: 'Luxury' };

export const STATUS_LABELS = {
  ride: { quoted: 'To confirm', confirmed: 'Driver assigned', arriving: 'Arriving', completed: 'Completed', expired: 'Expired', cancelled: 'Cancelled' },
  service: { accepted: 'Received', on_the_way: 'On the way', done: 'Delivered' },
  receipt: { sending: 'Sending', sent: 'Sent' },
  wakeup: { set: 'Set', done: 'Done', cancelled: 'Cancelled' },
  extension: { pending: 'To confirm', confirmed: 'Extended', expired: 'Expired' },
  review: { draft: 'Draft', published: 'Published' },
  early_checkin: { confirmed: 'Confirmed', pending: 'Pending', declined: 'Fully booked', cancelled: 'Cancelled' },
  dining: { reserved: 'Reserved', done: 'Completed', cancelled: 'Cancelled' },
};

const DONE = new Set(['completed', 'done', 'sent', 'confirmed', 'published']);
// A ride with a driver assigned is still on its way, not done.
const tone = (kind, status) => (DONE.has(status) && !(kind === 'ride' && status === 'confirmed') ? 'ok'
  : ['expired', 'cancelled', 'declined'].includes(status) ? 'muted' : 'live');

function hashOf(s) {
  let x = 2166136261;
  for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return x >>> 0;
}

/** A cancellation policy in two or three words; a free-cancel deadline that has passed no longer counts as free. */
export function cancelLabel(policy, nowMs = Date.now()) {
  if (!policy || policy.type === 'none') return { text: 'Non-refundable', free: false };
  const until = Date.parse(policy.freeUntil);
  if (!Number.isNaN(until) && nowMs >= until) return { text: 'First night charged if cancelled', free: false };
  return policy.type === 'limited' ? { text: 'Partly refundable', free: false } : { text: 'Free cancellation', free: true };
}

const zoneOf = (...things) => things.find((t) => typeof t?.timeZone === 'string')?.timeZone;
const nights = (n) => plural(n || 1, 'night');

/**
 * @param kit everything the cards need from the page: h, roomsMessage (hotel, query) and bookMessage (hotel, room
 *   type, rate, offer) → the chat messages a tap sends, send (chat message), api (method, path, body), pay ({ title,
 *   amount, desc, run(method) }) → result|null, toast, onAction (after a tap changed something server-side),
 *   photos () → manifest or null, now () → server ms, busy (), chatButton, openKey (stay).
 */
export function createCards(kit) {
  const { h } = kit;
  const money = formatMoney;
  const date = formatDate;
  // Cards whose request moves on by itself (a ride, a delivery, a receipt…): `${kind}:${id}` → every copy on screen.
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
    return h('button', { type: 'button', class: 'mini-btn', 'aria-label': `Copy ${label}`, onclick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        kit.toast(`${label[0].toUpperCase()}${label.slice(1)} copied`);
      } catch {
        kit.toast(text);
      }
    } }, icon('copy', 'icon icon-xs'), 'Copy');
  }

  // ---- Photos: generated pictures when public/art/photos has them, a tinted placeholder until then. ----
  // The keys are the ones in docs/ART-PROMPTS.md (cover-economy … room-suite).

  const CATEGORY_PHOTOS = { budget: 'economy', midscale: 'comfort', upscale: 'premium', luxury: 'luxury' };

  function pickPhoto(kind, key, seed) {
    const manifest = kit.photos?.();
    const list = manifest?.[kind]?.[key];
    if (!Array.isArray(list) || !list.length) return null;
    return new URL(`art/photos/${list[hashOf(seed) % list.length]}`, import.meta.url).href;
  }

  function hotelPhotoKey(hotel) {
    const text = `${hotel.name || ''} ${(hotel.tags || []).join(' ')} ${hotel.businessArea || ''}`;
    if (/\b(?:beach|ocean|bay|lake|harbor|harbour|waterfront|marina|wharf|waikiki|seaport)\b/i.test(text)) return 'lake';
    if (/\b(?:skyline|tower|downtown|times square|the strip|loop|mile|midtown|financial)\b/i.test(text)) return 'city';
    if (/\b(?:inn|boutique|garden|courtyard|cottage|b&b|hacienda)\b/i.test(text) && hashOf(hotel.id) % 2) return 'courtyard';
    return CATEGORY_PHOTOS[hotel.category] || 'comfort';
  }

  function roomPhotoKey(name, category) {
    if (/\b(?:two|2|double)\s+(?:queens?|doubles?|beds)\b|\btwin\b|queen[\s-]queen/i.test(name)) return 'twin';
    if (/\b(?:family|kids?|bunk)\b/i.test(name)) return 'family';
    if (/\bsuite\b/i.test(name)) return 'suite';
    if (/\b(?:deluxe|executive|premium|club|premier)\b/i.test(name)) return 'king-deluxe';
    return category === 'budget' ? 'king-economy' : 'king-comfort';
  }

  /** A real photo from the hotel supplier (live hotels), only over https. */
  function livePhoto(list) {
    const url = Array.isArray(list) ? list.find((u) => typeof u === 'string' && /^https:\/\//.test(u)) : null;
    return url || null;
  }

  function photo(kind, key, seed, { label = '', badge = '', big = false, src: real = null } = {}) {
    const src = real || pickPhoto(kind, key, seed);
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
    const people = [plural(q.adults || 2, 'adult'), q.children ? plural(q.children, 'child', 'children') : ''].filter(Boolean).join(', ');
    const rows = list.map((hotel, i) => {
      const distance = near && hotel.distanceM != null ? formatDistance(hotel.distanceM) : '';
      // The landmark is in the card's kicker ("Near Times Square"), so a row only says how far.
      const meta = [hotel.rating != null ? `★ ${hotel.rating}` : '', distance ? `${distance} away` : hotel.businessArea].filter(Boolean).join(' · ');
      const soldOut = hotel.lowestPrice == null;
      const btn = h('button', { type: 'button', class: 'pick-row', 'data-action': 'pick-hotel', 'data-lock': '', 'data-hotel-id': hotel.id },
        photo('covers', hotelPhotoKey(hotel), hotel.id, { badge: String(i + 1), src: livePhoto(hotel.photos) }),
        h('span', { class: 'pick-main' },
          h('span', { class: 'pick-name', text: hotel.name }),
          h('span', { class: 'pick-meta', text: meta }),
          h('span', { class: 'pick-tags' },
            hotel.promo ? h('span', { class: 'tag tag-promo', title: hotel.promo.title || null, text: percentOff(hotel.promo.discount) || 'Deal' }) : null,
            [CATEGORY_LABELS[hotel.category], ...(hotel.tags || []).slice(0, 1)].filter(Boolean).map((t) => h('span', { class: 'tag', text: t })))),
        h('span', { class: 'pick-price' },
          soldOut ? h('span', { class: 'pick-off', text: hotel.fitsParty === false ? 'Too small' : 'Sold out' })
            : [h('span', { class: 'per', text: 'from' }), h('span', { class: 'price', text: money(hotel.lowestPrice) }), h('span', { class: 'per', text: '/night' })]));
      btn.disabled = kit.busy();
      btn.addEventListener('click', () => kit.send(kit.roomsMessage(hotel, q)));
      return btn;
    });
    return shell('hotels', {
      badge: 'hotel',
      kicker: [q.city, near ? `Near ${near}` : ''].filter(Boolean).join(' · '),
      title: `${plural(list.length, 'hotel')} for you`,
      sub: [date(q.checkIn), nights(q.nights), people].filter(Boolean).join(' · '),
    }, h('div', { class: 'pick-list' }, rows));
  }

  // The plans worth showing: the cheapest one still free to cancel, and the cheapest overall.
  function bestRates(rates) {
    const open = (rates || []).filter((r) => r.available);
    const byPrice = [...open].sort((a, b) => a.totalPrice - b.totalPrice);
    const free = byPrice.find((r) => cancelLabel(r.cancelPolicy, kit.now?.()).free);
    return [...new Set([free, byPrice[0]].filter(Boolean))];
  }

  const BREAKFAST = ['Room only', 'Breakfast for 1', 'Breakfast for 2'];
  // Room sizes come in square meters; American guests read square feet.
  const sqft = (sqm) => `${Math.round((sqm * 10.7639) / 5) * 5} sq ft`;

  function roomsCard(card) {
    const hotel = card.hotel || {};
    const offer = card.offer || {};
    const types = (offer.roomTypes || []).filter((rt) => bestRates(rt.rates).length).slice(0, 3);
    if (!types.length) return null;
    const blocks = types.map((rt) => {
      const rates = bestRates(rt.rates).map((rate) => {
        const cancel = cancelLabel(rate.cancelPolicy, kit.now?.());
        const btn = h('button', { type: 'button', class: 'rate-row', 'data-action': 'pick-rate', 'data-lock': '', 'data-rate-id': rate.rateId },
          h('span', { class: 'rate-main' },
            h('span', { class: 'rate-name' }, BREAKFAST[rate.breakfast] || rate.name, rate.promo ? h('span', { class: 'tag tag-promo', text: percentOff(rate.promo.discount) || 'Deal' }) : null),
            h('span', { class: `rate-cancel${cancel.free ? ' is-free' : ''}`, text: cancel.text })),
          h('span', { class: 'rate-price' }, h('span', { class: 'price', text: money(rate.totalPrice) }), h('span', { class: 'per', text: `for ${nights(offer.nights)}` })),
          h('span', { class: 'rate-go', text: 'Book' }));
        btn.disabled = kit.busy();
        btn.addEventListener('click', () => kit.send(kit.bookMessage(hotel, rt, rate, offer)));
        return btn;
      });
      return h('div', { class: 'room-block' },
        h('div', { class: 'room-top' },
          photo('rooms', roomPhotoKey(rt.name, hotel.category), `${hotel.id}-${rt.roomId}`, { src: livePhoto(rt.photos) }),
          h('div', { class: 'room-info' },
            h('p', { class: 'room-name', text: rt.name }),
            h('p', { class: 'room-meta', text: [rt.bed, rt.areaSqm ? sqft(rt.areaSqm) : '', rt.window].filter(Boolean).join(' · ') }))),
        h('div', { class: 'rate-list' }, rates));
    });
    return shell('rooms', {
      badge: 'bed',
      kicker: hotel.name,
      title: 'Rooms you can book',
      sub: `${formatRange(offer.checkIn, offer.checkOut)} · ${nights(offer.nights)}`,
    }, h('div', { class: 'room-list' }, blocks));
  }

  function placesCard(card) {
    const list = (card.places || []).slice(0, 6);
    if (!list.length) return null;
    return shell('places', { badge: 'pin', kicker: card.city, title: `${card.keyword || 'Nearby'} · ${plural(list.length, 'place')}` },
      h('ul', { class: 'line-list' }, list.map((p) => h('li', {},
        h('span', { class: 'line-main', text: p.name }),
        h('span', { class: 'line-sub', text: [p.type, p.area].filter(Boolean).join(' · ') }),
        p.nearbyHotelCount ? h('span', { class: 'line-end', text: `${plural(p.nearbyHotelCount, 'hotel')} nearby` }) : null))));
  }

  function areasCard(card) {
    const list = (card.areas || []).slice(0, 5);
    if (!list.length) return null;
    return shell('areas', { badge: 'pin', kicker: card.city, title: 'Where to stay' },
      h('ul', { class: 'line-list' }, list.map((a) => h('li', {},
        h('span', { class: 'line-main', text: a.name }),
        h('span', { class: 'line-sub', text: a.reason || '' }),
        a.priceFrom != null ? h('span', { class: 'line-end', text: `from ${money(a.priceFrom)}` }) : null))));
  }

  function webCard(card) {
    const list = (card.results || []).slice(0, 5);
    if (!list.length) return null;
    return shell('web', { badge: 'list', kicker: 'Web search', title: card.query || 'Results' },
      h('ul', { class: 'line-list' }, list.map((r) => h('li', {},
        /^https?:\/\//.test(r.url || '') ? h('a', { class: 'line-main', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.title || r.url }) : h('span', { class: 'line-main', text: r.title || '' }),
        h('span', { class: 'line-sub', text: r.siteName || r.source || '' })))));
  }

  const ORDER_LABELS = { pending_payment: 'Unpaid', confirmed: 'Confirmed', cancelled: 'Cancelled', closed: 'Closed' };

  function ordersCard(card) {
    const list = (card.orders || []).slice(0, 5);
    return shell('orders', { badge: 'receipt', kicker: 'My bookings', title: list.length ? plural(card.orders.length, 'booking') : 'No bookings yet' },
      list.length ? h('ul', { class: 'line-list' }, list.map((o) => h('li', {},
        h('span', { class: 'line-main', text: o.hotel?.name || 'Booking' }),
        h('span', { class: 'line-sub', text: `${date(o.checkIn, false)} · ${nights(o.nights)} · ${money(o.totalPrice)}` }),
        h('span', { class: `line-end pill pill-${o.status === 'confirmed' ? 'ok' : 'muted'}`, text: ORDER_LABELS[o.status] || o.status })))) : null);
  }

  // ---- My trips: one booked stay ----

  function tripCard(card) {
    const o = card.order || {};
    const s = card.stay;
    const hotel = o.hotel || {};
    const status = s?.checkedOutAt ? pill('Checked out', 'muted') : s ? pill(`Room ${s.roomNumber || ''}`, 'ok') : pill('Upcoming', 'live');
    return shell('trip', {
      badge: 'hotel', kicker: o.id ? `Booking ${o.id}` : 'Booking', title: hotel.name || 'Hotel',
      sub: `${formatRange(o.checkIn, o.checkOut)} · ${nights(o.nights)}`, status,
    }, h('div', { class: 'trip-top' },
      photo('covers', hotelPhotoKey(hotel), hotel.id || o.id || '', { src: livePhoto(hotel.photos) }),
      h('div', { class: 'kvs trip-kvs' },
        row('Room', [o.room?.name, o.rooms > 1 ? plural(o.rooms, 'room') : ''].filter(Boolean).join(' · ')),
        row('Guests', (o.guests || []).join(', ')),
        row('Address', hotel.address || ''))),
    // Checked in: the room number and the key, right here.
    s && !s.checkedOutAt ? [roomKey(s), h('div', { class: 'card-actions' }, keyButton(s))] : null);
  }

  // ---- Before arrival ----

  function itineraryCard(card) {
    const it = card.itinerary || {};
    const items = it.items || [];
    if (!items.length) return null;
    return shell('itinerary', { badge: 'route', kicker: [it.city, it.date ? date(it.date) : ''].filter(Boolean).join(' · '), title: it.title || 'Your day' },
      h('ol', { class: 'timeline' }, items.map((x) => h('li', {},
        h('span', { class: 'tl-time', text: wallTime(x.time) }),
        h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'tl-body' },
          h('span', { class: 'tl-title', text: x.title || '' }),
          x.place || x.note ? h('span', { class: 'tl-sub', text: [x.place, x.note].filter(Boolean).join(' · ') }) : null)))));
  }

  function steps(labels, order, status) {
    const at = order.indexOf(status);
    return h('ol', { class: 'steps' }, labels.map((label, i) => h('li', { class: i < at ? 'is-done' : i === at ? 'is-current' : '' }, h('span', { text: label }))));
  }

  /** Live mode: the trip filled in for Uber and Lyft; the guest books and pays in their app (or website). */
  function rideLinksCard(card) {
    const safe = (u) => (typeof u === 'string' && /^https:\/\/(?:m\.uber\.com|www\.uber\.com|lyft\.com|ride\.lyft\.com)\//.test(u) ? u : null);
    const links = [
      ['uber', card.links?.uber?.label || 'Open in Uber', safe(card.links?.uber?.url)],
      ['lyft', card.links?.lyft?.label || 'Open in Lyft', safe(card.links?.lyft?.url)],
    ].filter(([, , url]) => url);
    if (!links.length) return null;
    return shell('ride_links', {
      badge: card.rideKind === 'airport_pickup' ? 'plane' : 'car',
      kicker: card.kindLabel || 'Ride',
      title: card.to ? `To ${card.to}` : 'Get a ride',
      sub: card.from ? `From ${card.from}` : 'Pickup at your location',
    },
    h('div', { class: 'route-box' },
      h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-from', 'aria-hidden': 'true' }), h('span', { text: card.from || 'Your location' })),
      h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-to', 'aria-hidden': 'true' }), h('span', { text: card.to || '' }))),
    h('div', { class: 'card-actions ride-links' },
      ...links.map(([key, label, url]) => h('a', { class: `btn ${key === 'uber' ? 'btn-primary' : 'btn-secondary'}`, href: url, target: '_blank', rel: 'noopener noreferrer', 'data-action': `open-${key}` }, label)),
      h('p', { class: 'card-note', text: 'You book and pay in the Uber or Lyft app; the fare is theirs.' })));
  }

  function rideCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (ride) => {
      const quoted = ride.status === 'quoted';
      const zone = zoneOf(ride);
      const body = [
        h('div', { class: 'route-box' },
          h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-from', 'aria-hidden': 'true' }), h('span', { text: ride.from || '' })),
          h('div', { class: 'route-pt' }, h('span', { class: 'route-dot is-to', 'aria-hidden': 'true' }), h('span', { text: ride.to || '' }))),
      ];
      if (ride.driver) {
        body.push(h('div', { class: 'driver' },
          h('span', { class: 'driver-face', 'aria-hidden': 'true', text: (ride.driver.name || 'D').slice(0, 1) }),
          h('span', { class: 'driver-main' },
            h('span', { class: 'driver-name', text: ride.driver.name || '' }),
            h('span', { class: 'driver-car', text: [ride.driver.color, ride.driver.car].filter(Boolean).join(' · ') })),
          h('span', { class: 'plate', text: ride.driver.plate || '' })));
        body.push(steps(['Driver assigned', 'Arriving', 'Completed'], ['confirmed', 'arriving', 'completed'], ride.status));
      }
      const actions = h('div', { class: 'card-actions' });
      if (quoted) {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'confirm-ride' }, `Confirm ride ${money(ride.fare)}`);
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
        actions.append(h('p', { class: 'card-note', text: 'Simulated ride: no real driver is sent' }), btn);
      } else if (ride.status === 'expired') {
        actions.append(kit.chatButton('Request again', ride.rideKind === 'airport_pickup' ? 'Pick me up at the airport again' : 'Get me a ride again', { cls: 'btn btn-secondary', action: 'requote-ride' }));
      }
      el.replaceChildren(shell(quoted || ride.status === 'expired' ? 'ride_quote' : 'ride', {
        badge: ride.rideKind === 'airport_pickup' ? 'plane' : 'car',
        kicker: ride.kindLabel || 'Ride',
        title: `Pickup at ${clockTime(ride.pickupAt, zone)}`,
        sub: [ride.carType, ride.passengers ? plural(ride.passengers, 'passenger') : '', ride.minutes ? `${ride.minutes} min` : '',
          quoted ? `about ${money(ride.fare)}` : ride.payment ? `Paid ${money(ride.fare)}` : ''].filter(Boolean).join(' · '),
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
    const when = [r.date ? date(r.date) : '', wallTime(r.arrivalTime)].filter(Boolean).join(', ');
    return shell('early_checkin', { badge: 'door', kicker: r.hotel?.name, title: 'Early check-in', sub: when ? `Arriving ${when}` : '', status: statusPill('early_checkin', r.status) },
      r.note ? h('p', { class: 'card-text', text: r.note }) : null);
  }

  // ---- Check-in and the stay ----

  const breakfastText = (b) => [wallTime(b.time), b.place, b.included ? 'Included' : b.price ? `${money(b.price)} per person` : ''].filter(Boolean).join(' · ');

  function roomKey(s) {
    return h('div', { class: 'roomkey' },
      h('div', { class: 'roomkey-no' }, h('span', { class: 'roomkey-label', text: 'Room' }), h('span', { class: 'roomkey-num', text: s.roomNumber || '' })),
      h('div', { class: 'roomkey-side' },
        h('span', { text: s.floor ? `Floor ${s.floor}` : '' }),
        h('span', { text: s.roomType || '' })));
  }

  function keyButton(s) {
    const key = h('button', { type: 'button', class: 'btn btn-primary key-btn', 'data-action': 'open-key' }, icon('key', 'icon'), 'Digital key');
    key.addEventListener('click', () => kit.openKey(s));
    return key;
  }

  function checkinCard(card) {
    const s = card.stay || {};
    return shell('checkin', { badge: 'key', kicker: s.hotel?.name, title: "You're checked in!", sub: `${formatRange(s.checkIn, s.checkOut)} · ${nights(s.nights)}`, status: s.early ? pill('Early', 'live') : pill('Checked in', 'ok') },
      roomKey(s),
      h('div', { class: 'kvs' },
        s.wifi ? row('Wi-Fi', `${s.wifi.ssid} / ${s.wifi.password}`, copyButton(s.wifi.password, 'Wi-Fi password')) : null,
        s.breakfast ? row('Breakfast', breakfastText(s.breakfast)) : null,
        row('Check-out', s.checkoutTime ? `${date(s.checkOut)} by ${wallTime(s.checkoutTime)}` : '')),
      h('div', { class: 'card-actions' }, keyButton(s)));
  }

  function serviceCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (t) => {
      const zone = zoneOf(t);
      const what = (t.items || []).map((x) => `${x.name}${x.qty > 1 ? ` ×${x.qty}` : ''}`).join(', ') || 'Room service';
      const doneAt = t.timeline?.find((x) => x.status === 'done')?.at || t.eta;
      el.replaceChildren(shell('service', {
        badge: 'box', kicker: t.roomNumber ? `To room ${t.roomNumber}` : 'Room service', title: what,
        sub: t.status === 'done' ? `Delivered at ${clockTime(doneAt, zone)}` : `Expected by ${clockTime(t.eta, zone)}`,
        status: statusPill('service', t.status), attrs: { 'data-id': t.id, 'data-status': t.status },
      }, steps(['Received', 'On the way', 'Delivered'], ['accepted', 'on_the_way', 'done'], t.status), t.note ? h('p', { class: 'card-text', text: t.note }) : null));
    };
    draw(card.ticket || {});
    if (card.ticket?.id) track(`service:${card.ticket.id}`, el, draw);
    return el;
  }

  function diningCard(card) {
    const r = card.reservation || {};
    const zone = zoneOf(r);
    const cost = r.included ? 'Included in your rate'
      : r.covered ? `${r.covered} included, others ${money(r.price)} each · charged to your room`
        : r.price ? `${money(r.price)} per person · charged to your room` : '';
    return shell('dining', { badge: 'dining', kicker: r.restaurant, title: `${r.kindLabel || 'Dining'} · ${clockTime(r.at, zone)}`, sub: [dayOf(r.at, zone), r.place].filter(Boolean).join(' · '), status: statusPill('dining', r.status || 'reserved') },
      h('div', { class: 'kvs' },
        row('Party', r.people ? plural(r.people, 'guest') : ''),
        row('Table', r.table || ''),
        row('Cost', cost)));
  }

  function wakeupCard(card) {
    const c = card.call || {};
    const zone = zoneOf(c);
    const [time, meridiem] = clockTime(c.at, zone).split(' ');
    return shell('wakeup', { badge: 'alarm', kicker: c.roomNumber ? `Room ${c.roomNumber}` : 'Wake-up call', title: 'Wake-up call', status: statusPill('wakeup', c.status) },
      h('div', { class: 'bigtime' },
        h('span', { class: 'bigtime-num' }, time || '', meridiem ? h('span', { class: 'bigtime-ampm', text: ` ${meridiem}` }) : null),
        h('span', { class: 'bigtime-sub', text: dayOf(c.at, zone) })));
  }

  function infoCard(card) {
    const i = card.info || {};
    const tel = i.frontDesk ? h('a', { class: 'mini-btn', href: `tel:${String(i.frontDesk).replace(/[^\d+]/g, '')}` }, icon('phone', 'icon icon-xs'), 'Call') : null;
    return shell('stay_info', { badge: 'wifi', kicker: i.hotel?.name, title: i.roomNumber ? `Room ${i.roomNumber} · Hotel info` : 'Hotel info', status: i.checkedIn ? pill('Checked in', 'ok') : pill('Not checked in', 'muted') },
      h('div', { class: 'kvs' },
        i.wifi ? row('Wi-Fi', `${i.wifi.ssid} / ${i.wifi.password}`, copyButton(i.wifi.password, 'Wi-Fi password')) : null,
        i.breakfast ? row('Breakfast', breakfastText(i.breakfast)) : null,
        row('Check-out', i.checkoutTime ? `by ${wallTime(i.checkoutTime)}` : ''),
        row('Front desk', i.frontDesk || '', tel)),
      (i.facilities || []).length ? h('div', { class: 'tags' }, i.facilities.map((f) => h('span', { class: 'tag', text: [f.name, wallTime(f.hours)].filter(Boolean).join(' ') }))) : null);
  }

  function extensionCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (x) => {
      const actions = h('div', { class: 'card-actions' });
      if (x.status === 'pending') {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'confirm-extension' }, `Confirm extension ${money(x.price)}`);
        btn.addEventListener('click', async () => {
          const result = await kit.pay({
            title: 'Extend your stay',
            amount: x.price,
            desc: [x.hotel?.name, `${plural(x.nights || 1, 'more night', 'more nights')}`, `Check-out ${date(x.toDate)}`].filter(Boolean).join(' · '),
            run: (method) => kit.api('POST', `/api/extensions/${encodeURIComponent(x.id)}/confirm`, { method }),
          });
          if (result?.extension) draw(result.extension);
          if (result) kit.onAction();
        });
        actions.append(btn);
      }
      el.replaceChildren(shell('extension_quote', {
        badge: 'calendar', kicker: x.hotel?.name, title: `Stay ${plural(x.nights || 1, 'more night', 'more nights')}`,
        sub: [x.room, formatRange(x.fromDate, x.toDate)].filter(Boolean).join(' · '),
        status: statusPill('extension', x.status), active: x.status === 'pending', attrs: { 'data-id': x.id, 'data-status': x.status },
      }, h('div', { class: 'card-total' }, h('span', { text: x.status === 'confirmed' ? 'Paid' : 'Total' }), h('span', { class: 'card-amount', text: money(x.price) })),
      actions.childElementCount ? actions : null));
    };
    draw(card.extension || {});
    if (card.extension?.id) track(`extension:${card.extension.id}`, el, draw);
    return el;
  }

  // ---- Leaving ----

  function billCard(card) {
    const b = card.bill || {};
    return shell('bill', { badge: 'receipt', kicker: b.hotel?.name, title: 'Your bill', sub: [b.roomNumber ? `Room ${b.roomNumber}` : '', formatRange(b.checkIn, b.checkOut), nights(b.nights)].filter(Boolean).join(' · '), status: pill('Checked out', 'ok') },
      h('dl', { class: 'bill-lines' }, (b.lines || []).map((l) => h('div', { class: 'bill-line' },
        h('dt', {}, h('span', { text: l.label }), l.note ? h('span', { class: 'bill-note', text: l.note }) : null),
        h('dd', { text: money(l.amount) })))),
      h('div', { class: 'card-total' }, h('span', { text: b.due > 0 ? `Paid at check-out${b.settledBy ? ` (${b.settledBy})` : ''}` : 'Nothing more to pay' }), h('span', { class: 'card-amount', text: money(b.due || 0) })),
      b.pointsEarned ? h('p', { class: 'points-earned' }, icon('sparkle', 'icon icon-xs'), h('span', { text: `You earned ${b.pointsEarned.toLocaleString('en-US')} points` })) : null);
  }

  function receiptCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (v) => {
      el.replaceChildren(shell('receipt', { badge: 'mail', kicker: 'Email receipt', title: 'Your receipt', status: statusPill('receipt', v.status), attrs: { 'data-id': v.id, 'data-status': v.status } },
        h('div', { class: 'kvs' }, row('Amount', money(v.amount)), row('Sent to', v.email || ''), v.sentAt ? row('Sent', dayTime(v.sentAt)) : null, row('Booking', v.orderId || ''))));
    };
    draw(card.receipt || {});
    if (card.receipt?.id) track(`receipt:${card.receipt.id}`, el, draw);
    return el;
  }

  const LEVELS = { Member: 'member', Gold: 'gold', Platinum: 'platinum' };

  function membershipCard(card) {
    const m = card.member || {};
    const points = m.points || 0;
    const total = points + (m.pointsToNext || 0);
    const pct = m.nextLevel && total ? Math.min(100, Math.round((points / total) * 100)) : 100;
    return shell('membership', { badge: 'crown', kicker: 'Nana Rewards', title: m.level || 'Member', status: pill(`${points.toLocaleString('en-US')} points`, 'ok') },
      h('div', { class: `level level-${LEVELS[m.level] || 'member'}` },
        h('span', { class: 'level-name', text: m.level || '' }),
        h('span', { class: 'level-points', text: points.toLocaleString('en-US') }),
        h('span', { class: 'level-bar' }, h('span', { class: 'level-fill', style: `width:${pct}%` })),
        h('span', { class: 'level-next', text: m.nextLevel ? `${(m.pointsToNext || 0).toLocaleString('en-US')} points to ${m.nextLevel}` : "You're at the top tier" })),
      (m.perks || []).length ? h('div', { class: 'tags' }, m.perks.map((p) => h('span', { class: 'tag', text: p }))) : null,
      (m.recent || []).length ? h('ul', { class: 'line-list' }, m.recent.slice(0, 4).map((r) => h('li', {},
        h('span', { class: 'line-main', text: r.label }),
        h('span', { class: 'line-end', text: `${r.points > 0 ? '+' : ''}${Number(r.points || 0).toLocaleString('en-US')}` })))) : null);
  }

  function stars(rating) {
    return h('span', { class: 'stars', role: 'img', 'aria-label': plural(rating, 'star') }, [1, 2, 3, 4, 5].map((n) => icon('star', `icon star${n <= rating ? ' is-on' : ''}`)));
  }

  function reviewCard(card) {
    const el = h('div', { class: 'card-slot' });
    const draw = (r) => {
      const actions = h('div', { class: 'card-actions' });
      if (r.status === 'draft') {
        const btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'publish-review' }, 'Publish review');
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
        actions.append(h('p', { class: 'card-note', text: 'Nothing is posted until you tap' }), btn);
      }
      el.replaceChildren(shell('review_draft', { badge: 'star', kicker: r.hotel?.name, title: r.status === 'published' ? 'Review published' : 'Review draft', status: statusPill('review', r.status), active: r.status === 'draft', attrs: { 'data-id': r.id, 'data-status': r.status } },
        stars(r.rating || 5),
        h('p', { class: 'card-text', text: r.text || '' }),
        r.reply?.text ? h('div', { class: 'card-reply' }, h('span', { class: 'card-reply-who', text: 'Reply from the hotel' }), h('span', { text: r.reply.text })) : null,
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
    ride_links: rideLinksCard,
    early_checkin: earlyCard,
    checkin: checkinCard,
    service: serviceCard,
    dining: diningCard,
    wakeup: wakeupCard,
    stay_info: infoCard,
    extension_quote: extensionCard,
    bill: billCard,
    receipt: receiptCard,
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
    receipt: (r) => ({ type: 'receipt', receipt: r }),
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
