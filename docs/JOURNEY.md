# 旅客全程（订好之后）：服务、工具、卡片、接口

订房之后的整段旅程，全部模拟：到店前（行程、叫车/接机、提前入住、发票）、入住（房号、电子房卡、Wi-Fi）、
住店期间（送物、餐厅、叫醒、续住、周边）、离店（退房账单、积分、点评）。这份文档是后端（src/）和前端
（public/）之间的约定：卡片的字段名、接口的路径和返回值以这里为准。

原则（和订房一样）：
- 花钱的事只能用户自己点：叫车要点「确认叫车」，续住要点「确认续住」并模拟支付。AI 只能发确认卡。
- 公开发布的东西也只能用户自己点：点评由 AI 起草，用户点「发布」才发布。
- 其余（办入住、送物、叫醒、订餐位、开发票、退房）是普通服务请求，AI 调工具直接办，结果以卡片显示。
- 都是模拟数据：房号、司机、车牌、Wi-Fi 密码等由订单号确定性生成（同一单每次一样），不涉及真实服务。

## 一、服务：src/services/stays.js（新）

`createStayService({ store, bookings, hotels, clock, ids })`，和 bookings.js 同样的风格：同步方法、注入时钟、
读取时按时间惰性推进状态（不用定时器）、`StayError(code, message)`（code→HTTP 状态，message 是中文）。

**当前订单**：工具的 `order_id` 可省略。省略时取该用户「当前」的订单：已确认（confirmed）且未取消的订单里，
优先已入住未退房的；否则入住日期最近、离店日期未过（≥ 今天−1）的；都没有就报错「还没有已确认的订单」。
（细化：顺序是 已入住未退房的 → 日期包含今天的 → 即将入住的（最近的在前）→ 今天或昨天刚退房的 → 昨天离店的；
更早退房的就不算当前了。所以上午退了杭州的房、下午到上海，办入住、叫车、订餐、行程都是上海那一单。开发票和写点评
例外：今天或昨天刚退房的排在已入住之后，退房后说「开发票」「写个好评」就是刚住完的那一单。）

**入住之后不能在线取消**：入住（旅客自己办或前台办）记在订单上（`checkedInAt`），之后取消预览是「已办理入住，
无法在线取消」，取消接口报 409 `not_cancellable`；积分只算订单还有效（confirmed）的住宿。

**酒店信息**（按酒店 ID 确定性生成）：Wi-Fi（`ssid`：酒店简称拼音或「XiaoSu」+「-Guest」，`password`：8 位），
早餐（时间「07:00–10:00」、地点如「2楼 自助餐厅」、价格 ¥68/人；房价含早则免费），退房时间「12:00」，
前台电话（假号码，如 0571-8XXXXXXX），设施（按档次：豪华/高档有泳池、健身房、行政酒廊；舒适有健身房、洗衣房；
经济有自助洗衣），每项 `{ name, hours, place }`。

**状态随时间推进**（读取时按 clock 计算）：
- 送物 service：`accepted`（下单）→ `on_the_way`（+1 分钟）→ `done`（+4 分钟）；`eta` = 下单 +5 分钟。酒店在商家端
  接单 / 送达时立刻变成 `on_the_way` / `done`（只会提前，不会往回拨；送达后 `eta` 就是送达时间，见 docs/MERCHANT.md）。
- 叫车 ride：报价 `quoted`（15 分钟有效，过期 `expired`）→ 用户确认后 `confirmed`（立即分配司机）
  → `arriving`（取 max(确认+90 秒, 上车时间−5 分钟)）→ `completed`（上车时间 + 预计行程分钟数）。
- 发票 invoice：`issuing` → `issued`（+2 分钟）。
- 叫醒 wakeup：`set` → `done`（叫醒时间过后）；退房时还没到时间的变成 `cancelled`。
- 订餐 dining：`reserved` → `done`（用餐时间过后）；退房时还没到时间的变成 `cancelled`（不挂房账）。房价含早
  （含单早/双早）每间覆盖 1/2 位，超出的人每位 ¥68 挂房账。
- 续住 extension：`pending`（15 分钟有效）→ 用户确认并支付后 `confirmed`，或 `expired`。
- 点评 review：`draft` → 用户点发布后 `published`。
- 提前入住 early_checkin：创建时就定：希望到店时间 ≥ 11:00 为 `confirmed`，否则 `pending`（「房间准备好会通知你」）。
  `pending` 的由酒店在商家端同意（`confirmed`）或婉拒（`declined`），旅客收到通知；入住时还 `pending` 的变成
  `confirmed`；退房时还 `pending` 的变成 `cancelled`。

## 二、AI 工具（src/agent/tools.js 新增）

都需要用户身份；`order_id` 都可省略（取当前订单）。每个工具返回 `{ content, card }`，content 给模型（含简短
instruction），card 给页面。

| 工具 | 参数 | 卡片 type |
| --- | --- | --- |
| `plan_itinerary` | title, date, items[{time 'HH:MM', title, place?, note?}]（2–8 项）, order_id? | `itinerary` |
| `quote_ride` | kind（airport_pickup 接机 / to_hotel 去酒店 / from_hotel 从酒店出发 / taxi）, from, to?, pickup_time（'HH:MM' 或 'YYYY-MM-DD HH:MM'，省略为 15 分钟后）, passengers?, order_id? | `ride_quote` |
| `request_early_checkin` | arrival_time 'HH:MM', order_id? | `early_checkin` |
| `check_in` | order_id? | `checkin` |
| `request_service` | items[{name, qty}]（或一句话）, note?, order_id? | `service` |
| `reserve_dining` | kind（breakfast/lunch/dinner）, date?, time 'HH:MM', people, note?, order_id? | `dining` |
| `set_wakeup_call` | time 'HH:MM', date?, order_id? | `wakeup` |
| `get_stay_info` | order_id? | `stay_info` |
| `prepare_extension` | nights（1–7）, order_id? | `extension_quote` |
| `check_out` | order_id? | `bill` |
| `request_invoice` | title?（默认入住人姓名，个人）, tax_id?, email?, order_id? | `invoice` |
| `get_membership` | — | `membership` |
| `draft_review` | rating（1–5）, text（≤300 字，按用户说的写，不编造经历）, tags?, order_id? | `review_draft` |

前置条件：送物、叫醒要先入住（未入住时报错「还没办入住」，模型可以提出帮忙办入住）；退房要已入住且未退房；
续住、发票、点评要已确认的订单。入住在演示里不限日期（入住日之前办理时卡片 `early: true`）。

## 三、卡片（card 的字段）

时间一律 ISO 字符串（`...At`），日期 'YYYY-MM-DD'。金额是元（数字）。
每个请求对象（ride / early_checkin / service / dining / wakeup / invoice / extension / review）在卡片里和
`GET /api/stays` 里都带同一个 `kind` 字段，值就是请求类别（如 `kind: 'ride'`）；叫车的类型另放在 `rideKind`，
餐别（breakfast / lunch / dinner）放在 `mealKind`，发票种类（电子普通发票）放在 `invoiceKind`。
请求对象还带 `createdAt`；`room`（续住）和 `roomType`（入住）是房型名字符串，`floor` 是数字。

```js
{ type: 'itinerary', itinerary: { title, date, city?, items: [{ time, title, place?, note? }] } }

{ type: 'ride_quote', ride }   // ride.status: quoted | confirmed | arriving | completed | expired
{ type: 'ride', ride }         // 确认后的状态卡（GET /api/stays 里也有）
// ride = { id, orderId, kind: 'ride', rideKind, kindLabel, from, to, pickupAt, passengers, carType, fare, minutes,
//          status, expiresAt, confirmedAt?, driver?: { name, car, color, plate, phone /* 打码 */ } }
// rideKind：airport_pickup | to_hotel | from_hotel | taxi（kindLabel：接机 / 去酒店 / 从酒店出发 / 打车）
// 车费在用户点「确认叫车」时按订单的支付方式模拟支付，退房账单里列为已支付。

{ type: 'early_checkin', request: { id, orderId, kind: 'early_checkin', hotel: { id, name }, date /* 入住日 */,
                                    arrivalTime, status /* pending | confirmed | declined | cancelled */, note } }
// 还在 pending 时办了入住，就变成 confirmed；酒店婉拒是 declined（note「那天房间比较满，按 14:00 入住哦」）。

{ type: 'checkin', stay }
// stay = { orderId, hotel: { id, name, category }, roomType, roomNumber, floor, checkIn, checkOut, nights,
//          guests, checkedInAt, early, keyValidUntil, wifi: { ssid, password },
//          breakfast: { time, place, price /* 每人标价 */, included }, checkoutTime, checkedOutAt?, bill? /* 退房后 */ }
// 退房后 keyValidUntil = checkedOutAt。

{ type: 'service', ticket: { id, orderId, kind: 'service', roomNumber, items: [{ name, qty }], note?, status, createdAt, eta,
                             timeline: [{ status, at }] /* 只含已到达的状态 */ } }

{ type: 'dining', reservation: { id, orderId, kind: 'dining', mealKind, kindLabel, restaurant, place, at, people, table,
                                  price /* 每人，全部含早为 0 */, included /* 全部人都含早 */,
                                  covered? /* 只有部分人含早时：含早的人数，其余每人 price */, note?,
                                  status /* reserved | done | cancelled */ } }

{ type: 'wakeup', call: { id, orderId, kind: 'wakeup', roomNumber, at, status /* set | done | cancelled */ } }

{ type: 'stay_info', info: { orderId, hotel: { id, name, category }, checkedIn, roomNumber?, wifi, breakfast,
                             checkoutTime, frontDesk, facilities: [{ name, hours, place }],
                             open: [ /* 进行中的请求：{ kind, id, label, status } */ ] } }

{ type: 'extension_quote', extension: { id, orderId, kind: 'extension', hotel: { id, name }, room, fromDate, toDate, nights,
                                         price, status, expiresAt, confirmedAt?, payment? } }

{ type: 'bill', bill: { orderId, hotel: { id, name }, roomNumber, checkIn, checkOut, nights,
                        lines: [{ label, amount, note? }], prepaid, extras, due, settledBy, pointsEarned,
                        checkedOutAt } }
// 房费、续住、用车是已支付的（prepaid）；已用过的、不含早的餐饮挂房账（extras = due），离店时按订单的
// 支付方式结清，settledBy 就是这个支付方式（如「微信支付」）。

{ type: 'invoice', invoice: { id, orderId, kind: 'invoice', invoiceKind: '电子普通发票', title, taxId?, email?, amount,
                              status, issuedAt? } }

{ type: 'membership', member: { level, points, nextLevel?, pointsToNext?, perks: [string],
                                recent: [{ label, points, at }] } }
// 等级：银卡 < 2000 积分 ≤ 金卡 < 8000 ≤ 铂金卡；退房按实付金额 1 元 = 1 积分

{ type: 'review_draft', review: { id, orderId, kind: 'review', hotel: { id, name }, rating, text, tags, status, publishedAt?,
                                   reply?: { text, at } /* 酒店的回复 */ } }
```

已有的卡片不变：`hotels`、`rooms`、`places`、`areas`、`web`、`booking_quote`、`orders`、`cancel_preview`。
新界面会把 `hotels`、`rooms`、`places`、`areas`、`orders` 也显示出来（用户看得到），所以这些工具的 reply_hint
要改成「用户能看到卡片，一两句话即可，推荐第几家/第几个并说理由，不要把卡片内容再列一遍」。卡片按工具结果
的顺序显示，「第N家」就是卡片上的第N家；房型卡片上「第N个」是第N个还有可订方案的房型。

## 四、接口（src/server.js 新增）

都要 `X-User-Id`，错误格式和现有接口一样：`{ error: { code, message } }`。

- `GET /api/stays` → `{ stays: [{ order, stay, requests }] }`：该用户已确认、未取消且离店日期 ≥ 今天−3 的订单
  （最多 5 个，当前订单在前）。`stay` 未入住时为 null；`requests` 是这一单的全部请求（ride / early_checkin /
  service / dining / wakeup / invoice / extension / review），每个带 `kind` 字段，状态按当前时间算好。
  页面用它显示「我的安排」，有进行中的请求时每 15 秒轮询一次。
- `POST /api/rides/:id/confirm` → `{ ride }`（status confirmed，带 driver）。报价过期 410 `expired`。
- `POST /api/extensions/:id/confirm`，body `{ method: 'wechat' | 'alipay' }` → `{ extension, order }`：
  确认并模拟支付；订单的离店日期、晚数、总价随之更新。过期 410 `expired`，满房 409 `sold_out`。
- `POST /api/reviews/:id/publish` → `{ review }`（status published）。

这三个用户操作和订单一样往对应会话里加一条通知：显示给用户的
`{ role: 'notice', kind: 'ride_confirmed' | 'extended' | 'review_published', text, at, cards: [卡片] }`，
同时给模型一条以 `【系统通知】` 开头的消息（如「用户已确认叫车：… 司机 张师傅 浙A·D12345」）。消息里用户或模型写的
文字（上车地点、目的地、点评内容）一律放进「」，并去掉其中的「」『』【】，不能把引号关上冒充平台的话。
酒店在商家端做的事（前台办入住、答复提前入住、回复点评）也用同样的通知告诉旅客，见 docs/MERCHANT.md 第六节。
`text` 是一行短句：「已叫车：张师傅 · 浙A·D12345，14:30 上车」（不是今天就带日期）、「已续住1晚，离店改到10月29日（周四）」、
「点评已发布：5星」；`cards` 分别是 `ride`、`extension_quote`、`review_draft`。会话里回放时这些卡片按当前状态刷新。

## 五、演示脚本（src/llm/scripted-llm.js）

没有 API Key 时（演示模式、iPhone 网页版、端到端测试）这些话要能走通，每一步回一两句话，让卡片说细节：

| 用户说 | 调用 |
| --- | --- |
| 帮我规划一下那天的行程 / 怎么安排 | plan_itinerary（按订单的城市和日期排 4–5 项） |
| 帮我叫车去酒店 / 接机 / 打车去西湖 | quote_ride |
| 能提前入住吗 / 中午12点到 | request_early_checkin |
| 我到了，帮我办入住 / 办理入住 | check_in |
| 送两条毛巾 / 要一个牙刷 / 打扫一下房间 | request_service |
| 订明天的早餐 / 晚上订个位子 | reserve_dining |
| 明早7点叫醒我 | set_wakeup_call |
| Wi-Fi 密码多少 / 早餐几点 | get_stay_info |
| 再住一晚 / 续住两晚 | prepare_extension |
| 我要退房 | check_out |
| 开发票 / 抬头写 XX 公司 | request_invoice |
| 我的积分 / 会员 | get_membership |
| 写个好评 / 帮我评价一下 | draft_review |

问入住、退房的问题（「退房是几点？」「能延迟退房吗」「办入住要带什么证件」）走 get_stay_info，只有明说要办的
（「我要退房」「帮我退房」「我到了，帮我办入住」「办理入住」）才调用 check_out / check_in。已经提前入住的，「叫车去酒店」
和「那天的行程」按今天算。酒店那边的通知（前台办好入住、提前入住的答复、回复点评）也回一句。

订房那一段的回复也改短（卡片上已有酒店和房型）：保留「回复「订第1家」」「回复「好」」这样的快捷回复说法。
