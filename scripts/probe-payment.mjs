#!/usr/bin/env node
/**
 * Probes LiteAPI's payment SDK (sandbox only):
 *   1. downloads the SDK script and prints how it reads its options (publicKey, secretKey, returnUrl, …);
 *   2. prebooks a real sandbox rate, mounts the card form in headless Chromium, pays with Stripe's test card,
 *      follows the redirect to returnUrl, books with the prebook's transactionId, reads it back and cancels it.
 * Prints no keys or client secrets. Needs LITEAPI_API_KEY (sandbox) and LITEAPI_PAYMENT_KEY, plus Playwright.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { readLiveConfig } from '../src/live/config.js';
import { createLiteApiSupplier, LITEAPI } from '../src/live/liteapi.js';
import { prebookCandidates, prebookFirstWorking } from './smoke-live.mjs';

const require = createRequire(import.meta.url);
const env = process.env;
const secrets = new Set(Object.entries(env).filter(([k, v]) => /(KEY|SECRET|TOKEN)$/i.test(k) && v && v.length >= 6).map(([, v]) => v.trim()));
const SHAPES = /\b(pi_[\w]+_secret_[\w]+|seti_[\w]+_secret_[\w]+|sand(box)?_[\w-]{6,}|sk_(test|live)_[\w]+|pk_(test|live)_[\w]{6,})\b/g;
const scrub = (t) => {
  let s = String(t ?? '');
  for (const v of secrets) s = s.split(v).join('[redacted]');
  return s.replace(SHAPES, (m) => `${m.slice(0, 8)}…[redacted]`);
};
const log = (...a) => console.log(scrub(a.join(' ')));
const section = (t) => console.log(`\n========== ${t} ==========`);

const live = readLiveConfig(env);
if (!live.hotels.enabled || !live.hotels.sandbox) {
  log('LiteAPI sandbox key missing (or a production key): this probe only runs in the sandbox.');
  process.exit(1);
}

// ------------------------------------------------------------------ 1. the SDK source
section('SDK source');
const sdkUrl = LITEAPI.paymentSdk.scriptUrl;
const sdkRes = await fetch(sdkUrl);
const sdk = await sdkRes.text();
log(`GET ${sdkUrl} → ${sdkRes.status} ${sdkRes.headers.get('content-type')} ${sdk.length} bytes`);
const TERMS = ['publicKey', 'secretKey', 'targetElement', 'returnUrl', 'appearance', 'business', 'handlePayment', 'environment', 'sandbox', 'pk_test', 'pk_live', 'loadStripe', 'js.stripe.com', 'confirmPayment', 'redirect', 'paymentElement', 'create("payment"', "create('payment'", 'submit', 'onSuccess', 'onError', 'callback', 'transactionId', 'prebookId', 'LiteAPIPayment'];
for (const term of TERMS) {
  let at = sdk.indexOf(term);
  let n = 0;
  const total = sdk.split(term).length - 1;
  if (!total) {
    log(`-- ${term}: not found`);
    continue;
  }
  log(`-- ${term}: ${total} hit(s)`);
  while (at >= 0 && n < 3) {
    log(`   …${sdk.slice(Math.max(0, at - 260), at + 260).replace(/\s+/g, ' ')}…`);
    at = sdk.indexOf(term, at + term.length + 400);
    n += 1;
  }
}
// Every URL in the script (hosts it talks to).
const urls = [...new Set(sdk.match(/https?:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?/g) || [])].slice(0, 40);
log(`-- URLs in the script: ${urls.join(' | ')}`);

// ------------------------------------------------------------------ 2. a real sandbox payment in a browser
section('Prebook (sandbox)');
const supplier = createLiteApiSupplier({ apiKey: live.hotels.apiKey, paymentKey: live.payments.publishableKey || '', logger: { info() {}, warn() {} } });
const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const checkIn = addDays(new Date().toISOString().slice(0, 10), 35);
const stay = { checkIn, checkOut: addDays(checkIn, 1), adults: 1, rooms: 1 };
const hotels = await supplier.searchHotels({ city: 'New York', location: { lat: 40.758, lng: -73.9855 }, radiusM: 3000, limit: 15, ...stay });
const priced = hotels.filter((h) => h.lowestPrice !== null);
const got = await prebookFirstWorking(supplier, prebookCandidates(priced, 4), stay);
const pb = got.result;
log(`prebook ${pb.prebookId ? 'ok' : 'missing id'} at "${got.candidate.hotel.name}", $${pb.price} ${pb.currency}; payment: ${pb.payment ? Object.keys(pb.payment).join(', ') : 'none'}; environment ${pb.payment?.environment}; publishable key ${pb.payment?.publishableKey ? `${pb.payment.publishableKey.slice(0, 8)}…` : 'none'}; secretKey shape ${pb.payment?.secretKey ? pb.payment.secretKey.replace(/[A-Za-z0-9]/g, (c) => (/[0-9]/.test(c) ? '9' : 'x')).replace(/x{4,}/g, 'x…').replace(/9{3,}/g, '9…') : 'none'}`);
if (!pb.payment) process.exit(1);

let returned = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/return') {
    returned = Object.fromEntries(u.searchParams);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>back</title><p id="back">Returned</p>');
    return;
  }
  if (u.pathname !== '/') {
    res.writeHead(404);
    res.end();
    return;
  }
  const variant = u.searchParams.get('variant') || 'pk';
  const cfg = {
    publicKey: variant === 'env' ? pb.payment.environment : pb.payment.publishableKey,
    secretKey: pb.payment.secretKey,
    targetElement: '#nana-payment',
    appearance: { theme: 'flat' },
    options: { business: { name: 'NanaHotel' } },
    returnUrl: `http://127.0.0.1:${server.address().port}/return?order=probe&variant=${variant}`,
  };
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<script src="${sdkUrl}"></script></head><body>
<h1>Pay</h1><div id="nana-payment"></div>
<script>
  window.__probe = { errors: [] };
  window.addEventListener('error', (e) => window.__probe.errors.push(String(e.message)));
  try {
    const p = new LiteAPIPayment(${JSON.stringify(cfg)});
    window.__probe.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(p));
    window.__probe.keys = Object.keys(p);
    const r = p.handlePayment();
    window.__probe.handleReturned = typeof r + (r && typeof r.then === 'function' ? ' (promise)' : '');
    if (r && typeof r.then === 'function') r.then((v) => { window.__probe.resolved = JSON.stringify(v ?? null).slice(0, 200); }, (e) => { window.__probe.rejected = String(e && e.message || e); });
  } catch (e) { window.__probe.errors.push('constructor/handlePayment: ' + (e && e.message || e)); }
</script></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = require('playwright');
const browser = await chromium.launch();

async function attempt(variant) {
  section(`Card form, publicKey = ${variant === 'env' ? 'environment name' : 'publishable key'}`);
  const ctx = await browser.newContext({ viewport: { width: 430, height: 1000 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
  const hosts = new Map();
  page.on('request', (r) => {
    try {
      const u = new URL(r.url());
      const k = `${r.method()} ${u.origin}${u.pathname}`.slice(0, 140);
      hosts.set(k, (hosts.get(k) || 0) + 1);
    } catch { /* ignore */ }
  });
  const failed = [];
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const u = new URL(r.url());
      failed.push(`${r.status()} ${r.request().method()} ${u.origin}${u.pathname}`);
    }
  });
  page.on('response', async (r) => {
    if (!r.url().startsWith('https://payment-wrapper.liteapi.travel/config')) return;
    try {
      const body = await r.json();
      const shape = (v, depth = 0) => (v && typeof v === 'object' && depth < 3 ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)])) : typeof v === 'string' && /^https?:/.test(v) ? v : typeof v);
      log(`/config answer: ${JSON.stringify(shape(body))}`);
    } catch (e) {
      log(`/config answer unreadable: ${e.message}`);
    }
  });
  await page.goto(`http://127.0.0.1:${port}/?variant=${variant}`);
  await page.waitForTimeout(9000);
  const probe = await page.evaluate(() => window.__probe);
  log(`probe: ${JSON.stringify(probe)}`);
  const frames = page.frames().map((f) => {
    try {
      const u = new URL(f.url());
      return `${u.origin}${u.pathname}`;
    } catch {
      return f.url().slice(0, 60);
    }
  });
  log(`frames: ${frames.join(' | ')}`);
  log(`page text: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800)}`);
  log(`buttons: ${JSON.stringify(await page.locator('button, input[type=submit]').evaluateAll((els) => els.map((e) => ({ text: (e.innerText || e.value || '').trim().slice(0, 40), id: e.id, cls: String(e.className).slice(0, 60), disabled: e.disabled }))))}`);
  log(`target html (tags only): ${(await page.locator('#nana-payment').evaluate((el) => el.innerHTML)).replace(/"[^"]{40,}"/g, '"…"').slice(0, 1500)}`);

  log(`requests: ${[...hosts.entries()].map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).slice(0, 80).join(' | ')}`);
  const stripeFrames = page.frames().filter((f) => /stripe\.com/.test(f.url()));
  if (!stripeFrames.length) {
    log(`no Stripe frame. console: ${consoleLines.slice(0, 25).join(' || ')}`);
    log(`requests: ${[...hosts.entries()].map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).slice(0, 40).join(' | ')}`);
    log(`failed: ${failed.slice(0, 20).join(' | ')}`);
    await ctx.close();
    return false;
  }
  // Fill the card in whichever Stripe frame has the fields (Payment Element or Card Element).
  let filled = false;
  for (const f of stripeFrames) {
    const inputs = await f.locator('input').evaluateAll((els) => els.map((e) => ({ name: e.name, id: e.id, type: e.type, placeholder: e.placeholder, autocomplete: e.autocomplete }))).catch(() => []);
    if (inputs.length) log(`stripe frame ${new URL(f.url()).pathname} inputs: ${JSON.stringify(inputs).slice(0, 900)}`);
    const pick = async (sels, value) => {
      for (const s of sels) {
        const l = f.locator(s).first();
        if (await l.count().catch(() => 0)) {
          await l.click({ timeout: 3000 }).catch(() => {});
          await l.pressSequentially(value, { delay: 30 }).catch(() => {});
          return s;
        }
      }
      return null;
    };
    const num = await pick(['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]'], '4242424242424242');
    if (!num) continue;
    const exp = await pick(['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]'], '1234');
    const cvc = await pick(['input[name="cvc"]', 'input[autocomplete="cc-csc"]'], '123');
    const zip = await pick(['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]'], '10036');
    // Country select, if shown: keep United States.
    log(`filled: number ${num}, expiry ${exp}, cvc ${cvc}, zip ${zip}`);
    filled = true;
    break;
  }
  if (!filled) {
    log('could not find the card number field in any Stripe frame');
    await ctx.close();
    return false;
  }
  await page.waitForTimeout(1500);
  const jpg = (await page.screenshot({ type: 'jpeg', quality: 45, fullPage: true })).toString('base64');
  console.log(`SCREENSHOT ${jpg.length}`);
  for (let i = 0; i < jpg.length; i += 4000) console.log(`IMG ${String(i / 4000).padStart(3, '0')} ${jpg.slice(i, i + 4000)}`);
  const buttons = page.locator('button, input[type=submit]');
  const count = await buttons.count();
  let clicked = null;
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i);
    const t = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value')) || '').trim();
    if (/pay|book|submit|confirm|complete/i.test(t) || i === count - 1) {
      await b.click({ timeout: 5000 }).catch((e) => log(`click failed: ${e.message}`));
      clicked = t || `(button ${i})`;
      break;
    }
  }
  log(`clicked: ${clicked}`);
  const backed = await page.waitForURL(/\/return/, { timeout: 60000 }).then(() => true, () => false);
  log(`returned to returnUrl: ${backed}${backed ? `; query keys: ${Object.keys(returned || {}).join(', ')}` : ''}`);
  if (backed) {
    const r = returned || {};
    log(`returnUrl params: ${Object.entries(r).map(([k, v]) => `${k}=${/secret/i.test(k) ? '[redacted]' : v === pb.prebookId ? '<prebookId>' : v === pb.payment.transactionId ? '<transactionId>' : String(v).slice(0, 30)}`).join(' & ')}`);
  } else {
    log(`after click, page text: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800)}`);
    log(`console: ${consoleLines.slice(-20).join(' || ')}`);
    log(`failed: ${failed.slice(0, 20).join(' | ')}`);
  }
  await ctx.close();
  return backed;
}

let paid = await attempt('env');
await browser.close();
server.close();

section('Book with the transactionId');
if (!paid) {
  log('payment did not complete; not booking');
  process.exit(1);
}
try {
  const b = await supplier.book({ prebookId: pb.prebookId, transactionId: pb.payment.transactionId, holder: { firstName: 'Probe', lastName: 'Test', email: 'smoke-test@example.com' }, guests: ['Probe Test'], clientReference: `PROBE${Date.now()}` });
  log(`booking ${b.bookingId} ${b.status}${b.hotelConfirmationCode ? `, hotel confirmation ${b.hotelConfirmationCode}` : ''}, $${b.price}`);
  const back = await supplier.getBooking(b.bookingId);
  log(`read back: ${back?.status} (${back?.supplierStatus})`);
  const c = await supplier.cancelBooking(b.bookingId);
  log(`cancelled: ${c.cancelled}, fee $${c.penalty}, refund ${c.refund}`);
} catch (err) {
  log(`book failed: [${err.code} ${err.status ?? ''}] ${err.message}`);
  process.exit(1);
}
