// End to end against the REAL services, in LiteAPI's sandbox (test bookings, nothing is charged):
//   the app with live hotels → search near Times Square → rooms → quote → Confirm booking → LiteAPI's card form
//   (Stripe test card 4242…) → back to the app → booked at LiteAPI → cancelled again.
// Nana is the scripted demo model, so the run is free and repeatable. Needs LITEAPI_API_KEY (a sandbox key; a
// production key is refused) and Playwright; GOOGLE_PLACES_API_KEY / GOOGLE_MAPS_API_KEY is used when set.
//   LITEAPI_API_KEY=sand_… node test/e2e/live-e2e.mjs        (SCREENSHOT_DIR=… to keep screenshots)
// In GitHub Actions: .github/workflows/live-e2e.yml.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { createScriptedLlm, demoScript } from '../../src/llm/scripted-llm.js';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SCREENSHOT_DIR || '';
const base = loadConfig({ envFile: null });
if (!base.live?.hotels?.enabled || !base.live.hotels.sandbox) {
  console.log('[live-e2e] needs a LiteAPI sandbox key in LITEAPI_API_KEY (production keys are refused)');
  process.exit(1);
}

const logs = [];
const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERROR ${m}`) };
const running = await startServer({
  config: { ...base, dataDir: null, port: 0, host: '127.0.0.1', merchantAccess: 'open', llm: { provider: 'scripted', label: 'Scripted demo', model: 'demo-script', configured: true, keyEnv: '' } },
  llm: createScriptedLlm(demoScript, { delayMs: 0 }),
  webSearch: { enabled: false },
  logger,
});
const BASE = `http://127.0.0.1:${running.port}`;
const browser = await chromium.launch();
const results = [];
let page;
let orderId = null;
let booked = false;
let cancelled = false;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(['PASS', name]);
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return true;
  } catch (err) {
    results.push(['FAIL', name]);
    console.log(`FAIL  ${name}: ${String(err?.message || err).split('\n')[0]}`);
    if (page) await shot(`fail-${results.length}`).catch(() => {});
    return false;
  }
}

async function shot(name) {
  if (!SHOTS || !page) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function apiCall(method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const res = await fetch(url, {
      method,
      headers: { 'X-User-Id': localStorage.getItem('nanahotel.userId'), 'Content-Type': 'application/json', 'X-Time-Zone': 'America/New_York' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }, { method, url, body });
}

const idle = () => page.waitForFunction(() => !document.querySelector('.typing') && !document.getElementById('send').classList.contains('is-stop'), null, { timeout: 90000 });
async function say(text) {
  const n = await page.locator('.turn-user').count();
  await page.locator('#input').fill(text);
  await page.locator('#input').press('Enter');
  await page.waitForFunction((k) => document.querySelectorAll('.turn-user').length > k, n, { timeout: 20000 });
  await idle();
  await page.waitForTimeout(600);
}

async function payInCardForm() {
  const sheet = page.locator('dialog[open]');
  await sheet.locator('.live-pay iframe').first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot('5-card-form');
  let filled = false;
  for (const f of page.frames().filter((x) => /js\.stripe\.com/.test(x.url()))) {
    const number = f.locator('input[name="number"]');
    if (!(await number.count().catch(() => 0))) continue;
    await number.click();
    await number.pressSequentially('4242424242424242', { delay: 25 });
    await f.locator('input[name="expiry"]').pressSequentially('1234', { delay: 25 });
    await f.locator('input[name="cvc"]').pressSequentially('123', { delay: 25 });
    const zip = f.locator('input[name="postalCode"]');
    if (await zip.count()) await zip.pressSequentially('10036', { delay: 25 });
    filled = true;
    break;
  }
  if (!filled) throw new Error('no card number field in the Stripe frames');
  await page.waitForTimeout(800);
  await shot('6-card-filled');
  await sheet.locator('.lp-submit-button').click();
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'America/New_York' });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|frame|connect|execute)/i.test(t)) problems.push(`csp: ${t.slice(0, 240)}`);
  });

  await step('The app says the hotels are real and this is test mode', async () => {
    await page.goto(BASE);
    await page.locator('#welcome').waitFor();
    await page.locator('#thread-note [data-mode="test"]').waitFor({ timeout: 10000 });
    const note = await page.locator('#thread-note').innerText();
    if (!/Real hotels/.test(note)) throw new Error(`thread note: ${note}`);
    await page.waitForTimeout(1500);
    await shot('1-welcome');
    return note.replace(/\s+/g, ' ');
  });

  await step('Traveler details saved', async () => {
    const r = await apiCall('PUT', '/api/profile', { firstName: 'Probe', lastName: 'Tester', email: 'smoke-test@example.com', contactPhone: '(212) 555-0142' });
    if (r.status !== 200) throw new Error(`PUT /api/profile → ${r.status} ${JSON.stringify(r.json)}`);
  });

  const searched = await step('Search near Times Square: real hotels with photos and prices', async () => {
    const d = new Date(Date.now() + 30 * 86400000);
    const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    await say(`${when} in New York near Times Square, two nights`);
    const card = page.locator('[data-card="hotels"]').last();
    await card.waitFor({ timeout: 60000 });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await shot('2-hotels');
    const names = await card.locator('.pick-name').allInnerTexts();
    const photos = await card.locator('.photo img').evaluateAll((els) => els.map((e) => e.currentSrc || e.src));
    if (!names.length) throw new Error('no hotels on the card');
    if (!photos.some((u) => /^https:/.test(u))) throw new Error('no real photos');
    return `${names.length} hotels, first "${names[0]}"`;
  });

  // Prices move all the time in the sandbox: up to three hotels / quotes until one locks.
  let quoted = false;
  for (let attempt = 0; searched && attempt < 3 && !booked; attempt += 1) {
    quoted = await step(`Rooms and a quote (attempt ${attempt + 1})`, async () => {
      const hotels = page.locator('[data-card="hotels"]').last().locator('[data-action="pick-hotel"]');
      await hotels.nth(Math.min(attempt, (await hotels.count()) - 1)).click();
      await idle();
      const rooms = page.locator('[data-card="rooms"]').last();
      await rooms.waitFor({ timeout: 60000 });
      await rooms.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await shot(`3-rooms-${attempt + 1}`);
      const rates = rooms.locator('[data-action="pick-rate"]');
      if (!(await rates.count())) throw new Error('no bookable rate at this hotel');
      const free = rooms.locator('[data-action="pick-rate"]', { hasText: /free cancel/i });
      await ((await free.count()) ? free.first() : rates.first()).click();
      await idle();
      const quote = page.locator('[data-card="booking_quote"]').last();
      await quote.waitFor({ timeout: 60000 });
      await quote.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await shot(`4-quote-${attempt + 1}`);
      return (await quote.locator('[data-action="confirm-pay"]').innerText()).replace(/\s+/g, ' ');
    });
    if (!quoted) continue;
    const paid = await step(`Confirm booking → LiteAPI's card form → pay with the test card (attempt ${attempt + 1})`, async () => {
      await page.locator('[data-card="booking_quote"]').last().locator('[data-action="confirm-pay"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.waitFor();
      const outcome = await Promise.race([
        sheet.locator('.live-pay iframe').first().waitFor({ timeout: 60000 }).then(() => 'form'),
        sheet.locator('.form-error:not([hidden])').waitFor({ timeout: 60000 }).then(() => 'error'),
      ]);
      if (outcome === 'error') {
        const msg = await sheet.locator('.form-error').innerText();
        await shot(`5-checkout-error-${attempt + 1}`);
        await sheet.locator('.modal-close').click().catch(() => {});
        throw new Error(`checkout: ${msg}`);
      }
      const waitBack = page.waitForURL(/[?&]paid=/, { timeout: 90000 });
      await payInCardForm();
      await waitBack;
      // Booked by the page as soon as it is back, then the chat shows the notice.
      await page.locator('.notice[data-kind="paid"]').last().waitFor({ timeout: 90000 });
      await page.waitForTimeout(2000);
      if (/payment_intent|client_secret|paid=/.test(page.url())) throw new Error(`the address still has payment details: ${page.url()}`);
      await shot('7-booked');
      const orders = await apiCall('GET', '/api/orders');
      const o = (orders.json?.orders || []).find((x) => x.status === 'confirmed' && x.live?.bookingId);
      if (!o) throw new Error(`no confirmed live order: ${JSON.stringify(orders.json).slice(0, 300)}`);
      orderId = o.id;
      booked = true;
      return `order ${o.id}, LiteAPI booking ${o.live.bookingId}, ${o.confirmationNo}, $${o.totalPrice}`;
    });
    if (!paid) {
      // A price change or sold-out room: back to the hotel list for the next attempt.
      await page.locator('dialog[open] .modal-close').click().catch(() => {});
    }
  }

  if (booked) {
    await step('Cancel it from the chat: "Cancel that booking" → Confirm cancellation (LiteAPI)', async () => {
      await say('Cancel that booking');
      const card = page.locator('[data-card="cancel_preview"]').last();
      await card.waitFor({ timeout: 60000 });
      await card.scrollIntoViewIfNeeded();
      await shot('8-cancel-preview');
      await card.locator('[data-action="confirm-cancel"]').click();
      await page.locator('.notice[data-kind="cancelled"]').last().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1200);
      await shot('9-cancelled');
      const o = (await apiCall('GET', '/api/orders')).json?.orders?.find((x) => x.id === orderId);
      if (o?.status !== 'cancelled') throw new Error(`order status ${o?.status}`);
      cancelled = true;
      return `refund $${o.cancellation?.refund}`;
    });
  }

  await step('No page errors and nothing blocked by the Content-Security-Policy', async () => {
    if (problems.length) throw new Error(problems.slice(0, 6).join(' | '));
  });
} finally {
  if (booked && !cancelled && orderId && page) {
    const r = await apiCall('POST', `/api/orders/${orderId}/cancel`, {}).catch((e) => ({ status: 0, json: String(e) }));
    console.log(`cleanup: cancelling ${orderId} → ${r.status}`);
  }
  await browser.close();
  await running.close();
  const errors = logs.filter((l) => /^(ERROR|WARN)/.test(l));
  if (errors.length) console.log(`server warnings/errors:\n  ${errors.slice(0, 15).join('\n  ')}`);
}
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
