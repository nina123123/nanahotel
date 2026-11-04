// 小宿商家版 — the hotel's console (docs/MERCHANT.md): 经营概览, 房态与入住, 住客服务工单, 点评与营销.
// Same server and data as the traveler side, so what a guest does in 小宿 shows up here and what the hotel does
// here reaches the guest. Guests appear masked (李*). Server data reaches the DOM only through textContent.
import { icon } from './icons.js';

const KEY_HOTEL = 'xiaosu.merchant.hotelId';
const POLL_MS = 15000;
const TABS = [
  { key: 'overview', label: '概览', icon: 'chart' },
  { key: 'rooms', label: '房态', icon: 'bed' },
  { key: 'tickets', label: '工单', icon: 'box' },
  { key: 'reviews', label: '点评营销', icon: 'star' },
];
const ROOM_STATES = {
  vacant: '空净', dirty: '空脏', occupied: '在住', arriving: '预抵', departing: '预离', ooo: '维修',
};
const ROOM_ORDER = ['vacant', 'dirty', 'occupied', 'arriving', 'departing', 'ooo'];
const TICKET_STATES = { new: '待处理', doing: '处理中', done: '已完成', declined: '已婉拒' };
const TICKET_KINDS = { service: '送物', early_checkin: '提前入住', wakeup: '叫醒', dining: '订餐' };
const ACTION_LABELS = { accept: '接单', deliver: '送达', done: '完成', approve: '同意', decline: '婉拒' };
const CHANNEL_ORDER = ['xiaosu', 'ctrip', 'meituan', 'fliggy', 'direct'];
const DISCOUNTS = [0.9, 0.85, 0.8, 0.7];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, String(value));
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

export const yuan = (n) => (Number.isFinite(n) ? `¥${Math.round(n).toLocaleString('zh-CN')}` : '—');
export const pct = (x, digits = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → '11月6日' (with the weekday when asked). */
export function dayLabel(ymd, withWeekday = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const wd = WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${+m[2]}月${+m[3]}日${withWeekday ? ` ${wd}` : ''}`;
}

/** '3分钟前', '2小时前', '11月1日'. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}小时前`;
  return dayLabel(new Date(t + 8 * 3600000).toISOString().slice(0, 10));
}

/** Add days to 'YYYY-MM-DD'. */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today in China time, 'YYYY-MM-DD'. */
export function todayCN(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

/** The hotel's business day: before 06:00 it is still last night (as for bookings made after midnight). */
export function businessDay(now = Date.now()) {
  const t = new Date(now + 8 * 3600000);
  if (t.getUTCHours() < 6) t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** 0.85 → '85折'; 0.9 → '9折'. */
export function zhe(discount) {
  const n = Math.round(discount * 100);
  return `${n % 10 ? n : n / 10}折`;
}

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* memory only */ } },
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', '网络好像断了，稍后再试。');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message || `请求失败（${res.status}）`);
  }
  return data || {};
}

const hotelPath = (rest = '') => `/api/merchant/${encodeURIComponent(state.hotelId)}${rest}`;

function toast(message) {
  const el = h('div', { class: 'toast', text: message });
  els.toasts.append(el);
  setTimeout(() => el.remove(), 2800);
}

const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

/** A button that runs an action once, with a spinner meanwhile. */
function actionButton(label, cls, run, attrs = {}) {
  const btn = h('button', { type: 'button', class: `m-btn ${cls}`, ...attrs }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.replaceChildren(spinner(), label);
    try {
      await run();
    } catch (err) {
      if (err.code !== 'empty') toast(err.message || '没办成，稍后再试。');
    } finally {
      // Still on screen (a draft filled in, a failure): ready for the next tap.
      if (btn.isConnected) {
        btn.disabled = false;
        btn.replaceChildren(label);
      }
    }
  });
  return btn;
}

function stars(rating, size = '') {
  return h('span', { class: `stars ${size}`, role: 'img', 'aria-label': `${rating} 星` },
    [1, 2, 3, 4, 5].map((n) => icon('star', `icon ${n <= Math.round(rating) ? 'is-on' : 'is-off'}`)));
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function openSheet(title) {
  const previous = document.activeElement;
  const body = h('div', { class: 'sheet-body' });
  const close = h('button', { type: 'button', class: 'sheet-close', 'aria-label': '关闭' }, icon('close'));
  const titleId = `sheet-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': titleId },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
      h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', id: titleId, text: title }), close),
      body));
  const ctl = { body, close: () => dialog.open && dialog.close() };
  close.addEventListener('click', ctl.close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) ctl.close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previous?.isConnected) previous.focus?.({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return ctl;
}

// ---------------------------------------------------------------------------
// Tooltip (hover and keyboard focus show the same thing)
// ---------------------------------------------------------------------------

function showTip(x, y, title, rows) {
  const tip = els.tip;
  tip.replaceChildren(h('b', { text: title }), ...rows.map(([k, v]) => h('div', { class: 'tip-row' }, h('span', { text: k }), h('span', { text: v }))));
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2));
  const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  els.tip.hidden = true;
}

/** Hover and focus on a chart's hit target show `describe(i)` → [title, rows]. */
function bindTip(el, describe) {
  const at = (e) => {
    const [title, rows] = describe();
    if (e.type === 'focus') {
      const r = el.getBoundingClientRect();
      showTip(r.left + r.width / 2, r.top, title, rows);
    } else showTip(e.clientX, e.clientY, title, rows);
  };
  el.addEventListener('pointermove', at);
  el.addEventListener('focus', at);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('blur', hideTip);
}

// ---------------------------------------------------------------------------
// Charts: inline SVG at the container's real width (text stays 11px), one axis each.
// ---------------------------------------------------------------------------

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((m) => m >= v);
}

const shortMoney = (v) => (v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}万` : `${Math.round(v)}`);

/** Bars over time; `future` bars are drawn quietly. Every bar is a hit target with a tooltip. */
function barChart(container, points, { value, label, describe, highlight }) {
  const W = Math.max(280, container.clientWidth || 600);
  const H = 180;
  const pad = { l: 40, r: 6, t: 14, b: 22 };
  const max = niceMax(Math.max(...points.map(value)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = iw / points.length;
  const bw = Math.max(3, Math.min(22, step - 2));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label },
    s('g', { class: 'grid' }, ticks.map((t) => s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }))),
    s('g', { class: 'axis' }, ticks.map((t) => {
      const text = s('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end' });
      text.textContent = shortMoney(t);
      return text;
    })));
  const every = Math.ceil(points.length / 6);
  points.forEach((p, i) => {
    const v = value(p);
    const x = pad.l + i * step + (step - bw) / 2;
    const top = y(v);
    // 4px rounded top, square at the baseline.
    const r = Math.min(4, bw / 2, (pad.t + ih - top) / 2);
    const d = `M${x},${pad.t + ih}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${pad.t + ih}Z`;
    svg.append(s('path', { class: `bar${highlight?.(p) ? ' is-xiaosu' : ''}`, d: v > 0 ? d : '' }));
    if (i % every === 0 || i === points.length - 1) {
      const t = s('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' });
      t.textContent = p.date.slice(5).replace('-', '/');
      svg.append(s('g', { class: 'axis' }, t));
    }
    const hit = s('rect', { class: 'hit', x: pad.l + i * step, y: pad.t, width: step, height: ih, tabindex: 0, 'aria-label': describe(p).flat(2).join(' ') });
    bindTip(hit, () => describe(p));
    svg.append(hit);
  });
  container.replaceChildren(svg);
}

/** A line (0–100%) with an optional dashed forecast and a threshold; the crosshair snaps to the nearest day. */
function lineChart(container, past, future, { value, threshold, label, describe }) {
  const W = Math.max(280, container.clientWidth || 600);
  const H = 170;
  const pad = { l: 40, r: 8, t: 14, b: 22 };
  const all = [...past, ...future];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i) => pad.l + (all.length < 2 ? iw / 2 : (i / (all.length - 1)) * iw);
  const y = (v) => pad.t + ih - Math.max(0, Math.min(1, v)) * ih;
  const path = (pts, offset) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i + offset).toFixed(1)},${y(value(p)).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1];
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label },
    s('defs', {}, s('linearGradient', { id: 'm-area', x1: 0, x2: 0, y1: 0, y2: 1 },
      s('stop', { offset: '0%', 'stop-color': '#f5b83d', 'stop-opacity': 0.28 }),
      s('stop', { offset: '100%', 'stop-color': '#f5b83d', 'stop-opacity': 0 }))),
    s('g', { class: 'grid' }, ticks.map((t) => s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }))),
    s('g', { class: 'axis' }, ticks.map((t) => {
      const text = s('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end' });
      text.textContent = pct(t);
      return text;
    })));
  if (past.length) {
    svg.append(s('path', { class: 'area', d: `${path(past, 0)}L${x(past.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }));
    svg.append(s('path', { class: 'line', d: path(past, 0) }));
  }
  if (future.length) {
    const joined = past.length ? [past[past.length - 1], ...future] : future;
    svg.append(s('path', { class: 'line is-forecast', d: path(joined, past.length ? past.length - 1 : 0) }));
  }
  if (threshold) {
    svg.append(s('line', { class: 'threshold', x1: pad.l, x2: W - pad.r, y1: y(threshold.value), y2: y(threshold.value) }));
    const t = s('text', { class: 'threshold-label', x: W - pad.r, y: y(threshold.value) - 5, 'text-anchor': 'end' });
    t.textContent = threshold.label;
    svg.append(t);
  }
  const every = Math.ceil(all.length / 6);
  all.forEach((p, i) => {
    if (i % every && i !== all.length - 1) return;
    const t = s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' });
    t.textContent = p.date.slice(5).replace('-', '/');
    svg.append(s('g', { class: 'axis' }, t));
  });
  const cross = s('line', { class: 'cross', y1: pad.t, y2: pad.t + ih, visibility: 'hidden' });
  const dot = s('circle', { class: 'dot', r: 4, visibility: 'hidden' });
  svg.append(cross, dot);
  const nearest = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    return Math.max(0, Math.min(all.length - 1, Math.round(((px - pad.l) / iw) * (all.length - 1))));
  };
  const point = (i) => {
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(value(all[i])));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
  };
  const hit = s('rect', { class: 'hit', x: pad.l - 8, y: pad.t, width: iw + 16, height: ih, tabindex: 0, 'aria-label': `${label}，用左右方向键查看每一天` });
  let focusIndex = past.length ? past.length - 1 : 0;
  const show = (i, cx, cy) => {
    point(i);
    const [title, rows] = describe(all[i], i >= past.length);
    showTip(cx, cy, title, rows);
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  const showFocused = () => {
    const box = svg.getBoundingClientRect();
    show(focusIndex, box.left + (x(focusIndex) / W) * box.width, box.top + (y(value(all[focusIndex])) / H) * box.height);
  };
  hit.addEventListener('focus', showFocused);
  hit.addEventListener('blur', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    focusIndex = Math.max(0, Math.min(all.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
    showFocused();
  });
  svg.append(hit);
  container.replaceChildren(svg);
}

/** The data behind a chart as a table, folded away (tooltips enhance, they never gate). */
function dataTable(caption, head, rows) {
  return h('details', { class: 'chart-table' },
    h('summary', { class: 'panel-note', text: '查看数据' }),
    h('table', { class: 'm-table' },
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { text: c })))))));
}

// Charts are drawn at their container's width, so they are redrawn when it changes.
const charts = new Set();
function chartSlot(draw) {
  const el = h('div', { class: 'chart' });
  let lastWidth = 0;
  const redraw = () => {
    const w = el.clientWidth;
    if (!w || w === lastWidth) return;
    lastWidth = w;
    draw(el);
  };
  charts.add(redraw);
  requestAnimationFrame(redraw);
  return el;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  hotels: [],
  hotelId: null,
  tab: 'overview',
  days: 30,
  roomDate: null,
  roomFilter: null,
  ticketFilter: null,
  data: {},
  tickets: null,
  timer: 0,
  seq: 0,
};

let els = {};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function deltaChip(change) {
  if (!Number.isFinite(change)) return null;
  const flat = Math.abs(change) < 0.005;
  const cls = flat ? 'delta-flat' : change > 0 ? 'delta-up' : 'delta-down';
  return h('span', { class: `delta ${cls}` }, flat ? '' : icon(change > 0 ? 'up' : 'down2', 'icon icon-xs'), `${change > 0 ? '+' : ''}${pct(change)}`);
}

function renderOverview(d) {
  const k = d.kpis || {};
  const series = (d.series || []).slice(-state.days);
  const range = h('div', { class: 'chart-toggle', role: 'group', 'aria-label': '时间范围' },
    [7, 30].map((n) => h('button', { type: 'button', 'aria-pressed': String(state.days === n), onclick: () => { state.days = n; render(); } }, `近${n}天`)));

  const kpis = h('div', { class: 'kpis' },
    h('div', { class: 'panel kpi kpi-hero' },
      h('span', { class: 'kpi-label', text: '今晚入住率' }),
      h('span', { class: 'kpi-value', text: pct(k.occupancy) }),
      h('span', { class: 'kpi-foot' }, deltaChip(k.vsLastWeek?.occupancy), '比上周同日'),
      h('div', { class: 'stat-row' },
        [['预抵', k.arrivals], ['预离', k.departures], ['在住', k.inHouse]].map(([label, n]) => h('div', { class: 'stat' },
          h('span', { class: 'stat-k', text: label }), h('span', { class: 'stat-v', text: n ?? '—' }))))),
    h('div', { class: 'panel kpi' },
      h('span', { class: 'kpi-label', text: '今日营收' }),
      h('span', { class: 'kpi-value', text: yuan(k.revenue) }),
      h('span', { class: 'kpi-foot' }, deltaChip(k.vsLastWeek?.revenue), '比上周同日')),
    h('div', { class: 'panel kpi' },
      h('span', { class: 'kpi-label', text: '平均房价 ADR' }),
      h('span', { class: 'kpi-value', text: yuan(k.adr) }),
      h('span', { class: 'kpi-foot', text: `RevPAR ${yuan(k.revpar)}` })),
    h('div', { class: 'panel kpi' },
      h('span', { class: 'kpi-label', text: '评分' }),
      h('span', { class: 'kpi-value', text: Number.isFinite(k.rating) ? k.rating.toFixed(1) : '—' }),
      h('span', { class: 'kpi-foot', text: `${k.reviewCount ?? 0} 条点评` })),
    h('button', { type: 'button', class: 'panel kpi kpi-link', onclick: () => go('tickets') },
      h('span', { class: 'kpi-label', text: '工单进行中' }),
      h('span', { class: 'kpi-value', text: String(k.openTickets ?? 0) }),
      h('span', { class: 'kpi-foot' }, '去处理', icon('chevron', 'icon icon-xs'))));

  const insights = (d.insights || []).length ? h('section', { class: 'panel' },
    h('p', { class: 'panel-title', text: '小宿经营建议' }),
    h('div', { class: 'insights' }, d.insights.map((it) => h('div', { class: `insight insight-${it.level || 'tip'}` },
      h('span', { class: 'insight-mark', 'aria-hidden': 'true' }, icon(it.level === 'warn' ? 'alert' : it.level === 'good' ? 'check' : 'sparkle', 'icon icon-xs')),
      h('div', {},
        h('p', { class: 'insight-title', text: it.title }),
        h('p', { class: 'insight-text', text: it.text }),
        it.action ? h('button', { type: 'button', class: 'm-btn m-btn-quiet insight-act', onclick: () => go(it.action.tab) }, it.action.label, icon('chevron', 'icon icon-xs')) : null))))) : null;

  const revenue = h('section', { class: 'panel' },
    h('p', { class: 'panel-title', text: '每日营收' }),
    h('p', { class: 'panel-note', text: '亮色柱是有小宿订单的日子' }),
    chartSlot((el) => barChart(el, series, {
      value: (p) => p.revenue,
      label: `近${state.days}天每日营收`,
      highlight: (p) => p.xiaosu > 0,
      describe: (p) => [dayLabel(p.date, true), [['营收', yuan(p.revenue)], ['入住率', pct(p.occupancy)], ['平均房价', yuan(p.adr)], ['小宿间夜', String(p.xiaosu || 0)]]],
    })),
    dataTable('每日营收', ['日期', '营收', '入住率', '小宿间夜'], series.map((p) => [dayLabel(p.date), yuan(p.revenue), pct(p.occupancy), String(p.xiaosu || 0)])));

  const forecast = d.forecast || [];
  const occupancy = h('section', { class: 'panel' },
    h('p', { class: 'panel-title', text: '入住率' }),
    h('p', { class: 'panel-note', text: `实线是近${state.days}天，虚线是未来 14 天预测（已订 + 预计）` }),
    chartSlot((el) => lineChart(el, series, forecast, {
      value: (p) => p.occupancy,
      threshold: { value: 0.9, label: '满房预警 90%' },
      label: '入住率走势和预测',
      describe: (p, isForecast) => [dayLabel(p.date, true), [[isForecast ? '预测入住率' : '入住率', pct(p.occupancy)]]],
    })),
    dataTable('未来 14 天预测入住率', ['日期', '预测入住率'], forecast.map((p) => [dayLabel(p.date, true), pct(p.occupancy)])));

  const channels = [...(d.channels || [])].sort((a, b) => CHANNEL_ORDER.indexOf(a.key) - CHANNEL_ORDER.indexOf(b.key));
  const stack = h('div', { class: 'stack', role: 'img', 'aria-label': channels.map((c) => `${c.label} ${pct(c.share)}`).join('，') },
    channels.map((c) => {
      const seg = h('span', { class: `ch-${c.key}`, style: `flex:${Math.max(c.share, 0.01)}`, tabindex: 0, 'aria-label': `${c.label} ${pct(c.share)}` });
      bindTip(seg, () => [c.label, [['占比', pct(c.share)], ['间夜', String(c.nights ?? '—')]]]);
      return seg;
    }));
  const channelPanel = h('section', { class: 'panel' },
    h('p', { class: 'panel-title', text: '订单来源' }),
    h('p', { class: 'panel-note', text: `近${state.days}天间夜占比` }),
    stack,
    h('div', { class: 'legend' }, channels.map((c) => h('span', { class: 'legend-item' },
      h('span', { class: `swatch ch-${c.key}`, 'aria-hidden': 'true' }), h('span', { text: `${c.label} ${pct(c.share)}` })))));

  const arrivals = h('section', { class: 'panel' },
    h('p', { class: 'panel-title', text: '今日预抵' }),
    (d.arrivals || []).length ? h('ul', { class: 'rows' }, d.arrivals.slice(0, 8).map((a) => h('li', {},
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title', text: `${a.guest} · ${a.roomType || ''}` }),
        h('span', { class: 'row-sub', text: [`${a.nights || 1}晚`, a.eta ? `预计 ${a.eta} 到` : ''].filter(Boolean).join(' · ') })),
      a.source === 'xiaosu' ? h('span', { class: 'chip chip-xiaosu', text: '小宿' }) : null,
      h('span', { class: `chip ${a.status === 'checked_in' ? 'chip-ok' : 'chip-info'}`, text: a.status === 'checked_in' ? '已入住' : '待入住' }))))
      : h('p', { class: 'empty', text: '今天没有预抵' }));

  return [
    h('div', { class: 'm-section-head' }, h('div', {}, h('h2', { class: 'm-h2', text: '经营概览' }), h('p', { class: 'm-sub', text: dayLabel(d.date, true) })), range),
    kpis,
    insights ? h('div', { style: 'height:12px' }) : null,
    insights,
    h('div', { class: 'm-grid m-grid-2', style: 'margin-top:12px' }, revenue, occupancy, channelPanel, arrivals),
  ];
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function renderRooms(d) {
  const today = state.roomDate || d.date;
  const dates = [0, 1, 2].map((n) => addDays(businessDay(), n));
  const dateSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '日期' }, dates.map((date, i) => h('button', {
    type: 'button', 'aria-pressed': String(date === today), onclick: () => { state.roomDate = date; load(); },
  }, ['今天', '明天', '后天'][i], h('span', { class: 'count', text: dayLabel(date) }))));
  const counts = d.counts || {};
  const legend = h('div', { class: 'room-legend', role: 'group', 'aria-label': '按状态筛选' }, ROOM_ORDER.map((st) => h('button', {
    type: 'button', class: `st-${st}`, 'aria-pressed': String(state.roomFilter === st),
    onclick: () => { state.roomFilter = state.roomFilter === st ? null : st; render(); },
  }, h('span', { class: 'st-dot', 'aria-hidden': 'true' }), ROOM_STATES[st], h('span', { class: 'count', text: counts[st] ?? 0 }))));
  const floors = (d.floors || []).map((f) => {
    const occupied = f.rooms.filter((r) => ['occupied', 'departing'].includes(r.status)).length;
    return h('section', { class: 'floor' },
      h('div', { class: 'floor-head' }, h('span', { class: 'floor-name', text: `${f.floor} 层` }), h('span', { class: 'floor-meta', text: `${occupied}/${f.rooms.length} 在住` })),
      h('div', { class: 'room-grid' }, f.rooms.map((r) => {
        const dim = state.roomFilter && r.status !== state.roomFilter;
        return h('button', {
          type: 'button',
          class: `room st-${r.status}${r.guest?.source === 'xiaosu' ? ' is-xiaosu' : ''}${dim ? ' is-dim' : ''}`,
          'aria-label': `${r.number} 房，${ROOM_STATES[r.status] || r.status}${r.guest ? `，${r.guest.name}` : ''}${r.tickets ? `，${r.tickets} 张工单` : ''}`,
          onclick: () => openRoom(r, today),
        },
        r.tickets ? h('span', { class: 'room-dot', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'room-no', text: r.number }),
        h('span', { class: 'room-st', text: ROOM_STATES[r.status] || '' }),
        r.guest ? h('span', { class: 'room-guest', text: r.guest.name }) : null);
      })));
  });
  return [
    h('div', { class: 'm-section-head' }, h('div', {}, h('h2', { class: 'm-h2', text: '房态与入住' }), h('p', { class: 'm-sub', text: `${dayLabel(today, true)} · 金色边框是小宿的客人` }))),
    h('div', { class: 'panel' }, dateSeg, h('div', { style: 'height:10px' }), legend),
    floors.length ? floors : h('p', { class: 'empty', text: '没有房间数据' }),
  ];
}

function openRoom(room, date) {
  const ctl = openSheet(`${room.number} 房`);
  const g = room.guest;
  const st = room.status;
  ctl.body.append(
    h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '房型' }), h('span', { text: room.roomType || '—' })),
    h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '状态' }), h('span', {}, h('span', { class: `chip st-${st}` }, h('span', { class: 'st-dot', 'aria-hidden': 'true' }), ROOM_STATES[st] || st))),
    g ? h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '客人' }), h('span', {}, g.name, ' ', g.source === 'xiaosu' ? h('span', { class: 'chip chip-xiaosu', text: '小宿' }) : null)) : null,
    g ? h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '日期' }), h('span', { text: `${dayLabel(g.checkIn)} – ${dayLabel(g.checkOut)}` })) : null,
    room.tickets ? h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '工单' }), h('span', { text: `${room.tickets} 张进行中` })) : null);
  const acts = h('div', { class: 'sheet-acts' });
  const act = (label, cls, body, done) => acts.append(actionButton(label, `${cls} m-btn-block`, async () => {
    await api('POST', hotelPath(`/rooms/${encodeURIComponent(room.number)}`), body);
    ctl.close();
    toast(done);
    load();
  }, { 'data-action': `room-${body.action}` }));
  if (st === 'arriving' && g?.source === 'xiaosu' && g.orderId && date === businessDay()) act('办理入住', 'm-btn-gold', { action: 'check_in', orderId: g.orderId }, `${room.number} 房已入住，客人那边也收到了`);
  if (st === 'dirty') act('标记已打扫', 'm-btn-gold', { action: 'clean' }, `${room.number} 房已打扫`);
  if (st === 'vacant') act('设为维修', 'm-btn-ghost', { action: 'ooo' }, `${room.number} 房设为维修`);
  if (st === 'ooo') act('恢复可售', 'm-btn-gold', { action: 'release' }, `${room.number} 房恢复可售`);
  if (acts.childElementCount) ctl.body.append(acts);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function renderTickets(d) {
  const tickets = d.tickets || [];
  const counts = { new: 0, doing: 0, done: 0 };
  for (const t of tickets) if (t.status in counts) counts[t.status] += 1;
  const filter = state.ticketFilter || (counts.new ? 'new' : counts.doing ? 'doing' : 'new');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '工单状态' }, ['new', 'doing', 'done'].map((st) => h('button', {
    type: 'button', 'aria-pressed': String(filter === st), onclick: () => { state.ticketFilter = st; render(); },
  }, TICKET_STATES[st], h('span', { class: 'count', text: counts[st] }))));
  const shown = tickets.filter((t) => (filter === 'done' ? ['done', 'declined'].includes(t.status) : t.status === filter));
  const now = Date.now();
  const list = shown.map((t) => {
    const waited = Math.round((now - Date.parse(t.createdAt)) / 60000);
    return h('article', { class: `panel ticket${t.status === 'new' ? ' is-new' : ''}`, 'data-ticket': t.id, 'data-status': t.status },
      h('div', { class: 'ticket-room' }, h('b', { text: t.roomNumber || '—' }), h('small', { text: '房' })),
      h('div', {},
        h('div', { class: 'ticket-top' },
          h('span', { class: 'ticket-title', text: t.title }),
          h('span', { class: 'chip', text: TICKET_KINDS[t.kind] || t.kind }),
          t.source === 'xiaosu' ? h('span', { class: 'chip chip-xiaosu', text: '小宿' }) : h('span', { class: 'chip', text: '前台电话' })),
        h('p', { class: 'ticket-meta' },
          `${t.guest || ''} · ${ago(t.createdAt)}`,
          t.status === 'new' && waited >= 10 ? h('span', { class: 'wait-long', text: ` · 已等 ${waited} 分钟` }) : null,
          t.dueAt ? ` · ${new Date(t.dueAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })}` : ''),
        t.note ? h('p', { class: 'ticket-note', text: t.note }) : null,
        (t.actions || []).length ? h('div', { class: 'ticket-acts' }, t.actions.map((a, i) => actionButton(ACTION_LABELS[a] || a, i === 0 ? 'm-btn-gold' : 'm-btn-ghost', async () => {
          const res = await api('POST', hotelPath(`/tickets/${encodeURIComponent(t.id)}`), { action: a });
          toast(`${t.roomNumber || ''} ${ACTION_LABELS[a] || ''}${t.source === 'xiaosu' ? '，客人那边已更新' : ''}`);
          if (res.ticket) state.ticketFilter = res.ticket.status === 'done' || res.ticket.status === 'declined' ? filter : res.ticket.status;
          load();
        }, { 'data-action': `ticket-${a}` }))) : null));
  });
  return [
    h('div', { class: 'm-section-head' }, h('div', {}, h('h2', { class: 'm-h2', text: '住客服务工单' }), h('p', { class: 'm-sub', text: '小宿客人的请求会实时出现在这里' }))),
    seg,
    h('div', { class: 'tickets', style: 'margin-top:12px' }, list.length ? list : h('p', { class: 'empty', text: filter === 'new' ? '没有待处理的工单，喝口茶吧' : '这里是空的' })),
  ];
}

// ---------------------------------------------------------------------------
// Reviews and promotions
// ---------------------------------------------------------------------------

function renderReviews({ reviews: r, promotions: p }) {
  const sum = r.summary || {};
  const total = sum.count || 0;
  const summary = h('section', { class: 'panel' },
    h('div', { class: 'rating-big' }, h('span', { class: 'rating-num', text: Number.isFinite(sum.rating) ? sum.rating.toFixed(1) : '—' }), stars(sum.rating || 0), h('span', { class: 'panel-note', text: `${total} 条点评` })),
    h('div', { class: 'dist' }, [5, 4, 3, 2, 1].map((n) => {
      const c = sum.distribution?.[n] || 0;
      return h('div', { class: 'dist-row' }, h('span', { text: `${n} 星` }),
        h('span', { class: 'dist-track' }, h('span', { class: 'dist-fill', style: `width:${total ? (c / total) * 100 : 0}%` })),
        h('span', { class: 'num', text: String(c) }));
    })),
    (sum.tags || []).length ? h('div', { class: 'tags' }, sum.tags.slice(0, 8).map((t) => h('span', { class: 'chip', text: `${t.tag} ${t.count}` }))) : null);

  const list = (r.reviews || []).map((rv) => {
    const box = h('div', { class: 'review-slot' });
    const drawReply = () => {
      if (rv.reply) {
        box.replaceChildren(h('div', { class: 'review-reply' }, h('b', { text: '酒店回复：' }), rv.reply.text));
        return;
      }
      const open = h('button', { type: 'button', class: 'm-btn m-btn-quiet', 'data-action': 'open-reply' }, '回复');
      open.addEventListener('click', () => {
        const input = h('textarea', { maxlength: 300, 'aria-label': '回复内容', placeholder: '写点什么，客人会看到' });
        const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
        box.replaceChildren(h('div', { class: 'reply-box' }, input, err, h('div', { class: 'reply-acts' },
          actionButton('小宿帮我写', 'm-btn-ghost', async () => {
            const data = await api('POST', hotelPath(`/reviews/${encodeURIComponent(rv.id)}/draft-reply`), {});
            input.value = data.text || '';
            input.focus();
          }, { 'data-action': 'draft-reply' }),
          actionButton('发布回复', 'm-btn-gold', async () => {
            const text = input.value.trim();
            if (!text) {
              err.textContent = '先写点内容';
              err.hidden = false;
              throw new ApiError(0, 'empty', '先写点内容');
            }
            const data = await api('POST', hotelPath(`/reviews/${encodeURIComponent(rv.id)}/reply`), { text });
            rv.reply = data.review?.reply || { text };
            toast(rv.source === 'xiaosu' ? '已回复，客人在小宿里能看到' : '已回复');
            drawReply();
          }, { 'data-action': 'send-reply' }))));
        input.focus();
      });
      box.replaceChildren(open);
    };
    drawReply();
    return h('article', { class: 'panel review', 'data-review': rv.id },
      h('div', { class: 'review-top' },
        h('span', { class: 'review-who', text: rv.guest || '客人' }), stars(rv.rating),
        rv.source === 'xiaosu' ? h('span', { class: 'chip chip-xiaosu', text: '小宿' }) : null,
        h('span', { class: 'review-when', text: [rv.roomType, ago(rv.at)].filter(Boolean).join(' · ') })),
      h('p', { class: 'review-text', text: rv.text }),
      (rv.tags || []).length ? h('div', { class: 'tags' }, rv.tags.map((t) => h('span', { class: 'chip', text: t }))) : null,
      box);
  });

  const promos = (p.promotions || []).map((pr) => {
    const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(Boolean(pr.active)), 'aria-label': `${pr.title} ${pr.active ? '已开启' : '已关闭'}`, 'data-action': 'toggle-promo' });
    sw.addEventListener('click', async () => {
      sw.disabled = true;
      try {
        await api('POST', hotelPath(`/promotions/${encodeURIComponent(pr.id)}`), { active: !pr.active });
        toast(!pr.active ? '特惠已开启，旅客搜索时就能看到' : '特惠已关闭');
        load();
      } catch (err) {
        toast(err.message);
        sw.disabled = false;
      }
    });
    return h('div', { class: 'panel promo', 'data-promo': pr.id },
      h('div', {},
        h('span', { class: 'promo-off', text: zhe(pr.discount) }), ' ',
        h('span', { class: 'promo-title', text: pr.title }),
        h('p', { class: 'promo-meta', text: `${dayLabel(pr.from)} – ${dayLabel(pr.to)} · 浏览 ${pr.stats?.views ?? 0} · 成交 ${pr.stats?.orders ?? 0} 单` })),
      sw);
  });

  return [
    h('div', { class: 'm-section-head' }, h('div', {}, h('h2', { class: 'm-h2', text: '点评' }), h('p', { class: 'm-sub', text: '小宿客人的点评会带「小宿」标记，回复他们能看到' }))),
    h('div', { class: 'm-grid' }, summary, list.length ? list : h('p', { class: 'empty', text: '还没有点评' })),
    h('div', { class: 'm-section-head' },
      h('div', {}, h('h2', { class: 'm-h2', text: '营销 · 特惠' }), h('p', { class: 'm-sub', text: '开启后，小宿里搜到这家酒店会显示特惠价' })),
      h('button', { type: 'button', class: 'm-btn m-btn-gold', 'data-action': 'new-promo', onclick: openPromoForm }, icon('tag', 'icon icon-xs'), '新建特惠')),
    h('div', { class: 'm-grid' }, promos.length ? promos : h('p', { class: 'empty', text: '还没有特惠活动' })),
  ];
}

function openPromoForm() {
  const ctl = openSheet('新建特惠');
  const today = businessDay();
  const presets = [
    ['今晚', today, today],
    ['本周末', ...weekend(today)],
    ['未来 7 天', today, addDays(today, 6)],
    ['未来 30 天', today, addDays(today, 29)],
  ];
  let discount = 0.85;
  let [, from, to] = presets[2];
  const title = h('input', { class: 'm-input', id: 'promo-title', maxlength: 12, value: '限时特惠' });
  const discSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '折扣' });
  const drawDisc = () => discSeg.replaceChildren(...DISCOUNTS.map((dv) => h('button', {
    type: 'button', 'aria-pressed': String(dv === discount), onclick: () => { discount = dv; drawDisc(); },
  }, zhe(dv))));
  drawDisc();
  const dateSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '日期' });
  const drawDates = () => dateSeg.replaceChildren(...presets.map(([label, f, t]) => h('button', {
    type: 'button', 'aria-pressed': String(f === from && t === to), onclick: () => { from = f; to = t; drawDates(); },
  }, label, h('span', { class: 'count', text: f === t ? dayLabel(f) : `${dayLabel(f)}–${dayLabel(t)}` }))));
  drawDates();
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  ctl.body.append(h('div', { class: 'form-grid' },
    h('div', {}, h('label', { class: 'field-label', for: 'promo-title', text: '活动名称' }), title),
    h('div', {}, h('span', { class: 'field-label', text: '折扣' }), discSeg),
    h('div', {}, h('span', { class: 'field-label', text: '入住日期' }), dateSeg),
    h('p', { class: 'panel-note', text: '按每晚房价打折，搜索结果、房型价格和新订单都用特惠价；已经下的订单不变。' }),
    err,
    actionButton('开启特惠', 'm-btn-gold m-btn-block', async () => {
      try {
        await api('POST', hotelPath('/promotions'), { title: title.value.trim() || '限时特惠', discount, from, to });
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        throw e;
      }
      ctl.close();
      toast('特惠已开启，旅客搜索时就能看到');
      load();
    }, { 'data-action': 'create-promo' })));
}

/** This weekend's Friday and Sunday nights (or the rest of it, if it has started). */
function weekend(today) {
  const [y, m, d] = today.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const fri = wd === 6 ? addDays(today, -1) : wd === 0 ? addDays(today, -2) : addDays(today, 5 - wd);
  const start = fri < today ? today : fri;
  return [start, addDays(fri, 1)];
}

// ---------------------------------------------------------------------------
// Hotels
// ---------------------------------------------------------------------------

function openHotels() {
  const ctl = openSheet('切换酒店');
  ctl.body.append(h('ul', { class: 'rows' }, state.hotels.map((ht) => h('li', {},
    h('button', {
      type: 'button', class: 'row-main', style: 'text-align:left', 'data-hotel': ht.id,
      onclick: () => { ctl.close(); selectHotel(ht.id); },
    },
    h('span', { class: 'row-title', text: ht.name }),
    h('span', { class: 'row-sub', text: [ht.city, `${ht.rooms} 间房`].filter(Boolean).join(' · ') })),
    ht.hasGuests ? h('span', { class: 'chip chip-xiaosu', text: '有小宿客人' }) : null,
    ht.id === state.hotelId ? icon('check', 'icon') : null))));
}

function selectHotel(id) {
  state.hotelId = id;
  storage.set(KEY_HOTEL, id);
  state.data = {};
  state.roomDate = null;
  state.roomFilter = null;
  state.ticketFilter = null;
  const hotel = state.hotels.find((x) => x.id === id);
  els.hotelName.textContent = hotel?.name || id;
  document.title = `${hotel?.name || '小宿商家版'} · 小宿商家版`;
  load();
}

// ---------------------------------------------------------------------------
// Loading, tabs, polling
// ---------------------------------------------------------------------------

async function fetchTab(tab) {
  if (tab === 'overview') return api('GET', hotelPath('/overview?days=30'));
  if (tab === 'rooms') return api('GET', hotelPath(`/rooms?date=${state.roomDate || businessDay()}`));
  if (tab === 'tickets') return api('GET', hotelPath('/tickets'));
  const [reviews, promotions] = await Promise.all([api('GET', hotelPath('/reviews')), api('GET', hotelPath('/promotions'))]);
  return { reviews, promotions };
}

async function load({ quiet = false } = {}) {
  clearTimeout(state.timer);
  if (!state.hotelId) return;
  const seq = ++state.seq;
  const tab = state.tab;
  if (!quiet && state.data[tab]) els.main.style.opacity = '0.6';
  else if (!state.data[tab]) els.main.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'margin-top:12px' }));
  try {
    // The tickets tab badge stays current whichever tab is open.
    const [data, tickets] = await Promise.all([fetchTab(tab), tab === 'tickets' ? null : api('GET', hotelPath('/tickets')).catch(() => null)]);
    if (seq !== state.seq) return;
    state.data[tab] = data;
    state.tickets = tab === 'tickets' ? data : tickets || state.tickets;
    render();
  } catch (err) {
    if (seq !== state.seq) return;
    if (!state.data[tab]) els.main.replaceChildren(h('div', { class: 'error-panel', role: 'alert', text: err.message }));
    else toast(err.message);
  } finally {
    if (seq === state.seq) {
      els.main.style.opacity = '';
      schedule();
    }
  }
}

/** While something is moving (open tickets, guests arriving today), look again every POLL_MS. */
function schedule() {
  clearTimeout(state.timer);
  if (document.hidden || state.tab === 'reviews') return;
  const open = (state.tickets?.tickets || []).some((t) => t.status === 'new' || t.status === 'doing');
  const arriving = (state.data.overview?.kpis?.arrivals || 0) > 0;
  if (open || arriving) state.timer = setTimeout(() => load({ quiet: true }), POLL_MS);
}

function render() {
  hideTip();
  charts.clear();
  const data = state.data[state.tab];
  renderTabs();
  if (!data) return;
  const view = { overview: renderOverview, rooms: renderRooms, tickets: renderTickets, reviews: renderReviews }[state.tab](data);
  els.main.replaceChildren(...view.flat().filter(Boolean));
}

function renderTabs() {
  const pending = (state.tickets?.tickets || []).filter((t) => t.status === 'new').length;
  els.tabs.replaceChildren(...TABS.map((t) => h('button', {
    type: 'button', class: 'm-tab', 'data-tab': t.key, 'aria-current': t.key === state.tab ? 'page' : null, onclick: () => go(t.key),
  }, icon(t.icon), h('span', { text: t.label }), t.key === 'tickets' && pending ? h('span', { class: 'm-tab-badge', text: pending, 'aria-label': `${pending} 张待处理` }) : null)));
}

function go(tab) {
  if (!TABS.some((t) => t.key === tab)) return;
  state.tab = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo({ top: 0 });
  load();
}

async function boot() {
  els = {
    main: document.getElementById('m-main'),
    tabs: document.getElementById('m-tabs'),
    hotelName: document.getElementById('m-hotel-name'),
    tip: document.getElementById('m-tip'),
    toasts: document.getElementById('toasts'),
  };
  const hash = location.hash.slice(1);
  if (TABS.some((t) => t.key === hash)) state.tab = hash;
  renderTabs();
  document.getElementById('m-hotel').addEventListener('click', openHotels);
  // Back to the traveler side: the same app page without ?view=merchant in the phone apps, the site root on a server.
  if (new URLSearchParams(location.search).get('view') === 'merchant') document.getElementById('m-to-guest').href = location.pathname;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ quiet: true }); });
  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { for (const redraw of charts) redraw(); });
    }).observe(els.main);
  }
  try {
    const data = await api('GET', '/api/merchant/hotels');
    state.hotels = Array.isArray(data.hotels) ? data.hotels : [];
    const saved = storage.get(KEY_HOTEL);
    selectHotel(state.hotels.some((x) => x.id === saved) ? saved : data.current || state.hotels[0]?.id);
  } catch (err) {
    els.hotelName.textContent = '小宿商家版';
    els.main.replaceChildren(h('div', { class: 'error-panel', role: 'alert', text: err.message }));
  }
}

if (typeof document !== 'undefined' && document.getElementById('m-app')) boot();
