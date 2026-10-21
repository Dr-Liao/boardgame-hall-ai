# 桌游大厅（dsh-boardgame-hall）

本地运行的桌游大厅：启动后占用一个端口并自动打开浏览器，玩家在网页里配置 AI 角色，与 AI 对弈或合作。

- **每款桌游是一个独立 Mod**：放进 `games/` 目录即可被自动发现。
- **AI 是全 agent**：行动决策和台词都由大模型（LLM）产出，而不是规则脚本。
- **游戏规则是硬边界**：模型给出的每个行动都必须通过 Mod 的合法性校验，非法行动会被打回重试。

当前内置的游戏：

| Mod | 类型 | 说明 |
| --- | --- | --- |
| `games/gobang` | 双人对弈 | 五子棋，Mod 的参考实现 |
| `games/ox` | 双人对弈 | 井字棋 |
| `games/arkhamhorror` | 合作卡牌 | 诡镇奇谈：卡牌版，独立仓库 [boardgame-arkhamhorror](https://github.com/Dr-Liao/boardgame-arkhamhorror)（git 子模块），见 [诡镇 README](games/arkhamhorror/README.md) |

---

## 快速开始

需要 Node.js 22.15+。

```bash
git clone --recursive https://github.com/Dr-Liao/boardgame-hall-ai.git
# 已经克隆过的话：git submodule update --init
npm install        # 同时安装大厅与 games/* 下各 Mod 的依赖（npm workspaces）
```

不拉取子模块时大厅仍可运行，只是没有诡镇奇谈。

**启动：**

- Windows：双击 `start.bat`
- Git Bash / WSL / macOS / Linux：`bash start.sh`
- 手动：在项目根目录运行 `npm start`（即 `node server.js`）

默认地址是 `http://127.0.0.1:8787`，可用环境变量 `BOARDGAME_PORT` 修改。

在「⚙️ 设置 → 👤 玩家」中可修改玩家名称和头像（最大 10MB，自动裁剪为 256px 方形）。新开的对局会使用新资料，已有存档保留原样。

### 配置大模型

AI 通过 **OpenAI 兼容的 `/chat/completions` 接口**调用模型，支持 OpenAI、DeepSeek、Ollama 等。三种配置方式任选其一：

1. **大厅网页**（最简单）：「⚙️ 设置 → 🔌 模型连接」中填写 API 地址、密钥和模型，可测试连接、拉取模型列表；「高级参数」里可调整其余选项。保存后写入 `boardgame.config.json`。
2. **配置文件**：复制 `boardgame.config.example.json` 为 `boardgame.config.json`，至少填写：
   ```json
   {
     "baseUrl": "https://api.deepseek.com/v1",
     "apiKey": "sk-你的密钥",
     "model": "deepseek-flash"
   }
   ```
3. **环境变量**：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 等，命名规则是把参数名改为大写下划线并加 `AI_` 前缀（如 `maxTurnCalls` → `AI_MAX_TURN_CALLS`）。环境变量优先于配置文件，网页里会提示被覆盖的项。

未配置 `apiKey` 时大厅仍可运行：AI 会按对局种子选一个合法行动兜底，右上角会提示「未配置模型」。

<details>
<summary>全部模型参数</summary>

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `temperature` / `topP` | 0.7 / 不传 | 采样参数；`topP <= 0` 时不写入请求 |
| `timeoutMs` | 60000 | 单次模型调用超时 |
| `maxTokens` | 10000 | 单次调用的输出上限，`<= 0` 表示不传 |
| `maxTokensCeiling` | 65536 | 推理把输出预算花光时（模型只思考没答话），自动翻倍重试的上限 |
| `reasoningRetries` | 2 | 上述「思考吃满预算」的重试次数 |
| `reasoningEffort` | 不传 | 推理强度 `minimal` / `low` / `medium` / `high` / `max`；留空由后端决定 |
| `maxRetries` | 3 | 单个决策步内允许的模型调用次数（含解析失败、非法行动后的重试） |
| `maxTurnCalls` | 24 | 单个 AI 回合内的模型调用总次数；一个回合可能有多步，超限会明确中止 |
| `turnTimeoutMs` | 120000 | 单个 AI 回合的总时长预算，`<= 0` 关闭 |
| `maxPromptTokens` | 131072 | 单次请求的提示词上限（本地估算），超出时先丢弃更早的历史 |
| `memorySteps` | 2 | 回合内记忆窗口：保留最近 N 步决策和当前步 |
| `jsonMode` | `auto` | 结构化输出：`auto` 先尝试 `response_format`，后端不支持时自动降级；`on` 始终下发；`off` 从不下发 |
| `chatEnabled` / `chatNotesMax` / `chatMaxChars` / `chatWindow` / `chatReplyCooldownMs` | `true` / 12 / 500 / 8 / 4000 | 战术交流开关、备忘条数上限、单条消息长度、上下文窗口、同频道回复冷却（毫秒，0 关闭） |

设置 `DSH_HOME` 会把配置、AI 角色和存档放到 `<DSH_HOME>/` 下，便于多实例隔离与测试。

</details>

### 多人联机

五子棋、井字棋和诡镇奇谈都可以创建多人房间：开局时选择「联机房间」，设置席位并逐席选择玩家或 AI，然后把邀请发给朋友，对方在大厅点击「加入联机房间」粘贴即可。

连接优先走 WebRTC 直连，失败时由中转服务接管，无需配置路由器。默认中转地址是 `https://boardgame-relay.onrender.com`，可在「设置 → 联机」或用 `BOARDGAME_RELAY_URL` 修改。中转程序在 `relay/`，部署步骤见 [多人联机说明](docs/multiplayer.md)。

### 免安装发布包

发布包内置 Node.js 和全部游戏，不携带存档、个人配置和密钥；运行数据保存在发布包内的 `user-data/`，与开发版隔离。

| 平台 | 使用方式 | 构建命令 |
| --- | --- | --- |
| Windows x64 | 完整解压后双击 `桌游大厅.exe`（默认端口 18787），保留旁边的 `app-*`、`runtime-*` 文件夹和 `current.ini` | `npm run build:windows`，或双击 `build-windows-logic.bat`（程序包）/ `build-windows-assets.bat`（诡镇卡图资源包）/ `build-windows-hall.bat`（纯大厅版，只含五子棋和井字棋，约 35 MB，正式发布用的就是这个） |
| macOS | 完整解压后双击 `桌游大厅.command`；首次如有安全提示，右键选择「打开」。Apple 芯片用 `macOS-arm64` 包，Intel 用 `macOS-x64` 包 | `npm run build:mac`（或 `build:mac:arm64` / `build:mac:x64`，也可双击 `build-macos.bat`）；纯大厅版用 `npm run build:mac:hall` |

构建产物输出到 `dist/`。Windows 程序包的构建需要 x64 Node.js 22.15+ 和 .NET Framework C# 编译器，资源包可以单独构建。

Windows 首次运行可能提示「打开文件 - 安全警告」并显示「未知发布者」：这是 Windows 对从网上下载的未签名 EXE 的常规提醒。只在自己电脑上运行，右键 ZIP 或 EXE → 属性 → 勾选「解除锁定」即可；要发布给别人，需要给 EXE 做代码签名，两种办法和证书选择见 [Windows 的「未知发布者」提示](docs/windows-signing.md)。

构建脚本不认识具体游戏：纯大厅版内置哪些游戏由 `package.json` 的 `boardgame.liteGames` 决定；游戏在自己的 `boardgame-mod.json` 里声明要拆成独立资源包的文件（`assetPacks`）和追加到使用说明的条目（`portableNotes`），格式见 `tools/release/stage-games.mjs` 顶部注释。

### 自动更新与游戏商店

大厅和每个游戏各自在 GitHub Release 上发版。大厅启动后以及之后每 6 小时检查一次新版本，大厅更新在「⚙️ 设置 → 🔄 大厅更新」中操作，游戏的安装与更新在大厅的「🎮 游戏中心」弹窗中操作：

- **更新大厅**：新版本下载到 `app-<版本>/` 旁路目录，重启后切换。新版本启动失败时，启动器会自动回滚到上一版本。
- **安装或更新游戏**：游戏下载到 `user-data/boardgame-hall/mods/<id>/<版本>/`。新游戏装完立即可玩，已加载游戏的新版本在重启后生效。
- **增量更新**：大厅和游戏都只下载变化的文件，未变化的文件从本地旧版本复用；不具备条件时自动退回整包下载。
- **签名校验**：所有清单都经过 ed25519 签名校验，下载内容再按 sha256 校验，可以放心使用 GitHub 加速镜像。

推送 `v<版本>` tag 后，GitHub Actions 会自动构建、签名并发布。密钥配置、目录仓库和发布格式见 [自动更新与游戏商店](docs/updates.md)。

---

## 功能

### AI 角色

AI 角色的核心是 `persona`（人设），这段文本会原样注入 system prompt，决定 AI 怎么行动、说什么话。默认内置《蔚蓝档案》的 5 位角色（花冈柚子、才羽桃、才羽绿、天童爱丽丝、天童凯伊），详见 [角色设定说明](docs/ai-personas.md)。

在「⚙️ 设置 → AI 列表」中可编辑人设和头像（emoji 或图片）。重启时，未改动过的默认角色会自动更新，自己编辑或新建的角色会保留。

### 合作类游戏与 AI 队友

合作类 Mod（`cooperative: true`）中 AI 是队友而不是对手，可选 0~3 名 AI 队友。Mod 可以通过 `aiSlotLabel`、`aiSlotDescription` 自定义座位文案，通过 `agentHint` 向 system prompt 补充合作目标。

### 战术交流与备忘

对局界面左下角的 💬 可以和 AI 讨论战术，分为**公开桌聊**（所有 AI 可见）和**私聊**（只有目标队友可见）。

- 公开桌聊默认由一名队友回应；输入 `@名字` 只让该队友回复，输入 `@全体`（也接受 `@所有人` / `@全员`）让所有 AI 队友都回复。输入框会自动弹出候选。
- 输入 `/` 使用指令：`/备忘 <内容>` 直接把一句话记进本局战术备忘，`/清除备忘` 清空本局备忘，`/help` 查看指令。指令不调用模型。
- 联机房间同样支持 `@` 与 `/`：行动由房主执行，队伍备忘所有人可见，私聊备忘只有发起那次私聊的成员能看到；联机里的备忘面板是只读的（改动走 `/备忘` 与 `/清除备忘`），`/清除备忘` 只会清掉你自己看得见的条目。
- 只有玩家明确表达长期意图（如「记住」「以后」「每次」）或确认 AI 的提议时，才会自动写入本局的战术备忘，并在之后每次决策时注入提示词。
- AI 自己的发言不会变成约定；每条备忘不超过 30 字，可在备忘面板查看、编辑、删除或清空。
- 备忘过多时会自动压缩；备忘只影响 AI 选哪个合法行动，不改变规则。
- 发送后按钮立即恢复，不必等模型；连续发言不会被逐条排队回复（同一频道有回复冷却，设置 → 模型连接 → 高级参数可调）。
- 该功能挂在大厅层，所有 Mod 自动获得。设计文档见 [战术交流设计](docs/tactical-chat-design.md)。

### 自动存档

每次成功提交行动后，整局会写入 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/sessions/<游戏 id>/<sessionId>.json`，每个游戏一个子目录（旧版直接放在 `sessions/` 下的存档会自动迁移过去）。进程重启或网页刷新后会回到上一局；损坏或版本不符的旧存档会被丢弃，不会阻断启动。

存档默认保留 14 天，`BOARDGAME_PERSIST=0` 关闭持久化，`BOARDGAME_PERSIST_TTL_DAYS` 调整保留天数。退出对局会删除该局存档。

### 反馈

大厅右上角（对局里在标题栏；诡镇的战役页和牌桌在标题栏最右侧各有一个入口）的「💬 反馈」会打开内置弹窗，里面是飞书多维表格表单，提交后直接进「桌游大厅问卷」。

- 「📋 一键复制诊断信息」复制大厅版本、系统、浏览器、当前游戏、时间和最近一条错误，粘贴到表单的「游戏环境」或「问题描述」即可；内容不含 API Key、密钥、存档路径或聊天记录。
- 表单是跨域内嵌的：大厅不能预填，也读不到提交结果，看到「提交成功」再关闭弹窗。
- 弹窗挂在 `document.body` 上，不参与大厅整页重绘，所以对局和设置里的重绘不会冲掉填到一半的内容。
- 换表单只改 `public/feedback-ui.js` 里的 `FEISHU_FORM_URL`。

---

## 架构

### 设计原则

1. **AI 实现在游戏外**：agent 的全部代码在 `lib/agent/`，游戏完全不知道 LLM 的存在。
2. **游戏只提供纯数据接口**：描述局面、说明行动格式、列出合法行动、校验、应用行动。

因此换模型只需改配置；新增桌游只需写一个 Mod，AI 能力自动生效。

```
public/ 网页大厅（原生 JS，无构建）
   │ REST /api
lib/server.js 大厅：会话、路由、应用行动
   ├── games/*      Mod：规则与给 AI 的接口
   └── lib/agent/   AI：配置、提示词、模型调用、解析、回合编排
                       └── LLM（OpenAI 兼容接口）
```

### 一次 AI 回合

```
组装提示词（人设 + 规则 + 当前局面 + 本回合进度）
  → 调用模型，解析 JSON { move, speech }
  → mod.validateMove() 校验        ← 解析失败或不合法：把错误反馈给模型，同一步内重试
  → mod.applyMove() 应用，判断是否还有下一步
```

- **回合内记忆**：同一个 AI 在一个回合里的多步决策共享一段对话历史，超出 `memorySteps` 的旧步骤会被剪掉并注明「已省略」。
- **确定性兜底**：重试用尽后，优先用 `mod.agentFallback()` 给出的落点（棋类通常由本地引擎算出）；没有该接口时，从 `mod.legalMoves()` 中按「对局种子 + 当前局面」选一个合法行动，同一局可复现。
- **引擎纠错**：`mod.refineMove()` 可以在模型给出「合法但会立刻输棋」的一手时改写落点（例如五子棋漏堵四连、井字棋漏挡三连），改写结果同样要过 `validateMove`。
- **失败不静默**：没有可用的合法行动或超出回合预算时，返回明确的 `AGENT_STALLED` 错误，而不是让对局卡住。

### 决策日志与指标

每次模型调用会追加一行到 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/decisions.jsonl`，记录模型、尝试次数、结果（`ok` / `parseError` / `validateError` / `fallback` 等）、耗时、token 用量和输出片段。

`GET /api/agent-stats` 返回聚合指标（非法率、兜底率、平均耗时等），`?reset=1` 清零计数。网页「⚙️ 设置 → 📊 AI 指标」可直接查看。

---

## 开发

### 目录结构

```
├── server.js                # 入口：加载 Mod、启动服务、打开浏览器
├── lib/
│   ├── agent/               # AI 架构：config / client / prompt / decoder / log / orchestrator
│   ├── mods.js              # Mod 加载器与接口契约（顶部注释是完整文档）
│   ├── updater.js / store.js  # 大厅自动更新 / 游戏商店（install.js 版本目录，signing.js 签名，delta.js 增量更新，zip.js 解压）
│   ├── ai.js                # AI 角色库
│   ├── server.js            # HTTP、REST API、会话
│   └── open.js              # 跨平台打开浏览器
├── games/                   # 每个桌游一个 Mod
├── public/                  # 大厅网页
├── relay/                   # 联机中转服务
├── tests/hall/              # 大厅通用回归（只依赖五子棋、井字棋和测试专用 Mod）
├── tests/fixtures/mods/     # 大厅测试专用 Mod，覆盖多人、私有信息、同时行动等能力，不随发布包分发
└── docs/                    # 设计与使用文档
```

### 新增一款桌游

在 `games/<id>/` 下放一个 `index.js`，默认导出一个对象：

```js
export default {
  id: 'gobang', name: '五子棋', players: [2, 2], seats: 2,
  cover: '...', coverEmoji: '⚫⚪', description: '...', tags: ['棋类'],
  render: { kind: 'board', size: 15, pieceStyle: 'stone' },
  settingsSpec: [], defaults: {},

  // 规则
  createState(settings, players) { /* -> state */ },
  validateMove(state, seat, move) { /* -> null 或错误字符串 */ },
  applyMove(state, seat, move) { /* -> 事件数组 */ },

  // 给 AI 的接口
  moveFormat: '{"x":0..14,"y":0..14}',
  describeState(state, seat) { /* -> 可读局面文本 */ },
  legalMoves(state, seat) { /* -> 合法行动数组 */ },
  moveToText(move) { /* -> "(x,y)" */ },
}
```

可选接口：`moveCost(state, seat, move)` 告诉兜底逻辑行动点成本（避免直接选「结束回合」）；`decisionSeed(session, seat, step)` 提供自定义兜底种子。

棋类 Mod 还可以声明「本地棋力」，让 AI 在模型不给力时也不会乱下（五子棋、井字棋即按此实现，见 `games/gobang/engine.js`）：

```js
agentHint: '判断顺序：先看成五点，再看必须封堵的四连……',  // 追加进 system prompt
agentCandidates(state, seat) { /* -> [{ move, note }]，提示词里的候选点 */ },
agentFallback(state, seat) { /* -> 模型失败/未配置时的兜底落点 */ },
refineMove(state, seat, move) { /* -> 必杀/必防时改写模型的落点 */ },
```

要通过游戏商店分发，在 Mod 根目录加一个 `boardgame-mod.json`（`id`、`version`、`hallApi` 等），格式与发布流程见 [自动更新与游戏商店](docs/updates.md#发布游戏)。

大厅不按游戏 ID 写分支。游戏专属界面（如图鉴、构筑、战役）由 Mod 自己提供，专属数据通过 `clientData` 下发，存档策略由 `sessionPolicy(state)` 声明。完整契约见 `lib/mods.js`；复杂 Mod 的完整示例见 [诡镇奇谈](games/arkhamhorror/README.md)。

### 测试

```bash
npm run test:hall           # 大厅核心回归（用本地假模型，不消耗付费额度）
npm run test:hall:browser   # 大厅浏览器回归（复用系统 Edge）
npm run test:mod -- <id> [脚本]  # 运行某个游戏自己的测试脚本，如 npm run test:mod -- arkhamhorror fast
npm test                    # 大厅 + 所有 Mod
```

大厅回归不依赖任何具体游戏：需要多人、私有手牌、同时行动、批量确认等能力时，用 `tests/fixtures/mods/` 下的测试专用 Mod；各游戏在大厅上的集成回归（如诡镇的联机测试）放在游戏自己的仓库里。诡镇奇谈的分层测试命令见 [诡镇 README](games/arkhamhorror/README.md#测试)，耗时与已知问题见 [测试说明](docs/testing.md)。

### REST API

<details>
<summary>展开接口列表</summary>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/catalog` | 桌游目录（含 AI 座位与各 Mod 的设置项） |
| GET | `/api/config` | 当前模型配置（不含密钥） |
| POST | `/api/config` | 保存模型配置到 `boardgame.config.json` |
| POST | `/api/config/test` | 测试模型连接 |
| POST | `/api/config/models` | 拉取模型列表 |
| GET | `/api/agent-stats` | AI 决策指标；`?reset=1` 清零 |
| GET | `/api/ais` | AI 角色列表 |
| POST | `/api/ais` | 新增或修改 AI（`{ ai }`） |
| POST | `/api/ais/delete` | 删除 AI（`{ id }`） |
| POST | `/api/start` | 开局（`{ modId, settings }`） |
| POST | `/api/move` | 玩家行动（`{ sessionId, move }`），随后执行 AI 回合 |
| POST | `/api/reset` | 用相同设置重开 |
| POST | `/api/leave` | 退出对局并删除存档 |
| POST | `/api/chat` | 战术讨论（`{ sessionId, text, to }`，`to=null` 为公开桌聊；文内可用 `@名字` / `@全体` 定向、`/备忘` 等指令） |
| POST | `/api/notes/add` / `update` / `delete` / `clear` | 管理战术备忘 |
| GET | `/api/updates` | 大厅更新与游戏商店状态（仅本机） |
| POST | `/api/updates/check` / `settings` / `hall/download` / `restart` | 检查更新、保存更新设置、下载大厅新版本、重启切换（仅本机） |
| POST | `/api/store/install` / `uninstall` | 安装、更新或卸载下载的游戏（`{ id }`，仅本机） |
| GET | `/api/sessions` | 已落盘的存档列表 |
| POST | `/api/session/delete` | 删除某局存档（`{ sessionId }`） |

</details>

### 限制

- 经典 Mod 是 1 名玩家对 1 名 AI；合作类 Mod 可加入 1~3 名 AI 队友。
- `/api/start` 和 `/api/move` 会同步等待 AI 回合完成，响应时间取决于模型速度；一个回合可能包含多次模型调用。
- 每个会话同一时刻只允许一个进行中的提交，并发请求返回 `SESSION_BUSY`。
- AI 角色保存在 `~/.dsh/boardgame-hall/ais.json`。
- 网页是原生 ES Module，无构建、无外部依赖，除模型调用外可离线运行。
