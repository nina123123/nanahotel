import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResendMailer, createDisabledMailer, buildBookingConfirmationEmail, buildReceiptEmail, classifyResendError, formatMoney, formatDay, formatClock, isFromAddress, RESEND,
} from '../src/live/email.js';
import { LiveServiceError } from '../src/live/http.js';
import { createFakeFetch } from './fakes/fake-fetch.js';

const KEY = 're_TEST_resend_key_123456';
const FROM = 'NanaHotel <bookings@nanahotel.example>';

const ORDER = {
  id: 'HA20261104123456',
  status: 'confirmed',
  hotel: { id: 'lp1a2b3', name: 'Midtown Lights Hotel', address: '123 W 44th St, New York 10036', tel: '+12125550123', city: 'New York' },
  room: { roomId: 'R1', name: 'Deluxe King', bed: '1 King bed' },
  rate: { rateId: 'Labc', name: 'Breakfast included · Free cancellation', breakfast: 2, cancelPolicy: { type: 'free', freeUntil: '2026-12-02T23:59:59.000Z', text: 'Free cancellation until Wed, Dec 2, 11:59 PM UTC. After that, cancelling costs $234.' } },
  checkIn: '2026-12-04',
  checkOut: '2026-12-06',
  nights: 2,
  rooms: 1,
  adults: 2,
  children: 1,
  guests: ['Sarah Miller', 'Tom Miller'],
  holder: { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' },
  totalPrice: 468,
  payment: { method: 'liteapi', paidAt: '2026-11-04T16:05:00.000Z', amount: 468, transactionId: 'tr_9b2c' },
  confirmationNo: 'MLH-77801',
};

function mailer(steps, opts = {}) {
  const fetch = createFakeFetch(steps);
  const logs = [];
  const m = createResendMailer({ apiKey: KEY, from: FROM, fetch, logger: { info: (x) => logs.push(x), warn: (x) => logs.push(x) }, sleep: async () => {}, ...opts });
  return { m, fetch, logs };
}

describe('Resend', () => {
  test('send: POST /emails with Bearer auth, from/to/subject/html/text, reply-to, tags, idempotency key', async () => {
    const { m, fetch } = mailer([{ json: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } }]);
    const out = await m.send({ to: 'sarah@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', replyTo: 'help@nanahotel.example', tags: [{ name: 'type', value: 'test' }, { name: 'bad tag', value: 'x' }], idempotencyKey: 'abc-1' });
    assert.deepEqual(out, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    const req = fetch.calls[0];
    assert.equal(req.url, 'https://api.resend.com/emails');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['idempotency-key'], 'abc-1');
    assert.deepEqual(req.json, { from: FROM, to: ['sarah@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', reply_to: 'help@nanahotel.example', tags: [{ name: 'type', value: 'test' }] });
  });

  test('bad input is refused before any request', async () => {
    const { m, fetch } = mailer([]);
    await assert.rejects(m.send({ to: 'not-an-email', subject: 'x', text: 'y' }), (e) => e instanceof LiveServiceError && e.code === 'bad_request' && e.userMessage === 'That email doesn\'t look right');
    await assert.rejects(m.send({ to: 'a@b.co', subject: '', text: 'y' }), { code: 'bad_request' });
    await assert.rejects(m.send({ to: 'a@b.co', subject: 'x' }), { code: 'bad_request' });
    assert.equal(fetch.calls.length, 0);
    assert.throws(() => createResendMailer({ apiKey: KEY, from: 'bookings at nanahotel' }), /from/);
    assert.throws(() => createResendMailer({ from: FROM }), /apiKey/);
  });

  test('errors map to codes; only an idempotent send is retried; the key never shows', async () => {
    const cases = [
      [401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key in the authorization header.' }, 'auth'],
      [403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }, 'auth'],
      [403, { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@example.com).' }, 'bad_request'],
      [422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }, 'bad_request'],
      [429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, 'rate_limit'],
      [429, { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }, 'rate_limit'],
      [500, { statusCode: 500, name: 'application_error', message: 'An unexpected error occurred.' }, 'unavailable'],
    ];
    for (const [status, body, code] of cases) assert.equal(classifyResendError(status, body).code, code, body.name);
    assert.equal(classifyResendError(429, { name: 'daily_quota_exceeded' }).retryable, false);

    const busy = { status: 429, json: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' } };
    const once = mailer([busy, { json: { id: 'x' } }]);
    await assert.rejects(once.m.send({ to: 'a@b.co', subject: 's', text: 't' }), { code: 'rate_limit' });
    assert.equal(once.fetch.calls.length, 1, 'no idempotency key: no retry (it could send twice)');
    const twice = mailer([busy, { json: { id: 'ok-1' } }]);
    assert.deepEqual(await twice.m.send({ to: 'a@b.co', subject: 's', text: 't', idempotencyKey: 'k1' }), { id: 'ok-1' });
    assert.equal(twice.fetch.calls.length, 2);

    const leak = mailer([{ status: 401, json: { name: 'invalid_api_key', message: `Key ${KEY} is invalid` } }]);
    const err = await leak.m.send({ to: 'a@b.co', subject: 's', text: 't' }).catch((e) => e);
    assert.ok(!err.message.includes(KEY));
    assert.ok(!leak.logs.join('\n').includes(KEY));
    assert.ok(!leak.logs.join('\n').includes('a@b.co'), 'recipients are not logged');
  });

  test('sendBookingConfirmation / sendReceipt use stable idempotency keys and a type tag', async () => {
    const { m, fetch } = mailer([{ json: { id: 'e1' } }, { json: { id: 'e2' } }]);
    await m.sendBookingConfirmation({ order: ORDER, to: 'sarah@example.com' });
    await m.sendReceipt({ order: ORDER, to: 'sarah@example.com', receiptId: 'RC123', timeZone: 'America/New_York' });
    assert.equal(fetch.calls[0].headers['idempotency-key'], 'booking-confirmation-HA20261104123456');
    assert.deepEqual(fetch.calls[0].json.tags, [{ name: 'type', value: 'booking_confirmation' }]);
    assert.equal(fetch.calls[1].headers['idempotency-key'], 'receipt-RC123');
    assert.match(fetch.calls[1].json.subject, /^Your receipt from NanaHotel: Midtown Lights Hotel$/);
  });

  test('without EMAIL_FROM the Resend test sender is used; checkKey lists domains', async () => {
    const { m, fetch } = mailer([{ json: { data: [{ id: 'd1', name: 'nanahotel.example', status: 'verified' }] } }], { from: '' });
    assert.equal(m.from, `NanaHotel <${RESEND.testSender}>`);
    assert.equal(m.testSender, true);
    assert.deepEqual(await m.checkKey(), { ok: true, domains: [{ name: 'nanahotel.example', status: 'verified' }] });
    assert.equal(fetch.calls[0].url, 'https://api.resend.com/domains');
    assert.equal(fetch.calls[0].method, 'GET');
    assert.equal(isFromAddress('bookings@nanahotel.example'), true);
    assert.equal(isFromAddress('Nana <bookings@nanahotel.example>'), true);
    assert.equal(isFromAddress('Nana bookings'), false);
  });

  test('the disabled mailer skips quietly', async () => {
    const d = createDisabledMailer();
    assert.equal(d.enabled, false);
    assert.deepEqual(await d.sendReceipt({ order: ORDER, to: 'a@b.co' }), { skipped: true });
    assert.deepEqual(await d.sendBookingConfirmation({ order: ORDER, to: 'a@b.co' }), { skipped: true });
  });
});

describe('email templates', () => {
  test('booking confirmation: the facts a guest needs, in en-US, HTML and text', () => {
    const mail = buildBookingConfirmationEmail(ORDER, { checkInTime: '16:00' });
    assert.equal(mail.subject, 'Booked: Midtown Lights Hotel, Fri, Dec 4 – Sun, Dec 6');
    for (const part of [mail.html, mail.text]) {
      assert.match(part, /Hi Sarah, your stay is confirmed/);
      assert.match(part, /Fri, Dec 4, 2026, from 4:00 PM/);
      assert.match(part, /Sun, Dec 6, 2026, by 11:00 AM/);
      assert.match(part, /MLH-77801/);
      assert.match(part, /HA20261104123456/);
      assert.match(part, /\$468/);
      assert.match(part, /Deluxe King · Breakfast included · Free cancellation/);
      assert.match(part, /Sarah Miller, Tom Miller/);
      assert.match(part, /2 adults, 1 child/);
      assert.match(part, /Free cancellation until Wed, Dec 2/);
      assert.doesNotMatch(part, /[　-鿿]/);
    }
    assert.doesNotMatch(mail.text, /<[a-z]/i);
    assert.doesNotMatch(mail.html, /Test booking/);
    assert.match(buildBookingConfirmationEmail({ ...ORDER, sandbox: true }).text, /Test booking: no money was charged/);
  });

  test('values are HTML-escaped', () => {
    const mail = buildBookingConfirmationEmail({ ...ORDER, hotel: { ...ORDER.hotel, name: '<script>alert(1)</script> & Co' } });
    assert.ok(!mail.html.includes('<script>'));
    assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co/);
  });

  test('receipt: room total, extra nights, total, payment method and time', () => {
    const order = { ...ORDER, checkOut: '2026-12-07', nights: 3, totalPrice: 702.5, extensions: [{ id: 'X1', fromDate: '2026-12-06', toDate: '2026-12-07', nights: 1, amount: 234.5 }] };
    const mail = buildReceiptEmail(order, { receiptId: 'RC123', timeZone: 'America/New_York' });
    assert.match(mail.text, /Receipt number: RC123/);
    assert.match(mail.text, /Room \(3 nights\): \$468/);
    assert.match(mail.text, /Extra night \(Sun, Dec 6, 2026 – Mon, Dec 7, 2026\): \$234\.50/);
    assert.match(mail.text, /Total paid: \$702\.50/);
    assert.match(mail.text, /Paid with: Card \(secure checkout\)/);
    assert.match(mail.text, /Paid on: Nov 4, 2026, 11:05 AM EST/);
  });

  test('formatters', () => {
    assert.equal(formatMoney(1108), '$1,108');
    assert.equal(formatMoney(412.3), '$412.30');
    assert.equal(formatDay('2026-11-06'), 'Fri, Nov 6, 2026');
    assert.equal(formatClock('15:00'), '3:00 PM');
    assert.equal(formatClock('00:30'), '12:30 AM');
    assert.equal(formatClock('', '11:00 AM'), '11:00 AM');
  });
});
