# 酒店商家端（演示）：服务、接口、数据

商家端是给酒店前台和店长用的控制台：经营概览、房态与入住、住客服务工单、点评与营销。它和旅客端用同一个服务端
和同一份数据，所以两边是连着的：旅客在小宿里订的房、要的毛巾、写的点评，商家端马上能看到；商家在控制台里接单、
送达、办入住、回复点评、开特惠，旅客那边的卡片和价格也跟着变。全部是模拟的，这份文档是后端（src/）和前端
（public/merchant.*）之间的约定。

原则：
- 演示用，不登录。商家端只看到打码后的旅客信息：姓名只留姓（「李*」），手机号打码。
- 酒店里的"其他客人"（房态、工单、点评、渠道）是按酒店 ID 和日期确定性生成的模拟数据；小宿里真实发生的订单、
  请求和点评叠加在上面，并标 `source: 'xiaosu'`（模拟的是 `source: 'sim'`）。
- 商家的操作只改自己酒店的数据；对旅客有影响的操作（办入住、工单状态、提前入住、回复点评）会给旅客的会话
  加一条通知（和订单通知一样：显示给用户的 notice + 给模型的【系统通知】）。

## 一、服务：src/services/merchant.js（新）

`createMerchantService({ store, bookings, stays, hotels, clock, promotions? })`，同步方法、注入时钟、`MerchantError(code, message)`
（code→HTTP 状态，中文 message；stays.js 的错误原样带上它的 code 和状态）。它也在手机 app 的页面里运行（和 stays.js 一样只依赖
src/util 和 src/services）。特惠存在 `createPromotionBook({ store, clock })`（集合 `merchant_promotions`）里，酒店服务
`createHotelService({ supplier, clock, promotions })` 用它查价；`buildDeps` 把同一个 promotions 交给两边。商家自己的改动另存在
`merchant_rooms`（当天的打扫/维修）、`merchant_tickets`（模拟工单的处理）、`merchant_replies`（对模拟点评的回复）。

**酒店的"今天"**：和订房一样，凌晨 6 点前还算前一晚（凌晨入住）。所以 00:30 来的「今晚」客人是昨天那一晚的预抵；
接口收发的日期仍是日历日期，房态的"今天"在 6 点前显示的是这一晚，概览的 `series` 最后一天也是这一晚。

需要的配合（在 bookings.js / stays.js / hotels 里加，保持原有接口不变）：
- `bookings.ordersForHotel(hotelId)`：这家酒店的全部订单（所有用户），新的在前。`bookings.markCheckedIn(...)`：入住（旅客
  自己办或前台办）记在订单上（`checkedInAt`），之后订单不能再在线取消。
- stays.js：按酒店列出入住记录和请求（`listHotelStays(hotelId)` 带每单的房号、`listHotelRequests(hotelId)`）；
  `frontDeskCheckIn(orderId)`（和旅客自己办入住同一个房号）；商家推进请求状态 `advanceRequest(requestId, action)`
  （送物：接单/送达/完成；提前入住：同意/婉拒）；`replyReview(reviewId, text)`。商家推进过的状态优先于按时间推进的
  状态（时间推进不会把状态往回拨）：接单立刻「配送中」，送达立刻「已送达」，没人处理时照旧 1 分钟配送中、5 分钟送达。
- 酒店特惠（见第五节）：酒店服务查价时乘上生效中的折扣，搜索结果和房型价格、报价、订单（还有续住）都用折后价。

**当前酒店**：`GET /api/merchant/hotels` → `{ hotels: [{ id, name, city, category, rating, rooms, hasGuests }], current }`。
`current` = 最近一个已确认订单的酒店（任何用户）；没有订单时用一家固定的示例酒店（杭州西湖边的第一家模拟酒店）。
`hotels` 是有小宿订单的酒店（新的在前）、示例酒店和几家不同类型的（上海的豪华型、丽江古城的客栈、成都的经济型）；
`hasGuests`：有还没离店的小宿订单。前端记住用户切换过的酒店。

**房间**：每家酒店的房间按房型的楼层范围生成（和 stays.js 分配房号同一规则：楼层取房型 `floor` 字段如「5-12层」，
跳过不吉利楼层；每层 01–28 号，低层客栈每层 01–08 号）。房号到房型的对应要确定性，真实旅客分到的房号一定在
网格里。每层的号码按房型分段（大床房最多，套房、家庭房最少，只在它们的楼层）；小宿客人住的那间显示他订的房型，
那几天这间房的模拟客人让给他。一单订几间也只占 stays.js 给的那一间（房费和间夜按间数算）。

## 二、经营概览

`GET /api/merchant/:hotelId/overview?days=30`（days 1–60，默认 30，否则 400 `invalid_days`）→
```js
{
  hotel: { id, name, city, category, rating, rooms /* 房间总数 */ },
  date: 'YYYY-MM-DD',                       // 今天（中国时间）
  kpis: {
    occupancy,      // 今晚入住率 0–1
    revenue,        // 今天营收（元）：今晚房费 + 今天的餐饮杂费
    adr,            // 平均房价
    revpar,         // 每间可售房收入
    arrivals, departures, inHouse,          // 今日预抵、预离、在住（间）
    openTickets,    // 待处理 + 处理中的工单
    rating, reviewCount,
    vsLastWeek: { occupancy, revenue },     // 和上周同一天比的变化（比例，如 0.08 = +8%）
  },
  series: [{ date, occupancy, revenue, adr, xiaosu /* 当天小宿订单间夜 */ }],   // 过去 days 晚，旧→新，最后一个是今晚
  forecast: [{ date, occupancy }],          // 之后 14 晚的预测入住率（已订 + 模拟）
  channels: [{ key: 'xiaosu' | 'ctrip' | 'meituan' | 'fliggy' | 'direct', label, share /* 0–1 */, nights }],  // 五个都在，按这个顺序
  arrivals: [{ orderId?, guest /* 李* */, roomType, nights, eta?, source, status: 'arriving' | 'checked_in' }],  // 小宿的在前，最多 20 条
  insights: [{ id, level: 'tip' | 'warn' | 'good', title, text, action?: { tab, label } }],  // 2–4 条，按数据规则生成
}
```
insights 的例子：未来某天预测入住率 ≥ 90% →「周五预计满房，可以把大床房上调 8–12%」（action 去「营销」）；有工单等了
超过 10 分钟 →「3 张工单还没人接」（action 去「工单」）；最近 30 天有差评提到同一个问题 →「3 条点评提到隔音」；
小宿渠道占比上升 →「小宿订单本周 +2 单」。另外还有：今天有小宿客人到店（去「房态」）、未来 7 天有入住率低于 55% 且
没开特惠的晚上（「开特惠」）、近 7 天有没回复的点评、近 30 天好评率（保底，保证至少 2 条）。`action.tab` 是前端的标签
key：`overview` / `rooms` / `tickets` / `reviews`（点评营销）。

## 三、房态与入住

`GET /api/merchant/:hotelId/rooms?date=YYYY-MM-DD`（默认今天，只支持今天到 +6 天，否则 400 `invalid_date`）→
```js
{
  date,
  counts: { vacant, dirty, occupied, arriving, departing, ooo },
  floors: [{ floor, rooms: [{
    number, roomType,
    status: 'vacant' | 'dirty' | 'occupied' | 'arriving' | 'departing' | 'ooo',
    guest?: { name /* 李* */, orderId?, checkIn, checkOut, source },
    tickets?: 1,                     // 这间房未完成的工单数
  }] }],
}
```
`POST /api/merchant/:hotelId/rooms/:number` body `{ action: 'clean' | 'ooo' | 'release' | 'check_in', orderId? }` → `{ room }`：
- `clean`：空脏 → 空净；`ooo`：设为维修（只能对空房：空净或空脏）；`release`：维修 → 空净。房间改动存起来，只对当天
  有效（模拟房间和小宿客人退房后的空脏房都一样）。状态不对是 409 `invalid_action`，不认识的 action 是 400
  `unknown_action`，没有这间房是 404 `room_not_found`。
- `check_in`：前台为小宿订单办入住（订单今天或之前入住、已确认、未入住）。房号就是 stays.js 给这一单的房号，
  `:number` 必须是它，不是就 409 `wrong_room`（`error.details.roomNumber` 是正确房号）。旅客收到通知「前台已为你办好入住：823 房」，
  附 `checkin` 卡片。其他错误：缺 orderId 400 `invalid_order`；不是这家酒店的订单 404 `not_found`；已取消/未支付 409
  `order_not_confirmed`；已入住 409 `already_checked_in`；入住日还没到 409 `not_arrived`。

## 四、住客服务工单

`GET /api/merchant/:hotelId/tickets` →
```js
{ tickets: [{
  id, kind: 'service' | 'early_checkin' | 'wakeup' | 'dining',
  roomNumber, guest /* 李* */, source: 'xiaosu' | 'sim',
  title,                      // 「毛巾 ×2」「提前入住 12:00」「叫醒 07:00」「早餐 2位 08:00」
  note?, createdAt, dueAt?,
  status: 'new' | 'doing' | 'done' | 'declined',
  actions: ['accept' | 'deliver' | 'done' | 'approve' | 'decline'],   // 现在能做的
  orderId?,
}] }
```
新的在前；`done` 只保留最近 24 小时。送物：`new`（旅客 accepted）→ `doing`（on_the_way）→ `done`，`actions` 是
`new` 时 `['accept', 'deliver']`、`doing` 时 `['deliver']`（打扫、维修这类是 `done`，两者等价）。叫醒和订餐只读：
`doing` 到时间变 `done`（退房时取消的不再列出）。提前入住 pending 时 `new`，可以同意/婉拒；11:00 以后到店的旅客
申请当场就确认了（`done`）。模拟工单（前台电话接的，`source: 'sim'`）每天 4–12 张，在模拟客人住的房间里，
也随时间推进（送物等 2–30 分钟才有人接）；没人处理的模拟提前入住，到客人到店时间算 `done`。
`POST /api/merchant/:hotelId/tickets/:id` body `{ action }` → `{ ticket }`：
- 送物 `accept`（new → doing，旅客那边变「配送中」）、`deliver` / `done`（→ done，旅客那边「已送达」）。
- 提前入住 `approve` / `decline`：旅客收到通知「酒店已确认 12:00 可以入住」/「那天房间比较满，按 14:00 入住哦」；
  旅客那边的请求变成 `confirmed` / `declined`（卡片上「已满房」），note 就是这句话。
- 模拟工单也能操作（存起来，只为演示）。不能操作的 409 `invalid_action`；不认识的 action 400 `unknown_action`；
  找不到（或完成超过 24 小时）的 404 `not_found`。

## 五、点评与营销

`GET /api/merchant/:hotelId/reviews` →
```js
{
  summary: { rating, count, distribution: { 5, 4, 3, 2, 1 }, tags: [{ tag, count }] },
  reviews: [{ id, source, guest /* 李* */, rating, text, tags, roomType?, at, reply?: { text, at } }],   // 新的在前
}
```
`summary` 是这家酒店全部的点评（模拟的历史，数量就是酒店的 reviewCount）加上小宿旅客的；`reviews` 列近 60 天的
模拟点评（最多 30 条，大多已经有酒店回复）和小宿旅客发布的点评。
`POST /api/merchant/:hotelId/reviews/:id/reply` body `{ text }`（1–300 字，否则 400 `invalid_reply`）→ `{ review }`。
再回复一次是改回复。小宿旅客的点评：回复同时出现在旅客的点评卡片上（`review.reply`，`GET /api/stays` 里也有），
旅客收到通知「酒店回复了你的点评」（回复的内容变了才通知）。
`POST /api/merchant/:hotelId/reviews/:id/draft-reply` → `{ text }`：按评分和标签套模板起草一段回复（不调用大模型，
商家可以改；差评会针对提到的问题，如隔音、早餐）。

`GET /api/merchant/:hotelId/promotions` → `{ promotions: [{ id, title, discount /* 0.85 = 85折 */, from, to, active,
createdAt, stats: { views, orders } }] }`；
`POST /api/merchant/:hotelId/promotions` body `{ title, discount, from, to }` → 201 `{ promotion }`，新建就开启
（title 1–20 字；discount 0.5–0.95，保留两位小数；from、to 是入住的晚上，含两头，今天起 60 天内；每家最多 5 个
还没结束的）。错误：400 `invalid_title` / `invalid_discount` / `invalid_date`，409 `too_many_promotions`。
`POST /api/merchant/:hotelId/promotions/:id` body `{ active }`（true / false）→ `{ promotion }`。
`stats.views` 是模拟的（开着的时候按小时累积），`stats.orders` 是用了这个特惠的小宿订单加上按浏览量模拟的成交。
生效中的特惠（active 且入住日期在范围内）作用在这家酒店的每晚价格上（每晚 × 折扣，四舍五入到元；同一晚有几个就用
折扣最大的那个）：搜索结果的起价、房型价格、报价和订单都是折后价；`hotels` 卡片里这家酒店带
`promo: { id, title, discount }`，房型方案带 `promo`（同样带 id），订单的 `rate.promo` 记下用了哪个特惠。
已经下的订单不变；报价后特惠关了，确认时按原规则提示价格有变动。

## 六、给旅客的通知

和叫车、续住的通知一样：会话里加一条 `{ role: 'notice', kind, text, at, cards }`，同时给模型一条以 `【系统通知，非用户输入】`
开头的消息；旅客正在等回复时，等这一轮说完再放进去。通知进订单所在的会话（提前入住、点评：请求所在的会话）。

| kind | text | cards | 给模型的（例） |
| --- | --- | --- | --- |
| `front_desk_checkin` | 前台已为你办好入住：823 房 | `checkin` | 酒店前台已为用户办好入住：… 823 房（8楼），电子房卡有效期至 …，Wi-Fi … |
| `early_checkin_approved` | 酒店已确认 12:00 可以入住 | `early_checkin` | 酒店已确认用户可以提前入住：…，10月30日（周五） 12:00 到店就能入住（模拟）。 |
| `early_checkin_declined` | 那天房间比较满，按 14:00 入住哦 | `early_checkin` | 酒店婉拒了用户的提前入住申请：… |
| `review_replied` | 酒店回复了你的点评 | `review_draft`（带 `reply`） | 酒店回复了用户的点评：… 5星，酒店的回复是「…」（模拟）。 |

商家写的文字（回复）在给模型的消息里一律放进「」，并去掉其中的「」『』【】，不能冒充平台的话。

## 七、页面（public/merchant.html）

黑金色的控制台，手机上底部四个标签（概览、房态、工单、点评营销），宽屏左侧导航。打开方式：电脑上
`http://localhost:8787/merchant`；手机 app 和 iPhone 网页版在「⋯」菜单里「切换到商家端（演示）」，商家端里有
「回到旅客端」。有进行中的工单或今天的预抵时每 15 秒刷新。
