// End-to-end: the traveler side and the hotel's console are linked (docs/MERCHANT.md), against a running server:
//   node test/e2e/run-server.js &   then   node test/e2e/merchant-smoke.mjs
// Env: BASE_URL (default http://localhost:8787), SCREENSHOT_DIR (optional), SMOKE_TIMEOUT_MS (default 30000).
// A guest books tonight in 小宿; the front desk checks them in; towels go from ticket to delivered; the guest's
// review gets a reply; a promotion shows up in the guest's next search. Skips when Playwright is unavailable.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS) || 30000;
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
    log('跳过：需要先启动服务（node test/e2e/run-server.js），再单独运行本文件，或设置 SMOKE=1。');
    return 0;
  }
  const playwright = loadPlaywright();
  if (!playwright) {
    log('跳过：未找到 playwright。');
    return 0;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    log(`失败：无法连接 ${BASE_URL}/api/health，请先运行 node test/e2e/run-server.js`);
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
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const hotelCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const guest = watch(await guestCtx.newPage(), '旅客端');
  const hotel = watch(await hotelCtx.newPage(), '商家端');
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
    await step('旅客：订今晚的酒店并支付', async () => {
      await guest.goto(BASE_URL);
      await guest.locator('#welcome').waitFor();
      await say('成都春熙路附近，今晚，便宜点');
      hotelName = await guest.locator('[data-card="hotels"] .pick-name').first().innerText();
      await say('订第1家');
      await say('好');
      await guest.locator('[data-card="booking_quote"][data-status="pending"] [data-action="confirm-pay"]').last().click();
      await guest.locator('dialog[open] [data-action="pay"]').click();
      await guest.locator('dialog[open]').waitFor({ state: 'detached' });
      await guest.locator('.notice[data-kind="paid"]').last().waitFor();
    });
    await step('商家端打开就是这家酒店，概览、图表和建议都在', async () => {
      await hotel.goto(`${BASE_URL}/merchant`);
      await hotel.locator('.kpi-hero .kpi-value').waitFor();
      assert.equal(await hotel.locator('#m-hotel-name').innerText(), hotelName);
      assert.ok((await hotel.locator('.chart svg').count()) >= 2, '营收和入住率两张图');
      assert.ok((await hotel.locator('.legend-item').count()) >= 4, '订单来源的图例');
      await hotel.locator('.panel', { hasText: '今日预抵' }).locator('.chip-xiaosu').first().waitFor();
      await screenshot(hotel, 'overview');
    });
    await step('房态：小宿的客人今天预抵 → 前台办入住 → 旅客收到房号', async () => {
      await tab('rooms');
      const room = hotel.locator('.room.is-xiaosu.st-arriving').first();
      roomNumber = await room.locator('.room-no').innerText();
      await room.click();
      await hotel.locator('dialog[open] [data-action="room-check_in"]').click();
      await hotel.locator('dialog[open]').waitFor({ state: 'detached' });
      await hotel.locator(`.room.is-xiaosu.st-occupied`, { hasText: roomNumber }).waitFor();
      await screenshot(hotel, 'rooms');
      await guest.reload();
      await guest.locator('.notice[data-kind="front_desk_checkin"]').last().waitFor();
      await guest.locator('#plans .plan-chip', { hasText: `${roomNumber} 房` }).first().waitFor();
    });
    await step('工单：旅客要毛巾 → 商家接单、送达 → 旅客的卡片跟着变', async () => {
      await say('送两条毛巾');
      await guest.locator('[data-card="service"]').last().waitFor();
      await tab('tickets');
      const ticket = hotel.locator('article.ticket', { hasText: roomNumber }).filter({ hasText: '小宿' }).first();
      await ticket.locator('[data-action="ticket-accept"]').click();
      await hotel.locator('article.ticket[data-status="doing"]', { hasText: roomNumber }).first().waitFor();
      await guest.reload();
      await guest.locator('[data-card="service"][data-status="on_the_way"]').last().waitFor();
      await hotel.locator('article.ticket[data-status="doing"]', { hasText: roomNumber }).first().locator('[data-action^="ticket-"]').first().click();
      await guest.reload();
      await guest.locator('[data-card="service"][data-status="done"]').last().waitFor();
      await screenshot(guest, 'towels-delivered');
    });
    await step('点评：旅客退房写好评并发布 → 商家回复 → 旅客看到回复', async () => {
      await say('我要退房');
      await say('写个好评');
      await guest.locator('[data-card="review_draft"][data-status="draft"] [data-action="publish-review"]').last().click();
      await guest.locator('.notice[data-kind="review_published"]').last().waitFor();
      await tab('reviews');
      const review = hotel.locator('article.review').filter({ hasText: '小宿' }).first();
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
    await step('营销：开 85 折特惠 → 旅客再搜，这家酒店显示特惠价', async () => {
      await hotel.locator('[data-action="new-promo"]').click();
      await hotel.locator('dialog[open] .seg button', { hasText: '85折' }).click();
      await hotel.locator('dialog[open] .seg button', { hasText: '未来 7 天' }).click();
      await hotel.locator('dialog[open] [data-action="create-promo"]').click();
      await hotel.locator('dialog[open]').waitFor({ state: 'detached' });
      await hotel.locator('.promo .switch[aria-checked="true"]').first().waitFor();
      await guest.locator('#btn-menu').click();
      await guest.locator('[data-action="new-chat"]').click();
      await guest.locator('#welcome').waitFor();
      await say('成都春熙路附近，今晚，便宜点');
      const row = guest.locator('[data-card="hotels"] [data-action="pick-hotel"]', { hasText: hotelName }).first();
      await row.locator('.tag-promo').waitFor();
      await screenshot(guest, 'promo-in-search');
    });
    await step('手机宽度下商家端底部四个标签，不横向滚动', async () => {
      await hotel.setViewportSize({ width: 360, height: 760 });
      await tab('overview');
      assert.equal(await hotel.locator('.m-tab').count(), 4);
      const overflow = await hotel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `横向溢出 ${overflow}px`);
      await screenshot(hotel, 'overview-360');
    });
    if (errors.length) throw new Error(`浏览器报错：\n${errors.join('\n')}`);
    log('通过');
    return 0;
  } catch (err) {
    log(`失败：${err.message}`);
    if (errors.length) log(`浏览器报错：\n  ${errors.join('\n  ')}`);
    await screenshot(guest, 'failure-guest').catch(() => {});
    await screenshot(hotel, 'failure-hotel').catch(() => {});
    return 1;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main();
