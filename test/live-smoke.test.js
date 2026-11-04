import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prebookCandidates, prebookFirstWorking } from '../scripts/smoke-live.mjs';
import { createLiteApiSupplier } from '../src/live/liteapi.js';
import { LiveServiceError } from '../src/live/http.js';
import { createFakeFetch } from './fakes/fake-fetch.js';
import { SANDBOX_KEY, hotelsList, ratesResponse, prebookResponse } from './fakes/liteapi-fixtures.js';

const STAY = { checkIn: '2026-12-04', checkOut: '2026-12-06', adults: 2, rooms: 1 };
const PRICE_409 = { status: 409, json: { error: { code: 2001, description: 'provider price exceeds locked selling price, please search again' } } };

function hotel(id, rates) {
  return { id, name: `Hotel ${id}`, offer: { roomTypes: [{ name: 'Room', rates: rates.map(([rateId, totalPrice, refundable, available = true]) => ({ rateId, name: `${rateId} plan`, totalPrice, refundable, available })) }] } };
}

describe('smoke test: which rates to prebook', () => {
  test('refundable first, then cheapest, one per hotel before a second rate of the same hotel', () => {
    const hotels = [
      hotel('H1', [['h1-nrfn', 300, false], ['h1-rfn', 400, true]]),
      hotel('H2', [['h2-rfn', 350, true], ['h2-rfn-big', 500, true]]),
      hotel('H3', [['h3-nrfn', 200, false]]),
      hotel('H4', [['h4-gone', 100, true, false]]),
      { id: 'H5', name: 'No offer', offer: null },
    ];
    assert.deepEqual(prebookCandidates(hotels).map((c) => c.rate.rateId), ['h2-rfn', 'h1-rfn', 'h3-nrfn']);
    assert.deepEqual(prebookCandidates(hotels, 5).map((c) => c.rate.rateId), ['h2-rfn', 'h1-rfn', 'h3-nrfn', 'h2-rfn-big', 'h1-nrfn']);
    assert.deepEqual(prebookCandidates([]), []);
  });
});

describe('smoke test: prebook until one works', () => {
  test('a price change that survives the supplier\'s one re-search moves on to the next rate, and says which attempt worked', async () => {
    const fetch = createFakeFetch([{ json: hotelsList() }, { json: ratesResponse() }, PRICE_409, { json: ratesResponse({ suffix: '-v2' }) }, PRICE_409, { json: prebookResponse({ price: 301.5 }) }]);
    const supplier = createLiteApiSupplier({ apiKey: SANDBOX_KEY, fetch, clock: { now: () => new Date('2026-11-04T16:00:00Z') } });
    const priced = (await supplier.searchHotels({ city: 'New York', ...STAY })).filter((h) => h.lowestPrice !== null);
    const candidates = prebookCandidates(priced, 3);
    assert.deepEqual(candidates.map((c) => [c.hotel.id, c.rate.name]), [
      ['lp1a2b3', 'Room only · Free cancellation'],
      ['lp4c5d6', 'Room only · Non-refundable'],
      ['lp1a2b3', 'Breakfast included · Free cancellation'],
    ]);
    const got = await prebookFirstWorking(supplier, candidates, STAY);
    assert.equal(got.attempt, 2);
    assert.equal(got.candidate.hotel.id, 'lp4c5d6');
    assert.equal(got.result.prebookId, 'pb_7f3a');
    assert.equal(got.failures.length, 1);
    assert.equal(got.failures[0].error.code, 'price_changed');
    assert.equal(got.failures[0].error.details.newPrice, 380);
    assert.deepEqual(fetch.calls.slice(2).map((c) => [new URL(c.url).pathname, c.json?.offerId ?? null]), [
      ['/v3.0/rates/prebook', 'OFFER-D'],
      ['/v3.0/hotels/rates', null],
      ['/v3.0/rates/prebook', 'OFFER-D-v2'],
      ['/v3.0/rates/prebook', 'OFFER-X'],
    ]);
  });

  test('when every attempt fails the error lists them all; a stop is not counted as a failed attempt', async () => {
    const failing = { prebook: async () => { throw new LiveServiceError('liteapi', 'price_changed', { status: 409, message: 'price exceeds locked selling price' }); } };
    const candidates = prebookCandidates([hotel('A', [['a', 100, true]]), hotel('B', [['b', 120, true]]), hotel('C', [['c', 90, false]])]);
    const err = await prebookFirstWorking(failing, candidates, STAY).catch((e) => e);
    assert.match(err.message, /^all 3 attempts failed: #1 "Hotel A" \(a plan\): \[price_changed 409\] price exceeds locked selling price; #2 "Hotel B"/);
    assert.match(err.message, /#3 "Hotel C"/);
    await assert.rejects(prebookFirstWorking(failing, [], STAY), /no bookable rate to try/);
    const stopped = { prebook: async () => { throw new DOMException('stopped', 'AbortError'); } };
    await assert.rejects(prebookFirstWorking(stopped, candidates, STAY), { name: 'AbortError' });
  });
});
