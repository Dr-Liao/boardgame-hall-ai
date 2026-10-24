# 桌游大厅 · `tests/hall` 测试审计（第 1 问：是否有已过时的用例）

- 审计对象：根仓库 `G:\boardgame-hall-ai`，HEAD `b900998`（工作树干净，仅 `.test-audit/` 未跟踪）。
- 范围：`tests/hall` 下 28 个 `*.test.mjs`（静态计数 107 个顶层 `test()` + 48 个 `t.test()`；实测 JUnit 160 testcase，见 §6.1）、`tests/hall/browser` 5 个 `*.browser.mjs`（10 例）、`tests/fixtures/**`、`tests/hall/playwright.config.mjs`、根 `package.json` 测试脚本、`docs/testing.md` / `docs/multiplayer.md` / `docs/arkham-online-performance.md`（并顺带核对 `docs/tactical-chat-design.md`、`docs/arkham-performance-roadmap.md`）。
- 方法/限制：**只读静态分析**。用 read/grep/git/node 静态脚本（提取 test 标题、import↔export 对照、env 变量交叉核对、计数）。按任务环境限制，**未运行** `node --test`/playwright/任何基准，未改源码。耗时先给静态下限，后由 Lead 实测回填（§6.1）；浏览器层尚未实测。

---

## 一、结论摘要（直接回答第 1 问）

1. **没有发现“仍在断言已被 P1–P4 替换掉的协议”且会误报/漏报的旧用例，也没有需要整文件删除的用例。** P1.1–P3.3 每个性能提交都在同一提交内同步改/加了对应测试（`online-busy/slim/coalesce/static/defer/delta/status-delta/shared`、浏览器 `online/static.browser.mjs`）；旧文件（`online.test.mjs`、`online-sync/ui`、`ai-retry`、`chat-notifications` 等）逐条核对源码后未见已删除的导出、已改名的错误码或已被替换的 wire 断言。
2. **确有 6 处“过时/无效断言或注释”需要更新（不是删除）**：最典型的是 `online-coalesce.test.mjs:148` 的注释与 `online-defer.test.mjs:127/178/182` 三条**永远为真**的断言（`mode:'actor'` 与 `deferred>0` 在源码里已不存在/不可达），它们无法再捕获相应回归。
3. **默认关闭功能（P2.1 `BOARDGAME_ONLINE_DEFER`、P3.2 A1′ `BOARDGAME_ONLINE_SHARED_VIEW`）共 7 个用例覆盖生产默认不可达分支，但全部显式开关、无“假覆盖”。** 建议保留并标注为 opt-in 契约（或迁到独立 script），不建议当作用例 bug。
4. **文档/脚本失配比代码用例更值得修**：`package.json:22` 的 `test:online` 仍是单文件旧入口（`docs/multiplayer.md:89` 还在推荐）→ 已定稿建议删除，见 §6.2；`docs/testing.md:3/16/18/19` 的用例数/耗时（69 文件、154 秒、test:hall 约 10 秒、浏览器 7 秒/例）与现状明显不符——**hall 已实测 14.0s / 160 例（§6.1）**，Arkham 现有 159 个 test 文件，Arkham 全量与浏览器层仍待重测；`docs/multiplayer.md:11` 引用的 `artifacts/boardgame-relay-render-save-resume.zip` 在仓库里不存在（`artifacts/` 被 gitignore 且无生成器）；`docs/tactical-chat-design.md:744-746` 的“28 项 / 1 项 / 218 项”已被后续用例量（160 / 10）取代。
5. **稳定性/环境风险集中在 4 处**：`updates.test.mjs` 2 个用例在缺 csc / 固定路径 Git Bash 时**静默 skip**；`online.test.mjs` fixture 未隔离 `AI_*` 环境（外部若配置了真实模型，AI 先手用例会走后台异步路径而失败/打真实接口）；发布断言用 `sleep(50–100ms)` 等待、以及“探测空闲端口→释放→再 spawn”的竞态，都有 CI flake 风险。**没有 `.only/.todo`、没有固定监听端口用例。**

---

## 二、逐条发现表

判定说明：**更新**＝改注释/收紧或修正断言；**保留但标注**＝用例有效但不代表生产默认路径；**合并**＝可去重；**删除**仅限脚本/死配置，本表没有建议删除的测试文件。

| # | 文件:行 | 现象 | 证据（源码 / 提交 / 文档） | 判定 | 建议动作 | 风险 |
|---|---|---|---|---|---|---|
| H01 | `tests/hall/online-coalesce.test.mjs:148-156` | 注释写「P2.1 后：busy status + 行动者同步发布 + 其他席位后台发布，最多 3 次 publishOnline」，但 P2.1 默认关闭，且源码根本没有 `mode:'actor'` 发布；默认路径应为 2 次 publishOnline（命令开始 1 次 busy status + 命令末尾 1 次 flush）。断言被放宽为 `≤3`/`≤2`，与其测试名「一次行动只 flush 一次最终快照」不匹配。 | `lib/server.js:109-114`（defer 默认 `=== '1'` 才开）、`lib/server.js:1579-1580`（命令开始发 status）、`lib/server.js:1675-1683`（命令末尾 flush）、`lib/server.js:1442-1447`；全仓 `mode:'actor'` 只出现在注释 `lib/server.js:1337`。 | 更新 | 改注释为默认路径描述；默认模式断言收紧为 `publishes.length === 2`、`published === 1`、`statusSent === 1`；需要覆盖 defer 时由 online-defer 负责。 | 低（现在能过，但断言过宽会漏掉「多发布一次」回归） |
| H02 | `tests/hall/online-busy.test.mjs:4, 9-10, 119` | 文件头第 4 行仍写「命令 **finally** 的 busy true→false 走 status」，与同文件 9-10 行、源码都不符：busy=true 的轻量 status 在**命令开始**发（`onlineCoalesce && onlineBusyStatus`），busy=false 随命令末尾最终快照下发。第 119 行断言消息同样写「finally 的 busy 变化应走 status」。第 121-123 行条件 `published>0 || statusSent>0` 近似恒真。 | `lib/server.js:1579-1580`、`lib/server.js:1654`、`lib/server.js:1675-1683`；同文件 `online-busy.test.mjs:9-10` 已自述 P1.5 后放宽。 | 更新 | 修正两处注释/消息为「命令开始的 busy=true status」；把 121-123 行收紧为「最后一条 publishOnline 记录 `busy:false` 且 `published>0`（默认合并路径）」。 | 低 |
| H03 | `tests/hall/online-defer.test.mjs:127, 178, 182` | 三条**永真**断言，已不能检测其声称的行为：① `mode==='actor'` 从来没有任何代码产生；② 默认模式断言同样检查 `actor`；③ `fullFlush.deferred === 0` 中的 `deferred` 只在 `publishOnline({onlySeats})` 时自增，而全仓没有调用方传 `onlySeats`（该分支为死代码）。 | `lib/server.js:1332-1351`（`onlySeats` 定义/使用）、`lib/server.js:1426-1448`（flushPublish 实现注释与代码：defer 时整体 `scheduleBackgroundPublish`，不单发行动者）、`lib/server.js:1421`（background 发布无 onlySeats）；全仓 grep `onlySeats` 仅 3 处且无调用方。 | 更新（+ 源码死代码待清理，另单提） | 把断言换成可观测信号：DEFER=1 时「命令响应返回前客人 revision 未前进、之后一次 background 发布补齐」；DEFER=0 时「恰好一次 flush、published>=2」。`deferred` 断言删除或随源码死分支一起删。 | 中：现在即使「行动者同步发布」回归也不会红（只靠 `background` 存在性兜底） |
| H04 | `tests/hall/online-shared.test.mjs:186` | 标题/注释写「**四席**共用」，但 `fixture(t,{env})` 未传 `count`，默认 `count=2`（第 188-196 行），实际只验证两席。 | 同文件 `fixture` 定义 `:30`（默认 `count=2`）、调用 `:188-196`；`fixture-static` 支持 4 席（`tests/fixtures/mods/fixture-static/index.js:209`）但未用到。 | 更新 | 标题/注释改为「两席」，或 `fixture(t,{count:4,...})` 真正四席（更慢，建议只改文字）。 | 低（标题误导，断言本身有效） |
| H05 | `tests/hall/online-perf-ui.test.mjs:127` | `assert.equal(calls.filter(c => c.startsWith('GET /online/status')).length >= 1, true, 'status 仍走既有轮询')` 是恒真断言（上一行已断言了该数量等于 `statusBefore`；`>=1` 在上一行成立时必然成立）。 | 同文件 `:122-125` 已断言「命令不新增 status 请求」。 | 更新 | 删掉该行，或改成 `assert.ok(statusBefore >= 1)` 在命令前断言。 | 低（死断言，无覆盖价值） |
| H06 | `tests/hall/online-ui.test.mjs:37` | 用 `transportNote: 'banner-only'` 模拟「非语义变化」，但 `public/online-ui.js` 已无 `transportNote` 任何使用（P2.3/P3.x 后改由 sessionStamp/actionStamp 判断）。测试能过是因为任何 serial 变化且会话未变都会只刷 chrome，与该字段无关。 | `public/online-ui.js:81-97`（lifecycle/sessionChanged/actionability 决定重绘）、全仓 grep `transportNote` 0 命中。 | 更新（低优先） | 换成真实非语义字段（如 `lobby.members[].name` 或 `relayUrl`）并加注释，避免后人以为该字段有语义。 | 低 |
| H07 | `tests/hall/online-defer.test.mjs:113-160`、`tests/hall/online-shared.test.mjs:167-303` | 2 个默认关闭开关共 7 个用例：DEFER=1 仅 1 个、SHARED_VIEW=1 共 4 个；默认关闭时（prod 默认）代码路径在默认 `npm test` 中不可达，只作为可选回滚/AB 开关契约。四个 SHARED 用例均显式设置 env，**没有“不打开开关却断言开关生效”的假覆盖**（另 1 个默认关闭用例 `:167-184` 断言 `isolatedViewStateCalls===0`）。 | `lib/server.js:109-114`（DEFER，默认关）、`lib/server.js:123-127`（SHARED_VIEW，默认关）；Arkham 能力已声明 `games/arkhamhorror/index.js:263`，但开不开仍是运维 env。 | 保留但标注 | 文件头/用例名标注 `OPT-IN（生产默认关闭）`；若要缩短默认 `test:hall`，可移到 `test:hall:opt-in`/nightly（见优化 O4），但不要删——它们是回滚开关的唯一回归。 | 低；风险是未来开关删除后用例仍绿（标注 + 开关代码删除时同步删用例） |
| H08 | `package.json:22`、`docs/multiplayer.md:89` | `test:online` 仍只跑 `tests/hall/online.test.mjs` 一个文件；联机测试现已拆成 11 个 `online*.test.mjs`（busy/coalesce/defer/delta/perf-ui/shared/slim/static/status-delta/sync/ui/online），该命令既不等于“联机回归”，也不在 `docs/testing.md` 里。**实测 `test:hall` 全量仅 14.0s（见 §6.1），单文件旧入口收益可忽略。** | `Get-ChildItem tests/hall -Filter 'online*.test.mjs'` = 12 个文件；`docs/testing.md:11-20` 未列 `test:online`；`docs/multiplayer.md:88-92` 推荐 `npm run test:online`；实测数字见 §6.1/§6.2。 | 删除（推荐）/或改 12 文件 glob | **推荐 A：删除脚本**（`package.json:22` 整行），`docs/multiplayer.md:88-92` 删掉该行（保留 test:hall / test:hall:browser）。若确需快速子集：`"test:online": "node --test tests/hall/online*.test.mjs"`（12 文件，Node≥22.15 支持 glob），并在 docs 注明“子集、非门禁”。详见 §6.2。 | 低（误导性入口，不跑坏测试） |
| H09 | `docs/testing.md:18` | 「`npm run test:hall` … 约 10 秒」：**已实测为 14.0s 墙钟（32 核，JUnit 160 testcase/0 失败），+40%，确认过时**（见 §6.1）。静态来源也已印证：`ai-background.test.mjs` 单文件模型延迟串行 ≈10.4s，是该文件 10s+ 的主因；全目录 28 文件/160 例。 | 实测：§6.1（Lead，2026-10-24）；`tests/hall/ai-background.test.mjs:213,363,416,456,565,605`；`tests/hall` 共 28 文件。 | 更新（数字已实测回填） | 用实测数字替换 docs/testing.md 表；建议同时注明机器/核数与“各机器差异大”。 | 低 |
| H10 | `docs/testing.md:3, 16, 19` | ① 第 3 行「69 个用例文件」：`games/arkhamhorror/tests` 现有 **159** 个 `*.test.mjs`；② 第 16 行 Arkham 全量「实测 154 秒」不在本次 hall 实测范围（需重测）；③ 第 19 行浏览器「约 7 秒/用例」：当前 5 文件/10 例，浏览器层待 Lead 单独实测（本文件不写未测数字）。 | `Get-ChildItem games/arkhamhorror/tests -Filter *.test.mjs` = 159；`tests/hall/browser` = 5 文件/10 例；`docs/testing.md` 最后改动 2026-10-19（`git log -1 -- docs/testing.md`）；hall 实测见 §6.1。 | 更新（hall 部分已实测；Arkham/browser 待测） | 与实测同步重写该表；把“历史对比”数字标成历史。 | 低 |
| H11 | `docs/testing.md:27`（另 18 行） | 声称 `test:hall`「只依赖五子棋、井字棋和 `tests/fixtures/mods/` 下的测试专用 Mod」，但实际还有外部环境依赖：`updates.test.mjs` 的启动器用例需要 Windows `.NET Framework` 的 `csc.exe` 与 `C:\Program Files\Git\bin\bash.exe`，`launch.test.mjs` 在 win32 分支执行 `cmd.exe /d /c start.bat`。这些依赖缺失时是 skip，不失败。 | `tests/hall/updates.test.mjs:483-484, 531, 545`；`tests/hall/launch.test.mjs:33-37`。 | 更新文档 | 在大厅回归说明里补「环境前置：csc/Git Bash（可缺省，缺省则跳过 2 个启动器用例）、系统 Edge（浏览器层）」。 | 低 |
| H12 | `docs/multiplayer.md:11` | 让用户「解压 `artifacts/boardgame-relay-render-save-resume.zip`」，但该文件在仓库中不存在，`artifacts/` 被 gitignore，仓库内没有任何脚本生成它（全仓 grep 只有这一处引用）。 | `.gitignore:18`（`artifacts/`）；`git log --all -- artifacts/boardgame-relay-render-save-resume.zip` 为空；全仓 grep 仅 docs/multiplayer.md:11 命中。 | 更新文档 | 改为「复制仓库 `relay/` 目录（含 package.json/server.js/render.yaml）到新仓库」，或提供生成脚本/提交产物。 | 低（部署文档误导） |
| H13 | `docs/multiplayer.md:72` | 「…联机聊天支持真人互聊及向指定 AI 私聊；单人模式的战术备忘功能保持原样，**联机中暂不提供备忘编辑**」。当前大厅联机已支持 `/备忘`、`/清除备忘` 与按席位可见性（online.test 有专门用例）；若这里说的是「没有手工钉住/编辑 UI」，措辞已容易误解。 | `lib/server.js:233-300`（`chatNotesView`、/备忘、/清除备忘 在 online 分支的可见性）；`tests/hall/online.test.mjs:326-409`（联机 /备忘 team/seat、清除只清自己可见）；手工 `/api/notes/*` 仅本地 API `lib/server.js:2351-2389`。 | 更新文档（需产品确认措辞） | 改成「联机支持 /备忘 与 /清除备忘（按席位可见）；手工钉住/编辑面板仍为单人模式」或反之明确边界。 | 低 |
| H14 | `docs/tactical-chat-design.md:622, 744-746` | 测试计数严重过时：「`npm test` 全绿（当前 19 + 199 = 218 项）」「`npm run test:hall` → 28 项全通过（原有 19 + 聊天 9）」「`npm test` → 28 + 199 = 227 项」「`test:hall:browser` → 1 项通过」。现状：test:hall 28 文件/107 顶层/155 报告例；browser 5 文件/10 例。 | 本审计静态计数（见“统计”节）；`git log -1 -- docs/tactical-chat-design.md` = 2026-10-20，早于 P2.2/P3.1/P3.2 新增用例。 | 更新 | 删除易腐的绝对计数，改「以 `npm test` 实际输出为准」；若要保留数字需同步。 | 低 |
| H15 | `docs/arkham-online-performance.md:134` | 「门禁：`node --test tests/hall/*.test.mjs`（114 例）」：现为 155 例（107 顶层 + 48 子用例）。第 83-84 行引用的 `games/arkhamhorror/tests/hall-online.test.mjs`、`tools/run-tests.mjs fast` 均存在，命令本身有效。 | 本审计计数；文件引用均已验证存在。 | 更新 | 改成「以 `node --test` 输出为准」或更新数字。 | 低 |
| H16 | `docs/arkham-performance-roadmap.md:368` | 进度行仍写「P2.2（AI 回合与回包解耦）**进行中**」，与同文档头 `:3`（P2.1–P2.3 已完成）及 2026-10-24 提交 `f303c5b`（已实现 + `tests/hall/ai-background.test.mjs`）矛盾。另 `:426` 的「现状：每 100ms 轮询」位于 P2.3 的“问题陈述”段，属历史描述，但易被误读为现状。 | `git show --stat f303c5b`（P2.2 完成，含 ai-background 测试）；`docs/arkham-performance-roadmap.md:3, 368, 426`。 | 更新文档 | 改 368 行 P2.2 为 ✅；426 行加「（P2.3 前）」。 | 低 |
| H17 | `tests/hall/updates.test.mjs:483-484, 531, 545` | 两个启动器用例是**环境条件静默 skip**：缺 `csc.exe` 跳过 Windows 启动器（含 C# 编译+3 个回滚子用例），缺固定路径 `C:\Program Files\Git\bin\bash.exe`（非 win32 为 `/bin/bash`）跳过 macOS 启动脚本。跳过时套件仍全绿，等于该回归在部分开发机/CI 上无覆盖；Git Bash 装在别处也会被跳过。 | 同文件 `:531`（`skip: !csc || !fs.existsSync(csc) ? ...`）、`:545`（`skip: !fs.existsSync(gitBash)`）、`:541/551` 真正 spawn。 | 保留但标注 | `docs/testing.md` 写明前置；或把这两个用例拆到 `test:hall:launcher` 显式脚本（缺环境时明确“未覆盖”而不是 silent skip）；Git Bash 路径可改成 `where bash` 探测。 | 中：回归静默消失不易察觉 |
| H18 | `tests/hall/online.test.mjs:24-47`（受影响用例 `:312-324`） | 该 fixture 只隔离 `DSH_HOME`，**不清理 `AI_*`**；同文件只有后面的聊天用例 `:343-349` 临时保存 5 个 AI 键。若开发机/CI 的环境里配了 `AI_API_KEY`（本项目支持 env 覆盖配置），`empty slots can be AI…` 用例的 AI 先手会走 P2.2 后台路径（`start` 立即返回 `aiPending`，`moveCount` 仍 0），`:318` 的 `started.session.state.moveCount === 1` 会失败，且可能向真实模型发请求。 | `lib/server.js:115-121,1224`（有 apiKey 才走后台）；`tests/hall/ai-background.test.mjs:137-154` 的 `isolateEnv` 是正确做法；`tests/hall/sessions.test.mjs:37-40` 会 delete `AI_API_KEY`。 | 更新（测试隔离） | 在 fixture/文件顶部统一保存并删除 `AI_*`（至少 `AI_API_KEY/AI_BASE_URL/AI_MODEL/AI_JSON_MODE/AI_TIMEOUT_MS/AI_TURN_TIMEOUT_MS/AI_MAX_RETRIES`），用例结束后恢复。 | 中：外部环境相关 flake / 误打真实接口 |
| H19 | `tests/hall/online-coalesce.test.mjs:144,177,218,226,234,253,264,295`；`online-defer.test.mjs:135,175`；`online-busy.test.mjs:113,137,163`；`online.test.mjs:397`；`online-static.test.mjs:232` | 用固定 `sleep(50/60/80/100/120ms)` 等后台 setImmediate/发布落定后再读 perf 记录；负载高时可能不足 → flake；正常时纯加时。 | `lib/server.js:1399-1424`（setImmediate/后台发布）、`tests/hall/online-coalesce.test.mjs:141-146`（注释自述“让残留兜底 setImmediate 跑完”）。 | 更新（健壮性） | 用条件等待替代，如 `waitFor(() => perf.recordsSince(from).records.some(e => e.event==='publish.member'))` 或等 `online.metrics.statusMessages/snapshots`、guest revision 到位；仅保留必要的极短让路。 | 中：flake 风险（尤其 CI/慢盘） |
| H20 | `tests/hall/launch.test.mjs:53-58,64-69`；`tests/hall/browser/chat.browser.mjs:27-35,78-93` | 「先 listen(0) 取端口 → close → 再用该端口 spawn/启动」存在竞态窗口；launch 用例重启自身 server 走同一端口。 | 同文件行号；`launch.test.mjs:58` spawn 使用 `BOARDGAME_PORT=port`。 | 保留但标注 | 失败时对 `EADDRINUSE` 重试一次，或让服务端选端口后从 stdout/health 发现（launch 用例可解析）。 | 低 |
| H21 | 全目录（例：`online-static.test.mjs:114-252`、`online-status-delta.test.mjs:97-152`、`online-slim.test.mjs:84-128`） | 各用例假设 P1–P4 开关处于默认值，但只在本文件内设置自己要测的开关，**不清理其它 `BOARDGAME_ONLINE_*` 外部 env**。若开发者做过 A/B 后把 `BOARDGAME_ONLINE_STATIC=0`/`STATUS_DELTA=0`/`SLIM=0`/`BUSY=0` 留在 shell 里再跑 `npm test`，默认路径用例会莫名变红/变灰（例如 static 用例期望「声明版本后不带 cards」，STATIC=0 时必然失败）。 | 开关读取点：`lib/server.js:89,92,97,105,114,121,127,752`；测试里仅个别文件设置对应 env（如 `online-coalesce.test.mjs:167`、`online-static.test.mjs:238`、`online-status-delta.test.mjs:163`、`online-defer.test.mjs:115`、`online-shared.test.mjs:190`）。 | 更新（健壮性） | 加一个测试公共 bootstrap：进入每个文件前保存并删除全部 `BOARDGAME_ONLINE_*`（以及非必需的 `AI_*`），用例按需显式打开；可用 `--import` 或 helper 顶部执行。 | 低–中：可复现性 |
| H22 | `tests/hall/online*.test.mjs` 中 8 个 + `ai-background.test.mjs`（共 9 个重 fixture 文件；另有 launch/agent-reactions 等简单 listen） | 每个文件重复约 30–70 行 `listen/stop/fixture/waitFor/nextAction` 样板（`listen` 在 12 个测试文件里重复定义、`stop` 9 个、`fixture` 9 个；`helpers/mods.mjs` 只提供 `loadTestMods`）。维护成本高，也是 env 保存/恢复容易写漏（见 H18/H21）的根源。 | grep 结果（本审计）：`const listen = server` 12 处、`const stop = server` 9 处、`async function fixture(` 9 处；`tests/hall/helpers/mods.mjs:9-15` 仅 15 行。 | 合并（重构） | 抽 `tests/hall/helpers/online-fixture.mjs`：`startHallPair({count,env,persistHost})`、`waitFor`、`startPerf(t)`、AI env 隔离；各文件只保留场景差异。 | 低（纯维护/优化） |
| H23 | `online-busy.test.mjs:103-145` vs `online-coalesce.test.mjs:131-163`；`online-defer.test.mjs:162-184` vs coalesce 默认路径；`online-sync.test.mjs:16-25` vs `online-delta.test.mjs:41-48` | 局部重复：① busy 首测与 coalesce 首测都断言「busy status + 最终快照 + guest 一致」；② defer=0 回滚测与 coalesce 默认路径都断言「命令末尾一次 flush」；③ `__proto__` 拒绝在 online-sync 与 online-delta 各测一遍。 | 上述行号；断言对比见文件内容。 | 合并（低优先） | 仅去重重复断言（保留各文件独有语义：busy 的“status 不污染增量基线”、defer 的开关回滚、delta 的纯函数 API）；预计不改变运行时。 | 低 |
| H24 | 根 `package.json:37-42`、浏览器目录 | 10 个浏览器用例不在 `npm test`（`test` = `test:hall` + `test:mods`；browser 单列 `test:hall:browser`，且不在 CI workflow 里）。docs/testing.md 单独列表是清楚的，但“全量测试”口径需明确：默认 `npm test` 不含浏览器层。 | `package.json:37-42`；`.github/workflows/` 仅 `release.yml`、`sync-r2.yml`，均无测试 job。 | 保留但标注 | 在 docs/testing.md 明确 `npm test` 不含浏览器；若需要“全量”再给 `test:all`（含 browser）或 CI 增加 test job。 | 低 |

---

## 三、已验证「没有过时」的部分（避免误杀）

1. **不存在引用已删除/改名导出**：对 35 个测试/配置文件（28 hall + 5 browser + helper + playwright.config）做 `import {…} from '../..'` 与目标文件 `export` 的静态对照，**0 个缺失文件、0 个缺失导出**（脚本内联执行，未写盘）。
2. **`ai-retry.test.mjs`（文件时间最老 10/8，早于 10/20 的 agent 重构）仍与源码一致**：测试里的关键行为全部还在——`自动重试已达上限`（`lib/server.js:1154`）、`本回合你已经行动过 N 步`（`lib/agent/prompt.js:304`）、`turn-budget` 恢复（`lib/server.js:1129`）、`POST /api/ai/retry`（`lib/server.js:2570`）、错误码 `SESSION_BUSY/STALE_REVISION/WRONG_SEAT/AGENT_STALLED`（`lib/server.js:2576/2578/2581/1155`）。**不过时。**
3. **`chat-notifications.test.mjs`（9/29）与 `public/chat-notifications.js`**：`createChatNotifications({load,save,now})`、`sync(session,{open,channel,visible})`、`dismiss(id,seq)` 契约完全一致（源码 `:3-44` 未被后续提交改动）。**不过时。**
4. **`online-ui.test.mjs`（10/15，早于 public/online-ui.js 的多次改动）行为仍成立**：当前实现仍保留 serial 单调保护（`public/online-ui.js:54`）、instanceId 退役（`:48-51`）、busy 时延迟应用会话（`:72`）、轮询 `?wait=1&after=`（`:91`）、非语义变化只刷 chrome（`:94-98`）。仅 `transportNote` 字段无意义（H06）。
5. **`updates.test.mjs` 已不再测 Gitee**（任务提示中的怀疑点，核实为**否**）：全目录 grep `gitee` 0 命中；CDN 顺序测试（`:127-170`）与当前 `lib/update-common.js:98-100`（CDN → GitHub → 加速镜像）和 `docs/updates.md:48` 完全一致；`tools/release/r2.mjs` 存在，R2 文档引用有效。**不过时。**
6. **`online.test.mjs` 没有“每次行动全量广播 / 100ms status 轮询”的旧断言**：13 个用例都是最终状态/权限/存档断言；唯一与轮询有关的是 `:531-556`，断言的是本地大厅长轮询事件唤醒（`<600ms`）与增量下行体积，且注释已在 P1.3 更新（`:551-552`）；长轮询机制仍在（`lib/server.js:2161`）。**不过时。**
7. **浏览器用例没有被配置漏跑**：`playwright.config.mjs:12-14` `testDir=./browser/` + `testMatch='**/*.browser.mjs'` 覆盖全部 5 个文件（10 例）；无 `.skip/.todo/.only`；`pretest:hall:browser` 的 `tools/require-playwright-browsers.mjs` 存在且会先真启动一次 msedge（fail-fast 有提示）。`browser/arkham-setup.browser.mjs` 已在 `aa13390` 删除并在 Arkham 仓库承接，无残留引用。
8. **fixtures 无死件、未脱节**：`fixture-cards` 被 `online.test.mjs`（并发/私有/批量/存档）与 `browser/online.browser.mjs` 使用；`fixture-static` 被 coalesce/defer/shared/static/status 和 `browser/static.browser.mjs` 使用，且 P3.2 已同步扩展 `viewStateSharesState`/探针（`tests/fixtures/mods/fixture-static/index.js:46-98,236-247`）。`helpers/mods.mjs` 有 12 个使用点。**都保留。**
9. **测试脚本引用的文件/参数全部存在**：`tests/hall/online.test.mjs`、`tests/hall/playwright.config.mjs`、`tools/test-mod.mjs`、`tools/require-playwright-browsers.mjs`、`tools/windows/Launcher.cs`、`tools/macos/launcher.command`、`relay/package.json`、`games/arkhamhorror/tools/run-tests.mjs` 均存在；`test:mods` 只会跑有 `package.json` 的 `games/arkhamhorror`（gobang/ox 无 package.json），与 docs 描述一致；`test:hall` 的 glob 只会命中 28 个顶层文件，不会误跑 `browser/`、`helpers/`、`playwright.config.mjs`。
10. **旧 `chat`/`launch`/`feedback`/`config` 用例**：`chat.test.mjs` 与 `lib/chat.js` 同日更新（10/19）、`launch.test.mjs` 与 `lib/launch.js` 同日（10/10）、`feedback.test.mjs` 与 `public/feedback-ui.js` 同日（10/21）、`config.test.mjs` 的字段（含 `reasoningRetries/reasoningEffort`）在 `lib/agent/config.js:39-82` 仍全部存在并持久化。**未见行为失配。**
11. **没有死用例标记**：全目录只有 `updates.test.mjs:531,545` 两个 `{skip:…}`（见 H17）；无 `.only/.todo`；无写死的监听端口（都用 `listen(0)`）；除 `updates/launch/browser-chat` 外测试都在进程内起服务，无跨进程管道依赖问题（这是本审计环境无法跑测试的原因，不是测试缺陷）。
12. **`git log` 信号解释**：`agent/ai-personas/ai-retry/chat-notifications/launch/online-ui` 等文件自初始导入后未被提交修改，并不是“被遗忘的用例”：它们锁定的 `lib/agent/config.js`、`public/chat-notifications.js`、`lib/launch.js` 契约未变；反而 `ai-retry` 的历史行为字符串仍在当前源码中（见第 2 条）。这类文件应保留。

---

## 四、测试规模 / 耗时 / 优化空间（静态，供第 2、3 问汇总）

**规模（本审计实测的静态计数）**
- `tests/hall`：28 个 `*.test.mjs`，107 个顶层 `test()` + 48 个 `t.test()` = **155 例**（node:test 报告口径）。
- `tests/hall/browser`：5 个 `*.browser.mjs`，**10 例**（chat 4、feedback 1、online 3、player-avatar 1、static 1）。
- 用例数自 docs 记录的 28 项增长到 155 项（主要是 P2.2 的 8 例、P3.1 的 7 例、P3.2 的 5 例，以及更早的 game-ai 等）。

**耗时静态下限（未运行测试）**
- `ai-background.test.mjs`：stub 模型延迟串行合计约 **10.4 s**（`sleep(3000)+sleep(1500)+sleep(2000)+sleep(2000)`[start+reset]`+sleep(700)+sleep(1200)`，行号见 H09），再加 8 个 fixture 的大厅/relay 启停。
- 其余显式固定等待：online-coalesce 8×100 ms、online-busy 3×50 ms、online-defer 2×80 ms、online.test 80+120 ms、online-static 60 ms、chat.test 520 ms、agent.test 300 ms、perf 110 ms、launch/updates 各 25–100 ms；合计约 1.3 s，但分散在不同文件（`node --test` 按文件并行，只影响关键文件）。
- `node --test tests/hall/*.test.mjs` 会按 CPU 并行 28 个文件；墙钟下限由最慢文件决定（目前大概率是 ai-background ≥10.4 s，其次 online.test 13 个串行用例、chat.test、updates 启动器）。
- **估算**：test:hall 墙钟约 **20–40 s**（视机器），docs/testing.md:18 的「约 10 秒」至少偏乐观/已过时；与 Lead 实测对齐后再定稿。

**第 3 问可落地的优化（大厅侧，按收益/风险排序）**
- O1【耗时，收益最大；数字见 §6.3】`ai-background.test.mjs` 的 stub 模型延迟按用例下调（3000→1000、1500→800、2000×2→800×2、1200→800、700 保持），串行延迟 10.4s→≈4.9s，**单文件省 ~5.4s**；按实测 14.0s 为关键路径推算，`test:hall` 墙钟预计 **14.0s→约 9–10s（省 4–5s，≈30%）**，新下限可能由次重的 `HTTP AI recovery…`（8.57s）决定。`<500ms` 断言行号与余量逐条见 §6.3，无需改断言；需同步改标题/诊断文案（`:4,207,209,238,242,433`）。
- O2【健壮性+少量耗时】H19/H20：固定 sleep 改条件等待、端口探测加重试；预计省 ~1 s 并显著降 flake。
- O3【并行度】`online.test.mjs` 的 13 个串行用例可拆成 2–3 个文件（relay/房间核心、私密/同时行动、存档/重启），利用 node:test 文件级并行；该文件当前是次慢路径。风险：共享 fixture 抽取（O5）后再拆。
- O4【默认套件瘦身】H07 的 7 个 opt-in 用例（online-defer 2、online-shared 5）移到独立 `test:hall:opt-in`/nightly，默认 `npm test` 不跑；`test:hall` 体感更短，同时把“生产不可达分支”与默认回归分开。需 Lead 实测其耗时占比后决定。
- O5【维护】H22 抽公共 `online-fixture` helper，并在 helper 顶部统一隔离 `AI_*`/`BOARDGAME_ONLINE_*`（H18/H21），一次改动同时消除 3 类问题。
- O6【文档】H08–H16：`test:online`、docs/testing.md 耗时/文件数、multiplayer 的 artifact/备忘、tactical-chat 计数、perf 文档的 114 例、roadmap 的 P2.2 状态；与 Lead 实测一起收尾。
- O7【可选流程】H24：CI 目前不跑任何测试；若希望防回归，可加一个只跑 `npm run test:hall` 的 workflow（浏览器层可 nightly）。是否需要由 Lead 决定，不计入本轮测试优化收益。

---

## 五、实测回填状态（Lead，2026-10-24）

- ✅ `node --test tests/hall/*.test.mjs`（28 文件）：**墙钟 14.0s**，JUnit **160 testcase / 0 失败**，`testsuite` duration 合计 13947.99ms（32 核机器）→ 见 §6.1。
- ⏳ `npm run test:hall:browser`：Lead 稍后单独实测（5 文件/10 例）；本文件不写未测数字，H10 的浏览器耗时待回填。
- ✅ 各 suite 最重：`agent 通用回归` 1.45s、`HTTP AI recovery is bounded…` 8.57s、chat 相关 ~1.0s；ai-background 单文件 10s+（与 H09 / O1 的静态判断一致）。
- ✅ H09 定稿：`docs/testing.md:18`「约 10 秒」→ 实测 14.0s（+40%），确认过时（见 §6.1）。H10 的 hall 部分已定稿；Arkham 全量 154s 与浏览器「7 秒/例」仍待各自重测。

---

## 六、实测回填定稿（Lead 实测，2026-10-24）

### 6.1 `test:hall` 实测

| 项 | 实测 |
|---|---|
| 命令 | `node --test tests/hall/*.test.mjs`（28 文件全量，32 核机器） |
| 墙钟 | **14.0 s** |
| JUnit 汇总 | **160 testcase / 0 失败**；`testsuite` duration 合计 **13947.99 ms** |
| 单 suite 最重 | `agent 通用回归` 1.45s；`HTTP AI recovery is bounded…` **8.57s**；chat 相关 ~1.0s |

- 与静态审计一致：28 文件吻合；JUnit 160 例 vs 本审计静态 155 例（差 5 为嵌套/计数口径，以 JUnit 为准）。
- **H09 定稿**：`docs/testing.md:18` 的「约 10 秒」→ 改为 **14.0 s**（注明机器/核数；+40%）。
- **H10 定稿（hall 部分）**：`docs/testing.md:3` 的「69 个用例文件」对不上 Arkham 现有 159 个 `*.test.mjs`；第 16 行 Arkham 全量 154s、第 19 行浏览器 7 秒/例不在本次 hall 实测范围，待重测。
- 浏览器层：Lead 稍后单独测，**暂不写入数字**。

### 6.2 H08 定稿：`test:online` 根脚本的去留

**结论：没有保留“单文件旧入口”的必要，推荐删除；如确需快速子集则改成 12 文件 glob，并在文档里降级为“子集”。**

- 现状问题：`package.json:22` 只跑 `tests/hall/online.test.mjs`（13 例），不覆盖 busy / slim / coalesce / static / delta / status-delta / shared / defer 等 8 个新联机文件；`docs/multiplayer.md:89` 把它列为“本机验证”，但实测 `test:hall` 全量只有 14.0s，单文件入口收益可忽略且名不副实。
- **推荐改法 A（最小、最清晰）**：
  1. 删除 `package.json:22` 整行 `"test:online": "node --test tests/hall/online.test.mjs",`；
  2. 删除 `docs/multiplayer.md:89` 的 `npm run test:online` 一行（`:88-92` 代码块保留 `npm install` / `relay:install` / `relay:start` / `test:hall` / `test:hall:browser`）；
  3. `docs/testing.md` 本就没有列 `test:online`，无需改。
- **备选改法 B（若保留快速联机循环）**：`"test:online": "node --test tests/hall/online*.test.mjs"`（12 个文件；`engines` 要求 Node≥22.15，支持 glob 模式），并在 `docs/multiplayer.md` 与 `docs/testing.md` 注明「联机子集，非完整大厅门禁；门禁仍是 `test:hall`」。
- 不建议保留现状（单文件）：名字暗示“联机回归”，实际漏掉 8 个联机文件，比删掉更容易误导。

### 6.3 O1 定稿：ai-background 延迟下调的预计节省与 `<500ms` 断言余量

当前该文件串行模型延迟 = 3000+1500+2000×2+700+1200 = **10.4s**（`ai-background.test.mjs:213,363,416(×2 次调用),565,605`），是 14.0s 墙钟的关键路径（实测该文件 10s+ 与静态一致）。

| 用例 | 现延迟（行） | 建议下调 | 节省 | 相关断言 / 余量 |
|---|---|---|---|---|
| 1 3s 延迟回包 | 3000（:213） | **1000ms** | 2.0s | `:249 elapsed < 500`：立即返回路径历史实测 ~22ms（`docs/arkham-performance-roadmap.md:419`），余量 ~478ms；若回归为同步则 ≥1000ms（检出余量 500ms）。不宜降到 800ms：返回后还要在 pending 窗口内完成 status/读存档/chat/blocked 四步（`:251-265`）。 |
| 3 双击/并发 | 1500（:363） | **800ms** | 0.7s | `:393 elapsed < 500` 同上；另 `:397-398` 要求 t≈80ms 时仍 `SESSION_BUSY`，800ms 窗口余量 ~720ms ✓ |
| 4 AI 先手 start/reset | 2000（:416，start+reset 各一次） | **800ms** | 2.4s | `:438 elapsed < 500`、`:456 resetElapsed < 500`：start 立即返回历史实测 ~9.9ms（roadmap:419），余量 ~490ms；回归检出余量 300ms ✓ |
| 6 回滚开关 `>=600ms` | 700（:565） | **保持 700ms** | 0 | `:588 elapsed >= 600` 要求“真的等模型”：仅比阈值高 100ms，不可再降（可考虑升到 800 换余量，+0.1s） |
| 7 guest 感知 | 1200（:605） | **800ms**（保守 1000ms） | 0.4s（保守 0.2s） | 无 `<500` 断言；`waitFor` 超时 8000/20000、轮询 20ms（`:632-636,647-651`），800ms 窗口约 40 次采样 ✓ |
| **合计** | 10.4s | ≈4.9–5.1s | **≈5.3–5.5s** | 全部 `<500ms` 断言无需修改 |

- **预计 `test:hall` 墙钟：14.0s → 约 9–10s（省 4–5s，约 30%）**。改后新下限可能由次重的 `HTTP AI recovery…`（8.57s）决定，别期望降到 8s 以下；若想继续压，可再看 `ai-retry.test.mjs:60-61` 的超时配置（`timeoutMs/turnTimeoutMs=300`），但那是其被测行为本身，需单独评估，勿盲降。
- **需同步改的文案**（否则数字自相矛盾）：文件头 `:4`「假模型延迟 3s…200ms 内返回」、用例 1 标题/注释/诊断 `:207,209,238,242`、用例 4 诊断 `:433`「2s 模型延迟」。
- **风险：低**。断言阈值不变；“不等待模型”仍由 800–1000ms 延迟 > 500ms 阈值检出；若边缘 CI 更慢，可采用“延迟 1000ms、阈值仍 500ms”的保守档（检出余量 500ms）。

---

### 附：本审计做过的只读检查（可复核）

- `git log --oneline --name-status -- tests/hall`（P1–P4 每个提交对应的测试增改清单）、`git log -1` 逐文件、`git status`（干净）。
- 28 个 test 文件的 `test()/t.test()` 标题与计数、`sleep/setTimeout` 统计、`.skip/.todo/.only` grep。
- 35 个文件的 import↔export 静态对照（0 缺失）。
- `lib/server.js`（协议/开关/发布/命令边界）、`lib/online.js`、`lib/online-sync.js`、`lib/perf.js`、`lib/mods.js`、`public/online-ui.js`、`public/online-delta.js`、fixtures 的针对性阅读。
- 源码 env 变量 vs 测试 env 变量交叉核对（AI_*/BOARDGAME_*/FIXTURE_*）。
- docs 引用核对：`artifacts/boardgame-relay-render-save-resume.zip`（缺失）、`games/arkhamhorror` 文件、`tools/release/r2.mjs`、`.github/workflows`、`.gitignore`。
- 实测数字由 Lead 提供（2026-10-24）：`node --test tests/hall/*.test.mjs` 墙钟 14.0s、JUnit 160 testcase/0 失败、testsuite duration 合计 13947.99ms。

