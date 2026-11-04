import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayCN, nowCN, addDays, nightsBetween, isValidDate, weekdayCN, toIsoCN, dayOfWeek, monthOf,
  formatDateCN, formatDateTimeCN, stayDates, checkStay, cnTimeMs, earliestCheckIn,
} from '../src/util/dates.js';
import { guestNameProblem, isValidGuestName } from '../src/util/names.js';
import { newId, orderNo, isUuid, confirmationNo, transactionId } from '../src/util/ids.js';
import { distanceM, offsetPoint } from '../src/util/geo.js';

test('todayCN / nowCN use China time regardless of the host time zone', () => {
  // 2026-10-29 17:30 UTC = 2026-10-30 01:30 in Shanghai
  const t = new Date('2026-10-29T17:30:00Z');
  assert.equal(todayCN(t), '2026-10-30');
  assert.deepEqual(nowCN(t), { date: '2026-10-30', time: '01:30', weekday: '周五' });
  assert.equal(todayCN(new Date('2026-10-29T15:59:59Z')), '2026-10-29');
  assert.equal(todayCN(new Date('2026-10-29T16:00:00Z')), '2026-10-30');
});

test('addDays and nightsBetween handle month/year/leap boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(nightsBetween('2026-10-30', '2026-11-01'), 2);
  assert.equal(nightsBetween('2026-11-01', '2026-10-30'), -2);
  assert.throws(() => addDays('2026-13-01', 1), RangeError);
});

test('isValidDate is strict', () => {
  assert.equal(isValidDate('2026-10-30'), true);
  for (const bad of ['2026-02-30', '2026-1-5', '2026/10/30', '20261030', '', null, undefined, 20261030, '2026-10-30T00:00']) {
    assert.equal(isValidDate(bad), false, String(bad));
  }
});

test('weekday helpers', () => {
  assert.equal(weekdayCN('2026-10-30'), '周五');
  assert.equal(weekdayCN('2026-11-01'), '周日');
  assert.equal(dayOfWeek('2026-10-31'), 6);
  assert.equal(monthOf('2026-02-09'), 2);
});

test('toIsoCN builds +08:00 timestamps', () => {
  assert.equal(toIsoCN('2026-10-30', '18:00'), '2026-10-30T18:00:00+08:00');
  assert.equal(Date.parse(toIsoCN('2026-10-30', '18:00')), Date.parse('2026-10-30T10:00:00Z'));
  assert.equal(cnTimeMs('2026-10-30', '00:00'), Date.parse('2026-10-29T16:00:00Z'));
  assert.throws(() => toIsoCN('2026-10-30', '25:00'), RangeError);
});

test('formatting helpers', () => {
  assert.equal(formatDateCN('2026-01-05'), '1月5日');
  assert.equal(formatDateTimeCN('2026-10-29T18:00:00+08:00'), '10月29日 18:00');
  assert.deepEqual(stayDates('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});

test('checkStay defaults and validation messages are Chinese', () => {
  assert.deepEqual(checkStay(undefined, undefined, '2026-10-25'), { checkIn: '2026-10-25', checkOut: '2026-10-26', nights: 1, datesAssumed: true });
  assert.deepEqual(checkStay('2026-10-30', '', '2026-10-25'), { checkIn: '2026-10-30', checkOut: '2026-10-31', nights: 1, datesAssumed: true });
  assert.deepEqual(checkStay('2026-10-30', '2026-11-01', '2026-10-25'), { checkIn: '2026-10-30', checkOut: '2026-11-01', nights: 2, datesAssumed: false });
  assert.match(checkStay('2026-10-24', '2026-10-25', '2026-10-25').error, /已经过去/);
  assert.match(checkStay('2026-10-30', '2026-10-30', '2026-10-25').error, /晚于/);
  assert.match(checkStay('2026-10-30', '2026-12-30', '2026-10-25').error, /30晚/);
  assert.match(checkStay('2027-12-30', '2027-12-31', '2026-10-25').error, /365天/);
  assert.match(checkStay('明天', '', '2026-10-25').error, /YYYY-MM-DD/);
  assert.match(checkStay('', '', '2026-10-25', { allowDefaults: false }).error, /入住日期/);
});

test('earliestCheckIn: yesterday until 06:00 China time (凌晨入住), today afterwards', () => {
  assert.equal(earliestCheckIn(new Date('2026-10-26T00:00:00+08:00')), '2026-10-25');
  assert.equal(earliestCheckIn(new Date('2026-10-26T05:59:00+08:00')), '2026-10-25');
  assert.equal(earliestCheckIn(new Date('2026-10-26T06:00:00+08:00')), '2026-10-26');
  assert.equal(earliestCheckIn(new Date('2026-10-26T23:59:00+08:00')), '2026-10-26');
  assert.equal(earliestCheckIn(new Date('2026-10-25T17:30:00Z')), '2026-10-25', 'host time zone does not matter');
});

test('checkStay honours an earliestCheckIn floor and defaults to it', () => {
  const opts = { earliestCheckIn: '2026-10-25' };
  assert.deepEqual(checkStay('2026-10-25', '2026-10-26', '2026-10-26', opts), { checkIn: '2026-10-25', checkOut: '2026-10-26', nights: 1, datesAssumed: false });
  assert.deepEqual(checkStay('', '', '2026-10-26', opts), { checkIn: '2026-10-25', checkOut: '2026-10-26', nights: 1, datesAssumed: true });
  const err = checkStay('2026-10-24', '2026-10-25', '2026-10-26', opts).error;
  assert.match(err, /已经过去/);
  assert.match(err, /凌晨入住/);
  assert.doesNotMatch(checkStay('2026-10-24', '2026-10-25', '2026-10-25', { earliestCheckIn: '2026-10-25' }).error, /凌晨/);
  assert.match(checkStay('2026-10-25', '2026-10-26', '2026-10-26').error, /已经过去/, 'no floor → today');
  assert.equal(checkStay('2026-10-26', '', '2026-10-26', { earliestCheckIn: '2026-10-27' }).checkIn, '2026-10-26', 'a floor after today is ignored');
});

test('guest names: honorifics and stand-in words are not names', () => {
  for (const bad of ['张先生', '王女士', '李小姐', '陈太太', '本人', '客人', '我自己', '用户', 'test', 'Test', '测试', '测试用户', 'guest', '张某', 'Mr Zhang', 'Mrs. Li']) {
    assert.equal(guestNameProblem(bad), 'placeholder', bad);
  }
  for (const bad of ['李', 'x'.repeat(21), '张三<script>', '13812345678']) assert.equal(guestNameProblem(bad), 'format', bad);
  for (const ok of ['张三', '李四', '欧阳娜娜', 'Li Wei', 'John Smith', '阿依古丽·买买提', '王小明']) assert.equal(isValidGuestName(ok), true, ok);
});

test('ids: prefixed ids, order numbers, uuid check', () => {
  const a = newId('Q');
  assert.match(a, /^Q[0-9a-f]{16}$/);
  assert.notEqual(a, newId('Q'));
  assert.match(orderNo(new Date('2026-10-29T17:30:00Z')), /^HA20261030\d{6}$/);
  assert.equal(isUuid('3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0a3c'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(undefined), false);
  assert.match(confirmationNo(), /^\d{8}$/);
  assert.match(transactionId('wechat', new Date('2026-10-25T02:00:00Z')), /^SIMWX20261025\d{10}$/);
  assert.match(transactionId('alipay'), /^SIMALI\d{18}$/);
});

test('geo: haversine distance and offsetPoint round-trip', () => {
  // 外滩 → 东方明珠 is roughly 900 m across the river.
  const d = distanceM({ lng: 121.4903, lat: 31.2400 }, { lng: 121.4998, lat: 31.2397 });
  assert.ok(d > 800 && d < 1000, String(d));
  assert.equal(distanceM(null, { lng: 1, lat: 1 }), null);
  assert.equal(distanceM({ lng: 120, lat: 30 }, { lng: 120, lat: 30 }), 0);
  const p = offsetPoint({ lng: 120.15, lat: 30.25 }, 1500, 45);
  const back = distanceM({ lng: 120.15, lat: 30.25 }, p);
  assert.ok(Math.abs(back - 1500) < 5, String(back));
});
