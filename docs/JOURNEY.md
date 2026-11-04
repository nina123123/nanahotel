# The trip after booking: services, tools, cards, API

Everything after a booking, all simulated: before arrival (itinerary, rides and airport pickups, early check-in),
check-in (room number, digital key, Wi-Fi), during the stay (deliveries, dining, wake-up calls, extensions, the area),
and check-out (the bill, an emailed receipt, Nana Rewards points, a review). This document is the agreement between
the back end (`src/`) and the front end (`public/`): card field names, API paths and responses follow it.
`docs/US-CONTRACT.md` §9 lists what the US edition changed.

Principles (the same as for booking):
- Spending money is the user's own tap: a ride is booked on **Confirm ride**, an extension on **Confirm extension**
  plus the test-mode payment. The AI only sends the confirmation card.
- Publishing is the user's own tap too: Nana drafts the review, and it is posted on **Post review**.
- Everything else (check-in, deliveries, wake-up calls, dining, receipts, check-out) is an ordinary service request:
  the AI calls the tool and the result shows as a card.
- All simulated: room numbers, drivers, plates and Wi-Fi passwords derive from the order id (the same order always
  gets the same ones), hotel facts from the hotel id. No real service is involved.

## 1. Service: src/services/stays.js

`createStayService({ store, bookings, hotels, clock, ids })`, in the style of bookings.js: synchronous methods, the
injected clock, statuses worked out lazily when a record is read (no timers), `StayError(code, message)` (code → HTTP
status, `message` is user-facing English).

**Times**: every request carries the hotel's `timeZone`; times at the hotel (pickups, meals, wake-up calls,
check-out, the key's expiry) are in that zone, and "today" for a request is the hotel's date. Instants are ISO.

**The current order**: `order_id` may be left out; the user's current confirmed order is used, in this order:
checked in and not out → dates covering today → upcoming (soonest first) → checked out today or yesterday → ended
yesterday; anything that ended earlier is not current. So after checking out of a Boston hotel in the morning and
flying to Chicago, check-in, rides, dining and the day plan are about the Chicago booking. Receipts and reviews are
the exception: a stay checked out today or yesterday comes right after a checked-in one, so "Email me a receipt" or
"Write a review" after leaving is about the stay just finished. No confirmed order → "There's no confirmed booking
yet; once one is booked and paid, I can arrange the rest".

**No online cancellation after check-in**: check-in (by the guest or the front desk) is recorded on the order
(`checkedInAt`); the cancellation preview then says it can't be cancelled online and the cancel route answers 409
`not_cancellable`. Points count only for stays whose order still stands (confirmed).

**Hotel facts** (deterministic per hotel id):
- Wi-Fi: `ssid` `"{Short}-Guest"` (the hotel's brand stem, e.g. `Harborline-Guest`), `password` 8 characters.
- Breakfast: 7:00–10:30 AM, a venue such as "Harvest Table, Lobby level", **$18 per person**, free when the rate
  includes breakfast.
- Check-in 3:00 PM, check-out 11:00 AM.
- Front desk: the hotel's phone, else a fictional `(212) 555-01xx` in the city's area code.
- Facilities by category, each `{ name, hours, place }`: pools (indoor, outdoor, rooftop), fitness center, spa,
  club lounge, business center, guest laundry; a vending area at minimum.
- Floors skip 13.

**Statuses over time** (computed from the clock on read):
- Delivery `service`: `accepted` (placed) → `on_the_way` (+1 minute) → `done` (+5 minutes); `eta` is when it is done.
  The hotel's Accept / Delivered in the console move it on at once (only sooner, never back; once delivered `eta` is
  the delivery time; docs/MERCHANT.md).
- Ride: `quoted` (valid for 15 minutes, then `expired`) → `confirmed` on the user's tap (a driver is assigned at once)
  → `arriving` (at max(confirmed + 90 s, pickup − 5 minutes)) → `completed` (pickup + the estimated minutes).
  Airport trips take 30–60 minutes, other rides 10–35.
- Receipt: `sending` → `sent` (+1 minute; `sentAt`).
- Wake-up call: `set` → `done` once its time passes; one still ahead at check-out becomes `cancelled`.
- Dining: `reserved` → `done` once its time passes; one still ahead at check-out becomes `cancelled` (nothing is
  charged). A breakfast-included rate covers 1 or 2 guests per room; others pay the listed price, charged to the room.
- Extension: `pending` (valid for 15 minutes) → `confirmed` after the tap and payment, or `expired`.
- Review: `draft` → `published` on the tap.
- Early check-in: decided when asked: arriving at **12:00 PM** or later → `confirmed`, earlier → `pending` ("I'll let
  you know when the room is ready"). The hotel approves (`confirmed`) or declines (`declined`) a pending one in the
  console and the guest gets a notice; a pending one becomes `confirmed` at check-in and `cancelled` at check-out.

## 2. AI tools (src/agent/tools.js)

All need the user's identity; `order_id` is always optional (the current order). Each returns `{ content, card }`:
`content` for the model (with a short instruction), `card` for the page.

| Tool | Arguments | Card type |
| --- | --- | --- |
| `plan_itinerary` | title, date, items[{ time 'HH:MM', title, place?, note? }] (2–8), order_id? | `itinerary` |
| `quote_ride` | kind (airport_pickup / to_hotel / from_hotel / taxi), from, to?, pickup_time ('HH:MM' or 'YYYY-MM-DD HH:MM', default in 15 minutes), passengers? (1–6), order_id? | `ride_quote` |
| `request_early_checkin` | arrival_time 'HH:MM', order_id? | `early_checkin` |
| `check_in` | order_id? | `checkin` |
| `request_service` | items[{ name, qty 1–10 }] (or a sentence), note?, order_id? | `service` |
| `reserve_dining` | kind (breakfast / lunch / dinner), date?, time 'HH:MM', people (1–10)?, note?, order_id? | `dining` |
| `set_wakeup_call` | time 'HH:MM', date?, order_id? | `wakeup` |
| `get_stay_info` | order_id? | `stay_info` |
| `prepare_extension` | nights (1–7), order_id? | `extension_quote` |
| `check_out` | order_id? | `bill` |
| `request_receipt` | email? (default: the booking's email), order_id? | `receipt` |
| `get_membership` | — | `membership` |
| `draft_review` | rating (1–5), text (≤ 500 characters, in the user's words, no invented experiences), tags?, order_id? | `review_draft` |

Times the user says ("7am", "noon", "2:30 PM") are turned into 'HH:MM' in the hotel's zone. Items are named in
English ("Towels", "Bath towels", "Toothbrush kit", "Extra pillows", "Housekeeping"); "clean the room" is
Housekeeping.

Preconditions: deliveries and wake-up calls need check-in first ("You haven't checked in yet; I can check you in
first"); check-out needs a stay that is checked in and not out; extensions, receipts and reviews need a confirmed
order. In the demo check-in works on any date (before the check-in date the card has `early: true`).

## 3. Cards (card fields)

Times are ISO strings (`…At`), dates 'YYYY-MM-DD', money USD numbers. Every request object (ride, early_checkin,
service, dining, wakeup, receipt, extension, review) carries the same `kind` field in its card and in
`GET /api/stays`: the request's category (`kind: 'ride'`). A ride's own type is `rideKind`, a meal's `mealKind`.
Requests also carry `createdAt` and the hotel's `timeZone`; `room` (extension) and `roomType` (check-in) are room
names, `floor` is a number.

```js
{ type: 'itinerary', itinerary: { title, date, city?, items: [{ time, title, place?, note? }] } }

{ type: 'ride_quote', ride }   // ride.status: quoted | confirmed | arriving | completed | expired
{ type: 'ride', ride }         // the status card after confirming (also in GET /api/stays)
// ride = { id, orderId, kind: 'ride', rideKind, kindLabel, from, to, pickupAt, passengers, carType, fare, minutes,
//          status, expiresAt, createdAt, timeZone, confirmedAt?, driver?: { name, car, color, plate, phone /* masked */ } }
// rideKind: airport_pickup | to_hotel | from_hotel | taxi (kindLabel: Airport pickup / To the hotel / From the hotel / Ride)
// driver: "Mike R.", "Toyota Camry" / "Tesla Model 3" / "Honda Odyssey" (vans for 5+), plates like "8ABC123"
// The fare is paid (test mode) with the booking's payment method on Confirm ride and listed as paid on the bill.

{ type: 'early_checkin', request: { id, orderId, kind: 'early_checkin', hotel: { id, name }, date /* check-in date */,
                                    arrivalTime, status /* pending | confirmed | declined | cancelled */, note, timeZone } }
// Still pending at check-in → confirmed; the hotel declining → declined ("The hotel is full that day, so check-in is at 3:00 PM").

{ type: 'checkin', stay }
// stay = { orderId, hotel: { id, name, category }, roomType, roomNumber, floor, checkIn, checkOut, nights,
//          guests, checkedInAt, early, keyValidUntil, wifi: { ssid, password },
//          breakfast: { time, place, price /* per person */, included }, checkoutTime /* '11:00' */, timeZone,
//          checkedOutAt?, bill? /* after check-out */ }
// After check-out keyValidUntil = checkedOutAt.

{ type: 'service', ticket: { id, orderId, kind: 'service', roomNumber, items: [{ name, qty }], note?, status, createdAt, eta,
                             timeZone, timeline: [{ status, at }] /* reached steps only */ } }

{ type: 'dining', reservation: { id, orderId, kind: 'dining', mealKind, kindLabel, restaurant, place, at, people, table,
                                  price /* per person, 0 when everyone is covered */, included /* everyone covered */,
                                  covered? /* when only some are: how many the rate covers; the rest pay price */, note?,
                                  status /* reserved | done | cancelled */, timeZone } }

{ type: 'wakeup', call: { id, orderId, kind: 'wakeup', roomNumber, at, status /* set | done | cancelled */, timeZone } }

{ type: 'stay_info', info: { orderId, hotel: { id, name, category }, checkedIn, roomNumber?, wifi, breakfast,
                             checkinTime /* '15:00' */, checkoutTime, frontDesk, facilities: [{ name, hours, place }], timeZone,
                             open: [ /* requests in progress: { kind, id, label, status } */ ] } }

{ type: 'extension_quote', extension: { id, orderId, kind: 'extension', hotel: { id, name }, room, fromDate, toDate, nights,
                                         price /* all-in */, taxesAndFees?, status, expiresAt, confirmedAt?, payment?, timeZone } }

{ type: 'bill', bill: { orderId, hotel: { id, name }, roomNumber, checkIn, checkOut, nights,
                        lines: [{ label, amount, note? }], prepaid, extras, due, currency: 'USD', settledBy, pointsEarned,
                        checkedOutAt } }
// The room, extensions and rides are prepaid; meals eaten that the rate doesn't cover are charged to the room
// (extras = due) and settled at check-out with the booking's payment method: settledBy is its label
// ("Credit or debit card", "Apple Pay"), or "Nothing due". Line labels: "Room (Deluxe King · 2 nights)",
// "Extension (1 night)", "Ride (Airport pickup)" / "Ride", "Breakfast (2 guests, 1 included in the rate)".

{ type: 'receipt', receipt: { id, orderId, kind: 'receipt', email, amount, status /* sending | sent */, sentAt?, createdAt, timeZone } }
// amount: what the stay cost (the bill's prepaid + due after check-out, else the order total). One receipt per
// order; asking again re-sends it (to a new address if one is given). Replaces the Chinese edition's invoice (request_invoice / `invoice`).

{ type: 'membership', member: { program: 'Nana Rewards', level, points, nextLevel?, pointsToNext?, perks: [string],
                                recent: [{ label, points, at }] } }
// Levels: Member < 2,000 points ≤ Gold < 8,000 ≤ Platinum; $1 paid = 1 point, earned at check-out.

{ type: 'review_draft', review: { id, orderId, kind: 'review', hotel: { id, name }, rating, text, tags, status, publishedAt?,
                                   reply?: { text, at } /* the hotel's reply */, timeZone } }
```

The booking cards are unchanged: `hotels`, `rooms`, `places`, `areas`, `web`, `booking_quote`, `orders`,
`cancel_preview`. The user sees every card, so the tools' instructions tell the model: one or two sentences,
recommend one by its number and say why, don't list the card again. Cards appear in tool-result order, so "#2" is the
second hotel on the card; on a rooms card "#N" is the N-th room type that still has a bookable rate.

## 4. API (src/server.js)

All need `X-User-Id`; errors are `{ error: { code, message } }` as elsewhere.

- `GET /api/stays` → `{ stays: [{ order, stay, requests }] }`: the user's confirmed orders whose stay ended at most 3
  days ago (at most 5, the current one first). `stay` is null before check-in; `requests` are all of that order's
  requests (ride, early_checkin, service, dining, wakeup, receipt, extension, review), each with `kind`, statuses as of
  now. The page shows them under **My trips** and polls every 15 seconds while something is moving.
- `POST /api/rides/:id/confirm` → `{ ride }` (status confirmed, with a driver). An expired quote → 410 `expired`.
- `POST /api/extensions/:id/confirm` `{ method: 'card' | 'apple_pay' }` → `{ extension, order }`: confirms and pays (test
  mode); the order's check-out date, nights and total change with it. Expired → 410 `expired`, sold out → 409
  `sold_out`.
- `POST /api/reviews/:id/publish` → `{ review }` (status published).

Each of these taps adds a notice to the session the card came from, like the order notices: for the user
`{ role: 'notice', kind: 'ride_confirmed' | 'extended' | 'review_published', text, at, cards: [card] }`, and for the
model a message starting `[System notice — not from the user]` (e.g. "The user confirmed the ride: Airport pickup,
“JFK Airport” → “The Ravelle New York”, pickup Fri, Nov 6, 12:00 PM EST, … Driver Mike R. in a White Toyota Camry,
plate 8ABC123, phone ***-***-0142."). Free text from the user or the model (pickup, destination, review text) is
quoted “…” with brackets and quotes stripped, so it can't close its quote and pass for the platform. The hotel's
actions in the console (front-desk check-in, early check-in answers, review replies) notify the guest the same way
(docs/MERCHANT.md §6).

`text` is one short line: "Ride booked: Mike R. · 8ABC123, pickup Fri, Nov 6, 12:00 PM" (just the time when the pickup
is today), "Extended 1 night: check-out is now Mon, Nov 9", "Review posted: 5 stars"; `cards` are `ride`,
`extension_quote` and `review_draft`. On replay these cards are refreshed to their current status, as are every stay
card in the session (STAY_CARD_FIELDS in server.js, including `receipt`).

## 5. The demo script (src/llm/scripted-llm.js)

With no API key (`npm run demo`, the offline phone app, the end-to-end tests) these phrases must work, each answered
in a sentence or two while the card carries the details:

| The user says | Tool |
| --- | --- |
| "Plan my day" / "What should we do that day?" | plan_itinerary (4–5 items for the booking's city and date) |
| "Get me a ride to the hotel" / "Pick me up at JFK" / "A ride to the Met" | quote_ride |
| "Can I check in early? I land at noon" | request_early_checkin |
| "I'm here, check me in" / "Check in" | check_in |
| "Two more towels please" / "A toothbrush kit" / "Clean the room" | request_service |
| "Book breakfast for tomorrow" / "A table for dinner at 7" | reserve_dining |
| "Wake me up at 7am" | set_wakeup_call |
| "What's the Wi-Fi password?" / "When is breakfast?" | get_stay_info |
| "One more night" / "Two more nights" | prepare_extension |
| "I'd like to check out" | check_out |
| "Email me a receipt" / "Send the receipt to …@…" | request_receipt |
| "My points" / "Am I Gold yet?" | get_membership |
| "Write a review" | draft_review |

Questions about check-in or check-out ("What time is checkout?", "Can I check out late?", "What do I need to check
in?") go to get_stay_info; only an explicit request ("I'd like to check out", "Check me out", "I'm here, check me in")
calls check_out / check_in. After an early check-in, "a ride to the hotel" and "plan my day" are about today. Notices
from the hotel (front-desk check-in, the early check-in answer, a review reply) get a one-line answer too.

The booking replies stay short as well (the cards show the hotels and rooms) and keep the quick-reply cues:
`Reply "Book #1"`, `Say "Yes" or "#2"`, `Tap "Confirm booking"`.
