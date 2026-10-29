# Mod 接口契约

大厅通过 Mod 的 `index.js` 加载游戏。Mod 默认导出一个对象；大厅只理解通用会话、席位、动作和投影，不理解具体游戏规则。运行时校验与默认行为在 `lib/mods.js`，接口版本在 `lib/version.js`。

## 基本约定

- `players: [min, max]`：游戏允许的总参与席位范围。
- `seats`：大厅可配置的最大席位数；缺省取 `players[1]`。席位可以是真人或 AI，不表达角色类型。
- `createState(settings, players)`：创建可 `structuredClone` 的权威状态。
- `validateMove(state, seat, move)`：纯校验，合法时返回 `null`。
- `applyMove(state, seat, move)`：只修改大厅提供的事务副本并返回事件；失败不得留下部分提交。
- `legalMoves(state, seat)`、`describeState(state, seat)`、`moveToText(move)` 与 `moveFormat`：供大厅、AI 和确定性兜底共用。

状态顶层至少包含 `status`、`winnerSeat`、`currentSeat`、`moveCount`、`revision`。大厅在成功事务后维护 `revision`。

## 席位与同时行动

- `decisionSeat(state)`：当前主要应答席位；缺省读取 `state.currentSeat`。
- `actingSeats(state)`：当前全部可提交席位；用于同时选人、构筑等阶段。
- `seatLocalMove(state, seat, move)`：声明动作只依赖该席位自身数据，使过期版本可在最新状态上重新校验。
- `pendingChoice(state)`：当复合运行时没有单一 `state.pendingChoice` 时，返回大厅应自动处理的当前待决选择。

本地开局按 `players` 限制席位；联机房间至少需要 2 席，并按
`max(2, players[0]) <= 总席位数 <= seats` 校验。真人和 AI 可以混合占用这些席位；
Mod 不应假定只有座位 0 是真人。

## 隐私与展示

- `viewState(state, seat, options)`：按观察者裁剪隐藏信息；不得修改入参。
- `viewEvents(events, seat)`：裁剪私密事件。
- `staticTables(state)`：返回与权威状态解耦的公共静态表。
- `viewStateSharesState`：声明 `viewState` 可以安全读取大厅按 revision 生成的共享隔离副本。
- `web`：声明 Mod 自带的客户端模块、样式和语言包。资源必须位于 Mod 自己的 `web.dir` 内。
- `handleApi`：只读公共资料接口；`handleLocalApi`：仅本机同源可用的私有资料接口。两者都不得旁路对局动作校验。

私有手牌、牌库顺序、待决私有候选和内部续执行数据只能经观察投影下发。

## 自动选择与 AI

- `autoChoice({ state, seat, states })`：按该席位同步的三态偏好返回一条普通合法动作。
- `autoPassChoice({ state, seat, disabledCodes })`：兼容两态“关闭提示”，只代答可跳过的可选窗口。
- `agentFallback`、`decisionSeed`、`moveCost`：模型失败时的确定性兜底。
- `agentCandidates`、`agentHint`、`refineMove`：可选的本地策略提示和无争议纠错。
- `validateAgentMove`：限制“真人合法、但模型不应代选”的动作；不能代替规则校验。
- `agentTurnKey`、`agentPlanning`：管理多步回合的上下文边界与 Mod 自有协作计划。
- `agentActionMessage`、`agentActionSpeechFrequency`、`agentReactionTriggers`：动作后的角色表达，不得修改规则状态。
- `enableAutoReactionHosted`：大厅启动时启用房主托管策略；不得创建或推进对局。

自动选择必须返回与玩家手点相同的普通 move，由大厅重新经过 `validateMove`、`applyMove`、日志和存档流程。

## 存档、迁移与检查点

- `sessionPolicy(state)`、`saveSummary(state)`：声明通用生命周期策略和存档摘要。
- `saveCompatibilityError(state)`、`migrateState(state, options)`：兼容性判断和纯函数迁移。
- `commitChoiceBatch(session, seat, batch, helpers)`：在一个事务草稿内原子提交多步选择。
- `createSessionCheckpoint(session, receipt)`：成功动作后可返回一个权威检查点，返回 `null` 表示不创建。
- `checkpointView(session, observerSeat)`：只返回可公开的检查点摘要，不能泄露快照。
- `migrateSessionCheckpoints(session, options)`：独立迁移历史检查点。
- `forkSessionCheckpoint(session, checkpointId, options)`：从检查点创建新的分支会话。

## 版本与兼容

下载的游戏在 `boardgame-mod.json` 声明 `hallApi`。新增可选钩子可以保持当前接口版本；删除字段、改变已有参数或返回值等不兼容修改必须提升 `HALL_API`，并先发布支持新版本的大厅。

新增钩子时必须同时完成：

1. 更新本文和 `lib/mods.js` 的运行时校验；
2. 在 `tests/fixtures/mods/` 增加契约夹具；
3. 更新 `HALL_API`（仅不兼容修改）；
4. 在具体游戏仓库补大厅集成回归。
