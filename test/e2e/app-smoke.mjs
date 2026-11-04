// End-to-end check of the phone-app build (app/): no backend, the server code runs in the page.
//   node test/e2e/app-smoke.mjs        (SCREENSHOT_DIR=… to keep screenshots)
// Serves hotel-agent/ as static files under a sub-path, like GitHub Pages, and drives it with Playwright:
//   1. no built-in model (the web version): scripted demo — search → 订第1家 → 好 → pay, and a reload restores
//      everything from IndexedDB;
//   2. a simulated Android bridge (XiaosuNative) with a built-in DeepSeek key, against a mocked DeepSeek: the page
//      only ever sends a placeholder key, and stopping a reply cancels the native request.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.env.NODE_TEST_CONTEXT && !process.env.APP_SMOKE) {
  console.log('[app-smoke] 跳过（用 npm run test:app 运行）');
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
    console.log('[app-smoke] 跳过：未找到 playwright');
    process.exit(0);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_PATH = '/For_nina/hotel-agent/';
const SHOTS = process.env.SCREENSHOT_DIR || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

// ---- a fake OpenAI-compatible provider ----------------------------------------------------------------------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const textChunks = (text) => [...text].reduce((out, ch, i) => {
  if (i % 4 === 0) out.push('');
  out[out.length - 1] += ch;
  return out;
}, []);

/** First chat turn: call search_hotels; after the tool result: a short answer. */
function mockCompletion(body) {
  const msgs = body?.messages || [];
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const afterTool = msgs.some((m) => m.role === 'tool');
  let out = '';
  if (hasTools && !afterTool) {
    const args = JSON.stringify({ city: '杭州', near: '西湖', check_in: '2026-11-13', check_out: '2026-11-15', adults: 2 });
    out += sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_hotels', arguments: '' } }] }, finish_reason: null }] });
    for (const part of [args.slice(0, 20), args.slice(20)]) {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] });
    }
    out += sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const text = hasTools ? '【模拟模型】西湖边给你找了几家，第一家离湖最近。' : '你好';
    for (const t of textChunks(text)) out += sse({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
    out += sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  return `${out}data: [DONE]\n\n`;
}

// ---- static server ------------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/mock-llm/chat/completions') {
    let raw = '';
    for await (const c of req) raw += c;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(mockCompletion(JSON.parse(raw || '{}')));
    return;
  }
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

// 商家端 is listed when the in-page server has the merchant API.
const menuOk = (actions) => ['open-plans,new-chat,open-profile', 'open-plans,new-chat,open-profile,open-merchant'].includes(actions.join());

async function menuActions(page) {
  await page.locator('#btn-menu').click();
  const actions = await page.locator('dialog[open] .menu-item').evaluateAll((els) => els.map((e) => e.dataset.action));
  await page.locator('dialog[open] .modal-close').click();
  return actions;
}

try {
  // 1. Demo mode, the way the app starts.
  const ctx1 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await newPage(ctx1);
  await step('打开 app（没有后端，服务在页面里运行）', async () => {
    await page.goto(APP_URL);
    await page.locator('#welcome').waitFor({ timeout: 20000 });
    if (!(await page.locator('#thread-note [data-mode="demo"]').count())) throw new Error('没有内置模型时应注明是演示模式');
    if (!menuOk(await menuActions(page))) throw new Error('菜单只有「我的安排」「新对话」「常用入住人」（和「切换到商家端」），不应有 AI 设置');
    // The animated pet runs from the app's own files too (runtime and animation are bundled, no CDN).
    await page.locator('#pet-header .has-rive canvas').waitFor({ timeout: 20000 });
    await snap(page, 'welcome-demo');
  });
  await step('演示模式：说行程 → 订第1家 → 好 → 确认预订 → 支付', async () => {
    await say(page, '这周五去杭州西湖边住两晚，两个人，预算600以内');
    await say(page, '订第1家');
    await say(page, '好');
    await page.locator('[data-card="booking_quote"] [data-action="confirm-pay"]').last().click();
    const sheet = page.locator('dialog[open]');
    await sheet.locator('[data-action="pay"]').click();
    await page.locator('[data-card="booking_quote"][data-status="confirmed"]').last().waitFor({ timeout: 20000 });
    await page.locator('.notice[data-kind="paid"]').last().waitFor({ timeout: 20000 });
    await snap(page, 'order-confirmed');
  });
  await step('刷新后对话和订单还在（数据存在手机本地）', async () => {
    await page.reload();
    await page.locator('[data-card="booking_quote"][data-status="confirmed"]').first().waitFor({ timeout: 20000 });
    await page.locator('.notice[data-kind="paid"]').first().waitFor({ timeout: 20000 });
  });
  await step('演示模式：办入住 → 房号卡片，「我的安排」显示房号', async () => {
    await say(page, '我到了，帮我办入住');
    await page.locator('[data-card="checkin"] .roomkey-num').last().waitFor({ timeout: 20000 });
    await page.locator('#plans .plan-chip', { hasText: '房' }).first().waitFor({ timeout: 20000 });
    await snap(page, 'checked-in');
  });
  await step('同一个 app 里切到商家端：房态里有这位小宿客人，再回旅客端', async () => {
    await page.locator('#btn-menu').click();
    await page.locator('dialog[open] [data-action="open-merchant"]').click();
    await page.locator('.kpi-hero .kpi-value').waitFor({ timeout: 20000 });
    await page.locator('.m-tab[data-tab="rooms"]').click();
    await page.locator('.room.is-xiaosu').first().waitFor({ timeout: 20000 });
    await snap(page, 'merchant-in-app');
    await page.locator('#m-to-guest').click();
    await page.locator('#messages .turn-user').first().waitFor({ timeout: 20000 });
  });

  if (page.errors.length) throw new Error(`页面报错：\n${page.errors.join('\n')}`);
  await ctx1.close();

  // 2. The Android app with a built-in key: calls leave through the native bridge, which adds the key itself.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await ctx2.addInitScript(({ mock }) => {
    const controllers = new Map();
    window.__bridge = { starts: [], cancels: 0 };
    const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
    window.XiaosuNative = {
      hasBuiltInModel: () => true,
      start(id, url, method, headersJson, body) {
        window.__bridge.starts.push({ url, method, auth: JSON.parse(headersJson).authorization });
        const ac = new AbortController();
        controllers.set(id, ac);
        // Like the Kotlin side: answer on a later task, through window.__xiaosuHttp.
        setTimeout(async () => {
          try {
            const res = await fetch(mock, { method, body, signal: ac.signal });
            window.__xiaosuHttp.head(id, res.status, JSON.stringify({ 'content-type': res.headers.get('content-type') }));
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              window.__xiaosuHttp.chunk(id, b64(value));
            }
            window.__xiaosuHttp.end(id);
          } catch (err) {
            if (!ac.signal.aborted) window.__xiaosuHttp.fail(id, String(err));
          }
        }, 0);
      },
      cancel(id) {
        window.__bridge.cancels += 1;
        controllers.get(id)?.abort();
      },
    };
  }, { mock: `${ORIGIN}/mock-llm/chat/completions` });
  const page2 = await newPage(ctx2);
  let pageCalls = 0;
  await page2.route('https://api.deepseek.com/**', (route) => {
    pageCalls += 1;
    return route.abort();
  });
  await step('安卓桥接：模型请求走原生通道，回复正常', async () => {
    await page2.goto(APP_URL);
    await page2.locator('#welcome').waitFor({ timeout: 20000 });
    if (await page2.locator('#thread-note [data-mode="demo"]').count()) throw new Error('内置了模型就不应显示演示模式');
    if (!menuOk(await menuActions(page2))) throw new Error('菜单里不应有 AI 设置');
    await send(page2, '下下周五杭州西湖边住两晚');
    await page2.locator('.bubble-in', { hasText: '【模拟模型】' }).last().waitFor({ timeout: 20000 });
    const bridge = await page2.evaluate(() => window.__bridge);
    if (bridge.starts.length !== 2) throw new Error(`应通过桥接调用模型 2 次，实际 ${bridge.starts.length} 次`);
    // The page only has a placeholder; the real key is added on the native side.
    if (!bridge.starts.every((s) => s.url === 'https://api.deepseek.com/chat/completions' && s.method === 'POST' && s.auth === 'Bearer built-in')) {
      throw new Error(`桥接收到的请求不对：${JSON.stringify(bridge.starts)}`);
    }
    if (pageCalls) throw new Error('安卓里不应由页面直接请求模型');
    if ((await page2.evaluate(() => globalThis.xiaosuApp.mode)) !== 'ai') throw new Error('应处于真实 AI 模式');
    await snap(page2, 'real-ai-android');
  });
  await step('安卓桥接：停止回复会取消原生请求', async () => {
    await page2.route(`${ORIGIN}/mock-llm/**`, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue().catch(() => {});
    });
    await send(page2, '再找找西湖边的');
    await page2.waitForFunction(() => window.__bridge.starts.length >= 3);
    await page2.locator('#send').click();
    await page2.waitForFunction(() => window.__bridge.cancels >= 1, null, { timeout: 10000 });
    await page2.locator('.muted-line', { hasText: '已停止' }).last().waitFor({ timeout: 10000 });
  });
  if (page2.errors.length) throw new Error(`页面报错：\n${page2.errors.join('\n')}`);
  await ctx2.close();
  console.log('[app-smoke] 通过');
} catch (err) {
  failed = true;
  console.error(`[app-smoke] 失败：${err.stack || err.message}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
