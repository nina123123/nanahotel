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
  renderMarkdown, createSseParser, requoteMessage, roomsMessage, bookMessage, policyLapsed, quickReplies, greeting,
  displayText, speakable,
} from '../../public/app.js';
import {
  clockTime, formatDate, formatDistance, formatMoney, formatPhoneInput, formatRange, normalizePhoneInput, US_PHONE_RE,
  wallTime,
} from '../../public/format.js';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS) || 30000;
// docs/US-CONTRACT.md §12: the demo phrases the scripted model handles.
const FIRST_MESSAGE = 'This Friday in New York near Times Square, two nights, under $300';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const BROWSER = { viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/New_York' };

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
  assert.ok(darkSrc, 'style.css has no :root tokens for the dark theme');
  return { light, dark: { ...light, ...tokens(darkSrc) } };
}

async function unitChecks() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);

  check('Markdown: escaped first, then numbered lists, bold and links', () => {
    const html = renderMarkdown('Here are a few near Times Square:\n1. **The Marlowe** $289/night <img src=x onerror=1>\n2. Hudson Row https://example.com/a');
    assert.ok(!/<img/.test(html), html);
    assert.match(html, /<ol><li><strong>The Marlowe<\/strong> \$289\/night &lt;img src=x onerror=1&gt;<\/li>/);
    assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">/);
    assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href="javascript'));
  });
  check('SSE parsing: an event split across chunks', () => {
    const got = [];
    const p = createSseParser((event, data) => got.push([event, data]));
    p.push('event: delta\ndata: {"te');
    p.push('xt":"Hi there"}\n\nevent: done\r\n');
    p.push('data: {}\r\n\r\n');
    p.end();
    assert.deepEqual(got, [['delta', { text: 'Hi there' }], ['done', {}]]);
  });
  check('US phone numbers: (415) 555-0123, +1, dashes and full-width digits become E.164', () => {
    for (const typed of ['(415) 555-0123', '415-555-0123', '+1 415 555 0123', '1 (415) 555-0123', '４１５５５５０１２３']) {
      assert.equal(normalizePhoneInput(typed), '+14155550123', typed);
    }
    for (const bad of ['555-0123', '+44 20 7946 0958', '(015) 555-0123', '']) assert.doesNotMatch(normalizePhoneInput(bad), US_PHONE_RE, bad);
    assert.equal(formatPhoneInput('4155550'), '(415) 555-0');
    assert.equal(formatPhoneInput('+1 4155550123'), '(415) 555-0123');
    assert.equal(formatPhoneInput('+44 20'), '+44 20');
  });
  check('Card taps send the hotel, plan, dates and party, with the ids tail last', () => {
    const query = { checkIn: '2026-11-06', checkOut: '2026-11-08', adults: 2, children: 1, rooms: 2 };
    assert.equal(roomsMessage({ id: 'sim-ny-003', name: 'The Marlowe' }, query, 2026),
      'Show me rooms at "The Marlowe" — Fri, Nov 6 to Sun, Nov 8, 2 adults, 1 child, 2 rooms (hotel_id: sim-ny-003, check_in: 2026-11-06, check_out: 2026-11-08)');
    assert.equal(bookMessage({ id: 'sim-ny-003', name: 'The Marlowe' }, { name: 'King Room' }, { rateId: 'R1-RO-FC', name: 'Room only · Free cancellation' }, { ...query, children: 0, rooms: 1 }, 2026),
      'Book "The Marlowe" · King Room · Room only · Free cancellation — Fri, Nov 6 to Sun, Nov 8, 2 adults (hotel_id: sim-ny-003, rate_id: R1-RO-FC, check_in: 2026-11-06, check_out: 2026-11-08)');
    const msg = requoteMessage({
      hotel: { id: 'sim-ny-003', name: 'The Marlowe' }, room: { name: 'King Room' }, rate: { rateId: 'R1-BF2-FC', name: 'Breakfast for 2 · Free cancellation' },
      checkIn: '2026-11-06', checkOut: '2026-11-08', adults: 2, rooms: 1,
    }, 2026);
    assert.match(msg, /^That quote expired, please quote it again: "The Marlowe" · King Room · Breakfast for 2 · Free cancellation — Fri, Nov 6 to Sun, Nov 8, 2 adults /);
    assert.match(msg, / \(hotel_id: sim-ny-003, rate_id: R1-BF2-FC, check_in: 2026-11-06, check_out: 2026-11-08\)$/);
  });
  check('Dates: "Fri, Nov 6", ranges with the year at the end only when it is not this year', () => {
    assert.equal(formatDate('2026-11-06', true, 2026), 'Fri, Nov 6');
    assert.equal(formatDate('2027-01-02', false, 2026), 'Jan 2, 2027');
    assert.equal(formatRange('2026-11-06', '2026-11-08', { refYear: 2026 }), 'Fri, Nov 6 – Sun, Nov 8');
    assert.equal(formatRange('2026-12-30', '2027-01-02', { refYear: 2026 }), 'Wed, Dec 30 – Sat, Jan 2, 2027');
    assert.equal(formatRange('2027-01-08', '2027-01-10', { refYear: 2026, sep: ' to ' }), 'Fri, Jan 8 to Sun, Jan 10, 2027');
  });
  check('Times: 12-hour, in the given zone; wall-clock HH:MM too', () => {
    assert.equal(clockTime('2026-11-06T22:30:00Z', 'America/New_York'), '5:30 PM');
    assert.equal(clockTime('2026-11-06T15:00:00Z', 'America/Los_Angeles'), '7:00 AM');
    assert.equal(wallTime('00:15'), '12:15 AM');
    assert.equal(wallTime('15:00'), '3:00 PM');
    assert.equal(wallTime('before 6 PM'), 'before 6 PM');
    assert.equal(wallTime('07:00–10:30'), '7:00–10:30 AM');
    assert.equal(wallTime('06:00-22:00'), '6:00 AM–10:00 PM');
  });
  check('Money: whole dollars from $100, cents below; distances in feet, then miles', () => {
    assert.deepEqual([1108, 289, 99.5, 18, 0].map(formatMoney), ['$1,108', '$289', '$99.50', '$18.00', '$0.00']);
    assert.equal(formatMoney(undefined), '—');
    assert.deepEqual([244, 483, 1609.344, 25000].map(formatDistance), ['800 ft', '0.3 mi', '1.0 mi', '16 mi']);
  });
  check('A free-cancel deadline that has passed is no longer free', () => {
    const policy = { type: 'free', freeUntil: '2026-11-05T18:00:00-05:00' };
    assert.equal(policyLapsed(policy, Date.parse('2026-11-05T17:59:00-05:00')), false);
    assert.equal(policyLapsed(policy, Date.parse('2026-11-05T18:00:00-05:00')), true);
  });
  check('Quick replies: "…" after Reply / Say / Type / Send; "Book #1" expands over the list; Tap "…" never counts', () => {
    assert.deepEqual(quickReplies('Here are 3 near Times Square. Reply "Book #1" to book the first one.', 3), ['Book #1', 'Book #2', 'Book #3']);
    assert.deepEqual(quickReplies('I\'d go with #1. Reply "Yes" to book it, or reply "#2" or "#3" to switch.', 3), ['Yes', '#2', '#3']);
    assert.deepEqual(quickReplies('To cancel one, reply "Cancel #N".', 2), ['Cancel #1', 'Cancel #2']);
    assert.deepEqual(quickReplies('To cancel one, reply "Cancel #N".', 0), []);
    assert.deepEqual(quickReplies('Your summary is ready. Check it over, then tap "Confirm booking".', 0), []);
    assert.deepEqual(quickReplies('You can say "Show cheaper ones" or "Closer to the subway".', 0), ['Show cheaper ones', 'Closer to the subway']);
    assert.deepEqual(quickReplies('SAY “Yes.” Or type "No", "Maybe later"', 0), ['Yes', 'No', 'Maybe later']);
    assert.deepEqual(quickReplies('The room type "Deluxe King" has a view of the park.', 0), []);
  });
  check('A tapped card message: the bubble hides the ids tail, nothing else', () => {
    const tapped = 'Book "The Marlowe (Times Square)" · King Room · Room only — Fri, Nov 6 to Sun, Nov 8, 2 adults'
      + ' (hotel_id: sim-ny-003, rate_id: R1-RO-NR, check_in: 2026-11-06, check_out: 2026-11-08)';
    assert.equal(displayText(tapped), 'Book "The Marlowe (Times Square)" · King Room · Room only — Fri, Nov 6 to Sun, Nov 8, 2 adults');
    assert.equal(displayText('Anything good to eat near the Strip? (for dinner)'), 'Anything good to eat near the Strip? (for dinner)');
    assert.equal(displayText('Book #1'), 'Book #1');
  });
  check('Read aloud in a call: no Markdown, links or emoji; "#1" becomes "number 1"', () => {
    assert.equal(speakable('Found 5 near Times Square! I\'d go with #1, **The Marlowe** 🎉 https://x.com/a — $1,108 for 2 nights · free cancellation.'),
      'Found 5 near Times Square! I\'d go with number 1, The Marlowe — $1,108 for 2 nights, free cancellation.');
    assert.equal(speakable('Booked! Off to the hot spring ♨'), 'Booked! Off to the hot spring');
  });
  check('The welcome greeting follows the time of day', () => {
    assert.equal(greeting(2), "Hey, night owl! I'm Nana");
    assert.equal(greeting(8), "Good morning, I'm Nana");
    assert.equal(greeting(13), "Good afternoon, I'm Nana");
    assert.equal(greeting(21), "Good evening, I'm Nana");
  });
  check('Light and dark themes: text contrast ≥ 4.5', async () => {
    const css = await readFile(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
    for (const [name, t] of Object.entries(themeTokens(css))) {
      // --accent is a fill (buttons, the user's bubbles); amber text uses --accent-ink.
      const pairs = [['text', 'bg'], ['text-2', 'bg'], ['text-3', 'bg'], ['text-3', 'surface-2'], ['text', 'bubble-in'],
        ['on-bubble-out', 'bubble-out'], ['on-accent', 'accent'], ['text-2', 'surface'], ['warn', 'surface'], ['danger', 'bg'],
        ['accent-ink', 'bubble-in'], ['accent-ink', 'bg'], ['accent-ink', 'surface-2'], ['accent-ink', 'accent-soft'], ['ok', 'ok-soft'], ['ok', 'surface-2']];
      for (const [fg, bg] of pairs) {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${name}: --${fg} on --${bg} contrast ${ratio.toFixed(2)} < 4.5`);
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
      log(`FAILED ${name}: ${err.message}`);
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
    log('skipped: playwright not found.');
    return 0;
  }
  if (!(await serverReachable())) {
    log(`FAILED: cannot reach ${BASE_URL}/api/health. Start the server first: node test/e2e/run-server.js`);
    return 1;
  }
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (err) {
    log(`skipped: Chromium did not start (${String(err.message).split('\n')[0]}).`);
    return 0;
  }
  const context = await browser.newContext(BROWSER);
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const errors = [];
  const zones = new Set();
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => {
    // Refused requests are logged by the browser; the steps assert those.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) zones.add(req.headers()['x-time-zone'] || '(none)');
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
  // A quick reply under the last answer, tapped like a user would.
  const tap = async (text) => {
    sent.push(`[${text}]`);
    await page.locator('.quick [data-action="quick-reply"]', { hasText: text }).first().click();
    await idle();
  };
  const petStatus = () => page.locator('#pet-status').innerText();
  // The Rive version's `mood` input on a pet host (null while it is the SVG).
  const riveMood = (selector) => page.locator(selector).first().evaluate((el) => el.petRive?.moodValue() ?? null);

  try {
    await step('Open the page: Nana says hello in the header and on the home screen, three examples', async () => {
      await page.goto(BASE_URL);
      await page.locator('#welcome .welcome-title').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(await page.locator('#app-name').innerText(), 'Nana');
      assert.match(await page.locator('#thread-note').innerText(), /AI-generated/);
      assert.deepEqual(await page.locator('#welcome [data-action="suggestion"] span:not(.chip-emoji)').allInnerTexts(), [
        'This Friday in New York near Times Square, two nights, under $300',
        'Tonight in Las Vegas on the Strip, cheap',
        'Next weekend in Miami Beach, 2 adults and 1 kid',
      ], 'the home-screen examples of §12');
      assert.equal(await page.locator('#pet-header .pet[data-live]').count(), 1);
      assert.equal(await petStatus(), 'Feeling calm');
      assert.match(await page.locator('#welcome .welcome-title .sr-only').innerText(), /^(Hey, night owl!|Good (morning|afternoon|evening),) I'm Nana$/);
      await page.waitForTimeout(1500);
      await screenshot('welcome');
    });
    await step('The Rive Nana takes over in the header and on the home screen', async () => {
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
    await step('Tap Nana: it reacts', async () => {
      await page.locator('#welcome .welcome-pet').click();
      await page.locator('#welcome .pet-pop:not([hidden])').waitFor();
      await page.locator('#pet-header').click();
      assert.notEqual(await petStatus(), '');
    });
    await step('Enter while an IME is composing does not send', async () => {
      await page.locator('#input').fill('New York');
      await page.locator('#input').evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
      assert.equal(await page.locator('.turn-user').count(), 0);
      await page.locator('#input').fill('');
    });
    await step('Call Nana: the call starts, the timer runs, the mic opens with things to say', async () => {
      await page.locator('#welcome [data-action="start-call"]').click();
      assert.equal(await page.locator('#app').getAttribute('data-call'), 'live');
      assert.equal(await page.locator('#btn-call').getAttribute('aria-label'), 'Hang up');
      await page.locator('#voice:not([hidden]) [data-action="say"]').first().waitFor();
      assert.ok((await page.locator('#voice [data-action="say"]').count()) >= 3);
      assert.equal(await page.locator('#btn-mic').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#call-time').innerText(), /^00:0\d$/);
      assert.equal(await page.locator('#welcome [data-action="start-call"]').isVisible(), false, 'no call button on the home screen during a call');
      await screenshot('call');
    });
    await step('"Say" a sentence (simulated speech) → transcribed and sent; the reply has hotel cards', async () => {
      const said = await page.locator('#voice [data-action="say"]').first().innerText();
      sent.push(`(voice) ${said}`);
      await page.locator('#voice [data-action="say"]').first().click();
      await page.locator('#voice-heard', { hasText: said }).waitFor();
      await page.locator('.turn-user .bubble-out.is-voice', { hasText: said }).waitFor();
      await idle();
      assert.ok(await page.locator('#voice').isHidden());
      const hotels = page.locator('[data-card="hotels"]').last();
      await hotels.waitFor();
      assert.ok((await hotels.locator('[data-action="pick-hotel"]').count()) >= 3);
      assert.match(await hotels.locator('.price').first().innerText(), /^\$\d/);
      const quick = await page.locator('.quick [data-action="quick-reply"]').allInnerTexts();
      assert.ok(quick.length >= 2, `quick replies: ${JSON.stringify(quick)}`);
      assert.deepEqual(quick, quick.map((_, i) => `Book #${i + 1}`), 'Reply "Book #1" expands over the hotels');
      assert.equal(await page.locator('.turn-in').last().locator('.turn-avatar .pet').count(), 1, 'every reply has Nana beside it');
      assert.match(await petStatus(), /rooms/);
      await screenshot('hotels');
    });
    await step('Tap the first hotel → room cards; the bubble hides the ids tail', async () => {
      const name = await page.locator('[data-card="hotels"] [data-action="pick-hotel"] .pick-name').first().innerText();
      sent.push(`[hotel card: ${name}]`);
      await page.locator('[data-card="hotels"] [data-action="pick-hotel"]').first().click();
      await idle();
      const bubble = await page.locator('.turn-user .bubble-out').last().innerText();
      assert.ok(bubble.startsWith(`Show me rooms at "${name}" — `), bubble);
      assert.doesNotMatch(bubble, /hotel_id/);
      const rooms = page.locator('[data-card="rooms"]').last();
      await rooms.waitFor();
      assert.ok((await rooms.locator('[data-action="pick-rate"]').count()) >= 2);
      await screenshot('rooms');
    });
    await step('Tap a rate → the booking summary, one button, Nana peeking over it', async () => {
      sent.push('[rooms card: first rate]');
      await page.locator('[data-card="rooms"] [data-action="pick-rate"]').first().click();
      await idle();
      assert.doesNotMatch(await page.locator('.turn-user .bubble-out').last().innerText(), /rate_id/);
      const quote = page.locator('[data-card="booking_quote"]').last();
      await quote.waitFor();
      assert.equal(await quote.locator('button').count(), 1);
      assert.match(await quote.locator('[data-action="confirm-pay"]').innerText(), /^Confirm booking \$\d/);
      assert.equal(await quote.locator('.card-peek .pet').count(), 1);
      assert.equal(await page.locator('.quick').count(), 0, 'no quick replies while a confirmation waits for its tap');
      assert.match(await petStatus(), /Confirm booking/);
      await screenshot('confirm');
    });
    await step('Hang up: the call ends and its length is noted', async () => {
      await page.locator('#btn-call').click();
      assert.equal(await page.locator('#app').getAttribute('data-call'), 'idle');
      await page.locator('.stamp', { hasText: 'Call ended' }).last().waitFor();
    });
    await step('Confirm booking → Apple Pay → Pay → booked; My trips shows the stay', async () => {
      await page.locator('[data-card="booking_quote"] [data-action="confirm-pay"]').last().click();
      const sheet = page.locator('dialog[open]');
      assert.match(await sheet.locator('.pay-note').innerText(), /^Test mode — you won.t be charged$/);
      assert.deepEqual(await sheet.locator('.pay-name').allInnerTexts(), ['Credit or debit card', 'Apple Pay']);
      await sheet.locator('[data-method="apple_pay"]').click();
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
      assert.match(await petStatus(), /hot spring/);
      await page.locator('#plans:not([hidden]) .plan-chip', { hasText: 'Check-in' }).first().waitFor();
      await screenshot('paid');
    });
    await step('A reload brings the chat back as it was (cards and the hot-spring sticker too)', async () => {
      await page.reload();
      await page.locator('[data-card="booking_quote"][data-status="confirmed"]').first().waitFor();
      await page.locator('.notice[data-kind="paid"]').first().waitFor();
      await page.locator('.notice[data-kind="paid"] + .turn-in .sticker').first().waitFor();
      await page.locator('[data-card="hotels"]').first().waitFor();
      assert.equal(await page.locator('#welcome').count(), 0);
    });
    await step('"Cancel that booking" → cancellation summary → cancelled', async () => {
      await say('Cancel that booking');
      const card = page.locator('[data-card="cancel_preview"]').last();
      await card.locator('[data-action="confirm-cancel"]').click();
      await page.locator('[data-card="cancel_preview"][data-status="cancelled"]').last().waitFor();
      await page.locator('.notice[data-kind="cancelled"]').last().waitFor();
      await page.waitForFunction(() => document.getElementById('plans').hidden);
      await screenshot('cancelled');
    });
    await step('Book again by typing: the "Book #1" and "Yes" quick replies work', async () => {
      await say(FIRST_MESSAGE);
      await page.locator('[data-card="hotels"]').last().waitFor();
      await tap('Book #1');
      assert.equal(await page.locator('.turn-user .bubble-out').last().innerText(), 'Book #1');
      await page.locator('[data-card="rooms"]').last().waitFor();
      await tap('Yes');
      await page.locator('[data-card="booking_quote"][data-status="pending"] [data-action="confirm-pay"]').last().click();
      await page.locator('dialog[open] [data-action="pay"]').click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await page.locator('.notice[data-kind="paid"]').last().waitFor();
    });
    await step('Before arrival: plan the day, a ride (only "Confirm ride" sends a driver)', async () => {
      await say('Plan my day');
      assert.ok((await page.locator('[data-card="itinerary"]').last().locator('.timeline li').count()) >= 3);
      assert.match(await page.locator('[data-card="itinerary"] .tl-time').first().innerText(), /^\d{1,2}:\d{2} [AP]M$/);
      await say('Get me a ride to the hotel');
      const ride = page.locator('[data-card="ride_quote"][data-status="quoted"]').last();
      await ride.waitFor();
      assert.match(await petStatus(), /Confirm ride/);
      await ride.locator('[data-action="confirm-ride"]').click();
      await page.locator('[data-card="ride"][data-status="confirmed"] .plate').last().waitFor();
      await page.locator('.notice[data-kind="ride_confirmed"]').last().waitFor();
      await page.locator('#plans .plan-chip.is-live').first().waitFor();
      await screenshot('ride');
    });
    await step('At the hotel: check in → room number and the digital key; My trips shows the room', async () => {
      await say("I'm here, check me in");
      const card = page.locator('[data-card="checkin"]').last();
      assert.match(await card.locator('.roomkey-num').innerText(), /^\d{3,4}$/);
      await card.locator('[data-action="open-key"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('.keycard-num').waitFor();
      await sheet.locator('[data-action="unlock"]').click();
      await sheet.locator('.keycard.is-open').waitFor();
      await screenshot('key');
      await sheet.locator('.modal-close').click();
      await page.locator('#plans .plan-chip', { hasText: 'Room ' }).first().waitFor();
    });
    await step('The stay: towels, a wake-up call, breakfast, Wi-Fi; asking about checkout does not check out', async () => {
      await say('Two more towels please');
      await page.locator('[data-card="service"] .steps').last().waitFor();
      await say('Wake me up at 7am');
      assert.equal(await page.locator('[data-card="wakeup"] .bigtime-num').last().innerText(), '7:00 AM');
      await say('Book breakfast for tomorrow');
      await page.locator('[data-card="dining"]').last().waitFor();
      await say("What's the Wi-Fi password?");
      await page.locator('[data-card="stay_info"] .kv', { hasText: 'Wi-Fi' }).last().waitFor();
      await say('What time is checkout?');
      assert.equal(await page.locator('[data-card="bill"]').count(), 0, 'a question about checkout never checks out');
    });
    await step('One more night: Confirm extension → test checkout → extended', async () => {
      await say('One more night');
      const ext = page.locator('[data-card="extension_quote"][data-status="pending"]').last();
      await ext.locator('[data-action="confirm-extension"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('[data-action="pay"]').click();
      await sheet.waitFor({ state: 'detached' });
      await page.locator('[data-card="extension_quote"][data-status="confirmed"]').last().waitFor();
      await page.locator('.notice[data-kind="extended"]').last().waitFor();
    });
    await step('My trips: this stay and everything arranged for it', async () => {
      await page.locator('#plans .plan-chip').first().click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('[data-card="trip"]').first().waitFor();
      assert.ok((await sheet.locator('[data-card]').count()) >= 4);
      await screenshot('plans');
      await sheet.locator('.modal-close').click();
    });
    await step('Leaving: the bill, an emailed receipt, points, a review (only "Publish review" posts it)', async () => {
      await say("I'd like to check out");
      await page.locator('[data-card="bill"] .card-amount').last().waitFor();
      await say('Email me a receipt');
      await page.locator('[data-card="receipt"]').last().waitFor();
      await say('My points');
      await page.locator('[data-card="membership"] .level-points').last().waitFor();
      assert.equal(await page.locator('[data-card="membership"] .card-kicker').last().innerText(), 'Nana Rewards');
      await say('Write a review');
      const review = page.locator('[data-card="review_draft"][data-status="draft"]').last();
      await review.locator('[data-action="publish-review"]').click();
      await page.locator('[data-card="review_draft"][data-status="published"]').last().waitFor();
      await page.locator('.notice[data-kind="review_published"]').last().waitFor();
      await screenshot('review');
    });
    await step('More → Traveler details: first and last name, email and a US phone; the saved number shows masked', async () => {
      await page.locator('#btn-menu').click();
      assert.deepEqual(await page.locator('dialog[open] .menu-item').allInnerTexts(), ['My trips', 'New chat', 'Traveler details', 'Switch to hotel console (demo)']);
      await page.locator('[data-action="open-profile"]').click();
      const sheet = page.locator('dialog[open]');
      await sheet.locator('button[type="submit"]:not([disabled])').waitFor();
      await sheet.locator('input[name="firstName"]').fill('Sarah');
      await sheet.locator('input[name="lastName"]').fill('');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-error', { hasText: 'Please enter a first and last name' }).waitFor();
      await sheet.locator('input[name="lastName"]').fill('Miller');
      await sheet.locator('input[name="email"]').fill('sarah@');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-error', { hasText: "That email doesn't look right" }).waitFor();
      await sheet.locator('input[name="email"]').fill('sarah.miller@example.com');
      await sheet.locator('input[name="contactPhone"]').fill('415 555 012');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-error', { hasText: 'Please enter a 10-digit US phone number' }).waitFor();
      await sheet.locator('input[name="contactPhone"]').fill('');
      await sheet.locator('input[name="contactPhone"]').pressSequentially('4155550123');
      assert.equal(await sheet.locator('input[name="contactPhone"]').inputValue(), '(415) 555-0123');
      await sheet.locator('button[type="submit"]').click();
      await sheet.locator('.form-status', { hasText: 'Saved' }).waitFor();
      assert.match(await sheet.locator('input[name="contactPhone"]').getAttribute('placeholder'), /0123$/);
      await screenshot('profile');
      await sheet.locator('.modal-close').click();
    });
    await step('Dark mode at 360px: no sideways scrolling', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: 360, height: 740 });
      await screenshot('dark-360');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${overflow}px of horizontal overflow`);
    });
    await step('More → New chat: back to the greeting', async () => {
      await page.locator('#btn-menu').click();
      await page.locator('[data-action="new-chat"]').click();
      await page.locator('#welcome').waitFor();
      assert.equal(await page.locator('.turn-user').count(), 0);
      await page.locator('#welcome .welcome-pet .has-rive').waitFor();
    });
    await step('Reduced motion: no Rive, the still Nana', async () => {
      const still = await browser.newContext({ ...BROWSER, reducedMotion: 'reduce' });
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
    assert.deepEqual([...zones], [BROWSER.timezoneId], `every API request sends X-Time-Zone (saw ${[...zones].join(', ')})`);
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
    log(`passed (messages sent: ${sent.map((s) => `"${s}"`).join(', ')})`);
    return 0;
  } catch (err) {
    log(`FAILED: ${err.message}`);
    if (sent.length) log(`messages sent:\n  ${sent.join('\n  ')}`);
    const transcript = await page.locator('#messages').innerText().catch(() => '');
    if (transcript) log(`the chat (end):\n${transcript.slice(-1500)}`);
    if (errors.length) log(`browser errors:\n  ${errors.join('\n  ')}`);
    await screenshot('failure').catch(() => {});
    return 1;
  } finally {
    await browser.close();
  }
}

async function main() {
  const failures = await unitChecks();
  if (failures.length) {
    log(`FAILED: ${failures.length} front-end check(s)`);
    return 1;
  }
  // `node --test` also picks up files under test/; the browser part needs a live server, so only run it there on request.
  if (process.env.NODE_TEST_CONTEXT && !process.env.SMOKE) {
    log('skipping the browser part: start the server (node test/e2e/run-server.js), then run `node test/e2e/smoke.mjs` on its own, or set SMOKE=1.');
    return 0;
  }
  return browserRun();
}

process.exitCode = await main();
