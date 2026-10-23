# 诡镇奇谈联机卡顿诊断与修复

> 结论：卡的主因不是「网速不够」，而是**房主进程每一步都在同步重算、复制、序列化整局**，
> 且这份整局里包含一整条只增不减的事件历史（每条事件都内嵌一张整桌快照）。
> 联机只是把这份工作乘上了「玩家数 × 每次行动的 publish 次数」，再叠上 Render 免费中转的往返。
> 于是越到战役后期越卡，联机比单机卡，人越多越卡。

- 复现命令：`node tools/perf-online-snapshot.mjs --seats=4 --moves=250`（`--trim=0` 看修复前）
- 测量环境：本机 Node 22，4 个真人席位，夜之狂热第一关，按「自动选第一个合法行动」推进（只为制造事件量，不代表真实牌序）
- 所有毫秒都是**同步阻塞**时间：这段时间里大厅的事件循环停住，WebSocket 心跳、快照下发、浏览器长轮询全部排队

## 一、卡在哪（修复前的实测，第 250 步 / 818 条事件）

| 指标 | 修复前 |
|---|---|
| 事件日志 | 818 条 / **8.27 MB**（每条事件内嵌整桌 `tableState`，5–10 KB） |
| 单次 `publishOnline`（4 个真人） | **≈164 ms** |
| 单次玩家快照（首次/重连/`sync`） | 844 KB |
| 单次增量 delta | 35–116 KB（预算窗口滑动会成批剥掉旧事件的 tableState） |
| 单次 `saveSnapshot` | **17.9 MB / 90 ms** 同步写盘 |
| `commitMove` 里被丢弃的整局序列化 | **56 ms / 次**（每个动作都付，AI 动作也不例外） |
| 单机每次行动下发 | **7.82 MB**（服务端 `viewEvents` 169 ms + 浏览器解析 45 ms） |

增长趋势：事件日志与存档随步数线性到超线性增长，第 50 → 250 步时 `publishOnline` 从 59 ms 涨到 168 ms。

## 二、根因

1. **事件日志只增不减**：每条事件都 `captureTableState` 存一张整桌快照。250 步 8.27 MB，战役越往后越大；而前端只回放 `seq > lastSeq` 的新事件，旧快照是纯死重量。
2. **一次行动要重建 3–17 次个人视图**：`onlineCommand` 里 2 次 `snapshotSession`、`runAiTurns` 每个 AI 动作 1 次、`finally` 1 次，中转 room 广播再触发 2 次 `onRoom → publishOnline`。每次 `publishOnline` 又对每个在线席位克隆整局 + 克隆整段事件历史 + 逐事件投影。带 3 个 AI 队友时，一次点击 ≈ 15 次发布 + 14 次落盘。
3. **存档同步、重复、且带历史副本**：`writeFileSync` 全同步；检查点把「当时的全部事件」整段复制进存档，体积近似平方增长。
4. **每一步还有一次纯浪费的整局序列化**（只为检测循环引用，结果被丢弃）。
5. **浏览器侧**：`/api/online/status` 每次变化都返回整份 session（844 KB），收到后 `root.replaceChildren` 重建整棵 DOM（表上每张卡图都是新建的 `<img>`）。
6. **中转**：操作要 `客人 → Render → 房主 → Render → 客人` 两段往返；本机实测 TCP 建连 170–260 ms、TLS 握手抖动到 5.4 s，免费实例还会休眠。

## 三、已实施的修复

| 位置 | 改动 |
|---|---|
| [`lib/server.js:49`](../lib/server.js#L49) | 新增 `trimEventVisuals`：提交时就地剥掉滑出窗口（最近 24 条）的 `tableState` / `presentation.tableState`，只保留文字历史 |
| [`lib/server.js:538`](../lib/server.js#L538) | 个人视图按 `revision + 事件条数 + 备忘 + 存档状态` 缓存，一次 revision 只算一遍 |
| [`lib/server.js:851`](../lib/server.js#L851) | `publishOnline` 跳过离线成员；同一份视图 + 同样 busy/lobby 时整条跳过（不再 deep copy + diff） |
| [`lib/server.js:875`](../lib/server.js#L875) | 中转 room 广播按房间签名去重，只有成员/准备/阶段真的变了才重发 |
| [`lib/server.js:602`](../lib/server.js#L602) | `commitMove` 的可序列化检查只覆盖本次新状态与新事件 |
| [`lib/server.js:106`](../lib/server.js#L106) | 落盘改为 `await saveSnapshotAsync`（不阻塞事件循环），并按内容指纹去重 |
| [`lib/sessions.js:101`](../lib/sessions.js#L101) | 新增异步原子写；并发保存用唯一临时文件名 |
| [`hall-integration.js:21`](../games/arkhamhorror/src/integration/hall-integration.js#L21) | 关卡检查点只存文字事件，不再复制整桌演出快照 |

### 修复后（同样 250 步）

| 指标 | 修复前 | 修复后 | 倍数 |
|---|---|---|---|
| 事件日志 | 8.27 MB | **0.42 MB** | ~20× |
| 单机每次行动下发 | 7.82 MB | **0.68 MB** | ~11× |
| 服务端 `viewEvents` | 169 ms | **13 ms** | ~13× |
| `commitMove` 多余序列化 | 56 ms | **1.7 ms** | ~33× |
| 单次存档 | 17.9 MB / 90 ms 同步 | **1.5 MB / 12 ms**，且异步不阻塞 | ~12× |
| 单个玩家快照 | 844 KB | **694 KB** | ~1.2× |
| 每次行动的 publish 次数 | 3–17 次全量重算 | 每个 revision 只算一遍，重复的整条跳过 | — |

150 步的对照（同一台机器、同一套脚本，`--trim=0` vs `--trim=1`）：
`publishOnline` 平均 141 → 106 ms，存档 4.6 MB/25 ms → 0.9 MB/7 ms，单机下发 3.62 → 0.53 MB。

剩下的 `publishOnline` 时间主要花在**每个席位各自的 `viewState` 投影**（约 7–11 ms/席位，4 席 45–90 ms）——
这是「每个玩家一份个性化视图」的固有成本，只能靠把公共部分与私有部分拆开再优化（见下）。

## 四、仍未解决的部分

1. **浏览器仍然整份拉取**：`/api/online/status` 每次变化返回整份 session（现在约 450–700 KB），前端整棵 DOM 重建。要进一步降，需要给浏览器加增量协议（复用 `snapshotChanges`/`applySnapshotChanges` + 客户端 baseline），属于接口改动，风险高于本次数据面修复，尚未做。
2. **个人视图的公共/私有拆分**：`viewState` 对每个席位都重算地点、敌人、幕/议程、卡表等公共部分；拆分后 4 人房间还能再省一半以上。
3. **网络**：中转在 Render 免费实例（休眠、共享 CPU、跨洋 RTT）。换区域/付费实例，或支持自建中转 + TURN，才可能把往返压到 100 ms 以内；这部分不在代码里。
4. **AI 回合与回包解耦**：客人仍要等整轮 AI 跑完才收到回复（期间界面一直「处理中」）。要改得调整 busy 语义与并发控制，本次未动。

## 五、复现与验证

```bash
node tools/perf-online-snapshot.mjs --seats=4 --moves=250            # 修复后
node tools/perf-online-snapshot.mjs --seats=4 --moves=250 --trim=0   # 修复前对照
```

脚本复刻 `sessionView` / `publish` / `saveSnapshot` 三条热路径，逐步输出事件体积、
`publishOnline` 耗时分解、delta 体积和存档耗时。

回归测试：`node --test tests/hall/*.test.mjs`、`games/arkhamhorror/tests/hall-online.test.mjs`
（四真人联机 240 步）、`games/arkhamhorror/tools/run-tests.mjs fast`。

## 六、后续计划

上面「仍未解决」里的 #2 → 前端渲染优化 → #1 已排成执行计划，见
[`arkham-performance-roadmap.md`](arkham-performance-roadmap.md)（含逐字节门禁、隐私断言与验收指标）。

## 七、卡图与混乱标记「过一会儿才出来」（2026-10-23 排查）

> 现象：玩一会儿以后，卡图、混乱标记要等一会儿才出现，越到后期越明显。
> 结论：**不是画图慢，是每个图像都要先打一轮 HTTP 请求**。
> 静态资源的 `cache-control` 是 `max-age=0, must-revalidate`，浏览器每次重新显示同一张
> 卡图/标记都必须回大厅复验一次；而复验在大厅侧要 `readFile` 整个文件 + 算两遍 sha256，
> 全部排在单线程事件循环上，和同一时刻「一次行动的整局视图 + 落盘」抢时间。
> 一局越到后期，单次行动占用事件循环越久，排队等复验的卡图就越晚出现。

### 7.1 实测（真实存档、本机 Chrome）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 第二次/第三次打开牌桌时的图片请求 | 47–48 次，全部走网络复验 | 全部命中本地缓存 |
| 图片请求 p95 / max | **401 ms / 419 ms** | **1 ms / 1 ms** |
| 页面下行字节（图片部分） | 895 KB（全是 304 响应头） | **0 B**（`decodedBodySize` 11.7 MB 全部来自缓存） |
| 44 张卡图并发复验（服务端） | 每张 = `realpath`×2 + `stat` + `readFile` + sha256×2 | 命中摘要后 304 不读盘：整轮 **13 ms** |
| 本地缺图触发的 CDN 回源 | 400–750 ms，**每次请求都重来一遍** | 失败结果记 10 分钟，立刻走下一个候选 |

修复前，打开一次牌桌（44 张图、5.1 MB）光是重复读盘 + 哈希就是几十毫秒的同步工作；
这些工作与「一次行动的整局视图（约 45 ms）」在同一事件循环里排队，表现就是图一张张慢慢出来。

### 7.2 改动

| 位置 | 改动 |
|---|---|
| [`lib/server.js:1153`](../lib/server.js#L1153) | 静态摘要缓存 `(mtime, size) → sha256`：条件请求命中时直接 304，**不读盘、不算哈希**；200 时摘要复用，只算一次哈希（原先 `serveStatic` + `sendPublic` 各算一遍） |
| [`lib/server.js:1219`](../lib/server.js#L1219) | 二进制媒体（`png/avif/webp/jpg/svg/woff/ttf/ogg/mp3/…`）改为 `public, max-age=86400, immutable`；带 `?v=` 的仍是一年 immutable |
| [`lib/server.js:1178`](../lib/server.js#L1178) | 静态根目录的 `realpath` 进程内缓存，省掉每次请求一次系统调用 |
| [`image-cache.js:34`](../games/arkhamhorror/src/integration/image-cache.js#L34) | 按需下载失败做 10 分钟负缓存（`missTtlMs`），CDN 上没有的卡图不再每次重绘都等一轮往返 |
| [`table-art.js:60`](../games/arkhamhorror/web/table-art.js#L60) | `IntersectionObserver` 在占位节点被重绘换掉时主动 `disconnect()`（观察者会强引用目标节点，长局会攒下大量已离屏卡图节点） |

`app.js` / `*.js` / `*.css` **保持** `max-age=0, must-revalidate`：Mod 的脚本与样式 URL 没有版本参数，
改成 immutable 会让更新后仍加载旧代码。图片、字体、音频是随包发布的二进制媒体，内容稳定，才可以长缓存。

### 7.3 验收

- 新增浏览器回归 [`tests/static-cache.browser.mjs`](../games/arkhamhorror/tests/static-cache.browser.mjs)：
  同一缓存里第二次打开牌桌，卡图必须「有内容、零下行字节」（即不再复验）。
  注意**不能用 `page.route` 造开局**——Playwright 一旦启用请求拦截就会关掉浏览器缓存，那样量不到缓存命中。
- 新增大厅用例（`tests/hall/mod-boundary.test.mjs`）：摘要命中后条件请求**不应再读文件**、媒体长缓存、
  脚本仍 must-revalidate、文件内容变化后旧 ETag 立刻失效。
- 新增 Mod 用例（`tests/image-cache.test.mjs`）：CDN 缺图在重试窗口内只请求一次。
- 门禁：`node --test tests/hall/*.test.mjs`（114 例）、`games/arkhamhorror/tools/run-tests.mjs fast`（2336 例）、
  `tools/capture-view-hashes.mjs`（逐字节一致）、`playwright test render-perf`（p50 7.0 ms，与基线同量级）。

### 7.4 仍未处理（同一族问题，按收益排序）

1. **旧存档的体积**：`bg-2-mv9d7v5f` 这份真实存档原本 39.6 MB（事件里内嵌 25 MB 的整桌快照 +
   14 MB 检查点），加载一次才压缩到 2.6 MB。0.2.0 打包版**没有** `trimEventVisuals`，
   跑那个版本时每次行动都要序列化 ~40 MB。升级到当前版本后，旧存档会在第一次读取时自动压缩并备份。
2. **存档列表 `/api/sessions`**：每个存档都要 `readFileSync` + `JSON.parse` + `migrateState`。
   实测 76 个存档 / 52.4 MB → **729 ms 同步阻塞**。打开「存档管理」时全场卡住。
   修法是按 `(mtime, size)` 缓存摘要、并在记录之间让出事件循环。
3. **`.bak` 备份只增不减**：同一台机器上已有 **1166 个 / 851 MB**（每次迁移都会 `copyFileSync` 一份）。
   `pruneSnapshots` / `ttlMsFromEnv` 目前**没有任何调用方**。
4. **每次视图仍然全量下发** `state.cards`（约 900 KB，整章规则卡面）与整段事件历史（约 0.74 MB）；
   即路线图 §8.3 的「静态表只发一次」和「status 增量/省略」，属于协议改动，单独排期。
