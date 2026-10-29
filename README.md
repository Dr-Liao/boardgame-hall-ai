# 桌游大厅（dsh-boardgame-hall）

本地运行的网页桌游大厅。每款游戏是独立 Mod；大厅负责席位、AI、聊天、存档、联机、更新和浏览器外壳，Mod 负责权威规则与专属界面。模型输出的动作必须经过 Mod 校验；模型不可用或连续失败时使用可复现的合法动作兜底。

内置五子棋、井字棋和扑克合集。《诡镇奇谈：卡牌版》由[独立游戏仓库](https://github.com/Dr-Liao/boardgame-arkhamhorror)提供，可按需克隆或从游戏中心安装。

## 快速开始

需要 Node.js 22.15+。

```bash
git clone https://github.com/Dr-Liao/boardgame-hall-ai.git
cd boardgame-hall-ai
git clone https://github.com/Dr-Liao/boardgame-arkhamhorror.git games/arkhamhorror  # 可选
npm install
npm start
```

Windows 也可双击 `start.bat`，其他平台可运行 `bash start.sh`。默认地址为 `http://127.0.0.1:8787`，`BOARDGAME_PORT` 可修改端口。配置、AI 角色和存档默认写入 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/`。

在「设置 → AI → 模型连接」中配置 OpenAI 兼容接口；也可使用 `boardgame.config.json` 或 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 等环境变量。没有 API key 时大厅仍可使用确定性兜底运行。

## 文档索引

### 使用与部署

- [多人房间、断线恢复与中转部署](docs/multiplayer.md)
- [自动更新、游戏商店、构建与发布](docs/updates.md)
- [测试入口、分层和生成物](docs/testing.md)
- [Windows 签名与未知发布者提示](docs/windows-signing.md)

### 架构与扩展

- [Mod 接口契约](docs/mod-api.md)
- [大厅与游戏本地化](docs/localization.md)
- [战术交流与备忘](docs/tactical-chat-design.md)
- [自动跳过与自动反应](docs/auto-pass.md)
- [快速反应卡口径](docs/quick-reaction-cards.md)
- [AI 角色设定](docs/ai-personas.md)
- [诡镇奇谈文档索引](https://github.com/Dr-Liao/boardgame-arkhamhorror#文档索引)

## 项目边界

```text
public/          大厅网页
lib/server.js    HTTP、会话、动作事务、存档与联机适配
lib/agent/       模型调用、提示词、重试与回合编排
games/<id>/      内置或开发中的游戏 Mod
relay/           联机中转服务
docs/            大厅文档
tests/           大厅契约回归
```

大厅不按游戏 ID 实现规则。一次动作统一经过 `legalMoves`、`validateMove` 和 `applyMove`；隐藏信息由 Mod 的观察投影按席位裁剪。新增游戏的稳定契约见 [Mod 接口契约](docs/mod-api.md)。

## 开发入口

```bash
npm run test:hall
npm run test:hall:browser
npm run test:mod -- <id> [脚本]
```

正式 Release 是只内置 `boardgame.liteGames` 的纯大厅包，其他游戏从游戏中心安装。本地 `npm run build:windows` / `npm run build:mac` 可以构建包含当前 `games/` 内容的完整版；发布、增量更新和目录结构以[更新文档](docs/updates.md)为准。

当前通用限制：动作请求会等待本轮 AI 结算；同一会话只允许一个进行中的提交，并发请求返回 `SESSION_BUSY`。
