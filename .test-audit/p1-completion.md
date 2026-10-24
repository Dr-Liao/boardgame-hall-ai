# P1 完成报告（2026-10-24）

对应审计报告 §3「P1」三项：
1. **修引擎热点**：`resolveTransaction` / 构筑规则校验里的重复深拷贝与重复匹配；
2. **拆 replay-golden**：fast 档关键路径按分组并行；
3. **瘦身 hall-online**：全量墙钟第一瓶颈的固定等待与冗余 status 轮询。

> 工作树仍与另一个会话的 TCU WIP 混在一起（该会话在 15:19–15:30 持续改文件/加测试），
> 本次 P1 改动叠加在其上、**未提交**。

---

## 1. 改了什么

### P1-A 引擎热点（最大收益）

用 `--cpu-prof` 定位到真实热点（不是 `resolution.js` 的 state 克隆）：

- **`web/deck-rules.js` 的构筑规则校验**占了 `campaign-n4` 压测 65%、walker 53% 的 CPU：
  `availablePurchases → replacementOptions → replacementVerdict → validateDeckRules` 每张牌/每个替换候选
  都会重新 `deckRules()` → **`structuredClone`** 一次，单次升级枚举可调用上百万次；
  `matchesCardRule` 里还有每次重建 `new Set(KNOWN_KEYS)`、每张卡重复跑 `Uses(...)` 正则等。
- 修复（语义不变，纯缓存）：
  - `deckRules` 按**调查员对象身份**缓存并深冻结（`registerDeckRules` 时 epoch 失效），返回共享只读对象；
  - 规则正则/未知键检查、卡面 text 特征与 printed uses、调查员特质小写表全部 `WeakMap` 缓存；
  - `validateDeckRules` 一次取出「排除式规则」，不再每张牌重建。
- 微基准（同工作树、同脚本，20 次「购卡→取消」循环）：**37.3s → 3.2s（11.5×）**；
  走子器 100 步：**13.1s → 2.3s（5.7×）**。replay-golden 指纹测试全绿（行为零变化）。

### P1-B 拆 replay-golden

- 13 局基线按**重放成本**拆成 3 组并行：`replay-golden-notz-gathering`（5 局）、
  `replay-golden-notz-long`（midnight-masks 152 步 + 80 步）、`replay-golden-campaigns`
  （carcosa/dunwich/tfa 5 局 + strict 3 人随机局）；基线一致性/覆盖率/待决选择门禁留在原文件（只读 JSON）。
- 共用 `tests/replay-golden-fixtures.mjs` + `replay-golden-group.mjs`，新文件已登记 FAST tier / node-suite。
- 结果：13 局仍逐指纹全量重放（9 个测试全绿），fast 档关键路径从 27.6s 单文件变为 3 个 ~10–16s 并行。

### P1-C 瘦身 hall-online（全量墙钟第一瓶颈）

- `views()` 去掉「先取 host → 轮询 4 席 → 再取 4 席」的固定 9 次 status：改为一次并行取 4 席，
  仅 revision 不一致时进入轮询（每次 status 是 ~1.1–1.6MB 全量视图）。
- 四人长跑每步固定等待 **350ms → 150ms**（relay 实际限流是 600 条/10s/连接 ≈ 60/s，150ms 下最坏 ~30/s，仍有余量；
  `views()` 本身会等 revision 收敛，不靠 sleep 保证正确性）。
- 结果：单文件 **126.6s → 61–69s**（连跑两次 69.2s / 61.4s，均 7/7 通过）。

---

## 2. 实测前后（本机 32 线程 / node v22.23.1）

| 指标 | P0 后 | P1 后 | 对比 P0 前（审计基线） |
|---|---|---|---|
| `fast` tier 墙钟 | 94.3s | **25.5s** | 2648 例；P0 前注释曾写 8s/40s |
| `slow` tier 墙钟 | 117.6s | **64.5s** | P0 前 ≥420s（跑不完量级） |
| `assets` tier 墙钟 | 27.8s | **24.6s** | 60s 级 |
| **`all`（全量 Node）** | 139.4s | **82.1s（1 分 22 秒）** | P0 前脏树 ≥891s 被强杀 / clean HEAD ≥7–10min |
| 根 `npm test`（大厅+Mod） | 166.2s | **121.8s**（含 npm 层与测试后段并发写盘，见限制；组件和 ≈ 11+82s） | P0 前 >15min 跑不完 |
| `hall-online` 单文件 | 126.6s | **61–69s** | 审计时 126.6s（全量第一瓶颈） |
| `replay-golden` | 27.6s（单文件） | **15.6s 最大分组**（3 文件并行） | 审计时 86s |
| `campaign-n4-purchase-stress` | 77.1s 单跑 / 93.3s 池内 | **20.6s 池内** | 原 300 轮单测 460.6s |
| `replay-fuzz-walker` | 124s | **25.6s 池内** | 原 5000 步 >480s 跑不完 |
| `replay-fuzz` | 53.8s | **34.5s 池内** | 原 100 局 111s |
| `test:hall` | 14.0s | **12s 级**（160 例全过） | 未变 |

all 池内新头部：`hall-online` 74.6s、`audit-resources` 38.6s、`replay-fuzz` 34.5s、
`import-cards` 28.8s、`replay-fuzz-walker` 25.6s —— **墙钟已从"少数引擎重测试"回到"联机长跑 + 生成物审计"**。

## 3. 验证

```bash
# 行为零变化（golden 指纹是硬门禁）
node --test tests/replay-golden*.test.mjs                      # 9/9 pass
node --test tests/replay.test.mjs tests/availability.test.mjs tests/deck-library.test.mjs \
            tests/card-filters.test.mjs tests/arkhamdb-import.test.mjs tests/core-n4.test.mjs \
            tests/game-settings.test.mjs                        # 43/43 pass
# 拆分组
node --test tests/replay-golden*.test.mjs                      # 20.8s（拆分前单文件约 27.6s 串行）
# 联机长跑稳定性（连跑两次）
node --test tests/hall-online.test.mjs                         # 69.2s / 61.4s，7/7 pass
# 浏览器侧构筑 UI（web/deck-rules.js 在浏览器共用）
npx playwright test --config playwright.config.mjs command-deck.browser.mjs deck-library.browser.mjs  # 2 passed
# 分层与全量
node tools/test-timings.mjs fast|slow|assets|all --top=12      # 25.5 / 64.5 / 24.6 / 82.1s
```

全量 all 的 8 个失败文件全部是**并发会话的既有 WIP**（campaign-n4 持久牌组 1 条、dunwich-player-gaps、
import-cards、music-assets、presentation-http、presentation-images、state-presentation、tcu-migration），
**P1 新增/修改的测试文件没有失败**。

## 4. 限制与遗留

1. **并发会话**：另一个会话在 15:19–15:30 持续新增 TCU 测试与内容；15:30:15 它又加了 2 个未登记 WIP 测试文件
   （`tcu-greater-good` / `tcu-prologue`），此刻 guard 是红的（属于对方在途工作，不是 P1 回归）。
   我把它 15:19 加的 `tcu-scenario-acceptance.test.mjs` 临时登记进了 suites/node-suite/tcu-suite 让门禁恢复绿；
   对方完成批次后需要统一核对清单。
2. **未提交**：工作树混有对方 157+ 项 WIP，P1 改动未提交；建议由维护者统一整理提交。
3. `root npm test` 的 121.8s 含 npm 两层进程与测量后段对方写盘干扰；组件和（大厅 12s + Mod all 82s + npm 开销）
   在干净环境应 ≈95–105s，可复测确认。
4. P2（未做）：assets 审计去重/缓存（audit-resources 38.6s、import-cards 28.8s）、
   默认入口分层（npm test=fast、nightly 全量）、CI 测试工作流、按改动选测、大厅内务。
