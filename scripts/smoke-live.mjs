#!/usr/bin/env node
/**
 * Live smoke test: calls each real service whose key is set and prints one PASS / FAIL / SKIP line per check.
 * Keys are read from the environment and never printed.
 *
 *   node --env-file=.env scripts/smoke-live.mjs            # locally (Node 20.6+), keys in a .env that git ignores
 *   node scripts/smoke-live.mjs --only=hotels,email        # some services only (llm, hotels, places, email, rides)
 *   SMOKE_LITEAPI_BOOK=1 node scripts/smoke-live.mjs       # sandbox only: also book, read back and cancel a test booking
 *   SMOKE_EMAIL_TO=you@example.com node scripts/…          # also send one test email
 *   SMOKE_LITEAPI_PREBOOK=1                                # with a production LiteAPI key: also try a price lock (no charge)
 *
 * Exit code 0 when nothing failed (skips are fine), 1 otherwise. In GitHub Actions: see docs/LIVE.md.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../src/llm/client.js';
import { resolveLlmConfig, PROVIDERS } from '../src/llm/providers.js';
import { ANTHROPIC } from '../src/llm/anthropic.js';
import { readLiveConfig, describeLiveConfig } from '../src/live/config.js';
import { createLiteApiSupplier, LITEAPI } from '../src/live/liteapi.js';
import { createGooglePlaces } from '../src/live/places.js';
import { createResendMailer } from '../src/live/email.js';
import { buildRideLinks } from '../src/live/rides.js';
import { distanceMeters } from '../src/live/http.js';

const env = process.env;
const args = process.argv.slice(2);
const only = new Set((args.find((a) => a.startsWith('--only='))?.slice(7) || '').split(',').map((s) => s.trim()).filter(Boolean));
const wants = (name) => !only.size || only.has(name);
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

// Every value of a variable that looks like a credential is scrubbed from all output, plus common key shapes.
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD)$/i;
const secrets = Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.trim().length >= 6).map(([, v]) => v.trim());
const KEY_SHAPES = /\b(sk-ant-[\w-]{6,}|sk-[\w-]{12,}|re_[\w]{8,}|AIza[\w-]{20,}|sand(box)?_[\w-]{6,}|prod_[\w-]{6,}|pi_[\w]+_secret_[\w]+)\b/g;
function safe(text) {
  let out = String(text ?? '');
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(KEY_SHAPES, '[redacted]');
}

const results = [];
function report(status, name, detail = '') {
  results.push({ status, name });
  console.log(`${status.padEnd(4)}  ${name}${detail ? `: ${safe(detail)}` : ''}`);
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const out = await fn();
    if (out && typeof out === 'object' && 'skip' in out) {
      report('SKIP', name, out.skip);
      return undefined;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    report('PASS', name, `${out?.detail ?? out ?? 'ok'} (${secs}s)`);
    return out?.value;
  } catch (err) {
    const code = err?.code ? `[${err.code}${err.status ? ` ${err.status}` : ''}] ` : '';
    report('FAIL', name, `${code}${err?.message || err}`);
    return undefined;
  }
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const quietLogger = { info() {}, warn() {} };
const TIMES_SQUARE = { lat: 40.758, lng: -73.9855 };

// ---------------------------------------------------------------------------
// AI model
// ---------------------------------------------------------------------------

const TOOL = {
  type: 'function',
  function: {
    name: 'get_hotel_count',
    description: 'Returns how many hotels are near a place. Call it whenever the user asks how many hotels there are.',
    parameters: { type: 'object', properties: { place: { type: 'string', description: 'The place, e.g. "Times Square"' } }, required: ['place'] },
  },
};

async function smokeLlm(provider) {
  const name = `AI (${PROVIDERS[provider].label})`;
  if (!env[PROVIDERS[provider].keyEnv]?.trim()) return report('SKIP', name, `${PROVIDERS[provider].keyEnv} is not set`);
  // The generic LLM_* overrides belong to the provider the app uses, not to the other one.
  const own = resolveLlmConfig(env).provider === provider;
  const cfg = resolveLlmConfig({ ...env, LLM_PROVIDER: provider, LLM_API_KEY: '', LLM_MODEL: own ? env.LLM_MODEL : '', LLM_BASE_URL: own ? env.LLM_BASE_URL : '' });
  const llm = createLlmClient({ ...cfg, totalTimeoutMs: 90000 });
  const messages = [
    { role: 'system', content: 'You are a test harness for a hotel assistant. Use the tool when it fits, then answer in one short sentence.' },
    { role: 'user', content: 'How many hotels are near Times Square? Use the get_hotel_count tool.' },
  ];
  const first = await check(`${name}: tool call (${cfg.model})`, async () => {
    let streamed = 0;
    const res = await llm.chat({ messages, tools: [TOOL], onTextDelta: (t) => { streamed += t.length; } });
    const call = res.toolCalls.find((c) => c.name === 'get_hotel_count');
    if (!call) throw new Error(`expected a get_hotel_count call, got finishReason ${res.finishReason} and ${res.content.length} chars of text`);
    const replay = res.encryptedContent ? ', thinking blocks kept for the next step' : '';
    return { detail: `called get_hotel_count(${call.arguments}), ${streamed} chars streamed first${replay}`, value: res };
  });
  if (!first) return undefined;
  const call = first.toolCalls.find((c) => c.name === 'get_hotel_count');
  await check(`${name}: answer after the tool result`, async () => {
    const res = await llm.chat({
      tools: [TOOL],
      messages: [
        ...messages,
        { role: 'assistant', content: first.content || null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }], ...(first.encryptedContent ? { encrypted_content: first.encryptedContent } : {}) },
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ place: 'Times Square', count: 12 }) },
      ],
    });
    if (!/12|twelve/i.test(res.content)) throw new Error(`the answer did not use the tool result: "${res.content.slice(0, 120)}"`);
    const cache = res.usage?.cache_read_input_tokens ? `, ${res.usage.cache_read_input_tokens} tokens read from cache` : '';
    return `"${res.content.trim().slice(0, 80)}"${cache}`;
  });
  if (provider === 'anthropic' && cfg.fallbacks) {
    // The client drops the refusal-fallback beta by itself if the API refuses it; this says which way it went.
    await check(`${name}: refusal fallback beta (${ANTHROPIC.fallbackBeta})`, async () => {
      const res = await fetch(`${cfg.baseUrl.replace(/\/v1$/, '')}${ANTHROPIC.messagesPath}`, {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC.version, 'anthropic-beta': ANTHROPIC.fallbackBeta, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 64, fallbacks: 'default', messages: [{ role: 'user', content: 'Say OK.' }] }),
      });
      const body = await res.text();
      if (res.ok) return 'accepted';
      if (res.status === 400) return { detail: `not accepted for this account/model (the client works without it): ${body.slice(0, 160)}` };
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hotels (LiteAPI)
// ---------------------------------------------------------------------------

/**
 * Up to `max` bookable rates to try a prebook on, from priced search results: refundable first, then cheapest,
 * one per hotel before a second rate of the same hotel (a hotel-wide problem should not use up every attempt).
 */
export function prebookCandidates(hotels, max = 3) {
  const all = [];
  for (const hotel of hotels || []) {
    for (const roomType of hotel?.offer?.roomTypes || []) {
      for (const rate of roomType.rates || []) if (rate.available) all.push({ hotel, roomType, rate });
    }
  }
  all.sort((a, b) => (b.rate.refundable === true) - (a.rate.refundable === true) || a.rate.totalPrice - b.rate.totalPrice);
  const seen = new Set();
  const firsts = [];
  const seconds = [];
  for (const c of all) {
    if (seen.has(c.hotel.id)) seconds.push(c);
    else {
      seen.add(c.hotel.id);
      firsts.push(c);
    }
  }
  return [...firsts, ...seconds].slice(0, max);
}

function failureText(f, i) {
  const e = f.error;
  const code = e?.code ? `[${e.code}${e.status ? ` ${e.status}` : ''}] ` : '';
  return `#${i + 1} "${f.candidate.hotel.name}" (${f.candidate.rate.name}): ${code}${e?.message || e}`;
}

/**
 * Prebooks the candidates in turn until one works (the supplier itself re-searches once on a price change).
 * @returns {Promise<{ result: object, attempt: number, candidate: object, failures: Array<{ candidate, error }> }>}
 *   throws an Error listing every attempt when none worked.
 */
export async function prebookFirstWorking(supplier, candidates, stay, opts = {}) {
  const failures = [];
  for (const [i, candidate] of candidates.entries()) {
    try {
      const result = await supplier.prebook({ hotelId: candidate.hotel.id, rateId: candidate.rate.rateId, ...stay, ...opts });
      return { result, attempt: i + 1, candidate, failures };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      failures.push({ candidate, error: err });
    }
  }
  throw new Error(candidates.length ? `all ${candidates.length} attempts failed: ${failures.map(failureText).join('; ')}` : 'no bookable rate to try');
}

async function smokeHotels(live) {
  if (!live.hotels.enabled) return report('SKIP', 'Hotels (LiteAPI)', 'LITEAPI_API_KEY is not set');
  const sandbox = live.hotels.sandbox;
  const label = `Hotels (LiteAPI ${sandbox ? 'sandbox' : 'PRODUCTION'})`;
  const supplier = createLiteApiSupplier({ apiKey: live.hotels.apiKey, paymentKey: live.payments.publishableKey || '', logger: quietLogger });
  const checkIn = addDays(new Date().toISOString().slice(0, 10), 30);
  const stay = { checkIn, checkOut: addDays(checkIn, 2), adults: 2, rooms: 1 };

  const list = await check(`${label}: hotels near Times Square`, async () => {
    const hotels = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 2000, limit: 20 });
    if (!hotels.length) throw new Error('no hotels within 2 km of Times Square');
    const withPhotos = hotels.filter((h) => h.photos.length).length;
    return { detail: `${hotels.length} hotels, nearest "${hotels[0].name}" at ${hotels[0].distanceM} m, ${withPhotos} with photos`, value: hotels };
  });
  if (!list) return undefined;

  const priced = await check(`${label}: USD rates ${stay.checkIn} → ${stay.checkOut}, 2 adults`, async () => {
    const hotels = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 2000, limit: 15, ...stay });
    const bookable = hotels.filter((h) => h.lowestPrice !== null).sort((a, b) => a.lowestPrice - b.lowestPrice);
    if (!bookable.length) throw new Error(`no availability at ${hotels.length} hotels`);
    return { detail: `${bookable.length}/${hotels.length} hotels bookable, cheapest $${bookable[0].lowestPrice}/night at "${bookable[0].name}"`, value: bookable };
  });
  if (!priced) return undefined;

  const offer = await check(`${label}: rooms and hotel details`, async () => {
    const { hotel, offer: o } = await supplier.getRoomOffer({ hotelId: priced[0].id, ...stay });
    const rates = o.roomTypes.flatMap((rt) => rt.rates);
    if (!rates.length) throw new Error('the hotel had rates in the search but none for its room offer');
    const refundable = rates.filter((r) => r.refundable).length;
    return { detail: `"${hotel.name}": ${o.roomTypes.length} room types, ${rates.length} rates (${refundable} refundable), check-in ${hotel.checkInTime}${hotel.timesFromHotel ? '' : ' (default)'}, ${hotel.photos.length} photos, phone ${hotel.tel ? 'listed' : 'not listed'}`, value: { hotel, offer: o } };
  });
  if (!offer) return undefined;

  if (!sandbox && !truthy(env.SMOKE_LITEAPI_PREBOOK)) return report('SKIP', `${label}: prebook`, 'production key: set SMOKE_LITEAPI_PREBOOK=1 to try a price lock (nothing is charged)');
  const candidates = prebookCandidates(priced, 3);
  const pb = await check(`${label}: prebook with the payment form session (up to ${candidates.length} rates)`, async () => {
    const got = await prebookFirstWorking(supplier, candidates, stay);
    const p = got.result;
    if (!p.payment) throw new Error('prebook worked but returned no payment session (secretKey/transactionId) — check usePaymentSdk');
    const how = `attempt ${got.attempt} of ${candidates.length} worked: "${got.candidate.hotel.name}", ${p.rateName || got.candidate.rate.name}${p.retried ? ' (after one re-search for a new price)' : ''}`;
    const earlier = got.failures.length ? `; before that ${got.failures.map(failureText).join('; ')}` : '';
    return { detail: `${how}: prebookId received, $${p.price} ${p.currency}${p.priceChanged ? ` (was $${p.expectedPrice})` : ''}, payment session ready, ${p.cancelPolicy?.type === 'free' ? 'free cancellation' : 'non-refundable'}${earlier}`, value: got };
  });
  if (!pb) return undefined;
  await check(`${label}: card form key (LITEAPI_PAYMENT_KEY)`, async () => {
    if (!live.payments.publishableKey) throw new Error('not set (or refused, see the notes above): the card form cannot load, so guests cannot pay');
    return `publishable key set for the ${live.payments.environment} form`;
  });

  if (!(sandbox && (truthy(env.SMOKE_LITEAPI_BOOK) || args.includes('--book')))) {
    return report('SKIP', `${label}: book / read back / cancel`, sandbox ? 'set SMOKE_LITEAPI_BOOK=1 to make and cancel a sandbox booking' : 'never with a production key');
  }
  const booking = await check(`${label}: sandbox booking (account card, no payment form)`, async () => {
    const p = await supplier.prebook({ hotelId: pb.candidate.hotel.id, rateId: pb.result.rateId, ...stay, usePaymentSdk: false });
    const b = await supplier.book({ prebookId: p.prebookId, paymentMethod: 'ACC_CREDIT_CARD', holder: { firstName: 'Smoke', lastName: 'Test', email: env.SMOKE_EMAIL_TO || 'smoke-test@example.com' }, guests: ['Smoke Test'], clientReference: `SMOKE${Date.now()}` });
    return { detail: `booking ${b.bookingId} ${b.status}${b.hotelConfirmationCode ? `, hotel confirmation ${b.hotelConfirmationCode}` : ''}`, value: b };
  });
  if (!booking) return undefined;
  await check(`${label}: read the booking back`, async () => {
    const b = await supplier.getBooking(booking.bookingId);
    if (!b) throw new Error('booking not found');
    return `status ${b.status} (${b.supplierStatus}), $${b.price}`;
  });
  await check(`${label}: cancel the booking`, async () => {
    const c = await supplier.cancelBooking(booking.bookingId);
    if (!c.cancelled) throw new Error(`status after cancel: ${c.supplierStatus}`);
    return `cancelled, fee $${c.penalty}, refund ${c.refund === null ? 'not stated' : `$${c.refund}`}`;
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Places (Google)
// ---------------------------------------------------------------------------

async function smokePlaces(live) {
  if (!live.places.enabled) return report('SKIP', 'Places (Google)', 'GOOGLE_PLACES_API_KEY is not set');
  const places = createGooglePlaces({ apiKey: live.places.apiKey, logger: quietLogger });
  await check('Places (Google): geocode "Times Square" in New York', async () => {
    const p = await places.geocode('Times Square', { city: 'New York, NY', near: { lat: 40.7549, lng: -73.984 } });
    if (!p) throw new Error('no result');
    const off = distanceMeters({ lat: p.lat, lng: p.lng }, TIMES_SQUARE);
    if (off > 1500) throw new Error(`"${p.name}" is ${off} m from Times Square`);
    return `"${p.name}", ${p.address} (${off} m off), types ${p.types.slice(0, 3).join(', ')}`;
  });
}

// ---------------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------------

async function smokeEmail(live) {
  if (!live.email.enabled) return report('SKIP', 'Email (Resend)', 'RESEND_API_KEY is not set');
  const mailer = createResendMailer({ apiKey: live.email.apiKey, from: live.email.from, replyTo: live.email.replyTo, logger: quietLogger });
  await check('Email (Resend): key and sending domain', async () => {
    let domains;
    try {
      ({ domains } = await mailer.checkKey());
    } catch (err) {
      if (err?.providerCode === 'restricted_api_key') return 'sending-only key (it cannot list domains, which is fine)';
      throw err;
    }
    if (live.email.testSender) return `key works; no EMAIL_FROM, so the test sender is used (delivers only to your Resend account address); ${domains.length} domain(s) on the account`;
    const domain = live.email.from.replace(/^.*@/, '').replace(/>.*$/, '').trim().toLowerCase();
    const d = domains.find((x) => x.name.toLowerCase() === domain);
    if (!d) throw new Error(`EMAIL_FROM uses ${domain}, which is not on this Resend account`);
    if (d.status !== 'verified') throw new Error(`${domain} is "${d.status}", not verified yet: guests will not get emails`);
    return `${domain} is verified`;
  });
  const to = env.SMOKE_EMAIL_TO?.trim();
  if (!to) return report('SKIP', 'Email (Resend): send a test email', 'set SMOKE_EMAIL_TO=you@example.com to send one');
  await check(`Email (Resend): send a test booking confirmation`, async () => {
    const order = {
      id: `SMOKE${Date.now()}`, sandbox: true, hotel: { name: 'Smoke Test Hotel', address: '1 Test Plaza, New York, NY 10036' }, room: { name: 'Deluxe King' },
      rate: { name: 'Breakfast included · Free cancellation', cancelPolicy: { text: 'Free cancellation until the day before check-in.' } },
      checkIn: addDays(new Date().toISOString().slice(0, 10), 30), checkOut: addDays(new Date().toISOString().slice(0, 10), 32), nights: 2, rooms: 1, adults: 2,
      guests: ['Smoke Test'], totalPrice: 468, confirmationNo: 'TEST-123',
    };
    const { id } = await mailer.sendBookingConfirmation({ order, to, test: true });
    return `sent (id ${id}) from ${live.email.from}`;
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Rides (offline)
// ---------------------------------------------------------------------------

async function smokeRides() {
  await check('Rides: Uber and Lyft links (no key, offline)', async () => {
    const links = buildRideLinks({ pickup: { name: 'JFK Terminal 4', lat: 40.6441, lng: -73.7823 }, dropoff: { name: 'Times Square', lat: TIMES_SQUARE.lat, lng: TIMES_SQUARE.lng } });
    if (!links?.uber.url.startsWith('https://m.uber.com/ul/?action=setPickup') || !links.lyft.url.startsWith('https://lyft.com/ride?id=lyft')) throw new Error('unexpected link format');
    return `${links.uber.url} | ${links.lyft.url}`;
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const live = readLiveConfig(env);
  console.log('NanaHotel live smoke test');
  for (const l of describeLiveConfig(live)) console.log(`  ${l}`);
  for (const w of live.warnings) console.log(`  note: ${w}`);
  if (live.hotels.enabled) console.log(`  LiteAPI card form: ${LITEAPI.paymentSdk.scriptUrl} (${live.payments.environment}, publishable key ${live.payments.publishableKey ? 'set' : 'missing'})`);
  console.log('');
  if (wants('llm')) {
    await smokeLlm('anthropic');
    await smokeLlm('openai');
  }
  if (wants('hotels')) await smokeHotels(live);
  if (wants('places')) await smokePlaces(live);
  if (wants('email')) await smokeEmail(live);
  if (wants('rides')) await smokeRides();
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}

// Runs only as a script; tests import the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`FAIL  smoke test crashed: ${safe(err?.stack || err)}`);
    process.exitCode = 1;
  });
}
