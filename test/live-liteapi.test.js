import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiteApiSupplier, isLiteApiSandboxKey, mapCancelPolicy, penaltyAt, liteApiTimeToIso, buildOccupancies, categoryForStars, mapLiteApiHotel,
  formatUsd, to24h, LITEAPI, lowestNightly,
} from '../src/live/liteapi.js';
import { LiveServiceError } from '../src/live/http.js';
import { createFakeFetch } from './fakes/fake-fetch.js';
import { SANDBOX_KEY, TIMES_SQUARE, hotelsList, hotelDetails, ratesResponse, prebookResponse, bookResponse, cancelResponse } from './fakes/liteapi-fixtures.js';

const NOW = new Date('2026-11-04T16:00:00Z');
const STAY = { checkIn: '2026-12-04', checkOut: '2026-12-06', adults: 2, rooms: 1 };

function clockAt(date) {
  let t = date.getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

function makeSupplier(steps, opts = {}) {
  const fetch = createFakeFetch(steps);
  const logs = [];
  const sleeps = [];
  const clock = opts.clock || clockAt(NOW);
  const supplier = createLiteApiSupplier({
    apiKey: SANDBOX_KEY,
    fetch,
    clock,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { supplier, fetch, logs, sleeps, clock };
}

const searchSteps = () => [{ json: hotelsList() }, { json: ratesResponse() }];

describe('LiteAPI: keys and setup', () => {
  test('sandbox is chosen by the key prefix', () => {
    assert.equal(isLiteApiSandboxKey('sand_123'), true);
    assert.equal(isLiteApiSandboxKey('sandbox_123'), true);
    assert.equal(isLiteApiSandboxKey('prod_123'), false);
    assert.equal(isLiteApiSandboxKey(''), false);
    const { supplier } = makeSupplier([]);
    assert.equal(supplier.sandbox, true);
    assert.equal(supplier.source, 'liteapi');
    assert.equal(supplier.live, true);
    assert.deepEqual(supplier.paymentSdk, { scriptUrl: LITEAPI.paymentSdk.scriptUrl, publishableKey: null, environment: 'sandbox', testCard: '4242 4242 4242 4242' });
    const prod = createLiteApiSupplier({ apiKey: 'prod_abc', paymentKey: 'pk_live_51NanaPublishable', fetch: createFakeFetch([]) });
    assert.equal(prod.sandbox, false);
    assert.equal(prod.paymentSdk.environment, 'live');
    assert.equal(prod.paymentSdk.publishableKey, 'pk_live_51NanaPublishable');
    assert.equal(prod.paymentSdk.testCard, null);
    assert.throws(() => createLiteApiSupplier({ apiKey: '' }), /apiKey/);
  });

  test('cities resolve synchronously (supplier interface); any US city is allowed', () => {
    const { supplier } = makeSupplier([]);
    const nyc = supplier.resolveCity('NYC');
    assert.equal(nyc.name, 'New York');
    assert.equal(nyc.fullName, 'New York, NY');
    assert.deepEqual(nyc.center, { lng: -73.984, lat: 40.7549 });
    assert.equal(supplier.resolveCity('Boise, ID').known, false);
    assert.equal(supplier.resolveCity(''), null);
    assert.ok(supplier.listCities().some((c) => c.name === 'Las Vegas'));
  });
});

describe('LiteAPI: search', () => {
  test('a city-wide search: hotel list around the city center, then one rates request for those hotels', async () => {
    const { supplier, fetch } = makeSupplier(searchSteps());
    const hotels = await supplier.searchHotels({ city: 'New York', ...STAY });
    assert.equal(fetch.calls.length, 2);
    const [list, rates] = fetch.calls;
    const url = new URL(list.url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.liteapi.travel/v3.0/data/hotels');
    assert.equal(list.method, 'GET');
    assert.equal(list.headers['x-api-key'], SANDBOX_KEY);
    assert.equal(url.searchParams.get('latitude'), '40.75490');
    assert.equal(url.searchParams.get('longitude'), '-73.98400');
    assert.equal(url.searchParams.get('radius'), '12000');
    assert.equal(rates.url, 'https://api.liteapi.travel/v3.0/hotels/rates');
    assert.equal(rates.method, 'POST');
    assert.equal(rates.headers['content-type'], 'application/json');
    assert.deepEqual(rates.json, {
      hotelIds: ['lp7e8f9', 'lp1a2b3', 'lp4c5d6'],
      occupancies: [{ adults: 2, children: [] }],
      currency: 'USD',
      guestNationality: 'US',
      checkin: '2026-12-04',
      checkout: '2026-12-06',
      timeout: LITEAPI.ratesTimeoutSeconds,
      roomMapping: true,
    });
    assert.deepEqual(hotels.map((h) => h.id), ['lp7e8f9', 'lp1a2b3', 'lp4c5d6'], 'best rated first; deleted and id-less hotels dropped');
  });

  test('hotels map to the sim supplier\'s Hotel shape, priced with a RoomOffer', async () => {
    const { supplier } = makeSupplier(searchSteps());
    const hotels = await supplier.searchHotels({ city: 'New York', ...STAY });
    const h = hotels.find((x) => x.id === 'lp1a2b3');
    for (const k of ['id', 'name', 'city', 'district', 'address', 'location', 'tel', 'rating', 'reviewCount', 'openedYear', 'amenities', 'category', 'businessArea', 'tags', 'photos', 'priceHint', 'source']) {
      assert.ok(k in h, k);
    }
    assert.equal(h.name, 'Midtown Lights Hotel');
    assert.equal(h.address, '123 W 44th St, New York 10036');
    assert.deepEqual(h.location, { lng: -73.9845, lat: 40.759 });
    assert.equal(h.rating, 4.3, '0–10 becomes 0–5');
    assert.equal(h.stars, 4);
    assert.equal(h.category, 'upscale');
    assert.deepEqual(h.tags, [], '"Not Available" is not a chain');
    assert.deepEqual(h.photos, ['https://static.example-cdn.com/h/1.jpg', 'https://static.example-cdn.com/h/1t.jpg']);
    assert.equal(h.source, 'liteapi');
    assert.equal(h.priceHint, null);
    assert.equal(hotels.find((x) => x.id === 'lp4c5d6').tags[0], 'Example Stays');

    const offer = h.offer;
    assert.equal(offer.hotelId, 'lp1a2b3');
    assert.equal(offer.nights, 2);
    assert.equal(offer.currency, 'USD');
    assert.equal(offer.demo, false);
    assert.equal(offer.sandbox, true);
    assert.deepEqual(offer.roomTypes.map((rt) => rt.name), ['Queen Room', 'Deluxe King'], 'cheapest room first');
    const king = offer.roomTypes[1];
    assert.equal(king.rates.length, 2, 'same room/board/terms from two suppliers: the cheaper one only');
    const [ro, bb] = king.rates;
    assert.match(ro.rateId, /^L[0-9a-z]{12}$/);
    assert.ok(ro.rateId.length <= 40);
    assert.equal(ro.name, 'Room only · Non-refundable');
    assert.equal(ro.breakfast, 0);
    assert.equal(ro.cancelPolicy.type, 'none');
    assert.equal(ro.totalPrice, 412.3);
    assert.deepEqual(ro.nightly, [{ date: '2026-12-04', price: 206.15 }, { date: '2026-12-05', price: 206.15 }]);
    assert.equal(ro.publicPrice, 450);
    assert.equal(ro.payment, 'prepay');
    assert.equal(ro.available, true);
    assert.equal(bb.name, 'Breakfast included · Free cancellation');
    assert.equal(bb.breakfast, 2);
    assert.equal(bb.totalPrice, 468);
    assert.equal(bb.cancelPolicy.freeUntil, '2026-12-02T23:59:59.000Z');
    assert.match(bb.cancelPolicy.text, /^Free cancellation until Wed, Dec 2, 11:59 PM UTC\. After that, cancelling costs \$234\.$/);
    const queen = offer.roomTypes[0].rates[0];
    assert.deepEqual(queen.payAtProperty, { amount: 50, currency: 'USD', text: 'Plus $50.00 in fees paid at the hotel' });
    assert.match(queen.cancelPolicy.text, /the full price/);
    assert.equal(h.lowestPrice, 190, '380 for 2 nights');
    assert.equal(lowestNightly(offer), 190);
    assert.ok(!JSON.stringify(hotels).includes('OFFER-'), 'offer ids stay server-side');
  });

  test('a hotel without rates is priced as unavailable (lowestPrice null)', async () => {
    const { supplier } = makeSupplier(searchSteps());
    const hotels = await supplier.searchHotels({ city: 'New York', ...STAY });
    const far = hotels.find((x) => x.id === 'lp7e8f9');
    assert.deepEqual(far.offer.roomTypes, []);
    assert.equal(far.lowestPrice, null);
  });

  test('around a landmark: a wider circle is fetched once, filtered to the radius, nearest first', async () => {
    const { supplier, fetch } = makeSupplier([{ json: hotelsList() }, { json: ratesResponse() }, { json: hotelsList() }, { json: ratesResponse() }]);
    const near = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 1500, ...STAY });
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.searchParams.get('latitude'), '40.75800');
    assert.equal(url.searchParams.get('radius'), '5000');
    assert.deepEqual(near.map((h) => h.id), ['lp1a2b3', 'lp4c5d6']);
    assert.ok(near[0].distanceM < near[1].distanceM);
    assert.deepEqual(fetch.calls[1].json.hotelIds, ['lp1a2b3', 'lp4c5d6']);
    // Relaxing within the circle already fetched (and priced): no request at all.
    const relaxed = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 2500, ...STAY });
    assert.equal(fetch.calls.length, 2);
    assert.equal(relaxed.length, 2);
    // Beyond it: a bigger circle, and rates only for the hotel not priced yet.
    const wider = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 7000, ...STAY });
    assert.equal(fetch.calls.length, 4);
    assert.equal(new URL(fetch.calls[2].url).searchParams.get('radius'), '14000');
    assert.deepEqual(fetch.calls[3].json.hotelIds, ['lp7e8f9']);
    assert.equal(wider.length, 3);
    const luxury = await supplier.searchHotels({ city: 'New York', location: TIMES_SQUARE, radiusM: 7000, categories: ['luxury'], ...STAY });
    assert.deepEqual(luxury.map((h) => h.id), ['lp7e8f9']);
    assert.equal(fetch.calls.length, 4);
  });

  test('rates are cached for a few minutes, the hotel list for hours', async () => {
    const clock = clockAt(NOW);
    const { supplier, fetch } = makeSupplier([...searchSteps(), { json: ratesResponse() }], { clock });
    const first = await supplier.searchHotels({ city: 'New York', ...STAY });
    first.find((h) => h.id === 'lp1a2b3').offer.roomTypes[0].rates[0].totalPrice = 1;
    const second = await supplier.searchHotels({ city: 'New York', ...STAY });
    assert.equal(fetch.calls.length, 2);
    assert.equal(second.find((h) => h.id === 'lp1a2b3').offer.roomTypes[0].rates[0].totalPrice, 380, 'cached offers are handed out as copies');
    clock.advance(4 * 60 * 1000);
    await supplier.searchHotels({ city: 'New York', ...STAY });
    assert.equal(fetch.calls.length, 3);
    assert.equal(fetch.calls[2].url, 'https://api.liteapi.travel/v3.0/hotels/rates');
  });

  test('a city not in the table is searched by name; no dates means no rates request', async () => {
    const { supplier, fetch } = makeSupplier([{ json: { data: [] } }, { json: hotelsList() }]);
    assert.deepEqual(await supplier.searchHotels({ city: 'Boise, ID', ...STAY }), []);
    const q = new URL(fetch.calls[0].url).searchParams;
    assert.equal(q.get('countryCode'), 'US');
    assert.equal(q.get('cityName'), 'Boise');
    const unpriced = await supplier.searchHotels({ city: 'Chicago' });
    assert.equal(fetch.calls.length, 2);
    assert.ok(unpriced.every((h) => h.offer === null && h.lowestPrice === null));
  });

  test('"no availability" (code 2001, even on HTTP 200) is an empty answer, not an error', async () => {
    const { supplier } = makeSupplier([{ json: hotelsList() }, { json: { error: { code: 2001, description: 'no availability found', message: 'no availability found' } } }]);
    const hotels = await supplier.searchHotels({ city: 'New York', ...STAY });
    assert.equal(hotels.length, 3);
    assert.ok(hotels.every((h) => h.lowestPrice === null));
  });

  test('a party is spread over its rooms, with a default age for each child', () => {
    assert.deepEqual(buildOccupancies({ adults: 5, children: 3, rooms: 2 }), [{ adults: 3, children: [8, 8] }, { adults: 2, children: [8] }]);
    assert.deepEqual(buildOccupancies({ adults: 1, rooms: 2 }), [{ adults: 1, children: [] }, { adults: 1, children: [] }]);
    assert.deepEqual(buildOccupancies({ adults: 2, children: 1, childAges: [4] }), [{ adults: 2, children: [4] }]);
  });
});

describe('LiteAPI: hotel details and room offer', () => {
  test('details: HD photos (default first), facilities, plain-text description, phone, check-in/out times', async () => {
    const { supplier, fetch } = makeSupplier([{ json: hotelDetails() }]);
    const h = await supplier.getHotel('lp1a2b3');
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.pathname, '/v3.0/data/hotel');
    assert.equal(url.searchParams.get('hotelId'), 'lp1a2b3');
    assert.deepEqual(h.photos.slice(0, 2), ['https://static.example-cdn.com/h/1-a-hd.jpg', 'https://static.example-cdn.com/h/1-b-hd.jpg']);
    assert.deepEqual(h.amenities, ['Free WiFi', 'Fitness center', 'Rooftop bar']);
    assert.equal(h.description, 'Steps from Times Square. Rooftop bar & gym.');
    assert.equal(h.tel, '+12125550123');
    assert.equal(h.checkInTime, '15:00');
    assert.equal(h.checkOutTime, '11:00');
    assert.equal(h.timesFromHotel, true);
    assert.equal(h.rooms[0].bed, '1 King bed');
    assert.equal(h.rooms[0].areaSqm, 28);
    assert.equal(h.rooms[1].bed, '2 Queen beds');
    await supplier.getHotel('lp1a2b3');
    assert.equal(fetch.calls.length, 1, 'details are cached');
  });

  test('an unknown hotel is null (and a missing time falls back to 3:00 PM / 11:00 AM)', async () => {
    const { supplier } = makeSupplier([{ status: 404, json: { error: { code: 404, message: 'hotel not found' } } }, { json: { data: { id: 'lpx', name: 'Plain Hotel' } } }]);
    assert.equal(await supplier.getHotel('lpnope'), null);
    const plain = await supplier.getHotel('lpx');
    assert.equal(plain.checkInTime, '15:00');
    assert.equal(plain.checkOutTime, '11:00');
    assert.equal(plain.timesFromHotel, false);
  });

  test('getRoomOffer joins the rates with the room details (bed, size, photos)', async () => {
    const { supplier } = makeSupplier([{ json: hotelDetails() }, { json: ratesResponse() }]);
    const { hotel, offer } = await supplier.getRoomOffer({ hotelId: 'lp1a2b3', ...STAY });
    assert.equal(hotel.name, 'Midtown Lights Hotel');
    const king = offer.roomTypes.find((rt) => rt.name === 'Deluxe King');
    assert.equal(king.bed, '1 King bed');
    assert.equal(king.areaSqm, 28);
    assert.deepEqual(king.photos, ['https://static.example-cdn.com/r/555-hd.jpg']);
    assert.equal(supplier.findRate(offer, king.rates[0].rateId).roomType.name, 'Deluxe King');
  });
});

describe('LiteAPI: prebook → payment → book', () => {
  test('prebook finds the offer by its short rateId and asks for a payment session', async () => {
    const { supplier, fetch } = makeSupplier([...searchSteps(), { json: prebookResponse() }], { paymentKey: 'pk_test_51NanaPublishable' });
    const hotels = await supplier.searchHotels({ city: 'New York', ...STAY });
    const rate = hotels.find((h) => h.id === 'lp1a2b3').offer.roomTypes[1].rates[1];
    const pb = await supplier.prebook({ hotelId: 'lp1a2b3', rateId: rate.rateId, ...STAY });
    const req = fetch.calls[2];
    assert.equal(req.url, 'https://book.liteapi.travel/v3.0/rates/prebook');
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.json, { offerId: 'OFFER-B', usePaymentSdk: true });
    assert.equal(pb.prebookId, 'pb_7f3a');
    assert.equal(pb.price, 468);
    assert.equal(pb.expectedPrice, 468);
    assert.equal(pb.priceChanged, false);
    assert.equal(pb.cancelPolicy.type, 'free');
    assert.equal(pb.termsAndConditions, 'Hotel terms & conditions.');
    assert.deepEqual(pb.payment, {
      provider: 'liteapi', transactionId: 'tr_9b2c', secretKey: 'pi_3Q_secret_test_abc', publishableKey: 'pk_test_51NanaPublishable', environment: 'sandbox', scriptUrl: LITEAPI.paymentSdk.scriptUrl,
    });
    assert.equal(pb.sandbox, true);
  });

  test('after a restart (no cached offer) prebook searches the rates again; a vanished rate is sold out', async () => {
    const { supplier: first } = makeSupplier(searchSteps());
    const rateId = (await first.searchHotels({ city: 'New York', ...STAY })).find((h) => h.id === 'lp1a2b3').offer.roomTypes[1].rates[1].rateId;
    const { supplier, fetch } = makeSupplier([{ json: ratesResponse() }, { json: prebookResponse({ price: 471.2, pct: 0.7 }) }, { json: { data: [] } }]);
    const pb = await supplier.prebook({ hotelId: 'lp1a2b3', rateId, ...STAY });
    assert.equal(fetch.calls[0].url, 'https://api.liteapi.travel/v3.0/hotels/rates');
    assert.deepEqual(fetch.calls[1].json, { offerId: 'OFFER-B', usePaymentSdk: true });
    assert.equal(pb.priceChanged, true);
    assert.equal(pb.price, 471.2);
    await assert.rejects(supplier.prebook({ hotelId: 'lp1a2b3', rateId: 'Lnothere00000', ...STAY, adults: 3 }), (err) => err instanceof LiveServiceError && err.code === 'sold_out');
  });

  test('an expired remembered offer gets one fresh search, and the same rate is locked with the new offer id', async () => {
    const expired = { status: 400, json: { error: { code: 4002, message: 'Offer has expired' } } };
    const { supplier, fetch } = makeSupplier([...searchSteps(), expired, { json: ratesResponse({ suffix: '-v2' }) }, { json: prebookResponse() }]);
    const rateId = (await supplier.searchHotels({ city: 'New York', ...STAY })).find((h) => h.id === 'lp1a2b3').offer.roomTypes[1].rates[1].rateId;
    const pb = await supplier.prebook({ hotelId: 'lp1a2b3', rateId, ...STAY });
    assert.equal(pb.prebookId, 'pb_7f3a');
    assert.deepEqual(fetch.calls.map((c) => new URL(c.url).pathname), ['/v3.0/data/hotels', '/v3.0/hotels/rates', '/v3.0/rates/prebook', '/v3.0/hotels/rates', '/v3.0/rates/prebook']);
    assert.equal(fetch.calls[2].json.offerId, 'OFFER-B');
    assert.equal(fetch.calls[4].json.offerId, 'OFFER-B-v2');
  });

  describe('409 / 2001 "price exceeds locked selling price, please search again"', () => {
    const PRICE_409 = { status: 409, json: { error: { code: 2001, description: 'provider price exceeds locked selling price, please search again' } } };
    /** The same answer with every price raised by `delta` (and new offer ids). */
    function bumped(delta, suffix) {
      const resp = ratesResponse({ suffix });
      for (const h of resp.data) {
        for (const rt of h.roomTypes) {
          if (rt.offerRetailRate) rt.offerRetailRate.amount += delta;
          for (const r of rt.rates) r.retailRate.total[0].amount += delta;
        }
      }
      return resp;
    }
    async function searched(extraSteps) {
      const made = makeSupplier([...searchSteps(), ...extraSteps]);
      const hotels = await made.supplier.searchHotels({ city: 'New York', ...STAY });
      const rate = hotels.find((h) => h.id === 'lp1a2b3').offer.roomTypes[1].rates[1];
      return { ...made, rate };
    }
    const paths = (fetch) => fetch.calls.map((c) => new URL(c.url).pathname);

    test('is classified as a price change, not as "unavailable"', async () => {
      const { classifyLiteApiError } = await import('../src/live/liteapi.js');
      const err = classifyLiteApiError(409, PRICE_409.json);
      assert.equal(err.code, 'price_changed');
      assert.equal(err.retryable, false);
      assert.equal(classifyLiteApiError(409, { error: { code: 2001, description: 'no availability found' } }).code, 'sold_out');
      assert.equal(classifyLiteApiError(409, { error: { message: 'conflict' } }).code, 'unavailable');
    });

    test('one fresh search, the same rate locked again with its new offer id; the new price is flagged', async () => {
      const { supplier, fetch, rate } = await searched([PRICE_409, { json: bumped(25, '-v2') }, { json: prebookResponse({ price: 493 }) }]);
      const pb = await supplier.prebook({ hotelId: 'lp1a2b3', rateId: rate.rateId, ...STAY });
      assert.deepEqual(paths(fetch), ['/v3.0/data/hotels', '/v3.0/hotels/rates', '/v3.0/rates/prebook', '/v3.0/hotels/rates', '/v3.0/rates/prebook']);
      assert.equal(fetch.calls[2].json.offerId, 'OFFER-B');
      assert.equal(fetch.calls[4].json.offerId, 'OFFER-B-v2');
      assert.equal(pb.prebookId, 'pb_7f3a');
      assert.equal(pb.retried, true);
      assert.equal(pb.rateId, rate.rateId);
      assert.equal(pb.rateChanged, false);
      assert.equal(pb.expectedPrice, 468, 'the price the guest saw');
      assert.equal(pb.price, 493);
      assert.equal(pb.priceChanged, true);
      assert.equal(pb.boardChanged, false);
      assert.equal(pb.cancellationChanged, false);
      assert.equal(pb.roomName, 'Deluxe King');
      assert.equal(pb.rateName, 'Breakfast included · Free cancellation');
    });

    test('when the exact rate is gone, the closest (same room, board and refundability) is locked and flagged', async () => {
      const fresh = ratesResponse({ suffix: '-v3' });
      for (const rt of fresh.data[0].roomTypes.filter((x) => x.offerId.startsWith('OFFER-B') || x.offerId.startsWith('OFFER-C'))) {
        rt.rates[0].cancellationPolicies.cancelPolicyInfos[0].cancelTime = '2026-12-01 23:59:59';
      }
      const { supplier, fetch, rate } = await searched([PRICE_409, { json: fresh }, { json: prebookResponse() }]);
      const pb = await supplier.prebook({ hotelId: 'lp1a2b3', rateId: rate.rateId, ...STAY });
      assert.equal(fetch.calls[4].json.offerId, 'OFFER-B-v3');
      assert.equal(pb.rateChanged, true);
      assert.notEqual(pb.rateId, rate.rateId);
      assert.equal(pb.requestedRateId, rate.rateId);
      assert.equal(pb.boardChanged, false);
      assert.equal(pb.cancellationChanged, false);
    });

    test('still failing after the one retry: price_changed carrying the fresh price, and no further attempts', async () => {
      const { supplier, fetch, rate } = await searched([PRICE_409, { json: bumped(40, '-v2') }, PRICE_409]);
      const err = await supplier.prebook({ hotelId: 'lp1a2b3', rateId: rate.rateId, ...STAY }).catch((e) => e);
      assert.ok(err instanceof LiveServiceError);
      assert.equal(err.code, 'price_changed');
      assert.equal(err.status, 409);
      assert.deepEqual(err.details, {
        hotelId: 'lp1a2b3', requestedRateId: rate.rateId, rateId: rate.rateId, rateChanged: false, oldPrice: 468, newPrice: 508, currency: 'USD',
        roomName: 'Deluxe King', rateName: 'Breakfast included · Free cancellation',
      });
      assert.equal(err.userMessage, 'The price just changed to $508 for your stay. Please check it before you book.');
      assert.equal(fetch.calls.length, 5, 'one re-search and one second prebook, never more');
      assert.equal(fetch.pending(), 0);
    });

    test('a re-search with the same offer id makes no second prebook; one with nothing left is sold out', async () => {
      const same = await searched([PRICE_409, { json: bumped(10, '') }]);
      const err = await same.supplier.prebook({ hotelId: 'lp1a2b3', rateId: same.rate.rateId, ...STAY }).catch((e) => e);
      assert.equal(err.code, 'price_changed');
      assert.equal(err.details.newPrice, 478);
      assert.equal(same.fetch.calls.length, 4);
      const gone = await searched([PRICE_409, { json: { data: [] } }]);
      const soldOut = await gone.supplier.prebook({ hotelId: 'lp1a2b3', rateId: gone.rate.rateId, ...STAY }).catch((e) => e);
      assert.equal(soldOut.code, 'sold_out');
      assert.equal(soldOut.userMessage, 'That room just sold out. Want me to look for another option?');
    });

    test('other prebook failures are not retried (a 500 stays unavailable)', async () => {
      const { supplier, fetch, rate } = await searched([{ status: 500, json: { error: { message: 'internal' } } }]);
      const err = await supplier.prebook({ hotelId: 'lp1a2b3', rateId: rate.rateId, ...STAY }).catch((e) => e);
      assert.equal(err.code, 'unavailable');
      assert.equal(fetch.calls.length, 3);
    });
  });

  test('a "not found" error inside a 200 body is not_found (an unknown hotel is null)', async () => {
    const { supplier } = makeSupplier([{ json: { error: { code: 4001, message: 'Hotel not found' } } }]);
    assert.equal(await supplier.getHotel('lpgone'), null);
  });

  test('book sends holder, guests per room, the transaction id and our order number', async () => {
    const { supplier, fetch } = makeSupplier([{ json: bookResponse() }]);
    const booking = await supplier.book({
      prebookId: 'pb_7f3a', transactionId: 'tr_9b2c', holder: { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com', phone: '+14155550123' },
      guests: ['Sarah Miller', 'Tom Lee'], rooms: 2, clientReference: 'HA20261104123456',
    });
    const req = fetch.calls[0];
    assert.equal(req.url, 'https://book.liteapi.travel/v3.0/rates/book');
    assert.deepEqual(req.json, {
      prebookId: 'pb_7f3a',
      holder: { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com', phone: '+14155550123' },
      payment: { method: 'TRANSACTION_ID', transactionId: 'tr_9b2c' },
      guests: [
        { occupancyNumber: 1, firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' },
        { occupancyNumber: 2, firstName: 'Tom', lastName: 'Lee', email: 'sarah@example.com' },
      ],
      clientReference: 'HA20261104123456',
    });
    assert.equal(booking.bookingId, 'BKX7Q2');
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.hotelConfirmationCode, 'MLH-77801');
    assert.equal(booking.price, 468);
    assert.equal(booking.hotel.name, 'Midtown Lights Hotel');
    assert.equal(booking.cancelPolicy.freeUntil, '2026-12-02T23:59:59.000Z');
  });

  test('book validates before calling and is never retried; a card problem is payment_failed', async () => {
    const { supplier, fetch } = makeSupplier([
      { status: 400, json: { error: { code: 4003, message: 'Payment declined by the issuer' } } },
      { status: 503, json: { error: { message: 'Service Unavailable' } } },
      { json: bookResponse({ status: 'FAILED' }) },
    ]);
    const holder = { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' };
    await assert.rejects(supplier.book({ prebookId: 'pb', transactionId: 't', holder: { ...holder, email: 'nope' } }), { code: 'bad_request', userMessage: 'That email doesn\'t look right' });
    await assert.rejects(supplier.book({ prebookId: 'pb', transactionId: 't', holder: { firstName: 'Sarah', email: 'sarah@example.com' } }), { code: 'bad_request' });
    await assert.rejects(supplier.book({ prebookId: 'pb', holder }), { code: 'bad_request' });
    assert.equal(fetch.calls.length, 0);
    await assert.rejects(supplier.book({ prebookId: 'pb', transactionId: 't', holder }), (err) => err.code === 'payment_failed' && /didn't go through/.test(err.userMessage));
    await assert.rejects(supplier.book({ prebookId: 'pb', transactionId: 't', holder }), { code: 'unavailable' });
    assert.equal(fetch.calls.length, 2, 'a 503 on book is not retried');
    await assert.rejects(supplier.book({ prebookId: 'pb', transactionId: 't', holder }), { code: 'payment_failed' });
  });

  test('sandbox bookings without the payment form use the account card method', async () => {
    const { supplier, fetch } = makeSupplier([{ json: bookResponse() }]);
    await supplier.book({ prebookId: 'pb', paymentMethod: 'ACC_CREDIT_CARD', holder: { firstName: 'Test', lastName: 'Guest', email: 'test@example.com' } });
    assert.deepEqual(fetch.calls[0].json.payment, { method: 'ACC_CREDIT_CARD' });
  });

  test('getBooking and cancel (PUT) map status, fee and refund', async () => {
    const { supplier, fetch } = makeSupplier([{ json: bookResponse() }, { json: cancelResponse() }, { status: 400, json: { error: { message: 'Booking is non-refundable and cannot be cancelled' } } }, { status: 404, json: { error: { message: 'not found' } } }]);
    const b = await supplier.getBooking('BKX7Q2');
    assert.equal(fetch.calls[0].url, 'https://book.liteapi.travel/v3.0/bookings/BKX7Q2');
    assert.equal(b.status, 'confirmed');
    const c = await supplier.cancelBooking('BKX7Q2');
    assert.equal(fetch.calls[1].method, 'PUT');
    assert.deepEqual(c, { bookingId: 'BKX7Q2', status: 'cancelled', supplierStatus: 'CANCELLED', cancelled: true, penalty: 0, refund: 468, currency: 'USD' });
    await assert.rejects(supplier.cancel('BKX7Q2'), { code: 'not_cancellable' });
    assert.equal(await supplier.getBooking('BKNONE'), null);
  });
});

describe('LiteAPI: errors, timeouts, secrets', () => {
  test('401 is auth with a guest-safe English message; the key is never in messages or logs', async () => {
    const { supplier, logs } = makeSupplier([{ status: 401, json: { error: { code: 401, message: `Invalid API key ${SANDBOX_KEY}` } } }]);
    const err = await supplier.searchHotels({ city: 'New York', ...STAY }).catch((e) => e);
    assert.ok(err instanceof LiveServiceError);
    assert.equal(err.code, 'auth');
    assert.equal(err.service, 'liteapi');
    assert.equal(err.userMessage, 'Hotel booking is temporarily unavailable. Please try again later.');
    assert.ok(!err.message.includes(SANDBOX_KEY));
    assert.ok(!JSON.stringify(logs).includes(SANDBOX_KEY));
  });

  test('a GET is retried on 429/5xx (retry-after honored), then gives up as unavailable', async () => {
    const { supplier, fetch, sleeps } = makeSupplier([
      { status: 429, json: { error: { message: 'Too many requests' } }, headers: { 'retry-after': '2' } },
      { status: 502, body: '<html>Bad gateway</html>' },
      { status: 500, json: { error: { message: 'oops' } } },
    ]);
    const err = await supplier.getHotel('lp1a2b3').catch((e) => e);
    assert.equal(fetch.calls.length, 3);
    assert.equal(sleeps[0], 2000);
    assert.equal(err.code, 'unavailable');
    assert.equal(err.retryable, true);
  });

  test('a hanging request times out; a caller abort rejects with the abort, not a LiveServiceError', async () => {
    const { supplier } = makeSupplier([{ delayMs: 5000, json: hotelsList() }], { timeoutMs: 30, maxRetries: 0 });
    const err = await supplier.searchHotels({ city: 'New York' }).catch((e) => e);
    assert.equal(err.code, 'timeout');
    const ctrl = new AbortController();
    const { supplier: s2 } = makeSupplier([{ delayMs: 5000, json: hotelsList() }]);
    setTimeout(() => ctrl.abort(), 20);
    const aborted = await s2.searchHotels({ city: 'New York', signal: ctrl.signal }).catch((e) => e);
    assert.equal(aborted.name, 'AbortError');
    assert.ok(!(aborted instanceof LiveServiceError));
  });

  test('logs carry method, path, status and time only (no guest names, emails or query strings)', async () => {
    const { supplier, logs } = makeSupplier([...searchSteps(), { json: bookResponse() }]);
    await supplier.searchHotels({ city: 'New York', ...STAY });
    await supplier.book({ prebookId: 'pb', transactionId: 't', holder: { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' } });
    assert.match(logs[0], /^\[liteapi\] GET \/v3\.0\/data\/hotels 200 \d+ms$/);
    const all = logs.join('\n');
    for (const secret of ['Sarah', 'sarah@example.com', 'latitude', SANDBOX_KEY]) assert.ok(!all.includes(secret), secret);
  });

  test('invalid stays are rejected before any request', async () => {
    const { supplier, fetch } = makeSupplier([{ json: hotelsList() }]);
    await assert.rejects(supplier.getRoomOffer({ hotelId: 'lp1', checkIn: '2026-12-06', checkOut: '2026-12-04' }), { code: 'bad_request' });
    assert.equal(fetch.calls.length, 0);
  });

  test('resolveLandmark goes through the geocoder', async () => {
    const seen = [];
    const geocoder = { geocode: async (text, opts) => { seen.push([text, opts.city]); return { name: 'Times Square', lat: 40.758, lng: -73.9855, address: 'Manhattan, NY 10036', types: ['tourist_attraction'], source: 'google' }; } };
    const { supplier } = makeSupplier([], { geocoder });
    const lm = await supplier.resolveLandmark('New York', 'Times Square');
    assert.deepEqual(seen, [['Times Square', 'New York, NY']]);
    assert.deepEqual(lm, { name: 'Times Square', location: { lng: -73.9855, lat: 40.758 }, area: 'Manhattan, NY 10036', type: 'tourist_attraction', extentM: 0, matched: 'exact', source: 'google' });
    const { supplier: none } = makeSupplier([]);
    assert.equal(await none.resolveLandmark('New York', 'Times Square'), null);
  });
});

describe('LiteAPI: mapping helpers', () => {
  test('cancellation policies: non-refundable, free until a deadline, deadline passed, penalties over time', () => {
    const nrfn = mapCancelPolicy({ refundableTag: 'NRFN' }, { total: 300 });
    assert.equal(nrfn.type, 'none');
    assert.equal(penaltyAt(nrfn, Date.now(), 300), 300);
    const cp = { refundableTag: 'RFN', cancelPolicyInfos: [{ cancelTime: '2026-12-03 12:00:00', amount: 300, timezone: 'GMT' }, { cancelTime: '2026-12-01 12:00:00', amount: 100, timezone: 'GMT' }] };
    const free = mapCancelPolicy(cp, { total: 300, now: NOW.getTime() });
    assert.equal(free.type, 'free');
    assert.equal(free.freeUntil, '2026-12-01T12:00:00.000Z');
    assert.equal(free.label, 'Free cancellation');
    assert.equal(penaltyAt(free, Date.parse('2026-11-30T00:00:00Z'), 300), 0);
    assert.equal(penaltyAt(free, Date.parse('2026-12-02T00:00:00Z'), 300), 100);
    assert.equal(penaltyAt(free, Date.parse('2026-12-04T00:00:00Z'), 300), 300);
    const late = mapCancelPolicy(cp, { total: 300, now: Date.parse('2026-12-02T00:00:00Z') });
    assert.equal(late.label, 'Cancellation fee applies');
    assert.match(late.text, /^Free cancellation ended Tue, Dec 1, 12:00 PM UTC\. Cancelling now costs \$100\.$/);
    assert.equal(mapCancelPolicy({ refundableTag: 'RFN', cancelPolicyInfos: [] }).type, 'free');
    assert.equal(mapCancelPolicy(undefined).type, 'none');
  });

  test('LiteAPI times: naive times in a named zone, GMT, ISO', () => {
    assert.equal(liteApiTimeToIso('2026-12-02 23:59:59', 'GMT'), '2026-12-02T23:59:59.000Z');
    assert.equal(liteApiTimeToIso('2026-12-02 18:00:00', 'America/New_York'), '2026-12-02T23:00:00.000Z');
    assert.equal(liteApiTimeToIso('2026-07-02 18:00', 'America/Los_Angeles'), '2026-07-03T01:00:00.000Z');
    assert.equal(liteApiTimeToIso('2026-12-02T10:00:00-05:00'), '2026-12-02T15:00:00.000Z');
    assert.equal(liteApiTimeToIso('soon'), null);
    assert.equal(liteApiTimeToIso('2026-12-02 12:00:00', 'Not/AZone'), '2026-12-02T12:00:00.000Z');
  });

  test('stars → category, money and clock formatting', () => {
    assert.deepEqual([1, 2, 3, 3.5, 4, 4.5, 5, null].map(categoryForStars), ['budget', 'budget', 'midscale', 'upscale', 'upscale', 'luxury', 'luxury', 'midscale']);
    assert.equal(formatUsd(1108.4), '$1,108');
    assert.equal(formatUsd(85.5), '$85.50');
    assert.equal(to24h('3:00 PM'), '15:00');
    assert.equal(to24h('12:00 am'), '00:00');
    assert.equal(to24h('11:00'), '11:00');
    assert.equal(to24h('noon'), '');
    assert.equal(mapLiteApiHotel({ id: 'x', name: 'Bad Coords', latitude: 400, longitude: 10 }).location, null);
  });
});
