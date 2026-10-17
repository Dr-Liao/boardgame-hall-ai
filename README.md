# 桌游大厅（dsh-boardgame-hall）

独立运行的桌游大厅：**启动后自己占用一个端口，并自动打开浏览器**显示大厅网页。
玩家在大厅里配置 AI 角色，与 AI 对弈；**每一款桌游都是一个独立插件（Mod）**，放进 `games/` 目录即可被自动发现。

AI 是**全 agent**：落子决策和台词都由大模型（LLM）产出，而不是内置规则脚本。

> 架构上，AI 侧区分「**回合内记忆**」（同一个 AI 回合的多步决策共享一段对话历史，
> 而不是每个行动重建提示词）与「**确定性兜底**」（模型不可用时按对局种子选一个合法行动，
> 同一种子可复现）。这两点与决策日志、指标见下文「全 agent 架构」一节。

---

## 快速开始

### 获取代码

诡镇奇谈 Mod 是独立仓库，以 git 子模块挂在 `games/arkhamhorror`：

```bash
git clone --recursive <大厅仓库地址>
# 已经克隆过的话：
git submodule update --init
npm install            # 同时安装大厅与 games/* 下各 Mod 的依赖（npm workspaces）
```

不拉取子模块时大厅仍可运行，只是没有诡镇；依赖诡镇的大厅测试会自动跳过。
诡镇卡图（约 1.9 GB）不在仓库中，首次显示时自动缓存，或在 `games/arkhamhorror` 下运行 `npm run images:fetch` 一次性下载。

### 多人联机

支持五子棋、井字棋和诡镇奇谈创建多人房间。在统一开局界面选择“联机房间”，设置席位数量，再逐席选择玩家或 AI；AI 席位会被预留。房主创建房间后复制邀请，朋友在大厅点击“加入联机房间”，粘贴邀请并准备。双方浏览器优先 WebRTC 直连，失败时由 Render 中转接管；无需配置路由器或另装穿透工具。

大厅默认中转地址为 `https://boardgame-relay.onrender.com`，可在“设置 → 联机”修改或用 `BOARDGAME_RELAY_URL` 覆盖默认值。独立中转程序位于 `relay/`，项目附带 Render Blueprint 和部署包。部署与使用步骤见 [多人联机说明](docs/multiplayer.md)。开发版需要 Node.js 22.15+。

### Windows EXE 免安装版

完整解压发布包后，双击 `桌游大厅.exe`。发布包内置 Windows x64 Node.js、全部游戏及本地图片音乐，默认使用端口 18787；无需另装 Node.js。请保留 EXE 旁的 `app`、`runtime` 文件夹。

发布包不携带已有存档、个人配置和密钥。运行后产生的数据保存在 EXE 同目录的 `user-data/`，与开发版的存档隔离；正常保存和恢复新对局的功能不受影响。

Windows 打包已拆成两个独立入口：双击 `build-windows-logic.bat` 生成可独立运行的逻辑包，双击 `build-windows-assets.bat` 生成诡镇奇谈卡图资源包。两者互不依赖，输出文件夹和 ZIP 压缩包均保存在 `dist/`。也可以分别运行 `npm run build:windows:logic` 和 `npm run build:windows:assets`；`npm run build:windows` 仍可一次生成两个包。只有逻辑包构建需要安装 x64 Node.js 22.15+ 和 Windows .NET Framework C# 编译器；资源包可单独构建。构建采用独立的新目录，排除存档、日志、个人配置、测试输出和参考工程。

### macOS 免安装版

macOS 发布包自带对应架构的 Node.js，完整解压后双击根目录的 `桌游大厅.command` 即可启动。首次启动如有安全提示，请右键该文件选择“打开”。Apple 芯片使用 `macOS-arm64` 包，Intel Mac 使用 `macOS-x64` 包；存档和个人设置保存在发布包内的 `user-data/`。

在项目根目录双击 `build-macos.bat`，或运行 `npm run build:mac`，会从 Node.js 官方站点下载运行时并同时生成 Apple 芯片与 Intel 两个 ZIP 包，输出到 `dist/`。也可以用 `npm run build:mac:arm64` 或 `npm run build:mac:x64` 只生成一种架构。ZIP 会保留启动文件和 Node 运行时的 macOS 可执行权限，不需要在 Mac 上再次执行 `chmod`。

**一键打开（推荐）：**

- Windows：双击 `start.bat`
- Git Bash / WSL / macOS / Linux：`bash start.sh`

**手动启动：**

```powershell
cd boardgame-hall
node server.js        # 或 npm start
```

启动后会在 **127.0.0.1:8787** 打开浏览器（`BOARDGAME_PORT` 可改）。

在「⚙️ 设置 → 👤 玩家」中可修改名称、上传头像并预览，点击「保存玩家资料」后持久保存。图片最大 10MB，会自动居中裁剪、压缩为 256px 方形；点击「恢复默认」并保存可移除自定义头像。新开或重开的对局会在玩家栏、聊天区，以及诡镇奇谈的队伍与局内玩家面板显示该头像；已有存档保留原名称和头像。

### 配置大模型（AI 全 agent 需要）

AI 通过 **OpenAI 兼容的 `/chat/completions` 接口**调用模型，支持 OpenAI / DeepSeek / Ollama 等。任选一种方式配置：

1. **配置文件**（推荐）：复制 `boardgame.config.example.json` 为 `boardgame.config.json` 并填入：
   ```json
   {
     "baseUrl": "https://api.deepseek.com/v1",
     "apiKey": "sk-你的密钥",
     "model": "deepseek-flash",
     "temperature": 0.7,
     "maxRetries": 3,
     "timeoutMs": 60000,
     "maxTokens": 10000,
     "maxTurnCalls": 24,
     "jsonMode": "auto",
     "turnTimeoutMs": 120000,
     "maxPromptTokens": 131072,
     "memorySteps": 2,
     "chatEnabled": true,
     "chatNotesMax": 12,
     "chatMaxChars": 500,
     "chatWindow": 8
   }
   ```
2. **环境变量**：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_TEMPERATURE`、`AI_TOP_P`、`AI_MAX_RETRIES`、`AI_TIMEOUT_MS`、`AI_MAX_TOKENS`、`AI_MAX_TURN_CALLS`、`AI_JSON_MODE`、`AI_TURN_TIMEOUT_MS`、`AI_MAX_PROMPT_TOKENS`、`AI_MEMORY_STEPS`、`AI_CHAT_ENABLED`、`AI_CHAT_NOTES_MAX`、`AI_CHAT_MAX_CHARS`、`AI_CHAT_WINDOW`（环境变量优先级高于配置文件）。

   - `maxRetries`：**单个决策步**内允许的模型调用次数（含解析失败/非法落子的重试）。
   - `maxTurnCalls`：**单个 AI 回合**内允许的模型调用总次数。一个回合可能有多个决策步
     （例如诡镇奇谈一个调查员有 3 个行动点），超限会明确中止该回合而不是静默卡住。
   - `maxTokens`：单次调用的输出上限（`<=0` 表示不传该参数）。
   - `topP`：可选采样参数；`<=0` 时不写入请求体，由后端决定。
   - `jsonMode`：结构化输出模式。`auto`（默认）先下发 `response_format=json_object`，
     后端不支持时自动降级为提示词约束 JSON 并记住该后端；`on` 始终下发；`off` 从不下发。
   - `turnTimeoutMs`：**单个 AI 回合**的墙钟预算（毫秒，默认 120000，`<=0` 关闭）。
     超时立即中止该回合，避免一次 `/api/move` 长时间挂起。
   - `maxPromptTokens`：单次请求的提示词预算（本地估算 token，默认 131072 = 128K，`<=0` 关闭）。
     超出时优先丢弃更早的对话历史，并在决策日志与指标里标记 `overBudget`。
     注意它只是"安全阀"：真正决定保留多少回合内历史的是下面的 `memorySteps`。
   - `memorySteps`：**回合内记忆窗口**，保留最近 N 步决策 + 当前步（默认 2，最小 1）。
     调大它 AI 才能记住更长的行动序列；`maxPromptTokens` 仍是硬上限，超了会继续丢弃更早的对话。
     默认 2 与历史版本完全一致（单回合只有 1 步的游戏不受影响）。

   设置 `DSH_HOME` 会把配置与 AI 角色改写到 `<DSH_HOME>/` 下（便于多实例隔离与测试）。

也可以在**大厅网页内**配置：点击右下角「⚙️ 设置 → 🔌 模型连接」，填入 API 地址与密钥、选择模型，并可「测试连接」与「获取模型列表」。展开「⚙️ 高级参数」还能直接编辑采样参数、单步/单回合预算、上下文与记忆窗口、战术交流开关等。网页保存即写入 `boardgame.config.json`；若同名环境变量已设置，则以环境变量为准（界面会提示）。

> 未配置 `apiKey` 时大厅仍可运行，AI 会用「按对局种子选出的合法落子」兜底，保证对局能继续（大厅右上角会提示「未配置模型」）。

---

## 设计思路（全 agent 架构）

### 目标与取舍

之前的 AI 是「规则脚本」：落子靠手写评分函数，台词靠硬编码模板。改成全 agent 后，**落子 + 台词都交给模型**，让 AI 真正「读棋盘、按人设思考、自由发挥」。

由此产生两条关键边界，是整个设计的核心：

1. **AI 架构放在外面**：AI/agent 的全部实现独立在 `lib/agent/` 里，游戏完全不知道 LLM 的存在。
2. **游戏只给 AI 留接口**：每个 Mod 只暴露一套纯数据接口（描述棋局、说明落子格式、列合法落点、校验合法性、应用落子、落子记法），AI 通过这些接口与游戏交互。

这样：
- 换模型（DeepSeek → OpenAI → Ollama）只改配置，不动任何游戏代码；
- 加新桌游只写 `games/<id>/index.js`，AI 能力自动生效；
- 模型产出的落子一定经过游戏的 `validateMove` 校验，非法落子会被打回重试，绝不污染棋局。

### 分层架构

```
┌─────────────────────────────────────────────┐
│  public/        网页大厅（原生 JS，无构建）      │
└───────────────────┬─────────────────────────┘
                    │ /api (REST)
┌───────────────────▼─────────────────────────┐
│  lib/server.js   大厅：会话、路由、落子应用      │
│                  （调用 agent 编排器走 AI 回合） │
└───────┬──────────────────────────┬──────────┘
        │ 组装会话、应用落子        │ 调用 agentPlay()
┌───────▼─────────────┐   ┌───────▼──────────────────────┐
│  games/* (Mod)      │   │  lib/agent/  ★ AI 架构（在外） │
│  - createState      │   │  config.js   LLM 配置         │
│  - validateMove     │◄──┤  client.js   chat/completions │
│  - applyMove        │   │  prompt.js   提示词组装        │
│  - describeState    │   │  decoder.js  解析模型 JSON     │
│  - legalMoves       │   │  orchestrator.js 回合闭环+兜底 │
│  - moveFormat       │   └───────────────────────────────┘
│  - moveToText       │              │ fetch
└─────────────────────┘    ┌─────────▼─────────┐
                           │ LLM（OpenAI 兼容） │
                           └───────────────────┘
```

### 一次 AI 回合的流程（编排器闭环）

`lib/agent/orchestrator.js` 的 `agentPlay(session, seat, turn)` 是每次 AI 决策步的入口；
大厅用 `createTurnContext()` / `endTurn()` 管理「一个 AI 回合」的生命周期：

```
大厅：runAiTurns() 发现 decisionSeat 是 AI
   ├─ 同一个座位 → 复用已有 turn 上下文（回合内记忆）
   └─ 换了座位或行动点用尽 → endTurn() 结算，另起一个 turn
        │
        ▼
构建 system prompt（人设 + 游戏规则 + 输出格式 + 落子格式 + 「你的回合可能不止一步」）
   + user prompt（我是谁/对手是谁 + 当前局面 + 本回合进度 + 最近对局进程）
        │
        ▼
   调模型（chat/completions，记 latency / token 用量）
        │
        ▼
   解析 JSON { move, speech }   ── 解析失败 ──► 反馈错误，同一步内重试
        │
        ▼
   mod.validateMove(state, seat, move)   ── 不合法 ──► 反馈错误，同一步内重试
        │
        ▼
   返回 { move, speech } → 大厅 mod.applyMove() 应用落子，再决定是否还有下一步
```

- **回合内记忆**：同一个 AI 座位在一个回合里的多步决策复用同一段对话历史，提示词里还会
  显式写出「本回合已经行动过 N 步、上一手是什么、剩余行动点」。上下文超过最近 2 个决策步
  会自动剪枝，并插入一句明确的「已省略」说明，避免提示词随回合长度无限膨胀。
- **合法性校验是硬边界**：模型产出的 `move` 必须先过 `mod.validateMove()`，不合法就把错误原文反馈给模型重试（最多 `maxRetries` 次，默认 3）。
- **兜底是可复现的**：重试预算耗尽后，用 `mod.legalMoves()` 选一个能通过校验的合法动作；
  起点由「对局种子 + 当前局面」决定，而不是恒定取第一项，也不是跨局随机的——同一局可复现。
  Mod 可用可选的 `decisionSeed(session, seat, step)` 提供自己的种子（诡镇取对局 RNG 状态）。
- **失败不再静默**：如果 `legalMoves()` 里没有任何候选能通过校验，或单回合模型调用超过
  `maxTurnCalls`，大厅会返回明确的 `AGENT_STALLED` / 错误信息，而不是让对局停在
  「轮到 AI 但永远不动」。

### 决策日志与指标（可观测性）

每次模型调用都会追加一行 JSONL 到 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/decisions.jsonl`，
记录：Mod、会话、座位、AI、模型、revision、第几次尝试、结果（`ok` / `parseError` /
`validateError` / `callError` / `fallback` / `noKeyFallback` / `stall`）、提示词字符数、
耗时、token 用量、模型原始输出片段（截断 300 字符）、错误摘要。日志写入失败只会告警，
不影响对局。

`GET /api/agent-stats` 返回进程内聚合指标（不重读日志文件）：

```json
{ "totals": { "calls": 42, "illegalRate": 0.12, "fallbackRate": 0.05, "overBudgetRate": 0,
              "avgPromptChars": 3800, "avgPromptTokensEst": 2400, "avgLatencyMs": 2100,
              "promptTokens": 51200, "promptTokensEst": 100800,
              "overBudget": 0, "turnTimeouts": 0 },
  "byMod": { "arkhamhorror": { "calls": 42, "turns": 9, "avgStepsPerTurn": 3.1, "avgPromptTokensEst": 2400 } } }
```

带 `?reset=1` 可清零进程内计数（不动历史日志文件）。大厅网页「⚙️ 设置 → 📊 AI 指标」
可直接查看这些指标与最近 30 条决策（含失败原因与模型输出片段）。

### Mod 与 Agent 的接口契约

Mod 不感知 LLM，只提供以下**纯数据/纯规则接口**（详见 `lib/mods.js` 顶部注释）：

| 接口 | 方向 | 作用 |
| --- | --- | --- |
| `createState(settings, players)` | 大厅→Mod | 创建初始对局状态 |
| `validateMove(state, seat, move)` | Agent→Mod | 校验落子合法性，返回 `null` 或错误字符串 |
| `applyMove(state, seat, move)` | 大厅→Mod | 应用落子，返回事件数组 |
| `describeState(state, seat)` | Agent→Mod | 把棋局渲染成给模型看的可读文本 |
| `legalMoves(state, seat)` | Agent→Mod | 全部合法落点（兜底用） |
| `moveFormat` | Agent→Mod | 落子 JSON 格式说明（写进提示词） |
| `moveToText(move)` | Agent→Mod | 落子的人类可读记法（对局进程展示用） |
| `moveCost(state, seat, move)` | Agent→Mod（可选） | 动作的行动点成本；兜底时避免直接选「结束回合」 |
| `decisionSeed(session, seat, step)` | Agent→Mod（可选） | 确定性兜底的种子，让同一局可复现 |

Agent 只通过这些接口与游戏交互，因此**对任意桌游都通用**——只要一个 Mod 实现上述接口，就能接入全 agent AI。

---

## 目录结构

```
boardgame-hall/
├── server.js                    # 入口：加载 Mod、起服务、打开浏览器
├── lib/
│   ├── agent/                   # ★ AI 架构（全 agent，与游戏解耦）
│   │   ├── config.js            #   LLM 配置（env + boardgame.config.json）
│   │   ├── client.js            #   OpenAI 兼容 chat/completions 客户端
│   │   ├── prompt.js            #   system/user 提示词组装（含回合进度）
│   │   ├── decoder.js           #   从模型输出稳健提取 JSON
│   │   ├── log.js               #   决策日志（JSONL）与运行指标
│   │   └── orchestrator.js      #   回合内记忆 + 校验 + 重试 + 确定性兜底
│   ├── mods.js                  # Mod 加载器 + 接口校验
│   ├── ai.js                    # AI 角色库（人设 = system prompt 素材）
│   ├── server.js                # HTTP + REST API + 会话
│   └── open.js                  # 跨平台打开浏览器
├── tests/hall/                  # ★ 大厅核心（lib/）通用回归
│   └── agent.test.mjs           #   回合记忆、剪枝、兜底、失败语义、指标
├── games/                       # ★ 每个桌游 = 一个独立 Mod
│   ├── gobang/index.js          # 五子棋（参考实现）
│   ├── ox/index.js              # 井字棋（第二个示例）
│   └── arkhamhorror/            # 诡镇奇谈：卡牌版（git 子模块，独立仓库，结构见其 ARCHITECTURE.md）
├── public/                      # 大厅网页（原生 JS，无构建）
└── boardgame.config.example.json
```

## 新增一款桌游（Mod）

在 `games/` 下新建目录并放入 `index.js`，`default` 导出对象。完整契约见 `lib/mods.js` 顶部注释，骨架如下：

```js
export default {
  id: 'gobang', name: '五子棋', players: [2, 2], seats: 2,
  cover: '...', coverEmoji: '⚫⚪', description: '...', tags: ['棋类'],
  render: { kind: 'board', size: 15, pieceStyle: 'stone' },
  settingsSpec: [], defaults: {},

  // —— 规则 ——
  createState(settings, players) { /* -> state */ },
  validateMove(state, seat, move) { /* -> null 或错误字符串 */ },
  applyMove(state, seat, move) { /* -> 事件数组 */ },

  // —— 给 AI 的接口 ——
  moveFormat: '{"x":0..14,"y":0..14}',
  describeState(state) { /* -> 可读棋局文本 */ },
  legalMoves(state) { /* -> 合法落点数组 */ },
  moveToText(move) { /* -> "(x,y)" */ },
}
```

大厅首页只显示游戏目录与通用设置；全卡图鉴、卡组构筑、战役界面等入口由游戏模块在自己的界面内提供。
游戏专属资料通过 `clientData` 下发，存档生命周期由 `sessionPolicy(state)` 声明；
存档摘要、角色说明、剩余行动点和 AI 协作计划也由 Mod 接口提供。
大厅不按游戏 ID 或调查员、战役等内部状态字段分支。完整接口见 `lib/mods.js`，诡镇的适配实现见
`games/arkhamhorror/hall-integration.js` 和 `games/arkhamhorror/agent-plans.js`。

## AI 角色

一个 AI 角色的核心是 **`persona`（人设）**：这段文本被原样注入 agent 的 system prompt，模型据此扮演——决定怎么行动、说什么台词。默认内置《蔚蓝档案》的 5 位角色（花冈柚子 / 才羽桃 / 才羽绿 / 天童爱丽丝 / 天童凯伊），分别配置语气、伙伴关系与桌游策略偏好，详见 [角色设定说明](docs/ai-personas.md)。大厅「⚙️ 设置 → AI 列表」里可直接编辑 persona。重启服务时，完全未修改的旧默认角色会自动更新；自行编辑的角色和自建角色会保留。头像支持 emoji，也可在编辑页上传 PNG / JPG / WebP 图片；图片会在浏览器端裁剪压缩为 256px 方形后随 AI 配置保存。

## 合作类桌游与 AI 队友

除了经典的双人竞技 Mod，大厅还支持**合作类 Mod**（`cooperative: true`）。这类 Mod 中，AI 是「队友」而非「对手」：

- `aiSlotLabel` / `aiSlotDescription`：自定义大厅设置里 AI 座位的标签（如「AI 队友」）。
- `teammates`：通过 `settingsSpec` 暴露一个 `select`，让玩家选择实际加入的 AI 队友数量（0 个也可以，即单人）。大厅会根据 `settings.teammates` 动态创建座位。
- `agentHint`：额外注入 system prompt 的游戏说明（合作目标、行动方式等）。
- 诡镇奇谈：卡牌版 就是合作类 Mod 的完整示例——AI 队友会**自动分配调查员并自动构筑卡组**（`engine.js` 的 `buildDeck`），随后与玩家一起合作通关。

## 战术交流与备忘（公开桌聊 / 私聊）

对局界面左下角的 💬 可以随时和 AI **讨论战术**，讨论结论会自动沉淀为本局的**战术备忘**，
并在之后每一次决策时注入提示词。设计文档见 `docs/tactical-chat-design.md`。

- **两种渠道**：公开桌聊（所有 AI 都能看到）与私聊（只有目标队友能看到，其它 AI 不会收到，也不会进入它们的上下文）。
- **自动记住**：只有玩家**明确表达长期意图**（"记住 / 以后 / 每次 / 我们说好 / 别再…"）
  或**确认 AI 的策略提议**时才会写入；"这回合先去阁楼"这类局内临时目标不会进记忆。
- **防污染**：AI 自己的发言永远不能变成约定；同义条目自动合并去重；
  每条备忘只在 30 字以内，可在备忘面板里**查看 / 编辑 / 删除 / 一键清空**，并保留"由哪句话产生"的追溯信息。
- **自动压缩**：备忘超过阈值时按作用域（全队 / 每个私聊对象）分别压缩，
  模型不可用或压缩后仍超硬上限时走**确定性裁剪**（同输入同输出，可复现）。
- **边界**：备忘只影响"选择哪一个合法行动"，不改变任何规则；与局面冲突时一律以局面和合法行动为准
  （`validateMove` 仍是硬边界）。
- **零插件改动**：抽屉挂在大厅层，五子棋/井字棋/诡镇都自动获得。

## 诡镇奇谈：卡牌版（arkhamhorror）

一个可玩的克苏鲁合作卡牌 Mod（规则引擎 + 数据分离）：

- 5 名核心调查员（守卫者 / 探求者 / 秘术师 / 游荡者 / 幸存者），各有属性、生命、理智与职业卡池。
- **AI 自动构筑卡组**：每位调查员从「本职业 + 中立」卡池按属性契合度打分，自动组出 30 张牌 + 弱点。
- 核心玩法：移动 / 调查（收集线索推进「幕」）/ 攻击 / 躲避 / 打出卡牌 / 使用资产能力；技能检定从混乱袋抽标记。
- 回合循环：神话阶段 → 调查阶段（每位调查员 3 行动）→ 敌人阶段 → 重整阶段。
- 胜负：推进幕至最后并击败首领「食尸鬼祭司」获胜；议程毁灭值走满或调查员全部倒下则失败。

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/catalog` | 桌游目录（含注入的「对手 AI」座位 + 各 Mod 专属设置） |
| GET | `/api/config` | Agent 模型配置（model / baseUrl / hasKey / maxRetries / maxTokens / maxTurnCalls / topP / jsonMode / turnTimeoutMs / maxPromptTokens / envOverrides，不含密钥） |
| POST | `/api/config` | 保存模型连接配置（baseUrl / model / apiKey + temperature / maxRetries / timeoutMs / maxTokens / maxTurnCalls / jsonMode / turnTimeoutMs / maxPromptTokens / memorySteps / chatEnabled / chatNotesMax / chatMaxChars / chatWindow，写入 `boardgame.config.json`） |
| POST | `/api/config/test` | 用给定配置测试连接（返回模型回复与耗时） |
| POST | `/api/config/models` | 拉取 OpenAI 兼容的模型列表（`GET /models`） |
| GET | `/api/agent-stats` | AI 决策指标（调用数 / 非法率 / 兜底率 / 超预算率 / 估算 token / 平均提示词长度与耗时 / 每回合步数 / 回合超时数 / 最近决策）；`?reset=1` 清零计数 |
| GET | `/api/ais` | AI 角色列表 |
| POST | `/api/ais` | 新增/修改 AI（`{ ai }`） |
| POST | `/api/ais/delete` | 删除 AI（`{ id }`） |
| POST | `/api/start` | 开局（`{ modId, settings }`） |
| POST | `/api/move` | 玩家落子（`{ sessionId, move }`），随后 AI 回合（等待模型） |
| POST | `/api/reset` | 用相同设置重开一局 |
| POST | `/api/chat` | 战术讨论（`{ sessionId, text, to }`；`to=null` 公开桌聊，`to=座位` 私聊），返回 AI 回复与本次备忘变更 |
| POST | `/api/notes/add` | 手动钉住一条战术备忘（`{ sessionId, text, to? }`） |
| POST | `/api/notes/update` | 修改备忘（`{ sessionId, noteId, text }`，≤30 字） |
| POST | `/api/notes/delete` | 删除备忘（`{ sessionId, noteId }`） |
| POST | `/api/notes/clear` | 清空本局记忆（`{ sessionId }`） |
| POST | `/api/leave` | 退出对局（同时删除该局存档） |
| GET | `/api/sessions` | 服务端已落盘的对局存档列表（含 `persist` 开关、存档目录、revision 与资源版本） |
| POST | `/api/session/delete` | 删除某一局的存档（`{ sessionId }`） |

## 测试

```bash
npm run test:hall         # 大厅核心（lib/）通用回归：Agent 编排器、回合记忆、兜底与指标
npm run test:arkham       # 诡镇奇谈 Mod 的规则/资源/HTTP 回归（= npm test -w games/arkhamhorror）
npm test                  # 大厅 + 所有带 package.json 的 Mod
npm run test:hall:browser     # 大厅浏览器回归（战术讨论抽屉，需要系统 Edge 通道）
npm run test:arkham:browser   # 浏览器回归（需要系统 Edge 通道）
```

`tests/hall/` 是与具体桌游无关的回归：它用本地 stub 模型（OpenAI 兼容的假服务）验证
回合内记忆、提示词剪枝、兜底确定性、失败语义、决策日志与指标，不依赖任何付费模型。
`games/arkhamhorror/tests/` 里另有真实 HTTP + 本地 stub 模型的端到端回归，包含
「同一种子产生相同 AI 决策序列」的复现性断言。

## 说明与限制

- 经典 Mod 为**双人对局**（1 名玩家 + 1 名 AI）；合作类 Mod 可设置 1~3 名 AI 队友（`teammates`）。
- `/api/start` 和 `/api/move` 会**同步等待** AI 回合完成（含模型调用），因此响应耗时取决于模型速度。
  一个 AI 回合可能包含多个决策步（如诡镇一个调查员 3 个行动点），因此一次点击可能要等多次模型调用；
  单个决策步受 `timeoutMs × maxRetries` 约束，整个回合受 `maxTurnCalls` 约束。
- AI 角色配置落盘到 `~/.dsh/boardgame-hall/ais.json`；战术备忘与讨论记录随对局快照一起落盘，退出对局即删除。
- **对局自动存档、断线可恢复**：每次成功提交后整局原子写入
  `<DSH_HOME 或 ~/.dsh>/boardgame-hall/sessions/<sessionId>.json`；进程重启时自动恢复，
  网页刷新后会回到上一局。资源版本变化、结构不符或损坏的旧存档会被明确丢弃（不会阻断启动），
  默认保留 14 天；`BOARDGAME_PERSIST=0` 关闭持久化，`BOARDGAME_PERSIST_TTL_DAYS` 调整保留天数。
- 同一时刻每个会话只允许一个进行中的提交（并发请求返回 `SESSION_BUSY`）。
- 客户端为原生 ES Module，无构建、无外部依赖，可离线运行（除模型调用外）。
- 诡镇奇谈：卡牌版为粉丝项目，玩法简化实现；文本与设定版权归 Fantasy Flight Games。
