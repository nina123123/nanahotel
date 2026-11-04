import { LiveServiceError, createHttpClient, codeForStatus, parseRetryAfterMs, isPlainObject, str, num } from './http.js';

/**
 * Email through Resend: booking confirmations and receipts (HTML + plain text, American English, USD).
 * createDisabledMailer() stands in when RESEND_API_KEY is not set, so callers never need an `if`.
 */

// ---------------------------------------------------------------------------
// VERIFY: assumptions about the Resend API (resend.com/docs, as of 2025).
// ---------------------------------------------------------------------------
export const RESEND = Object.freeze({
  baseUrl: 'https://api.resend.com',
  // VERIFY: POST /emails, Authorization: Bearer re_…, body { from, to: [..], subject, html, text, reply_to?, tags?:
  // [{ name, value }] } → 200 { id }. Errors: { statusCode, name, message } — 401 missing_api_key, 403
  // invalid_api_key / restricted_api_key / "You can only send testing emails to your own email address" (domain not
  // verified), 422 validation_error / invalid_from_address, 429 rate_limit_exceeded / daily_quota_exceeded, 5xx.
  sendPath: '/emails',
  // VERIFY: GET /domains → { data: [{ name, status }] } (needs a full-access key; a sending-only key gets 403).
  domainsPath: '/domains',
  // VERIFY: an Idempotency-Key header makes a retried send deliver once (keys live 24 hours).
  idempotencyHeader: 'Idempotency-Key',
  // Resend's shared test sender: delivers only to the address of the Resend account owner.
  testSender: 'onboarding@resend.dev',
});

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
const FROM_RE = /^(?:[^<>]{1,80}<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());
}

/** "NanaHotel <bookings@nanahotel.com>" or a bare address. */
export function isFromAddress(v) {
  return typeof v === 'string' && FROM_RE.test(v.trim());
}

export function classifyResendError(status, body, headers) {
  const b = isPlainObject(body) ? body : {};
  const name = str(b.name ?? b.error?.name, 60);
  const message = str(b.message ?? b.error?.message ?? (typeof body === 'string' ? body : ''), 300);
  let code = codeForStatus(status);
  let retryable;
  if (/missing_api_key|invalid_api_key|restricted_api_key/.test(name)) code = 'auth';
  else if (/testing emails|verify a domain|domain is not verified|not verified/i.test(message)) code = 'bad_request';
  else if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') {
    code = 'rate_limit';
    retryable = false;
  } else if (name === 'rate_limit_exceeded') code = 'rate_limit';
  else if (/validation_error|invalid_from_address|invalid_to_address|invalid_parameter|missing_required_field/.test(name)) code = 'bad_request';
  return new LiveServiceError('resend', code, {
    status,
    providerCode: name,
    retryable,
    retryAfterMs: parseRetryAfterMs(headers),
    message: `Resend ${status} ${name} ${message}`.replace(/\s+/g, ' ').trim(),
  });
}

// ---------------------------------------------------------------------------
// Formatting (en-US)
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/** Exact amounts for records: $1,108 or $412.30. */
export function formatMoney(n, currency = 'USD') {
  const v = num(n);
  if (v === null) return '';
  const whole = Number.isInteger(Math.round(v * 100) / 100);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(v);
}

/** '2026-11-06' → 'Fri, Nov 6, 2026'. */
export function formatDay(date) {
  const t = Date.parse(`${String(date).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(t)) return String(date ?? '');
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(t));
}

/** '15:00' → '3:00 PM'. */
export function formatClock(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ''));
  if (!m) return fallback;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

function formatInstant(iso, timeZone) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  let tz = timeZone || 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'America/New_York';
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(t));
}

const PAYMENT_LABELS = Object.freeze({ card: 'Credit or debit card', apple_pay: 'Apple Pay', liteapi: 'Card (secure checkout)' });

function partyText(order) {
  const a = num(order.adults) ?? 0;
  const c = num(order.children) ?? 0;
  const parts = [];
  if (a) parts.push(`${a} adult${a === 1 ? '' : 's'}`);
  if (c) parts.push(`${c} child${c === 1 ? '' : 'ren'}`);
  const r = num(order.rooms) ?? 1;
  if (r > 1) parts.push(`${r} rooms`);
  return parts.join(', ');
}

function guestNames(order) {
  if (Array.isArray(order.guests) && order.guests.length) return order.guests.map((g) => (typeof g === 'string' ? g : [g?.firstName, g?.lastName].filter(Boolean).join(' '))).filter(Boolean).join(', ');
  const h = order.holder;
  return h ? [h.firstName, h.lastName].filter(Boolean).join(' ') : '';
}

function firstNameOf(order) {
  if (order.holder?.firstName) return order.holder.firstName;
  const g = Array.isArray(order.guests) ? order.guests[0] : '';
  return typeof g === 'string' ? g.split(' ')[0] : g?.firstName || '';
}

function layout({ appName, title, intro, rows, footer, note }) {
  const tr = rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b6b6b;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;color:#1f1f1f">${escapeHtml(v).replace(/\n/g, '<br>')}</td></tr>`).join('');
  return [
    '<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
    `<p style="margin:0 0 8px;font-size:13px;color:#9a7b4f;letter-spacing:.04em">${escapeHtml(appName)}</p>`,
    `<h1 style="margin:0 0 12px;font-size:22px;color:#1f1f1f">${escapeHtml(title)}</h1>`,
    `<p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.5">${escapeHtml(intro)}</p>`,
    note ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fff4d6;border-radius:8px;font-size:14px;color:#6b5200">${escapeHtml(note)}</p>` : '',
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:12px;padding:8px 16px;display:block">${tr}</table>`,
    `<p style="margin:16px 0 0;font-size:13px;color:#6b6b6b;line-height:1.5">${escapeHtml(footer)}</p>`,
    '</div></body></html>',
  ].join('');
}

function plain({ appName, title, intro, rows, footer, note }) {
  return [
    title,
    '',
    intro,
    ...(note ? ['', note] : []),
    '',
    ...rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ', ')}`),
    '',
    footer,
    `— ${appName}`,
  ].join('\n');
}

/**
 * The confirmation email for a paid order (bookings.js Order shape; hotel times from the supplier when known).
 * @param {object} order
 * @param {{ appName?: string, timeZone?: string, checkInTime?: string, checkOutTime?: string, test?: boolean }} [opts]
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildBookingConfirmationEmail(order, { appName = 'NanaHotel', checkInTime, checkOutTime, test = false } = {}) {
  const o = isPlainObject(order) ? order : {};
  const hotel = isPlainObject(o.hotel) ? o.hotel : {};
  const name = firstNameOf(o);
  const nights = num(o.nights);
  const total = num(o.payment?.amount) ?? num(o.totalPrice);
  const ci = formatClock(checkInTime ?? hotel.checkInTime, '3:00 PM');
  const co = formatClock(checkOutTime ?? hotel.checkOutTime, '11:00 AM');
  const content = {
    appName,
    title: `You're booked at ${hotel.name || 'your hotel'}`,
    intro: `${name ? `Hi ${name}, your` : 'Your'} stay is confirmed. Here are the details to keep handy.`,
    note: test || o.test || o.sandbox ? 'Test booking: no money was charged and no room is held.' : '',
    rows: [
      ['Hotel', [hotel.name, hotel.address].filter(Boolean).join('\n')],
      ['Phone', hotel.tel || ''],
      ['Check-in', o.checkIn ? `${formatDay(o.checkIn)}, from ${ci}` : ''],
      ['Check-out', o.checkOut ? `${formatDay(o.checkOut)}, by ${co}` : ''],
      ['Nights', nights ? String(nights) : ''],
      ['Room', [o.room?.name, o.rate?.name].filter(Boolean).join(' · ')],
      ['Guests', [guestNames(o), partyText(o)].filter(Boolean).join('\n')],
      ['Confirmation number', o.confirmationNo || ''],
      ['Order number', o.id || ''],
      ['Total paid', total !== null ? formatMoney(total) : ''],
      ['Cancellation', o.rate?.cancelPolicy?.text || ''],
    ],
    footer: 'Questions or changes? Just reply to this email, or ask Nana in the app.',
  };
  return {
    subject: `Booked: ${hotel.name || 'your hotel'}, ${o.checkIn ? formatDay(o.checkIn).replace(/, \d{4}$/, '') : ''}${o.checkOut ? ` – ${formatDay(o.checkOut).replace(/, \d{4}$/, '')}` : ''}`.replace(/,\s*$/, ''),
    html: layout(content),
    text: plain(content),
  };
}

/**
 * The receipt for an order: room total, paid extensions, payment method and date.
 * @param {object} order
 * @param {{ appName?: string, timeZone?: string, receiptId?: string, test?: boolean }} [opts]
 */
export function buildReceiptEmail(order, { appName = 'NanaHotel', timeZone, receiptId, test = false } = {}) {
  const o = isPlainObject(order) ? order : {};
  const hotel = isPlainObject(o.hotel) ? o.hotel : {};
  const extensions = Array.isArray(o.extensions) ? o.extensions.filter(isPlainObject) : [];
  const extTotal = extensions.reduce((s, e) => s + (num(e.amount) || 0), 0);
  const total = num(o.totalPrice);
  const roomTotal = total !== null ? total - extTotal : null;
  const pay = isPlainObject(o.payment) ? o.payment : {};
  const content = {
    appName,
    title: `Your receipt for ${hotel.name || 'your stay'}`,
    intro: 'Thanks for staying with us. This receipt shows what was paid for this booking.',
    note: test || o.test || o.sandbox ? 'Test booking: no money was charged.' : '',
    rows: [
      ['Receipt number', receiptId || ''],
      ['Order number', o.id || ''],
      ['Hotel', [hotel.name, hotel.address].filter(Boolean).join('\n')],
      ['Stay', o.checkIn && o.checkOut ? `${formatDay(o.checkIn)} – ${formatDay(o.checkOut)}` : ''],
      ['Room', [o.room?.name, o.rate?.name].filter(Boolean).join(' · ')],
      [`Room${num(o.rooms) > 1 ? 's' : ''} (${num(o.nights) ?? ''} night${num(o.nights) === 1 ? '' : 's'})`, roomTotal !== null ? formatMoney(roomTotal) : ''],
      ...extensions.map((e) => [`Extra night${num(e.nights) === 1 ? '' : 's'} (${formatDay(e.fromDate)} – ${formatDay(e.toDate)})`, formatMoney(e.amount)]),
      ['Total paid', total !== null ? formatMoney(total) : ''],
      ['Paid with', PAYMENT_LABELS[pay.method] || (pay.method ? String(pay.method) : '')],
      ['Paid on', pay.paidAt ? formatInstant(pay.paidAt, timeZone) : ''],
      ['Taxes', 'Included unless listed as paid at the hotel'],
    ],
    footer: 'Need this in another format? Reply to this email.',
  };
  return { subject: `Your receipt from ${appName}: ${hotel.name || 'your stay'}`, html: layout(content), text: plain(content) };
}

// ---------------------------------------------------------------------------
// Mailers
// ---------------------------------------------------------------------------

/**
 * @param {{ apiKey: string, from: string, replyTo?: string, fetch?: typeof fetch, logger?: object|Function,
 *           timeoutMs?: number, appName?: string, maxRetries?: number, sleep?: Function }} opts
 */
export function createResendMailer({ apiKey, from, replyTo, fetch, logger, timeoutMs = 15000, appName = 'NanaHotel', maxRetries = 2, sleep } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('createResendMailer: apiKey is required');
  const sender = String(from || '').trim() || `${appName} <${RESEND.testSender}>`;
  if (!isFromAddress(sender)) throw new Error('createResendMailer: from must look like "Name <address@domain>"');
  const http = createHttpClient({
    service: 'resend',
    baseUrl: RESEND.baseUrl,
    fetch,
    logger,
    timeoutMs,
    maxRetries,
    sleep,
    secrets: [key],
    headers: { Authorization: `Bearer ${key}` },
    classify: classifyResendError,
  });

  /**
   * @param {{ to: string|string[], subject: string, html?: string, text?: string, replyTo?: string,
   *           tags?: Array<{ name: string, value: string }>, idempotencyKey?: string, signal?: AbortSignal }} m
   *   Retried on 429/5xx only with an idempotencyKey (so a retry can never send twice).
   * @returns {Promise<{ id: string }>}
   */
  async function send({ to, subject, html, text, replyTo: reply, tags, idempotencyKey, signal } = {}) {
    const recipients = (Array.isArray(to) ? to : [to]).map((t) => String(t || '').trim()).filter(Boolean);
    if (!recipients.length || !recipients.every(isEmail)) {
      throw new LiveServiceError('resend', 'bad_request', { message: 'Resend: invalid recipient', userMessage: 'That email doesn\'t look right' });
    }
    if (!str(subject, 300) || (!html && !text)) throw new LiveServiceError('resend', 'bad_request', { message: 'Resend: subject and html or text are required' });
    const body = { from: sender, to: recipients, subject: str(subject, 300) };
    if (html) body.html = html;
    if (text) body.text = text;
    const r = reply || replyTo;
    if (r && isEmail(r)) body.reply_to = r;
    const cleanTags = (Array.isArray(tags) ? tags : [])
      .filter((t) => isPlainObject(t) && /^[A-Za-z0-9_-]{1,256}$/.test(String(t.name)) && /^[A-Za-z0-9_-]{1,256}$/.test(String(t.value)))
      .map((t) => ({ name: String(t.name), value: String(t.value) }));
    if (cleanTags.length) body.tags = cleanTags;
    const idem = str(idempotencyKey, 256);
    const { data } = await http.request({
      method: 'POST',
      path: RESEND.sendPath,
      body,
      headers: idem ? { [RESEND.idempotencyHeader]: idem } : undefined,
      retry: Boolean(idem),
      signal,
    });
    const id = str(data?.id, 100);
    if (!id) throw new LiveServiceError('resend', 'unavailable', { message: 'Resend returned no email id' });
    return { id };
  }

  return {
    enabled: true,
    provider: 'resend',
    from: sender,
    testSender: sender.includes(RESEND.testSender),
    send,
    /** @param {{ order: object, to: string, checkInTime?: string, checkOutTime?: string, test?: boolean, signal?: AbortSignal }} a */
    sendBookingConfirmation({ order, to, signal, ...opts } = {}) {
      const mail = buildBookingConfirmationEmail(order, { appName, ...opts });
      return send({ to, ...mail, idempotencyKey: order?.id ? `booking-confirmation-${order.id}` : undefined, tags: [{ name: 'type', value: 'booking_confirmation' }], signal });
    },
    /** @param {{ order: object, to: string, receiptId?: string, timeZone?: string, test?: boolean, signal?: AbortSignal }} a */
    sendReceipt({ order, to, receiptId, signal, ...opts } = {}) {
      const mail = buildReceiptEmail(order, { appName, receiptId, ...opts });
      const ref = receiptId || order?.id;
      return send({ to, ...mail, idempotencyKey: ref ? `receipt-${ref}` : undefined, tags: [{ name: 'type', value: 'receipt' }], signal });
    },
    /** Key check for the smoke test: { ok, domains } — a sending-only key answers 403 restricted_api_key. */
    async checkKey({ signal } = {}) {
      const { data } = await http.request({ path: RESEND.domainsPath, signal });
      const list = Array.isArray(data?.data) ? data.data : [];
      return { ok: true, domains: list.filter(isPlainObject).map((d) => ({ name: str(d.name, 200), status: str(d.status, 40) })) };
    },
  };
}

/** No RESEND_API_KEY: every send resolves { skipped: true } (demo mode simulates the receipt card instead). */
export function createDisabledMailer() {
  const skipped = async () => ({ skipped: true });
  return { enabled: false, provider: 'none', from: '', testSender: false, send: skipped, sendBookingConfirmation: skipped, sendReceipt: skipped, checkKey: async () => ({ ok: false, domains: [] }) };
}
