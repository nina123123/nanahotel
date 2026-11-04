import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildUberLink, buildLyftLink, buildRideLinks, ridePoint, RIDE_LINKS } from '../src/live/rides.js';

const JFK = { name: 'JFK Terminal 4', lat: 40.6441, lng: -73.7823 };
const HOTEL = { name: 'Midtown Lights Hotel', lat: 40.759, lng: -73.9845, address: '123 W 44th St, New York, NY 10036' };

function params(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

describe('ride links', () => {
  test('Uber: setPickup with pickup and drop-off coordinates, names and address', () => {
    const url = buildUberLink({ pickup: JFK, dropoff: HOTEL });
    assert.ok(url.startsWith(`${RIDE_LINKS.uber}?action=setPickup&`));
    assert.match(url, /pickup\[latitude\]=40\.6441&pickup\[longitude\]=-73\.7823/);
    assert.deepEqual(params(url), {
      action: 'setPickup',
      'pickup[latitude]': '40.6441',
      'pickup[longitude]': '-73.7823',
      'pickup[nickname]': 'JFK Terminal 4',
      'dropoff[latitude]': '40.759',
      'dropoff[longitude]': '-73.9845',
      'dropoff[nickname]': 'Midtown Lights Hotel',
      'dropoff[formatted_address]': '123 W 44th St, New York, NY 10036',
    });
  });

  test('Uber: no pickup means the rider\'s location; a client id is passed through', () => {
    const p = params(buildUberLink({ dropoff: HOTEL, clientId: 'nana-client' }));
    assert.equal(p.pickup, 'my_location');
    assert.equal(p.client_id, 'nana-client');
    assert.equal(p['pickup[latitude]'], undefined);
  });

  test('Lyft: web link and app scheme with pickup and destination coordinates', () => {
    const web = buildLyftLink({ pickup: JFK, dropoff: HOTEL, partner: 'nana' });
    assert.ok(web.startsWith(`${RIDE_LINKS.lyftWeb}?id=lyft&`));
    assert.deepEqual(params(web), {
      id: 'lyft', 'pickup[latitude]': '40.6441', 'pickup[longitude]': '-73.7823', 'destination[latitude]': '40.759', 'destination[longitude]': '-73.9845', partner: 'nana',
    });
    assert.ok(buildLyftLink({ dropoff: HOTEL, app: true }).startsWith('lyft://ridetype?id=lyft&destination[latitude]=40.759'));
  });

  test('buildRideLinks: both buttons; Lyft is marked inexact without drop-off coordinates; nothing usable → null', () => {
    const links = buildRideLinks({ pickup: JFK, dropoff: HOTEL });
    assert.equal(links.uber.label, 'Open in Uber');
    assert.equal(links.lyft.label, 'Open in Lyft');
    assert.equal(links.lyft.exact, true);
    assert.ok(links.lyft.appUrl.startsWith('lyft://'));
    const named = buildRideLinks({ dropoff: { name: 'Madison Square Garden', address: '4 Pennsylvania Plaza, New York, NY' } });
    assert.equal(named.lyft.exact, false);
    assert.equal(params(named.lyft.url)['destination[latitude]'], undefined);
    assert.equal(params(named.uber.url)['dropoff[nickname]'], 'Madison Square Garden');
    assert.equal(buildRideLinks({ dropoff: null }), null);
    assert.equal(buildRideLinks({ dropoff: { lat: 999, lng: 999 } }), null);
  });

  test('points: invalid or (0, 0) coordinates are dropped; names and addresses are trimmed and encoded', () => {
    assert.deepEqual(ridePoint({ name: ' Hotel ', lat: 0, lng: 0 }), { name: 'Hotel', address: '', lat: null, lng: null });
    assert.deepEqual(ridePoint({ latitude: '40.7', longitude: '-73.9' }), { name: '', address: '', lat: 40.7, lng: -73.9 });
    assert.deepEqual(ridePoint({ location: { lat: 40.12345678, lng: -73.1 } }), { name: '', address: '', lat: 40.123457, lng: -73.1 });
    assert.equal(ridePoint({ lat: 91, lng: 0 }), null);
    const url = buildUberLink({ dropoff: { name: 'Café & Bar #1', lat: 40.7, lng: -73.9 } });
    assert.match(url, /dropoff\[nickname\]=Caf%C3%A9%20%26%20Bar%20%231/);
  });
});
