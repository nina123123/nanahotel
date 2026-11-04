// End-to-end smoke test of the chat page against a running server (scripted LLM + simulated hotels):
//   node test/e2e/run-server.js &   then   node test/e2e/smoke.mjs
// Env: BASE_URL (default http://localhost:8787), SCREENSHOT_DIR (optional), SMOKE_TIMEOUT_MS (default 30000).
// Browser-free checks of the page's pure helpers and colours run first, always (also under a bare `node --test`).
// Exits 0 with a skip message when Playwright/Chromium is unavailable; exits 1 on any failure.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderMarkdown, createSseParser, normalizePhoneInput, requoteMessage, formatStay, policyLapsed, quickReplies, greeting,
  displayText, speakable,
} from '../../public/app.js';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS) || 30000;
const FIRST_MESSAGE = '这周五去杭州西湖边住两晚，两个人，预算600以内';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const log = (...args) => console.log('[smoke]', ...args);

// ---------------------------------------------------------------------------
// Browser-free checks
// ---------------------------------------------------------------------------

function luminance(rgb) {
  const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(hexRgb(a)), luminance(hexRgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function themeTokens(css) {
  const tokens = (src) => Object.fromEntries([...src.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
  const light = tokens(/:root\s*\{([\s\S]*?)\n\}/.exec(css)[1]);
  const darkSrc = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root[^{]*\{([\s\S]*?)\}/.exec(css)?.[1];
  assert.ok(darkSrc, 'style.css 缺少深色主题的 :root 变量');
  return { light, dark: { ...light, ...tokens(darkSrc) } };
}

async function unitChecks() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);

  check('Markdown：先转义再加标签，编号列表、加粗、链接', () => {
    const html = renderMarkdown('西湖边找到这几家：\n1. **栖云** ¥568/晚 <img src=x onerror=1>\n2. 青禾 https://example.com/a');
    assert.ok(!/<img/.test(html), html);
    assert.match(html, /<ol><li><strong>栖云<\/strong> ¥568\/晚 &lt;img src=x onerror=1&gt;<\/li>/);
    assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">/);
    assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href="javascript'));
  });
  check('SSE 解析：事件被拆在多个分片里', () => {
    const got = [];
    const p = createSseParser((event, data) => got.push([event, data]));
    p.push('event: delta\ndata: {"te');
    p.push('xt":"你好"}\n\nevent: done\r\n');
    p.push('data: {}\r\n\r\n');
    p.end();
    assert.deepEqual(got, [['delta', { text: '你好' }], ['done', {}]]);
  });
  check('手机号：+86、横线、全角数字都能识别', () => {
    assert.equal(normalizePhoneInput('+86 138-1234-5678'), '13812345678');
    assert.equal(normalizePhoneInput('１３９１２３４５６７８'), '13912345678');
  });
  check('重新报价的消息带上酒店、价格方案和日期', () => {
    const msg = requoteMessage({
      hotel: { id: 'sim-hz-003', name: '晴舍精品酒店' }, room: { name: '舒适大床房' }, rate: { rateId: 'R1-BF2-FC', name: '含双早 · 免费取消' },
      checkIn: '2026-10-30', checkOut: '2026-11-01', adults: 2, rooms: 1,
    });
    assert.match(msg, /^报价失效了，请帮我重新报价：「晴舍精品酒店」的 舒适大床房 · 含双早 · 免费取消：/);
    assert.match(msg, /（hotel_id: sim-hz-003，rate_id: R1-BF2-FC，check_in: 2026-10-30，check_out: 2026-11-01）$/);
  });
  check('日期：跨年的离店日期带年份', () => {
    assert.equal(formatStay('2026-12-30', '2027-01-02', 2026), '12月30日 周三 – 2027年1月2日 周六');
  });
  check('免费取消截止时间过了就不算免费', () => {
    const policy = { type: 'free', freeUntil: '2026-10-29T18:00:00+08:00' };
    assert.equal(policyLapsed(policy, Date.parse('2026-10-29T17:59:00+08:00')), false);
    assert.equal(policyLapsed(policy, Date.parse('2026-10-29T18:00:00+08:00')), true);
  });
  check('快捷回复：回复「…」里的短句变成按钮，「订第1家」按列表展开，点「…」不算', () => {
    assert.deepEqual(quickReplies('推荐第1家～想订哪家？回复「订第1家」就行。', 3), ['订第1家', '订第2家', '订第3家']);
    assert.deepEqual(quickReplies('推荐第1个～回复「好」就帮你下单，想换就回「第2个」「第3个」。', 3), ['好', '第2个', '第3个']);
    assert.deepEqual(quickReplies('要取消的话回复「取消第N单」。', 2), ['取消第1单', '取消第2单']);
    assert.deepEqual(quickReplies('要取消的话回复「取消第N单」。', 0), []);
    assert.deepEqual(quickReplies('确认单发你啦，没问题就点「确认预订」哦。', 0), []);
    assert.deepEqual(quickReplies('你可以说「换便宜点的」或「离地铁近点」', 0), ['换便宜点的', '离地铁近点']);
  });
  check('点卡片发出的消息：气泡里不显示给模型看的 id 和日期', () => {
    const tapped = '订「晴舍精品酒店（杭州湖滨店）」的 舒适大床房 · 含双早 · 免费取消：11月6日入住，11月8日离店，2位成人，1间'
      + '（hotel_id: sim-hz-003，rate_id: R1-BF2-FC，check_in: 2026-11-06，check_out: 2026-11-08）';
    assert.equal(displayText(tapped), '订「晴舍精品酒店（杭州湖滨店）」的 舒适大床房 · 含双早 · 免费取消');
    assert.equal(displayText('西湖边有什么好吃的（推荐一下）'), '西湖边有什么好吃的（推荐一下）');
    assert.equal(displayText('订第1家'), '订第1家');
  });
  check('通话里朗读的文字：去掉 Markdown、链接、表情和颜文字', () => {
    assert.equal(speakable('找到5家～推荐第1家 **晴舍** (｡•ᴗ•｡) 🎉 https://x.com/a 共¥1,108～'), '找到5家，推荐第1家 晴舍 共¥1,108');
  });
  check('开场问候跟着时间走', () => {
    assert.equal(greeting(2), '这么晚还没睡呀');
    assert.equal(greeting(8), '早上好呀');
    assert.equal(greeting(12), '中午好呀');
    assert.equal(greeting(15), '下午好呀');
    assert.equal(greeting(21), '晚上好呀');
  });
  check('浅色/深色主题的文字对比度 ≥ 4.5', async () => {
    const css = await readFile(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
    for (const [name, t] of Object.entries(themeTokens(css))) {
      // --accent is a fill (buttons, the user's bubbles); amber text uses --accent-ink.
      const pairs = [['text', 'bg'], ['text-2', 'bg'], ['text-3', 'bg'], ['text-3', 'surface-2'], ['text', 'bubble-in'],
        ['on-bubble-out', 'bubble-out'], ['on-accent', 'accent'], ['text-2', 'surface'], ['warn', 'surface'], ['danger', 'bg'],
        ['accent-ink', 'bubble-in'], ['accent-ink', 'bg'], ['accent-ink', 'surface-2'], ['accent-ink', 'accent-soft'], ['ok', 'ok-soft'], ['ok', 'surface-2']];
      for (const [fg, bg] of pairs) {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${name}: --${fg} 在 --${bg} 上的对比度 ${ratio.toFixed(2)} < 4.5`);
      }
    }
  });

  const failures = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
      log(`ok ${name}`);
    } catch (err) {
      failures.push(name);
      log(`失败 ${name}：${err.message}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Browser run
// ---------------------------------------------------------------------------

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  // A global install is only resolvable through NODE_PATH, so also try <prefix>/lib/node_modules.
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

async function serverReachable() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function browserRun() {
  const playwright = loadPlaywright();
  if (!playwright) {
    log('跳过：未找到 playwright。');
    return 0;
  }
  if (!(await serverReachable())) {
    log(`失败：无法连接 ${BASE_URL}/api/health，请先运行 node test/e2e/run-server.js`);
    return 1;
  }
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (err) {
    log(`跳过：无法启动 Chromium（${String(err.message).split('\n')[0]}）。`);
    return 0;
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => {
    // Refused requests (e.g. the deliberate 400 for 「张先生」) are logged by the browser; the steps assert those.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  const sent = [];
  let shot = 0;
  const screenshot = async (name) => {
    if (!SCREENSHOT_DIR) return;
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${String(++shot).padStart(2, '0')}-${name}.png`) });
  };
  const step = async (name, fn) => {
    log(`… ${name}`);
    await fn();
    log(`ok ${name}`);
  };
  const idle = () => page.waitForFunction(() => !document.querySelector('.typing') && !document.getElementById('send').classList.contains('is-stop'));
  const say = async (text) => {
    sent.push(text);
    await page.locator('#input').fill(text);
    await page.locator('#input').press('Enter');
    await idle();
  };
  const lastReply = () => page.locator('.turn-in .bubble-in').last().innerText();
  // A quick reply under the last answer, tapped like a user would.
  const tap = async (text) => {
    sent.push(`[${text}]`);
    await page.locator('.quick [data-action="quick-reply"]', { hasText: text }).click();
    await idle();
  };
  const petStatus = () => page.locator('#pet-status').innerText();
  // The Rive version's `mood` input on a pet host (null while it is the SVG).
  const riveMood = (selector) => page.locator(selector).first().evaluate((el) => el.petRive?.moodValue() ?? null);

  try {
    await step('打开页面：小宿在顶部和开场页打招呼，三个示例', async () => {
      await page.goto(BASE_URL);
      await page.locator('#welcome .welcome-title').waitFor();
      assert.match(await page.locator('#thread-note').innerText(), /内容由 AI 生成/);
      assert.equal(await page.locator('#welcome [data-action="suggestion"]').count(), 3);
      assert.equal(await page.locator('#pet-header .pet[data-live]').count(), 1);
      assert.equal(await petStatus(), '情绪稳定中');
      assert.match(await page.locator('#welcome .welcome-title .sr-only').innerText(), /^(这么晚还没睡|早上好|中午好|下午好|晚上好)呀，我是小宿$/);
      await page.waitForTimeout(1500);
      await screenshot('welcome');
    });
    await step('Rive 版小宿加载后接替顶部和开场页的图', async () => {
      await page.locator('#pet-header .pet-frame.has-rive canvas').waitFor();
      await page.locator('#welcome .welcome-pet .pet-frame.has-rive canvas').waitFor();
      assert.equal(await riveMood('#pet-header'), 0);
      // The canvas really drew something.
      const drawn = await page.locator('#pet-header canvas').evaluate((c) => {
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque += 1;
        return opaque / (data.length / 4);
      });
      assert.ok(drawn > 0.2, `canvas ${Math.round(drawn * 100)}% drawn`);
    });
    await step('点一下小宿：它会有反应', async () => {
      await page.locator('#welcome .welcome-pet').click();
      await page.locator('#welcome .pet-pop:not([hidden])').waitFor();
      await page.locator('#pet-header').click();
      assert.notEqual(await petStatus(), '');
    });
    await step('中文输入法选字时按回车不会发送', async () => {
      await page.locator('#input').fill('杭州');
      await page.locator('#input').evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
      assert.equal(await page.locator('.turn-user').count(), 0);
      await page.locator('#input').fill('');
    });
    await step('打给小宿：通话开始，计时，麦克风打开，给出可以说的话', async () => {
      await page.locator('#welcome [data-action="start-call"]').click();
      assert.equal(await page.locator('#app').getAttribute('data-call'), 'live');
      await page.locator('#voice:not([hidden]) [data-action="say"]').first().waitFor();
      assert.ok((await page.locator('#voice [data-action="say"]').count()) >= 3);
      assert.equal(await page.locator('#btn-mic').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#call-time').innerText(), /^00:0\d$/);
      assert.equal(await page.locator('#welcome [data-action="start-call"]').isVisible(), false, '通话中开场页不再显示拨号按钮');
      await screenshot('call');
    });
    await step('「说」一句（模拟识别）→ 转写后发出，回复里有酒店卡片', async () => {
      const said = await page.locator('#voice [data-action="say"]').first().innerText();
      sent.push(`(语音) ${said}`);
      await page.locator('#voice [data-action="say"]').first().click();
      await page.locator('#voice-heard', { hasText: said }).waitFor();
      await page.locator('.turn-user .bubble-out.is-voice', { hasText: said }).waitFor();
      await idle();
      assert.ok(await page.locator('#voice').isHidden());
      const hotels = page.locator('[data-card="hotels"]').last();
      await hotels.waitFor();
      assert.ok((await hotels.locator('[data-action="pick-hotel"]').count()) >= 3);
      assert.match(await hotels.locator('.price').first().innerText(), /^¥/);
      assert.deepEqual(await page.locator('.quick [data-action="quick-reply"]').allInnerTexts(), ['订第1家', '订第2家', '订第3家']);
      assert.equal(await page.locator('.turn-in').last().locator('.turn-avatar .pet').count(), 1, '每段回复旁边有小宿的头像');
      assert.match(await petStatus(), /房型/);
      await screenshot('hotels');
    });
    await step('点第一家酒店 → 房型卡片；气泡里不显示 id', async () => {
      const name = await page.locator('[data-card="hotels"] [data-action="pick-hotel"] .pick-name').first().innerText();
      sent.push(`[酒店卡片：${name}]`);
      await page.locator('[data-card="hotels"] [data-action="pick-hotel"]').first().click();
      await idle();
      assert.equal(await page.locator('.turn-user .bubble-out').last().innerText(), `看看「${name}」的房型`);
      const rooms = page.locator('[data-card="rooms"]').last();
      await rooms.waitFor();
      assert.ok((await rooms.locator('[data-action="pick-rate"]').count()) >= 2);
      await screenshot('rooms');
    });
    await step('点一个价格方案 → 确认单，只有一个按钮，小宿趴在上面', async () => {
      sent.push('[房型卡片：第一个方案]');
      await page.locator('[data-card="rooms"] [data-action="pick-rate"]').first().click();
      await idle();
      assert.doesNotMatch(await page.locator('.turn-user .bubble-out').last().innerText(), /rate_id/);
      const quote = page.locator('[data-card="booking_quote"]').last();
      await quote.waitFor();
      assert.equal(await quote.locator('button').count(), 1);
      assert.match(await quote.locator('[data-action="confirm-pay"]').innerText(), /^确认预订 ¥/);
      assert.equal(await quote.locator('.card-peek .pet').count(), 1);
      assert.equal(await page.locator('.quick').count(), 0, '等着点确认单时不给快捷回复');
      assert.match(await petStatus(), /确认预订/);
      await screenshot('confirm');
    });
    await step('挂断：通话结束，记下时长', async () => {
      await page.locator('#btn-call').click();
      assert.equal(await page.locator('#app').getAttribute('data-call'), 'idle');
      await page.locator('.stamp', { hasText: '通话结束' }).last().waitFor();
    });
    await step('确认预订 → 选支付宝 → 支付 → 已订好，「我的安排」里有这单', async () => {
      await page.locator('[data-card="booking_quote"] [data-action="confirm-pay"]').last().click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('[data-method="alipay"]').click();
      await screenshot('pay-sheet');
      await sheet.locator('[data-action="pay"]').click();
      await sheet.waitFor({ state: 'detached' });
      await page.locator('[data-card="booking_quote"][data-status="confirmed"]').last().waitFor();
      await page.locator('.notice[data-kind="paid"]').last().waitFor();
      await page.locator('.notice[data-kind="paid"] + .turn-in .sticker').last().waitFor();
      assert.equal(await page.locator('#pet-header .pet').getAttribute('data-mood'), 'happy');
      assert.equal(await riveMood('#pet-header'), 4, 'Rive pet: happy');
      await page.locator('.notice[data-kind="paid"] + .turn-in .sticker .has-rive').last().waitFor();
      assert.equal(await page.locator('.turn-avatar canvas').count(), 0, 'finished replies are still pictures');
      assert.match(await petStatus(), /泡温泉/);
      await page.locator('#plans:not([hidden]) .plan-chip', { hasText: '入住' }).first().waitFor();
      await screenshot('paid');
    });
    await step('刷新后对话原样恢复（卡片、温泉贴纸也在）', async () => {
      await page.reload();
      await page.locator('[data-card="booking_quote"][data-status="confirmed"]').first().waitFor();
      await page.locator('.notice[data-kind="paid"]').first().waitFor();
      await page.locator('.notice[data-kind="paid"] + .turn-in .sticker').first().waitFor();
      await page.locator('[data-card="hotels"]').first().waitFor();
      assert.equal(await page.locator('#welcome').count(), 0);
    });
    await step('说「取消刚才那单」→ 取消确认 → 已取消', async () => {
      await say('取消刚才那单');
      const card = page.locator('[data-card="cancel_preview"]').last();
      await card.locator('[data-action="confirm-cancel"]').click();
      await page.locator('[data-card="cancel_preview"][data-status="cancelled"]').last().waitFor();
      await page.locator('.notice[data-kind="cancelled"]').last().waitFor();
      await page.waitForFunction(() => document.getElementById('plans').hidden);
      await screenshot('cancelled');
    });
    await step('打字再订一单：「订第1家」「好」的快捷回复也能用', async () => {
      await say(FIRST_MESSAGE);
      await page.locator('[data-card="hotels"]').last().waitFor();
      await tap('订第1家');
      assert.equal(await page.locator('.turn-user .bubble-out').last().innerText(), '订第1家');
      await page.locator('[data-card="rooms"]').last().waitFor();
      await tap('好');
      await page.locator('[data-card="booking_quote"][data-status="pending"] [data-action="confirm-pay"]').last().click();
      await page.locator('dialog[open] [data-action="pay"]').click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await page.locator('.notice[data-kind="paid"]').last().waitFor();
    });
    await step('到店前：规划行程、叫车（点「确认叫车」才派车）', async () => {
      await say('帮我规划一下那天的行程');
      assert.ok((await page.locator('[data-card="itinerary"]').last().locator('.timeline li').count()) >= 3);
      await say('帮我叫车去酒店');
      const ride = page.locator('[data-card="ride_quote"][data-status="quoted"]').last();
      await ride.waitFor();
      assert.match(await petStatus(), /确认叫车/);
      await ride.locator('[data-action="confirm-ride"]').click();
      await page.locator('[data-card="ride"][data-status="confirmed"] .plate').last().waitFor();
      await page.locator('.notice[data-kind="ride_confirmed"]').last().waitFor();
      await page.locator('#plans .plan-chip.is-live').first().waitFor();
      await screenshot('ride');
    });
    await step('到店：办入住 → 房号和电子房卡；「我的安排」显示房号', async () => {
      await say('我到了，帮我办入住');
      const card = page.locator('[data-card="checkin"]').last();
      assert.match(await card.locator('.roomkey-num').innerText(), /^\d{3,4}$/);
      await card.locator('[data-action="open-key"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('.keycard-num').waitFor();
      await sheet.locator('[data-action="unlock"]').click();
      await sheet.locator('.keycard.is-open').waitFor();
      await screenshot('key');
      await sheet.locator('.modal-close').click();
      await page.locator('#plans .plan-chip', { hasText: '房' }).first().waitFor();
    });
    await step('住店：送毛巾、叫醒、早餐、Wi-Fi', async () => {
      await say('送两条毛巾');
      await page.locator('[data-card="service"] .steps').last().waitFor();
      await say('明早7点叫醒我');
      assert.match(await page.locator('[data-card="wakeup"] .bigtime-num').last().innerText(), /^07:00$/);
      await say('订明天的早餐');
      await page.locator('[data-card="dining"]').last().waitFor();
      await say('Wi-Fi 密码多少');
      await page.locator('[data-card="stay_info"] .kv', { hasText: 'Wi-Fi' }).last().waitFor();
    });
    await step('续住一晚：确认续住 → 模拟支付 → 已续住', async () => {
      await say('再住一晚');
      const ext = page.locator('[data-card="extension_quote"][data-status="pending"]').last();
      await ext.locator('[data-action="confirm-extension"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('[data-action="pay"]').click();
      await sheet.waitFor({ state: 'detached' });
      await page.locator('[data-card="extension_quote"][data-status="confirmed"]').last().waitFor();
      await page.locator('.notice[data-kind="extended"]').last().waitFor();
    });
    await step('「我的安排」：这次住店和办过的事都在', async () => {
      await page.locator('#plans .plan-chip').first().click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('[data-card="trip"]').first().waitFor();
      assert.ok((await sheet.locator('[data-card]').count()) >= 4);
      await screenshot('plans');
      await sheet.locator('.modal-close').click();
    });
    await step('离店：退房账单、发票、积分、写点评（点「发布点评」才发布）', async () => {
      await say('我要退房');
      await page.locator('[data-card="bill"] .card-amount').last().waitFor();
      await say('开发票');
      await page.locator('[data-card="invoice"]').last().waitFor();
      await say('我的积分');
      await page.locator('[data-card="membership"] .level-points').last().waitFor();
      await say('写个好评');
      const review = page.locator('[data-card="review_draft"][data-status="draft"]').last();
      await review.locator('[data-action="publish-review"]').click();
      await page.locator('[data-card="review_draft"][data-status="published"]').last().waitFor();
      await page.locator('.notice[data-kind="review_published"]').last().waitFor();
      await screenshot('review');
    });
    await step('「⋯ → 常用入住人」：称呼不能当姓名，正确的能保存', async () => {
      await page.locator('#btn-menu').click();
      await page.locator('[data-action="open-profile"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('button[type="submit"]:not([disabled])').waitFor();
      await sheet.locator('input[name="guestName"]').fill('张先生');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-error', { hasText: '真实姓名' }).waitFor();
      await sheet.locator('input[name="guestName"]').fill('李明');
      await sheet.locator('input[name="contactPhone"]').fill('+86 139-1234-5678');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-status', { hasText: '已保存' }).waitFor();
      await sheet.locator('.modal-close').click();
    });
    await step('深色模式、360 宽也不出现横向滚动', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: 360, height: 740 });
      await screenshot('dark-360');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `横向溢出 ${overflow}px`);
    });
    await step('「⋯ → 新对话」回到开场白', async () => {
      await page.locator('#btn-menu').click();
      await page.locator('[data-action="new-chat"]').click();
      await page.locator('#welcome').waitFor();
      assert.equal(await page.locator('.turn-user').count(), 0);
      await page.locator('#welcome .welcome-pet .has-rive').waitFor();
    });
    await step('系统设置了「减少动态效果」：不加载 Rive，用静态的小宿', async () => {
      const still = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
      const p2 = await still.newPage();
      p2.on('pageerror', (err) => errors.push(err.message));
      await p2.goto(BASE_URL);
      await p2.locator('#welcome .welcome-title').waitFor();
      await p2.waitForTimeout(1500);
      assert.equal(await p2.locator('canvas').count(), 0);
      assert.ok(await p2.locator('#pet-header svg.pet').isVisible());
      await p2.locator('#pet-header').click();
      await p2.locator('#pet-header .pet.is-poked').waitFor();
      await still.close();
    });
    if (errors.length) throw new Error(`浏览器报错：\n${errors.join('\n')}`);
    log(`通过（发送的消息：${sent.map((s) => `"${s}"`).join('，')}）`);
    return 0;
  } catch (err) {
    log(`失败：${err.message}`);
    if (sent.length) log(`已发送的消息：\n  ${sent.join('\n  ')}`);
    const transcript = await page.locator('#messages').innerText().catch(() => '');
    if (transcript) log(`页面对话（末尾）：\n${transcript.slice(-1500)}`);
    if (errors.length) log(`浏览器报错：\n  ${errors.join('\n  ')}`);
    await screenshot('failure').catch(() => {});
    return 1;
  } finally {
    await browser.close();
  }
}

async function main() {
  const failures = await unitChecks();
  if (failures.length) {
    log(`失败：${failures.length} 项前端检查未通过`);
    return 1;
  }
  // `node --test` also picks up files under test/; the browser part needs a live server, so only run it there on request.
  if (process.env.NODE_TEST_CONTEXT && !process.env.SMOKE) {
    log('跳过浏览器部分：请先启动服务（node test/e2e/run-server.js），再用 `node test/e2e/smoke.mjs` 单独运行，或设置 SMOKE=1。');
    return 0;
  }
  return browserRun();
}

process.exitCode = await main();
