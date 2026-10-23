# 诡镇联机性能路线图（#2 → 渲染 → #1）

本文件是接下来三项优化的执行计划，顺序固定为：

1. **#2 `viewState` 公私拆分**（带逐字节门禁 + 隐私断言）
2. **前端渲染局部更新**（DOM morph）
3. **#1 浏览器增量协议**（`/api/online/status` 走 delta）

诊断数据与已完成的修复见 [`arkham-online-performance.md`](arkham-online-performance.md)；本文只写「接下来怎么改、怎么验收、怎么回滚」。

## 当前进度

| 项 | 状态 | 结论 |
|---|---|---|
| A0 逐字节基线 | ✅ | 15 夹具 / 55 席位视图，确定性已验证；门禁命令 `node tools/capture-view-hashes.mjs` |
| A3 隐私断言 | ✅ | 新增 5 条断言；顺带修掉「卡面自愈把别人手牌卡面补进本席位视图」的既有泄漏 |
| A1 公共部分拆分 | ⏸ 重估 | 实测公共计算每项 ≤0.05 ms，拆分无收益；改为共享 clone/静态表（A1′，约省 15 ms/次发布） |
| B 渲染优化 | ❌ 取消 | 实测整树重绘 p50 ≈4 ms（496 节点）；morph 原型无收益（差异被 `h()` 建树成本淹没），已回退 |
| C 增量协议 | 未开始 | 前端解析/渲染都不是瓶颈，应改做「减少发布次数 / 回包解耦」 |

## 0. 为什么是这个顺序

| 顺序 | 理由 |
|---|---|
| #2 先做 | 纯服务端、与前端解耦；收益立即可测（`publishOnline` 里的视图部分 45–90 ms，目标 ≤25 ms）；门禁是纯数据的（逐字节对比），最容易验证 |
| 渲染第二 | 体感大头在「整树重建 + 卡图重建」；先降渲染成本，#1 的解析收益才看得出来，否则省下的几毫秒会被渲染淹没 |
| #1 最后 | 协议改动风险最高（基线错位会显示旧状态），只有在 A/B 之后仍有明确收益才值得做；且它只改「本机大厅 ↔ 自己浏览器」，**不改中转协议**，不影响两人联机兼容性 |

每个阶段自带开关与回滚点，任何一步测不出收益就停在那一步，不往下推。

## 1. 阶段 A：#2 `viewState` 公私拆分

### A0 ✅ 逐字节基线（已完成）

- 工具：[`games/arkhamhorror/tools/capture-view-hashes.mjs`](../games/arkhamhorror/tools/capture-view-hashes.mjs)
  - `node tools/capture-view-hashes.mjs --write` 生成基线（`--write` 只在有意改变视图时用）；
  - `node tools/capture-view-hashes.mjs` 校验，不一致退出码 1。
- 基线：[`tests/fixtures/view-hashes.json`](../games/arkhamhorror/tests/fixtures/view-hashes.json)（`artifacts/` 被 .gitignore 忽略，所以放 tests/fixtures）。
- 覆盖：15 个夹具 / 55 份席位视图——战役 hub、关卡开场、中局（40/80/120 步）、首次出现的每种待决选择（mulligan / turnOrder / playerWindow / commit / reaction / discard / agenda）、私人技能检定、1/2 席位对照。
- 确定性已验证：同一份代码连续两次生成，文件哈希相同。
- 门禁语义：`JSON.stringify` 对键顺序敏感，所以「哈希一致 = 视图逐字节一致」，重构只能改「值的来源」，不能改对象字面量的构造顺序。

### A1 ⏸ 公共部分拆分：实测后重估（**收益不足，暂停**）

在动 `viewState` 之前先量了它到底花在哪（4 席、`view-hash-baseline` 种子、第 80 / 250 步）：

| 环节 | 第 80 步 | 第 250 步 |
|---|---|---|
| `viewState` 单席位（JIT 热） | 2.75 ms | 5.78 ms |
| `viewState` × 4 席 | 11.3 ms | 25.4 ms |
| `structuredClone(state)` 单次 | 1.87 ms | 3.5 ms |
| `structuredClone(cards)` / `(investigatorDefs)` | 0.70 / 0.35 ms | 1.09 / 0.44 ms |
| `campaignView` / `campaignStory` / `campaignProjection` / `abilityUsage` / `setAside` / `timeline` | 每项 ≤0.05 ms | 每项 ≤0.05 ms |
| `legalMoves`（仅行动席位） | 0.43 ms | 0.43 ms |

结论：**计划里的「公共计算很贵、抽出来共享」不成立**——所有公共辅助函数加起来不到 0.3 ms。
真正的开销是「每个席位一次 `structuredClone(state)`」和「`pick` 里逐席位深拷 `cards` + `investigatorDefs`」，
合计约 **15 ms / 次发布**（250 步、4 席），只占 `publishOnline` 的约 11%。

因此调整 A1 的范围（A2 并入）：

#### A1′（修订版）：共享「每 revision 只克隆一次」的数据

1. 大厅侧：`sessionView` 每 revision 只 `structuredClone(state)` 一次，四个席位共用（[`lib/server.js:485`](../lib/server.js#L485)）；用 Mod 声明位 `viewStateSharesState: true` 控制，未声明的 Mod 保持逐席位克隆。
2. Mod 侧：`viewState` 里 `pick` 对 `cards` / `investigatorDefs` 两个大表改「按引用」而不是 `structuredClone`（[observation.js:115](../games/arkhamhorror/src/integration/observation.js#L115)），并用同样的字段顺序构造，保证 A0 哈希不变。
3. 前置（必须）：把卡面自愈改成**视图本地 copy-on-write**（见 A3 已完成的观察者过滤），不再写共享的 `state.cards`；否则 A 席位补进来的卡面会污染 B 席位。
4. 预期：4 席视图部分 40 ms → ~25 ms；`publishOnline` 约 133 ms → ~118 ms。
5. 门禁：A0 哈希 + `test:fast` + 四真人联机。

> 若这一项的收益仍不值得，**直接跳到阶段 B**——它不影响任何用户可见的正确性，只是省 15 ms。

### A3 ✅ 隐私断言（已完成，并修掉一个既有泄漏）

- 新增 [`tests/view-privacy.test.mjs`](../games/arkhamhorror/tests/view-privacy.test.mjs)（已进 `FAST_TESTS` 与 `node-suite`），断言：
  别人手牌/压牌为空、别人牌组不下发、非应答者 `pendingChoice.options` 为空、非行动席位 `legalMoves` 为空、私人检定与私人日志不外泄、`viewEvents` 过滤 `privateSeat` 并遮蔽演出快照里的手牌。
- **实测发现一个既有泄漏**：`viewState` 的卡面自愈调用 `embeddedCardDefs(state, campaignId)` 时收集了**所有**席位的手牌/牌组/压牌，导致 A 席位触发自愈时，B 的手牌卡面被补进 A 的 `view.cards`（等于泄露「他有这张牌」；虽然只是卡面定义、不是手牌列表，协作游戏里影响有限）。
- 修复：`embeddedCardDefs` 增加可选 `{ observerSeat }`（[card-defs.js:149](../games/arkhamhorror/src/engine/card-defs.js#L149)）——建局/存档快照不传参数仍取全量，观察投影传 `{ observerSeat }` 只取「公共可见 + 本人手牌/牌组」（[observation.js:203](../games/arkhamhorror/src/integration/observation.js#L203)）。
- 验证：A0 逐字节哈希不变（夹具里没有触发自愈）；`test:fast` 2335/2335；大厅 113/113。

### A4. 验收

| 指标 | 目标 | 现状 |
|---|---|---|
| 逐字节哈希 | 100% 一致（含键顺序） | ✅ 15 夹具 / 55 席位视图，确定性已验证 |
| 隐私断言 | 全部通过（含新增矩阵） | ✅ 5 条新断言 + 既有四真人 240 步断言 |
| 回归 | `test:fast` + 大厅 113 例 + 四真人联机 7 例 | ✅ 2335/2335、113/113、7/7 |
| `publishOnline`（4 席，250 步） | 做 A1′ 后：视图部分 40 → ~25 ms，总耗时 133 → ~118 ms；不做则维持现状 | ⏸ A1′ 待定 |

**回滚**：A0/A3 不改变任何对外协议与存档格式（`embeddedCardDefs` 只在观察投影传参），出问题直接 revert；A1′ 的 `viewStateSharesState` 是逐 Mod 开关，可单独关掉。

## 2. 阶段 B：前端渲染局部更新（DOM morph）——❌ 已取消（实测无收益）

### B0 ✅ 测量工具与基线

- 工具：[`tests/render-perf.browser.mjs`](../games/arkhamhorror/tests/render-perf.browser.mjs)（系统 Edge）+ [`public/app.js`](../public/app.js) 里 `?perf=1` 的埋点：
  - `window.__HALL_BENCH_RENDER__(n)`：在同一局面上反复整树重绘并强制同步布局；
  - 每次 `render()` 的耗时记录进 `window.__HALL_RENDER_MS__`（默认关闭）。
- 场景：真实大厅 + 真实诡镇（`legacyAutoStart`，1 人），中途抽 14 张牌后约 **496 个 DOM 节点**。
- 基线（连续 20 次）：

| 工作负载 | p50 | p95 |
|---|---|---|
| A：同一状态整树重绘（含同步布局） | 4.0 ms | 5.0 ms |
| B：真实小改动（开/关时间线，每次触发完整 render） | 2.6 ms | 4.8 ms |
| C：把 CPU 降速 4 倍（模拟低端机器） | 13–36 ms | 33–52 ms（抖动大） |

### B1–B3 原型结论：morph 不划算

按计划实现了 `public/dom-morph.js`（同构补丁：属性/子节点/监听器差异，`h()` 记录监听器，`render()` 改为 morph），并用同一套基准做 A/B：

| 工作负载 | 整树替换（原路径） | morph |
|---|---|---|
| A p50 / p95 | 3.9 / 4.6 ms | 3.8 / 5.1 ms |
| 4 倍降速 p50 | 12.9 ms | 16.2 ms |

**原因**：整树重绘的耗时主要花在「用 `h()` 把新树造出来」（约 3 ms / 496 节点），
而不是「把新树挂上去并布局」（约 1 ms）。morph 省掉的是后者，却要额外走一遍差异比对，
两者相抵，甚至略慢。真要再降，只能避免建树（子树缓存 / 虚拟 DOM），那是更大的重写，
与收益不成比例。

**决定**：回退 morph 相关改动（`dom-morph.js`、`h.bind`、`render()` 接入、`data-morph` 标记），
只保留 `?perf=1` 埋点与 `render-perf.browser.mjs` 作为回归护栏（防止将来渲染性能数量级退化）。

> 结论：**前端渲染不是卡顿来源**。同一份数据里，房主一次 `publishOnline` 约 130 ms、
> 中转两段往返约 400 ms，比浏览器一次 4 ms 的重绘高两个数量级。

### 下一步建议（按收益排序）

1. **AI 回合与回包解耦**：客人的行动请求目前要等 `runAiTurns` 把整轮 AI 跑完才回包（十几秒），
   期间界面一直「处理中」。这是体感「点了没反应」的直接来源，收益最大。
2. **中转网络**：换区域/付费实例或自建中转（见 §0 的网络部分），把两段 RTT 从 ~400 ms 压下来。
3. **减少发布次数**：一次行动会触发 3–17 次 `publishOnline`；可以在 AI 动作之间合并发布
   （例如 150 ms 内的多次变更只推最后一次），把房主的阻塞时间按比例摊薄。

### （原计划，保留备查）

### B1. 让 `h()` 记录监听器

- 在 [`public/app.js:76`](../public/app.js#L76) 增加 `LISTENERS` Symbol 与 `bind(el, type, fn)`；`h()` 的 `on*` 走 `bind`。
- 把渲染树内 6 处手工 `addEventListener` 改为 `bind`：[catalog.js:119-120](../games/arkhamhorror/web/catalog.js#L119)（卡图 load/error 重试）、[game-ui.js:1156-1159](../games/arkhamhorror/web/game-ui.js#L1156)（仪表盘高亮）。其余 50 余处挂在 `document`/`window`/app root 上，走事件委托，不受影响。

### B2. 新增 `public/dom-morph.js`

规则（缺一不可）：

1. `nodeType` 不同 → 替换；
2. `namespaceURI`/`tagName` 不同 → 替换（地图是 `createElementNS` 生成的 SVG）；
3. `data-key` 不同 → 替换；
4. 属性集合按差异增删；`value`/`checked`/`disabled`/`src`/`open`/`hidden` 只在值不同时写，且 `document.activeElement` 的 `value` 不覆盖（保护 IME/光标）；
5. 监听器整组替换（旧的全部 `removeEventListener`，新的绑定）；
6. 子节点：有 `data-key` 走 Map 匹配，无 key 按位置匹配，多删少插。

### B3. 接入 `render()`

- [`public/app.js:344-346`](../public/app.js#L344)：`root.replaceChildren(next)` → `morph(root.firstElementChild, next)`，无旧节点时才 append。
- 同时**移除 `patchAppWhileChatting`**（[app.js:290](../public/app.js#L290)）：morph 天然保住输入框与光标，两套逻辑共存会互相搬节点。
- 给手牌/装备/地点/敌人/时间线加 `data-key`（卡实例 id / 地点 id / 敌人 id / event seq）。
- 开关：`?morph=0` 强制走旧路径，出问题可让玩家临时关闭。

### B4. 验收

| 指标 | 目标 |
|---|---|
| `render()` P95 | 下降 ≥40%（以 B0 基线为准），无 long task 超过 100 ms |
| 视觉回归 | 现有 50+ 浏览器用例全绿 + 关键界面截图对比（桌面 1440 / 移动 390） |
| 交互回归 | 「点牌→状态变化→再点同一张」「输入中文不丢字」「滚动位置不跳」「演出不被重置」 |
| 内存 | 连续 50 次更新后 DOM 节点数与监听器数不增长 |

**风险与对策**：

| 风险 | 对策 |
|---|---|
| 节点复用但监听器没重绑 → 点错卡 | B1 的 `bind` 强制覆盖；加「同一节点两次点击」回归 |
| 依赖「重建节点」重播的 CSS 动画失效 | 搜索 `void .*offsetWidth` 类写法；改为显式重置 class |
| morph 比重建更慢 | B0 先量；`?morph=0` 兜底 |
| 演出层持有旧节点引用 | morph 让节点存活，反而更稳；对被替换的节点加 `isConnected` 判断 |

**回滚**：`?morph=0` 即回到旧路径；默认值先在本地/内测打开，稳定后再默认开启。

## 3. 阶段 C：#1 浏览器增量协议（⏸ 优先级下调）

> 实测：浏览器每次收到约 500 KB 的会话 JSON，解析约 3–5 ms、渲染约 4 ms；
> 增量协议能省掉解析的绝大部分，但相对房主 130 ms/次发布与 400 ms 网络往返是小项。
> **建议先做上一节的「回包解耦」与网络，再回来评估是否还值得做 C。**

### C1. 契约

- `GET /api/online/status?wait=1&after=<serial>&stamp=<stamp>`，`stamp = <sessionId>:<revision>:<eventCount>`。
- 响应三选一：
  - `session` 全量（无 stamp、stamp 不匹配、基线被淘汰）；
  - `sessionDelta = { baseStamp, changes }`（stamp 命中基线）；
  - `sessionOmitted: true`（内容未变，只有 busy/room 变化）。
- 服务端为每个大厅保留最近 2–3 份「已发视图」作为基线（`Map`，超出淘汰回落到全量）。

### C2. 服务端

- 在 [`lib/server.js:1358`](../lib/server.js#L1358) 的 status 分支上包一层 `withSessionDelta(status, stamp)`；复用 `snapshotChanges`（[`lib/online-sync.js`](../lib/online-sync.js)）。
- 基线存的就是**发给浏览器的那个对象**（`status().session`），不要重新算一份。
- `p2p.js` 的直连等待仍在轮询 `/online/status`（不带 `stamp`、走全量），保持不变——它只在直连命令后短时轮询，不是热路径。

### C3. 客户端

- 新增 `public/session-delta.js`（`applySnapshotChanges` 的浏览器副本，约 30 行）+ 一条「两份实现同 fixture 输出一致」的单测，防止漂移。
- `online-ui.accept()`（[public/online-ui.js:37](../public/online-ui.js#L37)）：
  - 校验 `baseStamp === stamp(state.session)`，不匹配 → 立刻用无 stamp 的请求重新拉全量；
  - busy/聊天期间延后应用时，`appliedStamp` 必须跟着延后，不能拿「已收到」当「已应用」；
  - 任何异常都退回全量，绝不把 delta 应用到错误基线上。

### C4. 验收

| 指标 | 目标 |
|---|---|
| 每次轮询的下行体积 | 从 450–700 KB 降到 ≤40 KB（全量兜底除外） |
| 浏览器 JSON 解析耗时 | 下降 ≥80% |
| 正确性 | 新增用例：基线过期、刷新页面、两个标签页、busy 延后、连续 50 次 delta 后与全量结果逐字节一致 |
| 失败模式 | 任何异常都表现为「变慢（回全量）」，不允许出现「显示旧状态却可操作」 |

**回滚**：客户端不发送 `stamp` 即完全走旧全量路径；服务端保留全量分支，无需版本升级。

## 4. 测试矩阵

```bash
# 大厅（113 例）
node --test tests/hall/*.test.mjs

# 诡镇规则与集成（2335 例，含新增 view-privacy）
cd games/arkhamhorror && node tools/run-tests.mjs fast

# 观察视图逐字节门禁（阶段 A 护栏）
cd games/arkhamhorror && node tools/capture-view-hashes.mjs

# 四真人联机 + 隐私（7 例，约 2 分钟）
node --test games/arkhamhorror/tests/hall-online.test.mjs

# 浏览器回归（系统 Edge，channel: msedge）
node node_modules/@playwright/test/cli.js test --config tests/hall/playwright.config.mjs
node node_modules/@playwright/test/cli.js test --config games/arkhamhorror/playwright.config.mjs

# 渲染回归与基准（输出 RENDER_BASELINE）
node node_modules/@playwright/test/cli.js test --config games/arkhamhorror/playwright.config.mjs render-perf

# 性能基准（#2 前后对比）
node tools/perf-online-snapshot.mjs --seats=4 --moves=250
```

## 5. 里程碑与工作量（粗估）

| 阶段 | 内容 | 工作量 | 状态 |
|---|---|---|---|
| A0 | 逐字节基线与采集脚本 | 0.5 天 | ✅ 完成 |
| A1′ | 共享 state 副本 + 静态展示表（原「公共部分拆分」实测收益不足，已改范围） | 0.5–1 天 | ⏸ 待定（收益仅 ~15 ms/次发布） |
| A3 | 隐私断言矩阵 + 卡面泄漏修复 | 0.5 天 | ✅ 完成 |
| B0 | 渲染埋点与基线测量 | 0.5 天 | ✅ 完成（p50 ≈4 ms） |
| B1–B4 | morph + 接入 + 回归 | 1.5–2 天 | ❌ 取消（原型实测无收益，已回退） |
| C1–C3 | delta 协议 + 客户端兜底 | 2–3 天 | 依赖 A、B |
| C4 | 异常用例与压测 | 0.5–1 天 | 依赖 C1–C3 |

## 6. 上线检查清单

- [ ] 每阶段独立提交，提交信息写清门禁结果（哈希一致 / 用例数 / P95）。
- [ ] 诡镇改动在 `games/arkhamhorror` 这个独立仓库里提交并推送；大厅不跟踪它，不需要 bump 指针。
- [ ] 版本号：A 完成后升 `boardgame-mod.json` 的 `version`（视图实现变了，联机两端应同版本）；C 只影响本机 HTTP，不需要升大厅版本。
- [ ] 不使用任何持久化格式变更（三个阶段的视图都是运行期数据，不落盘）。
- [ ] 每阶段结束更新 [`arkham-online-performance.md`](arkham-online-performance.md) 的实测表。

## 7. 未决问题

1. `campaignView` / `campaignStory` / `scriptActionHints` / `locationShroudModifier` 是否真的与席位相关——需要 A1 逐条确认；宁可先按私有处理。
2. 共享 state 副本后，Mod 的 `viewState` 是否保证不写权威字段？目前只观察到 `state.cards` 自愈，需要加一条「视图期间权威 state 哈希不变」的断言兜底。
3. 渲染层还有一处「表格演出」持有 DOM 引用（`table-presentation` 的 anchors），morph 后要确认动画中节点被替换时的降级路径。
4. #1 的收益只有在 B 落地后测才有意义；若 B 之后浏览器每次渲染已 <15 ms，可考虑直接砍掉 C。

## 8. 4 人局延迟预算（2026-10-23 实测）

### 8.1 测量条件

- 4 个真人席位、无 AI、夜之狂热第一关，revision 100–123。
- 4 个大厅 + 本机 relay 跑在同一个 Node 进程里；客人的命令仍走 `客人 → relay → 房主` 的真实代码路径，只是 RTT 是本机。
- 因此下面的「命令往返」接近房主进程的真实同步开销；线上还要再叠加一/两段公网 RTT。relay 与房主同进程会让房主事件循环阻塞略偏高，量级不受影响。

### 8.2 当前实测

| 指标 | p50 | p95 |
|---|---|---|
| 房主行动命令往返 | **317 ms** | 399 ms |
| 客人行动命令往返（localhost relay） | **346 ms** | 425 ms |
| 房主事件循环阻塞 | **291 ms** | 331 ms |
| 命令响应 | 1.10 MB | 1.30 MB |
| `status` 响应 | 1.10 MB | 1.30 MB |
| 每次行动 serial 变化 | 2 次 | 2 次 |

单份席位视图（revision 100）的体积构成：

| 字段 | 大小 | 占比 |
|---|---|---|
| `state.cards` | **785 KB** | 69% |
| `events` | 250 KB | 22% |
| `state.investigatorDefs` | 81 KB | 7% |
| 其余（investigators / campaign / log / …） | ~27 KB | 2% |

一次房主行动在浏览器侧实际拉取：

| 项 | 当前 |
|---|---|
| 命令响应 | 1.1 MB |
| 2 次 `serial` 对应的长轮询 | 2.2 MB |
| `onlineUi.command` 末尾的显式 `refresh()` | 1.1 MB |
| **合计** | **≈4.4 MB / 次点击** |

两次 `serial` 的来源：一次是 revision 变化后的发布，一次是 `finally` 里 `busy` 从 true 变 false 又发布了一遍；第二次只为改一个布尔值，却仍要 deep copy + 两次 `JSON.stringify(full)`。

端到端推算（含浏览器解析、渲染与真实网络）：

| 场景 | 当前延迟 |
|---|---|
| 房主点击 → 桌面更新 | **330–420 ms** |
| 客人直连点击 → 自己屏幕 | **450–600 ms** |
| 客人经中转点击 → 自己屏幕 | **700–800 ms** |
| 客人点击 → 房主屏幕 | 350–500 ms |
| 带 AI 队友时的行动确认 | **+5–30 s**（等待整轮 AI，未计入上表） |

### 8.3 剩余可改进项与预估收益

| # | 改进 | 现状成本 | 预估改后 | 预计降幅 | 风险 |
|---|---|---|---|---|---|
| 1 | **静态表只发一次**：`cards` / `investigatorDefs` 按 `resourceVersion` 或 cards stamp 缓存，后续视图只带 stamp | 每份视图 866 KB；4 席克隆 + 每客人序列化 | 每次行动 1.1 MB → ~0.29 MB；发布 CPU −20–40 ms | 房主 −20–40 ms；中转客人 −80–200 ms | 中（客户端缓存/回退全量） |
| 2 | **busy 单独轻量消息**：`busy` 变化不再发整份快照 | 第二次全量发布 40–70 ms + 额外 1.1 MB status | 一条小消息/仅 status 字段 | 每次行动 −40–70 ms | 低 |
| 3 | **非行动者视图延后**：只构建行动者个人视图并回包，其余席位 `setImmediate` 后台发 | 回包前构建 4 席（60–80 ms）+ 3 份编码 | 回包只等 1 席（20–30 ms）；其余稍后到 | 服务端阻塞 −50–70%，房主点击 −55–65% | 中（顺序/flush） |
| 4 | **命令响应瘦身 + 去掉命令后的 refresh**：房主只回自己的视图，客人只回 `sessionId`/`revision`/`eventCount`；`onlineUi.command` 末尾不再无条件 `refresh()` | 命令响应 1.1 MB + 额外 1.1 MB refresh | 房主 ~0.3 MB、客人 <1 KB，且少一次全量往返 | 房主 −5–15 ms；中转客人 −20–100 ms | 低 |
| 5 | **status 增量/省略**（路线图 C） | 2 次 ×1.1 MB + refresh | ≤40 KB/次 | 本机解析 −10–20 ms；带宽 −95% | 中（基线错位） |
| 6 | **publish 序列化清理**：去掉防御性 deep copy；`full` 只 stringify 一次；metrics 不在生产 stringify | 每客人 15–25 ms | 每客人 5–10 ms | 每次发布 −20–40 ms | 低 |
| 7 | **A1′ 共享 clone/静态表** | 4 席视图 80 ms | ~65–70 ms | −15 ms/次发布 | 低–中 |
| 8 | **直连命令事件化**：`p2p.command` 不再 100 ms 轮询等本地 revision | 0–100 ms 量化等待 | 0 ms | 直连客人 −50 ms（均值） | 低 |
| 9 | **直连转发零拷贝**：房主浏览器不 parse→stringify，服务端切好 12 KB 片 | 每客人每快照 5–15 ms 主线程 | 接近纯转发 | 房主 CPU −5–15 ms/客人 | 中 |
| 10 | **AI 回合与回包解耦**：先回 move，再后台跑 reactions/AI 并推增量 | 5–30 s | 100–200 ms 确认 | 确认延迟 −90%+；下一回合仍受模型耗时限制 | 高（busy/并发语义） |
| 11 | **网络**：中转换区域/付费/自建 + TURN 提高直连率 | 两段 RTT ~400 ms | 100–150 ms | 中转客人 −250–300 ms | 非代码 |

> 不建议再投入：DOM morph（整树重绘 p50 ≈4 ms，实测无收益）；`viewState` 公共/私有拆分（公共辅助函数合计 <0.3 ms，A1′ 已覆盖主要收益）；只做 delta 协议（解析省 3–5 ms，相对 300 ms 的同步发布是小项）。

### 8.4 累计预估

| 阶段 | 房主点击 | 客人直连 | 客人中转 | 带 AI 的行动确认 |
|---|---|---|---|---|
| 当前 | 330–420 ms | 450–600 ms | 700–800 ms | 5–30 s |
| P0：1+2+3+4+6 | **100–160 ms** | **180–320 ms** | **400–550 ms** | 5–30 s |
| P1：+5+7+8+9 | 90–140 ms | 160–280 ms | 380–520 ms | 5–30 s |
| P2：+11 网络 | 90–140 ms | 120–220 ms | **250–350 ms** | 5–30 s |
| +10 AI 解耦 | 90–140 ms | 120–220 ms | 250–350 ms | **100–200 ms** |

口径：房主点击到桌面更新；客人点击到自己屏幕；带 AI 的「确认」指自己的行动被服务端接受并显示，不包含 AI 实际思考时间。

### 8.5 建议顺序与验收

1. 先做 **1 静态表** 与 **2 busy 轻量消息**：改动集中、收益确定，直接砍掉每次点击的大部分字节与一次全量发布。
2. 再做 **3 非行动者延后** 与 **4 命令响应瘦身（含去掉命令后的 `refresh()`）**：把房主同步阻塞从 ~300 ms 压到 ~80–120 ms。
3. 然后 **5 status 增量**、**6 序列化清理**、**7 A1′**、**8 p2p 事件化**。
4. 有 AI 席位时，**10 AI 解耦** 的体感收益最大；网络（11）取决于部署，和代码解耦。

验收目标：

| 指标 | 目标 |
|---|---|
| `perf-online-snapshot --seats=4 --moves=250` 的 `publishOnline` | 123 ms → **≤60 ms** |
| 4 人局命令往返 p50 | 317 ms → **≤120 ms** |
| 4 人局房主事件循环阻塞 p50 | 291 ms → **≤80 ms** |
| 单次命令响应 | 1.1 MB → **≤300 KB** |
| 每次行动的 status 总下行 | 3.3 MB → **≤100 KB** |
| 房主点击 → 桌面 | **≤150 ms** |
| 客人直连点击 → 自己屏幕 | **≤300 ms** |
| 客人中转点击 → 自己屏幕 | **≤450 ms** |
