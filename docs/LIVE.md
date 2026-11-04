# Going live with NanaHotel

NanaHotel runs as a **demo** until you give it keys: simulated hotels, simulated payments, demo landmarks, no
email. Each real service switches on by itself when its key is set, and switches off again when you remove the
key. You can go live one service at a time, and everything starts in **test mode** (sandbox) until you swap in
production keys.

| Service | What it does in NanaHotel | Key to set | Without it |
| --- | --- | --- | --- |
| AI model (Anthropic Claude, or OpenAI) | Nana's brain: understands chats, calls the tools | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | Nana explains how to set it up; `npm run demo` runs scripted answers |
| Hotels + payments (LiteAPI by Nuitée) | Real US hotels, live prices in USD, price lock, the card form, booking, cancellation | `LITEAPI_API_KEY` | Simulated hotels and a "Test mode" checkout |
| Places (Google Places API) | Finds "near Times Square" and other places on the map | `GOOGLE_PLACES_API_KEY` | Built-in demo landmarks |
| Email (Resend) | Booking confirmations and receipts | `RESEND_API_KEY` + `EMAIL_FROM` | No email (the receipt card still shows) |
| Rides (Uber, Lyft) | "Open in Uber" / "Open in Lyft" buttons with pickup and drop-off filled in | none | Always on; guests book and pay in Uber or Lyft |

---

## 1. Where keys go (and where they never go)

A key is a password. Put keys in exactly two places:

1. **Your host's environment variables** — the "Environment", "Variables", "Config vars" or "Secrets" page of
   wherever NanaHotel runs (Render, Railway, Fly.io `fly secrets set`, Heroku, a server's service file, …).
   Restart the app after changing them.
2. **GitHub Actions secrets**, for the smoke test (section 5): the repository's **Settings → Secrets and
   variables → Actions → New repository secret**, one secret per key, with the exact names below.

Never put a key in the code, a commit, an issue, a screenshot, or a chat — including a chat with Nana or any
other AI assistant. For trying things on your own computer you may use a file named `.env` in the project folder:
git already ignores it, so it is never uploaded. If a key ever leaks, revoke it in that provider's dashboard and
create a new one; nothing in NanaHotel needs to change except the variable.

When the app starts it prints one line per service (never any part of a key), for example:

```
AI model: Anthropic Claude (claude-opus-5-5, effort medium)
Hotels: LiteAPI sandbox (test bookings, nothing is charged; test card 4242 4242 4242 4242)
Places: Google Places API (New)
Email: Resend, from NanaHotel <bookings@yourdomain.com>
Rides: "Open in Uber" / "Open in Lyft" links (no key needed)
```

## 2. The variables

Names are exact (upper case, underscores). Empty means "not set".

| Variable | For | Example | Notes |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | AI | `sk-ant-…` | Anthropic Console → API keys |
| `ANTHROPIC_MODEL` | AI | `claude-opus-5-5` | Optional. Default `claude-opus-5-5`. Cheaper: `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `OPENAI_API_KEY` | AI | `sk-…` | Only if you use OpenAI instead of Anthropic |
| `OPENAI_MODEL` | AI | `gpt-5-mini` | Optional. Default `gpt-5-mini` |
| `LLM_PROVIDER` | AI | `anthropic` | Optional: `anthropic` or `openai`. If empty, the one whose key is set (Anthropic if both) |
| `LLM_EFFORT` | AI | `medium` | Optional: `low` (faster, cheaper), `medium` (default for Claude), `high` (more careful, slower) |
| `ANTHROPIC_FALLBACKS` | AI | `off` | Optional. See "Refusal fallback" below; leave empty to keep it on |
| `LITEAPI_API_KEY` | Hotels, payments | `sand_…` | The **private** key. One starting with `sand_` is the **sandbox** (test); any other key is **production** |
| `LITEAPI_PAYMENT_KEY` | (optional) | `pk_test_…` | **Not needed**: LiteAPI's card form brings its own Stripe key (checked in the sandbox). Kept for a later Stripe setup of your own; a secret key here is refused |
| `GOOGLE_PLACES_API_KEY` | Places | `AIza…` | Google Cloud → APIs & Services → Credentials |
| `RESEND_API_KEY` | Email | `re_…` | Resend → API Keys ("Sending access" is enough) |
| `EMAIL_FROM` | Email | `NanaHotel <bookings@yourdomain.com>` | Must be on a domain you verified in Resend |
| `EMAIL_REPLY_TO` | Email | `help@yourdomain.com` | Optional: where guests' replies go |
| `UBER_CLIENT_ID`, `LYFT_PARTNER_ID` | Rides | | Optional, only if Uber/Lyft gave you a partner id (credits referrals). Not secret |
| `MERCHANT_PASSWORD` | Hotel console | a long random phrase | The console at `/merchant` is open on your own computer only; on a public address it is **off** unless this is set, and then it asks for it |
| `AI_TURNS_PER_DAY` | Cost brake | `400` | At most this many replies from Nana per day for the whole server; then Nana says she is resting until tomorrow. Empty = no cap |
| `PUBLIC_URL` | Server | `https://nanahotel.onrender.com` | The server's own address (Render sets `RENDER_EXTERNAL_URL`, which is used when this is empty) |

Only for the smoke test (section 5): `SMOKE_EMAIL_TO` (send one test email there), `SMOKE_LITEAPI_BOOK=1`
(sandbox only: make, read back and cancel one test booking), `SMOKE_LITEAPI_PREBOOK=1` (with a production
LiteAPI key: also try a price lock; nothing is charged).

Advanced (normally leave empty): `LLM_API_KEY` (one key for whichever provider), `LLM_MODEL`, `LLM_BASE_URL` (a
company gateway in front of the AI provider), `LLM_TEMPERATURE` (older OpenAI models only), `LLM_THINKING=on`
(same as `LLM_EFFORT=high`).

## 3. Accounts to create — sandbox first

Do these in order; after each one you can run the smoke test to see it pass.

### AI model — Anthropic (recommended) or OpenAI

1. Create an account at **console.anthropic.com**, add a payment method or credits under Billing, and create an
   API key under **API keys**. Set it as `ANTHROPIC_API_KEY`.
2. In the Console, set a **monthly spend limit** you are comfortable with.
3. Optional: OpenAI instead — **platform.openai.com** → API keys → `OPENAI_API_KEY` (and `LLM_PROVIDER=openai`
   if both keys are set).

There is no separate sandbox for the AI: test conversations cost the same small amounts as real ones.

**Refusal fallback.** Claude has safety filters that can, rarely, decline a harmless request. NanaHotel asks
Anthropic to automatically retry such a request on another Claude model (Anthropic's `fallbacks: "default"`
option), so a false alarm does not become a dead end. It is on by default; set `ANTHROPIC_FALLBACKS=off` to turn
it off. If Anthropic does not accept the option for your account, NanaHotel notices and carries on without it.

### Hotels and payments — LiteAPI

1. Sign up at **liteapi.travel**. In the dashboard (Nuitée Connect) copy the **sandbox private API key** (it
   starts with `sand_`) → `LITEAPI_API_KEY`. That is all the card form needs too.
2. In sandbox, hotels and prices are real-looking but **nothing is booked and nobody is charged**. In the card
   form use the test card **4242 4242 4242 4242**, any future expiry date and any 3-digit CVC.
3. Book a test stay in the app end to end: search → rooms → Confirm booking → pay with the test card → you get
   the confirmation (and the email, once Resend is set up). Then cancel it from My trips.
4. To look at LiteAPI by hand (search a city, see the raw answer, try a booking call), use the dashboard's
   **API Playground**: it sends real requests with your key, so it is the quickest way to see whether a problem
   is in LiteAPI or in NanaHotel.
5. **Going to production:** finish LiteAPI's account verification and agreement in their dashboard, set your
   markup/commission there if you want one, then replace the key with the production private key. From that
   moment bookings are real and guests' cards are charged. The startup line changes to `Hotels: LiteAPI LIVE
   (real bookings, guests are charged)`, and the page drops its "Test mode" line.

### Places — Google Places API (New)

1. Go to **console.cloud.google.com**, create a project (e.g. "NanaHotel"), and attach a billing account.
2. **APIs & Services → Library**: enable **"Places API (New)"** (not the old "Places API").
3. **APIs & Services → Credentials → Create credentials → API key**. Then **edit the key**:
   - *API restrictions*: restrict it to **Places API (New)**;
   - *Application restrictions*: if your host has a fixed outgoing IP address, restrict to it.
4. Set it as `GOOGLE_PLACES_API_KEY`.
5. **Billing → Budgets & alerts**: add a monthly budget alert (e.g. $25). Under **APIs & Services → Places API
   (New) → Quotas** you can also cap requests per day.

Google has no sandbox; each search is a real (cheap) request. NanaHotel remembers every place for 24 hours, so
the hundredth "Times Square" of the day costs nothing.

### Email — Resend

1. Sign up at **resend.com**. Under **Domains**, add your domain (e.g. `nanahotel.com`) and add the DNS records it
   shows you at your domain registrar. Wait until the domain shows **Verified**.
2. **API Keys → Create API key** with "Sending access". Set it as `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to an address on the verified domain, written like `NanaHotel <bookings@nanahotel.com>`.
4. Until your domain is verified you can test with no `EMAIL_FROM`: emails then come from Resend's shared test
   sender, which only delivers to the email address of your own Resend account.

### Rides — nothing to sign up for

The ride card's "Open in Uber" / "Open in Lyft" buttons open the rider app (or website) with the trip filled in.
The guest books and pays there; NanaHotel never sees the fare or their payment.

### Later, optional — Stripe

You do not need Stripe now: LiteAPI's payment form takes the guest's card for the hotel. If you later sell things
of your own (paid extras, a membership), Stripe is the usual way to take those payments.

## 3b. What changes when hotels are live

- **Real hotels in any US city**, with LiteAPI's photos, room types, prices in USD (to the cent at checkout) and
  their own cancellation terms, shown in the hotel's time zone.
- **Checkout** is LiteAPI's card form inside the app (sandbox: card 4242 4242 4242 4242). The page says "Real hotels
  and prices" and, in the sandbox, "Test mode: bookings are tests and no card is charged".
- **The simulated stay is off**: no room keys, towels, wake-up calls, breakfast tables or front-desk check-in,
  because a real hotel never hears of them. Nana sends guests to the hotel's front desk for those, and offers
  **Uber / Lyft buttons** with the trip filled in (`get_ride_links`).
- **My trips** lists the confirmed bookings. Cancelling goes through LiteAPI and says what it costs first.
- **Emails**: with Resend set up, the booking confirmation goes to the guest's email after paying.
- **The hotel console** (`/merchant`) stays a demo over the simulated hotels, behind `MERCHANT_PASSWORD` on a
  public server.

## 3c. Hosting it (Render, US)

`render.yaml` describes the whole service: a Node web service in Virginia on the Starter plan with a 1 GB disk at
`/var/data` for the data (about $7–10 a month). Render only deploys `main`.

1. Sign in at **render.com** with GitHub and allow Render to see the `nanahotel` repository.
2. **New → Blueprint**, pick `nanahotel`, and click **Apply**. Render asks for each key: paste the same values as
   the GitHub secrets (`ANTHROPIC_API_KEY`, `LITEAPI_API_KEY`, `GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`; leave
   `EMAIL_FROM` and `LITEAPI_PAYMENT_KEY` empty for now). `MERCHANT_PASSWORD` is made for you; you find it under
   the service's **Environment** page.
3. When the deploy is green, open the address Render shows (like `https://nanahotel.onrender.com`). The log has one
   line per service (`[live] Hotels: LiteAPI sandbox …`).
4. Every push to `main` deploys again. `AI_TURNS_PER_DAY` (400 in the blueprint) caps Nana's replies per day.

**Phones.** iPhone: open the address in Safari → Share → **Add to Home Screen**. Android: in GitHub go to
**Settings → Secrets and variables → Actions → Variables** and add `NANAHOTEL_SERVER_URL` with that address; the next
Android build (any push to `main`, or **Run workflow** on "Android APK") shows the hosted server. The APK holds no
key. Without the variable it is the offline demo.

## 4. Costs to watch

Prices change; check each provider's pricing page. Figures below are what applied in late 2026.

- **Anthropic (Claude Opus 5.5):** $4 per million input tokens and $20 per million output tokens; input read from
  Anthropic's cache costs $0.20 per million, and NanaHotel uses the cache on every request. One step of Nana's
  thinking (read the chat, maybe call a tool, answer) is typically 2–8 cents; a whole booking conversation is
  often $0.20–$1. To spend less: `LLM_EFFORT=low`, or a smaller model (`ANTHROPIC_MODEL=claude-sonnet-5-5` at
  $2 / $10, or `claude-haiku-5-5` at $0.10 / $0.50) — try a few conversations first, since smaller models make
  more mistakes. The per-user chat limit (`CHAT_TURNS_PER_WINDOW`) also caps spend. Set a spend limit in the
  Anthropic Console.
- **OpenAI:** depends on the model; see platform.openai.com/pricing.
- **LiteAPI:** no fee per search on the standard plan; you earn the difference between the price you sell at and
  the hotel's net rate. Payment processing is handled by LiteAPI's payment service. Check your LiteAPI agreement
  for any platform fees and the rate limits of your plan.
- **Google Places (New) Text Search:** the fields NanaHotel asks for are billed as "Text Search Pro", about $32
  per 1,000 requests after the monthly free allowance (5,000 a month at the time of writing). With the 24-hour
  memory this is usually a few dollars a month or less. Keep the budget alert on.
- **Resend:** the free plan covers 3,000 emails a month (100 a day); the paid plan starts at $20 a month.
- **Uber / Lyft:** free for you.

## 5. The smoke test

`scripts/smoke-live.mjs` checks every service that has a key and prints one line per check, for example:

```
PASS  Hotels (LiteAPI sandbox): USD rates 2026-12-04 → 2026-12-06, 2 adults: 14/15 hotels bookable, cheapest $189/night at "…" (2.3s)
FAIL  Email (Resend): key and sending domain: [bad_request] nanahotel.com is "pending", not verified yet: guests will not get emails
SKIP  Places (Google): GOOGLE_PLACES_API_KEY is not set
```

What it checks:

| Service | Checks |
| --- | --- |
| AI (each provider with a key) | the model calls a test tool with sensible arguments; it answers using the tool's result; for Claude, whether Anthropic accepts the refusal-fallback option |
| Hotels | hotels near Times Square (names, distances, photos); USD rates for 2 nights 30 days ahead; rooms and hotel details (check-in time, phone, photos); a price lock with a card-form session (sandbox, or with `SMOKE_LITEAPI_PREBOOK=1`) — prices move all the time, so it tries up to 3 bookable rates (cheapest refundable first, different hotels first) and says which attempt worked — and that the card form key is set; with `SMOKE_LITEAPI_BOOK=1` in sandbox only: books, reads back and cancels a test booking |
| Places | "Times Square" in New York is found within 1.5 km of where it really is |
| Email | the key works and the `EMAIL_FROM` domain is verified; with `SMOKE_EMAIL_TO`, sends one test confirmation |
| Rides | the Uber and Lyft links are well formed (offline) |

It never prints keys, never books with a production key, and exits with an error only when something failed
(skipped checks are fine).

**On your computer:** with the keys in `.env`, run `node --env-file=.env scripts/smoke-live.mjs` (Node 20.6 or
newer). Add `--only=hotels,email` to check some services only.

**In GitHub Actions:** the keys are repository secrets (section 1). Two workflows use them:

- **Live smoke test** (`.github/workflows/live-smoke.yml`): every connector, one PASS / FAIL / SKIP line each. It
  runs every Monday and from the **Actions** tab (**Run workflow**). Optional repository *variables*: `EMAIL_FROM`,
  `SMOKE_EMAIL_TO` (send one test email there).
- **Live end-to-end (sandbox)** (`.github/workflows/live-e2e.yml`): the real app in a browser, with LiteAPI's
  sandbox: search near Times Square → rooms → quote → Confirm booking → the card form with the test card → booked
  → cancelled again. Run it from the Actions tab; its screenshots land on the `probe-shots` branch.

If a check fails right after going to production, put the sandbox key back while you look into it: the app keeps
working in test mode.

## 6. When something goes wrong

| You see | Likely cause | What to do |
| --- | --- | --- |
| Nana says "The AI service rejected our API key" | Wrong or revoked `ANTHROPIC_API_KEY` | Create a new key, update the variable, restart |
| "The AI service account is out of credit" | No credits / spend limit reached | Anthropic Console → Billing |
| "The AI model in the server settings wasn't found" | Typo in `ANTHROPIC_MODEL` / `OPENAI_MODEL` | Remove the variable to use the default |
| Smoke test: Hotels `[auth 401]` | Wrong `LITEAPI_API_KEY` | Copy the private key again from the LiteAPI dashboard; try the same search in its API Playground |
| The card form doesn't appear | A browser extension or network blocking Stripe, or LiteAPI's payment service is down | Try another browser; run the Live end-to-end workflow; check LiteAPI's status |
| Guests see "That room just sold out" | Hotel rooms really sell out between search and booking | Normal; Nana offers another option |
| Smoke test: Places `[auth]` | "Places API (New)" not enabled, no billing account, or the key is restricted to another API | Section 3, Places, steps 1–3 |
| Smoke test: Email "not verified" | DNS records missing or still propagating | Resend → Domains; it can take up to a day |
| Emails only reach you | No `EMAIL_FROM`, so the test sender is used | Verify your domain and set `EMAIL_FROM` |

---

## For engineers

### What each connector is

| File | Public API |
| --- | --- |
| `src/llm/providers.js` | `PROVIDERS` (`anthropic`, `openai`), `resolveLlmConfig(env)` → `{ provider, label, baseUrl, apiKey, model, temperature, thinking, configured, keyEnv, warnings, effort, fallbacks }` |
| `src/llm/client.js` | `createLlmClient({ ...resolveLlmConfig(env), fetch })` → `{ chat, provider, model }`; `LlmError` (English `userMessage`) |
| `src/llm/anthropic.js`, `openai.js`, `core.js` | Messages API adapter (streaming, tool use, thinking replay, prompt caching, refusal fallback), Chat Completions adapter, shared engine |
| `src/live/config.js` | `readLiveConfig(env)`, `describeLiveConfig(cfg)` |
| `src/live/liteapi.js` | `createLiteApiSupplier({ apiKey, paymentKey, fetch, clock, logger, geocoder })` → `searchHotels`, `getHotel`, `getRoomOffer`, `prebook`, `book`, `getBooking`, `cancelBooking`, `resolveCity`, `resolveLandmark`, `listCities`; helpers `penaltyAt`, `lowestNightly`, `findRate` |
| `src/live/places.js` | `createPlacesConnector({ apiKey, fetch, fallback })` → `geocode(text, { city, near })` → `{ name, lat, lng, address, types }`; `createSimGeocoder(simSupplier)` |
| `src/live/email.js` | `createResendMailer({ apiKey, from, replyTo, fetch })` → `send`, `sendBookingConfirmation`, `sendReceipt`; `createDisabledMailer()` |
| `src/live/rides.js` | `buildRideLinks({ pickup, dropoff })` → `{ uber: { label, url }, lyft: { label, url, appUrl, exact } }` |
| `src/live/index.js` | `createLiveServices(readLiveConfig(env), { fetch, clock, logger, simSupplier })` → `{ hotels, places, email, rides }` |

Errors from live connectors are `LiveServiceError { service, code, status, userMessage, retryable }`; `message`
is for logs (provider text with keys scrubbed), `userMessage` is short English a guest can read. Logs carry
method, path, status and time only — no bodies, query strings, guest names, emails or keys.

### When the price moves between search and "Confirm booking"

Hotel prices change by the minute. When LiteAPI refuses a price lock with *"provider price exceeds locked selling
price, please search again"* (HTTP 409, code 2001 — seen live in the sandbox), `prebook` searches that hotel once
more and locks the same room, board and refundability (else the closest rate) once more; never more than once.

- It worked: the result has `retried: true`, the locked `price` next to `expectedPrice` (what the guest saw) with
  `priceChanged`, and `rateChanged` / `boardChanged` / `cancellationChanged` when the closest rate differs from the
  one picked (`rateId` is then the new rate, `requestedRateId` the old one; `roomName` / `rateName` describe it).
  If any of these flags is set, show the guest the new terms before the card form.
- It failed again: a `LiveServiceError` with code `price_changed`, `userMessage` "The price just changed to $508
  for your stay. Please check it before you book." and `details: { hotelId, requestedRateId, rateId, rateChanged,
  oldPrice, newPrice, currency, roomName, rateName }` — what the requote card needs. Nothing left at all:
  `sold_out`.

### The payment form (checked live in LiteAPI's sandbox, Nov 2026)

`scripts/probe-payment.mjs` (branch `live-smoke`) and `test/e2e/live-e2e.mjs` ran this against the real sandbox:

1. **Confirm booking** → `POST /api/quotes/:id/confirm` → `supplier.prebook(...)` locks the price
   (`usePaymentSdk: true`) and returns `prebookId`, `transactionId` and `secretKey` (a Stripe PaymentIntent client
   secret). They are stored in the `payment_sessions` collection, never on the order. A locked price above the quote
   (or other terms) is refused as `price_changed` and Nana quotes again; a lower one is kept.
2. The sheet calls `GET /api/orders/:id/payment` (the order's owner only, only while it waits for payment), loads
   `https://payment-wrapper.liteapi.travel/dist/liteAPIPayment.js?v=a1` and mounts:

   ```js
   new LiteAPIPayment({
     publicKey: session.environment,   // 'sandbox' or 'live': the environment NAME (a pk_… key here gets a 400)
     secretKey: session.secretKey,
     targetElement: '#nana-payment-…',
     returnUrl: `${location.origin}/?paid=${order.id}`,
     submitButton: { text: 'Pay $1,729.42' },
   }).handlePayment();
   ```

   The script asks LiteAPI's `/config` for its provider (Stripe), loads `liteAPIPaymentStripe.js` and Stripe.js, and
   renders Stripe's Payment Element: Amazon Pay and Klarna buttons, then card, Afterpay, Cash App Pay and Affirm.
3. Paying sends the browser to `returnUrl` with `payment_intent`, `payment_intent_client_secret` and
   `redirect_status=succeeded`. The page removes them from the address bar at once and calls
   `POST /api/orders/:id/pay { method: 'liteapi' }`; the server books with the **stored** `transactionId`
   (`payment: { method: 'TRANSACTION_ID', transactionId }`), never one sent by the browser. Booking is never retried
   on its own; a second call while one is running answers `payment_processing`.
4. The live Content-Security-Policy (`LIVE_CSP` in `src/server.js`) allows exactly what the form loaded in the
   sandbox: `payment-wrapper.liteapi.travel`, Stripe (`js.stripe.com`, `*.stripe.com`, `b.stripecdn.com`,
   `m.stripe.network`, `hooks.stripe.com`) and hCaptcha. Hotel photos come from LiteAPI's CDN (`img-src https:`).
   The live end-to-end run reports anything the policy blocks.

### Assumptions to VERIFY (third-party APIs)

The build sandbox could not reach the providers' docs. Each assumption sits in one marked block per connector
(`VERIFY:` comments); the smoke test exercises the important ones.

- **Anthropic** (`ANTHROPIC` in `src/llm/anthropic.js`): `POST https://api.anthropic.com/v1/messages`,
  headers `x-api-key` and `anthropic-version: 2026-10-21` (no temperature/top_p/top_k on that version); default
  model `claude-opus-5-5` with `output_config.effort` (Opus 5.5 always thinks; `thinking` is omitted); stream
  events and deltas as listed there; stop reasons incl. `refusal` and `model_context_window_exceeded`;
  `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` and the `fallback` content block; thinking
  blocks replayed only while the prefix is unchanged, and a 400 mentioning a thinking signature recovered by
  stripping them; error types/status codes, `retry-after`, `x-should-retry`, `request-id`; `cache_control` on the
  last tool, the system block and the newest message block; `eager_input_streaming` on tools.
- **OpenAI** (`src/llm/openai.js`): Chat Completions; reasoning models (`gpt-5*`, `o*`) reject `temperature` and
  take `reasoning_effort`; `max_completion_tokens`; 429 `insufficient_quota` = billing; default model
  `gpt-5-mini` still offered.
- **LiteAPI** (`LITEAPI` in `src/live/liteapi.js`) — confirmed from the owner's dashboard: the private key goes in
  `X-API-Key`, sandbox private keys start with `sand_`, and the card form needs a separate publishable Payment SDK
  key. Still to verify: hosts `api.liteapi.travel/v3.0` (data, rates) and `book.liteapi.travel/v3.0` (prebook,
  book, bookings); publishable keys starting `pk_test_` / `pk_live_`; `GET /data/hotels` by
  `countryCode`+`cityName` or `latitude`+`longitude`+`radius` (meters) with `limit`; `GET /data/hotel?hotelId`
  fields (images, `checkinCheckoutTimes`, `hotelFacilities`, `phone`, `rooms` with `bedTypes`); `rating` on
  0–10; `POST /hotels/rates` body (`occupancies` with child ages, `currency`, `guestNationality`, `checkin`,
  `checkout`, `timeout`, `roomMapping`) and answer (`roomTypes[].offerId`, `offerRetailRate`, `rates[]` with
  `boardType`, `retailRate.total`, `taxesAndFees[].included`, `cancellationPolicies` `refundableTag` RFN/NRFN and
  `cancelPolicyInfos[].cancelTime` = when that fee starts, with `timezone`); "no availability" = error code 2001,
  possibly on HTTP 200 (code 2001 is also used, on a 409, for the price-change refusal above — confirmed live — so
  the message decides); board codes RO/BB/HB/FB/AI; `POST /rates/prebook { offerId, usePaymentSdk: true }` →
  `prebookId`, `price`, `priceDifferencePercent`, `cancellationChanged`, `boardChanged`, `transactionId`,
  `secretKey`; `POST /rates/book` with `holder`, `payment: { method: 'TRANSACTION_ID', transactionId }`
  (sandbox: `ACC_CREDIT_CARD`), `guests[].occupancyNumber`, `clientReference`; `GET /bookings/{id}`;
  `PUT /bookings/{id}` cancels → `status`, `cancellation_fee`, `refund_amount`; statuses CONFIRMED / PENDING /
  CANCELLED / CANCELLED_WITH_CHARGES / FAILED; the payment SDK script and options above; default child age 8 when
  none is given. The dashboard's API Playground is the quickest way to check any of these by hand.
- **Google Places (New)** (`GOOGLE_PLACES` in `src/live/places.js`): `POST
  https://places.googleapis.com/v1/places:searchText`, headers `X-Goog-Api-Key` and `X-Goog-FieldMask`
  (`places.id,places.displayName,places.formattedAddress,places.location,places.types`), body `textQuery`,
  `languageCode`, `regionCode`, `pageSize` (else the older `maxResultCount`), `locationBias.circle` (≤ 50 km);
  errors `{ error: { code, message, status } }`, an invalid key being a 400.
- **Resend** (`RESEND` in `src/live/email.js`): `POST https://api.resend.com/emails` with `Authorization:
  Bearer`, body `from`, `to[]`, `subject`, `html`, `text`, `reply_to`, `tags`; `Idempotency-Key` header; errors
  `{ statusCode, name, message }` (missing/invalid/restricted key, unverified domain, validation, rate and quota
  limits); `GET /domains` for the key check; test sender `onboarding@resend.dev`.
- **Uber / Lyft** (`RIDE_LINKS` in `src/live/rides.js`): `https://m.uber.com/ul/?action=setPickup&pickup[…]
  &dropoff[latitude|longitude|nickname|formatted_address]` (`pickup=my_location` when unknown); `https://lyft.com/ride`
  and `lyft://ridetype` with `id=lyft&pickup[latitude|longitude]&destination[latitude|longitude]`.
- **Prices quoted in section 4** (Google free allowance, Resend plans, LiteAPI fees).
