# NanaHotel for Hotels (demo): service, API, data

The hotel console is for the front desk and the manager: the overview, rooms and check-in, guest requests, and reviews
and promotions. It runs on the same server and data as the traveler side, so the two are connected: the room a
traveler books in NanaHotel, the towels they ask for and the review they write show up in the console at once; when
the hotel accepts and delivers a request, checks a guest in, replies to a review or starts a deal, the traveler's
cards and prices follow. Everything is simulated. This document is the agreement between the back end (`src/`) and
the front end (`public/merchant.*`).

Principles:
- A demo: no sign-in. The console only sees masked traveler details: first name and last initial ("Sarah M."), masked
  phone numbers. User ids never reach it.
- The hotel's "other guests" (rooms, tickets, reviews, channels) are simulated deterministically per hotel id and date;
  what really happens in NanaHotel (orders, requests, reviews) is layered on top with `source: 'nanahotel'` (simulated
  items have `source: 'sim'`).
- The hotel's actions change only its own data; the ones that reach a traveler (check-in, request status, early
  check-in answers, review replies) add a notice to the traveler's chat (as order notices do: a notice for the user,
  a `[System notice — not from the user]` line for the model).

## 1. Service: src/services/merchant.js

`createMerchantService({ store, bookings, stays, hotels, clock, promotions })`: synchronous methods, the injected clock,
`MerchantError(code, message)` (code → HTTP status, English message; a stays.js error keeps its own code and status).
It also runs inside the phone app's page (like stays.js it only depends on src/util and src/services). Deals live in
`createPromotionBook({ store, clock })` (collection `merchant_promotions`); the hotel service
`createHotelService({ supplier, clock, promotions })` prices with it, and `buildDeps` hands the same book to both. The
hotel's own changes are stored in `merchant_rooms` (today's cleaning and out-of-order rooms), `merchant_tickets`
(handled simulated tickets) and `merchant_replies` (replies to simulated reviews).

**Time**: each hotel's own zone (its city's). The hotel's "today" is the night in progress: until 6 AM it is still the
previous date, so a guest arriving at 12:30 AM for "tonight" is an arrival of the night that began yesterday. Dates
in and out of the API stay calendar dates; the room grid's "today" shows that night until 6 AM, and so does the last
day of the overview's `series`.

What the other services provide:
- `bookings.ordersForHotel(hotelId)`: every order for the hotel (all users), newest first; `bookings.markCheckedIn(…)`
  records a check-in (by the guest or the desk) on the order (`checkedInAt`), after which it can't be cancelled online.
- stays.js: a hotel's stays and requests (`listHotelStays(hotelId)` with each order's room, `listHotelRequests(hotelId)`);
  `frontDeskCheckIn(orderId)` (the same room the guest's own check-in gets); `advanceRequest(requestId, action)`
  (deliveries: accept / deliver / done; early check-in: approve / decline); `replyReview(reviewId, text)`. A status the
  hotel set wins over the timed one (time never moves it back): Accept → on the way at once, Delivered → done at once;
  untouched requests still go on the way after 1 minute and are delivered after 5.
- Deals (§5): the hotel service multiplies the nights a live deal covers; search results, room prices, quotes,
  orders and extensions use the deal price.

**The current hotel**: `GET /api/merchant/hotels` → `{ hotels: [{ id, name, city, category, rating, rooms, hasGuests }], current }`.
`current` is the hotel of the latest confirmed order (any user); with no orders, a fixed demo hotel: the first
simulated hotel in New York's Times Square area (`sim-nyc-001`). `hotels` lists hotels with NanaHotel orders (newest
first), the demo hotel and a few other kinds (a Las Vegas luxury resort, a French Quarter inn in New Orleans, an
Orlando budget hotel); `hasGuests` = a NanaHotel order that hasn't checked out. The page remembers the hotel the user
switched to.

**Rooms**: each hotel's rooms follow its room types' floor ranges (the same rule stays.js uses to assign rooms: the
room type's `floor` such as "Floors 5–12", skipping the 13th; rooms 01–28 per floor, 01–08 for low-rise inns). Room
numbers map to room types deterministically, so a real traveler's room is always in the grid. Each floor's numbers
are split by room type (kings most, suites and family rooms fewest, only on their floors); the room a NanaHotel guest
gets shows the type they booked, and the simulated guest who would have had it makes way for those nights. A booking
of several rooms occupies the one room stays.js assigns (revenue and room nights count all rooms).

## 2. Overview

`GET /api/merchant/:hotelId/overview?days=30` (days 1–60, default 30, else 400 `invalid_days`) →
```js
{
  hotel: { id, name, city, category, rating, rooms /* total rooms */ },
  date: 'YYYY-MM-DD',                       // the hotel's today
  kpis: {
    occupancy,      // tonight, 0–1
    revenue,        // today's revenue (USD): tonight's rooms + today's dining
    adr,            // average daily rate
    revpar,         // revenue per available room
    arrivals, departures, inHouse,          // rooms arriving, departing, in house today
    openTickets,    // new + in progress
    rating, reviewCount,
    vsLastWeek: { occupancy, revenue },     // change from the same day last week (0.08 = +8%)
  },
  series: [{ date, occupancy, revenue, adr, nanahotel /* NanaHotel room nights that night */, xiaosu /* same value, older name */ }],
                                            // the last `days` nights, oldest first, ending with tonight
  forecast: [{ date, occupancy }],          // the next 14 nights (booked + simulated)
  channels: [{ key: 'nanahotel' | 'expedia' | 'booking' | 'google' | 'direct', label, share /* 0–1 */, nights }],  // all five, in this order
  arrivals: [{ orderId?, guest /* "Sarah M." */, roomType, nights, eta?, source, status: 'arriving' | 'checked_in' }],  // NanaHotel first, at most 20
  insights: [{ id, level: 'tip' | 'warn' | 'good', title, text, action?: { tab, label } }],  // 2–4, by data rules
}
```
Channel labels: NanaHotel, Expedia, Booking.com, Google, Direct. Insight rules (examples): a night forecast at ≥ 90% →
"Fri, Nov 6 looks full" (raise the rate 8–12%; action "Promotions"); requests waiting over 10 minutes → "3 requests
not picked up" ("Handle them"); critical reviews in the last 30 days mentioning the same issue → "3 reviews mention
noise"; more NanaHotel bookings this week → "NanaHotel bookings up 2 this week". Also: NanaHotel guests arriving
today ("Open rooms"), a quiet night in the next 7 days without a deal ("Start a deal"), reviews from the last 7 days
without a reply ("Reply"), and the share of 4–5 star reviews in the last 30 days (the fallback, so there are always at
least 2). `action.tab` is the page's tab key: `overview` / `rooms` / `tickets` / `reviews` (reviews and promotions).

## 3. Rooms and check-in

`GET /api/merchant/:hotelId/rooms?date=YYYY-MM-DD` (default today; today to +6 days, else 400 `invalid_date`) →
```js
{
  date,
  counts: { vacant, dirty, occupied, arriving, departing, ooo },
  floors: [{ floor, rooms: [{
    number, roomType,
    status: 'vacant' | 'dirty' | 'occupied' | 'arriving' | 'departing' | 'ooo',
    guest?: { name /* "Sarah M." */, orderId?, checkIn, checkOut, source },
    tickets?: 1,                     // open tickets for this room
  }] }],
}
```
`POST /api/merchant/:hotelId/rooms/:number` `{ action: 'clean' | 'ooo' | 'release' | 'check_in', orderId? }` → `{ room }`:
- `clean`: vacant dirty → vacant clean; `ooo`: out of order (vacant rooms only, clean or dirty); `release`: out of order →
  vacant clean. Stored for today only (for simulated rooms and for a NanaHotel guest's room after check-out alike).
  Wrong status → 409 `invalid_action`; unknown action → 400 `unknown_action`; no such room → 404 `room_not_found`.
- `check_in`: the desk checks a NanaHotel booking in (checking in today or earlier, confirmed, not yet in). The room is
  the one stays.js gives that order; `:number` must be it, else 409 `wrong_room` (`error.details.roomNumber` is the
  right one). The traveler gets "The front desk checked you in: room 823" with a `checkin` card. Other errors: no
  orderId → 400 `invalid_order`; not this hotel's order → 404 `not_found`; cancelled or unpaid → 409
  `order_not_confirmed`; already in → 409 `already_checked_in`; check-in date not reached → 409 `not_arrived`.

## 4. Guest requests (tickets)

`GET /api/merchant/:hotelId/tickets` →
```js
{ tickets: [{
  id, kind: 'service' | 'early_checkin' | 'wakeup' | 'dining',
  roomNumber, guest /* "Sarah M." */, source: 'nanahotel' | 'sim',
  title,                      // "Towels ×2", "Early check-in 12:00 PM", "Wake-up call 7:00 AM", "Breakfast for 2 at 8:00 AM"
  note?, createdAt, dueAt?,
  status: 'new' | 'doing' | 'done' | 'declined',
  actions: ['accept' | 'deliver' | 'done' | 'approve' | 'decline'],   // what can be done now
  orderId?,
}] }
```
Newest first; `done` ones are kept for 24 hours. Deliveries: `new` (the guest's accepted) → `doing` (on_the_way) →
`done`; `actions` are `['accept', 'deliver']` when new and `['deliver']` when doing (tasks like housekeeping use
`done`, which is the same). Wake-up calls and dining are read-only: `doing` until their time, then `done` (ones
cancelled at check-out drop off). A pending early check-in is `new` and can be approved or declined; a guest arriving
at 12:00 PM or later was confirmed on the spot (`done`). Simulated tickets (phoned in, `source: 'sim'`) are 4–12 a
day in rooms with simulated guests and move on with time too (picked up after 2–30 minutes); an unhandled simulated
early check-in is `done` when the guest arrives.
`POST /api/merchant/:hotelId/tickets/:id` `{ action }` → `{ ticket }`:
- Deliveries: `accept` (new → doing; the guest's card shows "On the way"), `deliver` / `done` (→ done; "Delivered").
- Early check-in: `approve` / `decline`: the traveler gets "The hotel confirmed check-in at 12:00 PM" / "The hotel is
  full that day, so check-in is at 3:00 PM"; their request becomes `confirmed` / `declined`, with that line as its
  `note`.
- Simulated tickets can be handled too (stored, for the demo). Not allowed now → 409 `invalid_action`; unknown action →
  400 `unknown_action`; not found (or done more than 24 hours ago) → 404 `not_found`.

## 5. Reviews and promotions

`GET /api/merchant/:hotelId/reviews` →
```js
{
  summary: { rating, count, distribution: { 5, 4, 3, 2, 1 }, tags: [{ tag, count }] },
  reviews: [{ id, source, guest /* "Sarah M." */, rating, text, tags, roomType?, at, reply?: { text, at } }],   // newest first
}
```
`summary` covers all the hotel's reviews (the simulated history, as many as its `reviewCount`) plus NanaHotel
travelers'; `reviews` lists simulated reviews from the last 60 days (at most 30, most already replied to) and the ones
NanaHotel travelers posted. Simulated reviews are American English.
`POST /api/merchant/:hotelId/reviews/:id/reply` `{ text }` (1–500 characters, else 400 `invalid_reply`) → `{ review }`.
Replying again edits the reply. On a NanaHotel traveler's review the reply also shows on their review card
(`review.reply`, also in `GET /api/stays`), and they get "The hotel replied to your review" (only when the text
changed).
`POST /api/merchant/:hotelId/reviews/:id/draft-reply` → `{ text }`: a template reply by rating and tags (no model call;
the hotel can edit it; critical reviews address the issue they raise, such as noise or breakfast).

`GET /api/merchant/:hotelId/promotions` → `{ promotions: [{ id, title, discount /* 0.85 = 15% off */, from, to, active,
createdAt, stats: { views, orders } }] }`;
`POST /api/merchant/:hotelId/promotions` `{ title, discount, from, to }` → 201 `{ promotion }`, switched on (title 1–30
characters; discount 0.5–0.95, two decimals; `from` and `to` are check-in nights, inclusive, within 60 days from today;
at most 5 deals per hotel that haven't ended). Errors: 400 `invalid_title` / `invalid_discount` / `invalid_date`, 409
`too_many_promotions`.
`POST /api/merchant/:hotelId/promotions/:id` `{ active }` (true / false) → `{ promotion }`.
`stats.views` is simulated (it grows by the hour while the deal is on); `stats.orders` is the NanaHotel orders that
used the deal plus simulated ones from the views.
A live deal (active, with the night in range) applies to each night's price at that hotel (night × discount, rounded to
the dollar; with several, the biggest discount): the from-price in search, room prices, quotes and orders all use it;
the hotel on a `hotels` card has `promo: { id, title, discount }`, rate plans carry `promo` (with the id), and an
order's `rate.promo` records the deal used. Orders already placed don't change; if a deal is switched off after a
quote, confirming reports the price change as usual.

## 6. Notices to the traveler

Like ride and extension notices: the session gets `{ role: 'notice', kind, text, at, cards }` and the model a message
starting `[System notice — not from the user]`; while the traveler is waiting for a reply, it goes in after that
turn. The notice goes to the session of the order (early check-in and reviews: the session of the request).

| kind | text | cards | For the model (example) |
| --- | --- | --- | --- |
| `front_desk_checkin` | The front desk checked you in: room 823 | `checkin` | The front desk checked the user in: …, room 823 (floor 8); the digital key works until Fri, Nov 6, 11:00 AM EST; Wi-Fi …, password … (simulated). |
| `early_checkin_approved` | The hotel confirmed check-in at 12:00 PM | `early_checkin` | The hotel confirmed early check-in for the user: …, Fri, Nov 6 at 12:00 PM (simulated). |
| `early_checkin_declined` | The hotel is full that day, so check-in is at 3:00 PM | `early_checkin` | The hotel declined the user's early check-in: … is full on Fri, Nov 6, so check-in is at 3:00 PM as usual (simulated); the user can leave bags at the front desk. |
| `review_replied` | The hotel replied to your review | `review_draft` (with `reply`) | The hotel replied to the user's review of … (5 stars): “…” (simulated). |

The hotel's own words (a reply) are quoted “…” in the model's copy, with brackets and quotes stripped, so they can't
pass for the platform.

## 7. The page (public/merchant.html)

A black-and-gold console titled **NanaHotel for Hotels**: four tabs at the bottom on a phone (Overview, Rooms,
Requests, Reviews; deals live under Reviews), a sidebar on wide screens. Open it at `http://localhost:8787/merchant` on a computer; in the
phone app and the home-screen web app it's **⋯ → Switch to hotel console (demo)**, and the console has a way back to
the traveler side. It refreshes every 15 seconds while there are open tickets or arrivals today.
