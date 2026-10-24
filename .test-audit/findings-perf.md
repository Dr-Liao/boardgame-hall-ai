# 全量测试性能分析与优化方案（问题 3）

- 审计对象：`G:\boardgame-hall-ai`（大厅 HEAD `b900998`）+ `games/arkhamhorror`（Mod 独立仓库 HEAD `496ae99`，**工作树脏，且审计期间 02:35–02:48 有并发会话改文件、02:48:54 起另有会话在跑它自己的全套测试**）
- 机器：node `v22.23.1`，32 逻辑 CPU，Windows（`.test-audit/env.json`）
- 方法：只读静态分析 + 解析 Lead 实测产物（JUnit / wall-times / dot log / git 历史）。本 agent 未运行任何测试或基准；耗时数字全部来自 Lead 测量，或明确标注为「注释/文档值」。
- 数据源：`junit-hall.xml`、`junit-arkham-minor.xml`（3087 `<testcase>` + 1 `<testsuite>` = 3088 条）、`wall-times-minor.json`（158 文件 / 135.49s）、`arkham-run-killed.log`、Lead 的 HEAD clean worktree 计时。

> **口径警告（每个数字都适用）**
> 1. 当前工作树是 **WIP 脏树且红**（25 个失败，§3.4），不是发布态；Arkham 仓库正在被并发修改。
> 2. `node --test` 的 JUnit **没有文件分组**：顶层 `test()` 直接变 `<testcase>`，只有带子测试的才变 `<testsuite>`（Arkham 仅 1 个）。§1/§3 的 per-file 数字用「测试标题→文件」反查，**1072/3088（35%）动态命名用例无法归属，per-file 是下界**；并行跑时 testcase time 还含调度等待，**只用于排序，不用于绝对值**。
> 3. 全量（含两个慢文件）那次的绝对墙钟受并发写入/并发测试影响，**只能作下限证据**。

---

## 结论摘要（回答「全量测试是否耗时过长、有没有优化空间」）

1. **是，明显过长且被少数几个文件绑架。**
   - **HEAD 干净检出**：全量 Node 墙钟量级 **≥7 分钟**（`campaign-n4` ≥420s、`replay-fuzz` ≥300s 两个 watchdog 下限；实际 ≥7–10 分钟）。
   - **脏树全量**：**≥15 分钟**（被强杀，只作下限）。
   - **去掉这两个慢文件后的 158 文件**：**135.5s**，其中 `hall-online.test.mjs` 一个文件就 129.3s（单条用例 117.1s）。
2. **文档数字全部过时**：`suites.mjs` 的 130.3s/71.7s、`docs/testing.md` 的「全量 154s」写于 2026-10-18/19，之后仓库涨了 134 个提交、src 新增 1088 个文件；HEAD 上实测分别是 **≥3.2× / ≥4.2× / ≥3–4×**。机器单核性能正常（i9-13900K 微基准），**不是环境慢**。
3. **优化空间很大且分层**：把两个慢文件拆分+削减参数 → HEAD 全量 **≥420s → ~100–150s（-65~75%）**；修引擎热点回归（单步成本 3–4×）→ 再降到 **~60–90s**；瘦身 hall-online → 其余 158 文件 **135.5 → ~55–60s**；**`test:fast` 实测已 95.5s**（docs 写 8s、注释写 40s），拆 replay-golden（占 86%）后可到 **~20–40s**；assets 实测 64.8s 主要可压到 ~25–30s；CI 目前 **0 测试门禁**，需要补。
4. **不要把「红」当「慢」**：当前 25 个失败是 22 个 WIP 半成品/产物未重生成 + 2 个真过时（`suite-manifest` 清单漏登记在 clean HEAD 同样复现；`tcu-migration` 标题）+ 1 个可疑 30s 超时。

---

## 一、实测数字（每行标注测量条件）

| # | 测量项 | 数值 | 何时测 | 并发负载 | 产物/备注 |
|---|---|---|---|---|---|
| 1 | `npm run test:hall`（大厅 29 文件 / 160 例） | **14.0s 墙钟，0 失败；用例时间合计 52.2s** | 02:24 起，约 14s | 无 | `junit-hall.xml`；墙钟 = 最慢文件 `updates.test.mjs` 13.3s + 启动 |
| 2 | Arkham **去掉 replay-fuzz、campaign-n4 后 158 文件** | **135.49s 墙钟，exit 1，25 失败；3088 条用例，用例时间合计 861.2s** | 02:39:25–02:41:40 | 无（Lead 确认） | `wall-times-minor.json` + `junit-arkham-minor.xml` |
| 3 | Arkham **全量（含 2 个慢文件）** | **>891s（14.85min）未跑完，被强杀** | 02:24:17–02:39:19 | 有：worktree 被并发写 + 02:48:54 起另有全套测试 | 只作「当前全量 ≥15min」下限，不作精确值 |
| 4 | 其中 `campaign-n4.test.mjs`（脏树） | **≈9.3 分钟（~500s CPU）** | 观测 | 同 #3 | 无 JUnit（被杀前未落盘） |
| 5 | 其中 `replay-fuzz.test.mjs`（脏树） | **>14.8 分钟仍未结束（CPU 100% 单核，被强杀）** | 观测 | 同 #3 | 同上 |
| 6 | **HEAD clean worktree：`replay-fuzz.test.mjs` 单独计时** | **300s watchdog 强杀（CPU ~277s+）→ ≥300s** | 02:42:42–02:47:42 | 无（后段有轻微负载） | `head-replay-fuzz.log`；**注释 71.7s 的 ≥4.2 倍，且与 WIP 无关** |
| 7 | **HEAD clean worktree：`campaign-n4.test.mjs` 单独计时** | **420s watchdog 强杀（timedOut=true）→ ≥420s** | 02:47:42–02:54:42 | 02:48:54 起受另一会话全套测试负载影响（可能偏大） | `head-slow-times.json`；**注释 130.3s 的 ≥3.2 倍** |
| 8 | 每文件固定启动税 | `engine.js` 依赖图 import **809ms**（含 `cards-data.js` 191ms/52MB heap）、`content/registered.js` 773ms、`lib/server.js` 50ms、node 基线 13–19ms | 02:2x | 无 | 158 文件 ×~0.9s ≈ **140s CPU 未计入用例时间** |
| 9 | `npm run test:hall:browser`（5 spec / 10 例） | **35.75s 墙钟 / playwright 27.7s / 10 passed（≈2.8–3.6s/例）** | 02:52 | 无 | `wall-times-hall-browser.json`；不在 `npm test` 内 |
| 10 | **HEAD clean worktree 全量 Node 墙钟（推算）** | **≥ max(≥300s, ≥420s) 量级 = ≥7 分钟下线；实际量级 ≥7–10 分钟（禁止写精确值）** | — | — | 两个慢文件都触发 watchdog，真实值未取得；其余 158 文件量级 135.5s |
| 11 | **`run-tests.mjs fast`（131 文件 + 守卫）** | **95.54s 墙钟，exit 1；2648 tests / 2645 pass / 3 fail**（02040 槽位、state-presentation 米奇槽、tcu-migration 账本 P6→P7，均 WIP 半成品） | 02:55–02:56 | 无（Lead 测） | `tier-fast.log` + `tier-times.json`；**replay-golden 82.4s 占 86%** |
| 12 | **`run-tests.mjs assets`（14 文件 + 守卫）** | **64.82s 墙钟，exit 1**（125 tests / 118 pass / 7 fail，生成物漂移类 WIP） | 02:56:57–02:57:55 | 无（Lead 测） | `tier-assets.log` + `tier-times.json`；audit-resources 35.8s + import-cards 25.6s 占 95% |

**墙钟分解（#2，158 文件 / 135.5s）**：

```
135.5s ≈ 启动排队 ~6s + hall-online.test.mjs 129.3s（关键路径）+ 收尾
         └─ 其中单条「Arkham four humans…」= 117.1s
            = 240 步 × 350ms 固定 sleep（84s 下限）+ 每步 ~9 次 status/waitFor HTTP/JSON 往返 + 引擎
```

---

## 二、与文档声明的对照（哪些过时、几倍）

| 文档声明 | 出处 | 实测 | 结论 |
|---|---|---|---|
| `fast ≈ 40s / slow ≈ 180s / assets ≈ 60s` | `tests/suites.mjs:4-7` | **`test:fast` 实测 95.54s（2648 例，02:55）**、`test:assets` 实测 64.82s、slow 310.4s（缺 2 慢文件）；fast 归属 340.2s 是注释合计 96.7s 的 3.5× | **fast 注释是实测的 ~2.4× 偏乐观、assets 基本吻合（1.1×）**；16 个 fast 文件/5 个新 tcu 文件无注释 |
| `campaign-n4 130.3s`（占 40%） | `suites.mjs:145` | 脏树 ≈9.3min（~**3.8×**）；**HEAD clean worktree ≥420s 被 watchdog 强杀（≥3.2×）** | **过时**：该数写于 2026-10-18 提交 `2c6fb1d`，此后 134 个提交、src 新增 1088 个文件 |
| `replay-fuzz 71.7s` | `suites.mjs:146` | 脏树 >14.8min（**>12×**）；**HEAD clean worktree ≥300s（≥4.2×）** | **确定过时，且不是 WIP 造成**（HEAD 已 4 倍以上） |
| `all 328s → 约 135s`（单进程→并行） | `tools/run-tests.mjs:4` | HEAD 上仅 replay-fuzz 一个文件就 ≥300s；脏树全量 ≥15min | **过时**（当前并行 full 的下限都已远超 135s） |
| `fast 43s → 7s` | `tools/run-tests.mjs:4` | **`run-tests.mjs fast` 实测 95.54s（2648 例，02:55，脏树）**；其中 replay-golden 一个文件 82.4s | **过时 13.6 倍**（7s vs 95.5s） |
| 「69 个用例文件 / fast 8s / 全量 154s / node 单进程 5.5min」 | `docs/testing.md:3,13-17,38-39,44` | 当前 Arkham 160 个 test 文件；**fast 实测 95.5s = docs「8s」的 ~12×**；assets 64.8s = docs「30s」的 ~2.2×；两个慢文件在 HEAD 上 ≥420s/≥300s → 全量至少低估 3–4 倍 | **过时**（该文件最后修改 2026-10-19） |
| 浏览器「约 7 秒/用例」 | `docs/testing.md:19` | hall 浏览器 10 例实测 **35.75s / 10 例 ≈ 3.6s/例**（playwright 27.7s） | **高估 2 倍**（应为 ~2.8–3.6s/例） |
| `test:fast = 2510 例` | `audit/baseline.json`（提交 `d3a7e69`，10-23 20:38） | 当前磁盘 160 个 test 文件；本次实测 3088 条（已不含 2 个慢文件）→ 用例数已远超 2510 | **过时**（需重生成 baseline） |
| 「fast 2337 例全绿」 | `AGENTS.md:67` | 同一时间点三个数字（2337/2453/2510）互不一致 | **口径混乱**，建议只引用 JUnit 实时统计 |

**git 考古（把「过时」钉到提交与日期）**  
`git log -S '130.3'` 只有引入提交、从未更新；`-S '71.7'` 同理。规模对比：

| 数字 | 引入提交/日期 | 当时规模 | HEAD（2026-10-24 01:44） |
|---|---|---|---|
| 130.3s | `2c6fb1d` 2026-10-18 | 72 个测试文件 / 36 个 src JS / 0 个单卡文件 | **154 tracked 测试文件 / 1144 个 src JS**（玩家卡 entries 493 + 非玩家 encounter-entries 532） |
| 71.7s | `622f957` 2026-10-20 | 116 个测试文件 / 57 个 src JS | 同上；`622f957..HEAD` 共 **134 个提交，其中 104 个动 src、73 个动 tests、src 新增 1088 个文件** |

→ 结论：**文档/注释耗时已严重过时，且不是 WIP 造成的**。HEAD clean worktree（`496ae99`，独立 worktree、单文件计时、watchdog 强杀）实测：
- `replay-fuzz` **≥300s**（注释 71.7s → **≥4.2×**）；
- `campaign-n4` **≥420s**（注释 130.3s → **≥3.2×**；脏树里在 158 并行池中约 560s / 9.3min）；
- **HEAD 全量 Node 墙钟量级 ≥ max(≥300s, ≥420s) = ≥7 分钟；实际量级 ≥7–10 分钟（只有 watchdog 下限，不是精确值）**；`docs/testing.md`「全量 154s」至少低估 3–4 倍。
- 机器本身正常：i9-13900K / 32 线程单核微基准（3e8 循环 0.28s）无异常 → 慢是仓库演化（134 提交、src 新增 1088 文件、单步成本涨 3–4×）导致的，不是环境问题。
- 附带：clean HEAD worktree 里 `suite-manifest` 守卫同样失败（3 个已提交测试文件从未登记）→ 这是 HEAD 上的真实缺陷，不是脏树产物。

---

## 三、瓶颈与 Pareto

### 3.1 Pareto：per-file 用例时间（独立排序用，下界；testcase time 含并行调度等待）

| 排名 | 文件 | 用例时间合计 | 关键结构 |
|---|---|---|---|
| 1 | `hall-online.test.mjs`（slow） | **129.34s** | 单条 117.1s：240 步 × 350ms sleep + 每步 9 次 status 往返 |
| 2 | `replay-golden.test.mjs`（fast） | **82.43s** | 单条 67.65 + 14.52：786 步 × 2 次全量重放（注释 11.2s → 7.4×） |
| 3 | `notz-n4.test.mjs`（slow） | 36.61s（实际 ≥61s） | 单条 34.57s；最多 24 次「建局+整局推进」种子搜索 |
| 4 | `core-final-acceptance.test.mjs` | 35.91s | 单条 34.52s（注释 6.0s → 6×） |
| 5 | `audit-resources.test.mjs`（assets） | 35.78s | 单条 21.6s：in-process 全量审计（哈希 226MB 参考源 + 243MB web 目标）+ 子进程再跑 `--check-source` |
| 6 | `p2-hub-http.test.mjs` | 33.43s | 含 **30.21s 超时失败** |
| 7 | `dunwich-rules.test.mjs` | 26.38s | 117 条用例（注释 9.0s） |
| 8 | `decision-invariants.test.mjs` | 26.15s | 单条 20.22s（注释 13.4s） |
| 9 | `import-cards.test.mjs`（assets） | 25.59s | 子进程 `--check` 8.68s（把整次导入又做一遍） |
| 10 | `save-migration.test.mjs` | 22.57s | 单条 18.88s（注释 3.7s → 6.1×） |
| 11 | `tcu-investigators.test.mjs` | 17.83s | 单条 15.87s（注释 0.2s，已完全失真） |
| 12 | `flow-n5.test.mjs` | 16.73s | 注释 2.4s → 7× |
| 13 | `replay.test.mjs` | 16.23s | 注释 4.2s |
| 14 | `tfa-investigators.test.mjs` | 13.69s | 注释 4.1s |
| 15 | `core-story-acceptance.test.mjs` | 12.35s | 注释 1.8s |

前 10 占已归属用例时间（731.7s）的 **61%**，前 2 占 **29%**。**去掉 hall-online 后，replay-golden 82.4s 就是新的关键路径**。

### 3.2 主要瓶颈判定

0. **全量墙钟 = 两个慢文件的最大者 + 其余 158 文件（在 31 槽位池里被抢 CPU/排队）**：HEAD 上 `campaign-n4` ≥420s、`replay-fuzz` ≥300s，其余 158 文件干净时段 135.5s → 全量量级 **≥7 分钟**；脏树又分别恶化到 ~560s 与 >891s，全量 ≥15 分钟。**只要这两个文件不拆/不削，其他优化对 full 墙钟都只是噪声。**
1. **单文件内串行长用例**（文件是 node --test 的最小并行单位）：hall-online 单条 117s、replay-golden 单条 67.7s、notz-n4 单条 34.6s、campaign-n4 的「7 组 900 动作全战役 × 每动作 `clone(state)`」矩阵。  
   158 文件平均并行利用率 = 861.2s / 135.5s / 32 = **20%**，即使加上 ~140s 启动税也只有 ~23%——**并发不是瓶颈，关键路径是**。
2. **引擎热点回归（HEAD 上已存在，WIP 叠加）**：`replay-golden` 11.2→82.4s（7.4×）、`save-migration` 3.7→22.6（6.1×）、`notz-n4` 5.8→≥61（10×）、`core-final` 6.0→35.9（6×）、HEAD `replay-fuzz` ≥300s（注释 71.7，≥4.2×）；而纯 IO/审计类基本不变（`import-cards` 22.1→25.6 = 1.16×，`audit-resources` 25.5→35.8 = 1.4×）→ **回归在「建局 / applyMove / 重放 / stateHash / JSON clone」路径**，是「单卡文件化后每进程 import 1000+ 模块 + 状态变大 + 每动作钩子」的综合结果。这解释了为什么 `npm test` 的体感是「卡在少数几个引擎重测试上」。
3. **固定 sleep 与轮询**：hall-online 84s sleep（占该用例 72%）、大厅 ai-background 10.4s sleep、ai-retry 300ms×多轮重试。
4. **生成物审计重复重活**：`audit-resources` 一次 ≈695MB 读+sha256（226MB 参考源×2 + 243MB `web/`）+ 13MB 卡池解析；`import-cards` 的 `--check` 子进程把导入全做一遍；`presentation-images` 4 次 spawn 同类工具。
5. **每进程启动税**：158 文件 ×~0.9s ≈ **140s CPU**（≈ fast tier 注释总时长的 1.4 倍），来自 engine 依赖图 import（809ms/文件，含 13.5MB `cards-data.js` 的 191ms/52MB heap）。

### 3.3 tier 视角

| tier | 文件数 | 注释合计 | 实测归属合计（下界） | 关键路径文件 |
|---|---|---|---|---|
| fast | 127 | 96.7s（115/131 有注释） | **340.2s** | **`test:fast` 实测墙钟 95.54s（脏树，02:55，2648 例）**；replay-golden 82.4s 占 86% |
| slow | 7（缺 2） | 254.2s | **310.4s** | hall-online 129.3s |
| assets | 14 | 57.1s | **71.4s** | **`test:assets` 实测墙钟 64.82s（02:57）**；audit-resources 35.8s + import-cards 25.6s 占 95% |
| 未登记（当时） | 3 | — | 9.7s | hall-static 2.4 / view-shared-state 5.3 / view-static 2.0 |
| 守卫 | 1 | — | 0s（失败） | `suite-manifest`（HEAD 失败；脏树 02:45 已被并发会话补登记后通过，见 §5.6） |

### 3.4 失败面（避免把「红」误读成「慢/过时」）

25 失败 = **22 WIP 半成品/产物未重生成 + 2 真·过时 + 1 可疑 flake**：

- **(a) WIP / 产物未重生成（22）**：产物/索引过期 6（`architecture-guard` ability-coverage、`card-entries` entries/index、`migration-tools` 572!==570、`import-cards`×3 生成物漂移、`presentation-images` --check 漂移）；实现未落地 13（`ability-layer`×2、`p0-regressions` resolveCardAbility、`dunwich-player-gaps` 02040 槽位、`state-presentation` 米奇槽、`tcu-migration` P6!==P7 账本、`tcu-player-m2-4`×2、`tcu-primitives-p7`×3、`tcu-player-ledger`）；资源缺失 3（`music-assets` 缺 theCircleUndone BGM、`presentation-http`×2 卡背/卡图 404）。
- **(b) 真·过时断言/清单（2）**：`suite-manifest.test.mjs`（磁盘比 `node-suite` 多 3 个**已提交**文件 `hall-static`/`view-static`/`view-shared-state`，由 `c2b0124`、`7975937` 引入未登记 → HEAD 上 `npm test` 必红；这 3 个文件从 10-23 起从未被全量入口执行；02:45 已被并发会话补登记）；`tcu-migration.test.mjs` 标题仍写「玩家包 catalog-only」正文已断言 verified。
- **(c) 可疑 flake（1）**：`p2-hub-http.test.mjs`「P2 关卡结算停在局外页…」30.21s 超时（同文件其余用例 3.2s 通过）。建议单独重跑 + 临时 timeout 120s 判定。

---

## 四、优化方案（按 ROI 排序）

> 收益基线：①**HEAD 干净检出 full Node 墙钟量级 ≥7 分钟（= max(≥300s, ≥420s) 的 watchdog 下限，实际 ≥7–10 分钟）**；②**脏树全量 ≥15 分钟（下限）**；③**去掉两个慢文件后的 158 文件 = 135.5s**。所有预估都要求复测确认。

### O1【P0】拆分 + 瘦身两个超慢文件：`campaign-n4` / `replay-fuzz`（HEAD 上就是全量墙钟的 75%+）
- **做法**：① `campaign-n4.test.mjs`（15 条）拆 3 个文件（core 取消购卡/回滚/观察者；campaign 结局/创伤/牌组迁移；matrix 7 组全战役），文件=并行单位；② matrix 7→3 组（1p/2p/4p standard，难度差异留 smoke），900 步上限按实际收紧，`clone(state)` 每动作 → 每 20 动作（现在最多 6300 次深拷贝）；③ `replay-fuzz` 2 条拆 2 文件，默认 full 用 40 局/2000 步（阈值同比降），5000 步全参数版留 nightly。
- **预估收益**（基于 HEAD watchdog 下限，非精确值）：`campaign-n4` **≥420s → 预计 ~90–150s**（拆分后墙钟=最大单组；以实测最大组为准）；`replay-fuzz` **≥300s → 预计 ~70–100s**（拆分+参数×0.4）；两者并行后 **HEAD 全量 ≥420s → ~100–150s（-65~-75%）**，且其余 158 文件不再被抢 CPU。
- **风险**：中（丢 easy/hard/expert 全流程、fuzz 探索面缩小；nightly 全参数 + 种子轮转补偿）。
- **验证**：`node tools/run-tests.mjs all` 墙钟 + JUnit；`node --test tests/campaign-n4-matrix.test.mjs` / `tests/replay-fuzz-games.test.mjs` 单文件计时；新文件必须同 commit 登记 tier（守卫会拦）。

### O2【P0】瘦身 `hall-online`（158 文件墙钟关键路径，单条 117.1s）
- **做法**：240→120 步；`setTimeout(350ms)`→150ms（或改「命令回包 revision + 广播到达」条件等待）；每步 9 次 status 往返 → 从 command 回包读 revision，只保留 1 次视图一致性校验。
- **预估收益**：单条 117.1→**~35–45s**；文件 129.3→~45–55s；**158 文件墙钟 135.5→~55–60s（-56%）**，之后关键路径换成 replay-golden。
- **风险**：中（relay 限流/重连时序可能 flaky；保留 relay 重启与帮骰/私人检定断言）。
- **验证**：`node --test tests/hall-online.test.mjs` 连跑 10 次；`node tools/run-tests.mjs slow`；JUnit 该用例 <60s。

### O3【P0】定位/修复引擎热点回归（HEAD 已 4×+，WIP 叠加）
- **做法**：① 用 Lead 的 HEAD worktree 对照把「HEAD 已慢多少」和「WIP 额外回归」拆开（replay-fuzz 已确认 HEAD ≥300s）；② 对 `replay-golden`（786 步×2 重放，最可复现）跑 `node --cpu-prof --test tests/replay-golden.test.mjs`，看 `stateHash/stableStringify`、`JSON clone`、`applyMove` 占比；③ 重点怀疑：每步 `stateHash` 全量 `stableStringify`、每动作钩子/原语注册表扫描、state 变大（新卡牌/战役字段）；④ 修法：replay 改增量哈希/只哈希权威字段；applyMove 热点加缓存；若有 per-action 全表扫描则改索引。
- **预估收益**：HEAD 上已确认慢 3–4×（`replay-fuzz` ≥4.2×、`campaign-n4` ≥3.2×，机器单核性能正常已排除环境原因）；修到「注释时代 2× 以内」→ `campaign-n4 ≥420s→~260s`、`replay-fuzz ≥300s→~140s`、`replay-golden 82→~20–30s`、fast tier 340→~150–200s；**与 O1 组合后 HEAD 全量目标 ~60–90s**。
- **风险**：中（不能改变 replay 指纹；replay-golden 本身就是门禁）。
- **验证**：`node --test tests/replay-golden.test.mjs tests/replay.test.mjs` + `node tools/replay-fixtures.mjs --verify`；`node --cpu-prof` 前后对比；单文件 watchdog 计时。

### O4【P1】默认入口分层 + 大厅/Mod 并行 + CI
- **做法**：根加 `test:fast`（hall + arkham fast）、`test:full`（all）、`test:nightly`（full + p7/浏览器）；`npm test` 默认 = fast；写 `tools/test-all.mjs` 用 `Promise.all` 并行跑 hall 与 arkham（省 14s 串行 + 2 层嵌套 npm spawn）；CI 加 `test.yml`（PR 跑 fast；nightly 跑 nightly；release 打包前跑 full）。**当前两个仓库的 release.yml 都不跑任何测试。**
- **预估收益**：日常入口 `test:fast` 实测 95.5s →（O7 拆 replay-golden 后）**~20–40s**；合并门禁 full 从 HEAD ≥7min → O1 后 ~100–150s、O1+O3 后 ~60–90s；大厅 14s 完全被 Arkham 吸收；防「清单漏登记」类回归。
- **风险**：低。
- **验证**：`npm test`（fast）<40s；`npm run test:full`；CI workflow 绿灯。

### O5【P1】生成物审计去重/缓存/移出默认层
- **做法**：`audit-resources` 去掉重复的子进程 `--check-source`（或加 `--skip-media` 用 size+mtime）；目标指纹对 `web/audio`(174.6MB)+`web/img`(67.8MB) 改 size+mtime（整文件 sha256 留 nightly）；`import-cards` 子进程 `--check`（8.68s）与 in-process 导入重复 → 只留其一；`presentation-images` 4 spawn 合并；整个 assets tier 移出默认 full，放 nightly。
- **预估收益**：`test:assets` 实测墙钟 64.8s → **~25–30s（-55%）**；`audit-resources` 35.8→~18–20s（该文件占 assets 归属时间的 50%）。
- **风险**：低-中（媒体哈希减弱；抽样哈希+nightly 强校验补偿）。
- **验证**：`node --test tests/audit-resources.test.mjs tests/import-cards.test.mjs` 时间；`npm run audit:check`、`import:check` 仍绿。

### O6【P2】大厅内务（14.0s → ~6–7s）
- **做法**：`updates.test.mjs`（13.3s）拆 3 个文件，平台启动器（Windows C# 编译 5.2s + macOS bash 4.4s）默认只在 nightly/发布跑；`ai-background` 固定模型延迟 3000/2000/1500/1200/700ms → ~800ms（断言阈值 `<500ms`→`<200ms`，省 ~7s）；`ai-retry` timeoutMs 300→120ms（省 ~2–3s）。
- **预估收益**：大厅 14.0→**~6–7s（-50%）**。
- **风险**：低。
- **验证**：`node --test tests/hall/*.test.mjs` 墙钟 + 连跑 10 次无 flake。

### O7【P2】拆 `replay-golden`（O2 后新关键路径 82.4s）
- **做法**：13 个 golden fixture 按战役拆 3 个文件（notz / dunwich+carcosa / tfa+strict），总计算量不变、墙钟=最大分组 ~28s。O3 修好则可降级。
- **预估收益**：82.4→**~28–32s**；O2 后 158 文件墙钟 ~85→**~45–50s**。
- **风险**：低（纯搬运，replay 指纹不变）。
- **验证**：`node tools/run-tests.mjs fast`；`node tools/replay-fixtures.mjs --verify`。

### O8【P3】启动税/并发微调 + 按改动选测
- 启动税：engine import 0.8s×158≈140s CPU → 需要「懒加载/re-export」架构改动，收益仅 ~4–5s 墙钟，ROI 低于 O1–O3，暂不做；`--test-concurrency=32` 收益 <1%。
- 按改动选测（`tools/select-tests.mjs`）：`src/engine/**`→全部、`src/cards/entries/<code>.js`→grep 卡号命中的测试、`content/packs/**`→acceptance/ledger、`web/**`→浏览器 spec、未知→全部兜底；配 `.githooks/pre-push`，不作 CI 门槛。改一张卡 1–3 文件 5–10s vs 135s。风险：映射漏测 → nightly full + release full 兜底。
- **验证**：回放最近 20 个 commit 的 diff，比较选测与全量结果一致性。

### O9【P3】文档/基线/守卫流程
- 重测并重写 `suites.mjs` 头注释与逐文件秒数（用 JUnit 实时生成）、`docs/testing.md` 耗时表、`audit/baseline.json`；把「新增测试文件必须与 tier 登记同 commit」写进合并门禁（CI `test:fast` 跑守卫）；统一用例数口径（当前 2337/2453/2510/3088+ 并存）。

---

## 五、限制与复测方法

1. **本次数字只代表「脏 WIP 树 + 并发写入」快照**：02:35–02:48 有并发会话修改 Arkham 仓库（`tcu-player-m2-1.test.mjs` mtime 02:35:51、`tcu-primitives-p7.test.mjs` 02:37 出现、`suites.mjs/node-suite.mjs` 02:45:11 被改）；**02:48–02:49 起另一个会话在 arkham 仓库并发跑它自己的全套测试（观察到 40+ node 测试子进程）**。凡「脏树全量 15.5min 被强杀」这类数字只当**下限**，不当精确基线。
2. **异常不是机器慢**：i9-13900K / 32 线程，单核微基准（3e8 循环 0.28s）正常；HEAD clean worktree 单文件也触发 watchdog（replay-fuzz ≥300s、campaign-n4 ≥420s）→ 慢是仓库演化 + 测试结构造成。
3. **干净复测方法（建议 Lead 执行）**：`git -C games/arkhamhorror worktree add <dir> HEAD` → 在该 worktree 单独计时：
   - 每个文件 `node --test <file>`（watchdog），记录 **wall + process CPU**（`Measure-Command`/`Get-Process CPU`）；
   - 全量：`node --test <sorted files>`（去掉并发负载），记录 wall/JUnit；
   - 分别跑 `test:fast`、`test:slow`、`test:assets`、`all` 四档，生成 per-file JUnit（TAP reporter 可拿文件分组）。
4. **期望结论的验证清单**：O2 后 158 文件墙钟应从 135.5→~60s；O1 后 HEAD 全量应从 ≥420s（下限）降到 ~100–150s；O1+O3 后目标 ~60–90s；O3 后 replay-golden 应从 82.4→<30s。达不到说明参数还要再调。
5. **已补/仍缺的数据**：已补 —— `test:fast` 95.54s、`test:assets` 64.82s（`tier-times.json`）、hall 浏览器 35.75s、HEAD 两个慢文件 watchdog 下限；仍缺 —— Lead 的 TAP per-file 数据（可替换 §3.1 的下界）、HEAD `campaign-n4`/`replay-fuzz` 的真实完成时间（只有 watchdog 下限）、`test:slow` 的 tier 墙钟。
6. **清单守卫要分开写「HEAD 缺陷」vs「脏树已修」**：`suite-manifest` 在 **HEAD clean worktree 上失败**（3 个已提交测试文件 `hall-static`/`view-static`/`view-shared-state` 从未登记，是真实缺陷）；**脏树 02:45 起已被并发会话补登记，`run-tests.mjs fast|assets` 的守卫当前通过**。修法见 O9：把「新增测试文件必须与 tier 登记同 commit」纳入合并门禁，并重生成 `audit/baseline.json`。
