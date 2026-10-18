# 测试怎么跑

`games/arkhamhorror` 的回归原来只有一个入口：单进程把 69 个用例文件依次 import，跑一遍约 5.5 分钟。
现在按覆盖面和实测耗时分成三层，日常改动只跑快的那层。

## 命令

大厅 `package.json` 不再为每个游戏登记命令；游戏自己的脚本统一用 `npm run test:mod -- <游戏 id> [脚本]` 转发，
脚本写 `fast` 时先找 `test:fast`。不带脚本名运行 `npm run test:mod -- arkhamhorror nope` 可列出该游戏的全部测试脚本。

| 命令 | 覆盖 | 实测耗时（Windows / node 22） |
| --- | --- | --- |
| `npm run test:mod -- arkhamhorror fast` | 规则、AI、卡牌逻辑 | 约 8 秒 |
| `npm run test:mod -- arkhamhorror assets` | 卡池导入、展示资源、媒体许可、BGM 分配 | 约 30 秒 |
| `npm run test:mod -- arkhamhorror slow` | 整局模拟、存读档迁移、大厅联机集成（含四人长跑） | 约 2 分钟以上 |
| `npm run test:mod -- arkhamhorror` | 全量（默认入口，每个文件独立进程并行） | 约 2.5 分钟（实测 154 秒） |
| `npm run test:mod -- arkhamhorror node` | 全量，单进程串行（排查顺序依赖时用） | 约 5.5 分钟 |
| `npm run test:hall` | 大厅回归，只依赖五子棋、井字棋和 `tests/fixtures/mods/` 下的测试专用 Mod | 约 10 秒 |
| `npm run test:hall:browser` | 大厅浏览器回归（复用系统 Edge） | 约 7 秒/用例 |
| `npm run test:mod -- arkhamhorror browser` | 诡镇浏览器回归，含诡镇在大厅开局与联机界面上的用例（复用系统 Edge） | 视用例而定 |

手工验证单个文件最快：`cd games/arkhamhorror && node --test tests/ai-dialogue.test.mjs`（0.1 秒）。

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

清单按实测耗时排序并标注了秒数。**重新分层前请重新计时**，别按文件名猜——`campaign-n4` 一个文件就占 130 秒，
而名字很像"重活"的 `carcosa-rules` 只要 1.1 秒。

## 为什么快

`node --test` 收到多个文件时会按 CPU 并行、每个文件独立进程；把清单塞进单个入口文件串行 import 则没有这层并行。
两种写法差一个数量级：fast 43 秒 → 7 秒，全量 328 秒 → 154 秒。

顺带修掉一个隐患：单进程串行跑全量时，模块级全局状态会在用例文件之间串。
典型例子是 `music-assets.test.mjs`——它在串行全量里被判红（别的用例往内容注册表里注册了测试战役），
独立跑却通过。按文件隔离进程后这类互相污染不会再发生。

## 已知红（与你的改动无关）

`import-cards.test.mjs` 有两个用例在仓库当前状态下就失败：`参考资源` 里的 5 个源 JSON 比生成物新，
`src/cards/cards-data.js` 的 `resourceVersion` 与 `audit/catalog-report.json` 的 `bytes`/`sha256` 对不上。

同步方式（会改 `resourceVersion`，旧存档读取时走迁移而不是丢弃）：

```bash
cd games/arkhamhorror
npm run import           # 重新生成 cards-data.js 与 catalog-report.json
npm run presentation:write   # 再同步展示资源报告里的资源版本
npm run test:assets
```

在没同步之前，不要把这两个失败当成"我改坏了什么"。

## 浏览器回归

两个 `playwright.config.mjs` 都用 `channel: 'msedge'`，即复用系统 Edge，**不下载** Playwright 内核，
所以不需要 `npx playwright install`。`tools/require-playwright-browsers.mjs` 挂在大厅 `test:hall:browser` 与
诡镇 `test:browser` 的 `pre` 钩子上，会先真启动一次浏览器；通道不可用时在跑用例之前就给出可照做的提示，
而不是等 webServer 起来才抛一屏 stack trace。
