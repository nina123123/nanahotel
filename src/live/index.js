import { readLiveConfig, describeLiveConfig } from './config.js';
import { createLiteApiSupplier } from './liteapi.js';
import { createPlacesConnector, createSimGeocoder } from './places.js';
import { createResendMailer, createDisabledMailer } from './email.js';
import { buildRideLinks } from './rides.js';

export { readLiveConfig, describeLiveConfig } from './config.js';
export { createLiteApiSupplier, isLiteApiSandboxKey, LITEAPI, penaltyAt, lowestNightly, findRate, closestRate, formatUsd } from './liteapi.js';
export { createGooglePlaces, createPlacesConnector, createSimGeocoder, GOOGLE_PLACES } from './places.js';
export { createResendMailer, createDisabledMailer, buildBookingConfirmationEmail, buildReceiptEmail, RESEND } from './email.js';
export { buildRideLinks, buildUberLink, buildLyftLink, RIDE_LINKS } from './rides.js';
export { LiveServiceError, LIVE_ERROR_MESSAGES } from './http.js';

/**
 * Everything live in one call, for buildDeps (src/server.js):
 *
 *   const live = createLiveServices(readLiveConfig(env), { fetch, clock, logger, simSupplier });
 *   live.hotels   // LiteAPI supplier, or null in demo mode (keep the simulated supplier)
 *   live.places   // geocoder: Google Places with the demo landmarks as fallback (always present)
 *   live.email    // Resend mailer, or a disabled one ({ enabled: false }, sends resolve { skipped: true })
 *   live.rides    // { links(trip) } → Uber / Lyft buttons
 *
 * @param {ReturnType<typeof readLiveConfig>} cfg
 * @param {{ fetch?: typeof fetch, clock?: { now: () => Date }, logger?: object, simSupplier?: object, appName?: string }} deps
 */
export function createLiveServices(cfg = readLiveConfig({}), { fetch = globalThis.fetch, clock = { now: () => new Date() }, logger, simSupplier = null, appName = 'NanaHotel' } = {}) {
  const fallback = simSupplier ? createSimGeocoder(simSupplier) : null;
  const places = createPlacesConnector({ apiKey: cfg.places?.enabled ? cfg.places.apiKey : '', fetch, logger, fallback, now: () => clock.now().getTime() });
  const hotels = cfg.hotels?.enabled
    ? createLiteApiSupplier({ apiKey: cfg.hotels.apiKey, paymentKey: cfg.payments?.publishableKey || '', fetch, clock, logger, geocoder: places })
    : null;
  const email = cfg.email?.enabled
    ? createResendMailer({ apiKey: cfg.email.apiKey, from: cfg.email.from, replyTo: cfg.email.replyTo, fetch, logger, appName })
    : createDisabledMailer();
  const rides = { links: (trip) => buildRideLinks({ uberClientId: cfg.rides?.uberClientId, lyftPartner: cfg.rides?.lyftPartner, ...trip }) };
  return { config: cfg, describe: () => describeLiveConfig(cfg), hotels, places, email, rides };
}
