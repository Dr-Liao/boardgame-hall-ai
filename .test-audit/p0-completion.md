# P0 完成报告（2026-10-24）

对应上一轮审计报告 `.test-audit/test-suite-audit.md` 的 §3 "P0（先做）"三项：
1. 修复清单守卫（3 个已提交测试文件未登记 → `npm test` 必红）；
2. 拆分/削减两个超慢文件（campaign-n4、replay-fuzz）；
3. 重写耗时文档/注释 + 建立自动计时工具。

> 工作树状态：`games/arkhamhorror` 仍带着另一个会话的未提交 WIP（142 项），本次 P0 的改动叠加在其上、
> **未提交**；`audit/baseline.json` 等派生账本未重生成（需要干净树 + `npm run baseline`，见"遗留"）。

---

## 1. 改了什么

### P0-1 清单守卫（工作树已绿，HEAD 仍红）

- 3 个测试文件 `hall-static` / `view-static` / `view-shared-state`（10 用例）**已在工作树**被登记进
  `tests/suites.mjs`（FAST 档）与 `tests/node-suite.mjs`（前一会话的并行修复，本次验证通过）。
- 验证：`node --test tests/suite-manifest.test.mjs` → **1/1 pass**；磁盘 162 个非守卫用例 = node-suite 162 = tier 162。
- 注意：该修复**尚未提交**，因此 HEAD 快照上守卫仍是红的；提交本次 P0 改动时会一并带上。

### P0-2 拆分/削减超慢文件

| 改动 | 内容 | 依据 |
|---|---|---|
| `campaign-n4.test.mjs` | 只保留"快速部分"（升级/回滚/结局/创伤/牌组迁移，15 条）；抽出共享夹具 `campaign-n4-fixture.mjs` | 单文件实测 ~500s+（其中一条压测占 460s） |
| **新增** `campaign-n4-purchase-stress.test.mjs` | 原"连续 300 次取消购卡"压测独立成文件；默认 **50 轮**，`N4_CANCEL_LOOPS=300` 恢复原深度 | 300 轮单跑实测 **460.6s** |
| **新增** `campaign-n4-matrix.test.mjs` | 原 7 组整局矩阵 → **1/2/4 人 + standard 三组**（难度差异由混沌袋用例覆盖）；每步深拷贝 → 每 20 步抽样（命令仍逐步 clone） | 7 组单跑 ≈30s+，4 人组占 ~13s |
| `replay-fuzz.test.mjs` | 只保留"随机对局重放"；默认 **40 局**（原 100 局），阈值同比；`REPLAY_FUZZ_FULL=1` 恢复 100 局 | 100 局单跑实测 **111s** |
| **新增** `replay-fuzz-walker.test.mjs` | 走子器独立成文件；**不再复用 playGame 的逐步 stateHash**（乱走阶段不需要指纹，只在最后重放校验用 2 次）；直接 `nextMove/applyMove` 驱动，默认 **400 步**，`REPLAY_FUZZ_FULL=1` → 2,000 步 | 旧 5,000 步单跑 >480s（实测单步 ~300ms） |
| `tests/suites.mjs` / `node-suite.mjs` | 新文件登记进 SLOW 档；`suites.mjs` **删除全部写死的逐文件秒数**（保留说明文字），改为 tier 墙钟 + 计时工具指引 | 旧注释/文档实测已偏离 3–4 倍 |
| 相关口径同步 | `tools/run-tests.mjs` 头注释、`ARCHITECTURE.md` 用例表、`README.md` 命令表、`tests/replay.test.mjs`、`tools/replay-games.mjs` 注释 | 旧口径含 100 局/5,000 步/130.3s/71.7s 等 |

### P0-3 自动计时 + 文档重写

- **新增 `tools/test-timings.mjs`**：`node tools/test-timings.mjs <fast|slow|assets|all> [--top=N] [--json=path] [--serial] [--check]`
  输出 tier 墙钟、逐文件耗时（慢→快）、文件合计与并行度、失败文件。
- **新增 `tools/test-timing-reporter.mjs`**：node:test 自定义 reporter（内置 tap/spec 会拍平文件分组，
  必须用 reporter 事件的 `test:summary` 才能拿到 per-file `duration_ms`）。
- `package.json` 新增 `test:timing`（可通过 `npm run test:mod -- arkhamhorror timing` 转发）。
- `docs/testing.md`（大厅根仓库）耗时表按实测重写；`AGENTS.md:67` 删除"2337 例"写死口径，改为以工具/基线实时输出为准。
- 完整口径（nightly/发布前）：
  - `REPLAY_FUZZ_FULL=1 node --test tests/replay-fuzz.test.mjs tests/replay-fuzz-walker.test.mjs`
  - `N4_CANCEL_LOOPS=300 node --test tests/campaign-n4-purchase-stress.test.mjs`

---

## 2. 实测前后对比（本机 32 线程 / node v22.23.1，同一脏工作树）

| 指标 | P0 前 | P0 后 | 变化 |
|---|---|---|---|
| `campaign-n4.test.mjs` 单文件 | ~500s+（并行池内约 560s；300 次循环单测 460.6s） | **18.3s 单跑 / 33.7s 在 all 池内**（1 条既有 WIP 失败） | −90%+ |
| `replay-fuzz.test.mjs` | 100 局单测 **111.1s**；整文件更久 | **53.8s 单跑 / 62.7s 池内**（0 失败） | −45%+ |
| `replay-fuzz-walker.test.mjs` | 5,000 步：>480s（实测单步 ~300ms，原文件跑不完） | **124s 单跑/池内**（400 步，0 失败） | 从"跑不完"到可跑 |
| **slow tier 墙钟** | 下限 ≥420s（campaign-n4 watchdog），实际 ≥7min | **117.6s**（344 用例；1 个既有 WIP 失败） | ≈ −70% |
| **fast tier 墙钟** | 94–96s（未做 P1 优化） | **94.3s**（2648 用例；3 个既有 WIP 失败） | 持平（P1 目标） |
| **assets tier 墙钟** | 64.8s（当时有并发负载）/ 注释 60s | **27.8s**（125 用例；7 个既有 WIP 失败） | 明显下降 |
| **全量 `all` 墙钟** | 脏树 **≥14.9min 被强杀**（下限）；clean HEAD ≥7–10min | **139.4s（2 分 19 秒）**，163 文件 / 3115 用例 | **−80%+，达成 P0 目标（~2min）** |
| **根 `npm test` 全链路**（大厅 + Mod；`npm.cmd test`） | 脏树跑不完（>15min 强杀）；clean HEAD ≥7–10min | **166.15s（2 分 46 秒）** = 大厅 11.2s + Arkham all 139.4s + npm 开销 | **≈ −85%**；exit 1 只因 9 个既有 WIP 失败文件（3103/3115 pass） |
| 大厅 `test:hall` | 14.0s | **11.2s**（160 用例 0 失败，仅文档改动） | 持平 |

全量 all 池内头部（wall 139.4s，并行度 9.4x）：`hall-online` 126.6s、`replay-fuzz-walker` 124.2s、
`campaign-n4-purchase-stress` 93.3s、`replay-golden` 86.1s、`notz-n4` 68.8s、`replay-fuzz` 62.7s。
**P0 后墙钟已回到 `hall-online`（P1 才优化）与 walker 量级，不再是 campaign-n4/replay-fuzz 的 7–15 分钟。**

## 3. 验证

```bash
# 守卫（工作树）
cd games/arkhamhorror && node --test tests/suite-manifest.test.mjs     # 1 pass
# 新/改文件
node --test tests/campaign-n4.test.mjs               # 16 tests, 15 pass, 1 fail（既有 WIP：持久牌组重复卡断言）
node --test tests/campaign-n4-matrix.test.mjs        # 3 pass（21.3s）
node --test tests/campaign-n4-purchase-stress.test.mjs # 1 pass（77.1s）
node --test tests/replay-fuzz.test.mjs               # 1 pass（53.8s）
node --test tests/replay-fuzz-walker.test.mjs        # 1 pass（124s）
# tier / 全量
node tools/test-timings.mjs slow --top=10 --json=…   # wall 117.6s
node tools/test-timings.mjs assets --top=10          # wall 27.8s
node tools/test-timings.mjs fast --top=10            # wall 94.3s
node tools/test-timings.mjs all --top=15 --json=…    # wall 139.4s / 3115 tests / 9 个既有失败文件
# 大厅（根仓库）
node --test tests/hall/*.test.mjs                    # 160 pass / 11.2s
```

## 4. 遗留 / 未做（避免误判为 P0 未完成）

1. **当前工作树本来就有 9 个失败文件**（全量 all 实测）：`campaign-n4`(1 条既有 WIP 失败)、`dunwich-player-gaps`、
   `import-cards`、`music-assets`、`p2-hub-http`、`presentation-http`、`presentation-images`、`state-presentation`、
   `tcu-migration` —— 均来自另一个会话未完成的 TCU/WIP 与未重生成的账本，**不是 P0 引入**；P0 新增/重构的测试文件全部通过。
2. **未提交**：工作树混有另一会话的 142 项 WIP，无法把 P0 改动干净地单独提交；建议由维护者连同该 WIP 一起提交，
   或先提交登记修复 + P0 文件。HEAD 上 `npm test` 目前仍红（守卫未提交修复）。
3. `audit/baseline.json`（2510 例）与历史文档里的用例数未重生成/未改历史记录；需在干净树跑 `npm run baseline`。
4. P1（未做）：修引擎 `resolveTransaction` 每命令深拷贝 `cards/investigatorDefs` 的热点（这是 campaign/replay 单步 ~50–300ms 的根因）、
   拆 `replay-golden`（fast 档 86s 关键路径）、瘦身 `hall-online`（126s，现在是全量墙钟第一瓶颈）。
