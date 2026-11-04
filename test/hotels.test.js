import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, findCity } from '../src/services/hotels/sim-cities.js';
import { generateHotels, hashString, mulberry32, BRAND_STEMS } from '../src/services/hotels/sim-hotels.js';
import { buildRoomOffer } from '../src/services/hotels/pricing.js';
import { createSimSupplier } from '../src/services/hotels/sim-supplier.js';
import { createHotelService, HotelError, CATEGORY_LABELS } from '../src/services/hotels/index.js';
import { parseKeyword, hotelMatchesKeyword, normalizeCategory } from '../src/services/hotels/supplier.js';
import { BookingError } from '../src/services/bookings.js';
import { distanceM } from '../src/util/geo.js';
import { addDays } from '../src/util/dates.js';

const NOW = new Date('2026-10-25T10:00:00+08:00'); // a Sunday
const clock = { now: () => NOW };
const supplier = createSimSupplier();
const hotels = createHotelService({ supplier, clock });

const REAL_BRANDS = [
  '汉庭', '如家', '7天', '七天', '全季', '亚朵', '桔子', '麗枫', '丽枫', '维也纳', '锦江', '华住', '洲际', '万豪', '希尔顿', '凯悦',
  '香格里拉', '喜来登', '威斯汀', '丽思', '四季', '半岛', '文华东方', '柏悦', '安缦', '悦榕', '君悦', '皇冠假日', '假日', '智选',
  '宜必思', '格林豪泰', '城市便捷', '尚客优', '莫泰', '速8', '布丁', '星程', '漫心', '美居', '美豪', '开元', '君澜', '花间堂', '松赞',
  '途家', '隐居', '朗廷', '瑰丽', '宝格丽', '艾迪逊', '英迪格', '逸林', '欢朋', '希岸', '喆啡', '宜尚', '丽怡', '康铂', '白玉兰',
  '锦江之星', '海友', '秋果', '和颐', '雅阁', '璞隐', '轻住', '星野', '观澜湖', '枕水', '晴川', '万达', '温德姆', '雅高', '诺富特',
  '铂尔曼', '索菲特', '凯宾斯基', '雅诗阁', '东呈', '城家', '诗莉莉', '宿适', '书香', '金陵饭店', '建国饭店', '康莱德', '万丽',
  '驿居', '如家驿居', '云栖', '永乐半山',
];

const REQUIRED_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '西安', '南京', '苏州', '厦门', '三亚'];

test('city guide: required cities, tiers, 4–8 areas each with real-world fields', () => {
  for (const name of REQUIRED_CITIES) assert.ok(findCity(name), name);
  assert.ok(CITIES.length >= 12);
  const codes = new Set();
  for (const c of CITIES) {
    assert.ok(!codes.has(c.code), `duplicate code ${c.code}`);
    codes.add(c.code);
    assert.ok(['tier1', 'new_tier1', 'tourist', 'tier2'].includes(c.tier), c.name);
    assert.equal(c.fullName, `${c.name}市`);
    assert.ok(c.aliases.includes(`${c.name}市`), `${c.name} alias 市`);
    assert.ok(c.areas.length >= 4 && c.areas.length <= 8, `${c.name} has ${c.areas.length} areas`);
    if (c.season) assert.equal(c.season.length, 12);
    for (const a of c.areas) {
      assert.ok(a.name && a.district && a.reason && a.reason.length >= 8, `${c.name}/${a.name}`);
      assert.ok(a.landmarks.length >= 1 && a.landmarks.length <= 6, `${c.name}/${a.name} landmarks`);
      for (const p of [a.center, ...a.landmarks.map((l) => l.location)]) {
        assert.ok(p.lng > 98 && p.lng < 123 && p.lat > 18 && p.lat < 41, `${c.name}/${a.name} coords in China`);
      }
      assert.ok(distanceM(a.center, c.center) < 45000, `${c.name}/${a.name} near its city`);
      for (const l of a.landmarks) {
        assert.ok(l.name && l.type, `${a.name} landmark`);
        assert.ok(distanceM(l.location, a.center) < 16000, `${l.name} close to ${a.name}`);
      }
    }
  }
  assert.equal(findCity('杭州').tier, 'new_tier1');
  assert.equal(findCity('上海').tier, 'tier1');
  for (const n of ['三亚', '丽江', '厦门']) assert.equal(findCity(n).tier, 'tourist');
});

test('PRNG and hash are deterministic', () => {
  assert.equal(hashString('sim-hz-001'), hashString('sim-hz-001'));
  assert.notEqual(hashString('sim-hz-001'), hashString('sim-hz-002'));
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('generated hotels: 15–30 per city, every Hotel field filled, stable ids', () => {
  for (const c of CITIES) {
    const list = generateHotels(c);
    assert.ok(list.length >= 15 && list.length <= 30, `${c.name}: ${list.length}`);
    assert.deepEqual(generateHotels(c), list, `${c.name} deterministic`);
    const names = new Set();
    list.forEach((h, i) => {
      assert.equal(h.id, `sim-${c.code}-${String(i + 1).padStart(3, '0')}`);
      assert.ok(!names.has(h.name), `duplicate name ${h.name}`);
      names.add(h.name);
      assert.equal(h.city, c.fullName);
      assert.equal(h.source, 'sim');
      assert.ok(Object.isFrozen(h));
      assert.match(h.address, /（模拟地址）$/);
      assert.ok(h.address.startsWith(h.district));
      assert.ok(['economy', 'comfort', 'premium', 'luxury'].includes(h.category));
      assert.ok(h.rating >= 4.0 && h.rating <= 4.9 && Math.round(h.rating * 10) === h.rating * 10, `${h.id} rating ${h.rating}`);
      assert.ok(Number.isInteger(h.reviewCount) && h.reviewCount > 0);
      assert.ok(h.openedYear >= 2005 && h.openedYear <= 2025);
      assert.ok(Array.isArray(h.amenities) && h.amenities.length >= 3);
      assert.ok(Array.isArray(h.tags) && h.tags.length >= 1 && h.tags.length <= 4, `${h.id} tags`);
      assert.deepEqual(h.photos, []);
      assert.ok(Number.isInteger(h.priceHint) && h.priceHint > 0);
      assert.ok(h.tel === '' || /^0\d{2,3}-0000\d{4}$/.test(h.tel), h.tel);
      const area = c.areas.find((a) => a.name === h.businessArea);
      assert.ok(area, `${h.id} businessArea`);
      assert.equal(h.district, area.district);
      const d = distanceM(h.location, area.center);
      assert.ok(d >= 140 && d <= area.spreadM + 20, `${h.id} ${d}m from ${area.name}`);
    });
  }
});

test('hotel names are fictional: none contain a real hotel brand', () => {
  for (const c of CITIES) {
    for (const h of generateHotels(c)) {
      for (const brand of REAL_BRANDS) assert.ok(!h.name.includes(brand), `${h.name} contains ${brand}`);
    }
  }
  for (const stem of ['驿居', '云栖', '半山']) assert.ok(!BRAND_STEMS.includes(stem), `${stem} is (close to) a real chain`);
});

test('no name reads like an official on-site hotel of a trademarked park (迪士尼, 长隆, 华侨城)', () => {
  for (const c of CITIES) {
    for (const h of generateHotels(c)) assert.ok(!/^(上海|广州|深圳)?(迪士尼|长隆|华侨城|欢乐谷|世界之窗)/.test(h.name), h.name);
  }
});

test('no brand stem appears twice in one area (no near-duplicate listings)', () => {
  for (const c of CITIES) {
    const seen = new Map();
    for (const h of generateHotels(c)) {
      for (const stem of BRAND_STEMS.filter((b) => h.name.includes(b))) {
        const key = `${h.businessArea}|${stem}`;
        assert.ok(!seen.has(key), `${c.name}/${h.businessArea}: ${seen.get(key)} and ${h.name} share ${stem}`);
        seen.set(key, h.name);
      }
    }
  }
  const r = hotels.searchHotels({ city: '西安', near: '钟楼', checkIn: '2026-11-10' });
  const stems = r.hotels.flatMap((h) => BRAND_STEMS.filter((b) => h.name.includes(b)));
  assert.equal(new Set(stems).size, stems.length, r.hotels.map((h) => h.name).join(' | '));
});

test('inn-style hotels (民宿/客栈/院子) have no hotel-only amenities', () => {
  let n = 0;
  for (const c of CITIES) {
    for (const h of generateHotels(c)) {
      const area = c.areas.find((a) => a.name === h.businessArea);
      if (area.kind !== 'inn' || h.category === 'luxury') continue;
      n++;
      for (const a of ['机器人送物', '会议室', '室内泳池', '健身房', '24小时前台']) assert.ok(!h.amenities.includes(a), `${h.id} ${h.name} has ${a}`);
      assert.ok(!h.tags.includes('带泳池'), `${h.id} tagged 带泳池`);
    }
  }
  assert.ok(n >= 20, String(n));
  const r = hotels.searchHotels({ city: '北京', near: '什刹海', keyword: '泳池', checkIn: '2026-11-10' });
  for (const h of r.hotels) if (/民宿|客栈|院子|小院/.test(h.name)) assert.deepEqual(h.matchedKeywords, [], h.name);
});

test('car-free 鼓浪屿 offers no parking', () => {
  const xm = generateHotels(findCity('厦门')).filter((h) => h.businessArea === '鼓浪屿');
  assert.ok(xm.length >= 3);
  for (const h of xm) assert.ok(![...h.amenities, ...h.tags].some((x) => /停车/.test(x)), `${h.name}: ${h.amenities.join()}`);
  const r = hotels.searchHotels({ city: '厦门', near: '鼓浪屿', keyword: '能停车', checkIn: '2026-11-10', limit: 10 });
  for (const h of r.hotels) if (h.businessArea === '鼓浪屿') assert.deepEqual(h.matchedKeywords, [], h.name);
  assert.ok(r.hotels.some((h) => h.matchedKeywords.includes('停车')), 'mainland hotels still match 停车');
  assert.notEqual(r.hotels[0].businessArea, '鼓浪屿');
});

test('canals and the 秦淮河 give 河景, never 江景', () => {
  const suz = findCity('苏州');
  const nj = findCity('南京');
  const canalHotels = [...generateHotels(suz), ...generateHotels(nj).filter((h) => h.businessArea === '夫子庙/老门东')];
  let river = 0;
  for (const h of canalHotels) {
    assert.ok(!h.tags.includes('江景房'), `${h.id} ${h.name}`);
    const names = buildRoomOffer(h, { checkIn: '2026-11-10', checkOut: '2026-11-11' }).roomTypes.map((r) => r.name);
    assert.ok(!names.some((n) => n.startsWith('江景')), `${h.id}: ${names.join()}`);
    if (h.tags.includes('河景房')) {
      river++;
      assert.ok(names.some((n) => n.startsWith('河景')), `${h.id}: ${names.join()}`);
    }
  }
  assert.ok(river >= 1);
  const r = hotels.searchHotels({ city: '苏州', near: '平江路', keyword: '河景', checkIn: '2026-11-10' });
  assert.ok(r.hotels[0].matchedKeywords.includes('河景'), r.hotels.map((h) => h.name).join());
  assert.ok(!r.notes.some((n) => n.includes('没有找到')), r.notes.join('|'));
  assert.ok(generateHotels(findCity('上海')).some((h) => h.tags.includes('江景房')), '黄浦江 still gives 江景房');
});

test('far places are not passed off as near: 熊猫谷 (都江堰) and 崂山', () => {
  assert.equal(supplier.resolveLandmark('成都', '熊猫谷'), null);
  const panda = hotels.searchHotels({ city: '成都', near: '熊猫谷', checkIn: '2026-10-30', checkOut: '2026-10-31' });
  assert.ok(panda.notes.some((n) => n.includes('没找到「熊猫谷」')), panda.notes.join('|'));
  for (const near of ['崂山', '崂山风景区']) {
    const r = hotels.searchHotels({ city: '青岛', near, checkIn: '2026-10-30', checkOut: '2026-10-31' });
    assert.equal(r.landmark.name, '崂山风景区', near);
    assert.ok(r.hotels.length > 0 && r.hotels.every((h) => h.distanceM > 5000), r.hotels.map((h) => h.distanceM).join());
    assert.ok(r.notes.length > 0, 'the wider radius is explained');
  }
  assert.equal(supplier.resolveCity('崂山').name, '青岛');
});

test('北京 central-axis landmarks share one datum (GCJ-02)', () => {
  const bj = findCity('北京');
  const lm = (name) => bj.areas.flatMap((a) => a.landmarks).find((l) => l.name === name).location;
  const axis = lm('故宫博物院').lng;
  for (const name of ['天安门广场', '前门大街', '鼓楼']) assert.ok(Math.abs(lm(name).lng - axis) < 0.002, `${name} ${lm(name).lng} vs ${axis}`);
});

test('category mix follows the area: scenic/CBD/beach skew upscale, stations/airports skew budget', () => {
  const rank = { economy: 0, comfort: 1, premium: 2, luxury: 3 };
  const avgRank = (kinds) => {
    const xs = CITIES.flatMap((c) => generateHotels(c).filter((h) => kinds.includes(c.areas.find((a) => a.name === h.businessArea).kind)).map((h) => rank[h.category]));
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  assert.ok(avgRank(['scenic', 'cbd', 'beach']) > avgRank(['station', 'airport']) + 0.8);
  for (const c of CITIES) {
    const cats = new Set(generateHotels(c).map((h) => h.category));
    assert.ok(cats.size >= 3, `${c.name} has a category mix`);
  }
  const stationLuxury = CITIES.flatMap((c) => generateHotels(c).filter((h) => h.category === 'luxury' && ['station', 'airport'].includes(c.areas.find((a) => a.name === h.businessArea).kind)));
  assert.equal(stationLuxury.length, 0);
});

test('supplier.resolveCity is tolerant', () => {
  for (const t of ['杭州', '杭州市', 'hz', 'Hangzhou', ' HANGZHOU ', '去杭州玩', '杭州西湖']) assert.equal(supplier.resolveCity(t)?.name, '杭州', t);
  assert.equal(supplier.resolveCity('sz').name, '深圳');
  assert.equal(supplier.resolveCity('suzhou').name, '苏州');
  assert.equal(supplier.resolveCity('魔都').name, '上海');
  assert.equal(supplier.resolveCity('鼓浪屿').name, '厦门', 'a unique landmark identifies its city');
  assert.equal(supplier.resolveCity('外滩').name, '上海');
  assert.equal(supplier.resolveCity('拉萨'), null);
  assert.equal(supplier.resolveCity(''), null);
  // Street names that contain another city's name: '广州北京路' is 广州, '长安街' is not 西安.
  assert.equal(supplier.resolveCity('广州北京路').name, '广州');
  assert.equal(supplier.resolveCity('广州北京路步行街').name, '广州');
  assert.equal(supplier.resolveCity('北京路').name, '广州');
  assert.equal(supplier.resolveCity('南京东路').name, '上海');
  assert.equal(supplier.resolveCity('上海南京路').name, '上海');
  assert.equal(supplier.resolveCity('北京长安街').name, '北京');
  assert.notEqual(supplier.resolveCity('长安街')?.name, '西安');
  assert.equal(supplier.resolveCity('长安').name, '西安');
  const hz = supplier.resolveCity('杭州');
  assert.deepEqual(Object.keys(hz).sort(), ['center', 'code', 'fullName', 'name', 'season', 'tier']);
  assert.deepEqual(supplier.listCities().find((c) => c.name === '三亚'), { name: '三亚', tier: 'tourist' });
});

test('supplier.resolveLandmark: required aliases resolve to the right real place', () => {
  const cases = [
    ['杭州', '西湖边', '西湖'], ['杭州', '灵隐寺', '灵隐寺'], ['上海', '外滩', '外滩'], ['上海', '迪士尼', '上海迪士尼乐园'],
    ['成都', '春熙路', '春熙路'], ['成都', '宽窄巷子', '宽窄巷子'], ['西安', '兵马俑', '秦始皇帝陵博物院'], ['厦门', '鼓浪屿', '鼓浪屿'],
    ['三亚', '亚龙湾', '亚龙湾'], ['杭州', '断桥', '断桥残雪'], ['杭州', '杭州东站附近', '杭州东站'], ['杭州', '离西湖近一点', '西湖'],
    ['杭州', '城站', '杭州站'], ['杭州', '西湖边的酒店', '西湖'], ['杭州', '杭州西湖', '西湖'], ['北京', '故宫', '故宫博物院'],
    ['北京', '天安门', '天安门广场'], ['北京', '北京南站', '北京南站'], ['上海', '虹桥机场', '虹桥机场T2航站楼'],
    ['广州', '小蛮腰', '广州塔'], ['深圳', '世界之窗', '世界之窗'], ['重庆', '洪崖洞', '洪崖洞'], ['南京', '夫子庙', '夫子庙'],
    ['苏州', '拙政园', '拙政园'], ['青岛', '栈桥', '栈桥'], ['长沙', '橘子洲头', '橘子洲'], ['武汉', '黄鹤楼', '黄鹤楼'], ['丽江', '古城', '丽江古城'],
  ];
  for (const [city, text, expected] of cases) {
    const lm = supplier.resolveLandmark(city, text);
    assert.equal(lm?.name, expected, `${city} ${text}`);
    assert.ok(lm.location && Number.isFinite(lm.location.lng));
    assert.equal(typeof lm.area, 'string');
  }
  assert.equal(supplier.resolveLandmark('杭州', '湖滨').type, '商圈');
  assert.equal(supplier.resolveLandmark('杭州', '湖滨路').matched, 'partial');
  assert.equal(supplier.resolveLandmark('杭州', '外滩'), null, '外滩 is not in 杭州');
  assert.equal(supplier.resolveLandmark('杭州', '火星'), null);
  assert.equal(supplier.resolveLandmark('杭州', '杭州'), null, 'the city itself is not a landmark');
  assert.equal(supplier.resolveLandmark('杭州', '杭州市区'), null);
  assert.equal(supplier.resolveLandmark('拉萨', '布达拉宫'), null);
});

test('supplier.searchHotels filters by radius, categories and keyword; getHotel round-trips', () => {
  const west = supplier.resolveLandmark('杭州', '西湖');
  const near = supplier.searchHotels({ city: '杭州', location: west.location, radiusM: 2000 });
  assert.ok(near.length > 0);
  assert.ok(near.every((h) => distanceM(h.location, west.location) <= 2000));
  const lux = supplier.searchHotels({ city: '杭州', categories: ['luxury'] });
  assert.ok(lux.length && lux.every((h) => h.category === 'luxury'));
  const family = supplier.searchHotels({ city: '杭州', keyword: '亲子' });
  assert.ok(family.length && family.every((h) => hotelMatchesKeyword(h, ['亲子'])));
  assert.deepEqual(supplier.searchHotels({ city: '拉萨' }), []);
  const h = supplier.searchHotels({ city: '杭州' })[3];
  assert.equal(supplier.getHotel(h.id), h);
  assert.equal(supplier.getHotel('sim-hz-999'), null);
  assert.equal(supplier.getHotel('sim-xx-001'), null);
  assert.equal(supplier.getHotel('nope'), null);
});

test('keyword parsing: 和 separates wishes but not words', () => {
  assert.deepEqual(parseKeyword('亲子和泳池').tokens, ['亲子', '泳池']);
  assert.deepEqual(parseKeyword('温和').tokens, ['温和']);
  assert.deepEqual(parseKeyword('临河').tokens, ['河景']);
});

test('keyword parsing: stop words, prefixes, synonyms and category words', () => {
  assert.deepEqual(parseKeyword('亲子 带泳池的酒店'), { tokens: ['亲子', '泳池'], categories: [] });
  assert.deepEqual(parseKeyword('五星，江景'), { tokens: ['江景'], categories: ['luxury'] });
  assert.deepEqual(parseKeyword('经济型'), { tokens: [], categories: ['economy'] });
  assert.deepEqual(parseKeyword('含早 带娃'), { tokens: ['含早', '亲子'], categories: [] });
  assert.deepEqual(parseKeyword('杭州 安静', { ignore: ['杭州'] }), { tokens: ['安静'], categories: [] });
  assert.equal(normalizeCategory('豪华型'), 'luxury');
  assert.equal(normalizeCategory('premium'), 'premium');
  assert.equal(normalizeCategory('随便'), null);
});

test('searchHotels: unsupported / missing city errors are typed and Chinese', () => {
  assert.throws(() => hotels.searchHotels({ city: '拉萨' }), (err) => {
    assert.ok(err instanceof HotelError);
    assert.equal(err.code, 'city_not_supported');
    assert.match(err.message, /^演示版暂时只覆盖：北京、上海、广州、深圳、杭州/);
    assert.match(err.message, /拉萨/);
    return true;
  });
  assert.throws(() => hotels.searchHotels({}), (err) => err instanceof HotelError && err.code === 'city_required');
});

test('凌晨入住: before 06:00 the night in progress (yesterday\'s date) is bookable and is the default', () => {
  const at = (iso) => createHotelService({ supplier, clock: { now: () => new Date(iso) } });
  const late = at('2026-10-26T01:30:00+08:00');
  const r = late.searchHotels({ city: '杭州' });
  assert.deepEqual([r.query.checkIn, r.query.checkOut], ['2026-10-25', '2026-10-26']);
  assert.ok(r.notes.some((n) => n.includes('凌晨') && n.includes('今晚')), r.notes.join('|'));
  assert.equal(late.searchHotels({ city: '杭州', checkIn: '2026-10-25', checkOut: '2026-10-26' }).query.checkIn, '2026-10-25');
  assert.equal(late.priceCheck({ hotelId: 'sim-hz-001', rateId: 'R1-BF0-NR', checkIn: '2026-10-25', checkOut: '2026-10-26' }).rate.rateId, 'R1-BF0-NR');
  assert.throws(() => late.searchHotels({ city: '杭州', checkIn: '2026-10-24', checkOut: '2026-10-25' }), (e) => e.code === 'invalid_dates' && /凌晨/.test(e.message));
  const morning = at('2026-10-26T06:30:00+08:00');
  assert.equal(morning.searchHotels({ city: '杭州' }).query.checkIn, '2026-10-26');
  assert.throws(() => morning.searchHotels({ city: '杭州', checkIn: '2026-10-25', checkOut: '2026-10-26' }), (e) => e.code === 'invalid_dates');
});

test('searchHotels: a party that does not fit is not 满房 (fitsParty / needRooms), children count as occupants', () => {
  const r = hotels.searchHotels({ city: '成都', near: '春熙路', checkIn: '2026-10-25', checkOut: '2026-10-26', adults: 3, categories: ['economy'] });
  assert.ok(r.hotels.length > 0);
  assert.ok(!r.notes.some((n) => n.includes('都满房了')), r.notes.join('|'));
  assert.ok(r.notes.some((n) => n.includes('2间') && n.includes('3位成人')), r.notes.join('|'));
  for (const h of r.hotels) {
    if (h.lowestPrice !== null) continue;
    assert.equal(h.fitsParty, false, h.id);
    assert.equal(h.needRooms, 2);
    assert.equal(h.maxOccupancy, 2);
  }
  const kids = hotels.searchHotels({ city: '成都', near: '春熙路', checkIn: '2026-10-25', checkOut: '2026-10-26', adults: 2, children: 1, categories: ['economy'] });
  assert.equal(kids.query.children, 1);
  assert.deepEqual(kids.hotels.map((h) => [h.id, h.lowestPrice, h.fitsParty]), r.hotels.map((h) => [h.id, h.lowestPrice, h.fitsParty]));
  assert.ok(kids.notes.some((n) => n.includes('1名儿童')), kids.notes.join('|'));
  const two = hotels.searchHotels({ city: '成都', near: '春熙路', checkIn: '2026-10-25', checkOut: '2026-10-26', adults: 2, children: 1, rooms: 2, categories: ['economy'] });
  assert.ok(two.hotels.every((h) => h.fitsParty), 'two rooms fit');
  const four = hotels.searchHotels({ city: '上海', near: '外滩', checkIn: '2026-11-10', adults: 4, rooms: 1 });
  assert.ok(!four.notes.some((n) => n.includes('都满房了')), four.notes.join('|'));
  assert.equal(hotels.searchHotels({ city: '杭州' }).query.children, 0);
  assert.throws(() => hotels.priceCheck({ hotelId: 'sim-hz-001', rateId: 'R1-BF0-NR', checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 2, children: 1 }), (e) => e.code === 'too_many_guests' && /1名儿童/.test(e.message));
  const { offer } = hotels.getRoomOffer({ hotelId: 'sim-hz-001', checkIn: '2026-11-10', checkOut: '2026-11-11', adults: 2, children: 1 });
  assert.equal(offer.children, 1);
  assert.ok(offer.roomTypes.every((rt) => rt.maxOccupancy >= 3 || rt.rates.every((x) => x.unavailableReason === 'occupancy')));
});

test('searchHotels: dates default to tonight → tomorrow and are validated', () => {
  const r = hotels.searchHotels({ city: '杭州' });
  assert.equal(r.query.checkIn, '2026-10-25');
  assert.equal(r.query.checkOut, '2026-10-26');
  assert.equal(r.query.nights, 1);
  assert.equal(r.query.datesAssumed, true);
  assert.ok(r.notes.some((n) => n.includes('今晚')));
  assert.equal(r.demo, true);

  const given = hotels.searchHotels({ city: '杭州', checkIn: '2026-10-30', checkOut: '2026-11-01' });
  assert.equal(given.query.datesAssumed, false);
  assert.equal(given.query.nights, 2);

  for (const [ci, co, re] of [['2026-10-24', '2026-10-25', /已经过去/], ['2026-10-30', '2026-10-29', /晚于/], ['2026-11-30', '2027-01-30', /30晚/], ['下周五', '', /格式/]]) {
    assert.throws(() => hotels.searchHotels({ city: '杭州', checkIn: ci, checkOut: co }), (err) => err instanceof HotelError && err.code === 'invalid_dates' && re.test(err.message));
  }
});

test('searchHotels: defaults and clamping', () => {
  const r = hotels.searchHotels({ city: 'hangzhou', limit: 50, radiusKm: 100, adults: '3', rooms: 9, sort: 'weird', near: '西湖' });
  assert.equal(r.query.city, '杭州');
  assert.equal(r.query.limit, 10);
  assert.equal(r.query.radiusKm, 20);
  assert.equal(r.query.adults, 3);
  assert.equal(r.query.rooms, 5);
  assert.equal(r.query.sort, 'recommended');
  const d = hotels.searchHotels({ city: '杭州' });
  assert.deepEqual([d.query.adults, d.query.rooms, d.query.radiusKm, d.query.limit], [2, 1, 3, 6]);
  assert.ok(d.hotels.length <= 6);
});

test('searchHotels near a landmark: distances, radius and the result shape', () => {
  const r = hotels.searchHotels({ city: '杭州', near: '西湖边', checkIn: '2026-11-10', checkOut: '2026-11-12', limit: 10 });
  assert.equal(r.landmark.name, '西湖');
  assert.ok(r.totalFound >= r.hotels.length && r.hotels.length > 0);
  for (const h of r.hotels) {
    assert.ok(Number.isInteger(h.distanceM) && h.distanceM <= 3000, `${h.id} ${h.distanceM}`);
    assert.ok(h.lowestPrice === null || Number.isInteger(h.lowestPrice));
    for (const k of ['id', 'name', 'city', 'district', 'address', 'location', 'tel', 'rating', 'reviewCount', 'openedYear', 'amenities', 'category', 'businessArea', 'tags', 'photos', 'priceHint', 'source']) {
      assert.ok(k in h, `hotel.${k}`);
    }
  }
  const byDistance = hotels.searchHotels({ city: '杭州', near: '灵隐寺', sort: 'distance', checkIn: '2026-11-10' });
  const ds = byDistance.hotels.map((h) => h.distanceM);
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
  const noLandmark = hotels.searchHotels({ city: '杭州', sort: 'distance' });
  assert.equal(noLandmark.query.sort, 'recommended');
  assert.ok(noLandmark.hotels.every((h) => h.distanceM === null));
});

test('searchHotels: an unknown `near` falls back to the whole city with a note', () => {
  const r = hotels.searchHotels({ city: '杭州', near: '火星基地' });
  assert.equal(r.landmark, null);
  assert.ok(r.notes.some((n) => n.includes('没找到「火星基地」')));
  assert.ok(r.hotels.length > 0);
});

test('searchHotels: a landmark given as keyword is treated as near', () => {
  const r = hotels.searchHotels({ city: '上海', keyword: '迪士尼' });
  assert.equal(r.landmark?.name, '上海迪士尼乐园');
  assert.ok(r.hotels.every((h) => h.distanceM !== null));
});

test('searchHotels: radius expands with a note when nothing is close enough', () => {
  const r = hotels.searchHotels({ city: '丽江', near: '玉龙雪山', radiusKm: 1 });
  assert.ok(r.hotels.length > 0);
  assert.ok(r.notes.some((n) => /1公里内没有找到合适的，已扩大到\d+公里/.test(n)), r.notes.join('|'));
});

test('searchHotels: categories filter and Chinese category words', () => {
  const r = hotels.searchHotels({ city: '成都', near: '春熙路', categories: ['economy'] });
  assert.ok(r.hotels.length > 0 && r.hotels.every((h) => h.category === 'economy'));
  const zh = hotels.searchHotels({ city: '北京', categories: ['豪华型'] });
  assert.ok(zh.hotels.every((h) => h.category === 'luxury'));
  assert.deepEqual(zh.query.categories, ['luxury']);
  const kw = hotels.searchHotels({ city: '北京', keyword: '五星' });
  assert.ok(kw.hotels.every((h) => h.category === 'luxury'));
});

test('searchHotels: keyword is a soft preference — matches rank first, nothing is dropped, misses get a note', () => {
  const r = hotels.searchHotels({ city: '上海', near: '外滩', keyword: '亲子', checkIn: '2026-10-26', limit: 10 });
  const all = hotels.searchHotels({ city: '上海', near: '外滩', checkIn: '2026-10-26', limit: 10 });
  assert.equal(r.totalFound, all.totalFound, 'no hotel is dropped for a missing preference');
  assert.ok(hotelMatchesKeyword(r.hotels[0], ['亲子']));
  for (const h of r.hotels) assert.deepEqual(h.matchedKeywords, hotelMatchesKeyword(h, ['亲子']) ? ['亲子'] : []);
  const flags = r.hotels.filter((h) => h.lowestPrice !== null).map((h) => h.matchedKeywords.length);
  assert.deepEqual(flags, [...flags].sort((a, b) => b - a), 'matching hotels come first');
  assert.ok(flags.includes(0), 'non-matching hotels are still listed');
  assert.equal(r.notes.filter((n) => n.includes('没有找到')).length, 0);
  const none = hotels.searchHotels({ city: '杭州', keyword: '温泉滑雪场' });
  assert.ok(none.hotels.length > 0);
  assert.ok(none.notes.includes('没有找到完全符合「温泉滑雪场」的酒店，以下按综合推荐排序'), none.notes.join('|'));
});

test('searchHotels: an unmatched preference does not throw away the ones that matched', () => {
  const r = hotels.searchHotels({ city: '杭州', near: '西湖', keyword: '亲子 高楼层', checkIn: '2026-11-10' });
  const family = hotels.searchHotels({ city: '杭州', near: '西湖', keyword: '亲子', checkIn: '2026-11-10' });
  assert.ok(r.hotels.length > 0);
  assert.deepEqual(r.hotels.map((h) => h.id), family.hotels.map((h) => h.id), 'ranked exactly as for 亲子 alone');
  assert.ok(hotelMatchesKeyword(r.hotels[0], ['亲子']));
  assert.ok(r.notes.includes('没有找到「高楼层」相关的酒店，已优先显示符合「亲子」的'), r.notes.join('|'));
  assert.ok(!r.notes.some((n) => n.includes('「亲子 高楼层」')), r.notes.join('|'));
  // Two wishes nobody satisfies together: ranked by how many they meet, with a note.
  const both = hotels.searchHotels({ city: '杭州', near: '西湖', keyword: '亲子 网红 带泳池 新开业', checkIn: '2026-11-10' });
  const counts = both.hotels.filter((h) => h.lowestPrice !== null).map((h) => h.matchedKeywords.length);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('searchHotels: 含早 is matched against bookable breakfast rates, not hotel tags', () => {
  const r = hotels.searchHotels({ city: '杭州', near: '西湖', keyword: '湖景 含早', checkIn: '2026-10-30', checkOut: '2026-11-01', limit: 10 });
  assert.ok(!r.notes.some((n) => n.includes('含早')), r.notes.join('|'));
  const lakeAndBreakfast = r.hotels.filter((h) => h.matchedKeywords.includes('湖景') && h.matchedKeywords.includes('含早'));
  assert.ok(lakeAndBreakfast.length > 0, 'lake-view hotels with breakfast rates match both');
  assert.ok(r.hotels[0].matchedKeywords.includes('湖景'), 'a lake-view hotel ranks first');
  for (const h of r.hotels) {
    const offer = hotels.getRoomOffer({ hotelId: h.id, checkIn: '2026-10-30', checkOut: '2026-11-01' }).offer;
    const hasBreakfast = offer.roomTypes.some((rt) => rt.rates.some((x) => x.available && x.breakfast > 0));
    assert.equal(h.matchedKeywords.includes('含早'), hasBreakfast, h.id);
  }
});

test('searchHotels: budget filter, then relaxation up to +30% with a note', () => {
  const ok = hotels.searchHotels({ city: '杭州', priceMax: 500, checkIn: '2026-11-10' });
  assert.ok(ok.hotels.length > 0 && ok.hotels.every((h) => h.lowestPrice <= 500));
  assert.equal(ok.notes.filter((n) => n.includes('预算')).length, 0);

  // Find a budget just under the cheapest option near 鼓浪屿 so that only relaxation can satisfy it.
  const base = hotels.searchHotels({ city: '厦门', near: '鼓浪屿', checkIn: '2026-11-10', sort: 'price_asc', limit: 10 });
  const cheapest = base.hotels.find((h) => h.lowestPrice !== null).lowestPrice;
  const budget = Math.floor((cheapest / 1.15) / 10) * 10;
  const relaxed = hotels.searchHotels({ city: '厦门', near: '鼓浪屿', checkIn: '2026-11-10', priceMax: budget });
  const note = relaxed.notes.find((n) => n.includes('放宽到了'));
  assert.ok(note, relaxed.notes.join('|'));
  const hi = Number(/放宽到了 ¥(\d+)/.exec(note)[1]);
  assert.ok(hi <= Math.ceil((budget * 1.3) / 10) * 10 && hi > budget);
  assert.ok(relaxed.hotels.every((h) => h.lowestPrice <= hi));

  const tiny = hotels.searchHotels({ city: '上海', near: '外滩', priceMax: 50 });
  assert.ok(tiny.hotels.length > 0);
  assert.equal(tiny.query.sort, 'price_asc');
  assert.ok(tiny.notes.some((n) => n.includes('最便宜的也要')));

  const swapped = hotels.searchHotels({ city: '杭州', priceMin: 900, priceMax: 300 });
  assert.deepEqual([swapped.query.priceMin, swapped.query.priceMax], [300, 900]);
});

test('searchHotels: sort orders', () => {
  const asc = hotels.searchHotels({ city: '北京', sort: 'price_asc', limit: 10, checkIn: '2026-11-10' }).hotels.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = hotels.searchHotels({ city: '北京', sort: 'price_desc', limit: 10, checkIn: '2026-11-10' }).hotels.filter((h) => h.lowestPrice !== null).map((h) => h.lowestPrice);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  const rating = hotels.searchHotels({ city: '北京', sort: 'rating', limit: 10, checkIn: '2026-11-10' }).hotels.map((h) => h.rating);
  assert.deepEqual(rating, [...rating].sort((a, b) => b - a));
  const rec1 = hotels.searchHotels({ city: '北京', near: '故宫', checkIn: '2026-11-10' });
  const rec2 = hotels.searchHotels({ city: '北京', near: '故宫', checkIn: '2026-11-10' });
  assert.deepEqual(rec1, rec2, 'recommended is deterministic');
});

test('the demo suggestion chips all produce results', () => {
  // 这周五去杭州，西湖边住两晚，预算 600
  const a = hotels.searchHotels({ city: '杭州', near: '西湖边', checkIn: '2026-10-30', checkOut: '2026-11-01', priceMax: 600 });
  assert.ok(a.hotels.length >= 2 && a.hotels.every((h) => h.lowestPrice <= 600), JSON.stringify(a.notes));
  // 上海外滩附近的亲子酒店，明晚
  const b = hotels.searchHotels({ city: '上海', near: '外滩', keyword: '亲子酒店', checkIn: '2026-10-26', checkOut: '2026-10-27' });
  assert.ok(b.hotels.length >= 1);
  // 成都春熙路附近经济型，今晚
  const c = hotels.searchHotels({ city: '成都', near: '春熙路附近', categories: ['economy'] });
  assert.ok(c.hotels.length >= 1 && c.hotels.every((h) => h.category === 'economy'));
});

test('getRoomOffer and getHotel', () => {
  const { hotel, offer, datesAssumed } = hotels.getRoomOffer({ hotelId: 'sim-hz-001', checkIn: '2026-11-10', checkOut: '2026-11-12', adults: 2, rooms: 1 });
  assert.equal(hotel.id, 'sim-hz-001');
  assert.equal(offer.hotelId, 'sim-hz-001');
  assert.equal(offer.nights, 2);
  assert.equal(datesAssumed, false);
  assert.ok(offer.roomTypes.length >= 2);
  assert.equal(hotels.getRoomOffer({ hotelId: 'sim-hz-001' }).offer.checkIn, '2026-10-25');
  assert.throws(() => hotels.getRoomOffer({ hotelId: 'sim-hz-999' }), (e) => e instanceof HotelError && e.code === 'hotel_not_found');
  assert.equal(hotels.getHotel('sim-hz-001').name, hotel.name);
  assert.equal(hotels.getHotel('missing'), null);
  assert.equal(CATEGORY_LABELS[hotel.category].endsWith('型'), true);
});

test('priceCheck returns the rate or throws BookingError with a precise code', () => {
  const ok = hotels.priceCheck({ hotelId: 'sim-hz-001', rateId: 'R1-BF2-FC', checkIn: '2026-11-10', checkOut: '2026-11-12', rooms: 1, adults: 2 });
  assert.equal(ok.rate.rateId, 'R1-BF2-FC');
  assert.equal(ok.roomType.roomId, 'R1');
  assert.equal(ok.roomType.rates, undefined);
  assert.equal(ok.hotel.id, 'sim-hz-001');
  const codeOf = (args) => {
    try {
      hotels.priceCheck(args);
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof BookingError, e.name);
      return e.code;
    }
  };
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-12' };
  assert.equal(codeOf({ hotelId: 'sim-hz-999', rateId: 'R1-BF0-NR', ...stay }), 'hotel_not_found');
  assert.equal(codeOf({ hotelId: 'sim-hz-001', rateId: 'R9-XX', ...stay }), 'rate_not_found');
  assert.equal(codeOf({ hotelId: 'sim-hz-001', rateId: 'R1-BF0-NR', checkIn: '2026-11-10' }), 'invalid_dates');
  assert.equal(codeOf({ hotelId: 'sim-hz-001', rateId: 'R1-BF0-NR', ...stay, adults: 3, rooms: 1 }), 'too_many_guests');

  // Find a deterministic sold-out combination and check it is reported as such.
  let soldOut = null;
  for (let i = 0; i < 60 && !soldOut; i++) {
    const checkIn = addDays('2026-11-02', i);
    const { offer } = hotels.getRoomOffer({ hotelId: 'sim-hz-002', checkIn, checkOut: addDays(checkIn, 1) });
    const rt = offer.roomTypes.find((r) => !r.rates[0].available);
    if (rt) soldOut = { checkIn, rateId: rt.rates[0].rateId };
  }
  assert.ok(soldOut, 'some night is sold out');
  assert.equal(codeOf({ hotelId: 'sim-hz-002', rateId: soldOut.rateId, checkIn: soldOut.checkIn, checkOut: addDays(soldOut.checkIn, 1) }), 'sold_out');
});

test('createHotelService requires a supplier', () => {
  assert.throws(() => createHotelService({}), /supplier/);
});
