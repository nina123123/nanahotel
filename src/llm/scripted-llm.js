import { todayCN, addDays, isValidDate, weekdayCN, dayOfWeek, nightsBetween } from '../util/dates.js';

/**
 * Deterministic fake LLM implementing the llm/client.js chat() contract, for agent/server/e2e tests and
 * the no-key demo.
 *
 *   const llm = createScriptedLlm((messages, tools) => ({ content: '你好', toolCalls: [{ name, arguments }] }));
 *   const llm = createScriptedLlm([{ toolCalls: [...] }, { content: '...' }]);  // one entry per chat() call
 *
 * A step may be an object { content?, toolCalls?, reasoningContent?, error?, errorAfterText? }, an Error
 * (thrown), or a function (messages, tools) → step. Text is streamed through onTextDelta in small chunks.
 * `llm.calls` records { messages, tools } of every chat() call.
 */
export function createScriptedLlm(script, { chunkSize = 4, delayMs = 0 } = {}) {
  const queue = Array.isArray(script) ? [...script] : null;
  const calls = [];
  let n = 0;

  async function chat({ messages = [], tools = [], signal, onTextDelta } = {}) {
    const callNo = ++n;
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    if (signal?.aborted) throw abortError(signal);
    let step;
    if (queue) {
      if (!queue.length) throw new Error(`scripted-llm: no scripted response left for call #${callNo}`);
      step = queue.shift();
    } else {
      step = script;
    }
    if (typeof step === 'function') step = await step(messages, tools);
    if (step instanceof Error) throw step;
    step = step || {};
    if (step.error) throw step.error;

    const content = typeof step.content === 'string' ? step.content : '';
    const chars = Array.from(content);
    for (let i = 0; i < chars.length; i += chunkSize) {
      if (delayMs) await sleep(delayMs, signal);
      if (signal?.aborted) throw abortError(signal);
      onTextDelta?.(chars.slice(i, i + chunkSize).join(''));
    }
    if (step.errorAfterText) throw step.errorAfterText;

    const toolCalls = (step.toolCalls || []).map((c, i) => ({
      id: c.id || `call_scripted_${callNo}_${i}`,
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
      ...(c.invalidArguments ? { invalidArguments: true } : {}),
    }));
    const out = { content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: null };
    if (step.reasoningContent) out.reasoningContent = step.reasoningContent;
    return out;
  }

  return { chat, calls, provider: 'scripted', model: 'scripted-demo' };
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError(signal));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// demoScript: a tiny rule-based "model" for the e2e smoke test and the no-key demo
// ---------------------------------------------------------------------------

const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '西安', '南京', '苏州', '厦门', '三亚', '青岛', '长沙', '武汉', '丽江'];
const NOTICE_PREFIX = '【系统通知，非用户输入】';
const DEMO_GUEST = '李明';
const DEMO_PHONE = '13800000000';
const CN_NUM = { 一: 1, 两: 2, 二: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const NEAR_RE = /([一-龥A-Za-z0-9/·]{2,12}?)(?:边上|旁边|附近|周边|周围|一带|那边|这边|边|旁)/;

function toInt(s) {
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s];
}

function todayOf(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const m = /今天：(\d{4}-\d{2}-\d{2})/.exec(sys);
  return m && isValidDate(m[1]) ? m[1] : todayCN();
}

/** True between 00:00 and 05:59 China time (per the system prompt), when 今晚 is the night in progress. */
function lateNightOf(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const m = /北京时间 (\d{2}):\d{2}/.exec(sys);
  return Boolean(m && Number(m[1]) < 6);
}

function fmt(date) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${weekdayCN(date)}）`;
}

/**
 * Monday-based weeks: on a Sunday, 这周五 has passed, so it means the coming Friday. Before 06:00
 * (`lateNight`) 今晚 is the night in progress, i.e. yesterday's date.
 */
export function parseCheckIn(text, today, { lateNight = false } = {}) {
  let m;
  if ((m = /(\d{4}-\d{2}-\d{2})/.exec(text)) && isValidDate(m[1])) return m[1];
  if ((m = /(\d{1,2})月(\d{1,2})[日号]/.exec(text))) {
    let d = `${today.slice(0, 4)}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    // Same rule as the tools: only a date well in the past means next year.
    if (isValidDate(d) && d < today && nightsBetween(d, today) > 31) d = `${Number(today.slice(0, 4)) + 1}${d.slice(4)}`;
    if (isValidDate(d)) return d;
  }
  if (/大后天/.test(text)) return addDays(today, 3);
  if (/后天/.test(text)) return addDays(today, 2);
  if (/明天|明晚|明日/.test(text)) return addDays(today, 1);
  if (/今晚|今夜/.test(text)) return lateNight ? addDays(today, -1) : today;
  if (/今天|今日/.test(text)) return today;
  if ((m = /(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text))) {
    const mondayIdx = (d) => (d + 6) % 7;
    const monday = addDays(today, -mondayIdx(dayOfWeek(today)));
    const offset = m[1] === '下下' ? 14 : m[1] === '下' ? 7 : 0;
    let d = addDays(monday, offset + mondayIdx(WEEKDAY[m[2]]));
    if (d < today) d = addDays(d, 7);
    return d;
  }
  return undefined;
}

/** Search args from free text like '这周五去杭州西湖边住两晚，两个人，预算600以内'. */
export function parseSearch(text, today, { lateNight = false } = {}) {
  const city = CITIES.find((c) => text.includes(c));
  if (!city) return null;
  const args = { city };
  const after = text.slice(text.indexOf(city) + city.length).replace(/^市/, '');
  const quoted = /「([^」]{1,20})」/.exec(text);
  const near = quoted ? quoted[1] : (NEAR_RE.exec(after) || NEAR_RE.exec(text))?.[1];
  if (near) {
    const clean = near.replace(new RegExp(`^.*${city}市?`), '').replace(/^(靠近|离|在|去|到|住|近)/, '');
    if (clean.length >= 2) args.near = clean;
  }
  const checkIn = parseCheckIn(text, today, { lateNight });
  let m = /住?([一两二三四五六七八九十\d]+)\s*[晚夜]/.exec(text) || /住([一两二三四五六七八九十\d]+)\s*天/.exec(text);
  const nights = toInt(m?.[1]) || 1;
  if (checkIn) {
    args.check_in = checkIn;
    args.check_out = addDays(checkIn, nights);
  } else if (nights > 1) {
    args.check_in = today;
    args.check_out = addDays(today, nights);
  }
  if ((m = /([一两二三四五六\d])大([一两二三四五六\d])小/.exec(text))) {
    args.adults = toInt(m[1]);
    args.children = toInt(m[2]);
  } else if (/一家三口/.test(text)) {
    args.adults = 2;
    args.children = 1;
  } else if ((m = /([一两二三四五六七八九十\d]+)\s*(?:个人|个大人|人|位|大人|成人)/.exec(text))) {
    args.adults = toInt(m[1]);
  }
  if (args.children === undefined && (m = /([一两二三四五六\d])\s*(?:个|名)?(?:孩子|小孩|儿童|宝宝)/.exec(text))) args.children = toInt(m[1]);
  m = /预算\s*(?:是|在|大概|大约)?\s*(\d{2,5})/.exec(text) || /(\d{2,5})\s*(?:元|块)?\s*(?:以内|以下|之内)/.exec(text) || /不超过\s*(\d{2,5})/.exec(text);
  if (m) args.price_max = Number(m[1]);
  const cats = [];
  if (/经济|快捷/.test(text)) cats.push('economy');
  if (/舒适/.test(text)) cats.push('comfort');
  if (/高档|四星/.test(text)) cats.push('premium');
  if (/豪华|五星/.test(text)) cats.push('luxury');
  if (cats.length) args.categories = cats;
  if (/亲子|带娃|带孩子/.test(text)) args.keyword = '亲子';
  return args;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Tool results in the transcript, newest first: [{ name, args, content, at }] (`at`: index in messages). */
function toolResults(messages) {
  const names = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) names.set(c.id, { name: c.function?.name, args: parseJson(c.function?.arguments) || {} });
    }
  }
  const out = [];
  messages.forEach((m, at) => {
    if (m.role !== 'tool') return;
    const call = names.get(m.tool_call_id) || {};
    out.push({ name: call.name, args: call.args || {}, content: parseJson(m.content) || {}, at });
  });
  return out.reverse();
}

function call(name, args) {
  return { toolCalls: [{ name, arguments: args }] };
}

function has(tools, name) {
  return (tools || []).some((t) => t?.function?.name === name);
}

// ---- text-message replies (the cards show the details; the text recommends and offers quick replies) ----

// Hotels named in the reply (their numbered lines give 「订第1家」 one button per hotel), and room types offered.
const SHOWN = 3;
// The hotels card shows this many, numbered like the search result: 「第N家」 is the Nth on the card.
const CARD_HOTELS = 5;
const FALLBACK_TEXT = '我可以帮你找酒店、订房、查订单或取消订单～告诉我去哪个城市、哪天入住、住几晚、预算多少。';
const QUOTE_SENT_TEXT = '确认单发你啦，核对一下，没问题就点「确认预订」哦。';

// 1–9 parse, so 「第9家」 gets "刚才列了3家" rather than the fallback.
const PICK = '([1-9一二两三四五六七八九])';
const HOTEL_PICK_RE = new RegExp(`^我?(?:想|要)?(?:订|看看?|选|就|住|要)?第${PICK}家(?:吧|呢|酒店|的?房型|看看|怎么样)?$`);
const ITEM_PICK_RE = new RegExp(`^我?(?:想|要)?(?:订|选|就|要)?(?:第${PICK}个|${PICK})(?:吧|方案)?$`);
const ROOMS_RE = new RegExp(`^那?就?按?${PICK}间(?:看看?|查查?|吧)?$`);
const YES_RE = /^那?(?:好|好的|行|可以|订|订这个|就这个|就订这个|就它|确定|嗯|ok|okay)+$/i;

/** The text without spaces and punctuation, for matching short replies like 「订第1家！」. */
function compact(text) {
  return String(text).replace(/[\s，,。.！!？?~～、:：]/g, '');
}

function isCancelRequest(text) {
  return /退订/.test(text) || (/取消/.test(text) && /订单|那单|这单|一单|刚才|刚刚|预订|第.单/.test(text));
}

/** 1136 → '1,136'. */
function money(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** '2026-10-30' → '10月30日'. */
function md(date) {
  return isValidDate(date) ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` : String(date ?? '');
}

function stayPhrase(c) {
  return c.dates_assumed ? `先按${md(c.check_in)}入住、${c.nights}晚查的` : `${md(c.check_in)}入住，${c.nights}晚`;
}

/** The hotels a search reply names: the first three with a price (sold-out ones come last on the card). */
function hotelChoices(c) {
  return (c.hotels || []).filter((h) => h.hotel_id && h.price_from != null).slice(0, SHOWN);
}

/** A room type's plan to offer: the cheapest that can still be cancelled for free, else the cheapest. */
function bestRate(rt) {
  const open = (rt.rates || []).filter((r) => r.available !== false && r.rate_id && Number.isFinite(r.total_price)).sort((a, b) => a.total_price - b.total_price);
  return open.find((r) => r.free_cancel === true) || open[0] || null;
}

/**
 * 「第N个」 after a rooms reply: the Nth room type on the rooms card, which lists the room types that still
 * have a bookable plan (up to three, in the tool result's order). Derived from the stored tool result alone.
 */
function roomChoices(c) {
  return (c.room_types || []).map((rt) => ({ room: rt.room, rate: bestRate(rt) })).filter((x) => x.rate).slice(0, SHOWN);
}

/** The room type to recommend: one that can be cancelled for free if any, the cheapest of those. */
function recommendedRoom(choices) {
  let best = 0;
  choices.forEach((x, i) => {
    const b = choices[best].rate;
    const free = x.rate.free_cancel === true;
    if (free !== (b.free_cancel === true) ? free : x.rate.total_price < b.total_price) best = i;
  });
  return best;
}

function breakfastText(r) {
  const n = Number(r.breakfast);
  if (n === 0) return '不含早';
  if (n === 1) return '含单早';
  if (n === 2) return '含双早';
  if (n > 2) return `含${n}份早`;
  return String(r.plan || '').split(' · ')[0] || '早餐以确认单为准';
}

function cancelText(r) {
  if (r.free_cancel === true) {
    const until = /(\d{1,2}月\d{1,2}日\d{1,2}:\d{2})前/.exec(r.cancel || '')?.[1];
    return until ? `${until}前免费取消` : '可免费取消';
  }
  return /不可取消/.test(r.cancel || '') ? '不可取消' : '已不能免费取消';
}

function partyArgs(c) {
  return { adults: c.adults, ...(c.children ? { children: c.children } : {}), rooms: c.rooms };
}

function hotelsReply(c) {
  const hotels = c.hotels || [];
  const list = hotelChoices(c);
  if (!list.length) {
    if (hotels.some((h) => h.fits === false)) {
      const need = hotels.find((h) => Number.isFinite(h.need_rooms))?.need_rooms || (c.rooms || 1) + 1;
      return `按现在的人数，${c.near ? '这附近的' : '这些'}酒店${c.rooms > 1 ? `订${c.rooms}间` : '一间'}住不下（不是满房）。要按${need}间查吗？回复「按${need}间」就行。`;
    }
    return '这附近暂时没有可订的酒店，换个区域、日期或放宽预算试试？';
  }
  const top = list[0];
  const why = c.near && top.distance ? `离${c.near}${top.distance}、${top.rating}分` : `${top.rating}分、¥${money(top.price_from)}/晚`;
  return [
    `${c.city}${c.near ? `${c.near}附近` : ''}给你挑了这几家（${stayPhrase(c)}），照片和价格都在卡片上：`,
    ...list.map((h, i) => `${i + 1}. ${h.name}`),
    `推荐第1家～${why}。想订哪家？回复「订第1家」就行。`,
  ].join('\n');
}

function roomsReply(c) {
  const list = roomChoices(c);
  if (!list.length) {
    // Too many guests per room is not 满房 (C2): say so and offer more rooms (K5).
    const blocked = (c.room_types || []).flatMap((rt) => rt.rates || []);
    if (blocked.some((r) => /超出可住人数/.test(r.reason || ''))) {
      const max = Math.max(...(c.room_types || []).map((rt) => Number(rt.max_guests) || 0));
      const n = max > 0 ? Math.ceil(((c.adults || 0) + (c.children || 0)) / max) : (c.rooms || 1) + 1;
      return `「${c.hotel_name}」按现在的人数${c.rooms > 1 ? `订${c.rooms}间` : '一间'}住不下（不是满房）：每间最多住${max}人。要按${n}间查吗？回复「按${n}间」就行。`;
    }
    return `「${c.hotel_name}」这几天都订满了，换个日期或换一家看看？`;
  }
  const pick = recommendedRoom(list);
  const { room, rate } = list[pick];
  const others = list.map((_, i) => i).filter((i) => i !== pick).map((i) => `「第${i + 1}个」`).join('');
  return `「${c.hotel_name}」${stayPhrase(c)}～推荐第${pick + 1}个：${room} · ${breakfastText(rate)} · ${cancelText(rate)}，共¥${money(rate.total_price)}。`
    + `回复「好」就帮你下单${others ? `，想换就回${others}` : ''}。`;
}

function ordersReply(c) {
  const orders = (c.orders || []).slice(0, 5);
  if (!orders.length) return '你还没有订单。告诉我去哪个城市、哪天入住，我帮你找。';
  const count = c.count ?? orders.length;
  const lines = orders.map((o, i) => `${i + 1}. ${o.hotel} · ${md(o.check_in)}入住${o.nights}晚 · ¥${money(o.total_price)} · ${o.status}`);
  const tail = [count > orders.length ? `还有${count - orders.length}单没列出。` : '', orders.some(isOpenOrder) ? '要取消的话回复「取消第N单」。' : ''].join('');
  return [`你有${count}个订单：`, ...lines, ...(tail ? [tail] : [])].join('\n');
}

function cancelReply(c) {
  if (!c.cancellable) return `这单现在不能取消：${c.policy}`;
  if (c.status === '待支付') return `${c.hotel}这单还没付款，现在取消不收任何费用。确定的话点「确认取消」。`;
  return `${c.hotel}这单现在取消${c.penalty > 0 ? `要扣¥${money(c.penalty)}` : '免费'}，退款¥${money(c.refund)}。确定的话点「确认取消」。`;
}

function placesReply(c) {
  const list = (c.places || []).slice(0, SHOWN);
  if (!list.length) return '城市指南里没找到相关地点，换个关键词试试？';
  const lines = list.map((p, i) => `${i + 1}. ${p.name}${p.area ? ` · ${p.area}` : ''}`);
  return [`${c.city}这几个地方可以看看：`, ...lines, '营业时间、门票以官方为准。想住附近的话跟我说。'].join('\n');
}

function isOpenOrder(o) {
  return o.status === '已确认' || o.status === '待支付';
}

/** After a list_orders that a cancel request started: the order to cancel (「第N单」, else the newest open one). */
function cancelFromOrders(c, text, tools) {
  const orders = c.orders || [];
  if (!orders.length) return { content: '你还没有订单，没有需要取消的。' };
  const n = toInt(new RegExp(`第${PICK}(?:单|个订单)`).exec(compact(text))?.[1]);
  const target = n ? orders[n - 1] : orders.find((o) => o.status === '已确认') || orders.find((o) => o.status === '待支付');
  if (!target) return { content: n ? `你一共${orders.length}个订单，回复「取消第1单」这样告诉我是哪一单。` : '你现在没有可以取消的订单。' };
  if (!isOpenOrder(target)) return { content: `第${n}单${target.status}，不用再取消。` };
  if (!has(tools, 'prepare_cancellation')) return { content: ordersReply(c) };
  return call('prepare_cancellation', { order_id: target.order_id });
}

// ---- after booking: the stay journey ----

const AIRPORTS = {
  北京: '北京首都国际机场', 上海: '上海浦东国际机场', 广州: '广州白云国际机场', 深圳: '深圳宝安国际机场', 杭州: '杭州萧山国际机场',
  成都: '成都双流国际机场', 重庆: '重庆江北国际机场', 西安: '西安咸阳国际机场', 南京: '南京禄口国际机场', 苏州: '苏南硕放国际机场',
  厦门: '厦门高崎国际机场', 三亚: '三亚凤凰国际机场', 青岛: '青岛胶东国际机场', 长沙: '长沙黄花国际机场', 武汉: '武汉天河国际机场', 丽江: '丽江三义国际机场',
};
const MEAL_TIMES = { breakfast: '08:00', lunch: '12:00', dinner: '18:30' };
const CLOCK_IN_TEXT = /(凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|明早|明晚|今晚)?(\d{1,2}|[一二两三四五六七八九十]{1,3})[点:：](半|[0-5]\d)?/;

/** '7' / '七' / '十二' → number. */
function hourOf(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s];
  const m = /^([二两三])?十([一二三四五六七八九])?$/.exec(s);
  return m ? (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0) : undefined;
}

/** The first clock time in a message: '明早7点' → '07:00', '下午3点半' → '15:30', '18:30' → '18:30'. */
export function clockOf(text) {
  const m = CLOCK_IN_TEXT.exec(String(text));
  if (!m) return null;
  let h = hourOf(m[2]);
  const min = m[3] === '半' ? 30 : Number(m[3] || 0);
  if (/下午|傍晚|晚上|明晚|今晚/.test(m[1] || '') && h < 12) h += 12;
  else if (/晚上|明晚|今晚/.test(m[1] || '') && h === 12) h = 0;
  if (m[1] === '中午' && h < 6) h += 12;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

/**
 * What earlier tool results say about the trip: the hotel of the latest booking, its dates and party, the city.
 * Only the recent history is sent, so later in a stay the hotel comes from the stay tools' results instead.
 */
function tripOf(messages) {
  const results = toolResults(messages);
  const booked = results.find((r) => r.name === 'prepare_booking' && !r.content.error);
  const search = results.find((r) => r.name === 'search_hotels' && !r.content.error && (!booked || r.at < booked.at));
  const stay = results.find((r) => ['check_in', 'get_stay_info', 'request_early_checkin', 'prepare_extension'].includes(r.name) && !r.content.error);
  return {
    hotel: booked?.content.hotel || stay?.content.hotel || null,
    checkIn: booked?.content.check_in || null,
    adults: booked?.content.adults || search?.content.adults || 2,
    city: search?.content.city || cityOf('', messages),
    near: search?.content.near || null,
    checkedIn: results.some((r) => r.name === 'check_in' && !r.content.error),
  };
}

function itineraryCall(trip, today) {
  const where = trip.near || '';
  const items = [
    { time: '11:00', title: `抵达${trip.city || ''}`, note: '先把行李放到酒店' },
    { time: '12:00', title: '到酒店寄存行李', ...(trip.hotel ? { place: trip.hotel } : {}) },
    { time: '12:30', title: '午饭', place: where ? `${where}附近` : '酒店附近' },
    { time: '14:00', title: where ? `逛${where}` : '附近逛逛', ...(where ? { place: where } : {}), note: '慢慢走，累了就歇会儿' },
    { time: '18:30', title: '晚饭', note: '吃完早点回酒店休息' },
  ];
  // 那天 is the arrival day while it is still ahead and the guest is not in yet; otherwise the tool plans today.
  const date = trip.checkIn && trip.checkIn >= today && !trip.checkedIn ? { date: trip.checkIn } : {};
  return call('plan_itinerary', { title: `${where || trip.city || ''}一日安排`, ...date, items });
}

function rideCall(text, trip, today) {
  const clock = clockOf(text);
  // A pickup to the hotel before arrival day is for arrival day (unless the guest checked in early).
  const arrival = trip.checkIn && trip.checkIn > today && !trip.checkedIn ? { pickup_time: `${trip.checkIn} ${clock || '12:00'}` } : clock ? { pickup_time: clock } : {};
  const airport = AIRPORTS[trip.city] || '机场';
  if (/接机/.test(text)) return call('quote_ride', { kind: 'airport_pickup', from: airport, ...arrival });
  if (/送机|去机场/.test(text)) return call('quote_ride', { kind: 'from_hotel', from: '酒店', to: airport, ...(clock ? { pickup_time: clock } : {}) });
  if (/(去|回|到)酒店/.test(text)) return call('quote_ride', { kind: 'to_hotel', from: '当前位置', ...arrival });
  const to = /(?:去|到)([^，,。.！!？?～~\s]{2,12})/.exec(text)?.[1];
  if (!to) return { content: '想去哪里呀？告诉我目的地，比如「打车去西湖」。' };
  return call('quote_ride', { kind: 'taxi', from: trip.checkedIn && trip.hotel ? trip.hotel : '当前位置', to, ...(clock ? { pickup_time: clock } : {}) });
}

function diningCall(text, trip, today, lateNight) {
  const kind = /早/.test(text) ? 'breakfast' : /午|中饭/.test(text) ? 'lunch' : 'dinner';
  const date = parseCheckIn(text, today, { lateNight });
  return call('reserve_dining', { kind, time: clockOf(text) || MEAL_TIMES[kind], people: trip.adults || 2, ...(date ? { date } : {}) });
}

function invoiceCall(text, messages) {
  const t = compact(text);
  const prev = toolResults(messages).find((r) => r.name === 'request_invoice');
  const taxId = /税号(?:是|为)?([0-9A-Za-z]{15,20})/.exec(t)?.[1];
  // A tax id on its own completes the company title asked for just before.
  const title = /抬头(?:写|是|开|为|用)?([^，。；;]{2,40}?)(?:税号|$)/.exec(t)?.[1] || (taxId ? prev?.args.title : undefined);
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0];
  return call('request_invoice', { ...(title ? { title } : {}), ...(taxId ? { tax_id: taxId.toUpperCase() } : {}), ...(email ? { email } : {}) });
}

function reviewCall(text, messages) {
  const rating = /差评/.test(text) ? 2 : toInt(/([1-5一二三四五])\s*星/.exec(text)?.[1]) || 5;
  const done = (name) => toolResults(messages).some((r) => r.name === name && !r.content.error);
  // Only what the user said and what happened in this chat; no invented experiences.
  const said = /[，,]\s*(?:说|夸夸?|写上?|提一下)?\s*([^，,。]{2,30})[。！!]?$/.exec(text)?.[1];
  if (rating <= 3) return call('draft_review', { rating, text: `这次住得一般${said ? `：${said}` : ''}，希望能改进。`, tags: [] });
  const facts = [said, done('check_in') && '入住办得很快', done('request_service') && '送东西很及时', done('reserve_dining') && '订餐位很方便'].filter(Boolean);
  const tags = [done('check_in') && '入住快', done('request_service') && '服务及时'].filter(Boolean);
  return call('draft_review', { rating, text: `${['整体住得很满意', ...facts].join('，')}，下次还会再来～`, tags: tags.length ? tags : ['推荐'] });
}

// Checking in or out happens on a plain request (「我要退房」「我到了，帮我办入住」); a question about it (几点、
// 要带什么、能不能晚点) is answered from the stay info instead.
const CHECK_IN_RE = /^我?(要|想|准备|现在|马上)?(办理?|办一下)入住(吧|了|啦)?$|帮我(办理?|办一下)?入住|^我到(酒店)?(了|啦)$|checkin/i;
const CHECK_OUT_RE = /^我?(要|想|准备|现在|马上)?(办理?|办一下)?退房(了|吧|啦)?$|帮我(办理?|办一下)?退房/;
const QUESTION_RE = /几点|时间|什么时候|多久|延迟|晚点|推迟|吗|么|[？?]|前(?!台)|要带|带什么|证件|手续|怎么|如何|能不能|可不可以/;
/** 「帮我办入住」「我到酒店了，办入住」: a request to check in now, not a question about it. */
const wantsCheckIn = (t, text) => CHECK_IN_RE.test(t) || (/办(理|一下)?入住(吧|了|啦)?$/.test(t) && !QUESTION_RE.test(text));

/** A §5 phrase of the journey (only when its tool is offered), or null. */
function journeyRoute(text, messages, tools) {
  const t = compact(text);
  const today = todayOf(messages);
  const lateNight = lateNightOf(messages);
  const can = (name) => has(tools, name);
  if (can('quote_ride') && /叫车|打车|叫个车|叫辆车|接机|送机|约车|用车/.test(t)) return rideCall(text, tripOf(messages), today);
  if (can('set_wakeup_call') && /叫醒|叫早|闹钟/.test(t)) {
    // 明早 before 06:00 is the coming morning.
    const date = /明早|明天|明晨/.test(t) ? (lateNight ? today : addDays(today, 1)) : undefined;
    return call('set_wakeup_call', { time: clockOf(text) || '07:00', ...(date ? { date } : {}) });
  }
  if (can('request_early_checkin') && (/(提前|早点|提早)入住|几点(可以|能)入住/.test(t) || /^我?(大概|预计|可能)?(今天|明天|后天)?[^，。]{0,4}点(半|\d{1,2}分?)?(左右)?(就)?(能)?到(酒店)?了?$/.test(t))) {
    return call('request_early_checkin', { arrival_time: clockOf(text) || '12:00' });
  }
  if (can('check_in') && wantsCheckIn(t, text)) return call('check_in', {});
  if (can('get_stay_info') && (/wi-?fi|无线|网络|密码|早餐(几点|什么时候|在哪|时间)|几点(吃)?早餐|最晚几点|前台|健身房|泳池|游泳|洗衣/i.test(t)
    || (/入住|退房/.test(t) && !CHECK_OUT_RE.test(t) && QUESTION_RE.test(text)))) return call('get_stay_info', {});
  // 「订含早餐的酒店」 is a hotel search, not a table.
  if (can('reserve_dining') && !/酒店|民宿|客栈/.test(t) && /(订|预订|预约)[^，。]*?(早餐|早饭|午餐|午饭|晚餐|晚饭|位子|座位|餐位|桌)|(早餐|早饭|午餐|午饭|晚餐|晚饭)[^，。]*?(订|预订)/.test(t)) {
    return diningCall(text, tripOf(messages), today, lateNight);
  }
  if (can('request_service') && /毛巾|浴巾|牙刷|牙膏|拖鞋|矿泉水|枕头|被子|吹风机|充电器|纸巾|卫生纸|衣架|打扫|清洁|收拾房间|送[^机]/.test(t)) {
    return call('request_service', { items: text.replace(/[，,。！!～~]*(谢谢|麻烦(你)?了)[！!。～~]*$/, '').trim() });
  }
  if (can('prepare_extension') && /续住|再住|多住|延住/.test(t)) {
    return call('prepare_extension', { nights: toInt(/([一两二三四五六七\d])\s*[晚天]/.exec(t)?.[1]) || 1 });
  }
  if (can('check_out') && CHECK_OUT_RE.test(t)) return call('check_out', {});
  if (can('request_invoice') && /发票|开票|抬头|税号/.test(t)) return invoiceCall(text, messages);
  if (can('get_membership') && /积分|会员|等级/.test(t)) return call('get_membership', {});
  if (can('draft_review') && /好评|差评|评价|点评/.test(t)) return reviewCall(text, messages);
  if (can('plan_itinerary') && /行程|规划|怎么安排|安排一下|攻略/.test(t)) return itineraryCall(tripOf(messages), today);
  return null;
}

/** The reply after a stay tool: one or two light sentences; the card has the details. Null for other tools. */
function stayReply(name, c, messages) {
  switch (name) {
    case 'plan_itinerary': return `${md(c.date)}的行程排好啦～按时间放在卡片上了，想改哪一项跟我说哦。`;
    case 'quote_ride': return `${c.ride}约${c.minutes}分钟，车费¥${money(c.fare)}～没问题就点「确认叫车」哦。`;
    case 'request_early_checkin':
      return c.status === '已确认' ? `搞定啦～${c.note}。` : `${c.note}～`;
    case 'check_in':
      if (c.already_checked_in) return `你已经办好入住啦，房间是${c.room_number}～`;
      return `${c.early ? '提前帮你' : ''}入住办好啦～你住${c.room_number}，电子房卡和 Wi-Fi 都在卡片上。要送点东西或订早餐的话，回复「送两条毛巾」或「订明天的早餐」就行。`;
    case 'request_service': return `收到～${c.items.join('、')}大约5分钟送到${c.room_number}哦。`;
    case 'reserve_dining': {
      let pay = c.price_per_person ? `每位¥${money(c.price_per_person)}，记在房账上。` : '房价含早，不用另外付哦。';
      if (c.covered_by_rate) pay = `房价含${c.covered_by_rate}位的早餐，另外${c.people - c.covered_by_rate}位每位¥${money(c.price_per_person)}，记在房账上。`;
      return `订好啦～${c.at}的${c.meal}，${c.people}位，在${c.restaurant}。${pay}`;
    }
    case 'set_wakeup_call': return `好哒～${c.at}准时打电话叫你起床 ⏰`;
    case 'get_stay_info': {
      const q = lastUserText(messages);
      if (/wi-?fi|无线|网络|密码/i.test(q)) return `Wi-Fi 是 ${c.wifi.ssid}，密码 ${c.wifi.password}～卡片上可以一键复制哦。`;
      if (/早餐/.test(q)) {
        const [hours, place, price] = String(c.breakfast).split(' · ');
        return `早餐是${hours}，在${place}${price === '房价含早' ? '，房价已经含早啦' : `，${price}`}～`;
      }
      if (/退房/.test(q)) {
        if (/寄存|行李/.test(q)) return `可以的～退房时把行李交给前台寄存就行，最晚${c.checkout_time}前退房哦。`;
        if (/延迟|晚点|推迟|延时|晚一点/.test(q)) return `正常是${c.checkout_time}前退房～想晚点走可以跟前台说一声，视房态一般能延到13:00左右哦。`;
        return `最晚${c.checkout_time}前退房就行哦～`;
      }
      if (/入住/.test(q)) {
        if (/证件|带什么|要带|身份证/.test(q)) return '带上入住人的身份证就行～到了跟我说「我到了，帮我办入住」，我直接帮你办好。';
        if (/手续|怎么|如何/.test(q)) return '到店出示入住人的身份证就能办～也可以跟我说「帮我办入住」，房号和电子房卡直接发你。';
        return c.checked_in ? `你已经住进${c.room_number}啦～` : '14:00 起就能办入住啦，提早到的话可以先寄存行李～';
      }
      if (/前台|电话/.test(q)) return `前台电话是 ${c.front_desk}～`;
      return '住店信息都在卡片上啦，还想知道什么直接问我哦。';
    }
    case 'prepare_extension': return `多住${c.nights}晚是¥${money(c.price)}～没问题就点「确认续住」哦。`;
    case 'check_out':
      return `退房办好啦～这次一共¥${money(c.total_paid)}${c.due > 0 ? `，挂房账的¥${money(c.due)}已用${c.settled_by}结清（模拟）` : ''}，攒了${money(c.points_earned)}积分。要开发票或写个点评吗？回复「开发票」或「写个好评」就行。`;
    case 'request_invoice':
      return `发票申请好啦～抬头「${c.title}」，¥${money(c.amount)}，${c.status === '已开具' ? '已经开好了' : '两分钟左右开好'}${c.email ? `，会发到${c.email}` : ''}。`;
    case 'get_membership':
      return `你现在是${c.level}，有${money(c.points)}积分${c.next_level ? `，再攒${money(c.points_to_next)}分就升${c.next_level}啦` : '，已经是最高等级啦'}～`;
    case 'draft_review': return '草稿写好啦～看看要不要改，满意就点「发布」哦。';
    default: return null;
  }
}

/** Stay errors the demo can help with; others are passed on as they are. */
function stayErrorReply(error) {
  if (/还没办入住/.test(error)) return '还没办入住呢～要我先帮你办入住吗？回复「办理入住」就行。';
  if (/还没有已确认的订单/.test(error)) return '还没有订好的酒店呢～告诉我去哪个城市、哪天入住，订好了我再帮你安排呀。';
  if (/税号/.test(error)) return '公司抬头要有税号才能开哦～把18位的税号（统一社会信用代码）发我就行。';
  return null;
}

/** The reply once the last tool result is in. */
function afterTool(messages, tools) {
  const [r] = toolResults(messages);
  const c = r.content;
  if (c.error) return { content: stayErrorReply(c.error) || `抱歉，${c.error}` };
  switch (r.name) {
    case 'search_hotels': return { content: hotelsReply(c) };
    case 'get_hotel_rooms': return { content: roomsReply(c) };
    case 'prepare_booking': return { content: QUOTE_SENT_TEXT };
    case 'list_orders': {
      const text = lastUserText(messages);
      return isCancelRequest(text) ? cancelFromOrders(c, text, tools) : { content: ordersReply(c) };
    }
    case 'prepare_cancellation': return { content: cancelReply(c) };
    case 'search_places': return { content: placesReply(c) };
    default: return { content: stayReply(r.name, c, messages) || '查好了，还需要我帮你做什么？' };
  }
}

const PLACE_WORDS = [[/好吃|美食|吃的|小吃|夜市/, '美食'], [/交通|怎么去|火车站|高铁/, '火车站'], [/机场/, '机场'], [/好玩|景点|逛/, '景点']];

/** City from the message, else from the most recent search/rooms/booking result. */
function cityOf(text, messages) {
  const direct = CITIES.find((c) => text.includes(c));
  if (direct) return direct;
  for (const r of toolResults(messages)) {
    const city = r.content.city || r.args.city;
    if (typeof city === 'string' && city) return city.replace(/市$/, '');
  }
  return null;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return String(messages[i].content || '');
  return '';
}

/**
 * The machine-readable part of a card-button message (see the 看房型 / 订这个 / 重新报价 formats):
 * '…，2位成人，1名儿童，1间（hotel_id: sim-hz-001，rate_id: R1-BF2-FC，check_in: 2026-10-30，check_out: 2026-11-01）'.
 */
export function parseButtonMessage(text) {
  const field = (key, re) => new RegExp(`${key}[:：]\\s*(${re})`).exec(text)?.[1];
  const out = {};
  const hotelId = field('hotel_id', '[A-Za-z0-9_-]+');
  const rateId = field('rate_id', '[A-Za-z0-9_-]+');
  const checkIn = field('check_in', '\\d{4}-\\d{2}-\\d{2}');
  const checkOut = field('check_out', '\\d{4}-\\d{2}-\\d{2}');
  if (hotelId) out.hotel_id = hotelId;
  if (rateId) out.rate_id = rateId;
  if (checkIn && isValidDate(checkIn)) out.check_in = checkIn;
  if (checkOut && isValidDate(checkOut)) out.check_out = checkOut;
  let m;
  if ((m = /(\d+)位成人/.exec(text))) out.adults = Number(m[1]);
  if ((m = /(\d+)名儿童/.exec(text))) out.children = Number(m[1]);
  if ((m = /(\d+)间\s*[（(]/.exec(text))) out.rooms = Number(m[1]);
  return out;
}

function bookingArgs(text, messages) {
  const sent = parseButtonMessage(text);
  const rateId = sent.rate_id;
  if (!rateId) return null;
  let args;
  if (sent.hotel_id && sent.check_in && sent.check_out) {
    args = { ...sent };
  } else {
    // Older button format: only the rate id, so the rest comes from the last rooms result.
    const hotelName = /「([^」]+)」/.exec(text)?.[1];
    const rooms = toolResults(messages).filter((r) => r.name === 'get_hotel_rooms' && !r.content.error
      && (r.content.room_types || []).some((rt) => (rt.rates || []).some((x) => x.rate_id === rateId)));
    const hit = rooms.find((r) => r.content.hotel_name === hotelName) || rooms[0];
    if (!hit) return null;
    args = {
      hotel_id: hit.content.hotel_id,
      rate_id: rateId,
      check_in: hit.content.check_in,
      check_out: hit.content.check_out,
      rooms: hit.content.rooms,
      adults: hit.content.adults,
      ...(hit.content.children ? { children: hit.content.children } : {}),
    };
  }
  return withGuest(args, messages);
}

/** The saved profile fills guest and phone (prepare_booking does that); otherwise the demo guest. */
function withGuest(args, messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  if (!sys.includes('- 入住人：')) args.guest_names = [DEMO_GUEST];
  if (!sys.includes('- 手机：')) args.contact_phone = DEMO_PHONE;
  return args;
}

function roomsArgs(text, messages) {
  const sent = parseButtonMessage(text);
  if (!sent.hotel_id) return null;
  if (sent.check_in && sent.check_out) return sent;
  const search = toolResults(messages).find((r) => r.name === 'search_hotels' && (r.content.hotels || []).some((h) => h.hotel_id === sent.hotel_id));
  const args = { hotel_id: sent.hotel_id };
  if (search) {
    Object.assign(args, { check_in: search.content.check_in, check_out: search.content.check_out, adults: search.content.adults, rooms: search.content.rooms });
    if (search.content.children) args.children = search.content.children;
  }
  return args;
}

/** The demo's answer to a 已取消 notice follows the money in it: no refund promised when there is none. */
export function cancelledReply(notice) {
  if (/未支付|没有产生费用/.test(notice)) return '订单已取消，这单还没付款，不会产生任何费用。';
  const penalty = Number(/违约金\s*¥\s*(\d+(?:\.\d+)?)/.exec(notice)?.[1] || 0);
  const refund = Number(/退款\s*¥\s*(\d+(?:\.\d+)?)/.exec(notice)?.[1] || 0);
  if (refund > 0) return `订单已取消，${penalty > 0 ? `扣除违约金 ¥${penalty}，` : ''}退款 ¥${refund} 会按原路退回（模拟）。`;
  if (/不退款|退款\s*¥\s*0(?!\d)/.test(notice)) return `订单已取消。按取消政策这单不退款${penalty > 0 ? `（违约金 ¥${penalty}）` : ''}（模拟）。`;
  return '订单已取消，费用以订单记录为准（模拟）。';
}

// ---- short replies that refer to the latest numbered list ----

/** The latest search_hotels or get_hotel_rooms result: the numbered list the user is answering. */
function latestList(messages) {
  return toolResults(messages).find((r) => (r.name === 'search_hotels' || r.name === 'get_hotel_rooms') && !r.content.error);
}

function lastNoticeAt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && String(messages[i].content || '').startsWith(NOTICE_PREFIX)) return i;
  }
  return -1;
}

/** 「第N家」: the Nth hotel on the latest hotels card → its rooms, same dates and party. */
function pickHotel(n, messages, tools) {
  const search = toolResults(messages).find((r) => r.name === 'search_hotels' && !r.content.error);
  if (!search || !has(tools, 'get_hotel_rooms')) return null;
  const c = search.content;
  const shown = (c.hotels || []).filter((h) => h.hotel_id).slice(0, CARD_HOTELS);
  if (!shown.some((h) => h.price_from != null)) return { content: '刚才没有可订的酒店，换个区域、日期或放宽预算试试？' };
  const h = shown[n - 1];
  if (!h) return { content: shown.length === 1 ? '刚才只找到1家，回复「订第1家」就行。' : `卡片上有${shown.length}家，回复1到${shown.length}选一家就行。` };
  if (h.price_from == null) return { content: `第${n}家${h.fits === false ? '按现在的人数住不下' : '这几天满房了'}，换一家看看？` };
  return call('get_hotel_rooms', { hotel_id: h.hotel_id, check_in: c.check_in, check_out: c.check_out, ...partyArgs(c) });
}

/** 「第N个」 / 「好」 after a rooms reply: the plan offered for the Nth room type → prepare_booking. */
function pickRate(n, rooms, messages, tools) {
  if (!has(tools, 'prepare_booking')) return null;
  const c = rooms.content;
  const list = roomChoices(c);
  const pick = list[n - 1];
  if (!pick) {
    if (!list.length) return { content: `「${c.hotel_name}」现在没有可订的房型，换一家看看？` };
    return { content: `卡片上有${list.length}个房型，回复1到${list.length}选一个就行。` };
  }
  return call('prepare_booking', withGuest({ hotel_id: c.hotel_id, rate_id: pick.rate.rate_id, check_in: c.check_in, check_out: c.check_out, ...partyArgs(c) }, messages));
}

/** A bare 「N」 or 「第N个」: the Nth line of whichever list came last. */
function pickLatest(n, messages, tools) {
  const latest = latestList(messages);
  if (!latest) return null;
  return latest.name === 'get_hotel_rooms' ? pickRate(n, latest, messages, tools) : pickHotel(n, messages, tools);
}

/** 「好」: take the recommendation (line 1) of the latest list, unless a quote or an order notice already followed it. */
function sayYes(messages, tools) {
  const latest = latestList(messages);
  if (!latest) return null;
  if (latest.name === 'search_hotels') return pickHotel(1, messages, tools);
  if (lastNoticeAt(messages) > latest.at) return null;
  const quote = toolResults(messages).find((r) => r.name === 'prepare_booking' && !r.content.error);
  if (quote && quote.at > latest.at) return { content: '确认单已经发你了，核对一下，没问题就点「确认预订」。' };
  const choices = roomChoices(latest.content);
  return pickRate(choices.length ? recommendedRoom(choices) + 1 : 1, latest, messages, tools);
}

/** 「按N间」: the latest list again with N rooms. */
function withRooms(n, messages, tools) {
  const latest = latestList(messages);
  if (!latest || !n) return null;
  const c = latest.content;
  if (latest.name === 'get_hotel_rooms') {
    if (!has(tools, 'get_hotel_rooms')) return null;
    return call('get_hotel_rooms', { hotel_id: c.hotel_id, check_in: c.check_in, check_out: c.check_out, ...partyArgs(c), rooms: n });
  }
  if (!has(tools, 'search_hotels')) return null;
  return call('search_hotels', { ...latest.args, check_in: c.check_in, check_out: c.check_out, rooms: n });
}

/** An order notice the user's message came right after (the notice has not been answered yet). */
function unansweredNotice(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  const prev = messages[i - 1];
  return prev?.role === 'user' && String(prev.content || '').startsWith(NOTICE_PREFIX) ? String(prev.content) : null;
}

/** The answer to a ride / extension / review notice (judged by its latest line), or null for an order notice. */
export function stayNoticeReply(notice) {
  const line = String(notice).split('\n').pop();
  if (/已确认叫车/.test(line)) {
    const m = /司机\s*(\S+?师傅)\s*([^\s（(]+)/.exec(line);
    return m ? `车叫好啦～${m[1]}会准时到，车牌${m[2]}，上车前核对一下哦。` : '车叫好啦～司机会准时到，上车前核对一下车牌哦。';
  }
  if (/已续住/.test(line)) {
    const until = /离店日期改为\s*([^，。]+)/.exec(line)?.[1];
    return `续住办好啦～${until ? `离店改到${until}，` : ''}可以多玩${/已续住1晚/.test(line) ? '一天' : '几天'}啦。`;
  }
  if (/已发布点评/.test(line)) return '点评发布啦，谢谢你～期待下次再见呀！';
  // The hotel's side (docs/MERCHANT.md): the front desk, an early check-in answered, a reply to the review.
  if (/前台已为用户办好入住/.test(line)) {
    const room = /(\d{3,5}) 房/.exec(line)?.[1];
    return `前台已经帮你办好入住啦～${room ? `你住${room}，` : ''}电子房卡和 Wi-Fi 都在卡片上。`;
  }
  if (/酒店已确认用户可以提前入住/.test(line)) {
    const time = /(\d{2}:\d{2}) 到店/.exec(line)?.[1];
    return `好消息～酒店确认${time ? ` ${time} ` : ''}就能入住啦。`;
  }
  if (/酒店婉拒了用户的提前入住申请/.test(line)) return '酒店说那天房间比较满，要按 14:00 入住哦～早到的话可以先把行李寄存在前台。';
  if (/酒店回复了用户的点评/.test(line)) return '酒店回复了你的点评～在点评卡片上就能看到哦。';
  return null;
}

function noticeAck(notice) {
  const stay = stayNoticeReply(notice);
  if (stay) return stay;
  if (/已取消/.test(notice)) return cancelledReply(notice);
  if (/已支付成功/.test(notice)) return '订单已经确认，祝入住愉快～';
  return '订单已提交，记得按时完成模拟支付。';
}

function route(text, messages, tools) {
  if (has(tools, 'prepare_booking') && /rate_id/.test(text)) {
    const args = bookingArgs(text, messages);
    if (args) return call('prepare_booking', args);
    return { content: '我没找到这个房型的报价信息，告诉我想订第几家，我重新查一下房型。' };
  }
  if (has(tools, 'get_hotel_rooms') && /hotel_id/.test(text)) return call('get_hotel_rooms', roomsArgs(text, messages));
  if (/再想想|先不订/.test(text)) return { content: '好哒，不着急～报价会保留 15 分钟，想好了随时告诉我。' };
  const orderId = /HA\d{14}/.exec(text)?.[0];
  if (has(tools, 'prepare_cancellation') && orderId && /取消/.test(text)) return call('prepare_cancellation', { order_id: orderId });
  if (has(tools, 'list_orders') && (isCancelRequest(text) || /订单/.test(text))) return call('list_orders', {});

  const t = compact(text);
  let m;
  let reply = null;
  if ((m = ROOMS_RE.exec(t))) reply = withRooms(toInt(m[1]), messages, tools);
  else if ((m = HOTEL_PICK_RE.exec(t))) reply = pickHotel(toInt(m[1]), messages, tools);
  else if ((m = ITEM_PICK_RE.exec(t))) reply = pickLatest(toInt(m[1] ?? m[2]), messages, tools);
  else if (YES_RE.test(t.replace(/[吧啊呀哈嘛]+$/, ''))) reply = sayYes(messages, tools);
  if (reply) return reply;
  const stay = journeyRoute(text, messages, tools);
  if (stay) return stay;

  const place = PLACE_WORDS.find(([re]) => re.test(text));
  const placeCity = place && !/酒店|住/.test(text) ? cityOf(text, messages) : null;
  if (placeCity && has(tools, 'search_places')) return call('search_places', { city: placeCity, keyword: place[1] });
  const search = parseSearch(text, todayOf(messages), { lateNight: lateNightOf(messages) });
  if (search && has(tools, 'search_hotels')) return call('search_hotels', search);
  return { content: FALLBACK_TEXT };
}

/**
 * Rule-based "model" that texts like the real one should (see the system prompt): a trip request with a
 * city → search_hotels → a short reply naming three hotels; 「订第N家」/「N」 → get_hotel_rooms → one recommended
 * plan; 「好」/「第N个」 → prepare_booking (the confirmation the user taps); 「取消刚才那单」 → list_orders →
 * prepare_cancellation; 「我的订单」 → list_orders. After booking, the phrases of docs/JOURNEY.md §5 reach the
 * stay tools (行程, 叫车/接机, 提前入住, 办入住, 送毛巾, 订早餐, 叫醒, Wi-Fi, 续住, 退房, 发票, 积分, 好评).
 * Short replies resolve against the latest card, rebuilt from the tool results in the history. The card
 * buttons' messages (hotel_id / rate_id in （…）) work too.
 */
export function demoScript(messages, tools) {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return afterTool(messages, tools);

  const text = lastUserText(messages);
  if (text.startsWith(NOTICE_PREFIX)) {
    const stay = stayNoticeReply(text);
    if (stay) return { content: stay };
    if (/已取消/.test(text)) return { content: `${cancelledReply(text)}还需要我帮你看看别的酒店吗？` };
    if (/已支付成功/.test(text)) {
      return { content: '太好啦，订单已经确认！我去泡个温泉庆祝一下 ♨ 要帮你排排那天的行程，或者叫车去酒店吗？回复「帮我规划一下那天的行程」或「帮我叫车去酒店」就行。' };
    }
    return { content: noticeAck(text) };
  }
  const reply = route(text, messages, tools);
  const notice = !reply.toolCalls && unansweredNotice(messages);
  return notice ? { content: `${noticeAck(notice)}\n${reply.content}` } : reply;
}
