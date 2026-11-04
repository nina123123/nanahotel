import { resolveLlmConfig } from '../llm/providers.js';
import { isLiteApiSandboxKey, LITEAPI } from './liteapi.js';
import { isEmail, isFromAddress, RESEND } from './email.js';

/**
 * Which live services are switched on, read from environment variables (the host's settings or GitHub Actions
 * secrets; see docs/LIVE.md). A service is on when its key is set; with no keys at all the app runs exactly as
 * the demo: simulated hotels and payments, demo landmarks, no email, and the ride links (which need no key).
 *
 * Keys are kept on the returned objects (connectors need them) but never shown: JSON.stringify and console.log
 * print "[redacted]", and describeLiveConfig() prints no part of any key.
 */

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Makes `keys` of obj print as [redacted] in JSON.stringify / console.log (the values stay readable in code). */
function guard(obj, keys = ['apiKey']) {
  const safe = function safe() {
    const out = {};
    for (const [k, v] of Object.entries(this)) out[k] = keys.includes(k) && v ? '[redacted]' : v;
    return out;
  };
  Object.defineProperty(obj, 'toJSON', { value: safe, enumerable: false });
  Object.defineProperty(obj, INSPECT, { value: safe, enumerable: false });
  return obj;
}

function pick(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ mode: 'demo'|'sandbox'|'live', demo: boolean, on: { llm: boolean, hotels: boolean, places: boolean, email: boolean, rides: boolean },
 *   llm: { provider, label, model, configured, keyEnv, effort },
 *   hotels: { enabled, provider: 'liteapi'|'sim', sandbox, apiKey?, keyEnv },
 *   payments: { provider: 'liteapi'|'sim', mode: 'sandbox'|'live'|'demo', publishableKey: string|null, environment?,
 *               scriptUrl?, testCard?, keyEnv } — publishableKey (LITEAPI_PAYMENT_KEY) is for the browser, not a secret,
 *   places: { enabled, provider: 'google'|'sim', apiKey?, keyEnv },
 *   email: { enabled, provider: 'resend'|'none', apiKey?, from, replyTo, testSender, keyEnv },
 *   rides: { enabled: true, provider: 'deeplink', uberClientId, lyftPartner },
 *   warnings: string[] }}
 */
export function readLiveConfig(env = {}) {
  const warnings = [];
  const appName = pick(env, 'APP_NAME') || 'NanaHotel';

  const llmCfg = resolveLlmConfig(env);
  const llm = { provider: llmCfg.provider, label: llmCfg.label, model: llmCfg.model, configured: llmCfg.configured, keyEnv: llmCfg.keyEnv, effort: llmCfg.effort };

  const liteKey = pick(env, 'LITEAPI_API_KEY', 'LITEAPI_KEY');
  if (liteKey && !pick(env, 'LITEAPI_API_KEY')) warnings.push('LITEAPI_KEY is being used as LITEAPI_API_KEY; please rename it');
  const sandbox = liteKey ? isLiteApiSandboxKey(liteKey) : false;
  const hotels = liteKey
    ? guard({ enabled: true, provider: 'liteapi', sandbox, apiKey: liteKey, keyEnv: 'LITEAPI_API_KEY' })
    : { enabled: false, provider: 'sim', sandbox: false, keyEnv: 'LITEAPI_API_KEY' };
  if (liteKey && !sandbox) warnings.push('LITEAPI_API_KEY is a production key: bookings are real and guests are charged');

  // The card form's publishable key goes to browsers, so anything that looks like a secret is refused.
  const payKey = pick(env, 'LITEAPI_PAYMENT_KEY');
  const prefixes = LITEAPI.paymentSdk.publishableKeyPrefixes;
  let publishableKey = '';
  if (payKey) {
    if (/^(sk|rk)_/i.test(payKey) || payKey === liteKey || isLiteApiSandboxKey(payKey) || /^prod_/i.test(payKey)) {
      warnings.push('LITEAPI_PAYMENT_KEY looks like a secret key, not the publishable "Payment SDK" key; it is not used, because it would be sent to browsers');
    } else if (!/^pk_/i.test(payKey)) {
      warnings.push(`LITEAPI_PAYMENT_KEY doesn't look like a publishable key (${prefixes.sandbox}… or ${prefixes.live}…); it is not used`);
    } else {
      publishableKey = payKey;
      if (liteKey && sandbox && payKey.startsWith(prefixes.live)) warnings.push('LITEAPI_API_KEY is a sandbox key but LITEAPI_PAYMENT_KEY is a live payment key; use the sandbox Payment SDK key');
      if (liteKey && !sandbox && payKey.startsWith(prefixes.sandbox)) warnings.push('LITEAPI_API_KEY is a production key but LITEAPI_PAYMENT_KEY is a test payment key; use the production Payment SDK key');
    }
    if (!liteKey) warnings.push('LITEAPI_PAYMENT_KEY is set but LITEAPI_API_KEY is not; the card form is only used with live hotels');
  }
  // Not needed for the card form: LiteAPI's payment script takes the environment name and fetches its own Stripe
  // key (seen live in the sandbox; a publishable key in its place is refused). Kept for a future Stripe setup.
  const payments = liteKey
    ? {
      provider: 'liteapi',
      mode: sandbox ? 'sandbox' : 'live',
      // For the front end (not secret): load scriptUrl, then mount the form with publishableKey + environment
      // and the per-order secretKey from prebook.
      publishableKey: publishableKey || null,
      environment: sandbox ? LITEAPI.paymentSdk.sandboxEnvironment : LITEAPI.paymentSdk.liveEnvironment,
      scriptUrl: LITEAPI.paymentSdk.scriptUrl,
      testCard: sandbox ? LITEAPI.sandboxTestCard : null,
      keyEnv: 'LITEAPI_PAYMENT_KEY',
    }
    : { provider: 'sim', mode: 'demo', publishableKey: null, keyEnv: 'LITEAPI_PAYMENT_KEY' };

  const placesKey = pick(env, 'GOOGLE_PLACES_API_KEY', 'GOOGLE_MAPS_API_KEY');
  const places = placesKey
    ? guard({ enabled: true, provider: 'google', apiKey: placesKey, keyEnv: 'GOOGLE_PLACES_API_KEY' })
    : { enabled: false, provider: 'sim', keyEnv: 'GOOGLE_PLACES_API_KEY' };

  const resendKey = pick(env, 'RESEND_API_KEY');
  let email = { enabled: false, provider: 'none', from: '', replyTo: '', testSender: false, keyEnv: 'RESEND_API_KEY' };
  if (resendKey) {
    let from = pick(env, 'EMAIL_FROM');
    if (from && !isFromAddress(from)) {
      warnings.push('EMAIL_FROM should look like "NanaHotel <bookings@yourdomain.com>"; using Resend\'s test sender instead');
      from = '';
    } else if (!from) {
      warnings.push('EMAIL_FROM is not set: emails come from Resend\'s test sender, which only delivers to your own Resend account address');
    }
    const replyTo = pick(env, 'EMAIL_REPLY_TO');
    if (replyTo && !isEmail(replyTo)) warnings.push('EMAIL_REPLY_TO is not a valid email address and is ignored');
    email = guard({
      enabled: true,
      provider: 'resend',
      apiKey: resendKey,
      from: from || `${appName} <${RESEND.testSender}>`,
      replyTo: replyTo && isEmail(replyTo) ? replyTo : '',
      testSender: !from,
      keyEnv: 'RESEND_API_KEY',
    });
  } else if (pick(env, 'EMAIL_FROM')) {
    warnings.push('EMAIL_FROM is set but RESEND_API_KEY is not, so no email is sent');
  }

  const rides = { enabled: true, provider: 'deeplink', uberClientId: pick(env, 'UBER_CLIENT_ID'), lyftPartner: pick(env, 'LYFT_PARTNER_ID') };

  const cfg = {
    mode: hotels.enabled ? (sandbox ? 'sandbox' : 'live') : 'demo',
    demo: !hotels.enabled,
    on: { llm: llm.configured, hotels: hotels.enabled, places: places.enabled, email: email.enabled, rides: true },
    llm,
    hotels,
    payments,
    places,
    email,
    rides,
    warnings,
  };
  return guard(cfg, []);
}

/** Startup log lines, one per service. Never includes any part of a key. */
export function describeLiveConfig(cfg) {
  const c = cfg || readLiveConfig({});
  const lines = [];
  lines.push(c.llm?.configured
    ? `AI model: ${c.llm.label} (${c.llm.model}${c.llm.effort ? `, effort ${c.llm.effort}` : ''})`
    : `AI model: not set up (set ${c.llm?.keyEnv || 'ANTHROPIC_API_KEY'}; the scripted demo needs no key)`);
  const cardForm = '';
  if (!c.hotels?.enabled) lines.push('Hotels: demo (simulated hotels and payments); set LITEAPI_API_KEY to go live');
  else if (c.hotels.sandbox) lines.push(`Hotels: LiteAPI sandbox (test bookings, nothing is charged; test card ${LITEAPI.sandboxTestCard}${cardForm})`);
  else lines.push(`Hotels: LiteAPI LIVE (real bookings, guests are charged${cardForm})`);
  lines.push(c.places?.enabled ? 'Places: Google Places API (New)' : 'Places: demo landmarks; set GOOGLE_PLACES_API_KEY for real places');
  if (!c.email?.enabled) lines.push('Email: off; set RESEND_API_KEY and EMAIL_FROM to send confirmations and receipts');
  else lines.push(`Email: Resend, from ${c.email.from}${c.email.testSender ? ' (test sender: delivers only to your Resend account address)' : ''}`);
  lines.push('Rides: "Open in Uber" / "Open in Lyft" links (no key needed)');
  return lines;
}
