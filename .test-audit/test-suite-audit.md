# 测试套件审计报告（过时用例 / 全量耗时 / 优化空间）

- 生成时间：2026-10-24 03:00（Asia/Shanghai）
- 机器：Windows，Node v22.23.1，Intel i9-13900K（24 核 / 32 线程），单核性能正常（3e8 循环 0.28s）
- 对象：
  - 大厅根仓库 `G:\boardgame-hall-ai`，HEAD `b900998`（工作树干净）
  - Arkham Mod 独立仓库 `games/arkhamhorror`，HEAD `496ae99`，**工作树有 128 项未提交 WIP，且审计期间另一个会话在并发改文件、02:48 起并发跑它自己的全套测试**
- 原始产物与详细证据：`.test-audit/findings-hall.md`、`.test-audit/findings-arkham.md`、`.test-audit/findings-perf.md`、`junit-*.xml`、`wall-times*.json`、`tier-*.log`、`head-slow-times.json`、`arkham-tap/…`（未跑）等

---

## 0. 结论速览

1. **有"过时"，但绝大多数不是"该删的旧用例"，而是三类：**
   - **清单失配（P0 真缺陷）**：Arkham HEAD 上 `hall-static` / `view-static` / `view-shared-state` 3 个**已提交**测试文件（10 个用例）从未登记进 `tests/suites.mjs` 与 `tests/node-suite.mjs`，`suite-manifest.test.mjs` 守卫在 clean HEAD 上必红 → `npm test` / `test:fast|slow|assets` 全红，且这 3 个用例从未被全量入口执行过（02:45 并发会话已在脏树补登记）。
   - **过时断言/标题（~25 条）**：tcu-migration 标题仍写 catalog-only 而正文断言 verified；TFA 10 章各一条重复的"M5 已 playable"节点门禁；2 条完全重名测试 + 4 组同卡同行为重复覆盖；大厅 6 处注释/恒真断言/失效字段（online-coalesce/busy/defer/shared/perf-ui/ui）。
   - **陈旧文档与脚本（~15 处）**：`docs/testing.md` 的耗时/文件数全表、`suites.mjs` 头注释与逐文件秒数、`audit/baseline.json` 的 2510 例、AGENTS/roadmap 的 2337/2453、`test:online` 单文件旧入口、浏览器三入口重复跑整包、仓库完全没有测试 CI。
   - **死用例：0**（无 `.skip/.todo/.only`；仅 2 个启动器用例依赖 csc / Git-Bash，环境缺失时静默 skip）。**不建议整文件删除任何测试**；可合并而非删除。

2. **全量测试耗时"过长且被少数文件绑架"：**
   - 大厅 `test:hall` **14.0s**（文档写 ~10s）；大厅浏览器 **35.75s / 10 例**。
   - Arkham `test:fast` **95.5s**（文档写 ~8s / 注释写 ≈40s，2648 例）——其中 `replay-golden` 一个文件 ≈82s。
   - Arkham `test:assets` **64.8s**（文档 ~30s）——audit-resources ≈36s + import-cards ≈26s。
   - Arkham 慢档（slow）与全量（all）：**clean HEAD 上也跑不完**——单独计时 `campaign-n4` ≥420s（注释 130.3s）、`replay-fuzz` ≥300s（注释 71.7s）都被 watchdog 强杀；**HEAD 全量 Node 实际量级 ≥7–10 分钟**（文档写 154s，至少低估 3–4 倍）。当前脏树全量跑 14.9 分钟仍未结束（被人工终止）。
   - 结论：`npm test` 现在的时间是文档的 3–4 倍以上，且慢的根源是少数"引擎重测试"的单步成本随内容增长涨了 3–4 倍 + 几个超慢文件，而不是"并发不够"。

3. **优化空间很大，按 ROI：** 修清单守卫（分钟级）→ 拆/削 `campaign-n4`、`replay-fuzz`（全量 ≥7min → 目标 ~2min）→ 修引擎热点（`replay-golden` 82s→<30s，fast 95s→~40s）→ 瘦身 `hall-online`（117s→~40s，其余 158 文件 135s→~60s）→ 分层 + hall/mod 并行 + 补 CI（日常 `npm test` 可降到 ~20–30s）。

---

## 1. 实测数据（本机、本次审计）

| # | 套件 | 实测 | 文档/注释声明 | 偏差 | 备注 |
|---|---|---|---|---|---|
| 1 | 大厅 `node --test tests/hall/*.test.mjs` | **14.0s**，155 例（node 口径）/ 0 失败 | `docs/testing.md:18` 约 10s | +40% | 关键文件 updates 13.3s、ai-background 10.4s |
| 2 | 大厅浏览器（playwright，5 spec / 10 例） | **35.75s** 墙钟（playwright 27.7s），10 passed | `docs/testing.md:19` 约 7s/用例（≈70s） | 文档高估 | 实测 ≈2.8–3.6s/例 |
| 3 | Arkham `run-tests.mjs fast`（131 文件 + 守卫） | **95.54s**，2648 例 / 2645 pass / 3 fail（WIP 失败） | docs 约 8s；`suites.mjs:4` fast≈40s | **12× / 2.4×** | `replay-golden` ≈82s 占 86% |
| 4 | Arkham `run-tests.mjs assets`（14 文件） | **64.82s**，125 例 / 118 pass / 7 fail（WIP 失败） | docs 约 30s；注释 ≈60s | **2.2× / 1.1×** | audit-resources ≈36s + import-cards ≈26s |
| 5 | Arkham 去掉 2 个超慢文件的 158 文件 | **135.49s**，3088 条用例 / 25 fail | — | — | 关键路径 `hall-online` 单文件 ≈129s（单条 117.1s） |
| 6 | Arkham **clean HEAD**：`campaign-n4.test.mjs` 单独 | **≥420s（watchdog 强杀，未完成）** | 注释 130.3s（2026-10-18 写入） | **≥3.2×** | 脏树并行池内实测 ≈9.3min |
| 7 | Arkham **clean HEAD**：`replay-fuzz.test.mjs` 单独 | **≥300s（watchdog 强杀，未完成）** | 注释 71.7s（2026-10-20 写入） | **≥4.2×** | 脏树并行池内 >14.8min 未完成 |
| 8 | Arkham 全量 Node（`npm test` 实际内容） | 脏树 **≥14.9min 未完成**（被强杀）；HEAD 量级 **≥7–10min** | `docs/testing.md:16` 约 2.5min（154s） | **≥3–4×** | 只有 watchdog 下限，非精确值 |
| 9 | Arkham 浏览器（56 spec / 179 测试） | 未纳入本轮实测 | `docs/testing.md:19` 约 7s/例；`run-p7.mjs:17` 注释 ">4 分钟" | — | 不在 `npm test` 内，无 manifest、CI 不跑 |

> ⚠️ 口径与限制：02:35–02:48 有并发会话修改 Arkham 工作树，02:48–02:49 另有一会话并发跑全套测试（观察到 40+ node 子进程）。凡"脏树全量"数字只作下限。`campaign-n4`/`replay-fuzz` 的 clean-HEAD 单文件计时用 Start-Process + watchdog（300s/420s），CPU 时间也同步记录（≥277s）。
> 另：`replay-golden`/`notz-n4` 等 per-file 时间来自 JUnit testcase 归因，含并行调度等待，只用于排序。

### 1.1 时间去哪了（Pareto）

- **全量墙钟 = `campaign-n4` 与 `replay-fuzz` 的较大者**（clean HEAD 上分别 ≥420s / ≥300s）；其他任何优化对 full 墙钟都只是噪声，直到这两个被拆/削。
- **fast 墙钟 = `replay-golden`**（786 步 × 2 次全量重放，82.4s；注释 11.2s → 7.4×）。
- **assets 墙钟 = audit-resources + import-cards**（35.8s + 25.6s，均为重复读 100–200MB 资源/重复导入）。
- **其余 158 文件墙钟 = `hall-online`**（240 步 × 每步固定 350ms sleep + 9 次 status/HTTP 往返，单条 117.1s；其中 84s 是纯 sleep）。
- **引擎热点回归（clean HEAD 已存在）**：replay-golden 11.2→82.4s（7.4×）、save-migration 3.7→22.6s（6.1×）、notz-n4 5.8→≥61s（10×）、core-final 6.0→35.9s（6×）、replay-fuzz/campaign-n4 ≥3–4×。IO/审计类基本不变（import-cards 1.16×、audit-resources 1.4×）→ 回归集中在"建局 / applyMove / 重放 / stateHash / JSON clone"路径（内容从 0→1144 个 src JS、5930 张卡、单卡文件化后每进程 import 1000+ 模块、状态变大）。
- **每进程启动税**：158 个测试进程 × ≈0.9s（engine 依赖图 import 809ms/文件）≈ **140s CPU** 未计入用例时间。
- **并行利用率 ≈20%**：3088 条用例时间合计 861s / 墙钟 135.5s / 32 核 → 不是 CPU 不足，是关键路径太长。

---

## 2. "过时"清单（分类、证据、建议）

判定：**O** 过时断言/标题；**M** 失配（清单/脚本/配置）；**S** 数字陈旧；**R** 冗余；**D** 死用例。

### 2.1 P0 硬失配（会导致门禁红/用例从不执行）

| # | 位置 | 现象 | 证据 | 建议 |
|---|---|---|---|---|
| A1 | `games/arkhamhorror/tests/suite-manifest.test.mjs:21-28`、`tests/suites.mjs`、`tests/node-suite.mjs` | clean HEAD 上磁盘有 158 个非守卫 test 文件，只登记 155 个；差集 = `hall-static` / `view-static` / `view-shared-state`（10 用例，HEAD 已跟踪）。守卫在 clean HEAD 必红（已复现 1/1 fail）→ 四个 tier 入口全部红，且 3 个用例从未被任何 tier 执行 | 提交 `c2b0124`（10-23 23:44）新增 2 个、`7975937`（10-24 01:27）新增 1 个，均未改清单 | 把 3 个文件登记进 FAST tier + node-suite（同 commit）；并发会话 02:45 已在脏树做了一半，需确认与 HEAD 提交 |
| A2 | 5 个 WIP 文件 `tests/tcu-player-*.test.mjs` + `tools/audit-tcu-player.mjs` | 未跟踪文件已被 `suites.mjs/node-suite.mjs` 引用 → 只提交清单不提交文件时 `existsSync` 会红 | `git status` 为 `??`；清单已改 | 与清单同一 commit 提交，或先不入清单 |
| A3 | `tests/tcu-migration.test.mjs:48,91` | 标题仍写"玩家包…catalog-only"但正文已断言 verified；milestone 断言 `P7` 而 `audit/tcu-migration.json` 仍是 P6 | 工作树 diff 与 `git status`；该测试当前红 | 标题按现状态改写；`node tools/audit-tcu.mjs --write` 重生成账本并把"里程碑推进必须同步测试"写进清单 |

### 2.2 过时断言/标题（可立即更新，非删除）

- **大厅（6 处）**：
  - `tests/hall/online-coalesce.test.mjs:148-156`：注释仍按 P2.1 描述，默认路径应 2 次 publish、断言却放宽到 ≤3/≤2；建议收紧为 `publishes===2 / published===1 / statusSent===1`。
  - `tests/hall/online-busy.test.mjs:4,119`：注释写"finally 的 busy 变化走 status"，实际 busy=true 在命令开始发；:121-123 近似恒真。
  - `tests/hall/online-defer.test.mjs:127,178,182`：3 条永真断言（`mode:'actor'` 无代码产生、`onlySeats` 分支全仓无调用方=死代码、`deferred===0` 不可达）→ 应换成可观测信号（响应返回前 guest revision 未前进、之后一次 background 发布补齐）。
  - `tests/hall/online-shared.test.mjs:186`：标题写"四席共用"，fixture 默认 2 席。
  - `tests/hall/online-perf-ui.test.mjs:127`：恒真断言（上一行已断言同一计数）。
  - `tests/hall/online-ui.test.mjs:37`：`transportNote` 字段源码已无使用，换真实非语义字段。
- **Arkham（~15 条 + 重复组）**：
  - TFA 10 个章节文件各 1 条"M5 章节已从占位升级为 playable"（untamed:77 / eztli:85 / threads:135 / turn-back:161 / depths:164 / archives:209 / shattered:212 / boundary:214 / heart1:224 / heart2:137），与 `tfa-migration` 的一条总断言重复。
  - 完全重名测试 2 条：`tfa-untamed-wilds:317 ↔ tfa-boundary-beyond:516`、`tfa-untamed-wilds:334 ↔ tfa-heart-of-the-elders-part1:763`。
  - 同卡同行为 2 组：03185 约束衣（carcosa-literal:14 vs pending-encounters:116）、03232/03024（phase5-migration ↔ carcosa-implementation-gaps）。
  - TCU milestone 状态断言、`audit/baseline.json` milestone 仍写 P0。
- **判定为"仍有效、不要删"**：ai-retry / chat-notifications / online-ui / updates / launch / feedback / config 等旧文件（import↔export 对照 0 缺失、断言与当前源码契约一致；updates 已不再测 Gitee）；save-migration 的 5 步迁移链（v6/n5.x 仍被支持）。

### 2.3 陈旧文档/脚本/数字（S/M）

- `docs/testing.md`：:3「69 个用例文件」（现 159）、:13-17 耗时全表、:18 hall 10s、:19 浏览器 7s/例、:38-39/:44 "fast 43→7s / all 328→135s" —— 全部偏离实测。
- `games/arkhamhorror/tests/suites.mjs`：:4-7 头注释（fast≈40/slow≈180/assets≈60s 与自己逐文件注释合计 96.7/254.2/57.1s 矛盾）；:145-146 的 130.3s/71.7s 写于 10-18/10-20 后再未计时；:137-141 新增 5 个 tcu-player 条目耗时写 `——`；16 个 fast 文件无计时。
- 用例数口径混乱：`audit/baseline.json` 2510、`AGENTS.md:67` 2337、`docs/tcu-migration-roadmap.md:39` 2337 / :329 2453 —— 当前 fast 单独就 2648 例。
- `package.json:22` `test:online` 仍只跑 `online.test.mjs`（联机已 12 文件）；`docs/multiplayer.md:89` 仍推荐它。建议删除或改成 `node --test tests/hall/online*.test.mjs` 并标注"子集"。
- `docs/multiplayer.md:11` 引用的 `artifacts/boardgame-relay-render-save-resume.zip` 不存在（`artifacts/` 被 gitignore、无生成器）。
- 浏览器：`test:browser` / `test:p7` / `test:release` 三个入口重复跑整包；`playwright.tcu.config.mjs` 继承 testMatch（不带过滤会跑全部 56 spec，footgun）；`run-p7.mjs:37` 发布门禁仍用单进程 `node --test tests/node-suite.mjs`（≥7min）。
- 文档进度/计数：`docs/arkham-performance-roadmap.md:368` 仍写 P2.2"进行中"（已 ✅）；:549/:577 的浏览器用例数（50+/164）与现状（56 spec/179 测试）不符；`docs/tactical-chat-design.md:744-746` 的 28/1/218/227 项计数、`docs/arkham-online-performance.md:134` 的 114 例均过时。
- **CI**：`.github/workflows/` 只有 release.yml / sync-r2.yml，**两个仓库都没有测试工作流** → 这是清单漏登记、用例数口径漂移能长期潜伏的根本原因。

### 2.4 死用例 / 静默跳过

- 155 个 node 用例 + 56 个 browser spec 中无 `.skip/.todo/.only`、无环境跳过分发；`forbidOnly: true` 还会把误提交的 `.only` 判红。
- 唯二静默跳过：`tests/hall/updates.test.mjs:531,545` 依赖 `csc.exe` / 固定路径 Git-Bash，缺失时 skip → 建议文档写明前置，或拆 `test:hall:launcher` 显式跑（缺环境时明确"未覆盖"）。

### 2.5 冗余覆盖（可合并，非删除）

- Arkham：~26 个 fast tier 文件被 `audit-*`/`baseline:check` 用 `spawnSync node --test` 再跑一遍（audit-core-acceptance 实跑 13 个证据文件、carcosa-all 5、dunwich 4、audit-tcu 4、tcu-primitives 13）；`core-ledger` 与 audit 工具各实现一次账本 hash 锁；dunwich 7 文件 139 测试且卡号交叠极高（rules∩acceptance=120 码）。
- 浏览器：4 个 <2KB 单用例冒烟 spec（p0/dunwich-acceptance/core-acceptance/p6-content）可并入 p7-release 或 smoke。
- 大厅：9 个联机相关文件各重复 30–70 行 fixture/waitFor 样板（抽 helper 一次解决 env 隔离/重复代码）；`online` 系列 3 组局部重复断言。
- 保守合并清单：TFA 10 章门禁 + 2 重名 + 4 组同卡同行为 ≈ **15 条**；不建议删文件。

---

## 3. 优化方案（按 ROI）

> 基线：clean HEAD 全量 Node ≥7–10min（下限口径）；脏树 158 文件 135.5s；fast 95.5s；assets 64.8s；大厅 14.0s。所有收益需复测确认。

### P0（先做，收益最大/风险最低）

1. **修复清单守卫**：登记 3 个文件进 FAST + node-suite；把"新增/删除测试文件必须与 tier 清单同 commit"写进合并门禁；WIP 的 5 个 tcu-player 文件与清单同 commit。→ 恢复 `npm test` 可信。
2. **拆/削两个超慢文件**（当前全量墙钟的 ~90%+）：
   - `campaign-n4.test.mjs` 拆成 3 个文件（取消购卡/回滚/观察者；战役结局/创伤/牌组迁移；7 组参数矩阵）；矩阵 7→3 组（1p/2p/4p standard），900 步上限按实际收紧，`clone(state)` 每动作 → 每 20 动作（现最多 6300 次深拷贝）。预估 ≥420s → ~90–150s。
   - `replay-fuzz.test.mjs` 两条拆成 2 个文件；默认 full 用 40 局 / 2000 步（断言阈值同比），5000 步全参数版留 nightly。预估 ≥300s → ~70–100s。
   - 两者并行后 HEAD 全量：**≥420s（下限）→ 目标 ~100–150s**。
3. **重写耗时文档/注释 + 建立自动计时**：用 JUnit/TAP 实测重新标注 `suites.mjs` 与 `docs/testing.md`，或删掉绝对秒数改为"以 `npm run test:timing` 输出为准"；`audit/baseline.json`/AGENTS/roadmap 统一用例数口径（建议只引用实时统计）。

### P1（结构性问题）

4. **修引擎热点回归**（clean HEAD 已 3–4×，是慢的根因之一）：对 `replay-golden` 跑 `node --cpu-prof --test tests/replay-golden.test.mjs`，重点看 `stateHash/stableStringify`、JSON clone、applyMove/每动作钩子、state 变大后的全量扫描；目标是 replay-golden 82→<30s、fast 95.5→~40s、slow 同步下降。
5. **瘦身 `hall-online`**（其余 158 文件的关键路径）：240→120 步；固定 350ms sleep→150ms 或改条件等待；每步 9 次 status 往返→从命令回包读 revision。预估单条 117→~35–45s，158 文件 135.5→~55–60s。
6. **拆 `replay-golden`**：13 个 golden fixture 按战役拆 3 文件并行（总计算量不变，墙钟 82→~28s）；O4 修好后可降级。
7. **默认入口分层 + 并行 + CI**：根加 `test:fast`（hall + arkham fast）/`test:full`/`test:nightly`；`npm test` 默认跑 fast；hall 与 mod 用 `Promise.all` 并行（省 14s 串行 + npm 嵌套）；CI 加 `test.yml`（PR fast、nightly full）。日常从 135s→~15–25s。
8. **assets 审计去重/缓存/移出默认层**：audit-resources 去掉重复子进程 `--check-source`、媒体大文件改 size+mtime（整文件 sha256 放 nightly）；import-cards 的 `--check` 子进程与 in-process 导入二选一；presentation-images 4 次 spawn 合并。预估 assets 64.8→~35s。

### P2（内务与长期）

9. **大厅内务**：ai-background 固定模型延迟 3000/2000/1500/1200→~800–1000ms（`<500ms` 断言余量充足，预计 hall 14→9–10s）；updates 启动器用例拆出、默认只在 nightly/发布跑（13.3s）；`test:online` 删掉或改 glob；9 个联机文件抽 `online-fixture` helper（同时修 AI_*/BOARDGAME_* env 隔离）；固定 sleep 改条件等待；端口探测加 EADDRINUSE 重试。
10. **按改动选测**：`tools/select-tests.mjs`（engine→全部、单卡文件→grep 卡号命中、content→acceptance/ledger、web→浏览器 spec、未知兜底全部）+ pre-push；改一张卡从 135s 降到 5–10s。风险由 nightly full/release full 兜底。
11. **浏览器一套入口 + manifest**：`test:p7/test:release` 复用 `test:browser`，给 56 spec 加 manifest/守卫；`playwright.tcu.config.mjs` 加 `testMatch: '**/tcu-*.browser.mjs'`；4 个超大冒烟 spec 合并。

---

## 4. 建议的下一步（未执行，等待确认）

- 本轮只做只读审计 + 实测，**没有修改任何源码/测试/文档**；`games/arkhamhorror` 工作树有另一个会话在并发修改，不宜此时改动。
- 可立即执行且低风险（建议优先级）：
  1. Arkham：登记 3 个文件进 FAST/node-suite（修 HEAD 守卫红）并提交；
  2. 根仓库：更新 `docs/testing.md` 数字 + 修 `test:online`；
  3. Arkham：按 §3 的 P0-2 拆分/削减两个慢文件，再用本报告复测命令验收。
- 若需要，我可以直接实施 1–2 并在实施后跑门禁验证（当前会话有完整权限）。

---

## 5. 复测方法（供复核）

```powershell
# 大厅
Measure-Command { node --test tests/hall/*.test.mjs }              # 实测 14.0s
Measure-Command { node node_modules/@playwright/test/cli.js test --config tests/hall/playwright.config.mjs }  # 35.75s

# Arkham 分层（cwd = games/arkhamhorror）
Measure-Command { node tools/run-tests.mjs fast }                  # 95.5s（脏树，3 fail）
Measure-Command { node tools/run-tests.mjs assets }                # 64.8s（脏树，7 fail）
Measure-Command { node tools/run-tests.mjs all }                   # 当前脏树 >14.9min 未完成

# clean HEAD 单文件 watchdog 计时（本报告方法）
git worktree add <tmp> HEAD
# python/ps: Start-Process node '--test','tests/replay-fuzz.test.mjs' -PassThru + 300s watchdog
# 结果：replay-fuzz ≥300s、campaign-n4 ≥420s（均为下限）
```
