import { todayIn, addDays, isValidDate, dayOfWeek, nightsBetween } from '../util/dates.js';
import { findHoliday } from '../services/hotels/holidays.js';
import { formatUsd } from '../util/money.js';

/**
 * Deterministic fake LLM implementing the llm/client.js chat() contract, for agent/server/e2e tests and the no-key
 * demo.
 *
 *   const llm = createScriptedLlm((messages, tools) => ({ content: 'Hi', toolCalls: [{ name, arguments }] }));
 *   const llm = createScriptedLlm([{ toolCalls: [...] }, { content: '...' }]);  // one entry per chat() call
 *
 * A step may be an object { content?, toolCalls?, reasoningContent?, error?, errorAfterText? }, an Error (thrown),
 * or a function (messages, tools) → step. Text is streamed through onTextDelta in small chunks.
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
// demoScript: a small rule-based "model" for the e2e smoke test and the no-key demo
// ---------------------------------------------------------------------------

// City names as people write them; a neighborhood alias also becomes the search's `near`.
const CITIES = [
  ['New York', ['new york city', 'new york', 'nyc', 'manhattan']],
  ['Los Angeles', ['los angeles', 'l.a.', 'la', 'hollywood', 'santa monica']],
  ['San Francisco', ['san francisco', 'sf', 'san fran']],
  ['Las Vegas', ['las vegas', 'vegas']],
  ['Miami', ['miami beach', 'south beach', 'miami']],
  ['Orlando', ['orlando', 'disney world']],
  ['Chicago', ['chicago']],
  ['Seattle', ['seattle']],
  ['Boston', ['boston']],
  ['Washington DC', ['washington dc', 'washington d.c.', 'washington', 'dc', 'd.c.']],
  ['New Orleans', ['new orleans', 'nola']],
  ['Honolulu', ['honolulu', 'waikiki', 'oahu', 'hawaii']],
  ['San Diego', ['san diego']],
  ['Nashville', ['nashville']],
  ['Austin', ['austin']],
  ['Denver', ['denver']],
];
// Aliases that name a part of the city rather than all of it.
const NEIGHBORHOOD_ALIASES = { 'miami beach': 'Miami Beach', 'south beach': 'South Beach', hollywood: 'Hollywood', 'santa monica': 'Santa Monica', waikiki: 'Waikiki', 'disney world': 'Walt Disney World' };
const AIRPORT_CODES = {
  jfk: 'JFK Airport', lga: 'LaGuardia Airport', laguardia: 'LaGuardia Airport', ewr: 'Newark Airport', newark: 'Newark Airport', lax: 'LAX', sfo: 'SFO',
  las: 'Harry Reid International Airport', mia: 'Miami International Airport', mco: 'Orlando International Airport', ord: "O'Hare Airport", "o'hare": "O'Hare Airport",
  ohare: "O'Hare Airport", 'sea-tac': 'Seattle-Tacoma Airport', seatac: 'Seattle-Tacoma Airport', logan: 'Logan Airport', bos: 'Logan Airport', dca: 'Reagan National Airport',
  msy: 'New Orleans Airport', hnl: 'Honolulu Airport', san: 'San Diego Airport', bna: 'Nashville Airport', aus: 'Austin Airport', den: 'Denver Airport', dia: 'Denver Airport',
};
const CITY_AIRPORTS = {
  'New York': 'JFK Airport', 'Los Angeles': 'LAX', 'San Francisco': 'SFO', 'Las Vegas': 'Harry Reid International Airport', Miami: 'Miami International Airport',
  Orlando: 'Orlando International Airport', Chicago: "O'Hare Airport", Seattle: 'Seattle-Tacoma Airport', Boston: 'Logan Airport', 'Washington DC': 'Reagan National Airport',
  'New Orleans': 'New Orleans Airport', Honolulu: 'Honolulu Airport', 'San Diego': 'San Diego Airport', Nashville: 'Nashville Airport', Austin: 'Austin Airport', Denver: 'Denver Airport',
};
const NOTICE_PREFIX = '[System notice — not from the user]';
const DEMO_GUEST = 'Alex Rivera';
const DEMO_EMAIL = 'alex.rivera@example.com';
// 555-0100 to 555-0199 are reserved for fiction.
const DEMO_PHONE = '(415) 555-0123';
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, another: 1, couple: 2 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, last: -1 };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Words a capitalized place capture must not be.
const NOT_PLACES = /^(?:the )?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|^(?:tonight|today|tomorrow|noon|midnight|i|we|my|night|nights|weekend)$/i;

function toInt(s) {
  if (s === undefined || s === null) return undefined;
  const w = String(s).toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w];
}

function systemText(messages) {
  return messages.find((m) => m.role === 'system')?.content || '';
}

/** Today as the system prompt states it (the user's date). */
function todayOf(messages) {
  const m = /Today is [^(\n]*\((\d{4}-\d{2}-\d{2})\)/.exec(systemText(messages));
  return m && isValidDate(m[1]) ? m[1] : todayIn();
}

/** True between midnight and 5:59 AM (the user's time, per the system prompt), when "tonight" is the night in progress. */
function lateNightOf(messages) {
  const m = /local time is (\d{1,2}):(\d{2}) (AM|PM)/.exec(systemText(messages));
  if (!m) return false;
  const h = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0);
  return h < 6;
}

function weekdayIndex(word) {
  return WEEKDAYS.indexOf(String(word).toLowerCase().slice(0, 3));
}

/**
 * Monday-based weeks, as in the system prompt: "this Friday" is the coming Friday; "next Friday" the one in the
 * following week; weekends start on Friday. Before 6 AM (`lateNight`) "tonight" is the night in progress, i.e.
 * yesterday's date.
 */
export function parseCheckIn(text, today, { lateNight = false } = {}) {
  const s = String(text).toLowerCase();
  const dow = dayOfWeek(today);
  const monday = addDays(today, -((dow + 6) % 7));
  let m;
  if ((m = /(\d{4}-\d{2}-\d{2})/.exec(s)) && isValidDate(m[1])) return m[1];
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/.exec(s))) {
    return nextDate(today, MONTHS.indexOf(m[1].slice(0, 3)) + 1, Number(m[2]));
  }
  if ((m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(s))) return nextDate(today, Number(m[1]), Number(m[2]));
  if (/day after tomorrow/.test(s)) return addDays(today, 2);
  if (/\btomorrow\b/.test(s)) return addDays(today, 1);
  if (/\btonight\b|\bright now\b/.test(s)) return lateNight ? addDays(today, -1) : today;
  if (/\btoday\b/.test(s)) return today;
  if (/\bnext weekend\b/.test(s)) return addDays(monday, 11);
  if (/\bthis weekend\b|\bthe weekend\b|\bweekend\b/.test(s)) return dow === 6 || dow === 0 ? today : addDays(monday, 4);
  if ((m = /\b(this|next|coming|on)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.exec(s))) {
    const target = (weekdayIndex(m[2]) + 6) % 7;
    if (m[1] === 'next') return addDays(monday, 7 + target);
    let d = addDays(monday, target);
    if (d < today) d = addDays(d, 7);
    return d;
  }
  const holiday = findHoliday(s, today);
  if (holiday) return holiday.start < today ? today : holiday.start;
  return undefined;
}

/** A month-day this year, or next year once it is well in the past (as the tools do). */
function nextDate(today, month, day) {
  let d = `${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (isValidDate(d) && d < today && nightsBetween(d, today) > 31) d = `${Number(today.slice(0, 4)) + 1}${d.slice(4)}`;
  return isValidDate(d) ? d : undefined;
}

function findCityIn(text) {
  const s = ` ${String(text).toLowerCase().replace(/[’]/g, "'").replace(/[,.!?;:()]+/g, ' ').replace(/\s+/g, ' ')} `;
  let best = null;
  for (const [name, aliases] of CITIES) {
    for (const alias of aliases) {
      const at = s.indexOf(` ${alias} `);
      if (at !== -1 && (!best || at < best.at || (at === best.at && alias.length > best.alias.length))) best = { name, alias, at };
    }
  }
  return best;
}

function nightsOf(text) {
  const s = String(text).toLowerCase();
  const m = /\b(\d+|a|an|one|two|three|four|five|six|seven)[- ]nights?\b/.exec(s) || /\bfor (\d+|two|three|four|five|six|seven) (?:days|nights)\b/.exec(s);
  if (m) return toInt(m[1]) || 1;
  if (/\bfor a week\b|\ba week\b/.test(s)) return 7;
  if (/\bweekend\b/.test(s)) return 2;
  return 1;
}

/** Search args from free text like 'This Friday in New York near Times Square, two nights, under $300'. */
export function parseSearch(text, today, { lateNight = false } = {}) {
  const found = findCityIn(text);
  if (!found) return null;
  const args = { city: found.name };
  const lower = String(text).toLowerCase();
  const near = /\b(near|by|close to|next to|around|on|at)\s+((?:the\s+)?[A-Z0-9][\w'’.&-]*(?:\s+(?:[A-Z0-9][\w'’.&-]*|of|the|de|du|la))*)/.exec(String(text));
  const place = near ? near[2].replace(/\s+(?:of|the|de|du|la)$/i, '').trim() : '';
  // 'near Disney World' is a place even though it also names its city; 'in New York' is just the city.
  const asCity = place ? findCityIn(place) : null;
  const onlyCity = asCity && asCity.alias.startsWith(place.toLowerCase()) && !NEIGHBORHOOD_ALIASES[asCity.alias];
  const neighborhood = Object.keys(NEIGHBORHOOD_ALIASES).find((a) => ` ${lower.replace(/[^a-z' ]+/g, ' ')} `.includes(` ${a} `));
  if (place && !NOT_PLACES.test(place) && !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(place) && !onlyCity) {
    args.near = place;
    if (near[1] === 'on' || near[1] === 'at') args.radius_miles = 0.5;
  } else if (neighborhood) {
    args.near = NEIGHBORHOOD_ALIASES[neighborhood];
  }
  const checkIn = parseCheckIn(text, today, { lateNight });
  const nights = nightsOf(text);
  if (checkIn) {
    args.check_in = checkIn;
    args.check_out = addDays(checkIn, nights);
  } else if (nights > 1) {
    args.check_in = today;
    args.check_out = addDays(today, nights);
  }
  let m;
  if ((m = /\bfamily of (\d|three|four|five|six)\b/.exec(lower))) {
    args.adults = 2;
    args.children = Math.max(0, toInt(m[1]) - 2);
  }
  if ((m = /\b(\d+|one|two|three|four|five|six)\s+adults?\b/.exec(lower))) args.adults = toInt(m[1]);
  else if ((m = /\b(\d+|two|three|four|five|six)\s+(?:of us|people|guests|persons)\b/.exec(lower))) args.adults = toInt(m[1]);
  else if (/\b(?:just me|solo|by myself|alone)\b/.test(lower)) args.adults = 1;
  if ((m = /\b(\d+|a|an|one|two|three|four|five|six)\s+(?:kids?|children|child)\b/.exec(lower))) args.children = toInt(m[1]);
  if ((m = /\b(\d+|two|three|four|five)\s+rooms\b/.exec(lower))) args.rooms = toInt(m[1]);
  m = /\b(?:under|below|less than|max(?:imum)?|up to|at most|no more than|within)\s*\$?\s*(\d{2,5})\b/.exec(lower) || /\$\s*(\d{2,5})\s*(?:or less|max|tops)\b/.exec(lower);
  if (m) args.price_max = Number(m[1]);
  const cats = [];
  if (/\bbudget\b/.test(lower)) cats.push('budget');
  if (/\bmid-?range\b|\bmidscale\b|\b3[- ]star\b/.test(lower)) cats.push('midscale');
  if (/\bupscale\b|\b4[- ]star\b|\bfour[- ]star\b/.test(lower)) cats.push('upscale');
  if (/\bluxury\b|\b5[- ]star\b|\bfive[- ]star\b/.test(lower)) cats.push('luxury');
  if (cats.length) args.categories = cats;
  if (/\bcheap(?:est)?\b|\blow(?:est)? price|\binexpensive\b/.test(lower)) args.sort = 'price_asc';
  else if (/\b(?:best|top|highest)[- ]rated\b/.test(lower)) args.sort = 'rating';
  const wishes = [];
  if (/\bpool\b/.test(lower)) wishes.push('pool');
  if (/\bbreakfast\b/.test(lower)) wishes.push('free breakfast');
  if (/\bparking\b/.test(lower)) wishes.push('parking');
  if (/\bpets?\b|\bdog\b/.test(lower)) wishes.push('pet-friendly');
  if (args.children || /\bkids?\b|\bfamily\b|\bchildren\b/.test(lower)) wishes.push('family-friendly');
  if (wishes.length) args.keyword = wishes.join(' ');
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

// Hotels named in the reply (a numbered list, so Reply "Book #1" becomes one button per hotel), and room types.
const SHOWN = 3;
// The hotels card shows the search's hotels in order: "#N" is the Nth on the card.
const CARD_HOTELS = 6;
const FALLBACK_TEXT = 'I can find and book hotels, pull up your trips or cancel one. Tell me where and when, or Say "This Friday in New York near Times Square, two nights, under $300" or "Tonight in Las Vegas on the Strip, cheap".';
const QUOTE_SENT_TEXT = "Here's your booking summary. Check it over, then tap Confirm booking.";

const PICK_RE = /^(?:i'?ll (?:take|go with|book)|i want|i'?d like|let'?s (?:do|go with|book)|go with|book|pick|choose|select|option|number|no\.?|try|show me)?\s*(?:#\s*|no\.\s*|number\s*)?([1-9])(?:\s*please)?$/;
const ORDINAL_RE = /^(?:i'?ll (?:take|go with|book)|book|pick|choose|go with|let'?s (?:do|go with|book))?\s*the (first|second|third|fourth|fifth|sixth|last) (?:one|hotel|option|room|choice)?(?:\s*please)?$/;
const ROOMS_RE = /^(?:(?:search|look for|check|try|book|show|get|use|with)\s+)?(\d|one|two|three|four|five) rooms?(?:\s*please)?$/;
const YES_RE = /^(?:yes|yeah|yep|yup|sure|ok|okay|book it|do it|let'?s do it|go ahead|sounds good|that one|this one|perfect|great|yes please|confirm|book that|let'?s book it|please book it|works for me)(?:\s*please)?$/;
const CHEAPER_RE = /\b(?:cheaper|less expensive|lower price|more affordable)\b/;

/** The text without surrounding spaces and punctuation, lower case, for matching short replies like 'Book #1!'. */
function compact(text) {
  return String(text).toLowerCase().replace(/[’]/g, "'").replace(/[.,!?~:;"]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A request to cancel a booking (not a question about cancellation terms). */
function isCancelRequest(text) {
  const t = compact(text);
  if (!/\bcancel\b/.test(t)) return false;
  if (/\bfree cancellation\b|\bcancellation policy\b|\bcan i cancel\b|\bcan we cancel\b|\bif i cancel\b/.test(t)) return false;
  return /\b(?:booking|reservation|order|trip|stay|that|it|my|this|the last|#\s*\d|\d)\b/.test(t) || t === 'cancel';
}

function stayPhrase(c) {
  return c.dates_assumed ? `I assumed ${c.stay_text}` : c.stay_text;
}

/** The hotels a search reply names: the first three with a price (sold-out ones come last on the card). */
function hotelChoices(c) {
  return (c.hotels || []).filter((h) => h.hotel_id && h.price_from != null).slice(0, SHOWN);
}

/** A room type's rate to offer: the cheapest that can still be cancelled for free, else the cheapest. */
function bestRate(rt) {
  const open = (rt.rates || []).filter((r) => r.available !== false && r.rate_id && Number.isFinite(r.total_price)).sort((a, b) => a.total_price - b.total_price);
  return open.find((r) => r.free_cancel === true) || open[0] || null;
}

/**
 * "#N" after a rooms reply: the Nth room type on the rooms card, which lists the room types that still have a
 * bookable rate (in the tool result's order). Derived from the stored tool result alone.
 */
function roomChoices(c) {
  return (c.room_types || []).map((rt) => ({ room: rt.room, rate: bestRate(rt) })).filter((x) => x.rate);
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

function cancelText(r) {
  if (r.free_cancel === true) {
    const until = /until (.+)$/.exec(r.cancel || '')?.[1];
    return until ? `free cancellation until ${until}` : 'free cancellation';
  }
  return /non-refundable/i.test(r.cancel || '') ? 'non-refundable' : 'no free cancellation anymore';
}

function partyText(c) {
  const a = `${c.adults} adult${c.adults === 1 ? '' : 's'}`;
  return c.children ? `${a} and ${c.children} ${c.children === 1 ? 'child' : 'children'}` : a;
}

function partyArgs(c) {
  return { adults: c.adults, ...(c.children ? { children: c.children } : {}), rooms: c.rooms };
}

/** The place as the user put it ('the Strip', 'Times Square'), else as the search resolved it. */
function placeOf(c, args) {
  return (typeof args?.near === 'string' && args.near.trim()) || c.near || '';
}

function hotelsReply(c, args) {
  const hotels = c.hotels || [];
  const list = hotelChoices(c);
  const near = placeOf(c, args);
  if (!list.length) {
    if (hotels.some((h) => h.fits === false)) {
      const need = hotels.find((h) => Number.isFinite(h.need_rooms))?.need_rooms || (c.rooms || 1) + 1;
      return `For ${partyText(c)}, ${c.rooms > 1 ? `${c.rooms} rooms aren't` : "one room isn't"} enough at ${near ? 'the hotels nearby' : 'these hotels'} (they're not sold out). Want me to look for ${need} rooms? Reply "${need} rooms".`;
    }
    return "Nothing's available around there right now. Want to try another area, other dates or a bigger budget?";
  }
  const top = list[0];
  const why = near && top.distance ? `${top.distance} from ${near}, rated ${top.rating}` : `rated ${top.rating}, ${formatUsd(top.price_from)} a night`;
  return [
    `Here are a few ${near ? `near ${near}` : `in ${c.city}`} (${stayPhrase(c)}); photos and prices are on the cards:`,
    ...list.map((h, i) => `${i + 1}. ${h.name}`),
    `I'd go with #1: ${why}. Which one would you like? Reply "Book #1" and I'll pull up the rooms.`,
  ].join('\n');
}

function roomsReply(c) {
  const list = roomChoices(c);
  if (!list.length) {
    // Too many guests per room is not sold out: say so and offer more rooms.
    const blocked = (c.room_types || []).flatMap((rt) => rt.rates || []);
    if (blocked.some((r) => /too many guests/i.test(r.reason || ''))) {
      const max = Math.max(...(c.room_types || []).map((rt) => Number(rt.max_guests) || 0));
      const n = max > 0 ? Math.ceil(((c.adults || 0) + (c.children || 0)) / max) : (c.rooms || 1) + 1;
      return `${c.hotel_name} can't fit ${partyText(c)} in ${c.rooms > 1 ? `${c.rooms} rooms` : 'one room'} (it's not sold out): rooms sleep up to ${max}. Want me to check ${n} rooms? Reply "${n} rooms".`;
    }
    return `${c.hotel_name} is sold out for those dates. Want to try other dates or another hotel?`;
  }
  const shown = list.slice(0, SHOWN);
  const pick = recommendedRoom(shown);
  const { room, rate } = shown[pick];
  const others = shown.map((_, i) => i).filter((i) => i !== pick).map((i) => `"#${i + 1}"`);
  const alternatives = others.length ? `${others.length > 1 ? `, ${others.slice(0, -1).join(', ')}` : ''} or ${others[others.length - 1]}` : '';
  return `${c.hotel_name}, ${c.stay_text}. I'd take #${pick + 1}: ${room} · ${rate.breakfast === 'included' ? 'breakfast included' : 'room only'} · ${cancelText(rate)}, ${formatUsd(rate.total_price)} in total. `
    + `Want me to book it? Say "Yes"${alternatives}.`;
}

function ordersReply(c) {
  const orders = (c.orders || []).slice(0, 5);
  if (!orders.length) return "You don't have any bookings yet. Tell me where and when you're going and I'll find you a place.";
  const count = c.count ?? orders.length;
  const lines = orders.map((o, i) => `${i + 1}. ${o.hotel} · ${o.stay_text || o.check_in} · ${formatUsd(o.total_price)} · ${o.status}`);
  const tail = [count > orders.length ? `Plus ${count - orders.length} more.` : '', orders.some(isOpenOrder) ? 'To cancel one, Reply "Cancel #N".' : ''].filter(Boolean).join(' ');
  return [`You have ${count} booking${count === 1 ? '' : 's'}:`, ...lines, ...(tail ? [tail] : [])].join('\n');
}

function cancelReply(c) {
  if (!c.cancellable) return `That one can't be cancelled right now: ${c.policy}.`;
  if (c.status === 'Awaiting payment') return `${c.hotel} isn't paid yet, so cancelling is free. If you're sure, tap Confirm cancellation.`;
  if (c.refund <= 0) return `${c.hotel} is non-refundable, so cancelling forfeits the full ${formatUsd(c.penalty)}. If you're sure, tap Confirm cancellation.`;
  return `${c.hotel} ${c.penalty > 0 ? `costs ${formatUsd(c.penalty)} to cancel now, and ${formatUsd(c.refund)} comes back` : `cancels for free, with ${formatUsd(c.refund)} back`}. If you're sure, tap Confirm cancellation.`;
}

function placesReply(c) {
  const list = (c.places || []).slice(0, SHOWN);
  if (!list.length) return "I couldn't find that in the city guide. Want to try another word?";
  const lines = list.map((p, i) => `${i + 1}. ${p.name}${p.area ? ` · ${p.area}` : ''}`);
  return [`A few spots in ${c.city}:`, ...lines, 'Opening hours and tickets are on the official sites. Want a hotel nearby? Just ask.'].join('\n');
}

function isOpenOrder(o) {
  return o.status === 'Confirmed' || o.status === 'Awaiting payment';
}

/** After a list_orders that a cancel request started: the order to cancel ("#N", else the newest open one). */
function cancelFromOrders(c, text, tools) {
  const orders = c.orders || [];
  if (!orders.length) return { content: "You don't have any bookings, so there's nothing to cancel." };
  const n = toInt(/(?:#|number |no\. ?)\s*(\d)\b/.exec(compact(text))?.[1]);
  const target = n ? orders[n - 1] : orders.find((o) => o.status === 'Confirmed') || orders.find((o) => o.status === 'Awaiting payment');
  if (!target) return { content: n ? `You have ${orders.length} booking${orders.length === 1 ? '' : 's'}; Reply "Cancel #1" to pick one.` : "You don't have a booking that can be cancelled right now." };
  if (!isOpenOrder(target)) return { content: `#${n} is already ${target.status.toLowerCase()}, so there's nothing to cancel.` };
  if (!has(tools, 'prepare_cancellation')) return { content: ordersReply(c) };
  return call('prepare_cancellation', { order_id: target.order_id });
}

// ---- after booking: the stay ----

const MEAL_TIMES = { breakfast: '08:00', lunch: '12:30', dinner: '19:00' };

/** The first clock time in a message: '7am' → '07:00', '7:30 pm' → '19:30', 'noon' → '12:00', '18:30' → '18:30'. */
export function clockOf(text) {
  const s = String(text).toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(s)) return '12:00';
  if (/\bmidnight\b/.test(s)) return '00:00';
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/.exec(s);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === 'p') h += 12;
    const min = Number(m[2] || 0);
    return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
  }
  if ((m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s))) return `${m[1].padStart(2, '0')}:${m[2]}`;
  if ((m = /\bat (\d{1,2})\b(?!:|\/)/.exec(s))) {
    const h = Number(m[1]);
    // "at 7" in a morning context is 7 AM; "at 7" for dinner is 7 PM.
    if (h >= 1 && h <= 12) return `${String(/dinner|evening|tonight/.test(s) && h < 12 ? h + 12 : h).padStart(2, '0')}:00`;
  }
  return null;
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
    { time: '11:00', title: `Arrive in ${trip.city || 'town'}`, note: 'Drop your bags at the hotel first' },
    { time: '12:00', title: 'Leave bags at the hotel', ...(trip.hotel ? { place: trip.hotel } : {}) },
    { time: '12:30', title: 'Lunch', place: where ? `Near ${where}` : 'Near the hotel' },
    { time: '14:00', title: where ? `Explore ${where}` : 'Walk around the neighborhood', ...(where ? { place: where } : {}), note: 'Take it slow and rest when you need to' },
    { time: '18:30', title: 'Dinner', note: 'Then back to the hotel for an early night' },
  ];
  // "That day" is the arrival day while it is still ahead and the guest is not in yet; otherwise the tool plans today.
  const date = trip.checkIn && trip.checkIn >= today && !trip.checkedIn ? { date: trip.checkIn } : {};
  return call('plan_itinerary', { title: `${where || trip.city || 'Your'} day plan`, ...date, items });
}

function airportOf(text, trip) {
  const s = ` ${String(text).toLowerCase().replace(/[^a-z' -]+/g, ' ')} `;
  for (const [code, name] of Object.entries(AIRPORT_CODES)) if (s.includes(` ${code} `)) return name;
  return CITY_AIRPORTS[trip.city] || 'the airport';
}

function rideCall(text, trip, today) {
  const s = compact(text);
  const clock = clockOf(text);
  // A ride to the hotel before arrival day is for arrival day (unless the guest checked in early).
  const arrival = trip.checkIn && trip.checkIn > today && !trip.checkedIn ? { pickup_time: `${trip.checkIn} ${clock || '12:00'}` } : clock ? { pickup_time: clock } : {};
  if (/\bpick (?:me|us) up\b|\bairport pickup\b|\bpickup at\b|\bfrom the airport\b/.test(s)) return call('quote_ride', { kind: 'airport_pickup', from: airportOf(text, trip), ...arrival });
  if (/\bto the airport\b|\bto (?:jfk|lax|sfo|lga|ewr|ord|mco|mia)\b|\bairport\b/.test(s)) {
    return call('quote_ride', { kind: 'from_hotel', from: 'hotel', to: airportOf(text, trip), ...(clock ? { pickup_time: clock } : {}) });
  }
  if (/\b(?:to|back to) (?:the|my|our) hotel\b|\bto the inn\b|\bto the resort\b/.test(s)) return call('quote_ride', { kind: 'to_hotel', from: 'Current location', ...arrival });
  const to = /\b(?:ride|taxi|cab|car|uber|lyft|take me|take us|drive me|get me)\b.*?\bto\s+(.{2,40}?)(?:\s+at\s+.*)?$/.exec(s)?.[1];
  if (!to) return { content: 'Where to? Tell me the place, like "Get me a ride to Central Park".' };
  return call('quote_ride', { kind: 'taxi', from: trip.checkedIn && trip.hotel ? trip.hotel : 'Current location', to: to.replace(/\b\w/g, (c) => c.toUpperCase()), ...(clock ? { pickup_time: clock } : {}) });
}

function diningCall(text, trip, today, lateNight) {
  const s = compact(text);
  const kind = /breakfast|brunch/.test(s) ? 'breakfast' : /lunch/.test(s) ? 'lunch' : 'dinner';
  const date = parseCheckIn(text, today, { lateNight });
  const people = toInt(/\b(?:for|table for)\s+(\d+|two|three|four|five|six)\b/.exec(s)?.[1]);
  return call('reserve_dining', { kind, time: clockOf(text) || MEAL_TIMES[kind], people: people || trip.adults || 2, ...(date ? { date } : {}) });
}

function receiptCall(text) {
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0];
  return call('request_receipt', email ? { email } : {});
}

function reviewCall(text, messages) {
  const s = compact(text);
  const rating = /\b(?:bad|negative|poor|terrible)\b/.test(s) ? 2 : toInt(/\b([1-5]|one|two|three|four|five)[- ]stars?\b/.exec(s)?.[1]) || 5;
  const done = (name) => toolResults(messages).some((r) => r.name === name && !r.content.error);
  // Only what the user said and what happened in this chat; no invented experiences.
  const said = /\b(?:say|saying|mention|that)\s+(.{3,80})$/.exec(String(text).trim().replace(/[.!]+$/, ''))?.[1];
  if (rating <= 3) return call('draft_review', { rating, text: `The stay was just okay${said ? `: ${said}` : ''}. Hope it gets better.`, tags: [] });
  const facts = [said && said[0].toUpperCase() + said.slice(1), done('check_in') && 'Check-in was quick', done('request_service') && 'Housekeeping brought what we asked for fast', done('reserve_dining') && 'Booking a table was easy'].filter(Boolean);
  const tags = [done('check_in') && 'Quick check-in', done('request_service') && 'Helpful staff'].filter(Boolean);
  return call('draft_review', { rating, text: `${['A really nice stay', ...facts].join('. ')}. Would stay again.`, tags: tags.length ? tags : ['Recommended'] });
}

// Checking in or out happens on a plain request ("I'd like to check out", "I'm here, check me in"); a question about
// it (what time, how late, what to bring) is answered from the stay info instead.
const CHECK_IN_RE = /\bcheck (?:me|us) in\b|\bi'?m here\b|\bwe'?re here\b|\bi'?ve arrived\b|\bwe'?ve arrived\b|\bjust arrived\b|^check in(?: please| now)?$|\bplease check (?:me|us) in\b/;
const CHECK_OUT_RE = /\bcheck (?:me|us) out\b|\b(?:i'?d like|i want|i'?m ready|we'?re ready|we'?d like|ready) to check ?out\b|^check ?out(?: please| now)?$|\blet'?s check out\b/;
const QUESTION_RE = /\bwhat time\b|\bwhen\b|\bhow late\b|\bhow early\b|\buntil when\b|\blate check-?out\b|\bcheck ?out late\b|\bcan (?:i|we)\b|\bwhat do i need\b|\bwhat should i bring\b|\bdo i need\b|\bbring\b/;

/** A phrase of the stay (only when its tool is offered), or null. */
function journeyRoute(text, messages, tools) {
  const s = compact(text);
  const today = todayOf(messages);
  const lateNight = lateNightOf(messages);
  const can = (name) => has(tools, name);
  if (can('quote_ride') && /\b(?:ride|taxi|cab|uber|lyft|pick (?:me|us) up|airport pickup|car to|drive (?:me|us))\b/.test(s)) return rideCall(text, tripOf(messages), today);
  if (can('set_wakeup_call') && /\bwake (?:me|us)? ?up\b|\bwake-?up call\b|\balarm\b/.test(s)) {
    // "tomorrow" before 6 AM is the coming morning.
    const date = /\btomorrow\b/.test(s) ? (lateNight ? today : addDays(today, 1)) : undefined;
    return call('set_wakeup_call', { time: clockOf(text) || '07:00', ...(date ? { date } : {}) });
  }
  if (can('request_early_checkin') && /\bcheck(?:-| )?in early\b|\bearly check-?in\b|\bcheck in before\b|\b(?:i|we) land at\b|\b(?:i|we)'?ll (?:be|get) there (?:at|around|by)\b|\barrive (?:at|around|by) \d/.test(s)) {
    return call('request_early_checkin', { arrival_time: clockOf(text) || '12:00' });
  }
  if (can('check_in') && CHECK_IN_RE.test(s) && !QUESTION_RE.test(s)) return call('check_in', {});
  // "A hotel with breakfast" is a hotel search, not a table.
  if (can('reserve_dining') && !/\bhotels?\b/.test(s) && (/\b(?:book|reserve|get|make|need)\b.*\b(?:breakfast|brunch|lunch|dinner|table)\b/.test(s) || /\btable for\b/.test(s))) {
    return diningCall(text, tripOf(messages), today, lateNight);
  }
  if (can('get_stay_info') && (/\bwi-?fi\b|\bpassword\b|\binternet\b|\bfront desk\b|\bpool\b|\bgym\b|\bfitness\b|\blaundry\b|\bwhen is breakfast\b|\bbreakfast (?:hours|time)\b|\bwhat time is breakfast\b/.test(s)
    || (/\bcheck-?(?:in|out)\b|\bcheck (?:in|out)\b/.test(s) && QUESTION_RE.test(s)))) return call('get_stay_info', {});
  if (can('request_service') && /\btowels?\b|\btooth ?brush|\btooth ?paste\b|\bpillows?\b|\bblankets?\b|\bslippers\b|\bhangers\b|\btoilet paper\b|\bshampoo\b|\bsoap\b|\bwater\b|\bhousekeeping\b|\bclean (?:the|my|our) room\b|\bcrib\b|\biron\b|\bhair ?dryer\b|\bcharger\b|\bsend up\b|\bbring up\b/.test(s)) {
    return call('request_service', { items: String(text).trim() });
  }
  if (can('prepare_extension') && /\bone more night\b|\banother night\b|\bmore nights?\b|\bextend (?:my|the|our)? ?stay\b|\bextra nights?\b|\bstay (?:an?|one|two|three|\d) (?:more|extra) nights?\b|\bstay longer\b/.test(s)) {
    return call('prepare_extension', { nights: toInt(/\b(\d|one|two|three|four|five|six|seven|another|a)\s+(?:more|extra)\s+nights?\b/.exec(s)?.[1]) || 1 });
  }
  if (can('check_out') && CHECK_OUT_RE.test(s) && !QUESTION_RE.test(s)) return call('check_out', {});
  if (can('request_receipt') && /\breceipt\b|\binvoice\b|\bfolio\b/.test(s)) return receiptCall(text);
  if (can('get_membership') && /\bpoints\b|\brewards\b|\bmy (?:level|tier|status)\b|\bmembership\b|\bwhat (?:level|tier)\b|\b(?:am i|i'?m) (?:a )?(?:gold|platinum)\b/.test(s)) return call('get_membership', {});
  if (can('draft_review') && /\b(?:write|leave|post|draft|give)\b.*\breview\b|\breview (?:it|the hotel|my stay|our stay)\b/.test(s)) return reviewCall(text, messages);
  if (can('plan_itinerary') && /\bplan (?:my|the|our) day\b|\bitinerary\b|\bday plan\b|\bwhat should (?:i|we) do\b|\bplan (?:the|my|our) trip\b/.test(s)) return itineraryCall(tripOf(messages), today);
  return null;
}

/** The reply after a stay tool: one or two light sentences; the card has the details. Null for other tools. */
function stayReply(name, c, messages) {
  switch (name) {
    case 'plan_itinerary': return `Your plan for ${c.date_text} is ready, in time order on the card. Want to change anything?`;
    case 'quote_ride': return `${c.ride}: about ${c.minutes} minutes, ${formatUsd(c.fare)}. Tap Confirm ride if that works.`;
    case 'request_early_checkin':
      return c.status === 'Confirmed' ? `Done! ${c.note}.` : `${c.note}.`;
    case 'check_in':
      if (c.already_checked_in) return `You're already checked in: room ${c.room_number}.`;
      return `${c.early ? "You're checked in early" : "You're checked in"}: room ${c.room_number}. Your digital key and the Wi-Fi are on the card. Need anything? Say "Two more towels please" or "Book breakfast for tomorrow".`;
    case 'request_service': return `On it! ${c.items.join(', ')} will be at room ${c.room_number} in about 5 minutes.`;
    case 'reserve_dining': {
      let pay = c.price_per_person ? `It's ${formatUsd(c.price_per_person)} per person, charged to your room.` : 'Breakfast is included in your rate.';
      if (c.covered_by_rate) pay = `Your rate covers ${c.covered_by_rate} of you; the other ${c.people - c.covered_by_rate} are ${formatUsd(c.price_per_person)} each, charged to your room.`;
      // 'Harvest Table, Lobby level' reads as a name; 'Breakfast area, Lobby level' as a place.
      const where = /^(?:breakfast|lobby|courtyard)/i.test(c.restaurant) ? `in the ${c.restaurant.replace(/^\w/, (x) => x.toLowerCase())}` : `at ${c.restaurant}`;
      return `Booked: ${c.meal.toLowerCase()} for ${c.people} ${where}, ${c.at}. ${pay}`;
    }
    case 'set_wakeup_call': return `Done: your wake-up call is set for ${c.at} ⏰`;
    case 'get_stay_info': {
      const q = compact(lastUserText(messages));
      if (/wi-?fi|password|internet/.test(q)) return `The Wi-Fi is ${c.wifi.ssid}, password ${c.wifi.password}. You can copy it from the card.`;
      if (/breakfast/.test(q)) {
        const [hours, place, price] = String(c.breakfast).split(' · ');
        return `Breakfast is ${hours} at ${place}${price === 'included in your rate' ? ", and it's included in your rate" : `, ${price}`}.`;
      }
      if (/check-?out|check out/.test(q)) {
        if (/bag|luggage/.test(q)) return `Sure: after you check out (by ${c.checkout_time}), leave your bags with the front desk.`;
        if (/late|extend|later/.test(q)) return `Checkout is at ${c.checkout_time}. For a late checkout, ask the front desk; it's often possible until noon.`;
        return `Checkout is at ${c.checkout_time}.`;
      }
      if (/check-?in|check in/.test(q)) {
        if (/bring|need|id\b|documents?/.test(q)) return "Just bring a photo ID. When you get there, say \"I'm here, check me in\" and I'll do the rest.";
        return c.checked_in ? `You're already in room ${c.room_number}.` : `Check-in starts at ${c.checkin_time}; if you're early, the front desk can hold your bags.`;
      }
      if (/front desk|phone|call/.test(q)) return `The front desk is ${c.front_desk}.`;
      const facility = (c.facilities || []).find((f) => q.split(' ').some((w) => w.length > 3 && f.toLowerCase().includes(w)));
      if (facility) return `${facility.split(' · ').join(', ')}.`;
      return 'All the hotel info is on the card. Anything else you want to know?';
    }
    case 'prepare_extension': return `${c.nights === 1 ? 'One more night' : `${c.nights} more nights`} is ${formatUsd(c.price)}. Tap Confirm extension if that works.`;
    case 'check_out':
      return `You're checked out! ${formatUsd(c.total_paid)} in total${c.due > 0 ? `; the ${formatUsd(c.due)} on your room was settled with ${c.settled_by} (test mode)` : ''}, and you earned ${c.points_earned.toLocaleString('en-US')} points. Want a receipt or to leave a review? Say "Email me a receipt" or "Write a review".`;
    case 'request_receipt':
      return `Your receipt (${formatUsd(c.amount)}) is ${c.status === 'Sent' ? 'in' : 'on its way to'} ${c.email}${c.status === 'Sent' ? "'s inbox" : ''}.`;
    case 'get_membership':
      return `You're ${c.level === 'Member' ? `a ${c.program || 'Nana Rewards'} Member` : `a ${c.level} member of ${c.program || 'Nana Rewards'}`} with ${Number(c.points).toLocaleString('en-US')} points${c.next_level ? `; ${Number(c.points_to_next).toLocaleString('en-US')} more gets you to ${c.next_level}` : ', the top level'}.`;
    case 'draft_review': return "Here's a draft. Edit anything you like, then tap Post review.";
    default: return null;
  }
}

/** Stay errors the demo can help with; others are passed on as they are. */
function stayErrorReply(error) {
  if (/haven't checked in/i.test(error)) return 'You\'re not checked in yet. Want me to check you in first? Say "Check me in".';
  if (/no confirmed booking/i.test(error)) return "You don't have a confirmed booking yet. Tell me where and when you're going, and once it's booked I'll take care of the rest.";
  if (/which email/i.test(error)) return 'Which email should I send the receipt to?';
  return null;
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The reply once the last tool result is in. */
function afterTool(messages, tools) {
  const [r] = toolResults(messages);
  const c = r.content;
  if (c.error) return { content: stayErrorReply(c.error) || `Sorry, ${lowerFirst(String(c.error))}.` };
  switch (r.name) {
    case 'search_hotels': return { content: hotelsReply(c, r.args) };
    case 'get_hotel_rooms': return { content: roomsReply(c) };
    case 'prepare_booking': return { content: QUOTE_SENT_TEXT };
    case 'list_orders': {
      const text = lastUserText(messages);
      return isCancelRequest(text) ? cancelFromOrders(c, text, tools) : { content: ordersReply(c) };
    }
    case 'prepare_cancellation': return { content: cancelReply(c) };
    case 'search_places': return { content: placesReply(c) };
    default: return { content: stayReply(r.name, c, messages) || 'All set. Anything else I can do?' };
  }
}

const PLACE_WORDS = [
  [/\bthings to do\b|\bwhat to do\b|\bsights?\b|\battractions?\b|\bsightseeing\b/, 'sights'],
  [/\bwhere to eat\b|\bfood\b|\brestaurants?\b|\beat\b/, 'food'],
  [/\bbars?\b|\bnightlife\b|\blive music\b/, 'nightlife'],
  [/\bmuseums?\b/, 'museums'],
  [/\btrain station\b|\bstation\b/, 'train station'],
];

/** City from the message, else from the most recent search/rooms/booking result. */
function cityOf(text, messages) {
  const direct = findCityIn(text)?.name;
  if (direct) return direct;
  for (const r of toolResults(messages)) {
    const city = r.content.city || r.args.city;
    if (typeof city === 'string' && city) return city;
  }
  return null;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return String(messages[i].content || '');
  return '';
}

/**
 * The machine-readable part of a card-tap message (docs/US-CONTRACT.md §5):
 * '… — Fri, Nov 6 to Sun, Nov 8, 2 adults, 1 child (hotel_id: sim-nyc-004, rate_id: R1-BB-FC, check_in: 2026-11-06, check_out: 2026-11-08)'.
 */
export function parseButtonMessage(text) {
  const field = (key, re) => new RegExp(`\\b${key}:\\s*(${re})`).exec(text)?.[1];
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
  if ((m = /\b(\d+) adults?\b/.exec(text))) out.adults = Number(m[1]);
  if ((m = /\b(\d+) (?:children|child|kids?)\b/.exec(text))) out.children = Number(m[1]);
  if ((m = /\b(\d+) rooms?\b/.exec(text))) out.rooms = Number(m[1]);
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
    // Only the rate id: the rest comes from the last rooms result that offered it.
    const hotelName = /"([^"]+)"/.exec(text)?.[1];
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

/** The saved traveler details fill in name, email and phone (prepare_booking does that); otherwise the demo guest's. */
function withGuest(args, messages) {
  const sys = systemText(messages);
  if (!sys.includes('- Name: ')) args.guest_names = [DEMO_GUEST];
  if (!sys.includes('- Email: ')) args.email = DEMO_EMAIL;
  if (!sys.includes('- Phone: ')) args.contact_phone = DEMO_PHONE;
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

/** The demo's answer to a cancellation notice follows the money in it: no refund promised when there is none. */
export function cancelledReply(notice) {
  if (/wasn't paid|no charge/i.test(notice)) return "It's cancelled. It wasn't paid yet, so there's no charge.";
  const penalty = Number(/fee \$([\d,]+(?:\.\d+)?)/.exec(notice)?.[1]?.replace(/,/g, '') || 0);
  const refund = Number(/refund \$([\d,]+(?:\.\d+)?)/.exec(notice)?.[1]?.replace(/,/g, '') || 0);
  if (refund > 0) return `It's cancelled. ${penalty > 0 ? `After the ${formatUsd(penalty)} fee, ` : ''}${formatUsd(refund)} goes back to your original payment method (test mode).`;
  if (/no refund/i.test(notice)) return `It's cancelled. This rate was non-refundable, so there's no refund${penalty > 0 ? ` (fee ${formatUsd(penalty)})` : ''} (test mode).`;
  return "It's cancelled; the booking record has the details (test mode).";
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

/** "#N": the Nth hotel on the latest hotels card → its rooms, same dates and party. */
function pickHotel(n, messages, tools) {
  const search = toolResults(messages).find((r) => r.name === 'search_hotels' && !r.content.error);
  if (!search || !has(tools, 'get_hotel_rooms')) return null;
  const c = search.content;
  const shown = (c.hotels || []).filter((h) => h.hotel_id).slice(0, CARD_HOTELS);
  if (!shown.some((h) => h.price_from != null)) return { content: 'Nothing on that list is available. Want to try another area, other dates or a bigger budget?' };
  const h = shown[n === -1 ? shown.length - 1 : n - 1];
  if (!h) return { content: shown.length === 1 ? 'There was just one hotel; Reply "Book #1" to see its rooms.' : `The card has ${shown.length} hotels; pick one from 1 to ${shown.length}, like Reply "Book #1".` };
  if (h.price_from == null) return { content: `#${n} ${h.fits === false ? "can't fit everyone in the rooms you asked for" : 'is sold out for those dates'}. Want to look at another one?` };
  return call('get_hotel_rooms', { hotel_id: h.hotel_id, check_in: c.check_in, check_out: c.check_out, ...partyArgs(c) });
}

/** "#N" / "Yes" after a rooms reply: the rate offered for the Nth room type → prepare_booking. */
function pickRate(n, rooms, messages, tools) {
  if (!has(tools, 'prepare_booking')) return null;
  const c = rooms.content;
  const list = roomChoices(c);
  const pick = list[n === -1 ? list.length - 1 : n - 1];
  if (!pick) {
    if (!list.length) return { content: `${c.hotel_name} has nothing bookable right now. Want to look at another hotel?` };
    return { content: `The card has ${list.length} room type${list.length === 1 ? '' : 's'}; pick one from 1 to ${list.length}.` };
  }
  return call('prepare_booking', withGuest({ hotel_id: c.hotel_id, rate_id: pick.rate.rate_id, check_in: c.check_in, check_out: c.check_out, ...partyArgs(c) }, messages));
}

/** A bare "N", "#N" or "Book #N": the Nth line of whichever list came last. */
function pickLatest(n, messages, tools) {
  const latest = latestList(messages);
  if (!latest) return null;
  return latest.name === 'get_hotel_rooms' ? pickRate(n, latest, messages, tools) : pickHotel(n, messages, tools);
}

/** "Yes": take the recommendation of the latest list, unless a quote or an order notice already followed it. */
function sayYes(messages, tools) {
  const latest = latestList(messages);
  if (!latest) return null;
  if (latest.name === 'search_hotels') return pickHotel(1, messages, tools);
  if (lastNoticeAt(messages) > latest.at) return null;
  const quote = toolResults(messages).find((r) => r.name === 'prepare_booking' && !r.content.error);
  if (quote && quote.at > latest.at) return { content: 'The booking summary is already with you. Check it over, then tap Confirm booking.' };
  const choices = roomChoices(latest.content).slice(0, SHOWN);
  return pickRate(choices.length ? recommendedRoom(choices) + 1 : 1, latest, messages, tools);
}

/** "N rooms": the latest list again with N rooms. */
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

/** "Show cheaper ones": the latest search again, cheapest first. */
function cheaper(messages, tools) {
  const search = toolResults(messages).find((r) => r.name === 'search_hotels' && !r.content.error);
  if (!search || !has(tools, 'search_hotels')) return null;
  const { price_min: _min, ...args } = search.args;
  return call('search_hotels', { ...args, check_in: search.content.check_in, check_out: search.content.check_out, sort: 'price_asc' });
}

/** An order notice the user's message came right after (the notice has not been answered yet). */
function unansweredNotice(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  const prev = messages[i - 1];
  return prev?.role === 'user' && String(prev.content || '').startsWith(NOTICE_PREFIX) ? String(prev.content) : null;
}

/** The answer to a ride / extension / review / hotel notice (judged by its latest line), or null for an order notice. */
export function stayNoticeReply(notice) {
  const line = String(notice).split('\n').pop();
  if (/The user confirmed the ride/.test(line)) {
    const m = /Driver (.+?) in an? (.+?), plate ([A-Z0-9]+)/.exec(line);
    return m ? `Your ride is booked! ${m[1]} is coming in a ${m[2]} (plate ${m[3]}); check the plate before you get in.` : 'Your ride is booked! Check the plate before you get in.';
  }
  if (/The user extended the stay/.test(line)) {
    const until = /check-out is now ([^;]+);/.exec(line)?.[1];
    return `You're extended!${until ? ` Check-out is now ${until}.` : ''} Enjoy the extra time.`;
  }
  if (/The user posted a review/.test(line)) return 'Your review is posted. Thank you, and hope to see you again soon!';
  // The hotel's side (docs/MERCHANT.md): the front desk, an early check-in answered, a reply to the review.
  if (/The front desk checked the user in/.test(line)) {
    const room = /room (\d{3,5})/.exec(line)?.[1];
    return `The front desk checked you in${room ? `: room ${room}` : ''}. Your digital key and the Wi-Fi are on the card.`;
  }
  if (/The hotel confirmed early check-in/.test(line)) {
    const time = /at (\d{1,2}:\d{2} [AP]M)/.exec(line)?.[1];
    return `Good news: the hotel says you can check in${time ? ` at ${time}` : ' early'}.`;
  }
  if (/The hotel declined the user's early check-in/.test(line)) return "The hotel is full that day, so check-in is at 3:00 PM. If you arrive early, the front desk can hold your bags.";
  if (/The hotel replied to the user's review/.test(line)) return 'The hotel replied to your review; you can read it on the review card.';
  return null;
}

function noticeAck(notice) {
  const stay = stayNoticeReply(notice);
  if (stay) return stay;
  if (/was cancelled/.test(notice)) return cancelledReply(notice);
  if (/was paid and is confirmed/.test(notice)) return 'Booked! Enjoy the stay.';
  return 'Your booking is placed; finish the test payment to lock it in.';
}

function route(text, messages, tools) {
  if (has(tools, 'prepare_booking') && /\brate_id:/.test(text)) {
    const args = bookingArgs(text, messages);
    if (args) return call('prepare_booking', args);
    return { content: "I couldn't find that rate anymore. Tell me which hotel you'd like and I'll pull up the rooms again." };
  }
  if (has(tools, 'get_hotel_rooms') && /\bhotel_id:/.test(text)) return call('get_hotel_rooms', roomsArgs(text, messages));
  const t = compact(text);
  if (/\b(?:let me think|not yet|maybe later|hold on|i'?ll think about it)\b/.test(t)) return { content: "No rush. The quote holds for 15 minutes; just tell me when you're ready." };
  const orderId = /HA\d{14}/.exec(text)?.[0];
  if (has(tools, 'prepare_cancellation') && orderId && /\bcancel\b/i.test(text)) return call('prepare_cancellation', { order_id: orderId });
  if (has(tools, 'list_orders') && (isCancelRequest(text) || /\bmy (?:bookings?|trips?|orders?|reservations?)\b|\bbooking status\b/.test(t))) return call('list_orders', {});

  let m;
  let reply = null;
  if ((m = ROOMS_RE.exec(t))) reply = withRooms(toInt(m[1]), messages, tools);
  else if ((m = PICK_RE.exec(t))) reply = pickLatest(toInt(m[1]), messages, tools);
  else if ((m = ORDINAL_RE.exec(t))) reply = pickLatest(ORDINALS[m[1]], messages, tools);
  else if (YES_RE.test(t)) reply = sayYes(messages, tools);
  else if (CHEAPER_RE.test(t) && !findCityIn(text)) reply = cheaper(messages, tools);
  if (reply) return reply;
  const stay = journeyRoute(text, messages, tools);
  if (stay) return stay;

  const place = PLACE_WORDS.find(([re]) => re.test(t));
  // "A hotel near good food" is a hotel search; "food near the hotel" is a city-guide question.
  const hotelSearch = /\bhotels? (?:near|in|by|with|around|close to)\b|\b(?:find|book|search|need|want|looking for|show me)\b.*\bhotels?\b|\b(?:place|where) to stay\b|\broom\b/.test(t);
  const placeCity = place && !hotelSearch ? cityOf(text, messages) : null;
  if (placeCity && has(tools, 'search_places')) return call('search_places', { city: placeCity, keyword: place[1] });
  const search = parseSearch(text, todayOf(messages), { lateNight: lateNightOf(messages) });
  if (search && has(tools, 'search_hotels')) return call('search_hotels', search);
  return { content: FALLBACK_TEXT };
}

/**
 * Rule-based "model" that texts like the real one should (see the system prompt): a trip request with a city →
 * search_hotels → a short reply naming three hotels; "Book #N" / "#N" → get_hotel_rooms → one recommended rate;
 * "Yes" / "#N" → prepare_booking (the confirmation the user taps); "Cancel that booking" → list_orders →
 * prepare_cancellation; "My trips" → list_orders. After booking, the stay phrases of docs/US-CONTRACT.md §12 reach the
 * stay tools (plan, rides and airport pickups, early check-in, check-in, towels, wake-up calls, breakfast, Wi-Fi,
 * checkout questions, extensions, check-out, receipts, points, reviews). Short replies resolve against the latest
 * card, rebuilt from the tool results in the history. Card-tap messages (hotel_id / rate_id in (…)) work too.
 */
export function demoScript(messages, tools) {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return afterTool(messages, tools);

  const text = lastUserText(messages);
  if (text.startsWith(NOTICE_PREFIX)) {
    const stay = stayNoticeReply(text);
    if (stay) return { content: stay };
    if (/was cancelled/.test(text)) return { content: `${cancelledReply(text)} Want me to look for another hotel?` };
    if (/was paid and is confirmed/.test(text)) {
      return { content: 'Booked! Enjoy the stay. Want me to plan the day or get you a ride? Say "Plan my day" or "Get me a ride to the hotel".' };
    }
    return { content: noticeAck(text) };
  }
  const reply = route(text, messages, tools);
  const notice = !reply.toolCalls && unansweredNotice(messages);
  return notice ? { content: `${noticeAck(notice)}\n${reply.content}` } : reply;
}

