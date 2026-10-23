# 诡镇联机性能优化路线（2026-10 重写）

> 状态：执行中；P0（基线 + 仪表 + harness）已完成（2026-10-23），下一阶段 P1。
> 范围：大厅 + 诡镇 Mod 的**联机热路径**；不含规则引擎优化、卡图加载、单机存档压缩。
> 基线：2026-10-23 手工实测（4 真人、夜之狂热第一关、revision 100–123）；P0 已用新 harness 复现并冻结，见 §1.6。

## 0. 摘要

一句话：**先删掉不该发的东西，再减少发的次数，最后才做客户端增量和渲染。**

旧版把顺序排成「`viewState` 公私拆分 → DOM morph → 浏览器 status 增量」。实测后三条都没有按原计划继续：

- `viewState` 的公共辅助函数合计 < 0.3 ms，拆分无收益；真正贵的是每席位 `structuredClone(state)` 和 `pick` 深拷 `cards` / `investigatorDefs`。
- DOM morph 在同一状态重绘下 p50 3.8 vs 3.9 ms，4x CPU 降速 16.2 vs 12.9 ms；整树构建占 75%，morph 省的是 25% 的挂载，还多付 diff 和监听器重绑。已回退。
- 浏览器 status 增量单做只省 3–5 ms 解析，相对 300 ms 的发布/往返是小项。

新路线按 **字节 → 发布次数 → 延迟语义 → 可选深度** 排序。P1/P2 是主线，P3 可选，P4 只在渲染仍是瓶颈时做。

**目标（4 人局）**

| 指标 | 现状 p50 | 目标 | 阶段 |
| --- | --- | --- | --- |
| 房主点击 → 桌面 | 330–420 ms | ≤ 200 ms（P1）/ ≤ 120 ms（P2） | P1 / P2 |
| 客人直连点击 → 自己屏幕 | 450–600 ms | ≤ 300 ms | P2 |
| 客人中转点击 → 自己屏幕 | 700–800 ms | ≤ 450 ms | P2 / P3 |
| 带 AI 的行动确认 | 5–30 s | ≤ 200 ms | P2 |
| 房主事件循环阻塞 | 291 ms | ≤ 150 ms（P1）/ ≤ 80 ms（P2） | P1 / P2 |
| 单次命令响应 | 1.10 MB | ≤ 300 KB（房主）/ ≤ 1 KB（客人） | P1 |
| 每次行动 status 总下行 | 3.3 MB | ≤ 1.1 MB（P1）/ ≤ 100 KB（P3） | P1 / P3 |
| `publishOnline`（4 席 / 250 步） | 123–130 ms | ≤ 60 ms | P1 / P3 |
| 4 人命令往返 | 317 ms | ≤ 200 ms（P1）/ ≤ 120 ms（P2） | P1 / P2 |

> P0 已用 `tools/perf-online-latency.mjs` 复现并冻结基线（§1.6）：从 P1 起，阶段出口以 harness 的 p50 做同机前后对比；上表「现状」列仍是手工口径，保留作历史参考。

## 1. 基线

### 1.1 测量条件

- 4 个真人席位、无 AI、夜之狂热第一关，revision 100–123。
- 4 个大厅 + 本机 relay 跑在同一个 Node 进程里；客人的命令仍走 `客人 → relay → 房主` 的真实代码路径，只是 RTT 是本机。
- 线上还要再叠加 1–2 段公网 RTT；relay 与房主同进程会让房主事件循环阻塞略偏高，量级不受影响。
- 数字来自 2026-10-23 的手工测量记录（本节保留原始口径）；P0 已用新 harness 复现并冻结成基线文件 `artifacts/perf/baseline-20261023.json`（本地，不入发布包），复现数据见 §1.6。

### 1.2 延迟

| 指标 | p50 | p95 |
| --- | --- | --- |
| 房主行动命令往返 | 317 ms | 399 ms |
| 客人行动命令往返（localhost relay） | 346 ms | 425 ms |
| 房主事件循环阻塞 | 291 ms | 331 ms |
| 命令响应 | 1.10 MB | 1.30 MB |
| `status` 响应 | 1.10 MB | 1.30 MB |
| 每次行动 serial 变化 | 2 次 | 2 次 |

### 1.3 单份席位视图构成（revision 100）

| 字段 | 大小 | 占比 |
| --- | --- | --- |
| `state.cards` | **785 KB** | 69% |
| `events` | 250 KB | 22% |
| `state.investigatorDefs` | 81 KB | 7% |
| 其余（investigators / campaign / log / …） | ~27 KB | 2% |

**76% 的字节是静态表**（`cards` + `investigatorDefs`），每次点击却要传四份。

### 1.4 每次行动实际拉取

| 项 | 体积 |
| --- | --- |
| 命令响应 | 1.1 MB |
| 2 次 `serial` 对应的长轮询 | 2.2 MB |
| `onlineUi.command` 末尾的显式 `refresh()` | 1.1 MB |
| **合计** | **≈ 4.4 MB / 次点击** |

> 上表是房主浏览器口径；`status` 总下行不含命令响应，命令响应另计 1.1 MB。

### 1.5 服务端热路径

- 一次行动可见 3–5 次 `publishOnline`（提交后、AI 后、`finally`、房间广播；上一版记录 3–17 次，P0 会以 harness 实测为准）。
- `sessionView`：`structuredClone(state)` + `pick` 逐字段 `structuredClone`（含 `cards` / `investigatorDefs`）+ 事件历史 clone + Mod 投影。
- `online.publish`：每席位 JSON 深拷贝 + diff + 2–3 次 `JSON.stringify` + 指标 stringify。
- 存档：`snapshotSession` 后异步写，不阻塞事件循环（已修）。

### 1.6 P0 复现（2026-10-23，`tools/perf-online-latency.mjs`）

环境：Windows / Node v22.23.1；4 个大厅 + 本机 relay 同进程；真实 campaignHub 开局（4 真人各选调查员 + 自动牌组），统计 100 步（预热 5 步）。基线文件 `artifacts/perf/baseline-20261023.json`（本地，gitignore）。

| 指标 | 手工基线（§1.2/§1.4） | P0 复现 p50（p95） | 偏差 |
| --- | --- | --- | --- |
| 房主行动命令往返 | 317 ms | 388 ms（464；n=9 ¹） | +22% |
| 客人行动命令往返（本机 relay） | 346 ms | 434 ms（514；n=91） | +25% |
| 房主事件循环阻塞 | 291 ms | 241 ms（288） | −17% |
| 命令响应 | 1.10 MB | 1.23 MB（1.33 MB） | +12% |
| `status` 响应 | 1.10 MB | 1.24 MB（1.32 MB） | +13% |
| 每次行动 `status` 总下行 | 3.3 MB | 3.73 MB（3.96 MB） | +13% |
| 每次行动 `publishOnline` 次数 | 3–5 | 3 | 同量级 |
| 每次行动 `publishOnline` 耗时 | — | 284 ms（343） | — |
| 阶段：commit / snapshot | — | 35 ms / 245 ms | — |
| 单席位视图（revision 120） | 1.10 MB：cards 785 / events 250 / defs 81 / 其余 27 KB | 1.26 MB：cards 833 / events 287 / defs 105 / 其余 29 KB | 结构一致 |

¹ 4 人局到第 4 轮后 seat0/1 按游戏机制阵亡、不再产生动作，host 样本因此偏少；`--moves=20` 时四席分布 5/5/4/6。三次复跑 host p50 为 361 / 364 / 388 ms。

**结论**：字节结构（静态表约占 2/3）、发布次数、阻塞量级与手工基线一致（±25% 内）。命令往返比手工基线高约 20%，主要是测量路径不同（手工记录 vs harness 的 HTTP 命令往返），**P1 起以本 harness 的 p50 作为前后对比口径**；旧口径的 317 ms 保留在 §1.2 作为历史参考。

复现命令：

```bash
node tools/perf-online-latency.mjs --moves=100 --json=artifacts/perf/baseline-20261023.json
node tools/perf-online-latency.mjs --moves=20 --baseline=artifacts/perf/baseline-20261023.json   # 回归 >20% 退出 1
```

## 2. 已完成、已否决、教训

### 2.1 已完成（保留，不要回退）

- `trimEventVisuals`：事件里的整桌演出快照只保留最近 24 条；250 步事件日志 8.27 MB → 0.42 MB。
- 视图按 revision 缓存（`cachedSessionView`）；`publishOnline` 跳过离线成员、内容未变跳过。
- 中转 room 广播按签名去重；`commitMove` 只序列化本次新内容；存档异步原子写。
- 静态资源摘要缓存 + 媒体长缓存；卡图失败负缓存。
- 服务端快照 delta（`snapshotChanges`）：35–116 KB vs 694 KB 全量。

### 2.2 已否决

| 尝试 | 实测 | 决定 |
| --- | --- | --- |
| DOM morph（旧阶段 B） | p50 3.8 vs 3.9 ms；p95 5.1 vs 4.6 ms；4x 16.2 vs 12.9 ms | 回退，不再做通用 morph |
| `viewState` 公私拆分（旧 A1） | 公共辅助每项 ≤ 0.05 ms，合计 < 0.3 ms | 暂停；改做 A1′ 共享 clone |
| 浏览器 status 增量单做（旧 C） | 解析 3–5 ms，渲染 4 ms | 降到 P3，先做 P1 / P2 |

#### 为什么不再做通用 DOM morph

- 整树重绘的耗时约 3 ms 花在「用 `h()` 把新树造出来」，约 1 ms 花在「挂上去并布局」；morph 仍然要造完整棵树，只省后者。
- 同状态（近零差异）基准下 morph 只打平，说明 diff 的成本 ≈ 挂载的成本；真实变化还要再加 patch，必然更慢。
- 4x CPU 降速下基线 3.9→12.9（3.3x），morph 3.8→16.2（4.3x），多出来的部分就是被放大的纯 JS diff。
- `h()` 每次 render 都创建新的监听器闭包，morph 无法判断等价，只能整组重绑；事件委托已经覆盖大部分交互，保节点收益很小。
- 496 个节点太小，diff 的固定成本摊不薄；牌桌主体还是 Mod 返回的真实 DOM，大厅无法安全地深入 diff。

> 如果将来要做虚拟 DOM，必须先让 `h()` 返回 vnode，并给 Mod UI 提供组件/区域契约；那是平台级重写，单独立项，不放进本路线。

### 2.3 教训

1. **先量阶段，再谈优化**：4 ms 的渲染只占 300–400 ms 点击的 1%。
2. **先删工作，再做增量**：morph 在全量构建之后打补丁，等于建两遍。
3. **一次行动只应有一次全量下发**：重复 publish / 重复 refresh 是最大浪费。
4. **优化 75%，不是 25%**：省 1 ms 的挂载不会改变体感。
5. **协议改动必须带字节和隐私门禁**：视图可以裁剪，但不能改变「谁能看到什么」。

## 3. 目标、原则与约束

### 3.1 目标

以「点击到屏幕」为准，不以单函数微秒数为准：

- P1 结束：房主点击 ≤ 200 ms，阻塞 ≤ 150 ms，命令 ≤ 300 KB，status 总计 ≤ 1.1 MB。
- P2 结束：房主点击 ≤ 120 ms，直连客人 ≤ 300 ms，AI 确认 ≤ 200 ms，阻塞 ≤ 80 ms。
- P3 结束：中转客人 ≤ 450 ms，status ≤ 100 KB，`publishOnline` ≤ 60 ms。
- P4（条件）：render p95 ≤ 8 ms，或渲染占点击 < 10%。

### 3.2 原则

1. **端到端优先**：每次改动都要能回答「哪个指标、降多少、怎么测」。
2. **先减字节，再减次数，最后才做增量/渲染**。
3. **一次行动最多 1 次命令响应 + 1 次最终快照 + 1 次 status**；禁止命令后再无条件 `refresh()`。
4. **线协议只增可选字段**：旧客户端、旧中转不崩；静态表/增量缓存必须能回退全量。
5. **每个优化独立开关**（env / capability），可单独回滚。
6. **隐私、重连、存档兼容是硬约束**：`view-privacy`、4 人 240 步、房主重启必须全绿。
7. **不改 relay 协议**；房主↔浏览器与房主↔客人分开改。
8. **存档永远写全量**；省略只发生在 wire。

### 3.3 硬约束

- 私有信息（别人的手牌、牌库顺序、私聊、未触发剧情）不得进入公共静态表或其他席位视图。
- 任何 wire 变化都要有「全量回退」路径；缓存错位只能表现为「变慢」，不能表现为「显示旧状态却可操作」。
- 联机两端版本不一致时仍然拒绝加入；本次路线不改变版本握手语义。
- 存档格式不变；静态表和增量只存在于运行期。

## 4. 路线

### P0 基线与仪表（1–1.5 天）

**目标**：把「感觉慢」变成可复现的分阶段数字。

- 新增 `tools/perf-online-latency.mjs`：
  - 用 `createServer` 起 4 个大厅（不同端口 / `DSH_HOME`）+ 本机 relay；
  - 建房、加入、准备、开局，按脚本推进 N 步（默认 100），可配 `--ai=0|2`；
  - 记录：命令往返、房主事件循环阻塞、命令响应字节、status 字节、每次行动的 `publishOnline` 次数、serial 变化次数；
  - 输出 JSON + 表格，支持 `--baseline <file>` / `--compare <file>`。
- 大厅加 `BOARDGAME_PERF=1`：
  - `snapshotSession`：view build / publish / save 分阶段；
  - `publishOnline`：视图缓存命中、每席位 deep copy / diff / encode、成员数；
  - `onlineCommand`：commit / reactions / AI / publish / save；
  - 写入 `DSH_HOME/perf.jsonl`，默认关闭。
- 浏览器：复用 `?perf=1`，补 `window.__ONLINE_PERF__`（status / command 字节、render 次数、apply 耗时）。
- 基线文件：`artifacts/perf/baseline-20261023.json`（本地，不入发布包）。

**验收**：同一台机器复现 317 ms ±20%；能回答「这次点击发了几次 publish、几字节、各阶段多少 ms」。
**回滚**：纯观测，无行为变化。

**状态：已完成（2026-10-23）** ✅

- `tools/perf-online-latency.mjs`：`--setup=hub|fast`（默认 hub，真实开局）、`--seats/--moves/--warmup/--ai/--seed/--status`、`--json/--baseline/--compare`、回归 >20% 退出 1；每动作 host/guest 分组与阶段明细。
- 服务端：`lib/perf.js` + `lib/server.js` / `lib/online.js` 埋点，`BOARDGAME_PERF=1` 开启、默认关闭；`DSH_HOME/perf.jsonl`（`BOARDGAME_PERF_FILE=0` 关闭）、事件循环延迟直方图、`publish.member` 分项。
- 浏览器：`public/perf.js` + `public/app.js` / `online-ui.js` / `p2p.js`，`?perf=1` 时 `window.__ONLINE_PERF__`（requests / commands / applies / renders + `summary()`），默认访问零新增请求。
- 基线：`artifacts/perf/baseline-20261023.json`，复现数字见 §1.6（host p50 388 ms、阻塞 241 ms、命令/status 1.2 MB、status 下行 3.7 MB、publish 3 次）。
- 新增用例：`tests/hall/perf.test.mjs`、`tests/hall/online-perf-ui.test.mjs`；大厅浏览器回归 `online.browser.mjs` 3/3 通过。
- 已知既有失败（与本阶段改动无关，属 Arkham 仓库当前提交状态）：`tcu-migration.test.mjs` / `tcu-rules.test.mjs` 缺 `artifacts/migration/tcu/*.json` 生成产物；`capture-view-hashes.mjs` 基线未随「迁移四循环」提交更新。P1 需要视图逐字节门禁时改用 hydration 等价性用例，不以该过期基线为准。

### P1 字节与重复发布（3–4 天）

> 目标：单次命令 ≤ 300 KB，每次行动 status 总下行 ≤ 1.1 MB，房主阻塞 ≤ 150 ms。
> 这一阶段不改延迟语义（仍然等 AI），只砍数据面。

#### P1.1 busy 轻量消息（0.5 天）

**现状**：`busy` 变化会触发整份 snapshot；`finally` 里 `publishOnline` 再发一次全量。

**改动**：
- `lib/online.js` 增加 `publishStatus(member, { busy, lobby, revision, snapshotId })`。
- 不为 relay 新增消息类型：复用现有 `snapshot` 信封，payload 加 `kind: 'status'`，relay 原样转发即可。
- 客户端 `online-ui.accept` 只更新 `state.online.busy/lobby`，不替换 session。
- 用 `snapshotId` / `revision` 防止旧 status 覆盖新快照；最终快照携带 `busy: false`。
- status 不进入 `sentSnapshots` 的 delta 基线，否则下一次全量/增量会以错误 base 计算。
- `publishOnline` 的 `finally` 只在内容真的变化时才发全量；busy 单独走 status。

**预期**：每次行动 −40–70 ms，少一次全量发布。

**风险**：status 先于最终快照到达，导致按钮提前可用。客户端必须等 `revision` / `snapshotId` 匹配。

**验收**：4 人 240 步 busy 切换正确；断线重连后 busy 一致。

#### P1.2 命令响应瘦身 + 去掉命令后的 refresh（1 天）

**现状**：`onlineCommand` 返回完整 `cachedSessionView`；`online-ui.command` 之后 `refresh()`；`run()` 再 `refresh()` 一次。

**改动**：
- 房主：仍返回自己的视图（本地渲染需要）。
- 客人：只返回 `{ ok, sessionId, revision, eventCount, busy }`；状态由随后的 snapshot / 长轮询送达。
- 客人侧 `app.js` / Mod UI（`game-ui.js`、`hub.js`）不能假设 `r.session` 一定存在：`session` 改为可选，snapshot 到达后再替换；乐观落子保留到 snapshot 覆盖。
- `online-ui.command`：move / chat 成功后不再 `refresh()`；只有 `start` / `reset` / `leave` 等无 session 返回的动作才刷新。
- `run()` 不再对 command 包一层 refresh；错误路径保留一次 `GET /status` 兜底。
- 直连 `p2p.command` 同样只等 snapshot，不额外拉全量。

**预期**：每次行动 −1.1 MB；客人 −20–100 ms。

**风险**：客人响应先到、snapshot 后到，UI 会短暂看到旧状态。用 `busy` / `revision` 占位，不把旧状态当可操作。

**验收**：客人点击后 300 ms 内看到自己的行动；4 人测试；无重复 refresh；全仓 `r.session` 调用点审计，客人路径下 `session` 缺失不抛错。

#### P1.3 序列化清理（0.5 天）

**现状**：`online.publish` 每席位 `JSON.parse(JSON.stringify(...))`、`JSON.stringify(delta)` / `JSON.stringify(full)`、metrics 再 stringify。

**改动**：
- `sessionView` 每 revision 产生新对象，`publish` 不再防御性深拷贝（加注释与测试保证不突变）。
- `fullJson = JSON.stringify(full)` 只算一次；delta 也用字符串长度比较。
- `sendRaw` 直接发字符串，避免 socket 层二次 stringify。
- metrics 字节只在 `BOARDGAME_PERF=1` 时计算。

**预期**：每客人 15–25 ms → 5–10 ms。

**风险**：共享视图被下游修改；开发环境加 `Object.freeze` 或测试断言，生产保留注释。

**验收**：`online-sync.test.mjs` + 4 人测试；profile 无回退。

#### P1.4 静态表只发一次（1–1.5 天）

**现状**：`viewState` 的 `pick` 每席位 `structuredClone(cards)` + `structuredClone(investigatorDefs)`；每份视图 866 KB。

**设计**：
- 会话级 `staticVersion`（`mod.id + mod.version + hash(publicCards + investigatorDefs)`，开局 / 读档算一次）。
- 首次视图带 `static: { version, cards, investigatorDefs }`；客户端按 `sessionId` 缓存。
- 后续视图带 `staticVersion`，不带两表；客户端 `hydrate(session)` 后再渲染。
- 请求带 `clientStatic=<version>`（status / command 查询参数），命中才省略；未命中回全量。
- host 与 guest 都按「浏览器缓存 + hall 缓存」两层处理：host 依据本地浏览器的 `clientStatic` 决定是否省略；guest hall 在 `receiveSnapshot` 时保留 `static`，浏览器刷新后由 guest hall 补发，不要求重新向 host 要全量。
- **公共静态表只能是公共卡面**：自愈补进来的本人手牌定义走 `privateCards` 小补丁，不得把某个席位的视图表当公共表缓存。
- `includeStatic=false` 时，自愈判断不能依赖空的 `view.cards`：由大厅传入已知公共卡号集合（或会话级公共表索引），只补公共表里没有、且观察者可见的定义。
- 新增的公共卡面走 `cardsPatch`；静态表版本变化时允许一次全量重发。
- 存档仍写全量。

**Mod 改动**：`viewState(state, seat, { includeStatic })`；`includeStatic=false` 时跳过两表，并把自愈结果放进 `privateCards`。

**预期**：1.1 MB → ~300 KB；publish CPU −20–40 ms；客人 −80–200 ms。

**风险**：客户端 hydration 漏字段导致牌桌空白；私有卡面混入公共表造成泄漏；刷新后缓存丢失需回全量。

**验收**：
- 新单测「hydrated view 与全量 view 逐字节一致」；
- `view-privacy` 全绿，新增「公共表不含私有卡面」断言；
- 刷新 / 换局 / 版本变化回全量；
- 4 人 240 步。

#### P1.5 发布合并（1 天）

**现状**：一次行动 3–5 次 `publishOnline`，其中多次内容相同或只差 busy。

**改动**：
- `schedulePublish()`：标脏后在 `setImmediate` / 微任务合并，窗口内只发最后一次；命令响应前 `flushPublish()`。
- AI 连续动作在短窗口内合并；事件已累积，客户端按 `seq` 回放；最终状态必须 flush。
- `finally` 的 busy 走 P1.1 的 status，不再触发全量。

**预期**：publish 次数 3–5 → 1–2；房主 −40–120 ms。

**风险**：跳过中间快照导致演出不连贯；用事件序列回放，加浏览器用例确认 AI 动作可见。

**验收**：4 人 240 步；AI 2 人局动作不丢；`publishOnline` 计数断言。

#### P1 出口

- 命令响应 ≤ 300 KB；每次行动 status 总下行 ≤ 1.1 MB；房主阻塞 ≤ 150 ms；4 人命令往返 ≤ 200 ms。
- `test:hall`、`test:fast`、4 人联机、`view-privacy`、浏览器回归全绿。
- 视图哈希（hydration 后）不变；静态表相关的 wire 变化有独立 fixture。

### P2 延后与解耦（2.5–4 天）

> 目标：房主点击 ≤ 120 ms，带 AI 确认 ≤ 200 ms，直连客人 ≤ 300 ms。
> 这一阶段改时序 / 并发语义，风险高于 P1。

#### P2.1 非行动者视图延后（1 天）

**现状**：`onlineCommand` 返回前 `publishOnline` 为所有席位建视图；4 席约 60–80 ms。

**改动**：
- 先构建行动者视图并随响应返回；
- 其他在线席位 `setImmediate` 后台构建 / 发布，同一 revision 合并；
- 行动者的 `onlinePublishedViews` 标记已发，避免重复；
- busy=false 随最终快照 / status 发送。

**预期**：房主同步阻塞 −50–70%，点击 −55–65%。

**风险**：其他玩家短暂落后；下一动作在其他人收到前开始（busy 锁仍阻止）；测试顺序。

**验收**：4 人点击后各自 ≤ 2 帧内更新；无 stale revision 提交。

#### P2.2 AI 回合与回包解耦（1.5–2 天）

**现状**：`onlineCommand` `await runAiTurns`，客人等 5–30 s。

**改动**：
- 提交人类动作后立即返回 `{ revision, eventCount, aiPending: true }`（房主可带自己的视图）；
- `busy` 保持 true；后台 `runAiTurns`，每步 / 最终 `publishOnline`；
- AI 失败 / 超时通过 `session.events` 的 `agentError` + status 暴露，不再只靠 HTTP 错误；
- `start` / `reset` 同样先返回，再后台跑先手 AI；
- 客户端显示「AI 思考中」，允许聊天，不允许下一步行动；
- 服务器重启后按存档恢复并继续。

**预期**：AI 确认 5–30 s → 100–200 ms；体感最大收益。

**风险**：错误传播、并发 / 重入、客户端 `working` 状态、重连时 AI 仍在跑。

**验收**：
- 假模型延迟 3 s，点击 200 ms 内确认；
- AI 完成后状态一致；
- AI 失败可见；
- 双击不重复跑；
- 重启恢复。

#### P2.3 直连命令事件化（0.5–1 天）

**现状**：`p2p.command` 收到 result 后每 100 ms 轮询 `/online/status`，等本地 revision。

**改动**：
- `directSnapshot` 返回的 status 直接用于解析等待者；
- `waitForRevision(revision)` Promise，由 `directSnapshot` / `receiveSnapshot` 触发；
- 若 snapshot 先于 result 到达，立即 resolve；
- 去掉 100 ms 轮询。

**预期**：直连客人 −0–100 ms（均值约 50 ms）。

**风险**：直连与中转切换时 Promise 悬挂；超时回退一次 status。

**验收**：直连 / 中转切换；4 人测试；无轮询请求。

#### P2 出口

- 房主点击 ≤ 120 ms；直连客人 ≤ 300 ms；AI 确认 ≤ 200 ms；房主阻塞 ≤ 80 ms。
- 4 人 240 步、AI 2 人、断线重连、房主重启全绿。

### P3 深度优化（2–3 天，可选）

> 只有 P1 / P2 后仍不达标才做；每项独立评估。

#### P3.1 浏览器 status 增量（1–1.5 天）

- `stamp = sessionId:revision:eventCount[:staticVersion]`；服务端保留最近 2–3 份已发视图。
- 响应三选一：全量 / `sessionDelta` / `sessionOmitted`。
- 客户端严格校验 `baseStamp`，异常回全量。
- 预期 status ≤ 40 KB，解析 −80%。
- 风险：基线错位显示旧状态；失败模式必须是「变慢不变错」。

#### P3.2 A1′ 共享 state clone（0.5–1 天）

- `viewStateSharesState` 逐 Mod 开关；每 revision 只 `structuredClone(state)` 一次，四席共用。
- `cards` 自愈改 copy-on-write；加「视图期间权威 state 哈希不变」断言。
- 预期 −15 ms / publish。
- 风险：Mod 写共享 state；默认关闭，Arkham 先开。

#### P3.3 直连转发零拷贝（1 天）

- 房主浏览器不再 `JSON.parse` / `stringify` 每个 snapshot；服务端切 12 KB 片或浏览器按字符串切片。
- 预期 −5–15 ms / 客人。
- 风险：校验 / 分片边界；保留解析兜底。

#### P3.4 网络（非代码）

- Render 付费 / 换区域、自建 relay、TURN 提高直连率。
- 预期中转客人 −250–300 ms。
- 验收：真实跨网一次建房 / 加入 / 落子。

### P4 渲染（条件触发，2–3 天）

> 只有 P1–P3 后 render p95 > 8 ms 或占点击 > 10% 才做。**不做通用 DOM morph。**

- 区域级更新：手牌 / 时间线 / 动作栏 / 日志各自按 key 更新，不整页 diff。
- 静态子树缓存：地点地图、卡表、规则书面板，按 revision / 输入复用。
- 渲染合并：一次网络批次只 render 一次；`run()` / `finally` 不重复 render。
- 事件委托 + `data-action`，动态区域不建闭包监听器。
- 验收：render p95 ≤ 8 ms；50+ 浏览器用例；输入 / 滚动 / 动画不回归。
- 如果做虚拟 DOM：`h()` 必须返回 vnode，且 Mod UI 提供组件 / 区域契约——平台级重写，单独立项。

## 5. 验收与门禁

### 5.1 指标表

| 指标 | 现状 | P1 出口 | P2 出口 | P3 出口 |
| --- | --- | --- | --- | --- |
| 房主点击 → 桌面 | 330–420 ms | ≤ 200 ms | ≤ 120 ms | — |
| 直连客人点击 → 屏幕 | 450–600 ms | ≤ 400 ms | ≤ 300 ms | — |
| 中转客人点击 → 屏幕 | 700–800 ms | ≤ 600 ms | ≤ 500 ms | ≤ 450 ms |
| AI 行动确认 | 5–30 s | 5–30 s | ≤ 200 ms | — |
| 房主事件循环阻塞 | 291 ms | ≤ 150 ms | ≤ 80 ms | — |
| 单次命令响应 | 1.10 MB | ≤ 300 KB | ≤ 300 KB | — |
| 每次行动 status 总下行 | 3.3 MB | ≤ 1.1 MB | ≤ 1.1 MB | ≤ 100 KB |
| `publishOnline`（4 席 / 250 步） | 123–130 ms | ≤ 90 ms | ≤ 70 ms | ≤ 60 ms |
| 4 人命令往返 | 317 ms | ≤ 200 ms | ≤ 120 ms | — |

### 5.2 每次提交必须跑

```bash
# 大厅回归
node --test tests/hall/*.test.mjs

# 4 人联机 + 隐私（约 2 分钟）
node --test games/arkhamhorror/tests/hall-online.test.mjs

# 诡镇规则 / 集成 / golden replay
cd games/arkhamhorror && node tools/run-tests.mjs fast

# 观察视图逐字节门禁
cd games/arkhamhorror && node tools/capture-view-hashes.mjs

# 服务端热路径基准
node tools/perf-online-snapshot.mjs --seats=4 --moves=250

# 联机延迟基准（P0 harness；默认 hub 开局，--moves=20 约 20 秒）
node tools/perf-online-latency.mjs --moves=20
```

浏览器：

```bash
node node_modules/@playwright/test/cli.js test --config tests/hall/playwright.config.mjs
node node_modules/@playwright/test/cli.js test --config games/arkhamhorror/playwright.config.mjs
```

### 5.3 新增门禁

- **字节**：`tests/hall/online-payload.test.mjs` 断言 4 人 fixture 的命令 / status ≤ 阈值（宽松，只防数量级退化）。
- **隐私**：静态表 hydration 后与全量视图逐字节一致；私有卡面不在公共表。
- **性能**：`tools/perf-online-latency.mjs --moves=100 --baseline=artifacts/perf/baseline-20261023.json`：文件不存在时写入本次基线，存在时比较，核心指标（host/guest 命令往返、命令字节、status 下行、publish 次数、阻塞）比基线差 >20% 退出 1（不进默认 `npm test`，CI nightly / release 跑）。只做同机前后对比，绝对值不当浏览器指标。
- **顺序**：busy / status 不乱序；coalescing 不丢最终状态。

### 5.4 回滚

- 每项一个 env：`BOARDGAME_ONLINE_BUSY=0`、`..._SLIM_RESPONSE=0`、`..._STATIC=0`、`..._COALESCE=0`、`..._DEFER=0`、`..._AI_BACKGROUND=0`。
- 客户端 `?online=legacy` 或 capability 缺失 → 全量路径。
- 静态表 / 增量任何异常回全量。
- 协议只增可选字段，旧中转不受影响。

## 6. 里程碑

| 阶段 | 内容 | 工作量 | 出口指标 |
| --- | --- | --- | --- |
| P0 ✅ | harness + 仪表 + 基线（2026-10-23 完成） | 1–1.5 天 | host 命令往返 p50 388 ms、阻塞 241 ms、status 下行 3.7 MB（§1.6） |
| P1 | busy / slim / 序列化 / 静态表 / 合并 | 3–4 天 | 命令 ≤ 300 KB；阻塞 ≤ 150 ms |
| P2 | 延后 / AI 解耦 / p2p 事件 | 2.5–4 天 | 点击 ≤ 120 ms；AI ≤ 200 ms |
| P3 | status delta / A1′ / 零拷贝 / 网络 | 2–3 天 | status ≤ 100 KB；relay ≤ 450 ms |
| P4 | 区域渲染（条件） | 2–3 天 | render p95 ≤ 8 ms |

## 7. 上线

1. 每项独立提交，提交信息写清基线 / 门禁结果。
2. 先本地 / 内测开 flag，4 人局跑 3 局，再默认。
3. 大厅版本 bump（wire 变化）；诡镇 Mod 版本 bump（`viewState` 签名变化）。若第三参写进 Mod 契约文档，属于向后兼容扩展，`HALL_API` 不必 bump，但 `lib/mods.js` 注释要同步。
4. relay 不动；旧中转仍可建房。
5. 保留上一版一个 release 的全量回退路径。
6. 诡镇改动在 `games/arkhamhorror` 独立仓库提交并推送；大厅不跟踪该目录内容。
7. 本路线不引入持久化格式变更；静态表和增量都只存在于运行期。

## 8. 未决问题

1. **静态表按会话还是按席位缓存**：需要先统计 10 个真实存档里自愈补卡的分布；公共表与私有 `privateCards` 的边界要写死。
2. **发布合并与 AI 演出**：客户端能否只靠 `events.seq` 回放被合并的中间态；需要浏览器验证。
3. **AI 后台化后的 busy 语义**：是否允许排队下一动作；建议不允许，保持单飞行。
4. **直连 snapshot 与 result 的到达顺序**：不同浏览器是否稳定；需实测 Chrome / Edge。
5. **P3.1 status delta 在静态表落地后是否仍值得**：先测再决定。
6. **存档体积**（约 1.5 MB / 12 ms）是否要单独优化：当前不影响点击延迟。

## 9. 附录

### 9.1 指标口径

- **房主点击**：`pointerup` 到桌面 revision 更新。
- **客人点击**：`pointerup` 到本地屏幕应用该 revision。
- **AI 确认**：提交到自己的行动可见；不含 AI 实际思考时间。
- **房主阻塞**：一次命令内同步 JS + publish + save 的主线程时间（event-loop delay）。
- **字节**：HTTP `content-length` + WS / DataChannel payload；gzip 前后都记。

### 9.2 关键文件

- 大厅：[lib/server.js](../lib/server.js)（`sessionView` / `cachedSessionView` / `publishOnline` / `onlineCommand` / `snapshotSession`）、[lib/online.js](../lib/online.js)（`publish` / `command`）、[lib/online-sync.js](../lib/online-sync.js)、[lib/perf.js](../lib/perf.js)（P0 埋点，`BOARDGAME_PERF=1`）。
- 浏览器：[public/online-ui.js](../public/online-ui.js)（`accept` / `command` / `refresh`）、[public/p2p.js](../public/p2p.js)（`command` / `receive`）、[public/app.js](../public/app.js)（`render` / `rawApi`）、[public/perf.js](../public/perf.js)（`?perf=1` → `window.__ONLINE_PERF__`）。
- Mod：[games/arkhamhorror/src/integration/observation.js](../games/arkhamhorror/src/integration/observation.js)（`viewState` / `pick`）。
- 基准：[tools/perf-online-snapshot.mjs](../tools/perf-online-snapshot.mjs)、[tools/perf-online-latency.mjs](../tools/perf-online-latency.mjs)（P0 主 harness）、[games/arkhamhorror/tests/render-perf.browser.mjs](../games/arkhamhorror/tests/render-perf.browser.mjs)；冻结基线 `artifacts/perf/baseline-20261023.json`（本地）。

### 9.3 旧结论存档

上一版（已删除）的 A0 / A3（逐字节基线、隐私断言）结论继续有效；B（morph）与 C（status delta）的实测见 §2.2，不再重复论证。
