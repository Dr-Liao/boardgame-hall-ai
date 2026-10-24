# Arkham Horror LCG mod — 测试套件审计（问题 1 + 问题 3 慢用例候选）

- 审计对象：`G:\boardgame-hall-ai\games\arkhamhorror`（独立 git 仓库，HEAD `496ae99`，工作树脏：tcu-player M2/P7 系列 WIP）
- 方法：**只读静态分析**。未运行 `node --test`、benchmark 或 audit 工具（环境 spawn EPERM）。允许的 in-process `node -e` 只用于读 package.json / suites.mjs / 数清单 / 比对卡号。所有耗时数字来自 `tests/suites.mjs` 注释与文档声明，**未经本次实测**。
- 机器事实（Lead 的 measure 环境）：node v22.23.1，**32 逻辑 CPU**（`.test-audit/env.json`）。
- 审计时点：2026-10-24 02:2x；Lead 的全量实测仍在进行中，本文未采用其数据。

---

## 0. 结论摘要（直接回答问题 1）

**有，而且不止一类。** 按「能立即实锤」排序：

| # | 类别 | 数量 | 一句话 |
|---|------|------|--------|
| A | **清单失配：新增用例从未进任何 tier，清单守卫现在是红的** | 3 个文件 / **10 个测试** | `hall-static` / `view-static` / `view-shared-state` 由最近 2 个提交（P1.4/P3.2 观测性能）加入磁盘，但 `suites.mjs` 与 `node-suite.mjs` 都没登记；`suite-manifest.test.mjs` 的磁盘比对必然失败 → `npm test` / `test:fast|slow|assets` 目前全部是红的（守卫在每个 tier 前都会跑）。 |
| B | **一次性里程碑状态断言已过时** | ≥11 条 | 每章一条「M5 章节已从占位升级为 playable」（TFA 10 个章节文件）+ TCU「玩家包仍 catalog-only」；后者正在 WIP 里改成 P7（**标题还没改**，标题与断言自相矛盾）。这类断言每个里程碑都要人肉改一次，是「过时」的最大制造机。 |
| C | **冗余覆盖（同一行为多层断言）** | 15+ 条可合并；~26 个 fast tier 测试文件被 audit 门禁重复执行 | 卡牌行为同时被 `phase5-migration` / `card-fidelity-*` / `*-implementation-gaps` / `*-acceptance` 断言；core/carcosa/dunwich/tcu 的 audit 工具会 `spawnSync node --test` 再跑一遍已在 tier 里的证据文件；账本哈希锁在 `core-ledger` 与 `audit-* --check` 里各实现一次。 |
| D | **文档/基线的规模与耗时数字互相矛盾且陈旧** | 6 处 | `audit/baseline.json` 记 **2510** 例；AGENTS.md 与 roadmap 说 **2337**；同一 roadmap 另一处说 **2453**；docs/testing.md 说「69 个用例文件」、fast 8s、node 5.5min；suites.mjs 头注释说 fast≈40s / slow≈180s / assets≈60s。 |
| E | **死用例 / 条件跳过** | **0** | 155 个 node 用例 + 56 个 browser spec 中没有任何 `test.skip` / `todo` / `only` / `describe.skip`；环境变量只用于 DSH_HOME/AI stub 设置，不构成跳过门。 |
| F | **浏览器用例死文件** | **0 个「永远不跑」** | `playwright.config.mjs` 的 `testMatch: '**/*.browser.mjs'` 会发现全部 56 个 spec。真正的问题是：(1) 浏览器套件没有 tier/manifest 守卫、不在 `npm test` 里、CI 也没有测试工作流；(2) 3 个 npm 入口重复跑同一整包；(3) `playwright.tcu.config.mjs` 继承 `testMatch`，不带文件过滤会把 56 个 spec 全跑一遍并写 TCU 证据。 |

**问题 3 的结论（先给结论，证据见 §6）**：`npm test`（= `all`）在 32 核机器上的墙钟时间下限由 **`campaign-n4.test.mjs` 一个文件决定（注释 130.3s，约占 all 墙钟的 ~90%）**；第二临界路径是 `replay-fuzz`（71.7s）。**只优化别的文件对 `all` 没有意义**。最有效动作是「拆分 campaign-n4 成 2–3 个文件 + 削减参数」，预期 `all` 从 ~135–155s 降到 ~45–70s；再削 `replay-fuzz` 可到 ~35–50s。

**可删/合并/更新计数（保守）**：
- 必须新增登记：3 文件（10 测试）→ 修守卫；
- 可合并/降层：TFA 每章状态门禁 10 条 + 2 条完全重复标题 + 2 组同卡同行为（03185、03232/03024）= **~15 条**；
- 只需更新（不删）：1 条 TCU 标题 + 1 条 milestone 断言 + audit/baseline 重生成 + 4 处文档数字；
- 死用例：0。

---

## 1. 逐条发现表

> 证据格式 `文件:行`；「判定」= 已过时（O）/ 冗余（R）/ 死用例（D）/ 失配（M）/ 数字失真（S）/ 优化（P）。

| # | 文件:行 | 现象 | 证据 | 判定 | 建议动作 | 风险 |
|---|---------|------|------|------|----------|------|
| F1 | `tests/suite-manifest.test.mjs:10,21-24` | **清单守卫当前必红**：磁盘比 node-suite 多 3 个未登记用例文件 | `readdirSync(tests/)` 当前 = 159 个 `*.test.mjs`；node-suite 注册 155；tiers 155；META 只排除 `suite-manifest.test.mjs`。差集 = `hall-static.test.mjs`、`view-static.test.mjs`、`view-shared-state.test.mjs`（3 文件，静态数 1+3+6=**10 测试**）。`run-tests.mjs:11,26` 每个 tier 都先跑 GUARD，所以 `npm run test:fast` 当前会报 1 条 assert 失败。 | M / O | 把 3 个文件登记进 `suites.mjs`（建议 FAST）+ `node-suite.mjs`；或先在守卫 META 显式豁免（不推荐）。修完再重测 fast 例数。 | 低：只是登记；但登记后 fast 例数/耗时都要重测 |
| F2 | 提交 `c2b0124`、`7975937` | 上述 3 文件是最近两个提交新增，**提交里没有同步清单**，且 HEAD 就已失配 | `git show --stat c2b0124 -- tests/` 只有 2 个新文件（126+137 行）；`git show --stat 7975937 -- tests/` 只有 `view-shared-state.test.mjs`（202 行）；两提交都没碰 `tests/suites.mjs` / `tests/node-suite.mjs`。HEAD 快照：tracked `tests/*.test.mjs` = 154、node-suite = 150 → 同样差 3。 | M | 同上；并在合并门禁里把 `test:fast` 作为必跑（AGENTS 已有，但 WIP 显然没跑） | 低 |
| F3 | `tests/tcu-player-m2-1..4.test.mjs`、`tcu-player-ledger.test.mjs` | 5 个新测试文件**未被 git 跟踪**（`??`），但已在 suites/node-suite 里登记 | `git status` = `?? tests/tcu-player-*.test.mjs`；`suites.mjs:137-141`、`node-suite.mjs:152-156` 已引用。若只提交清单不提交文件，`suite-manifest.test.mjs:26-28` 的 `existsSync` 断言会立刻红。 | M（WIP 预期） | 提交时 5 个文件与清单同一 commit；否则守卫会报「分层清单里的文件不存在」 | 低 |
| F4 | `tests/tcu-migration.test.mjs:48`（工作树） | 标题与断言互相矛盾：标题仍说「玩家包…仍 catalog-only」，正文已断言 `player.status === 'verified'` | `git diff tests/tcu-migration.test.mjs`：+87 张 rulesImplemented、85 deckbuilding，milestone `'P6'→'P7'`；但 `test()` 标题（第 48 行）未同步改。 | O（标题过时） | 标题改为「调查员包 M1 + 玩家包 M2 已验收，战役包仍 catalog-only」 | 无 |
| F5 | `tests/tcu-migration.test.mjs:91` | milestone 断言写死 `audit.milestone === 'P7'`，但 `audit/tcu-migration.json` 未在工作树中重新生成（仍是提交 `d3a7e69` 的 P6 内容） | `git status` 未列 `audit/tcu-migration.json`；测试要求 P7 + `verifiedScope.playerCards` 等新字段。当前状态：这条 + ledger 断言会红，直到 `node tools/audit-tcu.mjs --write`。 | O（门禁需重生成） | 先 `audit:tcu --write` 再跑；把「milestone 一旦推进必须改测试」写进 P7 收尾清单 | 低 |
| F6 | TFA 每章 1 条 M5 状态门禁：`tfa-untamed-wilds:77`、`doom-of-eztli:85`、`threads-of-fate:135`、`turn-back-time:161`、`depths-of-yoth:164`、`city-of-archives:209`、`shattered-aeons:212`、`boundary-beyond:214`、`heart-of-the-elders-part1:224`、`part2:137` | 每章一条「章节已从占位升级为 playable，并保留原卡身份」 | 10 条同构断言；`tests/tfa-migration.test.mjs` 已有「M5 registers ten Forgotten Age chapters as playable and opens…」一条覆盖全部 10 章。 | R / O | 保留 tfa-migration 的一条；各章文件只留「保留原卡身份」的卡身份断言（或并入 migration），删 10 条状态断言 | 低 |
| F7 | `tests/tfa-untamed-wilds.test.mjs:317` ↔ `tests/tfa-boundary-beyond.test.mjs:516` | **完全同名测试**「混乱标记表与四档难度一致」 | 标题逐字相同；`doom-of-eztli:640` 是更完整的变体（多了 elder thing 断言）。 | R | 抽成 `tfa-fixture` 共享 helper 或只留一处分章节断言 | 低 |
| F8 | `tests/tfa-untamed-wilds.test.mjs:334` ↔ `tests/tfa-heart-of-the-elders-part1.test.mjs:763` | **完全同名测试**「结局写入战役记录并保留存档一致性」 | 标题逐字相同，断言都走战役记录/save 往返。 | R | 合并为共享 helper，参数化章节 | 低 |
| F9 | `tests/carcosa-literal-behavior.test.mjs:14` ↔ `tests/carcosa-pending-encounters.test.mjs:116` | 同一张卡同一行为两处断言：03185 约束衣「进威胁区/占槽/双行动弃置」 | 标题分别是「约束衣进入威胁区、占槽且提供双行动弃除能力」/「约束衣占满手部与身体槽，并生成双行动弃置入口」。 | R | 保留 literal-behavior 一份，pending-encounters 只留“入口/可见性”独有断言 | 低 |
| F10 | `tests/phase5-migration.test.mjs:76` ↔ `tests/carcosa-implementation-gaps.test.mjs:203`；`phase5-migration:580` ↔ `carcosa-implementation-gaps:29` | 同卡同行为两层断言：03232 捷径、03024 田野调查 | 标题一一对应（中文 vs 英文描述同一行为）；两文件共 16 个卡号在标题级交叠（另见 §2）。 | R | 按「行为回归」归并到一层（建议保留 carcosa-implementation-gaps 的行为断言，phase5-migration 只留“旧 DSL 已删”的迁移事实断言） | 中：需逐条确认两侧断言面是否等价 |
| F11 | `tests/card-fidelity-*.test.mjs` 6 文件 | 卡保真度 6 文件 82 个卡号，与核心/敦威治验收组大量交叠 | 卡号级交集：与 `dunwich-acceptance` 3 文件 **20** 个、与 `phase5-migration` 15 个、与 `core-acceptance` 7 文件 **14** 个、与 `dunwich-rules` 11 个（见 §2 表）。例：01063/01031/01068 同时出现在 card-fidelity-core-p3 与 core 验收组。 | R | 不删「行为」；把 card-fidelity 定位为“边角/回归”层，验收组只保留“支付/入场/账本”事实；合并同卡同行为的用例 | 中 |
| F12 | `tests/dunwich-rules.test.mjs`（119 测试）↔ `dunwich-encounter-acceptance`（75 动态）↔ `dunwich-player-acceptance`（1 巨型）↔ `dunwich-player-gaps`（54） | 单个战役 7 文件 139 静态测试；卡号重叠极高：dunwich-rules 173 码 ∩ dungeon-acceptance 226 码 = **120**；dunwich-acceptance ∩ gaps = **60**。 | 文件级联调；`dunwich-encounter-acceptance` 与 `dunwich-rules` 共享 73 个卡号（全文级）。 | R | 中期合并为 2 层：「规则/机制」+「逐卡验收账本」；gaps 文件的历史命名可退役 | 中高（改动量大，建议排期而非顺手） |
| F13 | `tools/audit-core-acceptance.mjs:10-12,35` | audit 工具用 `spawnSync node --test` 重跑 **13 个已在 tier 里的测试文件**（含 slow tier 的 `core-final-acceptance`、`notz-n4`），只为生成 `audit/core-acceptance.json` | `files=['core-acceptance','core-special-acceptance','core-encounter-acceptance','core-timing-acceptance','core-scenario-acceptance','core-story-acceptance','core-final-acceptance','rules-n3','core-n4','core-n4b','notz-n4','scenario-n4b','p6-content']`；该工具被 `npm run test:core`（package.json:74）与 `audit-baseline.mjs:31`（`baseline:check`）调用。 | R / P | 二选一：① `baseline:check/test:core` 只在合并门禁/夜间跑（现状其实已经如此，但要明确不再重跑证据测试，改为校验账本哈希）；② 保留实跑但去掉 fast tier 里「账本哈希」重复断言（见 F14）。 | 中：去掉实跑后“证据新鲜度”依赖 fast tier 先行跑过 |
| F14 | `tests/core-ledger.test.mjs:11-23` vs `tools/audit-core-acceptance.mjs:66-69` | 账本哈希锁实现两遍：账本测试校验 `CORE_ACCEPTANCE_SHA256` + 13 个证据文件 sha256；audit 工具 `--check` 又逐字节比对 `audit/core-acceptance.json` 与 `src/cards/core-acceptance.js` | 同一「Stale evidence」语义在两处。其它审计工具同构：`audit-carcosa-all-cards.mjs:19-25,30`（5 文件）、`audit-dunwich-acceptance.mjs:11-16,21`（4 文件）、`audit-carcosa-player.mjs:11`、`audit-tcu.mjs:175,490,601,649`、`audit-tcu-primitives.mjs:186` → **约 26 个 fast tier 文件在 audit/baseline 门禁里被重复执行**。 | R | 账本哈希锁只留 fast tier 一处；audit 工具默认只做「账本与源一致」检查，`--write` 时才实跑证据 | 中 |
| F15 | `audit/baseline.json:3,115-121` | 基线自称 milestone **P0**、记录 `test:fast` = **2510 例**；但它是 2026-10-23 20:38 提交 `d3a7e69` 生成，之后 3 个提交改了 tests/src（含 3 个未登记测试、5 个 WIP 测试） | `git log -1 --format='%h %ad' -- audit/baseline.json` = `d3a7e69`；`audit-baseline.mjs:80-88` 会实跑 fast 并逐字节比较（:113-124）。当前工作树下 `baseline:check` 必然报 `tests` 字段漂移。 | S / O | 修完 F1/F5 后 `npm run baseline` 重生成；或把 tests 计数从逐字节基线里拆出（它天然随用例增长漂移） | 低 |
| F16 | `AGENTS.md:67`、`docs/tcu-migration-roadmap.md:39,329` | 三处「实测用例数」互不一致：AGENTS/roadmap L39 = **2337**，roadmap L329 = **2453**（“基线 2337 + 116 新例”），baseline = **2510** | 同一 2026-10-23 时间点，三个数字；2337 是 P5 时点，2453 是 P6 时点，2510 是 `d3a7e69` 时点，之后又新增 5 个 fast 文件 + 3 个未登记文件。 | S | 统一口径：只引用 `audit/baseline.json` 的生成值，并在文档里写「截至 commit X」 | 低 |
| F17 | `docs/testing.md:3,13-17,38-39,44` | 规模/耗时声明陈旧：L3「69 个用例文件」；L13 fast≈8s；L15 slow≈2min+；L16 全量 154s；L17 node（单进程）≈5.5min；L44「fast 43→7s，all 328→135s」 | 当前可执行用例文件 **155**（磁盘 159）；fast 注释耗时合计 **96.7s**（115/131 文件有注释；16 个无）；slow 已知合计 **254.2s** + hall-online 未注释；assets 合计 **57.1s**；单进程 node-suite 串行下限 ≈ **408s+**（≈7min，不是 5.5min）。32 核下 fast 墙钟 ~8–15s、slow/ all ~130–140s 尚属合理，但「69 文件」「node 5.5min」已不成立。 | S | 更新 testing.md 表格：文件数 155；把「按 32 核实测」与「单文件合计」两种口径分开写；node 单进程改为 ≥7min | 低 |
| F18 | `tests/suites.mjs:4-7,145` | 头注释声明的分层耗时与自己的逐文件注释自相矛盾：fast≈40s（注释合计 96.7s）、slow≈180s（注释合计 254.2s+hall-online）、assets≈60s（57.1s ✓）；`// 130.3 —— 单个文件占了整套回归的 40%`：130.3 / 当前合计 408s ≈ 32%，且 40% 是旧 328s 总时长时代的算术 | `suites.mjs:145`（campaign-n4 130.3）、`:146`（replay-fuzz 71.7）；**16 个 fast 文件没有秒数注释**（含 6 个 card-fidelity、5 个新 tcu-player）；5 个新 tcu-player 条目直接写 `——`（:137-141），与「重新分层前先重新计时」的规则不符。 | S / O | 用 Lead 实测重写头注释与逐文件秒数；新文件补计时；把「注释合计 vs 墙钟」写清是 serial sum 还是 wall | 低 |
| F19 | `tests/suites.mjs:10-142`（131 条）vs `tests/node-suite.mjs:2-156`（155 条） | tier / node-suite / 磁盘三方一致性的**算术**：155 = 131 fast + 10 slow + 14 assets；磁盘 = 155 + guard + 3 未登记 = 159 | 已用脚本逐项核对：`tier NOT on disk = []`、`node-suite NOT in tier = []`、`disk NOT in tier = {3 未登记 + guard}`。 | M | 见 F1 | 低 |
| F20 | `tools/run-tests.mjs:11,26` | 每个 tier 都强制先跑 `tests/suite-manifest.test.mjs`，并把它与本 tier 文件放进**同一个** `node --test` 进程池；守卫红了整层就红 | 代码路径明确；没有「guard 失败但 tier 继续」的旁路。 | M（设计如此） | 保持；但 CI/合并门禁必须真的跑它，否则像 F1 这样失配会一直潜伏 | 无 |
| F21 | `tests/notz-n4.test.mjs:144-158` | 「四个使者组」靠循环种子碰运气：`for (let seed=0; seen.size<4 && seed<24; seed++)` 每次 `fixture(1)` + `midnight()`（整局状态创建+推进） | 最多 24 次建局；是 notz-n4（5.8s/11 测试）里最重的一段。 | P | 直接注入 4 组 agentSet（engine 支持 seeded RNG 时），或把上限 24→8 并保留“碰不到就跳过该组”的宽松断言 | 低 |
| F22 | `tests/hall-online.test.mjs:239-355` | 四人联机长跑是 slow tier 里唯一**没有标注耗时**的文件：最多 240 步 × 每步 4 个 HTTP status + `waitFor` + **每动作固定 350ms 睡眠**（:287） | 单文件理论下限 = 240 × 0.35s ≈ 84s；加上 4 个 Node server + relay 建停与中途 relay 重启。 | P | 见 §6：240→120 步、睡眠 350→150ms（保留 relay abuse 限流余量），预计省 30–60s | 中：relay 限流/重连时序可能抖动 |
| F23 | `playwright.config.mjs:11-13,15-16`；`tools/run-p7.mjs:17,53-57`；`package.json:96,114,115` | 浏览器套件不是「有 spec 没跑」，而是**入口重复 + 无清单 + 不在 npm test/CI**：56 spec / 179 静态测试，全部被 testMatch 发现；`test:browser`、`test:p7`、`test:release` 三个脚本都会跑同一整包；`workers:1, fullyParallel:false`，run-p7 注释称“实测 >4 分钟”；CI 只有 release.yml/sync-r2.yml，没有测试工作流。 | `package.json:96` `test:browser`=run-p7 --browser-only；`:114/115` test:p7/test:release；run-p7:53-56 只在 `--p7-only` 时过滤 `p7-release.browser.mjs`。 | M / R | ① 给浏览器套件加 manifest（或至少文档列 56 个）并纳入合并门禁；② `test:p7/test:release` 复用 `test:browser`，别再各自跑一遍；③ 减少 CI 之外的重复执行 | 中 |
| F24 | `playwright.tcu.config.mjs:14-17` | TCU 专用配置 `...base` 继承 `testDir/testMatch`，**不带文件过滤直接跑会执行全部 56 个 spec**，并用 TCU reporter 覆盖 `audit/tcu-browser-acceptance.json` | 当前 5 个 npm 脚本都显式传了文件（package.json:63,65），所以没爆；但 `docs/tcu-rules.md:17` 的推荐命令恰好带过滤，属“靠调用纪律”。 | M（footgun） | 在 tcu config 里设 `testMatch: '**/tcu-*.browser.mjs'` | 低 |
| F25 | `tests/p0.browser.mjs`（698B/1 测试）、`dunwich-acceptance.browser.mjs`（1.3KB）、`core-acceptance.browser.mjs`（1.4KB）、`p6-content.browser.mjs`（1.4KB） | 4 个 <2KB 的单用例冒烟 spec，功能与 `p7-release.browser.mjs` / `hall-setup.browser.mjs` 重叠 | 体积+测试数统计（56 spec / 179 静态测试） | R | 合并进 p7-release 或一个 `smoke.browser.mjs`；低优先 | 低 |
| F26 | `docs/arkham-performance-roadmap.md:549,577` | 文档还写「50+ 浏览器用例」「164 个浏览器用例」；当前 56 spec / **179** 静态 test()（含 for 循环动态注册，如 `turn-handoff.browser.mjs:3`） | 统计脚本：179 个 `test(...)`；`turn-handoff` 的 2 条是 `for (const action of [...]) test(...)`，不是空文件。 | S | 更新数字；把「文件数」和「用例数」分开写 | 低 |
| F27 | `tools/run-p7.mjs:37` | P7/release 门禁的 node 回归仍走**单进程** `node --test tests/node-suite.mjs`（155 文件串行），而日常入口 `npm test` 已是分层并行 `run-tests.mjs all` | run-p7:37；`package.json:13` `test:node` 也仍保留单进程；docs/testing.md:17 建议单进程用于排查顺序依赖，但 run-p7 把它当发布门禁主路径。单进程串行下限 ≈408s+（16 个无注释文件还未计）。 | P / O | run-p7 的 `test-arkham` 改为 `node tools/run-tests.mjs all`（顺带覆盖守卫）；单进程路径只保留给诊断 | 低 |

---

## 2. 冗余覆盖专题（量化）

### 2.1 分组规模（159 个 `*.test.mjs` 静态统计）

| 主题 | 文件数 | 静态 test() | 备注 |
|------|--------|-------------|------|
| core/一般（含 phase1/2/3/5/6、p0/p1/p2/p6/p7、replay、decision、hall、save、checkpoint…） | 71 | 741 | 混杂最多，历史命名最重 |
| tfa | 27 | 607 | 10 章文件 + 验收/规则/故事/战役；章文件间模板化重复高 |
| tcu | 22 | 267 | 13 个 primitives + rules/interactions/investigators/migration + 5 个 WIP 玩家卡 |
| carcosa | 16 | 167 | migration/ledger/rules/literal/pending/gaps/acceptance 多层 |
| dunwich | 7 | 139 | rules 119 + acceptance/ledger/gaps/migration |
| other（audit-resources/import-cards/展示/图像等） | 16 | 122 | assets/慢速门禁 |
| **合计** | **159** | **1992** | 动态循环注册的用例（如 `for (const code of ENEMIES) test(...)`）按 1 条计，实际执行数更高 |

### 2.2 卡号级交叠（正文出现即计入，偏宽松；标题级见下）

| 组 A | 组 B | 共享卡号 |
|------|------|----------|
| dunwich-rules（173 码） | dunwich-acceptance 3 文件（226 码） | **120** |
| dunwich-acceptance 3 文件 | dunwich-player-gaps | **60** |
| phase5-migration（160 码） | dunwich-acceptance | 38 |
| phase5-migration | core-acceptance 7 文件（150 码） | 28 |
| core-acceptance | tfa 10 章文件（201 码） | 28 |
| phase5-migration | dunwich-rules | 23 |
| card-fidelity 6 文件（82 码） | dunwich-acceptance | 20 |
| phase5-migration | carcosa-gaps 3 文件 | 16 |
| card-fidelity | phase5-migration | 15 |
| card-fidelity | core-acceptance | 14 |
| 01170 / 01171 | core-encounter-acceptance:69,78 / core-scenario-acceptance:63,71 / tfa-encounter-p1:211,223 | 同一张卡在 3 个文件被断言（标题级） |

### 2.3 确定的重复组（标题级，可立即处理）

1. **TFA 每章 M5 状态门禁 ×10**（F6）→ 与 `tfa-migration` 的一条总断言重复。
2. **两条完全同名测试**（F7/F8）→ 真正重复。
3. **03185 约束衣**：`carcosa-literal-behavior:14` 与 `carcosa-pending-encounters:116`（F9）。
4. **03232 捷径 / 03024 田野调查**：`phase5-migration` 与 `carcosa-implementation-gaps`（F10）。
5. **审计账本三层**（F13/F14）：行为测试（13 文件）→ 账本测试（core-ledger 等 4 个）→ audit 工具/`baseline:check`（再 spawn 同一批测试）。属于「同一批卡/行为在测试、账本测试、CLI 审计三处断言」的典型。
6. **core 验收 7 文件**：`core-acceptance`（17）+`special`（16）+`encounter`（7）+`timing`（13）+`scenario`（15）+`story`（19）+`final`（12）= 99 条，按主题切分本身合理，但 `final` 与其它文件有 13–17 条同卡重叠（如 01002 黛西、01170/01171），可作为合并首选。

### 2.4 迁移/存档测试是否还在测已不支持的旧格式？——**结论：是有效覆盖，不算过时**

- `src/engine/save-migration.js:122-153` 的 `STATE_MIGRATIONS` 仍有 5 步：`v6/n5.1→n5.2→n5.3→n5.4→n5.5→v7/n6.0`；当前 `STATE_SCHEMA_VERSION=7`、`RULES_VERSION='n6.0'`（`src/engine/rules-state.js`），即 **v6 + n5.x 旧存档仍在支持链上**，`save-migration.test.mjs` 的 12 条用例（n5.2 往事回声阈值、n5.3 胆量、n5.4 约束衣、v7 效果实体化、资源版本升级、拒绝 schema v4/更新版本）都对应真实代码路径，**建议保留**。
- `dunwich/carcosa/tfa/tcu-migration.test.mjs` 实际是**内容/范围账本一致性测试**（读 `audit/*-migration.json`、`scan-tcu-scope` 产物），不是旧存档格式测试；名字里的 migration 是“内容迁移”，不是 save migration。它们仍有效，但其中**里程碑状态断言**会随进度过时（F4/F5 已发生）。
- 唯一可削减的是 `save-migration` 里「升级选项很多的局间存档」（测试文件 :106-143）：为造出 >1000 条 `hubPurchase` 而全量枚举 legalMoves，是 3.7s 的主要来源（见 §6）。

---

## 3. 死用例 / 条件跳过检查

- `test.skip` / `test.todo` / `describe.skip` / `it.skip` / `.todo(` / `todo:` / `test.only` / `describe.only` / `xit` / `xdescribe`：**0 命中**（tests 目录 215 个 `.mjs` 全扫）。
- `process.env.*`：50 处，全部是测试内临时设置 `DSH_HOME`（临时目录）、`AI_API_KEY/AI_MAX_RETRIES/AI_TIMEOUT_MS/AI_BASE_URL`（本地 stub 模型）并在 finally 恢复；**没有一处被用作跳过/降级条件**。
- `catch`：仅 2 处且都不是吞失败——`decision-http.test.mjs:63`（本地 stub 模型读取 body 的兜底）、`presentation-http.test.mjs:25`（非 JSON 响应按文本返回，供断言错误码）。
- 浏览器侧：无 `test.skip/fixme/only`；`forbidOnly: true` 还会把误提交的 `.only` 直接判红。
- **结论：没有死用例/被静默跳过的用例。** 真正“死”的是 F1 的 3 个文件——它们能跑但从未被任何 tier 调度。

---

## 4. 浏览器用例覆盖（56 spec / 179 静态测试）

- **发现机制**：`playwright.config.mjs:11-13` `testDir=tests`、`testMatch='**/*.browser.mjs'` → 56 个文件全部可被发现，**没有“永远不会跑”的 spec**。
- `turn-handoff.browser.mjs` 看起来 0 个 `test(`，实为 `for (const action of ['resource','endTurn']) test(...)`（:3）动态注册 2 条 → 不是空文件。
- **真正的缺口**：
  1. `npm test`（`tools/run-tests.mjs all`，package.json:12）**只跑 node 测试**；浏览器只能 `npm run test:browser`（= run-p7 --browser-only）或 test:p7/test:release 手动跑；CI（只有 `.github/workflows/release.yml`、`sync-r2.yml`）没有测试工作流 → 浏览器套件在自动化里等于不存在。
  2. **没有清单/守卫**：node 侧 155 个文件有 `suites.mjs` + `suite-manifest.test.mjs` 双保险，浏览器 56 个文件没有任何 manifest；未来新增 spec 不会被任何检查发现“漏跑”（好在 testMatch 会兜底）。
  3. **三入口重复执行整包**：`test:browser`（:96）、`test:p7`（:114）、`test:release`（:115）都会用同一 config 跑全部 56 spec；此外还有 5 个单文件脚本（carcosa/tfa/tcu×3）是子集重跑。
  4. `workers:1, fullyParallel:false`：56 spec/179 测试串行，run-p7:17 注释“>4 分钟”；这是浏览器侧的耗时主因（若纳入门禁需评估）。
  5. `playwright.tcu.config.mjs` 继承 testMatch 的 footgun（F24）。
  6. 4 个 <2KB 冒烟 spec 可合并（F25）。

---

## 5. 文档 / 基线数字对照（问题 1 的“用户可见统计”部分）

| 出处 | 声明 | 现状 / 证据 | 判定 |
|------|------|-------------|------|
| `audit/baseline.json:118` | `test:fast` = **2510 例**（0 fail，status 0） | 该文件由 `d3a7e69`（2026-10-23 20:38）生成；之后 3 个提交新增 3 个未登记测试文件 + 工作树 5 个新 fast 文件 | 需重生成（F15） |
| `AGENTS.md:67` | 「2026-10-23 实测 **2337 例**全部通过，基线见 audit/baseline.json」 | 与同一 baseline 的 2510 矛盾；2337 是更早时点 | 陈旧（S） |
| `docs/tcu-migration-roadmap.md:39` | 「2026-10-23 实测 **2337 例**全部通过（2026-10-22 基线 2311）」 | 同上 | 陈旧（S） |
| `docs/tcu-migration-roadmap.md:329` | 「test:fast **2453 例全绿**（基线 2337 + 116 新例）；baseline:check 14/14」 | 又一个新的中间值；且当前 baseline audits 列表已 16 项（含 tcuScope/tcuMigration） | 陈旧（S） |
| `docs/testing.md:3` | 「单进程把 **69 个**用例文件依次 import，约 5.5 分钟」 | 当前可执行 155 文件；单进程串行下限 ≈408s+ 未注释部分 ≈7min+ | 陈旧（S） |
| `docs/testing.md:13-17` | fast≈8s / assets≈30s / slow≈2min+ / 全量 154s / node≈5.5min | 32 核下 fast≈8-15s、slow/all≈130-140s、assets≈26-30s 与逐文件合计 **自洽**；但 node 5.5min 已不成立（≥7min）；文件数口径错 | 部分陈旧（S） |
| `docs/testing.md:38-39,44` | 「campaign-n4 占 130 秒」「fast 43→7s，all 328→154s」 | 130.3s 数字对；「40%」只在旧 328s 总时长下成立（现行慢档注释合计 254.2s，campaign-n4 占 51%；对 32 核 `all` 墙钟则占 ~90%）；fast serial sum 现为 96.7s | 算术陈旧（S） |
| `tests/suites.mjs:4-7` | fast≈40 / slow≈180 / assets≈60 | 自己的逐文件注释合计：fast **96.7s**（115/131 有注释）、slow **254.2s**（9/10 有注释）、assets **57.1s** | fast/slow 陈旧，assets 接近（S） |
| `tests/suites.mjs:145` | campaign-n4「130.3 —— 单个文件占了整套回归的 40%」 | 130.3/408s ≈ 32%；40% 是旧总时长的算法 | 陈旧（S） |
| `tests/suites.mjs:137-141` | 5 个新 tcu-player 条目耗时写 `——` | 与第 8 行“括号内是实测秒数，重新分层前请先重新计时”的规则不一致 | 待补（S） |
| `audit/baseline.json:3` | `milestone: "P0"` | 仓库已到 P7（TCU 玩家卡），baseline 的 purpose/notes 仍写 P0 修基线 | 命名陈旧（S） |
| `docs/arkham-performance-roadmap.md:549,577` | 「50+ 浏览器用例」「164 个浏览器用例」 | 当前 56 spec / 179 静态 test() | 陈旧（S） |

补充事实（工作树 WIP，属预期不算缺陷）：
- `audit/ability-coverage.json`、`audit/core-acceptance.json`、`src/cards/core-acceptance.js` 均在工作树被改；`tests/node-suite.mjs`、`tests/suites.mjs` 同步加了 5 个 tcu-player 文件。
- `git status` 共 123 项；新增 tcu 卡文件 20 余个、新测试 5 个、`tools/audit-tcu-player.mjs` 未跟踪。**合并时若漏提交任一测试文件，守卫会立即红**（F3）。

---

## 6. 慢用例削减候选（问题 3）

### 6.1 先看全量结构（32 核 / node --test 默认 31 并发）

- 逐文件注释合计：fast **96.7s**（115/131 有注释，16 个无）+ slow **254.2s**（9/10 有注释，hall-online 无）+ assets **57.1s** = **≥408s 串行**。
- 分层并行后，墙钟 ≈ **关键路径文件耗时**：
  - `fast` 关键路径 = `replay-golden` 11.2s（其余 ≤4.2s）→ 预计墙钟 ~10–15s；
  - `assets` 关键路径 = `audit-resources` 25.5s（次高 import-cards 22.1s）→ ~26–30s；
  - `slow` 关键路径 = **`campaign-n4` 130.3s**（次高 replay-fuzz 71.7s）→ ~130–140s；
  - `all` = slow 关键路径 → **~130–140s**。
- 因此：**`all` 的墙钟 ~90% 由 campaign-n4 一个文件决定**；在它降下来之前，削任何其它文件对 `npm test` 的墙钟没有意义。第二目标是 replay-fuzz（72s），第三是 hall-online（未测，理论下限 ~84s）。

### 6.2 候选表

| 优先级 | 文件 | 注释耗时 | 慢在哪（证据） | 可安全削减的参数 | 预期降幅 | 风险 |
|---|---|---|---|---|---|---|
| **P0** | `tests/campaign-n4.test.mjs` | **130.3s** | ① 第 53 行测试：300 次「购卡→取消」循环，每次事务 + 全量状态 clone 比较；② 第 376-394 行：**7 组参数**（1 人 × easy/standard/hard/expert + 2/3/4 人 standard）各跑「直到 campaign over、最多 900 个动作」的完整战役，且**每个动作后 `state = clone(state)`**（JSON 深拷贝）。 | 1) 参数矩阵 7 → 3（1p standard / 2p standard / 4p standard），difficulty 留给一个小的 fast 冒烟用例；2) 300 → 50 次；3) `clone(state)` 每 20 步一次（`clone(command)` 保留）；4) **把 7 组矩阵拆成独立文件**（如 `campaign-n4-matrix.test.mjs`）让 node --test 跨文件并行。 | 文件 130→**45–60s**；若再拆分，slow/all 墙钟 130→**60–80s** | 低-中：丢 easy/hard/expert 全流程（混沌袋差异由其它测试覆盖）；去掉逐步 clone 会失去“别名污染”检测（可用抽样 clone 补偿） |
| **P1** | `tests/replay-fuzz.test.mjs` | **71.7s** | ① 第 22-63 行：**100 局**随机对局，每局 `playGame` + `replayHashes` 全量重放；② 第 65-152 行：**5,000 步**随机走子（单局 steps=400，循环建局），每 100 步做 JSON 幂等 + 卡号解析；③ 最后再来一局 120 步整局重放校验。 | ① 100 → 40 局（保持 4 战役 × 4 座位 × 3 难度的轮转，断言阈值按比例从 900 步降到 ~350）；② `TARGET_STEPS` 5,000 → 2,000（阈值 jsonChecks≥10 同比降到 ≥4）；③ 最后的 120 步整局保留。 | 71.7→**25–30s** | 中：随机 fuzz 的探索面缩小；用“每局至少 1 步”+ 种子轮转保证覆盖，不要只减局数不减组合 |
| **P1** | `tests/hall-online.test.mjs` | **未注释**（slow 里唯一） | 第 239-355 行四人长跑：最多 240 步 × 每步 4 个 HTTP `status` + `waitFor` + **每动作固定 350ms sleep**（:287）；4 个 Node server + relay + 中途 relay 重启/重连（:304-321）。理论下限 240×0.35 ≈ 84s。 | ① 240 → 120 步（仍要求 `round≥4` 或到达 scenarioResult）；② sleep 350 → 150ms（relay 是“每连接滥用限制”，4 人×150ms 仍有数倍余量）；③ 保留 relay 重启分支（它是本文件独有价值）。 | 预计省 **30–60s**（若原本接近 240 步） | 中：relay 限流/重连时序可能偶发 flaky；建议保留 350ms 但把步数上限压到 120 |
| **P2** | `tests/decision-invariants.test.mjs` | 13.4s | 第 44-62 行：5 调查员 × 4 人数矩阵，每个组合 `create` 后第 59 行又 `restore(create(...))` **再建一次局** → 约 40 次 `createGameState`；第 93-132 行：2 种人数 × 100 步，每步全量 `legalMoves` + 校验 + 每 5 步 branch clone + 每 10 步额外 `create('01005',2,...)`（+20 次建局）。 | 矩阵 5×4 → 5×2（1/4 人）；determinism 断言复用同一个 state 而非再 create；100 → 50 步；额外 create 每 25 步一次。 | 13.4→**6–7s** | 低 |
| **P2** | `tests/dunwich-player-acceptance.test.mjs` | 7.0s | **1 个巨型 test**（标题 `Dunwich ${code} ${name} 严格验收主要印刷效果`）内部 47 次 `fixture(...)`（每次 `createGameState`），是主要成本。 | 用 `core-fixture` 的基准 state + `structuredClone` 复用（多数 probe 只改一两张卡），或按卡牌批次合并 fixture。 | 7→**3–4s** | 中：共享 state 会引入互污染风险；需保留每条 probe 的重置断言 |
| **P2** | `tests/p2-hub-http.test.mjs` | 7.3s | 2 个测试各起/停 HTTP server 3-4 次；第 2 个测试通过 HTTP 完整打穿「集结」到 scenarioResult（第 205-213 行，`i<150` 步）。 | 第 2 个测试改为在 scenarioResult 处加载已存档快照（同文件已覆盖 save/load 路径），或走 resign 快速进结算；把 150 步上限压到实际所需。 | 7.3→**3–4s** | 中：失去“纯合法动作打完一整关”的端到端证据；可拆一条小用例保留 30 步冒烟 |
| **P3** | `tests/notz-n4.test.mjs` | 5.8s | 第 144-158 行：种子搜索最多 24 次 `fixture+midnight` 直到凑齐 4 个使者组；第 105 行 4 人循环。 | 种子上限 24→8 + 注入固定 agentSet（若可）；4 人循环保留。 | 5.8→**3–4s** | 低 |
| **P3** | `tests/save-migration.test.mjs` | 3.7s | 第 106-143 行「升级选项很多的局间存档」：为造 >1000 条 `hubPurchase` 而全量 `legalMoves(old)`（:138-139），Carcosa 2 人局间枚举成本高。 | 用 1 人局（仍 >1000 条？以实测为准）或减少可升级卡池；其余 11 条迁移链用例保留。 | 3.7→**2s** | 低 |
| **P3** | `tests/dunwich-rules.test.mjs` | 9.0s | 119 测试 / 111KB，`settle()` 109 处 + `fixture()` 29 处；每测试 ~75ms，**无单一热点**。 | 不删测试；长期可把纯规则函数的用例改用轻量 state skeleton（现在都用完整 createGameState）。 | 9→**6–7s**（L 工作量） | 中：改动面大，收益中等，不建议现在做 |
| **P3** | `tests/core-final-acceptance.test.mjs` | 6.0s | 12 测试；第 8 行循环 core 3 关所有地点/变体（数据量小）；第 21 行 10 个种子迭代建局。 | 第 21 行 10 → 3 个种子（随机布置覆盖已够）。 | 6→**4.5–5s** | 低 |

> 另：fast tier 内部关键路径是 `replay-golden`（11.2s，13 局/786 步 golden 基线），不建议削——它是重放契约的唯一全局门禁；若 fast 墙钟需要下降，可考虑把 `tfa-investigators`（4.1s）等大数据文件留给 slow，但收益有限。
>
> `assets` tier 关键路径 `audit-resources`（25.5s）+`import-cards`（22.1s）主要成本是读 13MB 卡池与资源哈希；属于“生成物校验”，可只在小改内容时跑，不建议削参数。

### 6.3 推荐执行顺序（对 `npm test` 墙钟）

1. 拆分 + 削减 `campaign-n4`（必修，单点决定 `all` 的 90% 墙钟）→ all 预计 ~60–80s。
2. 削减 `replay-fuzz`（100→40 局、5000→2000 步）→ all 预计到 ~40–50s（此时 replay-fuzz ~30s 是新关键路径）。
3. 给 `hall-online` 计时并按 §6.2 调整；它可能把 slow 关键路径接到 40–60s，需要重测。
4. 其余 P2/P3 只在“重新分层/重新计时”时一并处理，避免为了 1-3s 引入 flaky。

---

## 7. git 历史信号

- 仓库只有 ~8 天历史（首提交 `c1b595c` 2026-10-17）。用 `git log -80 --name-only -- tests/` 统计**每个测试文件最后被触及的提交**：
  - **45+ 个文件最后一次修改就是初始提交 `c1b595c`（2026-10-17）或 TFA 提交 `2c6fb1d`（2026-10-18）**：包括 `notz-n4`、大量 `carcosa-*`、`p0/p3/p4/p5/p6/p7` 浏览器 spec、`core-encounter-acceptance`、`decision-invariants` 等。它们仍在跑且仍绿，说明“稳定”，**不能仅凭未改动判定过时**；但其中 `p0.browser`、`p2-hub.browser`、`p3-table/p4-interaction/p5-map/p6-content` 等阶段命名已与现实里程碑脱节（P7 已发布），属“历史命名负债”。
  - **最近两个提交新增的 3 个测试从未进清单**（F1/F2）——这是 git 能给出的最硬信号：最新改动（观测性能 P1.4/P3.2）恰好绕过了唯一的分层守卫。
  - 工作树新增的 5 个 tcu-player 测试 + `tools/audit-tcu-player.mjs` 未跟踪（F3）：合并风险。
- 结论：git 信号支持“最新用例没进 tier”与“一次性里程碑断言反复过期”（F4/F5/F6）；不支持“大量测试长期未随源码更新”这种强判断（8 天历史太短，且无失败证据）。

---

## 8. 方法与限制（供复核）

- **未运行**任何测试/基准/audit：本机 `node --test`、`playwright`、`audit-*` 都会派生子进程并捕获 stdio，按环境限制会 EPERM。需要实测数字请以 Lead 的 `.test-audit/` 测量结果为准。
- 允许并使用的工具：`read`/`grep`/`glob`、只读 `git log/show/diff/status/ls-tree`、以及 in-process `node -e`（读 package.json/suites.mjs/node-suite.mjs、统计文件与测试标题、比对卡号）。所有“合计耗时”均为 `suites.mjs` 注释值的算术和，不是墙钟。
- 未验证项：`npm test` 当前红的结论基于对 `suite-manifest.test.mjs` 逻辑的逐行复算（磁盘 158 vs 注册 155），**不是实跑结果**；fast 当前例数无法静态精确得到（动态注册的用例数 > 静态 test() 数）。
- 若 Lead 传来实测 tier 数字，建议补充一节「§9 实测 vs 声明对照」：fast/slow/assets/all 墙钟与 `audit/baseline.json:118`、`docs/testing.md:13-17`、`suites.mjs:4-7` 三处声明逐一比对。
