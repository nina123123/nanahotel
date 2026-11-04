# NanaHotel: an AI hotel concierge

NanaHotel is a chat assistant that gets a hotel stay done the way a phone call to a good concierge would: find a
hotel, book it, and then handle everything before arrival, during the stay and after check-out, all in one
conversation. It is the US English edition of 小宿, the Chinese product this repository was copied from. The
assistant is **Nana**, a calm 3D plush capybara with an orange on its head.

> "This Friday in New York near Times Square, two nights, under $300"
> → Nana works out the dates (check-in Fri, Nov 6), answers in a sentence or two and sends hotel cards (photo,
> rating, distance from Times Square, all-in price per night) → tap a hotel → room cards (breakfast, free
> cancellation, total) → tap **Book** → the booking summary → **you tap "Confirm booking"** → test-mode payment
> (card or Apple Pay) → booked. You can also just reply "Book #1", "Yes" or "#2".
>
> After booking: "Plan my day" → an itinerary card; "Get me a ride to the hotel" or "Pick me up at JFK" → a ride
> quote, and only **your tap on "Confirm ride"** books it (driver, car, plate, live progress); "I'm here, check me
> in" → room number, digital key, Wi-Fi; "Two more towels please" → delivery status; "Wake me up at 7am",
> "Book breakfast for tomorrow"; "One more night" → **you tap "Confirm extension"** and pay; "I'd like to check out"
> → the bill and Nana Rewards points; "Email me a receipt"; "Write a review" → a draft that is posted only when
> **you tap "Post review"**.

The screen feels like a call with Nana: warm cream and amber (black and gold in dark mode), the conversation and its
cards in the middle, and a call bar at the bottom with a mic, a text box and call / hang up. **Speech recognition is
simulated for now**: the mic offers a few "you could say" phrases that follow the journey ("Book #1" while booking,
"Two more towels please" during the stay); tap one and it is typed out like a transcript and sent. You can always
type. During a call the browser reads Nana's replies aloud when it has an English voice.

Nana shows what it is doing next to its avatar (Thinking…, Typing…, what to tap next), offers quick replies under
each answer, goes off to the hot spring when you book, naps when left alone, and drops its orange when poked.
**My trips** lists your bookings with their room numbers, rides on the way and deliveries; open one to see every card
of that stay, including the digital key after check-in.

Anything that spends money or posts publicly happens only on your tap: Confirm booking, Confirm cancellation, Confirm
ride, Confirm extension, Post review. The AI can only prepare those cards.

## Demo mode

**Out of the box everything is simulated: hotels, rooms, prices, availability, bookings and payments.** The hotels are
fictional (314 of them in 16 US cities), placed around real neighborhoods and landmarks (Times Square, the Strip,
South Beach, Waikiki). No real booking is made and nothing is charged. The hotel data sits behind a supplier
interface (`src/services/hotels/supplier.js`), which is where the live hotel connector plugs in (see
[Going live](#going-live)).

Demo cities: New York, Los Angeles, San Francisco, Las Vegas, Miami, Orlando, Chicago, Seattle, Boston,
Washington DC, New Orleans, Honolulu, San Diego, Nashville, Austin and Denver. Each city has its own time zone,
neighborhoods (why stay there, nearby landmarks, prices from), airports and hotels in four categories (budget,
midscale, upscale, luxury). Prices rise on weekends, US holidays and big weekends (Thanksgiving, Christmas to New
Year, July 4, Memorial Day, Labor Day, spring break in Miami, Orlando and Las Vegas) and follow each city's season.
The same hotel on the same night costs the same for everyone.

Prices are **all-in**: the nightly price on every card already includes taxes and any resort or destination fee,
and the breakdown (`taxesAndFees`) is on the booking summary, so nothing is added at checkout.

`npm run demo` goes one step further and needs no API key at all: Nana's replies come from a script
(`src/llm/scripted-llm.js`) that understands the demo phrases in `docs/US-CONTRACT.md` §12, so the whole journey
can be tried and tested offline.

## Run it

Node.js 20 or later; there is nothing to install.

```bash
cd nanahotel

# 1) The no-key demo (scripted replies, simulated hotels; data is cleared on restart)
npm run demo            # open http://localhost:8787

# 2) With a real AI model
cp .env.example .env    # set ANTHROPIC_API_KEY (or OPENAI_API_KEY)
npm start               # open http://localhost:8787
```

- To open it from a phone on the same Wi-Fi, set `HOST=0.0.0.0` in `.env` and visit `http://<your computer's IP>:8787`.
- Behind a reverse proxy such as nginx, set `TRUST_PROXY=1` so rate limits use each visitor's address, not the proxy's.
- Rate limits: `CHAT_TURNS_PER_WINDOW` (messages per user per 10 minutes, default 30) and `WRITES_PER_IP_PER_WINDOW`
  (writes per address per 10 minutes, default 600, 0 = off). Raise the second when many people share one public
  address (an office or event Wi-Fi).
- Time zones: the page sends the browser's zone in `X-Time-Zone`, so "today" and "tonight" are the traveler's own.
  `DEFAULT_TIME_ZONE` (default `America/New_York`) is used when a request has none or an invalid one. Times at the
  hotel (pickups, wake-up calls, breakfast, check-in) are always in the hotel's zone.

### AI models

| `LLM_PROVIDER` | Provider | Default model | Key |
|---|---|---|---|
| `anthropic` (default) | Anthropic Claude | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | `gpt-5-mini` | `OPENAI_API_KEY` |

`ANTHROPIC_MODEL` / `OPENAI_MODEL` pick another model, `LLM_EFFORT` sets how much the model thinks before answering,
and `LLM_BASE_URL` routes through a gateway. With no key, Nana explains in the chat how to set one up. All options are
in `.env.example` and `docs/LIVE.md`.

## What Nana can do

- **Find hotels**: city, landmark or neighborhood ("near Times Square", "on the Strip", "near Disney World"), dates,
  guests (adults, children, rooms), budget, category and wishes (family friendly, pool, free parking, pets,
  breakfast…).
- **Compare rooms**: bed, size in sq ft, view, floor, and a few rate plans per room (room only or with breakfast;
  free cancellation, free cancellation until a nearer deadline, or non-refundable), all-in price per night.
- **Book**: the AI only prepares a booking summary (valid for 15 minutes). The booking is placed when you tap
  **Confirm booking**, then you pay in the test-mode checkout (credit or debit card, or Apple Pay; "Test mode — you
  won't be charged"). Price, availability and the cancellation policy are checked again on confirm and on pay; if
  anything changed (say the free-cancellation deadline passed) Nana quotes again.
- **Late at night**: between midnight and 6 AM, "tonight" means the night in progress, so you can still check in
  for the night that started yesterday.
- **Trips and cancellations**: "My trips", "Cancel that booking". Nana shows what the policy charges and refunds
  first; you tap **Confirm cancellation**.
- **Where to stay**: neighborhoods with a reason to stay, nearby landmarks and prices from; landmarks, airports and
  stations by name.
- **Remembers you**: first and last name, email, phone and stay preferences in **⋯ → Traveler details**, or by saying
  "remember that". Saved details are used for the next booking; Nana asks before changing them.
- **Protects your phone number**: the AI model only ever sees it masked (`***-***-0123`), whether it was saved or
  typed into the chat. The full number stays on the server and is filled in when the booking is placed.
- **Searches the web** (optional): with `BOCHA_API_KEY` set, Nana can look up opening hours, events and tips.

After booking (all simulated; room numbers, drivers, plates and Wi-Fi passwords are fixed per booking; details in
`docs/JOURNEY.md`):

- **Before arrival**: an itinerary for the trip's city and dates; rides and airport pickups (a quote is valid for 15
  minutes; once confirmed a driver is assigned and the ride moves along); early check-in requests.
- **Check-in**: room number, floor, digital key, Wi-Fi, breakfast hours and place, check-out time.
- **During the stay**: towels, a toothbrush kit, extra pillows, housekeeping (accepted, on the way, delivered);
  breakfast or a restaurant table; wake-up calls; facilities and the front desk; one more night (confirmed and paid,
  then the booking's check-out date and total change).
- **Check-out**: the bill (prepaid, extras, due) and Nana Rewards points; an emailed receipt; membership tier
  (Member, Gold, Platinum); a review drafted from what you said, posted only on your tap.

## The hotel console (demo)

**NanaHotel for Hotels** is a black-and-gold console for the front desk and the manager, on the same server and data
as the traveler side, so the two are connected (details in `docs/MERCHANT.md`):

- **Overview**: tonight's occupancy, today's revenue, ADR and RevPAR, arrivals / departures / in house; revenue and
  occupancy for the last 7 or 30 days and a 14-day occupancy forecast (with a 90% line); bookings by channel
  (NanaHotel, Expedia, Booking.com, Google, Direct); Nana's suggestions. Every chart can be explored by hover or
  keyboard and has a data table.
- **Rooms and check-in**: a room map by floor (vacant clean, vacant dirty, occupied, arriving, departing, out of
  order; a gold border marks NanaHotel guests). When a NanaHotel guest arrives today, the desk checks them in and the
  guest gets the room number in the chat.
- **Guest requests**: towels, early check-in, wake-up calls and dining requests made in the chat show up here; when
  the desk accepts and delivers, the guest's card follows; early check-in can be approved or declined.
- **Reviews and promotions**: rating breakdown and keywords; NanaHotel guests' reviews are tagged, and replies show
  up on the guest's review card. A deal (say 15% off for the next 7 days) prices the hotel on the guest side at once.

Open `http://localhost:8787/merchant` (or **⋯ → Switch to hotel console (demo)** in the app). Other guests,
channels and past reviews are simulated per hotel; what really happens in NanaHotel is layered on top. The console
only ever shows masked names ("Sarah M.") and phone numbers.

## Why the AI can't book on its own

Assistants that send emails or place orders without asking have been rightly criticized, and a booking is a
contract that spends the traveler's money. So:

1. `prepare_booking` only creates a booking summary, valid for 15 minutes, with the room, dates, guests, the
   all-in total and the cancellation policy.
2. Only a tap calls `POST /api/quotes/:id/confirm` and `/api/orders/:id/pay`. The server checks the price and
   availability again, and that the order belongs to the current user.
3. After a payment or cancellation the server adds a `[System notice — not from the user]` to the AI's history, so
   the AI learns the booking's status. If a user types that prefix it is rewritten, so notices cannot be forged.

Showing the all-in price from the first card follows the FTC's rule on unfair or deceptive fees, which requires
lodging prices to include mandatory fees.

## Project structure

```
nanahotel/
  src/
    server.js              HTTP server: chat over SSE, sessions, quotes / orders / payment / cancellation, My trips,
                           Confirm ride / extension, Post review, traveler details, static pages; the hotel console
                           API /api/merchant/* (no X-User-Id) and the /merchant page; hotel actions notify the guest
    config.js              reads .env and the environment (the only module that does)
    util/                  dates and time zones, US phone and name checks, money, ids
    llm/                   model clients (Anthropic, OpenAI), provider settings, the scripted demo model
    live/                  live connectors: LiteAPI hotels and payments, Google Places, Resend email, ride links
    agent/
      agent.js             one turn's tool-calling loop
      tools.js             the AI's tools: search_hotels / get_hotel_rooms / list_areas / search_places / web_search /
                           prepare_booking / list_orders / prepare_cancellation / save_profile, and 13 for the stay
                           (itinerary, rides, early check-in, check-in, requests, dining, wake-up, stay info, extension,
                           check-out, receipt, rewards, review)
      prompt.js            the system prompt (today in the traveler's zone, the next two weeks, holidays, preferences)
      text.js              the notice prefix, forged-notice neutralizing, small text helpers
    services/
      hotels/              hotel service + supplier interface + the simulated supplier (cities, neighborhoods,
                           landmarks, hotel generation, pricing, US holidays)
      bookings.js          quote → order → payment → cancellation, the order state machine
      stays.js             after booking: rides, check-in, requests, dining, wake-up, extension, bill, receipt,
                           rewards, reviews (statuses move on with time)
      merchant.js          the hotel console: overview, rooms and desk check-in, requests, review replies, deals
      places.js            city guide (neighborhoods, landmarks)
      websearch.js         web search (optional)
    store/json-store.js    JSON file storage (the data/ folder)
    http/                  SSE writer, static files
  public/                  the mobile-first web page (light and dark): chat, cards, call bar, My trips, the console
  app/                     the phone app shell: runs src/ inside the page (browser stand-ins for Node modules),
                           data in IndexedDB; used by the Android app and the home-screen web app
  android/                 the Android app (a WebView on app/), built by GitHub Actions
  tools/                   asset builders (the Nana Rive animation)
  test/                    unit and integration tests; e2e/ has the Playwright smoke tests and the demo server
  docs/SPEC.md             design spec: modules, data shapes, the API
  docs/JOURNEY.md          the stay after booking: services, tools, card fields, API
  docs/MERCHANT.md         the hotel console: service, API, data, and how it connects to the traveler side
  docs/US-CONTRACT.md      what the US edition agreed on (voice, locale, time zones, demo phrases)
  docs/LIVE.md             going live: keys, real hotels, payments, places, email
  docs/ART-PROMPTS.md      image prompts for the 3D plush Nana and the hotel photos
```

The chat is `POST /api/chat`, streamed as SSE: `status` (Searching hotels near Times Square…), `delta` (text),
`card` (hotels, rooms, booking summary, ride, check-in…, drawn as cards by the page), `done`. My trips reads
`GET /api/stays` and refreshes every 15 seconds while a ride or a delivery is on its way. The full API is in
`docs/SPEC.md` and `docs/JOURNEY.md`.

Phone app: `app/` runs the whole server inside the page, so the Android app and the home-screen web app work
offline with the demo; an Android build given a hosted server address shows that server instead.

## Tests

```bash
npm test                                                         # all unit and integration tests, offline
npm run test:app                                                 # the phone app build: demo flow, local storage
npm run demo & BASE_URL=http://localhost:8787 npm run test:e2e   # browser end-to-end: call, cards, booking, the stay
BASE_URL=http://localhost:8787 npm run test:merchant             # traveler and console together: desk check-in, requests, replies, deals
LITEAPI_API_KEY=sand_… node test/e2e/live-e2e.mjs                 # the real LiteAPI sandbox in a browser: card form, booking, cancel
```

`test/live-flow.test.js` runs the live path (search, price lock, card form session, booking, cancellation, the
console sign-in) against a fake LiteAPI, offline. GitHub Actions runs the unit tests and the three browser
walk-throughs on every push (`.github/workflows/ci.yml`).

The unit tests run on a fixed clock (Wed, Nov 4, 2026) against the simulated supplier, so they are deterministic.
They cover the time-zone rules (a traveler in Los Angeles at 11 PM asking for "tonight"; `X-Time-Zone` checks),
US phone, email and name validation, all-in pricing, the booking and stay journeys, and the receipt flow.

## Going live

Every real service switches on by its key, and everything starts in test mode. Full steps:
**[`docs/LIVE.md`](docs/LIVE.md)**.

| Key | What it switches on |
| --- | --- |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | Nana's AI (Claude by default) |
| `LITEAPI_API_KEY` | Real US hotels, live prices, price lock, LiteAPI's card form, booking and cancellation (a `sand_` key is the sandbox: test bookings, card 4242 4242 4242 4242) |
| `GOOGLE_PLACES_API_KEY` / `GOOGLE_MAPS_API_KEY` | "Near Times Square" and other places, through Google Places API (New) |
| `RESEND_API_KEY` (+ `EMAIL_FROM`) | Booking confirmation emails |
| none | Uber / Lyft buttons with the trip filled in |

With live hotels the simulated stay (room keys, towels, the front desk) is off, since a real hotel never hears of it.
Nana sends guests to the front desk for those and offers ride buttons instead. The demo keeps the full journey.

**Hosting**: `render.yaml` sets up the server on Render in the US with a disk for the data; see
[docs/LIVE.md §3c](docs/LIVE.md#3c-hosting-it-render-us). On a public address the hotel console needs
`MERCHANT_PASSWORD`, and `AI_TURNS_PER_DAY` caps the AI bill.

**Phones**: iPhone users add the hosted site to the Home Screen. The Android app (built by `.github/workflows/android.yml`
and published under Releases) shows the hosted server when the repository variable `NANAHOTEL_SERVER_URL` is set,
and is the offline demo otherwise. No API key is ever built into the app.

**Checks against the real services**: the *Live smoke test* workflow (every connector, weekly) and *Live end-to-end
(sandbox)* (search → card form → booking → cancellation in a browser) use the repository's secrets.

Before real travelers use it you will also want a privacy policy and terms, consent for guest names, emails, phone
numbers and trip details, a real sign-in (the app tells users apart by a random id the browser makes), a database
instead of the JSON files in `data/`, and, to sell travel to residents of California, Florida, Washington and
Hawaii, their seller-of-travel registration.

## Known limits

- In demo mode every hotel, price and booking is simulated; future holidays follow the usual rules.
- No weather (Nana won't make it up), and distances are straight-line.
- Conversations and bookings are JSON files on the server: fine for a demo or a small pilot, not for production.
