import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIME_ZONE, canonicalTimeZone, isValidTimeZone, resolveTimeZone, todayIn, nowIn, dateIn, timeIn, zonedTimeMs,
  toIsoInZone, zoneAbbr, addDays, nightsBetween, isValidDate, isValidTime, weekdayShort, weekdayLong, dayOfWeek, monthOf,
  formatDate, formatRange, formatTime, formatDateTime, formatClock, stayDates, checkStay, earliestCheckIn, isLateNight,
} from '../src/util/dates.js';
import { guestNameProblem, isValidGuestName, namePartProblem, splitFullName, fullName, maskedGuestName } from '../src/util/names.js';
import { newId, orderNo, isUuid, confirmationNo, transactionId } from '../src/util/ids.js';
import { formatUsd, cents } from '../src/util/money.js';
import { distanceM, offsetPoint } from '../src/util/geo.js';

test('the default zone is New York; zones are checked and canonicalised', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'America/New_York');
  assert.equal(canonicalTimeZone('America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(canonicalTimeZone('america/new_york'), 'America/New_York');
  assert.equal(canonicalTimeZone('US/Pacific'), 'America/Los_Angeles');
  assert.equal(canonicalTimeZone(' Pacific/Honolulu '), 'Pacific/Honolulu');
  assert.equal(canonicalTimeZone('UTC'), 'UTC');
  for (const bad of ['Mars/Olympus', '../../etc/passwd', 'America/New York', '', '   ', 'x'.repeat(80), null, undefined, 42, {}]) {
    assert.equal(canonicalTimeZone(bad), null, String(bad));
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
  assert.equal(resolveTimeZone('Mars/Olympus', 'America/Chicago'), 'America/Chicago');
  assert.equal(resolveTimeZone('nope', 'also nope'), 'America/New_York');
  assert.equal(resolveTimeZone(undefined), 'America/New_York');
  // Many odd names do not grow memory without bound (the alias cache is capped); they still answer correctly.
  for (let i = 0; i < 1200; i++) assert.equal(canonicalTimeZone(`Nowhere/Place_${i}`), null);
  assert.equal(canonicalTimeZone('US/Eastern'), 'America/New_York');
});

test('todayIn / nowIn follow the given zone, not the host', () => {
  // 2026-11-05 07:00 UTC is 11 PM on Wed, Nov 4 in Los Angeles and 2 AM on Thu, Nov 5 in New York.
  const t = new Date('2026-11-05T07:00:00Z');
  assert.equal(todayIn('America/Los_Angeles', t), '2026-11-04');
  assert.equal(todayIn('America/New_York', t), '2026-11-05');
  assert.equal(todayIn(undefined, t), '2026-11-05', 'defaults to New York');
  assert.deepEqual(nowIn('America/Los_Angeles', t), { date: '2026-11-04', time: '23:00', weekday: 'Wed', zone: 'America/Los_Angeles' });
  assert.deepEqual(nowIn('Pacific/Honolulu', t), { date: '2026-11-04', time: '21:00', weekday: 'Wed', zone: 'Pacific/Honolulu' });
  assert.equal(nowIn('Not/AZone', t).zone, 'America/New_York', 'an unknown zone falls back to New York');
  assert.equal(dateIn('2026-11-05T07:00:00Z', 'America/Chicago'), '2026-11-05');
  assert.equal(timeIn(t.getTime(), 'America/Chicago'), '01:00');
  assert.equal(dateIn('not a time'), '');
  assert.equal(timeIn(undefined), '');
});

test('wall times convert to instants across daylight saving time', () => {
  // Winter (EST, -05:00) and summer (EDT, -04:00) in New York.
  assert.equal(toIsoInZone('2026-11-05', '15:00', 'America/New_York'), '2026-11-05T15:00:00-05:00');
  assert.equal(toIsoInZone('2026-07-04', '21:00', 'America/New_York'), '2026-07-04T21:00:00-04:00');
  assert.equal(zonedTimeMs('2026-11-05', '15:00', 'America/New_York'), Date.parse('2026-11-05T20:00:00Z'));
  // DST starts Mar 8, 2026 at 2 AM and ends Nov 1, 2026 at 2 AM.
  assert.equal(toIsoInZone('2026-03-08', '03:30', 'America/New_York'), '2026-03-08T03:30:00-04:00');
  assert.equal(toIsoInZone('2026-03-08', '01:30', 'America/New_York'), '2026-03-08T01:30:00-05:00');
  assert.equal(toIsoInZone('2026-11-01', '12:00', 'America/New_York'), '2026-11-01T12:00:00-05:00');
  // Hawaii and Arizona do not observe DST.
  assert.equal(toIsoInZone('2026-07-01', '15:00', 'Pacific/Honolulu'), '2026-07-01T15:00:00-10:00');
  assert.equal(toIsoInZone('2026-07-01', '15:00', 'America/Phoenix'), '2026-07-01T15:00:00-07:00');
  assert.equal(Date.parse(toIsoInZone('2026-11-05', '15:00', 'America/Los_Angeles')), Date.parse('2026-11-05T23:00:00Z'));
  assert.throws(() => toIsoInZone('2026-11-05', '25:00'), RangeError);
  assert.throws(() => zonedTimeMs('2026-02-30', '10:00'), RangeError);
});

test('zone abbreviations for text read in another zone', () => {
  assert.equal(zoneAbbr('2026-11-05T20:00:00Z', 'America/New_York'), 'EST');
  assert.equal(zoneAbbr('2026-07-01T20:00:00Z', 'America/New_York'), 'EDT');
  assert.equal(zoneAbbr('2026-07-01T20:00:00Z', 'America/Los_Angeles'), 'PDT');
  assert.equal(zoneAbbr('2026-01-01T20:00:00Z', 'America/Chicago'), 'CST');
  assert.equal(zoneAbbr('2026-01-01T20:00:00Z', 'America/Denver'), 'MST');
  assert.equal(zoneAbbr('2026-01-01T20:00:00Z', 'Pacific/Honolulu'), 'HST');
});

test('addDays and nightsBetween handle month/year/leap boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(nightsBetween('2026-10-30', '2026-11-01'), 2);
  assert.equal(nightsBetween('2026-11-01', '2026-10-30'), -2);
  assert.equal(nightsBetween('2026-03-07', '2026-03-09'), 2, 'a DST weekend is still two nights');
  assert.throws(() => addDays('2026-13-01', 1), RangeError);
});

test('isValidDate / isValidTime are strict', () => {
  assert.equal(isValidDate('2026-10-30'), true);
  for (const bad of ['2026-02-30', '2026-1-5', '2026/10/30', '20261030', '', null, undefined, 20261030, '2026-10-30T00:00', '11/06/2026']) {
    assert.equal(isValidDate(bad), false, String(bad));
  }
  assert.equal(isValidTime('07:00'), true);
  assert.equal(isValidTime('23:59'), true);
  for (const bad of ['7:00', '24:00', '12:60', '7am', '', null]) assert.equal(isValidTime(bad), false, String(bad));
});

test('weekday helpers', () => {
  assert.equal(weekdayShort('2026-11-06'), 'Fri');
  assert.equal(weekdayLong('2026-11-08'), 'Sunday');
  assert.equal(dayOfWeek('2026-10-31'), 6);
  assert.equal(monthOf('2026-02-09'), 2);
});

test('formatting follows US conventions', () => {
  assert.equal(formatDate('2026-11-06'), 'Fri, Nov 6');
  assert.equal(formatDate('2026-11-06', '2026-11-04'), 'Fri, Nov 6');
  assert.equal(formatDate('2027-01-01', '2026-11-04'), 'Fri, Jan 1, 2027', 'the year shows when it is not this year');
  assert.equal(formatDate('2026-11-06', null, { weekday: false }), 'Nov 6');
  assert.equal(formatRange('2026-11-06', '2026-11-08', '2026-11-04'), 'Fri, Nov 6 – Sun, Nov 8');
  assert.equal(formatTime('14:30'), '2:30 PM');
  assert.equal(formatTime('00:00'), '12:00 AM');
  assert.equal(formatTime('12:00'), '12:00 PM');
  assert.equal(formatTime('07:05'), '7:05 AM');
  assert.equal(formatDateTime('2026-11-06T19:30:00Z', 'America/New_York'), 'Fri, Nov 6, 2:30 PM');
  assert.equal(formatDateTime('2026-11-06T19:30:00Z', 'America/New_York', { abbr: true }), 'Fri, Nov 6, 2:30 PM EST');
  assert.equal(formatDateTime('2027-01-01T19:30:00Z', 'America/Chicago', { ref: '2026-11-04' }), 'Fri, Jan 1, 2027, 1:30 PM');
  assert.equal(formatClock('2026-11-06T19:30:00Z', 'America/Denver', { abbr: true }), '12:30 PM MST');
  assert.deepEqual(stayDates('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});

test('checkStay: defaults and English validation messages', () => {
  assert.deepEqual(checkStay(undefined, undefined, '2026-10-25'), { checkIn: '2026-10-25', checkOut: '2026-10-26', nights: 1, datesAssumed: true });
  assert.deepEqual(checkStay('2026-10-30', '', '2026-10-25'), { checkIn: '2026-10-30', checkOut: '2026-10-31', nights: 1, datesAssumed: true });
  assert.deepEqual(checkStay('2026-10-30', '2026-11-01', '2026-10-25'), { checkIn: '2026-10-30', checkOut: '2026-11-01', nights: 2, datesAssumed: false });
  assert.match(checkStay('2026-10-24', '2026-10-25', '2026-10-25').error, /has already passed/);
  assert.match(checkStay('2026-10-30', '2026-10-30', '2026-10-25').error, /Check-out needs to be after check-in/);
  assert.match(checkStay('2026-10-30', '2026-12-30', '2026-10-25').error, /at most 30 nights/);
  assert.match(checkStay('2027-12-30', '2027-12-31', '2026-10-25').error, /up to 365 days ahead/);
  assert.match(checkStay('tomorrow', '', '2026-10-25').error, /YYYY-MM-DD/);
  assert.match(checkStay('11/06/2026', '', '2026-10-25').error, /isn't a valid date/);
  assert.match(checkStay('', '', '2026-10-25', { allowDefaults: false }).error, /check-in date is needed/);
  for (const r of [checkStay('2026-10-24', '2026-10-25', '2026-10-25'), checkStay('x', '', '2026-10-25')]) {
    assert.doesNotMatch(r.error, /[㐀-鿿]/, 'no Chinese left');
  }
});

test('the night in progress: before 6 AM local time "tonight" is the night that began yesterday', () => {
  assert.equal(earliestCheckIn(new Date('2026-11-05T00:00:00-05:00'), 'America/New_York'), '2026-11-04');
  assert.equal(earliestCheckIn(new Date('2026-11-05T05:59:00-05:00'), 'America/New_York'), '2026-11-04');
  assert.equal(earliestCheckIn(new Date('2026-11-05T06:00:00-05:00'), 'America/New_York'), '2026-11-05');
  assert.equal(earliestCheckIn(new Date('2026-11-05T23:59:00-05:00'), 'America/New_York'), '2026-11-05');
  // 1:30 AM in Los Angeles is 4:30 AM in New York: both still the night of Nov 4.
  const t = new Date('2026-11-05T09:30:00Z');
  assert.equal(earliestCheckIn(t, 'America/Los_Angeles'), '2026-11-04');
  assert.equal(isLateNight(t, 'America/Los_Angeles'), true);
  // 6:30 AM in New York is 3:30 AM in Los Angeles: a new day in New York, still last night in LA.
  const u = new Date('2026-11-05T11:30:00Z');
  assert.equal(earliestCheckIn(u, 'America/New_York'), '2026-11-05');
  assert.equal(earliestCheckIn(u, 'America/Los_Angeles'), '2026-11-04');
  assert.equal(isLateNight(u, 'America/New_York'), false);
});

test('checkStay honours the late-night floor and the user\'s own "tonight"', () => {
  const opts = { earliestCheckIn: '2026-11-03' };
  assert.deepEqual(checkStay('2026-11-03', '2026-11-04', '2026-11-04', opts), { checkIn: '2026-11-03', checkOut: '2026-11-04', nights: 1, datesAssumed: false });
  assert.deepEqual(checkStay('', '', '2026-11-04', opts), { checkIn: '2026-11-03', checkOut: '2026-11-04', nights: 1, datesAssumed: true });
  const err = checkStay('2026-11-02', '2026-11-04', '2026-11-04', opts).error;
  assert.match(err, /has already passed/);
  assert.match(err, /night in progress \(Tue, Nov 3\) can still be booked until 6 AM/);
  assert.doesNotMatch(checkStay('2026-11-02', '2026-11-03', '2026-11-03', { earliestCheckIn: '2026-11-03' }).error, /night in progress/);
  assert.match(checkStay('2026-11-03', '2026-11-04', '2026-11-04').error, /has already passed/, 'no floor → today');
  assert.equal(checkStay('2026-11-04', '', '2026-11-04', { earliestCheckIn: '2026-11-05' }).checkIn, '2026-11-04', 'a floor after today is ignored');
  // A user in Los Angeles at 11 PM on Nov 4 searches a New York hotel, where it is already 2 AM on Nov 5: their
  // "tonight" (Nov 4) is still the night in progress there, so it is the default.
  assert.deepEqual(checkStay('', '', '2026-11-05', { earliestCheckIn: '2026-11-04', defaultCheckIn: '2026-11-04' }),
    { checkIn: '2026-11-04', checkOut: '2026-11-05', nights: 1, datesAssumed: true });
  // After 6 AM at the hotel that night is over: the default moves on to the hotel's today.
  assert.equal(checkStay('', '', '2026-11-05', { defaultCheckIn: '2026-11-04' }).checkIn, '2026-11-05');
  // A user far ahead (tomorrow already) gets their tonight when it is at most a day off.
  assert.equal(checkStay('', '', '2026-11-04', { defaultCheckIn: '2026-11-05' }).checkIn, '2026-11-05');
  assert.equal(checkStay('', '', '2026-11-04', { defaultCheckIn: '2026-11-09' }).checkIn, '2026-11-04', 'never more than a day off');
});

test('guest names: a first and a last name; titles and stand-in words are not names', () => {
  for (const bad of ['Mr. Smith', 'Mrs Miller', 'Dr. Chen', 'Guest', 'test', 'Test User', 'my wife', 'John Doe', 'Anonymous', 'Me Myself']) {
    assert.equal(guestNameProblem(bad), 'placeholder', bad);
  }
  for (const bad of ['S', 'x'.repeat(61), 'Sarah <script>', '4155550123', 'N/A', '', '  ']) assert.equal(guestNameProblem(bad), 'format', bad);
  for (const one of ['Sarah', 'Cher']) assert.equal(guestNameProblem(one), 'incomplete', one);
  for (const ok of ['Sarah Miller', 'David Chen', "Liam O'Brien", 'Mary-Kate Olsen', 'José García', 'Mary Ann van der Berg', 'Nguyễn Văn An', 'J. R. Smith']) {
    assert.equal(isValidGuestName(ok), true, ok);
  }
  assert.equal(namePartProblem('Sarah'), null);
  assert.equal(namePartProblem('van der Berg'), null);
  assert.equal(namePartProblem('Mr'), 'placeholder');
  assert.equal(namePartProblem('test'), 'placeholder');
  assert.equal(namePartProblem('S@rah'), 'format');
  assert.deepEqual(splitFullName('  Sarah   Jane Miller '), { firstName: 'Sarah', lastName: 'Jane Miller' });
  assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.equal(fullName({ firstName: ' Sarah ', lastName: 'Miller' }), 'Sarah Miller');
  assert.equal(fullName({}), '');
  assert.equal(maskedGuestName('Sarah Miller'), 'Sarah M.');
  assert.equal(maskedGuestName('Mary Ann van der Berg'), 'Mary B.');
  assert.equal(maskedGuestName('Cher'), 'Cher');
  assert.equal(maskedGuestName(''), 'Guest');
});

test('ids: prefixed ids, order numbers (Eastern date), payment ids, uuid check', () => {
  const a = newId('Q');
  assert.match(a, /^Q[0-9a-f]{16}$/);
  assert.notEqual(a, newId('Q'));
  // 2026-11-05 03:30 UTC is still Nov 4 in New York.
  assert.match(orderNo(new Date('2026-11-05T03:30:00Z')), /^HA20261104\d{6}$/);
  assert.equal(isUuid('3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0a3c'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(undefined), false);
  assert.match(confirmationNo(), /^\d{8}$/);
  assert.match(transactionId('card', new Date('2026-11-04T15:00:00Z')), /^SIMCARD20261104\d{10}$/);
  assert.match(transactionId('apple_pay'), /^SIMAPAY\d{18}$/);
});

test('money: whole dollars from $100, cents below', () => {
  assert.equal(formatUsd(1108), '$1,108');
  assert.equal(formatUsd(1108.4), '$1,108');
  assert.equal(formatUsd(23.5), '$23.50');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(-5), '-$5.00');
  assert.equal(formatUsd('x'), '$0.00');
  assert.equal(cents(0.1 + 0.2), 0.3);
  assert.equal(cents(19.999), 20);
});

test('geo: haversine distance and offsetPoint round-trip', () => {
  // Times Square → the Empire State Building is about 1.1 km.
  const d = distanceM({ lng: -73.9855, lat: 40.7580 }, { lng: -73.9857, lat: 40.7484 });
  assert.ok(d > 1000 && d < 1200, String(d));
  assert.equal(distanceM(null, { lng: 1, lat: 1 }), null);
  assert.equal(distanceM({ lng: -122.4, lat: 37.8 }, { lng: -122.4, lat: 37.8 }), 0);
  const p = offsetPoint({ lng: -118.25, lat: 34.05 }, 1500, 45);
  const back = distanceM({ lng: -118.25, lat: 34.05 }, p);
  assert.ok(Math.abs(back - 1500) < 5, String(back));
});
