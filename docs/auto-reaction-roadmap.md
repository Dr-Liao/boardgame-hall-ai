# 自动反应（基于快速反应）改造路线图

> 目标：在现有「快速反应」之上增加「自动反应」，两者共享同一条三态阶梯；默认值固定来自
> 会话/内置配置，玩家可逐卡覆盖；联机沿用「房主进程代答 + 异步偏好收集」，每次开关修改
> 不产生协议往返。
>
> 状态：已实施（2026-10-26）——引擎托管模式、大厅代答、三态按钮、异步同步、sidecar 与测试均已落地。
> 前置阅读：[auto-pass.md](auto-pass.md)（P0/P1 代答、prefs 通道、离线策略）。

---

## 0. 结论摘要与术语

**先澄清两个容易混淆的词**：

- **会话默认 ≠ 房主个人配置**。默认值是内置/服务端配置（v1 = `autoByDefault ? 'auto' : 'ask'`），
  房主玩家自己开关自动/快速反应**只影响自己的座位**，不会改变任何默认；v1 也不提供房主修改默认
  的入口。（之前口头叫它「房主默认」，下文统一写「会话默认」，避免和房主个人开关混淆。）
- **房主代答 = 房主进程（大厅）在发布前补 `choose`**，不是房主玩家的偏好或配置。

结论：

- 每张卡只有一个状态：`skip`（自动跳过） / `ask`（每次询问） / `auto`（自动触发）。
  「快速反应」和「自动反应」只是这个状态的两种视图，联动由状态机保证。
- 三态整梯都走会话默认；每个座位（包括房主）只保存自己动过的卡作为覆盖。
- 覆盖保留到本局结束，不提供重置入口。v1 默认是固定的，所以把开关掰回默认值就等于重新跟随，
  重置没有实际意义。
- 开关修改走本地优先 + 去抖的异步 `prefs`，并随下一次 `move` 捎带；房主进程在发布前代答，
  不产生「每改一次就一次请求」的往返。
- 偏好单独做轻量落盘（sidecar），不触发整局快照。
- 界面：角色面板名字右侧一个**三态按钮**——`skip` 暗闪电+斜杠、`ask` 亮闪电、`auto` 亮齿轮
  （旋转）；点一下按 `skip → ask → auto → skip` 循环。名字过长时省略号截断，按钮不缩不换行；
  hover 用原生 `title`，同时说明两个开关的当前状态与下一档。
- 离线座位按 `auto` 结算；AI 跟随会话默认（v1 默认即内置默认，行为与今天一致）。
- 代价：自动奖励从「引擎事务内直接领」变成「房主进程补一条 `choose`」，每次多一次 revision /
  actionLog。

---

## 1. 状态模型

| 状态 | 三态按钮 | 窗口行为 | 谁结算 |
| --- | --- | --- | --- |
| `skip` | 暗闪电 + 斜杠 | 不弹窗 | 房主进程补 `choose skip` |
| `ask` | 亮闪电 | 弹窗 | 玩家自己答 |
| `auto` | 亮齿轮（旋转） | 不弹窗 | 房主进程补 `choose trigger` |

- 状态是唯一真值，按钮的图标/亮暗/旋转都只是它的投影。
- `hasAutoReaction`（所有旧式反应 + 新式非手牌反应）决定能否进入 `auto`；默认 auto 采用安全口径
  （无目标、无资源/弃牌/充能成本、纯收益，允许横置），罗兰/雷克斯/马克/幸运兔脚等默认 `auto`；
  艾格尼丝、拾荒、升级版米兰 01533 等默认 `ask`、可手动切 `auto`。没有任何反应提示的卡不渲染控件。

### 1.1 点击转移（单按钮循环）

| 当前状态 | 点一下 |
| --- | --- |
| `skip` | `ask`（快速开、自动关） |
| `ask` | `auto`（快速开、自动开） |
| `auto` | `skip`（快速关、自动关） |

> 三态本身保证「自动开 ⇒ 快速开」「快速关 ⇒ 自动关」，不存在非法组合；服务端只接受三态枚举。

### 1.2 内置默认

| 卡 | 默认状态 |
| --- | --- |
| `autoByDefault`：无目标、无资源/弃牌/充能成本（只允许横置）、效果属于纯收益（获得资源/发现线索/抽牌/加当前检定/上下文伤害），次数限制不影响 | `auto` |
| `hasAutoReaction` 但不是 `autoByDefault`：有目标、有资源/弃牌/充能成本、搜索/`chooseOne`/`resolve` 等可能再做选择的反应（如艾格尼丝、拾荒、升级版米兰） | `ask`（可切 `auto`） |
| 有反应提示、但没有可自动的反应窗口（快速事件/免费能力/天赋档位） | `ask`（两态，只可跳/询问） |
| 没有任何反应提示 | 不渲染控件 |

默认值**不读任何玩家**的开关，也不随对局内任何人变化（v1）。

---

## 2. 配置模型：固定默认 + 个人覆盖

```js
session.autoPrefs = {
  version: 0,
  seats: {                                  // 每个座位只存动过的卡（含房主座位）
    0: { states: { '01073': 'skip' }, seq: 12 },
    1: { states: { '01033': 'auto' }, seq: 7 },
  },
}
```

有效状态：

```js
stateOf(seat, code) =
  seats[seat]?.states?.[code]                 // 1. 个人覆盖
  ?? (autoByDefault(code) ? 'auto' : 'ask') // 2. 会话/内置默认（v1 固定）
```

- **房主也是普通座位**：房主把自己的米兰关掉，只影响房主座位；其他玩家的默认仍是 `auto`。
- **没有 `defaults` 字段、没有房主默认入口**。将来若要做服务端配置，走大厅/Mod 设置，不通过
  玩家 UI，也不写进玩家覆盖。
- **覆盖的生命周期**：玩家手动改过的卡会记一条覆盖，本局内一直保持；默认值不会因任何人的开关
  变化，所以覆盖只影响自己座位，也不会被别的事件改写。不提供「重置覆盖」入口。v1 默认固定，
  所以把开关掰回默认值在行为上就等于重新跟随；覆盖记录本身留在本局，直到新开一局（或清除本地
  偏好 + sidecar）。
- **单机**：同一个人既是玩家又是房主进程，配置模型完全一致；没有「房主默认」这个概念，只有
  个人覆盖 + 内置默认。
- **离线座位**：不读覆盖，直接按内置默认结算（自动资格的卡 `auto`），避免全桌等缺席玩家。
- **AI**：没有个人覆盖，使用会话默认；v1 默认 = 内置默认，所以 AI 行为与今天一致。未来默认若
  可配置，AI 的自动结算要读同一份默认，否则会出现「默认 ask、AI 仍自动领」。

---

## 3. 异步收集

沿用快速反应现有的「本地优先、异步上行」思路，扩展到三态，但只收集个人覆盖：

- **本地立刻生效**：点击只改本机 store 与 UI，不阻塞、不弹错误。
- **去抖合并**：250ms 内的连续切换合并成一条 `prefs`；页面隐藏/卸载时尽量 flush。
- **随 move 捎带**：`client.autoPrefs = { states, seq }`，房主进程在 `commitMove` 之前合并——
  「切完马上行动」不会丢最后一次修改。
- **失败重试**：`SESSION_BUSY` 800ms、旧房主/不支持 30s 冷却；重连、房主离线→在线、每 2 分钟
  重新全量同步（与现有 `syncReactionPreferences` 同节奏）。
- **不广播**：没有会话默认可改，所以不存在「默认变化要通知全桌」；偏好只影响自己座位。客户端
  乐观更新，重连时从视图里的 `mine` 恢复。
- **权限**：每个成员只能写自己座位的 `states`；没有 `defaults` 作用域。
- **视图**：`sessionView` 的联机分支加 `autoPrefs: { mine, seq }`（只给本人）；`cachedSessionView`
  的 per-seat key 加 `seq`，保证重连拿到最新覆盖。
- **旧数据**：`client.autoPass.codes` 保留一个版本，按 `{ code: 'skip' }` 迁移成覆盖。

---

## 4. 实现要点

### 4.1 引擎：自动奖励从「直接答」变成「带默认选项的窗口」

- [`resolution.js`](../games/arkhamhorror/src/engine/resolution.js#L37-L100)：
  `requestChoice` 对真人**只在「大厅托管模式」下**抛出带 `autoOptionId` / `autoTriggerOptionId` /
  `cardCode` 的 `ChoicePause`；AI 和纯引擎消费者（单测 / replay / 审计）保持「同事务直接领」。
  托管模式由 Mod 的 `enableAutoReactionHosted()` 打开，大厅加载 Mod 时调用一次。
- [`encounter.js`](../games/arkhamhorror/src/engine/encounter.js#L387-L395)：
  **所有旧式反应窗口**都传 `autoTriggerOptionId: 'trigger'` 与 `cardCode`；只有
  `isAutomaticReward(r)` 额外传 `autoOptionId`（默认 auto，AI 直接领）。这些提示只在托管模式
  进 state，普通窗口保持旧状态形状，避免改动回放指纹。
- [`ability-exec.js`](../games/arkhamhorror/src/engine/ability-exec.js#L311-L348)：
  新式反应窗口把**每张候选卡**列成一个带 `cardCode` 的 option；引擎不改 AI 行为，由大厅/客户端
  在「恰好一个候选卡设为 auto」时选择该 option，多个候选保持询问。
- [`observation.js`](../games/arkhamhorror/src/integration/observation.js#L279-L295)：
  `pendingChoice` 白名单增加 `autoOptionId`、`autoTriggerOptionId`、`cardCode`。
- [`card-defs.js`](../games/arkhamhorror/src/engine/card-defs.js#L58-L105)：
  新增 `hasAutoReaction`（旧式反应 + 新式非手牌反应，可切 auto）与 `autoByDefault`（纯收益自动奖励，
  默认 auto）；`fromHand` 的快速事件和 event 卡不进 auto。顺手把 `hasReactionPromptFor` 漏传的
  `limit` 补上。
- 回滚：`BOARDGAME_AUTOREACTION=0`（引擎恢复真人直接领）+ `BOARDGAME_AUTOPASS=0`（大厅不代答）。

### 4.2 房主进程代答：一个循环同时处理 trigger / skip

```js
// lib/server.js 概念代码
function settleAutoChoices(session, sender = null) {
  const mod = modById(session.modId)
  const hook = mod?.autoChoice || mod?.autoPassChoice
  if (!hook) return 0
  for (let guard = 0; guard < 32; guard++) {
    const state = session.state
    if (!state || state.status !== 'playing' || !state.pendingChoice) break
    const seat = state.pendingChoice.seat
    const move = hook({
      state, seat,
      states: effectiveStates(session, seat),   // 覆盖；离线返回 {}
    })
    if (!move) break
    const revision = state.revision
    commitMove(session, seat, move, revision)
    if (session.state.revision <= revision) break
  }
}
```

```js
// games/arkhamhorror/index.js 概念代码
autoChoice({ state, seat, states }) {
  const choice = state?.pendingChoice
  if (!choice || choice.seat !== seat) return null
  const stateOf = code => states?.[code]
    ?? (autoByDefault(code) ? 'auto' : 'ask')
  const triggerOptionId = choice.autoOptionId || choice.autoTriggerOptionId
  if (triggerOptionId && choice.canSkip !== false && stateOf(choice.cardCode) === 'auto') {
    return { action: 'choose', choiceId: choice.id, optionId: triggerOptionId, auto: true }
  }
  // 新式反应窗口：每张候选卡一个 option；恰好一个候选卡 auto 时才代答，多个候选保持询问。
  if (!triggerOptionId && Array.isArray(choice.options)) {
    const autoOptions = choice.options.filter(option => option.cardCode
      && state.cards?.[option.cardCode]?.hasAutoReaction
      && stateOf(option.cardCode) === 'auto')
    if (autoOptions.length === 1) {
      return { action: 'choose', choiceId: choice.id, optionId: autoOptions[0].id, auto: true }
    }
  }
  if (choice.canSkip) {
    const plan = reactionSkipPlan(state, code => stateOf(code) === 'skip')
    if (plan) return { action: 'choose', choiceId: plan.choice.id, optionId: 'skip', auto: true }
  }
  return null
}
```

调用点沿用现有四处：联机 move、单机 `/api/move`、`runAiTurnsInner` 每步前后、`aiRetry`；
`commitMove` 在发布前代答，客户端不会看到这些窗口。

> auto 只代答**初始反应窗口**。反应效果里如果需要选目标、选卡、选技能，会正常打开普通
> `requestChoice` 并弹给玩家；自动逻辑不会替玩家挑目标。纯收益自动奖励本身没有目标，所以
> 米兰/孤狼这类会直接结算。

### 4.3 三态按钮（详细）

#### 形态

一个 **24×24 的单按钮**，一个命中区，点一下按 `skip → ask → auto → skip` 循环。
按钮内部只有一个图标，图标随状态变化：

```
skip   ⚡ + 斜杠（暗）     自动跳过
ask    ⚡（亮）            每次询问
auto   ⚙（亮 + 旋转）      自动触发
```

- 闪电复用 [`tableIcon('action')`](../games/arkhamhorror/web/table-components.js#L4-L33) 的现有路径；
  齿轮在同一份 `paths` 里新增一条 24×24 路径（`fill:none`、`stroke:currentColor`、1.65 描边）。
- 不显示文字；语言切换不改变宽度；`skip` 的斜杠用绝对定位的 `<i>` 叠在闪电上。
- `auto` 金色描边/底色/外发光；`ask` 亮色描边；`skip` 低对比。颜色之外再用斜杠/旋转区分。
- 有旧式反应窗口或新式非手牌反应的卡（`hasAutoReaction`）能进入 `auto`；默认是否为 `auto` 由
  `autoByDefault` 决定：米兰/孤狼/罗兰/幸运兔脚等默认 auto，艾格尼丝/升级版米兰默认 ask、可手动切 auto。
  没有这些反应的卡两态循环 `skip ↔ ask`。

#### 点击语义

| 当前状态 | 点一下 | 说明 |
| --- | --- | --- |
| `skip` | `ask` | 快速开、自动关 |
| `ask` | `auto` | 快速开、自动开（自动隐含快速） |
| `auto` | `skip` | 快速关、自动关 |

- 每次点击只改本机状态、立即重绘；异步同步在后台进行（第 3 节）。

#### 键盘与可访问性

- 一个 `role="button"`，Tab 一次到达；Space/Enter 触发。
- `aria-label` 写「当前状态 + 点击后果」，例如「反应设置：自动触发（快速、自动都开）。点按切换到自动跳过。」
- 可选的视觉隐藏 `aria-live="polite"` 播报切换结果；焦点环清晰。
- 双态卡（无自动资格）的 aria 只描述 skip/ask。

#### hover（原生 title）

| 状态 | 文案 |
| --- | --- |
| `skip` | 「反应设置：自动跳过（快速反应关、自动反应关）。点按 → 每次询问。」 |
| `ask` | 「反应设置：每次询问（快速反应开、自动反应关）。点按 → 自动触发。」 |
| `auto` | 「反应设置：自动触发（快速反应开、自动反应开）。点按 → 自动跳过。」 |

- 只用原生 `title`，不做自定义 tooltip（已定）；触摸端不加入首次气泡/长按说明（已定）。
- 文案 key：`game.reaction.mode.{skip,ask,auto}` 与 `.title`。

#### 动画与降级

```css
.ah-reaction-mode.is-auto .ah-icon { animation: ah-gear-spin 7s linear infinite; transform-origin: 50% 50%; }
@keyframes ah-gear-spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .ah-reaction-mode.is-auto .ah-icon { animation: none; } }
```

- 颜色/描边过渡 150ms；旋转 7s/圈；切换状态不改变按钮尺寸，避免行高/宽度抖动。
- `prefers-reduced-motion: reduce` 时只保留亮/暗，不转。
- 齿轮旋转是「自动已开启」的附加线索，不是唯一线索；关闭时完全静止。

#### 位置与排版

位置：角色个人面板（`renderPlayerDock` 的 `.ah-dock-investigator`，见
[`game-ui.js:1345-1355`](../games/arkhamhorror/web/game-ui.js#L1345-L1355)），角色名右侧、头像左侧。

```
.ah-dock-investigator
├─ .ah-dock-kicker            DrLiao 的调查员
├─ .ah-dock-name-row          ← flex; min-width:0; 右侧给头像留位
│   ├─ button.ah-dock-name    [职业图标] 普雷斯顿·费尔蒙…   ← 只截名字
│   └─ button.ah-reaction-mode  [⚡/⚙]                     ← 固定尺寸，永不缩/换行
└─ .ah-dock-portrait          （绝对定位在右上）
```

DOM：

```js
h('div', { className: 'ah-dock-name-row' },
  h('button', { className: 'ah-dock-name', title: inv.name,
    'data-interaction': `investigator:${inv.seat}`, onclick: () => openCardDetailDef(...) },
    tableIcon(classIcon(inv.klass)),
    h('span', { className: 'ah-dock-name-text' }, inv.name)),
  h('button', { className: `ah-reaction-mode is-${mode}`, title, 'aria-label': ...,
    onclick: () => { setReactionState(s.sessionId, inv.seat, inv.code, next); render() } },
    tableIcon(mode === 'auto' ? 'gear' : 'action'),
    mode === 'skip' ? h('i', { className: 'ah-reaction-slash' }) : null))
```

CSS 要点：

```css
.ah-dock-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; margin-right: 36px; }
.ah-dock-name { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; }
.ah-dock-name .ah-icon { flex: 0 0 auto; }
.ah-dock-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ah-reaction-mode { position: relative; flex: 0 0 auto; width: 24px; height: 24px;
  display: grid; place-items: center; padding: 0; border: 1px solid #827c65; border-radius: 5px;
  background: #202923f2; color: #b3b3a0; cursor: pointer; }
.ah-reaction-mode .ah-icon { width: 15px; height: 15px; }
.ah-reaction-mode.is-ask, .ah-reaction-mode.is-auto { color: #ffe5a6; border-color: #d1ae5a; background: #3d3c21f2; }
.ah-reaction-mode.is-auto { box-shadow: 0 0 8px #e1b95055; }
.ah-reaction-mode.is-auto .ah-icon { animation: ah-gear-spin 7s linear infinite; transform-origin: 50% 50%; }
.ah-reaction-mode.is-skip { color: #7d7a6c; }
.ah-reaction-slash { position: absolute; width: 16px; height: 1.5px; background: currentColor; transform: rotate(-45deg); pointer-events: none; }
```

- 名字按钮 `flex: 1 1 auto; min-width: 0`；按钮 `flex: 0 0 auto`；空间不足时只截名字，
  按钮保持 24px，**不换行、不缩、不改变行高**。
- 头像仍绝对定位；用 `--ah-dock-portrait-w` 按主题给 30/35px 留位。
- **必须清理主题里的固定宽度**：[style.css:650](../games/arkhamhorror/web/style.css#L650) 的 95px、
  [noir.css:112](../games/arkhamhorror/web/noir.css#L112) 的 100px、以及 ≤1000 / ≤700 断点里的
  同名规则，改成 `min-width:0` + 行布局。
- 渲染条件：`ahCardDef(s, inv.code)` 有 `hasReactionPrompt` **或** `hasAutoReaction` 才渲染；
  两个都没有则不渲染，行自然变宽。
- 按钮是名字按钮的**兄弟节点**，不能嵌套 `<button>`；`onpointerdown` / `onkeydown` 要
  `stopPropagation`，避免误触打开角色卡详情。
- 新控件用独立 class（`ah-reaction-mode`），不复用卡面
  [`card-interactions.css:85-90`](../games/arkhamhorror/web/card-interactions.css#L85-L90) 的
  `.ah-reaction-toggle`，避免影响卡面/详情里的旧按钮。
- 资产卡/详情：有旧式反应窗口的卡（如米兰）也复用三态按钮；只有快速开关的卡保留旧文字按钮。
- 卡面神智角标移除；伤害/恐惧扣除标记改到卡面左侧，不再和右上角按钮叠在一起。

### 4.4 轻量保存（sidecar）

偏好不靠整局快照落盘，避免「改一个开关触发十几 MB 保存」：

- **路径**：`<DSH_HOME>/boardgame-hall/sessions/<modId>/prefs/<sessionId>.json`。
  单独子目录，避免被 [`readSnapshots`](../lib/sessions.js#L138-L168) 当成存档扫描。
- **结构**：

```json
{
  "version": 1,
  "sessionId": "bg-...",
  "updatedAt": "2026-10-26T...",
  "seats": { "0": { "states": { "01033": "skip" }, "seq": 42 } }
}
```

- **写**：任何覆盖变化后 500ms 去抖写一次；临时文件 + rename 原子替换；`persistOn` 关闭或
  `saveDetached` 时跳过。多人同时改只写一份合并后的 `seats`。
- **读**：所有 session 创建/加载入口调用同一个 `hydratePrefs(session)`；sidecar 存在且
  `updatedAt` 比快照里的副本新时以 sidecar 为准，否则按座位 `seq` 合并；都没有则空覆盖。
- **删**：扩展 `deleteSnapshot` 一并删除 sidecar；重置/新开一局生成新 `sessionId`；TTL 清理复用
  `pruneSnapshots`。
- **失败**：写失败只 `console.warn` 一次，内存继续用，客户端重连会重发；不影响对局。

### 4.5 协议与视图

```json
// prefs（单机走 POST /api/prefs）
{ "sessionId": "bg-...", "states": { "01033": "skip" }, "seq": 42 }

// move 捎带
{ "client": { "autoPrefs": { "states": { "01033": "skip" }, "seq": 42 } } }
```

- 校验：最多 256 个键、key 长度 ≤64、值只能是 `skip/ask/auto`、`seq` 为安全整数；只写本人座位。
- 视图：联机分支加 `autoPrefs: { mine: states, seq }`（只给本人）；没有 `defaults` 字段。
- 缓存：`cachedSessionView` 的 per-seat key 加该座位 `seq`，重连/多设备能拿到最新覆盖。
- 兼容：旧客户端的 `client.autoPass.codes` 按 `{ code: 'skip' }` 写入本人覆盖；旧存档没有
  `autoPrefs` 时按内置默认。

---

## 5. 修改路线

| 阶段 | 目标 | 主要改动 | 验收 | 回滚点 |
| --- | --- | --- | --- | --- |
| **0 语义冻结** | 三态、默认来源、覆盖生命周期、协议定稿 | 本文 + 用例表 | 评审通过 | — |
| **1 会话配置** | 先有地方存、能同步、能轻量落盘，不改对局行为 | `session.autoPrefs.seats`；`prefs` 与 move 捎带；视图 `mine` + seq；权限/上限；sidecar 读写删；旧 `autoPass.codes` 适配；单机 `/api/prefs` | 配置进/出/持久化/权限/乱序单测；对局状态零变化 | 不读取配置即回到现状 |
| **2 引擎暴露** | 真人能「看见」自动奖励窗口 | `autoOptionId`/`autoTriggerOptionId`/`cardCode`；真人 vs AI 分流；observation 白名单；`hasAutoReaction`/`autoByDefault`；replay driver 适配 | 真人出窗、AI 无窗、投影字段正确；旧引擎用例更新 | 引擎 legacy 开关 |
| **3 房主进程 settle** | 在发布前把 trigger/skip 都答掉 | `autoChoice` 钩子；三态解析；trigger 优先；四处调用点；离线策略；guard | 大厅集成：0 额外命令、窗口不发布、链式窗口一次结算 | `BOARDGAME_AUTOREACTION=0` |
| **4 客户端** | 角色面板的三态按钮 + 名字排版 + 异步同步 | 三态 store；单按钮 `skip → ask → auto → skip`；齿轮旋转/高亮、静态闪电+斜杠；名字省略号与固定按钮位；hover/aria；去抖 + 捎带 + 重试；兜底提交；i18n | 浏览器 1440/390/≤700：名字可截断、按钮不缩不换行、齿轮开转关停、hover 文案完整、不闪烁、不重复提交 | 隐藏自动档 |
| **5 兼容迁移** | 旧客户端/旧存档/旧中转不炸 | 旧覆盖迁移；缺 `autoPrefs` 按内置默认；sidecar 缺失回退；relay 无需改 | 兼容矩阵逐项 | 双 env |
| **6 验收文档** | 全量回归与说明 | 单测/大厅/浏览器/replay/perf；`auto-pass.md` 更新；新 `auto-reaction.md` | 全绿 + 基线说明 | — |

> 阶段 2 与 3 必须同批合入：只合 2 会让真人看到没人代答的自动奖励窗口。

---

## 6. 改前 / 改后

| 维度 | 改前 | 改后 |
| --- | --- | --- |
| 每卡配置 | 只有「快速反应」开/关 | 三态：`skip` / `ask` / `auto`；闪电+齿轮联动 |
| 开关外观 | 卡面/详情里的文字按钮（⚡ 开/关） | 角色面板名字右侧与有旧式反应的资产卡上的三态按钮：⚡+斜杠 / ⚡ / ⚙；齿轮开启亮起并旋转；hover 原生 `title`；资产卡不再显示神智角标，扣除标记在左侧 |
| 名字排版 | 固定宽度或随内容撑开 | `flex` 名字 + 固定尺寸控件；超长名字省略号，控件永远可见、不换行 |
| 默认值来源 | 每个玩家各自一套，无会话默认 | 固定内置默认（安全口径无目标纯收益 = `auto`，其余 = `ask`）；任何玩家开关都不改变默认 |
| 默认与房主 | 无会话默认概念；每个玩家的开关互相独立（含房主） | 固定内置默认 + 个人覆盖；房主开关仍只影响自己；无默认编辑入口 |
| 自动奖励 | 引擎对所有座位无条件自动领取 | 真人开窗、房主进程按覆盖/默认代答 `trigger`；AI 仍直接领 |
| 覆盖生命周期 | 无 | 逐卡覆盖保留到本局结束；不提供重置入口（v1 默认固定，掰回默认值即等价） |
| 开关修改 | 本机 localStorage → 异步 `prefs` + move 捎带 | 同一条异步通道；只收集个人覆盖；仍无协议往返 |
| 偏好落盘 | 不落盘 / 随整局快照 | sidecar 轻量保存，去抖 500ms，不触发整局快照 |
| 联机请求 | skip 由房主进程代答，0 条额外命令 | skip + trigger 都由房主进程代答，0 条额外命令 |
| revision / 日志 | 自动奖励在事务内，无额外 revision | 每次自动触发多一次 `commitMove`（revision/actionLog） |
| 单机 | 人类座位直接领 | 同一套逻辑（单机 = 个人配置 + 房主进程代答） |
| 客人视图 | 自己的快速反应集合 | 自己的覆盖（`mine`）+ 固定默认；无默认字段 |
| 离线座位 | skip 不代答，等人 | `auto` 自动开（纯收益，不卡桌）；`skip` 仍等人 |
| AI | 自动领取 | 跟随会话默认；v1 默认 = 内置默认，行为不变 |
| 引擎-only（测试/回放） | 自动奖励无窗口 | 真人出现 `auto` 窗口，评测脚本需补答 |
| 回滚 | `BOARDGAME_AUTOPASS=0` | 新增 `BOARDGAME_AUTOREACTION=0`（大厅 + 引擎 legacy 成对） |

---

## 7. 风险与缓解

| 风险 | 场景 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 引擎暴露的连带变化 | 测试/回放/工具只跑引擎，真人自动奖励变成待决窗口 | 高（基线/用例） | 阶段 2+3 同批；replay driver 优先选 `autoOptionId`；一次性重采基线并在文档标注 |
| 额外 revision / 日志噪音 | 每次自动触发多一条 `choose` | 中 | move 带 `auto: true` 供演出/日志过滤；P1.5 合并发布；perf 基准对比 |
| 「默认」被误解为房主配置 | 玩家以为房主关掉就全桌关 | 中 | 文档/帮助文案明确「默认来自会话配置，房主开关只影响自己」；v1 不提供默认 UI |
| 覆盖永久化 | 手动改过的卡本局内不再跟随默认 | 低（v1 默认固定） | 行为上掰回默认值即等价；文档写明；未来默认可配置时再评估重置 |
| 异步丢最后一次修改 | 切完立刻行动 / 断网 | 中 | move 捎带；去抖 flush；重连/2 分钟重发；失败静默重试 |
| 覆盖晚到导致多触发一次 | 客人关闭自动后，别人的命令先到 | 中 | 与自动跳过同级 best-effort；文档说明；纯收益可接受 |
| 视图缓存失效错误 | 座位 seq 没进缓存键 | 中 | per-seat key 加 seq；集成用例覆盖 |
| sidecar 生命周期 | 重置/删除/过期留下孤儿文件；写失败 | 中 | 扩展 `deleteSnapshot`；TTL 清理；失败只 warn 并靠客户端重发 |
| sidecar 与快照副本不一致 | 快照里带旧副本 | 低 | sidecar 更新时间更新时优先；按 seq 合并 |
| 离线策略与默认冲突 | 默认 `ask`，离线玩家窗口卡桌 | 中 | 离线按 `auto` 处理（纯收益）；文档写明 |
| AI 不跟随未来默认 | 默认改成 `ask` 后 AI 仍自动领 | 低（v1 无此配置） | v1 默认固定；未来配置默认时同步改 AI 结算 |
| 回滚不彻底 | 只关大厅，引擎仍对真人开窗 | 中 | 双开关成对；发布说明里写清 |
| 客人伪造其他座位 | 客户端塞别人的 `states` | 低/高 | 服务端只接受本人座位；拒绝未知字段 |
| 三态非法组合 | 数据层出现「快速关 + 自动开」 | 中 | 只存三态枚举；服务端拒绝未知值；转移用例穷举 |
| 主题固定宽度与 flex 冲突 | 现有 95/100px 定宽 | 中（名字被压、控件溢出） | 统一清掉定宽，改成 `min-width:0`；1440/390/≤700 验收 |
| 齿轮动画副作用 | 旋转被误认为「加载中」；晕动 | 低中 | 只有 `auto` 转；`prefers-reduced-motion` 关闭；亮色/描边表达状态 |
| 触摸端没有 hover | 手机看不到 title 描述 | 中（已接受） | 不加入额外说明（已定）；`aria-label` 保底 |
| 窄面板挤压 | 控件 + 头像占位后名字只剩省略号 | 低 | 接受名字只剩 `…`；控件尺寸不缩、不换行；必要时 ≤700 收紧头像/间距 |
| 三态按钮的可发现性 | 单按钮循环顺序不明显，读屏只听到一个控件 | 中 | hover/aria 都写「当前状态 → 下一档」；图标形状+斜杠+旋转三重区分；可选首次提示 |

---

## 8. 验收清单

- [ ] 默认值：安全口径内的无目标纯收益默认 `auto`、其余 `ask`；**房主把自己的卡关掉不影响其他玩家**。
- [ ] 覆盖：客人手动改的卡本局内保持；没有重置入口；掰回默认值行为等价于跟随。
- [ ] 三态转移：按第 1.1 表逐格点击，结果一致；不存在 `快速关 + 自动开`。
- [ ] 单机：同一套模型；个人覆盖 + 内置默认，无「房主默认」概念。
- [ ] 联机：0 额外客户端命令；链式自动触发由房主进程一次结算，其他席位看不到中间窗口。
- [ ] 异步：连续切换 N 次只发不超过一条 `prefs`；切换后立刻行动使用最新状态。
- [ ] 权限：成员只能写自己座位；客户端塞 `defaults`/别人座位被忽略或拒绝。
- [ ] 轻量保存：改覆盖后 500ms 内出现 sidecar；重启大厅后恢复；删除对局时 sidecar 一并删除；
      改开关不触发整局快照。
- [ ] 离线：自动资格的卡按 `auto` 结算，不卡桌。
- [ ] AI：v1 行为与今天一致（跟随内置默认）。
- [ ] 角色面板：名字超长出现省略号；控件固定尺寸、不换行、不被头像压住；没有对应反应的
      角色不渲染控件。
- [ ] 齿轮：`auto` 时亮起并旋转；`ask/skip` 静止；`prefers-reduced-motion` 下不旋转。
- [ ] 闪电：静态，无动画；开亮/关暗与三态一致。
- [ ] hover 能看到完整作用描述（原生 `title`）；键盘聚焦有 `aria-label` 等价描述；
      `role="switch"`、`aria-checked` 正确。
- [ ] 1440 / 390 / ≤700 三档排版不跳；切换状态不改变行高或控件尺寸。
- [ ] 点击控件不会误开角色卡详情；名字本身仍可点开详情。
- [ ] 回滚：`BOARDGAME_AUTOREACTION=0` 后行为与今天一致。
- [ ] 回放：默认路径的 golden replay 说明与重采计划；带三态的续算/存档重放一致。

---

## 9. 已定决策

1. **默认范围**：三态整梯都走会话默认；默认是内置/服务端配置，**不是房主个人开关**，v1 不开放
   房主修改默认的入口。
2. **单机**：直接当成个人配置，数据结构与联机一致。
3. **三态控件**：单按钮，`skip → ask → auto → skip` 循环；`skip` 暗闪电+斜杠、`ask` 亮闪电、
   `auto` 亮齿轮（旋转），点击语义见 1.1。
4. **离线**：按 `auto` 结算。
5. **AI**：跟随会话默认；v1 默认等于内置默认，行为不变。
6. **落盘**：偏好单独做 sidecar 轻量保存，不触发整局快照。
7. **触摸端说明**：不加入首次气泡/长按说明，只靠 `aria-label` 与图标状态。
8. **按钮尺寸**：22px 已验证够用；实现取 24×24 + 15px 图标，点击面积更稳，视觉不变。

## 10. 剩余实现细节（非产品决策）

- sidecar 的具体目录清理策略（是否随 TTL 一起 prune）。
- 视图字段命名（`mine` / `states`）与旧 `autoPass` 适配保留几个版本。
- 可选 `aria-live` 播报是否在 v1 就做。
- 未来默认可配置时，AI 结算的读点与配置入口（大厅设置/Mod 设置）。

## 11. 实施记录（2026-10-26）

已落地：

- **引擎**：`enableAutoReactionHosted()` 托管模式；旧式反应窗口带 `autoTriggerOptionId`/`cardCode`，
  纯收益自动奖励额外带 `autoOptionId`；新式非手牌反应通过 `ability-exec` 的候选 option 自动接入
  （恰好一个 auto 候选才代答）。`hasAutoReaction`（旧式 + 新式非手牌）与 `autoByDefault`（默认 auto）
  进卡面。默认 auto 采用安全口径：无目标、无资源/弃牌/充能成本（允许横置）、纯收益效果；罗兰、
  雷克斯、马克、幸运兔脚、米兰、孤狼等 17 张默认 `auto`；艾格尼丝、拾荒、升级版米兰 01533 等默认
  `ask`、可手动切 `auto`。快速事件（`fromHand`）和 event 卡不进 auto。这些提示只在托管模式进 state，
  纯引擎/回放指纹不变。
- **大厅**：`session.autoPrefs.seats`；`prefs` / move 捎带；`autoChoice` 代答 trigger 优先、skip 其次；
  新式反应窗口只有恰好一个候选卡 auto 时代答；sidecar 读写删 + 读档恢复；单机 `/api/prefs`；
  旧 `autoPass.codes` 兼容成 skip。
- **存档兼容**：旧存档的内嵌卡面若缺少 `hasAutoReaction`/`autoByDefault`，`save-migration` 检测后
  强制刷新一次卡面（不 bump 资源版本），读档后按钮与默认值立即可用。
- **客户端**：三态 store；单按钮 `skip → ask → auto → skip`；名字行省略号 + 固定按钮位；
  250ms 去抖 + move 捎带 + 失败重试；窗口兜底提交；原生 `title`。
- **界面**：角色面板名字右侧 24px 三态按钮，`skip` 暗闪电+斜杠、`ask` 亮闪电、`auto` 亮齿轮旋转；
  长名字省略号，按钮不缩/不换行。有旧式反应的资产卡（如米兰）也显示三态按钮；资产卡不再显示
  神智角标，伤害/恐惧扣除标记移到左侧，不与右上角按钮重叠；卡面已有经验/弱点角标时按钮左移，
  双面角标下移。
- **测试**：
  - 完整卡牌清单见 [quick-reaction-cards.md](quick-reaction-cards.md) / [quick-reaction-cards.csv](quick-reaction-cards.csv)；
  - `tests/hall/auto-reaction.test.mjs`：默认 auto / ask / skip / 四座位链 / ask 中断 / sidecar 重启恢复；
  - `npm run test:hall` 全绿；
  - `player-dashboard.browser.mjs` 全绿（含三态按钮循环、齿轮动画、长名字省略、米兰/升级版米兰资产卡按钮、扣除标记、经验角标不重叠）；
  - Arkham 定向测试（auto-pass、reaction-preferences、save-migration、i18n、notz golden replay）全绿。
- **已知非本功能失败**（干净 HEAD 上同样存在，未改基线）：
  - `carcosa-curtain-call-hub` / `-only` 的初始状态指纹与旧基线不一致（`ffee…` vs `7ba…`）；
  - `audit/tcu-migration.json --check` 因本机缺少 release/interaction 浏览器证据而 gate 失败。

## 12. 后续卡牌的自动接入

- 新卡照常写 `cards-data.js` + 单卡条目；`allCardDefs` 会从 `EFFECTS.reactions`、调查员规则和条目
  abilities 自动推导 `hasReactionPrompt` / `hasAutoReaction` / `autoByDefault`，UI 不需要逐卡注册。
- `kind:'reaction'` + `legacyReaction:true`（迁移标准写法）→ 自动获得快速/自动入口。
- 默认 `auto` 的安全口径：**无目标、无资源/弃牌/充能成本（允许横置）、效果是纯收益**
  （获得资源/发现线索/抽牌/加当前检定/上下文伤害）；次数限制不影响。罗兰/雷克斯/幸运兔脚/实验室助理/
  艺术生/报纸/仪式蜡烛/看门狗等 17 张按此默认 auto。
- 有目标、有资源/弃牌/充能成本、`chooseOne`/搜索/`resolve` 等反应默认 `ask`、可手动切 auto
  （如艾格尼丝、拾荒、升级版米兰 01533）；升级版米兰这类新式 `resolve` 不做静态自动判断。
- **新式 `kind:'reaction'` 且 `fromHand !== true`、又不是 event 卡**（如升级版米兰 01533）→ 也会自动
  获得三态按钮；大厅只在窗口里恰好一个候选卡设为 auto 时选择它，多个候选保持询问，不替玩家排序。
- `kind:'reaction'` 但 `fromHand:true`（快速事件）、`free` / `played+fast+trigger` / `playerWindow` /
  `boost` → 只会获得快速开关，不会进入 auto；要 auto 需改成非手牌反应或扩展自动代答点。
- 纯文本写了 `[reaction]`、但还没有能力条目的卡不会出现按钮；反应实现后自动出现。
- [`reaction-preferences.test.mjs`](../games/arkhamhorror/tests/reaction-preferences.test.mjs) 有覆盖守卫：
  新条目有 `reaction` 但没入口、legacy 反应没 auto、或 auto 字段缺失时，`test:fast` 会失败。
