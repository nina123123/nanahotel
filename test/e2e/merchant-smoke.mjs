// End-to-end: the guest side and the hotel's console are linked (docs/MERCHANT.md), against a running server:
//   node test/e2e/run-server.js &   then   node test/e2e/merchant-smoke.mjs
// Env: BASE_URL (default http://localhost:8787), SCREENSHOT_DIR (optional), SMOKE_TIMEOUT_MS (default 30000).
// A guest books tonight in NanaHotel; the front desk checks them in; towels go from request to delivered; the
// guest's review gets a reply; a deal shows up in the guest's next search. Skips when Playwright is unavailable.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS) || 30000;
// docs/US-CONTRACT.md §12. The guest is in Las Vegas, and so is the front desk.
const TONIGHT = 'Tonight in Las Vegas on the Strip, cheap';
const ZONE = { locale: 'en-US', timezoneId: 'America/Los_Angeles' };
const log = (...args) => console.log('[merchant-smoke]', ...args);

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const globalRoot = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
  for (const id of ['playwright', path.join(globalRoot, 'playwright')]) {
    try {
      return require(id);
    } catch {
      // try the next location
    }
  }
  return null;
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.SMOKE) {
    log('skipped: start the server first (node test/e2e/run-server.js), then run this file on its own, or set SMOKE=1.');
    return 0;
  }
  const playwright = loadPlaywright();
  if (!playwright) {
    log('skipped: playwright not found.');
    return 0;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    log(`FAILED: cannot reach ${BASE_URL}/api/health. Start the server first: node test/e2e/run-server.js`);
    return 1;
  }
  const browser = await playwright.chromium.launch();
  const errors = [];
  const watch = (page, who) => {
    page.setDefaultTimeout(TIMEOUT);
    page.on('pageerror', (err) => errors.push(`${who}: ${err.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`${who}: ${m.text()}`);
    });
    return page;
  };
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...ZONE });
  const hotelCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...ZONE });
  const guest = watch(await guestCtx.newPage(), 'guest');
  const hotel = watch(await hotelCtx.newPage(), 'hotel');
  const consoleZones = new Set();
  hotel.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/merchant/')) consoleZones.add(req.headers()['x-time-zone'] || '(none)');
  });
  let shot = 0;
  const screenshot = async (page, name) => {
    if (!SCREENSHOT_DIR) return;
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${String(++shot).padStart(2, '0')}-${name}.png`) });
  };
  const step = async (name, fn) => {
    log(`… ${name}`);
    await fn();
    log(`ok ${name}`);
  };
  const idle = () => guest.waitForFunction(() => !document.querySelector('.typing') && !document.getElementById('send').classList.contains('is-stop'));
  const say = async (text) => {
    const before = await guest.locator('.turn-user').count();
    await guest.locator('#input').fill(text);
    await guest.locator('#input').press('Enter');
    await guest.waitForFunction((n) => document.querySelectorAll('.turn-user').length > n, before);
    await idle();
  };
  const tab = async (key) => {
    await hotel.locator(`.m-tab[data-tab="${key}"]`).click();
    await hotel.locator(`.m-tab[data-tab="${key}"][aria-current="page"]`).waitFor();
    await hotel.waitForFunction(() => !document.querySelector('.skeleton') && document.getElementById('m-main').style.opacity === '');
  };

  try {
    let roomNumber = '';
    let hotelName = '';
    await step('Guest: book a hotel for tonight and pay', async () => {
      await guest.goto(BASE_URL);
      await guest.locator('#welcome').waitFor();
      await say(TONIGHT);
      hotelName = await guest.locator('[data-card="hotels"] .pick-name').first().innerText();
      await say('Book #1');
      await say('Yes');
      await guest.locator('[data-card="booking_quote"][data-status="pending"] [data-action="confirm-pay"]').last().click();
      await guest.locator('dialog[open] [data-action="pay"]').click();
      await guest.locator('dialog[open]').waitFor({ state: 'detached' });
      await guest.locator('.notice[data-kind="paid"]').last().waitFor();
    });
    await step('The console opens on that hotel: overview, charts and tips', async () => {
      await hotel.goto(`${BASE_URL}/merchant`);
      await hotel.locator('.kpi-hero .kpi-value').waitFor();
      assert.equal(await hotel.title(), `${hotelName} · NanaHotel for Hotels`);
      assert.equal(await hotel.locator('#m-hotel-name').innerText(), hotelName);
      assert.deepEqual(await hotel.locator('.m-tab > span:not(.m-tab-badge)').allInnerTexts(), ['Overview', 'Rooms', 'Requests', 'Reviews']);
      assert.ok((await hotel.locator('.chart svg').count()) >= 2, 'revenue and occupancy charts');
      assert.deepEqual(await hotel.locator('.legend-item .swatch').evaluateAll((els) => els.map((e) => e.className.replace('swatch ', ''))),
        ['ch-nanahotel', 'ch-expedia', 'ch-booking', 'ch-google', 'ch-direct'], 'the five channels in their slots');
      await hotel.locator('.panel', { hasText: "Today's arrivals" }).locator('.chip-nanahotel').first().waitFor();
      await screenshot(hotel, 'overview');
    });
    await step('Rooms: the NanaHotel guest arrives today → the front desk checks them in → the guest gets the room number', async () => {
      await tab('rooms');
      const room = hotel.locator('.room.is-nanahotel.st-arriving').first();
      roomNumber = await room.locator('.room-no').innerText();
      await room.click();
      await hotel.locator('dialog[open] [data-action="room-check_in"]').click();
      await hotel.locator('dialog[open]').waitFor({ state: 'detached' });
      await hotel.locator('.room.is-nanahotel.st-occupied', { hasText: roomNumber }).waitFor();
      await screenshot(hotel, 'rooms');
      await guest.reload();
      await guest.locator('.notice[data-kind="front_desk_checkin"]').last().waitFor();
      await guest.locator('#plans .plan-chip', { hasText: `Room ${roomNumber}` }).first().waitFor();
    });
    await step('Requests: the guest asks for towels → the hotel accepts and delivers → the guest card follows', async () => {
      await say('Two more towels please');
      await guest.locator('[data-card="service"]').last().waitFor();
      await tab('tickets');
      const ticket = hotel.locator('article.ticket', { hasText: roomNumber }).filter({ has: hotel.locator('.chip-nanahotel') }).first();
      await ticket.locator('[data-action="ticket-accept"]').click();
      await hotel.locator('article.ticket[data-status="doing"]', { hasText: roomNumber }).first().waitFor();
      await guest.reload();
      await guest.locator('[data-card="service"][data-status="on_the_way"]').last().waitFor();
      await hotel.locator('article.ticket[data-status="doing"]', { hasText: roomNumber }).first().locator('[data-action^="ticket-"]').first().click();
      await guest.reload();
      await guest.locator('[data-card="service"][data-status="done"]').last().waitFor();
      await screenshot(guest, 'towels-delivered');
    });
    await step('Reviews: the guest checks out and publishes a review → the hotel replies → the guest sees the reply', async () => {
      await say("I'd like to check out");
      await say('Write a review');
      await guest.locator('[data-card="review_draft"][data-status="draft"] [data-action="publish-review"]').last().click();
      await guest.locator('.notice[data-kind="review_published"]').last().waitFor();
      await tab('reviews');
      const review = hotel.locator('article.review').filter({ has: hotel.locator('.chip-nanahotel') }).first();
      await review.locator('[data-action="open-reply"]').click();
      await review.locator('[data-action="draft-reply"]').click();
      await hotel.waitForFunction(() => document.querySelector('article.review textarea')?.value.length > 5);
      await review.locator('[data-action="send-reply"]').click();
      await review.locator('.review-reply').waitFor();
      await screenshot(hotel, 'review-replied');
      await guest.reload();
      await guest.locator('.notice[data-kind="review_replied"]').last().waitFor();
      await guest.locator('[data-card="review_draft"] .card-reply').last().waitFor();
    });
    await step('Promotions: a 15% off deal → the guest searches again and the hotel shows the deal', async () => {
      await hotel.locator('[data-action="new-promo"]').click();
      await hotel.locator('dialog[open] .seg button', { hasText: '15% off' }).click();
      await hotel.locator('dialog[open] .seg button', { hasText: 'Next 7 days' }).click();
      await hotel.locator('dialog[open] [data-action="create-promo"]').click();
      await hotel.locator('dialog[open]').waitFor({ state: 'detached' });
      await hotel.locator('.promo .switch[aria-checked="true"]').first().waitFor();
      await guest.locator('#btn-menu').click();
      await guest.locator('[data-action="new-chat"]').click();
      await guest.locator('#welcome').waitFor();
      await say(TONIGHT);
      const row = guest.locator('[data-card="hotels"] [data-action="pick-hotel"]', { hasText: hotelName }).first();
      await row.locator('.tag-promo', { hasText: '15% off' }).waitFor();
      await screenshot(guest, 'promo-in-search');
    });
    await step('At phone width the console has four tabs at the bottom and no sideways scrolling', async () => {
      await hotel.setViewportSize({ width: 360, height: 760 });
      await tab('overview');
      assert.equal(await hotel.locator('.m-tab').count(), 4);
      const overflow = await hotel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${overflow}px of horizontal overflow`);
      await screenshot(hotel, 'overview-360');
    });
    assert.deepEqual([...consoleZones], [ZONE.timezoneId], `every console request sends X-Time-Zone (saw ${[...consoleZones].join(', ')})`);
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
    log('passed');
    return 0;
  } catch (err) {
    log(`FAILED: ${err.message}`);
    if (errors.length) log(`browser errors:\n  ${errors.join('\n  ')}`);
    await screenshot(guest, 'failure-guest').catch(() => {});
    await screenshot(hotel, 'failure-hotel').catch(() => {});
    return 1;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main();
