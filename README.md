# 桌游大厅（dsh-boardgame-hall）

本地运行的桌游大厅：启动后占用一个端口并自动打开浏览器，玩家在网页里配置 AI 角色，与 AI 对弈或合作。

- **每款桌游是一个独立 Mod**：放进 `games/` 就会被自动发现。
- **AI 是全 agent**：行动和台词都由大模型（LLM）产出，而不是规则脚本。
- **规则是硬边界**：模型给出的每个行动都必须通过 Mod 的合法性校验，非法行动会被打回重试。

内置游戏：

| Mod | 类型 | 说明 |
| --- | --- | --- |
| `games/gobang` | 双人对弈 | 五子棋，Mod 的参考实现 |
| `games/ox` | 双人对弈 | 井字棋 |
| `games/poker` | 四人组队 | 扑克合集（掼蛋），支持本地 AI 与多人混合席位 |
| `games/arkhamhorror` | 合作卡牌 | 诡镇奇谈：卡牌版，独立仓库按需克隆，见 [诡镇 README](games/arkhamhorror/README.md) |

---

## 快速开始

需要 Node.js 22.15+。

```bash
git clone https://github.com/Dr-Liao/boardgame-hall-ai.git
cd boardgame-hall-ai
git clone https://github.com/Dr-Liao/boardgame-arkhamhorror.git games/arkhamhorror  # 可选
npm install        # 同时安装大厅与 games/* 下各 Mod 的依赖
```

启动：Windows 双击 `start.bat`；Git Bash / WSL / macOS / Linux 用 `bash start.sh`；也可以直接 `npm start`。默认地址是 `http://127.0.0.1:8787`，可用环境变量 `BOARDGAME_PORT` 修改。退出直接按 `Ctrl+C`：大厅会自己关服退出，不会再出现「终止批处理操作吗(Y/N)?」的确认。

配置、AI 角色和存档默认在 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/`；设置 `DSH_HOME` 可以让多个实例互不干扰。

### 配置大模型

AI 通过 **OpenAI 兼容的 `/chat/completions` 接口**调用模型，支持 OpenAI、DeepSeek、Ollama 等。三种方式任选其一：

1. **大厅网页**：「⚙️ 设置 → AI → 模型连接」里填写 API 地址、密钥和模型，可测试连接、拉取模型列表，保存后写入 `boardgame.config.json`。
2. **配置文件**：复制 `boardgame.config.example.json` 为 `boardgame.config.json`，至少填写 `baseUrl`、`apiKey`、`model`。
3. **环境变量**：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 等，命名规则是把参数名改成大写下划线并加 `AI_` 前缀；优先级高于配置文件。

未配置 `apiKey` 时大厅仍可运行：AI 会按对局种子选一个合法行动兜底。

### 功能一览

- **AI 角色**：人设（persona）决定 AI 怎么行动、说什么话，内置《蔚蓝档案》5 位角色，可在设置中编辑，见 [角色设定](docs/ai-personas.md)。
- **合作与队友**：合作类 Mod 可选 0~3 名 AI 队友，座位文案与提示词由 Mod 定制。
- **战术交流**：对局左下角可公开桌聊或私聊 AI，`@名字` 定向回复，`/备忘` 记下长期约定并在之后每次决策时注入，见 [设计文档](docs/tactical-chat-design.md)。
- **多人联机**：创建房间后逐席选择玩家或 AI，把邀请码发给朋友即可加入；优先 WebRTC 直连，失败时走中转，见 [多人联机](docs/multiplayer.md)。
- **自动存档**：每次提交行动后整局落盘，重启或刷新回到上一局，默认保留 14 天。
- **自动更新与游戏商店**：大厅和每个游戏各自从 GitHub Release 更新，增量下载 + 签名校验，见 [自动更新与游戏商店](docs/updates.md)。
- **界面语言**：简体中文 / English 即时切换，各游戏用自己的语言包跟随，见 [本地化](docs/localization.md)。

---

## 结构

```
public/          网页大厅（原生 JS，无构建）
lib/server.js    大厅：HTTP、REST API、会话与应用行动
lib/agent/       AI：配置、提示词、模型调用、解析与回合编排
games/<id>/      每个桌游一个 Mod：规则 + 给 AI 的接口
relay/           多人联机中转服务
docs/            设计与使用文档
tests/           大厅回归（不依赖具体游戏）
```

设计上 AI 在游戏之外：agent 的全部代码在 `lib/agent/`，游戏不知道模型的存在；游戏只提供纯数据接口——描述局面、说明行动格式、列出合法行动、校验并应用行动。因此换模型只需改配置，新增桌游只需写一个 Mod。

一次 AI 回合：组装提示词 → 调用模型（输出行动与台词）→ `validateMove` 校验 → `applyMove` 应用。解析失败或行动不合法时把错误反馈给模型重试；重试用尽后按对局种子或 Mod 提供的兜底行动继续，不会让对局卡住。

新增游戏在 `games/<id>/` 提供 `index.js`（规则回调，以及 `describeState` / `legalMoves` / `moveToText` 等 AI 接口），完整契约见 `lib/mods.js`。大厅不按游戏 ID 写分支，游戏专属界面与数据由 Mod 自己提供。

---

## 测试与发布

```bash
npm run test:hall           # 大厅核心回归（本地假模型，不消耗付费额度）
npm run test:hall:browser   # 大厅浏览器回归（复用系统 Edge）
npm run test:mod -- <id> [脚本]   # 某个游戏自己的测试，如 npm run test:mod -- arkhamhorror fast
```

大厅回归不依赖任何具体游戏；耗时与已知问题见 [测试说明](docs/testing.md)。

发布大厅双击 `release.bat`，发布诡镇奇谈双击 `games/arkhamhorror/release.bat`，推送版本 tag 后由 GitHub Actions 构建、签名并发布。

免安装发布包内置 Node.js 和全部游戏，不携带存档、个人配置和密钥，运行数据放在包内 `user-data/`：Windows 用 `npm run build:windows`（默认端口 18787），macOS 用 `npm run build:mac`，产物输出到 `dist/`。Windows 首次运行的安全提示见 [Windows 的「未知发布者」提示](docs/windows-signing.md)。

---

## 限制

- 经典 Mod 是 1 名玩家对 1 名 AI；合作类 Mod 可加入 1~3 名 AI 队友。
- `/api/start` 和 `/api/move` 会同步等待 AI 回合完成，响应时间取决于模型速度。
- 每个会话同一时刻只允许一个进行中的提交，并发请求返回 `SESSION_BUSY`。
- 网页是原生 ES Module，无构建、无外部依赖，除模型调用外可离线运行。
