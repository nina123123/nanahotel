# NanaHotel (US) — the contract between front end, back end and the live connectors

NanaHotel is the US English edition of 小宿 (the Chinese hotel concierge this repository was copied from). The
assistant is **Nana**, the same capybara with an orange on its head; the app is **NanaHotel**. Everything a user sees is
American English, prices are USD, dates and times follow en-US, and the demo data is American (cities, hotels,
holidays). Field names of cards and APIs stay as they are unless this document says otherwise.

Three streams work in parallel and must agree on what is below:
- **Front end** (`public/`, `app/`, `android/`, `test/e2e/`, `tools/`)
- **Back end** (`src/` except the LLM layer and `src/live/`; `test/*.test.js` except LLM/live tests; docs)
- **Live connectors** (`src/live/`, `src/llm/providers.js`, `src/llm/client.js`, new LLM provider code, their tests, `docs/LIVE.md`)

## 1. Voice and names

- App name `NanaHotel`; assistant `Nana` (header title shows `Nana`). Warm, light, a little playful; short sentences;
  at most one emoji per reply; no tildes. Examples: "On it!", "Here are a few near Times Square.", "Booked! Enjoy the
  stay."
- Pet status lines: idle "Feeling calm", "Thinking…", the running tool ("Searching hotels near Times Square…"),
  "Typing…", next step ("Check it over, then tap Confirm booking"), "Booked! Off to the hot spring ♨", "Taking a nap
  zZ", wake "I'm up!". Poke lines are playful ("Careful, my orange!", "Still here!", "Hehe, that tickles").
- Menu: `My trips`, `New chat`, `Traveler details`, `Switch to hotel console (demo)`.
- Hotel console: `NanaHotel for Hotels`.

## 2. Locale

- Dates: "Fri, Nov 6" (with year only when it differs from this year). Ranges "Fri, Nov 6 – Sun, Nov 8".
- Times: 12-hour, "2:30 PM". Hotel check-in 3:00 PM, check-out 11:00 AM by default.
- Money: USD numbers in data; shown as `$1,108` (whole dollars from $100 up, cents below).
- Distances in miles/feet: "0.3 mi", "800 ft".
- Phone numbers: US, stored E.164 `+14155550123`; accepted as "(415) 555-0123", "415-555-0123", "+1 415 555 0123";
  shown masked as `***-***-0123`. Fictional numbers use 555-01xx.
- Guest names: first name + last name. Masked names in the hotel console: "Sarah M." (first name + last initial).

## 3. Time zone

- The page sends `X-Time-Zone: <IANA zone>` (from `Intl.DateTimeFormat().resolvedOptions().timeZone`) on every API
  request. The server validates it (falls back to `America/New_York`) and uses it for "today", "tonight", "this
  Friday" in the prompt and when resolving dates. "Tonight" after midnight and before 6:00 AM means the night in
  progress (same rule as before).
- Each demo city has its own IANA zone; times at a hotel (wake-up, dining, pickup) are in the hotel's zone. Cards carry
  ISO instants (`…At`) and the page formats them; where the server formats a time into text it uses the hotel's zone.

## 4. Quick replies (the page turns these into buttons)

- Replies offer answers as phrases in straight double quotes after **Reply / Say / Type / Send** (any case):
  `Reply "Book #1" to book it.`, `Say "Yes" or "Show cheaper ones".`
- **Tap "…"** names a button on a card and is never a quick reply.
- A single pick phrase with `#1` over a list (or a card) of n items expands to one button per item, up to 4:
  "Book #1" → "Book #1", "Book #2", "Book #3". A template uses `#N`: `Reply "Cancel #N"` → "Cancel #1", "Cancel #2".

## 5. Messages a card tap sends (the bubble hides the ids tail)

- Hotel row: `Show me rooms at "{hotel}" — {Fri, Nov 6} to {Sun, Nov 8}, {2 adults[, 1 child]}[, {2 rooms}] (hotel_id: {id}, check_in: {YYYY-MM-DD}, check_out: {YYYY-MM-DD})`
- Rate row: `Book "{hotel}" · {room} · {plan} — {Fri, Nov 6} to {Sun, Nov 8}, {2 adults} (hotel_id: {id}, rate_id: {rateId}, check_in: {…}, check_out: {…})`
- Requote: `That quote expired, please quote it again: "{hotel}" · {room} · {plan} — {dates}, {party} (hotel_id: …, rate_id: …, check_in: …, check_out: …)`
- The ids tail is ASCII: ` (hotel_id: X, rate_id: Y, check_in: YYYY-MM-DD, check_out: YYYY-MM-DD)`. The demo script
  keys off `hotel_id:`, `rate_id:`, `check_in:`, `check_out:` and the party phrases `N adult(s)`, `N child(ren)`,
  `N room(s)`.

## 6. Notices

Every notice item in a session carries `kind` (the page never parses notice text):
`pending`, `paid`, `cancelled`, `ride_confirmed`, `extended`, `review_published`, `front_desk_checkin`,
`early_checkin_approved`, `early_checkin_declined`, `review_replied`. `text` is one short English line for display.
The model-facing copy starts with `[System notice — not from the user]`.

## 7. Traveler details (profile) and guests

- Profile fields: `{ firstName, lastName, email, contactPhone, preferences }`. GET returns `hasPhone` and the masked
  phone; PUT accepts any subset (omitted = unchanged; `contactPhone: null` deletes).
- Validation messages are English ("Please enter a first and last name", "That email doesn't look right",
  "Please enter a 10-digit US phone number").
- A booking's holder is `{ firstName, lastName, email }`; `guests` stays an array of full names.

## 8. Payments in demo mode

The simulated checkout offers `card` ("Credit or debit card") and `apple_pay` ("Apple Pay"):
`POST /api/orders/:id/pay { method: 'card' | 'apple_pay' }`. It says "Test mode — you won't be charged".

With live hotels (LiteAPI), Confirm booking locks the price (`POST /api/quotes/:id/confirm` → an order
`pending_payment` with `live: { provider, sandbox, environment, bookingId }`), the sheet gets the card form's session
from `GET /api/orders/:id/payment` (owner only: `{ environment, secretKey, scriptUrl, amount, currency, payBy,
sandbox, testCard }`), LiteAPI's form returns to `/?paid=<order>`, and `POST /api/orders/:id/pay { method: 'liteapi' }`
books. A quote card whose order still waits for payment carries `orderStatus: 'pending_payment'` and offers
"Finish payment". docs/LIVE.md has the details.

## 9. The stay in the US

Same tools and cards as docs/JOURNEY.md, with these changes:
- **Receipt instead of 发票**: tool `request_receipt { email?, order_id? }` → card `{ type: 'receipt', receipt: { id,
  orderId, kind: 'receipt', email, amount, status: 'sending' | 'sent', sentAt? } }`. (`request_invoice` and the
  `invoice` card are removed.)
- Rides: `kindLabel` "Airport pickup" / "To the hotel" / "From the hotel" / "Ride"; drivers like "Mike R.", cars
  "Toyota Camry" / "Tesla Model 3" / "Honda Odyssey" (vans for 5+), plates like "8ABC123".
- Rewards: "Nana Rewards" — Member < 2,000 points ≤ Gold < 8,000 ≤ Platinum; $1 paid = 1 point.
- Dining: breakfast 7:00–10:30 AM, $18 per person unless the rate includes it; restaurant names in English.
- Service items in English ("Towels", "Toothbrush kit", "Extra pillows", "Housekeeping").
- Stay info: Wi-Fi `"{Short}-Guest"` + 8-character password; front desk a fictional 555-01xx number in the city's area
  code; check-out 11:00 AM; facilities by category (pool, fitness center, business center, guest laundry…).
- Early check-in: usual check-in is 3:00 PM; arriving at 12:00 PM or later → confirmed, earlier → pending.
- Floors skip 13 (not the Chinese unlucky floors).

## 10. The hotel console (US)

- Masked guests "Sarah M."; `source: 'nanahotel'` for our guests (was `xiaosu`), `'sim'` for simulated ones.
- Channels (keys → labels): `nanahotel` NanaHotel, `expedia` Expedia, `booking` Booking.com, `google` Google, `direct`
  Direct. Colours map by slot as before (nanahotel takes the gold slot).
- Simulated reviews, tickets and names are American English.

## 11. Demo cities (simulated hotels, demo mode only)

New York (Times Square, Central Park, SoHo, JFK), Los Angeles (Hollywood, Santa Monica, Downtown, LAX), San Francisco
(Union Square, Fisherman's Wharf, SFO), Las Vegas (the Strip, Downtown), Miami (South Beach, Brickell, MIA), Orlando
(Walt Disney World, Universal, MCO), Chicago (Magnificent Mile, the Loop, O'Hare), Seattle (Pike Place, SEA), Boston
(Back Bay, Seaport, Logan), Washington DC (National Mall, Georgetown, DCA), New Orleans (French Quarter), Honolulu
(Waikiki), San Diego (Gaslamp, La Jolla), Nashville (Broadway), Austin (Downtown, South Congress), Denver (LoDo,
DEN). Categories `budget`, `midscale`, `upscale`, `luxury`. US holidays and big weekends raise prices
(Thanksgiving, Christmas–New Year, July 4, Memorial Day, Labor Day, spring break in Miami/Orlando/Las Vegas).

## 12. Demo phrases (the scripted model must handle them; the e2e tests use them)

- Booking: "This Friday in New York near Times Square, two nights, under $300" · "Tonight in Las Vegas on the Strip,
  cheap" · "Next weekend in Miami Beach, 2 adults and 1 kid" · then "Book #1" · "Yes" · "#2" · "Cancel that booking".
- The stay: "Plan my day" · "Get me a ride to the hotel" · "Pick me up at JFK" · "Can I check in early? I land at
  noon" · "I'm here, check me in" · "Two more towels please" · "Wake me up at 7am" · "Book breakfast for tomorrow" ·
  "What's the Wi-Fi password?" · "What time is checkout?" (a question: never checks out) · "One more night" ·
  "I'd like to check out" · "Email me a receipt" · "My points" · "Write a review".
- Home-screen examples: "This Friday in New York near Times Square, two nights, under $300", "Tonight in Las Vegas on
  the Strip, cheap", "Next weekend in Miami Beach, 2 adults and 1 kid".
