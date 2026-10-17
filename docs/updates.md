# 自动更新与游戏商店

大厅和每个游戏各自通过 GitHub Release 发版。大厅定期检查两边的新版本，在「⚙️ 设置 → 🔄 更新与游戏」中一键更新大厅、安装或更新游戏。

```
GitHub
 ├── Dr-Liao/boardgame-hall-ai        Release：免安装包 + 程序包 + 运行时包 + update-manifest.json
 │                                    main 分支 registry/index.json：游戏商店里列出的游戏
 └── Dr-Liao/boardgame-arkhamhorror   Release：arkhamhorror-<版本>.zip + boardgame-mod.release.json
```

所有清单都用同一把 ed25519 私钥签名，大厅只接受 `lib/update-keys.json` 中登记的公钥；下载的包再按清单里的 sha256 校验。因此加速镜像只负责转发，即使被篡改也会被拒绝。

## 首次配置

1. **生成签名密钥**（只做一次）：

   ```bash
   npm run release:keygen
   ```

   公钥写入 `lib/update-keys.json`，需要提交到仓库。私钥写入 `.release-keys/`（已被 git 忽略）。

2. **把私钥存为 GitHub Secret**，大厅仓库和每个游戏仓库都要配置：

   ```bash
   gh secret set BOARDGAME_UPDATE_PRIVATE_KEY --repo Dr-Liao/boardgame-hall-ai < .release-keys/boardgame-update-<id>.pem
   gh secret set BOARDGAME_UPDATE_PRIVATE_KEY --repo Dr-Liao/boardgame-arkhamhorror < .release-keys/boardgame-update-<id>.pem
   ```

   之后把私钥备份到安全的地方，再从本机删除。私钥丢失后，只能生成新密钥并发布一个同时带新旧公钥的大厅版本。

3. **私有仓库的额外 Secret**：如果诡镇仓库是私有的，在大厅仓库配置 `SUBMODULE_TOKEN`（能读取诡镇仓库的 token）。如果大厅仓库是私有的，在游戏仓库配置 `HALL_REPO_TOKEN`。另外要注意，玩家下载 Release 资源要求仓库公开。

4. **游戏目录**是大厅仓库的 `registry/index.json`，大厅从 `main` 分支的 raw 地址读取。新增或下架游戏时，只要修改这个文件并推送到 `main`，不需要发布大厅新版本：

   ```json
   {
     "schema": 1,
     "games": [
       { "id": "arkhamhorror", "repo": "Dr-Liao/boardgame-arkhamhorror", "name": "诡镇奇谈：卡牌版", "description": "合作卡牌，1~4 人", "coverEmoji": "🐙" }
     ]
   }
   ```

   目录地址和大厅发布仓库都写在根 `package.json` 的 `boardgame` 字段中，打包时会一并写进发布包。已经分发出去的包会一直读这个地址，所以不要移动或重命名这个文件。

## 发布大厅

1. 修改根 `package.json` 的 `version`（格式 `x.y.z`）并提交。
2. 打 tag 并推送，tag 中的说明文字会作为更新说明显示在大厅里：

   ```bash
   git tag -a v1.1.0 -m "新增游戏商店；修复联机重连"
   git push origin v1.1.0
   ```

3. `.github/workflows/release.yml` 会自动完成以下步骤：
   - 在 Windows 和 macOS 上构建免安装包；
   - 用 `tools/release/pack-update.mjs` 拆出程序包和各平台运行时包；
   - 用 `tools/release/make-manifest.mjs` 生成并签名 `update-manifest.json`；
   - 发布 GitHub Release。

发布的文件：

| 文件 | 用途 |
| --- | --- |
| `BoardgameHall-<平台>-<版本>.zip` | 完整免安装包，首次安装时下载 |
| `BoardgameHall-app-<版本>.zip` | 程序包（平台无关，顶层目录 `app-<版本>/`）。增量更新按需从中分段读取，退回整包时才完整下载 |
| `BoardgameHall-app-<版本>.files.json` | 程序包的文件索引，用于增量更新 |
| `BoardgameHall-runtime-<平台>-<Node 版本>.zip` | 运行时包，只在 Node 版本变化时下载 |
| `update-manifest.json` | 签名清单 |

注意：引入自动更新的第一个版本需要玩家手动下载完整包，因为旧启动器还不支持版本切换。此后的版本都可以自动更新。

### 增量更新

发布脚本为每个程序包和游戏包生成文件索引 `<包名>.files.json`，记录每个文件的 sha256，以及它的压缩数据在 ZIP 中的位置。签名清单记录索引的 sha256，索引又记录所属 ZIP 的 sha256，所以信任链和整包下载一样。

更新时，大厅先把本地旧版本中哈希一致的文件硬链接（跨盘时复制）到新版本目录，再用 HTTP Range 从 Release 上的 ZIP 里只取变化的文件，每个文件写入前都会按索引校验 sha256。例如只改了几个脚本时，227 MB 的程序包只需下载几十 KB。

以下情况会自动退回下载完整 ZIP：

- 没有可复用的旧版本，例如首次安装游戏；
- 变化的数据超过整包的 60%；
- 服务器或镜像不支持 Range；
- 增量过程中任意文件校验失败。

旧发布没有索引时同样整包下载。实现见 `lib/delta.js`。

## 发布游戏

游戏仓库根目录需要一个 `boardgame-mod.json`：

```json
{
  "id": "arkhamhorror",
  "name": "诡镇奇谈：卡牌版",
  "version": "1.0.0",
  "hallApi": 1,
  "exclude": ["tests/", "tools/", "docs/", "*.md"],
  "prepack": "tools/prepack-release.mjs",
  "preserve": ["web/img/"]
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | 发布版本，必须与 tag 一致。这是游戏商店使用的唯一版本号 |
| `hallApi` | 依赖的 Mod 接口版本（`lib/version.js` 的 `HALL_API`）。大厅只加载自己支持范围内的游戏 |
| `exclude` | 不打包的路径前缀或扩展名。`.git`、`.github`、`node_modules` 总是排除 |
| `prepack` | 可选。打包前运行 `node <脚本> <暂存目录>`，用来改写暂存内容 |
| `preserve` | 运行时生成、更新时要从旧版本带过来的文件（例如卡图缓存） |

游戏包里不能有运行时 npm 依赖，因为玩家的机器上不会执行 `npm install`。

发布方式与大厅相同：修改 `boardgame-mod.json` 的 `version`，然后打 tag 并推送。仓库里的 `.github/workflows/release.yml` 会签出大厅仓库，调用 `tools/release/pack-mod.mjs` 打包并签名，最后发布 Release。发布产物包括 `<id>-<版本>.zip`、增量更新用的 `<id>-<版本>.files.json` 和 `boardgame-mod.release.json`。玩家已有该游戏的旧版本（包括大厅内置的版本）时，只下载变化的文件。

`hallApi` 高于玩家大厅支持版本的游戏不会被安装，界面会提示「需要先更新大厅」。修改 Mod 接口契约时，先发布支持新 `hallApi` 的大厅，再发布依赖它的游戏。

## 玩家端的行为

### 免安装包目录结构

```
桌游大厅.exe / 桌游大厅.command
current.ini            当前使用的版本，以及回滚用的上一版本
app-<版本>/            大厅程序
runtime-<Node 版本>/   Node.js 运行时
user-data/             存档、配置、AI 角色和下载的游戏，所有版本共用
edition.json           仅纯大厅版有：列出内置的游戏
```

纯大厅版由 `build-windows-hall.bat`（`build-windows.ps1 -HallOnly`）构建，只内置五子棋和井字棋。它和完整版使用同一份程序包更新，但更新时会按 `edition.json` 跳过其他内置游戏，所以始终保持精简。诡镇等游戏可从游戏商店安装。`pack-update.mjs --app` 会拒绝用纯大厅版生成共用的程序包。

### 大厅更新流程

1. 新版本准备到 `app-<新版本>/`：未变化的文件从当前版本复用，变化的文件增量下载。然后改写 `current.ini`，并标记为试运行（`trial=1`）。
2. 玩家点击「重启大厅」后，进程以退出码 75 退出，启动器按新指针重新启动。
3. 新版本成功监听端口后去掉试运行标记，并清理更早的版本。
4. 如果新版本在试运行期间异常退出，启动器会回滚到上一版本，把该版本记入 `failed`，并在界面上提示。

### 游戏更新与卸载

- **安装位置**：下载的游戏放在 `user-data/boardgame-hall/mods/<id>/<版本>/`。开发版放在 `~/.dsh/boardgame-hall/mods/`。
- **新游戏**：安装后立即出现在大厅里。
- **已加载游戏的新版本**：需要重启大厅才生效，以免内存中的对局混用新旧两套规则。
- **版本选择**：内置版本和下载版本同时存在时，取版本号较高的那个；版本号相同时使用内置版本。
- **卸载**：只能卸载下载的版本。如果该游戏正在使用，卸载会在下次启动时执行。

### 运行模式

| 模式 | 条件 | 能做什么 |
| --- | --- | --- |
| `portable` | 新版免安装包 | 可下载并切换大厅版本 |
| `manual` | 旧版免安装包等环境 | 只提示去发布页下载 |
| `dev` | git 仓库 | 只提示运行 `git pull && git submodule update --init` |

游戏商店在所有模式下都可以使用。

### 设置与环境变量

- **GitHub 加速镜像**：在设置页填写一个以 `https://` 开头、以 `/` 结尾的前缀。直连失败时，大厅会改用「前缀 + 原地址」重试。
- **`BOARDGAME_UPDATE_CHECK=0`**：关闭自动检查。
- **`BOARDGAME_GITHUB_BASE`**：替换 `https://github.com`，用于测试或使用自建的 Gitea 镜像。

## 本地验证

```bash
node --test tests/hall/updates.test.mjs
```

测试内容：

- ZIP 读写和路径安全；
- 签名清单的校验；
- `current.ini` 的读写、清理和资源合并；
- 通过本地伪 GitHub 完成大厅更新与游戏安装；
- 编译真实的 Windows 启动器（需要 .NET Framework C# 编译器），以及用 bash 运行 macOS 启动脚本，验证重启、回滚和版本选择。
