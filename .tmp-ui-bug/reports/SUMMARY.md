# 牌桌 UI 两处问题修复总结（2026-10-26）

## 问题 1：左下方「调查员头像」与「反应模式齿轮」错位

- **现象**：用户截图红圈一。名字行右侧的三态齿轮（`.ah-reaction-mode`）与调查员头像（`.ah-dock-portrait`）不在同一水平线。
- **根因**（静态问题，不是刷新抖动）：commit `9b7ab72` 新增齿轮时，头像仍是旧版 `position:absolute; top:0; right:0`（对齐调查员列顶部＝kicker 行），齿轮在名字行内垂直居中 → 两者中心恒差 **18.5 CSS px**（有玩家头像时）。用户截图反推 Δ≈18.7 CSS px，与复现一致（<0.5px）。
- **修复**：
  - `web/game-ui.js`（renderPlayerDock）：把 `.ah-dock-portrait` 移入 `.ah-dock-name-row`，排在齿轮之后；
  - `web/player-dashboard.css`：头像改为在名字行内 `top:50%; translateY(-50%)` 居中，名字行 `padding-right:36px` 预留头像位（原 `margin-right:36px` 移除）；`≤1000px` 头像隐藏时 `padding-right:0`（顺带修掉旧版窄屏 36px 空槽）。
- **验证**：视口 1001/1100/1240/1366/1440/1598/1632/1700/1920 全部 Δ=0.0px；齿轮位置、名字截断宽度、齿轮→头像 6px 间距与旧版一致；`player-dashboard.browser.mjs` 8/8 通过（新增对齐断言）。

## 问题 2：右侧「下方」（调查员 beneath 区）整排在刷新/演出时消失再出现

- **现象**：用户截图红圈二。刷新局势、结束回合、AI/自动结算演出时，「下方」整排短暂消失后恢复。
- **根因**：演出中间态快照缺私有字段。
  1. 服务端每次演出提示/checkpoint 用 `captureTableState()` 抓「演出快照」（`src/engine/engine.js:260`、`src/engine/dispatch.js:143`）；
  2. v0.3.1 的 `captureTableState()` 调查员映射只带手牌/装备等，**没有 `beneath`/`beneathCount`**；
  3. 客户端 `web/table-presentation.js` 的 `applyStep()` 用该快照整体替换 `displayed.state.investigators`，随后 `onChange()` 整树重绘；
  4. `renderPlayerDock()` 里 `beneath.length ? 渲染 .ah-beneath-row : null` → 该次渲染整排不显示；
  5. 中间态一直陪跑到演出队列 `drain()` 结束才恢复 → 消失时长 = 剩余演出时长（实测单段 1.5s，结束回合 6.2s，带阅读型剧情页 >18s）。
- **修复**（`src/integration/presentation-state.js`）：
  - `captureTableState()` 调查员映射带 `beneath` 与 `beneathCount`；
  - `projectTableState()` 对非观察者座位清空 `beneath`（保留公开张数 `beneathCount`，与 `observation.js` 的隐私契约一致）。
- **验证**：
  - 修复前 A/B：8 次重绘 6 次缺行、帧级缺口 4970ms；结束回合 3032 帧中 876 帧缺行、缺口 6201ms。
  - 修复后真实大厅 + 真实对局（赛菲娜开局面牌）：刷新 200 帧采样 **0 次缺行**；结束回合 3017 帧 **0 帧缺行 / 0ms 缺口**。
  - Node 回归 `tests/state-presentation.test.mjs` 新增「演出快照保留本人下方牌、他人只拿张数」15/15 通过。

## 涉及文件（games/arkhamhorror 仓库，均未提交）

```
 M src/integration/presentation-state.js   (+5/-1)
 M web/game-ui.js                          (+5/-2)
 M web/player-dashboard.css                (+9/-3)
 M tests/state-presentation.test.mjs       (+19)
 M tests/player-dashboard.browser.mjs      (+27)
```

## 门禁与注意事项

- `playwright player-dashboard.browser.mjs`：**8/8 通过**；`node --test tests/state-presentation.test.mjs`：**15/15 通过**。
- `node tools/run-tests.mjs fast`：3585 pass / 2 fail。两个失败为**同工作区另一个并行会话的卡牌内容/账本改动**导致（golden replay carcosa hub 指纹、TCU migration 账本可复算），与本次 UI/快照改动无关（本次未改规则与卡牌数据）。
- `p3-table/presentation.browser` 的 11 个失败是本工作区既有问题（故事导入演出叠层挡住点击、setup 文案与测试断言不一致）；已用 HEAD 原始文件 A/B 验证**同样失败**，非本次改动引入。
- **需要重启大厅进程**（`server.js`）让服务端的 `presentation-state.js` 修复生效；浏览器刷新页面即可拿到前端修复。
- 次要发现（未修）：视口约 1000px 宽且「下方」≥2 张时，战场横向空间不足，第 2 张需内层滚动才能看到；用户窗口约 1470px 不受影响，如需要可另行处理。
- 并行会话仍在修改卡池限制/引擎等文件；本报告只涉及上面 5 个文件。

## 证据

- 三栏对比（用户截图 / HEAD / 修复后，含中心线与 Δ）：`.tmp-ui-bug/reports/shots/cmp/compare-zoom-3up.png`
- 修复后头像-齿轮对齐裁剪图：`.tmp-ui-bug/reports/shots/cmp/fixed-dock-1400.png`、`fixed-dock-1700.png`
- 详细诊断报告：`.tmp-ui-bug/reports/dock-layout.md`、`.tmp-ui-bug/reports/beneath-flicker.md`
