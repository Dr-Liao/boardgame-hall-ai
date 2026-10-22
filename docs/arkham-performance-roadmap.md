# 诡镇联机性能路线图（#2 → 渲染 → #1）

本文件是接下来三项优化的执行计划，顺序固定为：

1. **#2 `viewState` 公私拆分**（带逐字节门禁 + 隐私断言）
2. **前端渲染局部更新**（DOM morph）
3. **#1 浏览器增量协议**（`/api/online/status` 走 delta）

诊断数据与已完成的修复见 [`arkham-online-performance.md`](arkham-online-performance.md)；本文只写「接下来怎么改、怎么验收、怎么回滚」。

## 0. 为什么是这个顺序

| 顺序 | 理由 |
|---|---|
| #2 先做 | 纯服务端、与前端解耦；收益立即可测（`publishOnline` 里的视图部分 45–90 ms，目标 ≤25 ms）；门禁是纯数据的（逐字节对比），最容易验证 |
| 渲染第二 | 体感大头在「整树重建 + 卡图重建」；先降渲染成本，#1 的解析收益才看得出来，否则省下的几毫秒会被渲染淹没 |
| #1 最后 | 协议改动风险最高（基线错位会显示旧状态），只有在 A/B 之后仍有明确收益才值得做；且它只改「本机大厅 ↔ 自己浏览器」，**不改中转协议**，不影响两人联机兼容性 |

每个阶段自带开关与回滚点，任何一步测不出收益就停在那一步，不往下推。

## 1. 阶段 A：#2 `viewState` 公私拆分

### A0. 前置：逐字节基线（必须先做）

- 新增 `games/arkhamhorror/tools/capture-view-hashes.mjs`：对一组固定夹具建局、推进到指定局面，对**每个席位**调用 `viewState(structuredClone(state), seat)`，输出 `sha256(JSON.stringify(view))` 到 `games/arkhamhorror/artifacts/view-hashes.json`。
- 夹具至少覆盖：开局 hub、关卡开场、mid-game（有资产/敌人/地点附件）、`pendingChoice` 的每种 kind、私人技能检定、关间升级、战役纪要。
- 门禁：**拆分前后哈希必须完全一致**。`JSON.stringify` 对键顺序敏感，所以拆分只能改「值的来源」，不能改对象字面量的构造顺序。
- 如果确实需要改顺序（例如新增字段），单独提交并重新生成基线，不能混在重构里。

### A1. 拆出「按 revision 可复用」的公共部分

在 `src/integration/observation.js` 里把昂贵且与席位无关的计算抽成一组函数，并用 **WeakMap 按 state 对象缓存**（同一 revision 的 4 个席位共享同一份 state 时才能命中，见 A2）：

| 现有位置 | 内容 | 判定 |
|---|---|---|
| [observation.js:116-131](../games/arkhamhorror/src/integration/observation.js#L116) | 地点附件、有效帷幕 | 公共（`locationShroudModifier` 需逐条确认是否真的看观察者） |
| [:132-137](../games/arkhamhorror/src/integration/observation.js#L132) | 敌人有效生命/战斗/闪避 | 公共 |
| [:138](../games/arkhamhorror/src/integration/observation.js#L138) | `locationEntryErrors`（按 `currentSeat`） | 公共（按状态，不按观察者） |
| [:150-160](../games/arkhamhorror/src/integration/observation.js#L150) | 毁灭/线索/战役投影/剧本标记/时间线/混乱袋 | 公共 |
| [:164-168](../games/arkhamhorror/src/integration/observation.js#L164) | 剧本 intro / layout | 公共 |
| [:169](../games/arkhamhorror/src/integration/observation.js#L169) | `setAsideCards` | 公共 |
| [:263-265](../games/arkhamhorror/src/integration/observation.js#L263) | `abilityUsage`（遍历全部调查员） | 公共 |
| [:139-141](../games/arkhamhorror/src/integration/observation.js#L139) | `campaignView(state, observer)` | **私有**（含本人牌组/创伤） |
| [:149](../games/arkhamhorror/src/integration/observation.js#L149) | `campaignStory(..., observer)` | 待确认（默认按私有处理） |
| [:161-163](../games/arkhamhorror/src/integration/observation.js#L161) | 私人技能检定 | **私有** |
| [:176-190](../games/arkhamhorror/src/integration/observation.js#L176) | `hand` / `beneath` | **私有**（其余字段公共） |
| [:194-215](../games/arkhamhorror/src/integration/observation.js#L194) | `state.cards` 自愈 + `view.cards` | **私有**（见下） |
| [:220-234](../games/arkhamhorror/src/integration/observation.js#L220) | `pendingChoice` / `options` | **私有**（`prompt` 可公开，`options` 只给应答者） |
| [:236-237](../games/arkhamhorror/src/integration/observation.js#L236) | `legalMoves` | **私有** |
| [:240-255](../games/arkhamhorror/src/integration/observation.js#L240) | `upgradeBlocked` | **私有** |
| [:258-269](../games/arkhamhorror/src/integration/observation.js#L258) | `scriptActions` / `usedActions` | 待确认（依赖 observer） |

> 这张表是**初判**，实施时每条都要用 A0 的逐字节对比确认，不允许「看起来是公共的」就搬走。

### A2. 每 revision 只克隆一次权威状态

现在 [`sessionView`](../lib/server.js#L485) 为每个席位 `structuredClone(session.state)`（4 席 ≈ 11 ms）。改成每个 revision 克隆一次、所有席位共用这个副本。

- 约束：`viewState` 会写 `state.cards`（自愈），对同一份副本是幂等的；除此之外必须只读。
- 这是通用大厅代码，不能默认所有 Mod 的 `viewState` 都是只读的。加一个 Mod 声明位（例如 `viewStateSharesState: true`），只有声明的 Mod 才共享副本；未声明的保持每席位克隆。
- 门禁：声明后跑 A0 哈希 + 全量 `test:fast`（`viewState` 被大量用例间接调用）。

### A3. 隐私断言（与逐字节门禁同等重要）

- 已有：[`hall-online.test.mjs`](../games/arkhamhorror/tests/hall-online.test.mjs) 四真人 240 步，逐条检查「其他席位的 `hand`/`deck` 为空」「`event.privateSeat` 必须匹配」。
- 新增单测 `viewState` 隐私矩阵：给每个席位各建一份视图，断言
  - 别人手牌不在 `view.investigators[].hand`；
  - 别人牌组不出现在 `campaign.investigators[seat].deck`；
  - 非应答者的 `pendingChoice.options` 为空；
  - 非行动席位的 `legalMoves` 为空；
  - **`view.cards` 只包含「公共可见 + 本人手牌」的卡号**（关键，见下）。
- `view.cards` 的自愈必须保持按席位计算：如果按「全部席位并集」加热，B 的视图里会出现只在 A 手牌中的卡面定义，等于泄露「A 手里有这张牌」。

### A4. 验收

| 指标 | 目标 |
|---|---|
| 逐字节哈希 | 100% 一致（含键顺序） |
| `publishOnline`（4 席，250 步） | 从 ~124–164 ms 降到 **≤60 ms**，其中视图部分 ≤25 ms |
| 隐私断言 | 全部通过（含新增矩阵） |
| 回归 | `test:fast` 2330 例 + 大厅 113 例 + 四真人联机 7 例全绿 |

**回滚**：整个 A 阶段不改变任何对外协议与存档格式，出问题直接 revert 该提交即可；`viewStateSharesState` 是逐 Mod 开关，可单独关掉。

## 2. 阶段 B：前端渲染局部更新（DOM morph）

### B0. 先量，再改

- 新增 `tests/hall/browser/render-perf.browser.mjs`（Edge 通道已在本机可用，已验证）：起一个大厅、用固定种子开一局诡镇、连续走 N 步，用 `PerformanceObserver` 记录 long task，并在 `render()` 里加一个仅 `?perf=1` 生效的埋点（`window.__HALL_RENDER_MS__`）。
- 记录基线：`render()` P50/P95、单次渲染新增 DOM 节点数、`LayoutDuration`/`RecalcStyleDuration`（CDP `Performance.getMetrics`）。
- 若基线 P95 < 15 ms，说明渲染不是瓶颈，**本阶段直接取消**，跳到 #1。

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

## 3. 阶段 C：#1 浏览器增量协议

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

# 诡镇规则与集成（2330 例）
cd games/arkhamhorror && node tools/run-tests.mjs fast

# 四真人联机 + 隐私（7 例，约 2 分钟）
node --test games/arkhamhorror/tests/hall-online.test.mjs

# 浏览器回归（系统 Edge，channel: msedge）
node node_modules/@playwright/test/cli.js test --config tests/hall/playwright.config.mjs
node node_modules/@playwright/test/cli.js test --config games/arkhamhorror/playwright.config.mjs

# 性能基准（#2 前后对比）
node tools/perf-online-snapshot.mjs --seats=4 --moves=250
```

## 5. 里程碑与工作量（粗估）

| 阶段 | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| A0 | 逐字节基线与采集脚本 | 0.5 天 | — |
| A1–A2 | 公共/私有拆分 + 状态共享 | 1–1.5 天 | A0 |
| A3 | 隐私断言矩阵 | 0.5 天 | A1 |
| B0 | 渲染埋点与基线测量 | 0.5 天 | — |
| B1–B3 | morph + 接入 + key | 1.5–2 天 | B0 |
| B4 | 浏览器回归与截图 | 0.5–1 天 | B1–B3 |
| C1–C3 | delta 协议 + 客户端兜底 | 2–3 天 | A、B |
| C4 | 异常用例与压测 | 0.5–1 天 | C1–C3 |

## 6. 上线检查清单

- [ ] 每阶段独立提交，提交信息写清门禁结果（哈希一致 / 用例数 / P95）。
- [ ] 诡镇改动走子模块：先提交 `games/arkhamhorror`，再在大厅仓库 bump。
- [ ] 版本号：A 完成后升 `boardgame-mod.json` 的 `version`（视图实现变了，联机两端应同版本）；C 只影响本机 HTTP，不需要升大厅版本。
- [ ] 不使用任何持久化格式变更（三个阶段的视图都是运行期数据，不落盘）。
- [ ] 每阶段结束更新 [`arkham-online-performance.md`](arkham-online-performance.md) 的实测表。

## 7. 未决问题

1. `campaignView` / `campaignStory` / `scriptActionHints` / `locationShroudModifier` 是否真的与席位相关——需要 A1 逐条确认；宁可先按私有处理。
2. 共享 state 副本后，Mod 的 `viewState` 是否保证不写权威字段？目前只观察到 `state.cards` 自愈，需要加一条「视图期间权威 state 哈希不变」的断言兜底。
3. 渲染层还有一处「表格演出」持有 DOM 引用（`table-presentation` 的 anchors），morph 后要确认动画中节点被替换时的降级路径。
4. #1 的收益只有在 B 落地后测才有意义；若 B 之后浏览器每次渲染已 <15 ms，可考虑直接砍掉 C。
