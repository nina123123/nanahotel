import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createPlacesService } from '../src/services/places.js';
import { HotelError } from '../src/services/hotels/index.js';
import { generateHotels } from '../src/services/hotels/sim-hotels.js';
import { findCity } from '../src/services/hotels/sim-cities.js';
import { lowestNightly } from '../src/services/hotels/pricing.js';

const supplier = createSimSupplier();
const NOW = new Date('2026-10-25T10:00:00+08:00');
const places = createPlacesService({ supplier, clock: { now: () => NOW } });

test('searchPlaces returns guide entries with the spec fields', () => {
  const res = places.searchPlaces({ city: '杭州', keyword: '西湖' });
  assert.ok(res.length > 0);
  const [first] = res;
  assert.equal(first.name, '西湖');
  assert.equal(first.type, '景点');
  assert.equal(first.area, '湖滨');
  assert.ok(first.location && Number.isFinite(first.location.lng));
  assert.ok(first.nearbyHotelCount > 0);
  for (const p of res) for (const k of ['name', 'area', 'type', 'location', 'nearbyHotelCount']) assert.ok(k in p, k);
});

test('searchPlaces: aliases, generic words and limits', () => {
  assert.equal(places.searchPlaces({ city: '西安', keyword: '兵马俑' })[0].name, '秦始皇帝陵博物院');
  assert.equal(places.searchPlaces({ city: '成都', keyword: '熊猫' })[0].name, '成都大熊猫繁育研究基地');
  const stations = places.searchPlaces({ city: '杭州', keyword: '火车站' }).map((p) => p.name);
  assert.ok(stations.includes('杭州东站') && stations.includes('杭州站'), stations.join());
  assert.ok(places.searchPlaces({ city: '杭州', keyword: '机场' }).some((p) => p.name === '杭州萧山国际机场'));
  assert.ok(places.searchPlaces({ city: '西安', keyword: '小吃' }).some((p) => p.name === '回民街'));
  assert.ok(places.searchPlaces({ city: '北京', keyword: '博物馆' }).some((p) => p.name === '故宫博物院'));
  assert.ok(places.searchPlaces({ city: '杭州', keyword: '西湖附近' }).some((p) => p.name === '西湖'));
  assert.equal(places.searchPlaces({ city: '杭州', keyword: '西湖', limit: 2 }).length, 2);
  assert.deepEqual(places.searchPlaces({ city: '杭州', keyword: '火星基地' }), []);
});

test('searchPlaces without a keyword lists the areas (商圈) with reasons', () => {
  const res = places.searchPlaces({ city: '三亚', limit: 20 });
  assert.equal(res.length, findCity('三亚').areas.length);
  assert.ok(res.every((p) => p.type === '商圈' && p.reason));
});

test('listAreas: 住哪儿 advice with landmarks, hotel counts and 参考起价', () => {
  const areas = places.listAreas('杭州');
  const city = findCity('杭州');
  const hotels = generateHotels(city);
  assert.equal(areas.length, city.areas.length);
  assert.equal(areas.reduce((s, a) => s + a.hotelCount, 0), hotels.length);
  const hubin = areas.find((a) => a.name === '湖滨');
  assert.deepEqual(hubin.landmarks, ['西湖', '断桥残雪', '湖滨银泰in77', '杭州站']);
  assert.equal(hubin.reason, '步行到西湖、晚上逛湖滨，贵但方便');
  assert.equal(hubin.priceFrom, Math.min(...hotels.filter((h) => h.businessArea === '湖滨').map((h) => h.priceHint)));
  for (const a of areas) for (const k of ['name', 'landmarks', 'hotelCount', 'priceFrom', 'district', 'reason', 'location']) assert.ok(k in a, k);
  assert.ok(areas.every((a) => a.priceBasis === 'weekday'), 'a dateless 起价 says it is the weekday price');
});

test('listAreas with dates prices the stay (season and holidays included)', () => {
  const sy = findCity('三亚');
  const yalong = generateHotels(sy).filter((h) => h.businessArea === '亚龙湾');
  const springFestival = places.listAreas('三亚', { checkIn: '2027-02-06', checkOut: '2027-02-07' }).find((a) => a.name === '亚龙湾');
  const weekday = places.listAreas('三亚').find((a) => a.name === '亚龙湾');
  const expected = Math.min(...yalong.map((h) => lowestNightly(h, { checkIn: '2027-02-06', checkOut: '2027-02-07', city: supplier.resolveCity('三亚'), now: NOW })).filter(Number.isFinite));
  assert.equal(springFestival.priceFrom, expected);
  assert.ok(springFestival.priceFrom > weekday.priceFrom * 1.5, `${springFestival.priceFrom} vs ${weekday.priceFrom}`);
  assert.deepEqual([springFestival.priceBasis, springFestival.checkIn, springFestival.checkOut], ['dates', '2027-02-06', '2027-02-07']);
  assert.equal(places.listAreas('三亚', { checkIn: '2027-02-06' })[0].checkOut, '2027-02-07', 'one night by default');
  assert.throws(() => places.listAreas('三亚', { checkIn: '2027-02-07', checkOut: '2027-02-06' }), (e) => e instanceof HotelError && e.code === 'invalid_dates');
  assert.throws(() => places.listAreas('三亚', { checkIn: '2026-10-01', checkOut: '2026-10-02' }), (e) => e.code === 'invalid_dates');
});

test('landmarks carry their own 区 when it differs from their area', () => {
  const cases = [
    ['广州', '广州塔', '海珠区'], ['北京', '南锣鼓巷', '东城区'], ['杭州', '雷峰塔', '西湖区'], ['杭州', '断桥', '西湖区'],
    ['上海', '国家会展中心', '青浦区'], ['西安', '回民街', '莲湖区'], ['成都', '望江楼', '武侯区'], ['武汉', '汉口江滩', '江岸区'],
    ['广州', '陈家祠', '荔湾区'], ['北京', '故宫', '东城区'],
  ];
  for (const [city, keyword, district] of cases) assert.equal(places.searchPlaces({ city, keyword, limit: 1 })[0].district, district, `${city} ${keyword}`);
  assert.equal(places.searchPlaces({ city: '广州', keyword: '陈家祠', limit: 1 })[0].area, '上下九/沙面');
  const tower = supplier.listAreas('广州').flatMap((a) => a.landmarks).find((l) => l.name === '广州塔');
  assert.equal(tower.district, '海珠区');
});

test('unsupported city → HotelError city_not_supported; missing city → city_required', () => {
  assert.throws(() => places.searchPlaces({ city: '拉萨', keyword: '布达拉宫' }), (e) => e instanceof HotelError && e.code === 'city_not_supported' && /演示版暂时只覆盖/.test(e.message));
  assert.throws(() => places.listAreas('火星'), (e) => e instanceof HotelError && e.code === 'city_not_supported');
  assert.throws(() => places.listAreas(''), (e) => e instanceof HotelError && e.code === 'city_required');
});

test('works with a supplier that has no city guide', () => {
  const bare = { ...supplier, listAreas: undefined };
  const p = createPlacesService({ supplier: bare });
  assert.deepEqual(p.searchPlaces({ city: '杭州', keyword: '西湖' }), []);
  assert.deepEqual(p.listAreas('杭州'), []);
  assert.throws(() => createPlacesService({}), /supplier/);
});
