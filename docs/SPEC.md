# NanaHotel: build spec (the contract for all implementers)

Product: a consumer chat concierge for US travelers. The traveler chats in a mobile web page ("This Friday in New York
near Times Square, two nights, under $300"); the agent, **Nana**, searches hotels, compares rooms and prices, and
books only after the user taps an explicit confirm button, then a test-mode payment (credit or debit card, or Apple
Pay). It also looks things up (neighborhoods and landmarks in its built-in city guide, optional web search) and runs
the stay after booking (docs/JOURNEY.md) and a hotel-side console (docs/MERCHANT.md).

NanaHotel is the US English edition of 小宿; `docs/US-CONTRACT.md` is the agreement between the three streams that
built it (front end, back end, live connectors) and wins over this file where they differ.

**In demo mode the supply side is simulated**: hotels are fictional, generated deterministically around real
neighborhoods and landmarks of 16 US cities; rooms, prices, availability, orders and payment are simulated. The hotel
supplier sits behind an interface so a real source (the live connectors in `src/live/`, docs/LIVE.md) can replace it.

Decisions (do not revisit):
- A traveler's assistant (B2C). The hotel console is a demo of the other side of the same data.
- LLM: Anthropic Claude by default, OpenAI as the alternative, both with tool calling (src/llm/, owned by the
  connectors stream). With no key, `npm run demo` uses a scripted model.
- No real-world facts may be invented: weather is NOT offered; landmark names and coordinates are real public facts;
  hotels, brands and phone numbers are fictional (555-01xx numbers).
- Web search: an optional Bocha adapter, active only when `BOCHA_API_KEY` is set; otherwise the tool is not offered.
- Form: a web chat page served by the same Node server; the phone app runs the same code in the page (app/).

The product name is configurable (`APP_NAME`, default `NanaHotel`). All user-facing copy is American English.

## Tech constraints

- Node.js ≥ 20 (CI and the container run 22), ESM (`"type": "module"`), **zero npm dependencies**.
  Built-ins only: `node:http`, `node:fs/promises`, `node:path`, `node:crypto`, `node:test`, `node:assert/strict`, global
  `fetch`, `Intl`.
- Plain JavaScript with JSDoc where it helps. No TypeScript, no build step, no bundler.
- Every module that does I/O receives its dependencies (fetch, clock, store) through a factory so tests can inject fakes.
  No module reads `process.env` except `src/config.js` (which reads the LLM settings through `resolveLlmConfig(env)`
  from `src/llm/providers.js`).
- Time zones (`src/util/dates.js`, cached `Intl.DateTimeFormat`):
  - Dates are `YYYY-MM-DD` strings; instants are ISO strings.
  - **The user's zone** comes from the `X-Time-Zone` header (an IANA name, validated and canonicalized; anything else
    falls back to `DEFAULT_TIME_ZONE`, default `America/New_York`). It decides "today", "tonight", "this Friday" in
    the prompt and when tools resolve dates, and which year notices leave out.
  - **The hotel's zone** (`hotel.timeZone`, from its city) decides every time at the hotel: free-cancellation
    deadlines, pickups, wake-up calls, dining, check-in and check-out, the digital key's expiry. Where the server
    writes a time into text it uses the hotel's zone and adds the abbreviation when it matters ("3:00 PM EST").
  - Before 6:00 AM, "tonight" means the night in progress: check-in may be yesterday's date (`earliestCheckIn`).
- Money: USD numbers. Prices shown to travelers are **all-in** whole dollars per night: (room rate + resort fee) ×
  (1 + city tax) + flat per-night fees, rounded. `taxesAndFees` says how much of the total is taxes and fees. Display
  `$1,108` (whole dollars from $100 up, cents below) via `formatUsd` in `src/util/money.js`.
- Style: 2-space indent, single quotes, semicolons, small functions, comments only where they explain *why*.

## Layout and ownership

```
nanahotel/
  package.json  .env.example  README.md                                    [back end]
  src/
    config.js                  env → config object                         [back end]
    server.js                  createApp(deps) + buildDeps + startServer   [back end]
    http/sse.js  http/static.js  SSE writer, safe static files             [back end]
    llm/providers.js  llm/client.js  llm/core.js  llm/anthropic.js  llm/openai.js   [connectors]
    llm/scripted-llm.js        the scripted demo model (no key needed)     [back end]
    live/                      LiteAPI hotels + payments, Google Places, Resend email, ride links   [connectors]
    agent/prompt.js            system prompt builder                       [back end]
    agent/agent.js             tool-calling loop for one user turn         [back end]
    agent/tools.js             tool schemas + handlers                     [back end]
    agent/text.js              notice prefix, forged-notice neutralizing   [back end]
    services/hotels/index.js   createHotelService (supplier-agnostic)      [back end]
    services/hotels/supplier.js  the supplier interface (JSDoc) + shared search phrases
    services/hotels/sim-supplier.js  simulated supplier
    services/hotels/sim-cities.js  16 cities: zone, area code, tax, neighborhoods, landmarks (real names, approx coords)
    services/hotels/sim-hotels.js  deterministic fictional hotel generator (fictional brand stems)
    services/hotels/pricing.js simulated rooms and rates (all-in)
    services/hotels/holidays.js  US holidays and big weekends 2026–2027 (price multipliers + the prompt)
    services/bookings.js       quotes, orders, payment, cancellation
    services/stays.js          the stay after booking (docs/JOURNEY.md)
    services/merchant.js       the hotel console (docs/MERCHANT.md)
    services/websearch.js      Bocha web search adapter
    services/places.js         city guide: neighborhoods + landmarks
    store/json-store.js        persistent JSON collections
    util/dates.js  util/names.js  util/money.js  util/ids.js  util/geo.js
  public/  app/  android/  tools/  test/e2e/                               [front end]
  test/*.test.js               each stream tests its own modules (llm-client / live-* are the connectors')
```

## Shared domain types (JSDoc shapes; field names are the contract)

```js
/** Hotel: what suppliers return (prices are added by the hotel service). */
Hotel = {
  id: string,              // "sim-nyc-007" (simulated); real suppliers use their own ids
  name: string,            // "Sparrow Rest Stay Hell's Kitchen" (fictional)
  city: string, state: string,   // "New York", "NY"
  district: string,        // neighborhood, "Hell's Kitchen"
  address: string,         // "Hell's Kitchen, New York, NY (simulated address)"
  location: { lng: number, lat: number } | null,
  tel: string,             // may be ''
  rating: number | null,   // 0–5, one decimal
  reviewCount: number, openedYear: number,
  amenities: string[],     // "Free Wi-Fi", "Indoor pool", "Self parking", "Fitness center" …
  category: 'budget' | 'midscale' | 'upscale' | 'luxury',
  businessArea: string,    // the guide area, "Hell's Kitchen / Midtown West"
  tags: string[],          // max 4: "Trendy", "Pool", "Great value", "Family friendly" …
  photos: string[],        // empty for simulated hotels (the page uses art/photos or a tinted placeholder)
  priceHint: number | null,// base nightly room-rate anchor
  timeZone: string,        // the hotel's IANA zone
  source: 'sim',
}

/** Search params (hotel service). Dates default to tonight → tomorrow in the user's zone when missing. */
HotelSearch = {
  city: string, keyword?: string, near?: string /* landmark text */, radiusMiles?: number /* default 2, max 12 */,
  checkIn?: string, checkOut?: string, adults?: number /* default 2 */, children?: number /* 0–6 */, rooms?: number /* default 1 */,
  priceMin?: number, priceMax?: number /* all-in per night */, categories?: Category[],
  sort?: 'recommended' | 'price_asc' | 'price_desc' | 'rating' | 'distance', limit?: number /* default 6, max 10 */,
}

HotelSearchResult = {
  query: { ...normalized HotelSearch, state, timeZone, radiusMiles, radiusKm, checkIn, checkOut, nights, datesAssumed, currency: 'USD' },
  landmark: { name, location, area } | null,     // the resolved `near`
  hotels: Array<Hotel & { distanceM, distanceMiles, lowestPrice /* all-in per night, null = sold out */, matchedKeywords, fitsParty, promo? }>,
  totalFound: number,                            // before budget filtering / limit
  notes: string[],                               // e.g. "Nothing under $150, so I widened it to $200"
  demo: boolean,
}

/** Rooms and rates (pricing.js, deterministic). */
RoomOffer = {
  hotelId, checkIn, checkOut, nights, adults, children, rooms, currency: 'USD',
  roomTypes: Array<{
    roomId: string,          // stable per hotel, "R1"
    name: string,            // "Deluxe King"
    bed: string,             // "1 King Bed", "2 Queen Beds"
    areaSqft: number, areaSqm: number, maxOccupancy: number,
    window: string,          // "Window", "Floor-to-ceiling windows", "City view", "Ocean view", "Harbor view" …
    floor: string,           // "Floors 2–5" (no 13th floor)
    rates: Array<{
      rateId: string,        // `${roomId}-${planCode}`, "R1-BB-FC"
      name: string,          // "Breakfast included · Free cancellation"
      breakfast: 0 | 1 | 2,
      cancelPolicy: { type: 'free' | 'limited' | 'none', freeUntil: string | null /* ISO with the hotel's offset */, text },
      payment: 'prepay',
      nightly: Array<{ date, price /* all-in */ }>,
      totalPrice: number,    // sum(nightly) × rooms
      taxesAndFees: number,  // the part of totalPrice that is taxes and fees
      resortFee?: number,    // per room per night, when the area charges one (Las Vegas Strip, Miami Beach, Waikiki…)
      available: boolean, remaining: number | null, unavailableReason: null | 'sold_out' | 'occupancy',
    }>,
  }>,
  demo: boolean, priceDisclaimer: 'Simulated prices for the demo; totals include taxes and fees',
}

/** Quote: a booking the agent prepared, awaiting the user's tap. Created ONLY by bookings.prepareBooking. */
Quote = {
  id: 'Q…', userId, sessionId, status: 'pending' | 'confirmed' | 'expired' | 'superseded',
  hotel: { id, name, address, tel, city, state, district, timeZone }, room: { roomId, name, bed },
  rate: { rateId, name, breakfast, cancelPolicy },
  checkIn, checkOut, nights, rooms, adults, children,
  guests: string[],          // full names ("Sarah Miller"), at least one per room
  holder: { firstName, lastName, email },   // who booked: the saved traveler details, else the first guest
  contactPhone: string,      // E.164 "+14155550123" server-side; every public view shows "***-***-0123"
  arrivalTime: string, specialRequests: string,
  nightly: [{ date, price }], totalPrice, taxesAndFees, currency: 'USD',
  createdAt, expiresAt,      // ISO; quotes expire after 15 minutes
  orderId: string | null,
}

/** Order lifecycle: pending_payment → confirmed → (cancelled); pending_payment → closed (unpaid for 15 minutes). */
Order = {
  id: 'HA' + yyyymmdd + 6 digits, userId, quoteId, sessionId,
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'closed',
  ...the quote's hotel / room / rate / dates / guests / holder / contactPhone / arrivalTime / specialRequests / nightly / totalPrice / taxesAndFees / currency,
  payment: { method: 'card' | 'apple_pay', paidAt, amount, transactionId } | null,
  confirmationNo: string | null,       // simulated 8-digit hotel confirmation number, set when paid
  cancellation: { cancelledAt, penalty, refund, reason } | null,
  extensions?: [...],                  // paid extensions (stays.js)
  createdAt, payBy, updatedAt,
}
```

## Module APIs

### util
- `dates.js`: `canonicalTimeZone(zone)`, `isValidTimeZone(zone)`, `resolveTimeZone(zone, fallback)`, `todayIn(zone, now)`,
  `nowIn(zone, now) → { date, time, weekday }`, `dateIn(instant, zone)`, `timeIn(instant, zone)`, `zonedTimeMs(date, 'HH:MM', zone)`
  (DST-safe), `toIsoInZone(date, 'HH:MM', zone) → '2026-11-05T15:00:00-05:00'`, `zoneAbbr(instant, zone) → 'EST'`,
  `addDays`, `nightsBetween`, `isValidDate`, `isValidTime`, `weekdayShort`, `formatDate(date, ref) → 'Fri, Nov 6'` (year
  only when it differs from `ref`'s), `formatRange`, `formatTime('14:30') → '2:30 PM'`, `formatDateTime`, `formatClock`,
  `isLateNight(now, zone)`, `earliestCheckIn(now, zone)`, `checkStay(checkIn, checkOut, today, opts)` (1–30 nights, at most
  365 days ahead).
- `names.js`: `guestNameProblem(name) → 'format' | 'placeholder' | 'incomplete' | null` (a guest needs a first and last
  name; titles, "Guest", "test", "my wife" are not names), `namePartProblem(part)`, `splitFullName`, `fullName`,
  `maskedGuestName('Sarah Miller') → 'Sarah M.'`.
- `money.js`: `formatUsd(n)`, `cents(n)`. `ids.js`: `newId(prefix)`, `orderNo(now)`, `isUuid(s)`, `confirmationNo()`,
  `transactionId(method, now)`. `geo.js`: `distanceM(a, b)` (haversine, meters).

### store/json-store.js
`createJsonStore({ dir, debounceMs, fs? })` → `{ load(), collection(name) → { get, set, delete, values, find, size }, flush(), close() }`.
Debounced atomic writes (`name.json.tmp` then rename, mode 0600). `dir: null` = in memory (tests).
Collections: `sessions`, `quotes`, `orders`, `profiles`, plus the stay and console collections of JOURNEY.md / MERCHANT.md.

### services/hotels
`createHotelService({ supplier, clock, promotions })` where supplier is `createSimSupplier()`.
Supplier interface (supplier.js documents it so a live adapter can implement it):
`{ source, listCities() → [{ name, state, timeZone, … }], resolveCity(text), resolveLandmark(city, text) → { name, location, area, matched } | null,
   listAreas(city), searchHotels({ city, keyword, location, radiusM, categories }) → Hotel[] (unpriced), getHotel(id) }`.
Unsupported city → `HotelError { code: 'city_not_supported', message: 'The demo covers New York, Los Angeles, … "X" isn't covered yet' }`.

Simulated data: the 16 cities of US-CONTRACT §11, each with its IANA zone, area code, hotel tax, market (business /
leisure / mixed), 4–7 neighborhoods (approx coordinates, a reason to stay, landmarks, airports and stations) and
18–30 fictional hotels (314 in all) with a realistic category mix. Names come from fictional brand stems (no real
brands; a trademark guard rejects real chain words). Addresses read "Hell's Kitchen, New York, NY (simulated
address)". Generation is deterministic (seeded by city + index), so ids, names and prices are stable across restarts.

Service: `searchHotels(HotelSearch) → HotelSearchResult`, `getRoomOffer({ hotelId, checkIn, checkOut, adults, children, rooms }) → { hotel, offer }`,
`getHotel(id)`, `listCities()`, `priceCheck({ hotelId, rateId, checkIn, checkOut, rooms, adults, children }) → { hotel, roomType, rate }` or throws.

pricing.js: `buildRoomOffer(hotel, { checkIn, checkOut, adults, children, rooms, city, now })`, `lowestNightly(hotel, opts)`.
Deterministic (hash of hotel id + date). Base anchored to `priceHint` (city price level × category); weekday factors
by market (leisure cities peak Friday and Saturday, business cities midweek); holiday and big-weekend multipliers
(holidays.js) per market; seasons per city; a hashed jitter; a cap on stacked factors. Room types: budget 2, midscale
3, upscale 4, luxury 4 including a suite. Rate plans per category: the cheapest non-refundable plan, then free
cancellation and/or breakfast at +6–25%; a paid-extra plan always costs at least $10 a night more than the cheapest.
Cancellation: free until 3:00 PM hotel time the day before check-in (`limited`: three days before), then the first
night is charged; `none` is non-refundable. Occupancy: rooms × maxOccupancy must hold adults + children, else
`unavailableReason: 'occupancy'`; about 10% of (hotel, room type, week) combinations are sold out, more on holidays.

### services/places.js
`createPlacesService({ supplier, clock })` → `searchPlaces({ city, keyword, limit }) → [{ name, area, type, location, nearbyHotelCount }]`
over the city guide (whole-word matches for short keywords; "food" finds dining and nightlife areas);
`listAreas({ city, checkIn, checkOut }) → [{ name, reason, landmarks, hotelCount, priceFrom, priceBasis }]`. No weather.

### services/websearch.js
`createWebSearch({ provider: 'bocha', apiKey, fetch })` → `{ enabled, search(query, { freshness, count }) → [{ title, url, snippet, site, date }] }`.
`enabled: false` without a key (the tool is then not offered).

### services/bookings.js
`createBookingService({ store, hotels, clock, ids })`:
- `prepareBooking({ userId, sessionId, hotelId, rateId, checkIn, checkOut, rooms, adults, children, guests, firstName, lastName, email, contactPhone, arrivalTime, specialRequests })`
  validates (dates via `checkStay`, check-in no earlier than `earliestCheckIn`; rooms 1–5; children 0–6; at least one
  adult per room; guest names per `guestNameProblem`, at least one per room, no more names than people; email required;
  a US phone), re-prices via `hotels.priceCheck`, supersedes the user's other pending quotes in the same session, stores
  and returns a Quote (pending, 15-minute expiry). Throws `BookingError { code, status, message }` with English
  messages meant for the model or the user.
- US phone rules (`normalizePhone`): 10 digits, optionally with a leading 1 or +1, any of "(415) 555-0123",
  "415-555-0123", "415.555.0123", "+1 415 555 0123" (full-width characters too); area code and exchange must not start
  with 0 or 1 (NANP). Stored as E.164 `+14155550123`; `maskPhone` → `***-***-0123` (idempotent); `formatPhone` →
  `(415) 555-0123`. Message: "Please enter a 10-digit US phone number".
- `normalizeEmail`: trims, lower-cases the domain; message "That email doesn't look right".
- `confirmQuote({ userId, quoteId })` → Order (pending_payment, payBy +15 min). Idempotent. Rejects other users' quotes
  (`not_found`), expired (`expired`), superseded, a closed free-cancellation window (`terms_changed`), and re-checks
  price and availability (`price_changed`, `sold_out`).
- `payOrder({ userId, orderId, method: 'card' | 'apple_pay' })` → Order (confirmed, payment + confirmationNo). Idempotent;
  rejects closed or cancelled orders, a passed check-in date and `invalid_payment_method` ("Please choose a credit or
  debit card or Apple Pay").
- `previewCancellation({ userId, orderId })` → `{ order, penalty, refund, policyText, cancellable }`;
  `cancelOrder({ userId, orderId, reason })` → Order (cancelled). Free before `freeUntil`; after it the first night is
  charged; `none` = penalty is the total. Unpaid orders cancel with no charge. Checked-in stays can't be cancelled online.
- `listOrders(userId)` newest first; `getOrder`; `getQuote`. Quotes expire and unpaid orders close lazily on read.
- `extendOrder(…)` (called by stays.js only, from the user's Confirm extension tap) moves check-out, adds nights and
  the paid amount.
- Labels: `PAYMENT_METHOD_LABELS = { card: 'Credit or debit card', apple_pay: 'Apple Pay' }`, order and quote status labels.

### services/stays.js
`createStayService({ store, bookings, hotels, clock, ids })`: everything after a booking is paid, as docs/JOURNEY.md
describes. Ride and extension quotes and review drafts are made by the agent's tools; `confirmRide`,
`confirmExtension`, `publishReview` only by the user's taps (HTTP routes).

### services/merchant.js
`createMerchantService({ store, bookings, stays, hotels, clock, promotions })`: the console of docs/MERCHANT.md.
`createPromotionBook({ store, clock })` is shared with `createHotelService({ …, promotions })`, which discounts the
nights a deal covers.

### llm (connectors stream)
`resolveLlmConfig(env) → { provider, label, baseUrl, apiKey, model, configured, keyEnv, warnings, … }` (providers.js:
`anthropic` default, `openai`), and `createLlmClient(config)` → `chat({ messages, tools, signal, onTextDelta }) →
{ content, toolCalls: [{ id, name, arguments: string }], finishReason, usage }`; errors are `LlmError { code, status,
userMessage }` (English). The agent speaks the OpenAI-style message shape; the client translates for Anthropic.
`scripted-llm.js` (back end) implements the same `chat()` with `demoScript`, which understands the demo phrases of
US-CONTRACT §12 and the card-tap tails of §5.

### agent/tools.js
`createTools({ hotels, places, bookings, stays, webSearch, profiles, clock })` → `{ definitions(ctx), execute(name, rawArgs, ctx) → { content, card?, status? } }`.
`ctx = { userId, sessionId, timeZone, phoneVault, signal }`. Unknown tools, bad JSON and validation errors return
`{ content: { error } }` (never throw to the loop). Argument names are snake_case; descriptions are English.
- `search_hotels` { city*, near, keyword, radius_miles, check_in, check_out, adults, children, rooms, price_min, price_max, categories, sort, limit } → card `hotels`
- `get_hotel_rooms` { hotel_id*, check_in, check_out, adults, children, rooms } → card `rooms`
- `search_places` { city*, keyword*, limit } → card `places`
- `list_areas` { city*, check_in, check_out } → card `areas`
- `web_search` { query*, freshness } → card `web` (only when webSearch.enabled)
- `prepare_booking` { hotel_id*, rate_id*, check_in*, check_out*, rooms, adults, children, guest_names, email, contact_phone, arrival_time, special_requests }
  Guest names, email and phone fall back to the saved traveler details; a masked phone is resolved from the session's
  vault → card `booking_quote`. The content tells the model it is shown and awaits the user's tap: never claim it is booked.
- `list_orders` {} → card `orders`; `prepare_cancellation` { order_id* } → card `cancel_preview`
- `save_profile` { first_name, last_name, email, contact_phone, preferences, confirm_overwrite } (only on an explicit
  request; replacing a saved name, email or phone needs `confirm_overwrite: true`) → no card
- the 13 stay tools of docs/JOURNEY.md §2 (`plan_itinerary` … `draft_review`, with `request_receipt`) → the cards of §3
Content sent to the model is compact (≤ 6 hotels, prices, ids, `stay_text` with weekdays, whether free cancellation
is still possible now); cards may be richer. The model only ever sees masked phone numbers.

Card shapes (the page renders these; `type` is the discriminator):
```
{ type: 'hotels', query, landmark, hotels: [...], notes, demo, needRooms? }
{ type: 'rooms', hotel, offer: RoomOffer }
{ type: 'places', city, keyword, places: [...] }
{ type: 'areas', city, areas: [...] }
{ type: 'web', query, results: [...] }
{ type: 'booking_quote', quote: PublicQuote }       // PublicQuote = Quote with contactPhone masked, no userId
{ type: 'orders', orders: PublicOrder[] }
{ type: 'cancel_preview', orderId, penalty, refund, policyText, cancellable, order: PublicOrder }
{ type: 'order', order: PublicOrder }               // emitted by the server after confirm / pay / cancel
```

### agent/prompt.js
`buildSystemPrompt({ appName, assistantName, now, timeZone, profile, features: { webSearch, demoHotels }, cities }) → string`.
Includes: Nana's role and voice (short, warm, a little playful; at most one emoji; no tildes); today and the local time
in the user's zone and a two-week calendar; the late-night rule; upcoming holidays; how to resolve relative dates
("tonight", "this Friday", "next weekend", "Thanksgiving"); defaults (2 adults, 1 room, 1 night, said out loud); ask only
what blocks progress, one question at a time; never invent hotels or prices; all-in prices; the booking protocol
(search → rooms → prepare_booking → the user taps Confirm booking → test-mode payment; never say "booked" before an
order notice says so); cancellation; the stay; privacy (never repeat full phone numbers); quick-reply cues
(`Reply "Book #1"`, `Tap "Confirm booking"`, US-CONTRACT §4); the saved traveler details (masked); formatting (short
paragraphs, light Markdown, no tables, don't repeat what the cards show); the supported cities.

### agent/agent.js
`runAgentTurn({ llm, tools, session, userText, ctx, systemPrompt, emit, signal, maxSteps = 8 }) → { messages, display, aborted, error }` (never throws).
- Request messages = [system, …trimmed history, user]. Trimming keeps the last ~30 messages and never starts on a
  `tool` message or an assistant tool call without its results.
- Loop: `llm.chat` with `onTextDelta: (t) => emit('delta', { text: t })`; tool calls → append the assistant message, run
  the tools (read-only ones concurrently, side-effecting ones after them in order, each checking the stop signal;
  emit `status` before, `card` after), append `{ role: 'tool', tool_call_id, content }`, continue; no tool calls →
  final message.
- Max steps → `MAX_STEPS_TEXT` ("This one got a bit complicated, so I'll stop here for now. …").
- `LlmError` → `error { message: userMessage }`; content_filter → `retract {}` then a canned reply, and neither the
  flagged text nor the user turn is stored. A stopped or failed turn keeps the user message and any partial reply
  ("… (reply interrupted)").
- Phone numbers typed in the chat are masked before the model sees them; the full numbers go to `session.phoneVault`
  (server-side only; a mask typed for two numbers is stored as ambiguous).

## HTTP API (server)

Identity: no login. The browser creates a UUID once (localStorage) and sends `X-User-Id: <uuid>`; missing or invalid →
401 ("Your user id is missing or invalid; please reload the page and try again"). The page also sends
`X-Time-Zone: <IANA zone>`. JSON bodies ≤ 32 KB. Errors: `{ error: { code, message, details? } }` with English messages.

- `GET  /api/health` → `{ ok: true, appName, llm: { provider, model, configured }, hotels: 'sim', webSearch, defaultTimeZone }`
- `POST /api/sessions` → `{ sessionId }`
- `GET  /api/sessions/:id` → `{ sessionId, items: DisplayItem[] }` (owner only). Booking, order and stay cards are
  refreshed to their current status. `DisplayItem = { role: 'user' | 'assistant' | 'notice', text, cards?, kind? /* notices */, at }`.
- `POST /api/chat` `{ sessionId?, message }` → `text/event-stream`: `session { sessionId }` · `status { text }` · `delta { text }` ·
  `card { card }` · `retract {}` · `error { message }` · `done {}`. One turn per session (409 `busy`), at most 2 per user
  and 20 server-wide (503 `server_busy`); message 1–2000 characters; a client disconnect aborts the model call. With
  no model configured the reply explains how to set up `.env` (and `npm run demo`).
- `POST /api/quotes/:id/confirm` → `{ order }`; `POST /api/orders/:id/pay` `{ method: 'card' | 'apple_pay' }` → `{ order }`;
  `POST /api/orders/:id/cancel` `{ reason? }` → `{ order }`; `GET /api/orders` → `{ orders }`; `GET /api/orders/:id/cancel-preview`.
- After confirm / pay / cancel (and the stay and hotel events of JOURNEY.md and MERCHANT.md) the server appends a
  `notice` with a `kind` to the session display and a history message for the model:
  `{ role: 'user', content: '[System notice — not from the user] Order HA… was paid and is confirmed. …' }`. Notices
  since the last turn share one model message (one line each); a notice that lands during a turn is stored after it;
  the paid notice replaces a just-placed pending one in the display. User text that imitates the prefix is rewritten
  to `(System notice …)`. Free text inside a notice is quoted “…” and cannot close its quote.
- `GET /api/profile` / `PUT /api/profile` `{ firstName, lastName, email, contactPhone, preferences }` — any subset;
  omitted = unchanged, `''` or `null` clears; first and last name must both be set or both be empty. GET returns the
  masked phone and `hasPhone`. Codes `invalid_name`, `invalid_email`, `invalid_phone`, `invalid_preferences` (60
  characters at most).
- Stays (JOURNEY.md §4): `GET /api/stays`, `POST /api/rides/:id/confirm`, `POST /api/extensions/:id/confirm` `{ method }`,
  `POST /api/reviews/:id/publish`.
- Hotel console (MERCHANT.md, no `X-User-Id`): `GET /api/merchant/hotels`, `GET /api/merchant/:hotelId/{overview,rooms,tickets,reviews,promotions}`,
  `POST …/rooms/:number`, `…/tickets/:id`, `…/reviews/:id/reply`, `…/reviews/:id/draft-reply`, `…/promotions`, `…/promotions/:id`.
- Static: `GET /` and `/public/*` from `public/` (no traversal, correct types, `.wasm` as `application/wasm`, no
  listings); `GET /merchant` → public/merchant.html (`/merchant/` redirects).
- Headers on every response: CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
  connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Limits: per-user chat turns (`CHAT_TURNS_PER_WINDOW`, default 30 per 10 minutes; checked before the address bucket is
  charged), writes per client address (`WRITES_PER_IP_PER_WINDOW`, default 600; `TRUST_PROXY=1` behind a proxy), at most
  20 sessions per user (the oldest go), empty sessions idle for a day are dropped at startup; the store is flushed
  before confirm / pay / cancel respond.
- `createApp({ config, llm, hotels, places, bookings, stays, merchant?, webSearch, store, clock, logger })` →
  `{ server, handler, close({ graceMs }) }` so tests can listen on port 0; `buildDeps(config)` wires the services;
  `startServer({ config, logger, llm })` listens and returns the app plus `{ port, url, close, store }`.

## Front end

The page, the phone app and the Android shell belong to the front-end stream; US-CONTRACT.md fixes what they share
with the back end: the voice and names (§1), locale (§2), `X-Time-Zone` (§3), quick-reply cues (§4), the messages a
card tap sends (§5), notice kinds (§6), traveler details (§7), test-mode payments (§8), the receipt card and stay
details (§9), the console (§10). Card fields are in this file and docs/JOURNEY.md.

## Testing

`npm test` = `node --test test/*.test.js` (unit + integration, no network). Each stream tests its own modules.
Back-end tests run on a fixed clock (usually Wed, Nov 4, 2026, 10 AM in New York) against the simulated supplier and an
in-memory store; the server tests use a fake LLM that scripts tool calls. They include: time zones (a user in Los
Angeles at 11 PM asking for "tonight"; `X-Time-Zone` validation and fallback; the hotel's zone for deadlines and
pickups; DST), US phone / email / name validation, all-in pricing, the booking state machine, notices, the stay, the
receipt flow and the console. `src/llm/scripted-llm.js` exports `createScriptedLlm(script)` and `demoScript`;
`test/e2e/run-server.js` boots the app with it (`npm run demo`), and the Playwright smoke tests in `test/e2e/` drive the
demo phrases of US-CONTRACT §12.

## History: what the review rounds changed (still binding)

- Card-tap messages carry the stay and ids as an ASCII tail `(hotel_id: …, rate_id: …, check_in: YYYY-MM-DD, check_out: YYYY-MM-DD)`
  plus the party in words ("2 adults, 1 child, 2 rooms"); the bubble hides the tail.
- `children` (0–6) on search, rooms, price check and prepare_booking; children count toward occupancy, not price.
  Rates blocked by occupancy have `unavailableReason: 'occupancy'` (never shown as sold out).
- `keyword` ranks (`matchedKeywords`) instead of filtering; "breakfast included" matches bookable breakfast rates
  (`RATE_TOKENS` in supplier.js), not hotel tags.
- confirmQuote and payOrder re-check the free-cancellation deadline (`terms_changed`, 409); `guest_count_mismatch`;
  placeholder names are rejected.
- Side-effecting tools (prepare_booking, prepare_cancellation, save_profile, the stay's prepare tools) run after the
  step's read-only tools, in order.
- Relative check-out words ("tomorrow") count from today; year-less check-out dates take their year from the check-in.
- Preferences: at most 60 characters everywhere (form, API, tools), and all of them reach the prompt.
- Dates in notices and cards show the year only when it differs from the user's current year (check-out compared
  with check-in).
- The hotels card asks for `needRooms` rooms when one room can't hold the party ("2 rooms").
- `list_areas` takes optional dates so "prices from" follows them (`priceBasis`).
