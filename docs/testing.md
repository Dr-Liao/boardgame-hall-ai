# 测试怎么跑

`games/arkhamhorror` 的回归按覆盖面与实测耗时分成 fast / slow / assets 三档，日常改动只跑快档；
全量入口 `npm test` 会把所有文件交给 node 自己的测试运行器并行跑（每个文件独立进程）。

机器、内容量和测试清单都会持续变化，本文不锁定容易失真的耗时数字。
Arkham 逐文件与 tier 墙钟用 `node tools/test-timings.mjs <tier>` 现测。

## 命令

大厅 `package.json` 不再为每个游戏登记命令；游戏自己的脚本统一用 `npm run test:mod -- <游戏 id> [脚本]` 转发，
脚本写 `fast` 时先找 `test:fast`。不带脚本名运行 `npm run test:mod -- arkhamhorror nope` 可列出该游戏的全部测试脚本。

| 命令 | 覆盖 |
| --- | --- |
| `npm run test:mod -- arkhamhorror fast` | 规则、AI、卡牌逻辑、golden replay |
| `npm run test:mod -- arkhamhorror assets` | 卡池导入、展示资源、媒体许可、BGM 分配 |
| `npm run test:mod -- arkhamhorror slow` | 整局模拟、存读档迁移、随机对局重放、大厅联机集成（含四人长跑） |
| `npm run test:mod -- arkhamhorror` | 全量（默认入口，每个文件独立进程并行） |
| `npm run test:mod -- arkhamhorror node` | 全量，单进程串行（仅用于排查顺序依赖，不建议日常运行） |
| `npm run test:mod -- arkhamhorror timing` | 逐文件耗时、tier 墙钟与并行度（`tools/test-timings.mjs`） |
| `npm run test:hall` | 大厅 Node 回归，只依赖参考游戏和 `tests/fixtures/mods/` 下的测试专用 Mod |
| `npm run test:online` | 全部大厅联机 Node 回归；`test:online:core` 只跑核心文件 |
| `npm run test:hall:browser` | 大厅浏览器回归（当前 19 例，复用系统 Edge） |
| `npm run test:hall:all` | 大厅 Node + 浏览器回归 |
| `npm run test:mod -- arkhamhorror browser` | 诡镇浏览器回归；不在默认 `npm test` 内 |

P1（2026-10-24）优化了引擎热路径：构筑规则（升级/自动构筑/legalMoves）从每张牌重复 `structuredClone`
改为按调查员缓存冻结规则 + 卡面/规则派生信息 WeakMap 缓存；golden replay 按分组拆成 3 个文件并行；
四人联机长跑去掉冗余 status 轮询并下调固定等待。

慢档里两个历史上最重的文件已经拆分减量：`campaign-n4-purchase-stress`（默认 50 轮，`N4_CANCEL_LOOPS=300` 跑原深度）、
`replay-fuzz` / `replay-fuzz-walker`（默认 40 局 / 400 步，`REPLAY_FUZZ_FULL=1` 跑完整 100 局 / 2,000 步）。
完整口径留给 nightly 或发布前手动跑。

手工验证单个文件最快：`cd games/arkhamhorror && node --test tests/ai-dialogue.test.mjs`（通常 1–2 秒，含 node 启动）。

## 大厅回归与游戏回归的边界

大厅回归验证的是 Mod 契约，而不是某个游戏：多人席位、私有手牌、同时行动、批量确认、存档兼容等能力都由
`tests/fixtures/mods/fixture-cards` 提供，新增或移除 `games/` 下的游戏不会影响 `npm run test:hall`。
某个游戏在大厅上的集成表现（如诡镇的四人联机、换牌界面、存档管理页）放在游戏自己的仓库里，
例如 `games/arkhamhorror/tests/hall-online.test.mjs`、`hall-online.browser.mjs` 与 `hall-setup.browser.mjs`。

## 分层怎么维护

`games/arkhamhorror/tests/suites.mjs` 是唯一的分层清单，每个 `tests/*.test.mjs` 必须恰好落在一个 tier 里。
`tests/suite-manifest.test.mjs` 负责守住它：与 `node-suite.mjs` 的用例集合一致、磁盘上没有漏登记的用例、
tier 之间不重叠、清单里的文件真实存在。任何 tier 开始跑之前都会先跑这个守卫，所以新用例忘登记会立刻报错，
而不是等到某次全量才发现快测根本没覆盖它。

清单不再写死逐文件秒数（引擎/内容一变就失真，历史注释曾偏离实测 3–4 倍）。需要逐文件耗时时跑
`node tools/test-timings.mjs <fast|slow|assets>`：默认并行（看 tier 墙钟与相对排序），加 `--serial` 得到接近
「单文件净耗时」的数字，`--top=N` 只看最重的几个。重新分层前先重测，别按文件名猜——例如名字像"轻活"的
`replay-golden` 现在是 fast 档的关键路径。

TCU 的 fast 回归只用 `tools/check-tcu-audit-sources.mjs` 校验审计账本锁定的来源哈希，不在测试进程里嵌套重跑
整套证据。需要完整复算时显式运行 `npm run audit:tcu:check`；发布门禁仍使用完整复算口径。

## 为什么快

`node --test` 收到多个文件时会按 CPU 并行、每个文件独立进程；把清单塞进单个入口文件串行 import 则没有这层并行。
并行入口（`tools/run-tests.mjs`、`tools/test-timings.mjs`）就是按这个方式跑。
墙钟由当次最慢的少数文件和进程排队决定，因此瓶颈应以 timing 工具的当前输出为准；
串行单进程入口通常会慢一个数量级。

顺带修掉一个隐患：单进程串行跑全量时，模块级全局状态会在用例文件之间串。
典型例子是 `music-assets.test.mjs`——它在串行全量里被判红（别的用例往内容注册表里注册了测试战役），
独立跑却通过。按文件隔离进程后这类互相污染不会再发生。

## 生成物与账本：看到红先重生成，不要当成"我改坏了什么"

卡池或内容改动之后，仓库里有几类**派生文件**会比源文件旧，跑测试就会红。它们不是用例失败，按下面顺序重生成即可：

```bash
cd games/arkhamhorror
node tools/audit-core-acceptance.mjs --write     # Core 逐卡验收账本
node tools/audit-p6.mjs --write                  # P6 行为差异账本
node tools/audit-dunwich-acceptance.mjs --write  # 敦威治逐卡账本
node tools/audit-carcosa-all-cards.mjs --write   # 卡尔克萨逐卡账本
node tools/audit-carcosa-scenarios.mjs --write   # 卡尔克萨逐章账本
node tools/import-cards.mjs --write              # src/cards/cards-data.js、audit/catalog-report.json
node tools/build-presentation.mjs --write        # 展示资源报告里的资源版本
```

`--write` 不是改哈希糊过去：逐卡账本会**先重跑证据用例**，任何一条不是 `pass` 都直接退出、不写盘。

顺序有依赖：账本脚本会重写 `src/cards/*-acceptance.js`，而 `resourceVersion` 把这类文件一起算进摘要，
所以**先跑账本、再跑 `import-cards` 和 `build-presentation`**，否则 `import-cards --check` 会一直报"生成物漂移"。

判定红线：`node tools/<脚本> --check` 全部应当零漂移。改过证据用例（`tests/*.test.mjs`）后要重跑对应账本脚本，
否则账本会报 `Stale evidence`。

当心换行符：仓库约定 `* text=auto eol=lf`。账本锁的是**工作区字节**，如果一个被锁文件在 Windows 上被写成 CRLF，
提交后再 checkout 会变成 LF，哈希就再也对不上。生成或改写文件后确认它是 LF。

## 浏览器回归

大厅与 Arkham 的 Playwright 配置都用 `channel: 'msedge'`，即复用系统 Edge，**不下载** Playwright 内核，
所以不需要 `npx playwright install`。`tools/require-playwright-browsers.mjs` 挂在大厅 `test:hall:browser` 与
诡镇 `test:browser` 的 `pre` 钩子上，会先真启动一次浏览器；通道不可用时在跑用例之前就给出可照做的提示，
而不是等 webServer 起来才抛一屏 stack trace。
