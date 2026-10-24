# 自动跳过（P0 发送者代答 + P1 全员偏好缓存）

> 目标：玩家把某些卡片的「快速反应」关掉后，联机/单机都不再为这些窗口发 `choose/skip` 命令——
> 房主在**发布快照之前**替对应座位补一条普通 skip。P0 只覆盖命令发送者本人；P1 让房主按座位
> 缓存偏好，于是**别人的命令触发的窗口、多座位连续窗口**也能在同一条命令里全部代答。
> 状态：P0/P1 均已实现（2026-10-24），默认开启，`BOARDGAME_AUTOPASS=0` 回滚。

## 1. 背景

原来的自动跳过是**纯客户端**的（[`games/arkhamhorror/web/reaction-preferences.js`](../games/arkhamhorror/web/reaction-preferences.js)）：

1. 房主引擎结算出一个可选窗口（`pendingChoice`，`kind ∈ reaction/playerWindow/boost`）；
2. 窗口随快照下发，客户端 `reactionPassPlan` 判定「该座位所有可选卡都已关闭」；
3. 客户端把窗口藏住、再发一条普通 `POST /move`（`choose/skip`）。

第 3 步在联机里要一次命令往返（直连 ≈1 RTT，中转 ≈2 段 RTT），而且全桌在 busy 期间等这一跳。
更糟的是「四个人同时满足触发条件」这类场景：引擎按座位顺序逐个开窗，每个窗口都要一次往返。

## 2. 做法（房主代答，不碰规则层）

**房主在命令的同步段里循环补普通 skip**，走和玩家手点完全相同的 `commitMove`
（`validateMove` / `applyMove` / `state.actionLog` / continuation 全一致），所以回放、撤销、审计、
存档都不需要迁移。

```
客户端 move ── body.client.autoPass = { codes:[本机「反应关」卡号] }   ← 同时刷新房主缓存
        │
        ▼
房主 commitMove(玩家动作)
        │  ← 这里已经可能产生 pendingChoice
        ├─ settleAutoPass(sender)
        │     while pendingChoice
        │       且 该座位偏好可知（发送者本人，或 P1 缓存 + 该成员在线）
        │       且 mod.autoPassChoice(...) 返回普通 choose/skip
        │        → commitMove(skip)   // 和手点同一条路径
        │
        ▼
snapshotSession / publish（窗口从未出现在任何快照里）
```

- **P0**：只认命令发送者本人（当前命令携带的 `client.autoPass`）；
- **P1**：额外认房主缓存的任意座位偏好（`prefs` 命令 / 每次 move 捎带刷新）。因此：
  - 别人命令触发的窗口 → 该座位有缓存就代答；
  - 四人连续窗口 → 触发命令里一次 settle 完 4 个 skip，**0 条额外命令、1 次发布**；
  - 缓存没有 / 座位离线 / 映射失败 / 窗口里还有开启的卡 → 链在该座位停下，窗口照常发布，
    该玩家客户端仍有原来的自动跳过兜底（最多退化成一次请求，不会卡死）。
- **prefs 只写缓存、不改对局**：不占 busy、不进发布合并窗口，也**不**主动代答已经在等的窗口
  （否则会和该座位客户端同时提交 skip 抢 revision，产生假错误）；等待中的窗口由该客户端自己的
  skip 命令结算（命令同样携带偏好，走 P0 代答）。
- **偏好有序**：客户端每次上报带单调 `seq`（页面加载后递增），房主丢弃乱序到达的旧偏好；
  自动提交的 skip 若因版本已推进而失败，客户端静默刷新，不弹错误。
- **断线策略**：缓存只在房主进程内存（`WeakMap`，不进视图/存档）；settle 时要求该席位当前
  仍在房间里且在线，离线/离开恢复「等待」（不替掉线玩家静默跳过关键反应）。
- **缓存重建**：连接断开→恢复、房主离线→在线、以及每 2 分钟都会重发一次 `prefs`，
  覆盖「房主进程重启导致缓存清空但客人 sync key 未变」的情况。
- **清空**：客户端每次 move 都会带当前的「反应关」集合（空数组 = 清除该座位缓存）；
  `prefs` 命令同理。玩家重新打开提示后，下一次同步即移除缓存。

## 3. 协议与实现位置

| 位置 | 作用 |
| --- | --- |
| `POST /api/move` 的 `body.client.autoPass = { codes: string[], seq }` | 每次行动捎带并刷新房主缓存（单机/联机同形，空数组 = 清除，seq 用于丢弃乱序旧值） |
| `POST /api/move`（单机） | 单机由本机大厅用命令携带的偏好代答；单机不读跨命令缓存 |
| `POST /api/online/command` 的 `action:'prefs'`，`body:{ sessionId, codes, seq }` | 开关变化 / 进局 / 重连 / 低频刷新时的异步全量同步；只更新房主缓存，不改变对局状态 |
| [`lib/server.js`](../lib/server.js) `normalizeAutoPassCodes` / `normalizeAutoPassSeq` / `rememberAutoPassPrefs` / `autoPassPrefsFor` / `settleAutoPass` | 解析限界、按 seq 合并偏好、按座位内存缓存、在线检查、逐窗口代答（`AUTO_PASS_GUARD=32`） |
| [`lib/server.js`](../lib/server.js) 调用点 | 单机 `/api/move`、联机 move 分支（`beginBackgroundAi` 判定之前）、`runAiTurnsInner`（每步 AI 提交后、`onStep` 发布前）、`aiRetry` |
| [`relay/server.js`](../relay/server.js) | `request.action` 白名单加入 `prefs`（中转只转发、不解析） |
| [`public/app.js`](../public/app.js) / [`public/online-ui.js`](../public/online-ui.js) / [`lib/online.js`](../lib/online.js) | 浏览器 `/prefs` → 联机命令；直连命令白名单加入 `prefs`（与 move 同传输，保证相对顺序） |
| [`lib/mods.js`](../lib/mods.js) `autoPassChoice({ state, seat, disabledCodes })` | 可选 Mod 钩子：返回普通 `choose/skip` 或 `null` |
| [`games/arkhamhorror/index.js`](../games/arkhamhorror/index.js) | Arkham 实现：复用 `web/reaction-preferences.js` 的纯判定 `reactionSkipPlan` |
| [`games/arkhamhorror/web/reaction-preferences.js`](../games/arkhamhorror/web/reaction-preferences.js) | `reactionSkipPlan`（浏览器/Node 共用，无 localStorage 依赖）、`reactionDisabledCodes` |
| [`games/arkhamhorror/web/game-ui.js`](../games/arkhamhorror/web/game-ui.js) | `cardMove` 每次捎带偏好+seq；`renderGame` 里异步同步 `prefs`（按 instance/session/seat/codes 去重、失败冷却、重连/2 分钟刷新）；自动提交的 skip 失败静默；原 `scheduleReactionPass` 保留为兜底 |

## 4. 「四个人都关了同一张装备的反应」现在会怎样

- 引擎仍按座位顺序逐个询问（不是多人共享窗口）；但 P1 之后，**只要四个座位都在线且偏好已同步**，
  触发者那一条命令里就会把 4 个窗口全部代答：0 条额外 skip 命令、其他玩家也看不到任何窗口。
- 任一座位没有同步到偏好 → 链在该座位停下，该玩家自己的客户端兜底发一次 skip（旧行为）。
- 该座位离线/离开房间 → 不代答，链停在那里等待（重连后客户端会重新同步偏好并继续）。
- 某个窗口里除了这张卡还有别的开启的反应/免费能力 → 该座位不自动跳过，窗口弹出等人点；
  强制选择（`canSkip=false`）永远不会被代答。

## 5. 开关与验收

- 回滚：`BOARDGAME_AUTOPASS=0`（大厅启动时读取，恢复「客户端自己发 skip」的旧行为）。
- 大厅回归：[`tests/hall/autopass.test.mjs`](../tests/hall/autopass.test.mjs) 10 例：
  单机代答 / 联机 P0 / 全员缓存下 `openAll` 四座位链 0 额外命令 / 随 move 捎带缓存 /
  缺偏好兜底 / `prefs` 只写缓存不改对局 / seq 丢弃乱序旧值 / 空集合清除 / 离线座位不代答 / 回滚。
- 游戏回归：[`games/arkhamhorror/tests/auto-pass.test.mjs`](../games/arkhamhorror/tests/auto-pass.test.mjs)
  （纯判定 fail-closed 边界、Mod 钩子返回形状可过 `validateMove`、真实拾荒窗口提交、payload 口径）
  与既有 [`reaction-preferences.test.mjs`](../games/arkhamhorror/tests/reaction-preferences.test.mjs)。
- 浏览器回归 [`games/arkhamhorror/tests/online-reaction-skip.browser.mjs`](../games/arkhamhorror/tests/online-reaction-skip.browser.mjs)：
  覆盖「进局同步 `prefs`」+「房主没代答时客户端自己补发 skip」的兜底语义。

## 6. 已知取舍

- 偏好缓存是 best-effort：`seq` 只会丢弃乱序旧值，不能消除「重新打开提示后、同步尚未到达」的
  极短窗口；这段窗口最坏退化为一次客户端兜底请求。
- 缓存不落盘：房主进程重启/换局后为空；客户端在「连接恢复 / 房主离线→在线 / 每 2 分钟」时会重发，
  空窗期退化为 P0/旧行为。
- `prefs` 是轻量命令（不写状态、不落盘、不触发 AI），只在开关/进局/重连/低频刷新时发送，
  不是每个窗口一次；它不走忙碌闸门和 P1.5 的发布合并窗口。
- 自动提交的 skip 若因版本已推进而失败会静默刷新（不弹错误提示），只写 `console.warn`，
  便于区分「客户端自动兜底竞争」与真正的操作失败。
- 混版本自动降级：旧中转不认识 `prefs`（直接拒绝）→ 客户端静默冷却重试，功能退化为 P0/旧行为；
  旧房主忽略 `client.autoPass`；旧 Mod 不发送偏好。都不影响正常对局。
  **上线时中继（relay）需要同步更新**（`request.action` 白名单加了 `prefs`）；自建/官方 relay 未更新时
  P1 的跨命令缓存不可用，但 P0 与客户端兜底仍然工作。
