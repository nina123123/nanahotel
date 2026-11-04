// End-to-end check of the phone-app build (app/): no backend, the server code runs in the page.
//   node test/e2e/app-smoke.mjs        (SCREENSHOT_DIR=… to keep screenshots)
// Serves the repository as static files under a sub-path, like GitHub Pages, and drives it with Playwright:
//   the scripted demo — search → "Book #1" → "Yes" → pay, a reload restores everything from IndexedDB, check-in, the
//   hotel console in the same app — and the page never calls an AI provider (the app holds no keys; the connected
//   Android build shows the hosted server instead, android/…/RemoteClient.kt).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.env.NODE_TEST_CONTEXT && !process.env.APP_SMOKE) {
  console.log('[app-smoke] skipped (run it with npm run test:app)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright')));
  } catch {
    console.log('[app-smoke] skipped: playwright not found');
    process.exit(0);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_PATH = '/nanahotel/';
const SHOTS = process.env.SCREENSHOT_DIR || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
const BROWSER = { viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/New_York' };

// ---- static server ------------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(BASE_PATH)) {
    res.writeHead(404).end();
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const APP_URL = `${ORIGIN}${BASE_PATH}app/`;

// ---- helpers ------------------------------------------------------------------------------------------------

const browser = await chromium.launch();
let failed = false;
let shot = 0;

async function step(name, fn) {
  process.stdout.write(`[app-smoke] … ${name}\n`);
  await fn();
  process.stdout.write(`[app-smoke] ok ${name}\n`);
}

async function snap(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.png`) });
}

async function newPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.errors = errors;
  return page;
}

async function send(page, text) {
  await page.locator('#input').fill(text);
  await page.locator('#send').click();
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.typing') && !document.getElementById('send').classList.contains('is-stop'), null, { timeout: 30000 });
}

async function say(page, text) {
  await send(page, text);
  await waitIdle(page);
}

// The hotel console is listed when the in-page server has the merchant API.
const menuOk = (actions) => ['open-plans,new-chat,open-profile', 'open-plans,new-chat,open-profile,open-merchant'].includes(actions.join());

async function menuActions(page) {
  await page.locator('#btn-menu').click();
  const actions = await page.locator('dialog[open] .menu-item').evaluateAll((els) => els.map((e) => e.dataset.action));
  await page.locator('dialog[open] .modal-close').click();
  return actions;
}

try {
  // 1. Demo mode, the way the app starts.
  const ctx1 = await browser.newContext(BROWSER);
  const page = await newPage(ctx1);
  let providerCalls = 0;
  await page.route(/^https:\/\/(api\.anthropic\.com|api\.openai\.com)\//, (route) => {
    providerCalls += 1;
    return route.abort();
  });
  await step('Open the app (no backend: the server runs in the page)', async () => {
    await page.goto(APP_URL);
    await page.locator('#welcome').waitFor({ timeout: 20000 });
    if (!(await page.locator('#thread-note [data-mode="demo"]').count())) throw new Error('without a built-in model the page should say it is the demo');
    if (!menuOk(await menuActions(page))) throw new Error('the menu has My trips, New chat, Traveler details (and the hotel console), no AI settings');
    // The animated pet runs from the app's own files too (runtime and animation are bundled, no CDN).
    await page.locator('#pet-header .has-rive canvas').waitFor({ timeout: 20000 });
    await snap(page, 'welcome-demo');
  });
  await step('Demo mode: a trip → "Book #1" → "Yes" → Confirm booking → Pay', async () => {
    await say(page, 'This Friday in New York near Times Square, two nights, under $300');
    await say(page, 'Book #1');
    await say(page, 'Yes');
    await page.locator('[data-card="booking_quote"] [data-action="confirm-pay"]').last().click();
    const sheet = page.locator('dialog[open]');
    await sheet.locator('[data-action="pay"]').click();
    await page.locator('[data-card="booking_quote"][data-status="confirmed"]').last().waitFor({ timeout: 20000 });
    await page.locator('.notice[data-kind="paid"]').last().waitFor({ timeout: 20000 });
    await snap(page, 'order-confirmed');
  });
  await step('After a reload the chat and the booking are still there (stored on the phone)', async () => {
    await page.reload();
    await page.locator('[data-card="booking_quote"][data-status="confirmed"]').first().waitFor({ timeout: 20000 });
    await page.locator('.notice[data-kind="paid"]').first().waitFor({ timeout: 20000 });
  });
  await step('Demo mode: check in → the room card; My trips shows the room', async () => {
    await say(page, "I'm here, check me in");
    await page.locator('[data-card="checkin"] .roomkey-num').last().waitFor({ timeout: 20000 });
    await page.locator('#plans .plan-chip', { hasText: 'Room ' }).first().waitFor({ timeout: 20000 });
    await snap(page, 'checked-in');
  });
  await step('Switch to the hotel console in the same app: the NanaHotel guest is in Rooms; then back', async () => {
    await page.locator('#btn-menu').click();
    await page.locator('dialog[open] [data-action="open-merchant"]').click();
    await page.locator('.kpi-hero .kpi-value').waitFor({ timeout: 20000 });
    await page.locator('.m-tab[data-tab="rooms"]').click();
    await page.locator('.room.is-nanahotel').first().waitFor({ timeout: 20000 });
    await snap(page, 'merchant-in-app');
    await page.locator('#m-to-guest').click();
    await page.locator('#messages .turn-user').first().waitFor({ timeout: 20000 });
  });

  if (providerCalls) throw new Error(`the app called an AI provider ${providerCalls} times; it must only run the scripted demo`);
  if (page.errors.length) throw new Error(`page errors:\n${page.errors.join('\n')}`);
  await ctx1.close();

  console.log('[app-smoke] passed');
} catch (err) {
  failed = true;
  console.error(`[app-smoke] FAILED: ${err.stack || err.message}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
