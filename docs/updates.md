# 自动更新与游戏商店

大厅和每个游戏各自通过 GitHub Release 发版。大厅定期检查两边的新版本，在「⚙️ 设置 → 大厅更新」中一键更新大厅，在大厅的「🎮 游戏中心」中安装或更新游戏。

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

3. **私有仓库的额外 Secret**：如果大厅仓库是私有的，在游戏仓库配置 `HALL_REPO_TOKEN`（能读取大厅仓库的 token），游戏发布时要用大厅仓库里的打包脚本。大厅发布不签出游戏仓库，不需要额外 token。另外要注意，玩家下载 Release 资源要求仓库公开。

4. **游戏目录**是大厅仓库的 `registry/index.json`，大厅从 `main` 分支的 raw 地址读取。新增或下架游戏时，只要修改这个文件并推送到 `main`，不需要发布大厅新版本：

   ```json
   {
     "schema": 1,
     "games": [
       {
         "id": "arkhamhorror",
         "repo": "Dr-Liao/boardgame-arkhamhorror",
         "name": "诡镇奇谈：卡牌版",
         "description": "合作卡牌，1~4 人",
         "coverEmoji": "🐙",
         "localized": {
           "en": {
             "name": "Arkham Horror: The Card Game",
             "description": "Cooperative card game for 1–4 players"
           }
         }
       }
     ]
   }
   ```

   `localized` 是可选字段：游戏**尚未安装**时，大厅按当前语言从这里取商店展示文案；已安装的游戏以 Mod 自己的 `i18n` 为准（见 [本地化方案](localization.md) 的「游戏商店」一节）。key 必须是合法 locale（用 `lib/i18n.js` 的 `normalizeLocale()` 规范化，如 `en`），值只允许 `name` / `description` 两个非空字符串；非法条目会被 `lib/store.js` 忽略并回退基础中文文案。旧目录、旧客户端、旧大厅都能继续按基础 `name` / `description` 工作，不需要等大厅发版，推 `main` 即生效。

   目录地址和大厅发布仓库都写在根 `package.json` 的 `boardgame` 字段中，打包时会一并写进发布包。已经分发出去的包会一直读这个地址，所以不要移动或重命名这个文件。

5. **Cloudflare R2 镜像（可选，国内优先）**：大厅按 CDN → GitHub → 用户填的加速镜像的顺序取文件，内容验签或校验不通过时换下一个来源，所以 CDN 上缺文件或内容过期都不会出错。R2 支持 Range，增量更新的分段下载同样优先走 CDN。

   两个仓库共用存储桶 `boardgame`，各占一个目录（大厅 `hall/`，诡镇 `arkhamhorror/`），目录下的路径与 GitHub 一一对应：

   ```
   hall/releases/download/<tag>/<文件>
   hall/releases/latest/download/update-manifest.json
   hall/raw/main/registry/index.json
   arkhamhorror/releases/download/<tag>/<文件>
   arkhamhorror/releases/latest/download/boardgame-mod.release.json
   ```

   1. 在 Cloudflare 控制台的 R2 存储桶「设置 → 自定义域」绑定一个托管在 Cloudflare 上的域名（当前为 `drliao1.com`）。不要用 `r2.dev` 公开地址，它有限速，只适合测试。
   2. 在「R2 → 管理 API 令牌」创建一个对该存储桶有「对象读和写」权限的令牌，记下 Access Key ID、Secret Access Key 和账户 ID，在两个 GitHub 仓库里都配置：

      ```bash
      for repo in Dr-Liao/boardgame-hall-ai Dr-Liao/boardgame-arkhamhorror; do
        gh variable set R2_BUCKET --repo $repo --body "boardgame"
        gh variable set R2_ACCOUNT_ID --repo $repo --body "<账户 ID>"
        gh secret set R2_ACCESS_KEY_ID --repo $repo
        gh secret set R2_SECRET_ACCESS_KEY --repo $repo
      done
      ```

      之后每次发版，workflow 会在 GitHub Release 之后用 `tools/release/r2.mjs` 把附件上传到 R2（清单最后上传，并另存一份到 `releases/latest/download/`）。`registry/index.json` 推送到 `main` 时由 `sync-r2.yml` 同步到 R2。带版本号的文件缓存一年，清单和游戏目录缓存 5 分钟。
   3. 告诉大厅各仓库的 CDN 目录地址（以 `https://` 开头、以 `/` 结尾）：根 `package.json` 的 `boardgame.cdn` 用于大厅自身和游戏目录，`registry/index.json` 里每个游戏加 `cdn` 字段：

      ```json
      "boardgame": { "repo": "Dr-Liao/boardgame-hall-ai", "cdn": "https://dl.example.com/hall/", ... }
      ```

      ```json
      { "id": "arkhamhorror", "repo": "Dr-Liao/boardgame-arkhamhorror", "cdn": "https://dl.example.com/arkhamhorror/", ... }
      ```

      `boardgame.cdn` 随大厅版本发布，已经分发的旧包不会读取它；游戏的 `cdn` 字段改目录即可生效。
   4. 首次启用前，可以手动把现有的最新 Release 补到 R2：先 `gh release download <tag> --repo Dr-Liao/boardgame-arkhamhorror -D dist/r2`，再设置 `R2_*` 四个环境变量，运行 `node tools/release/r2.mjs release dist/r2 --dir=arkhamhorror --tag=<tag>`。大厅用 `--dir=hall`；游戏目录用 `node tools/release/r2.mjs file registry/index.json --dir=hall --path=registry/index.json`。`node tools/release/r2.mjs list --prefix=arkhamhorror/` 可以核对已上传的文件。

## 发布大厅

1. 双击根目录的 `release.bat`（也可以 `release.bat 1.1.0 "更新说明"`）：它只处理大厅仓库，检查工作区干净且与 `origin/main` 同步，更新根 `package.json` 和 `package-lock.json` 的版本号，提交 `chore: release v1.1.0`、打 tag 并推送。诡镇奇谈的版本号不会被改动。
2. 手动发版等价于修改根 `package.json` 的 `version`（格式 `x.y.z`）并提交，然后打 tag 并推送，tag 中的说明文字会作为更新说明显示在大厅里：

   ```bash
   git tag -a v1.1.0 -m "新增游戏商店；修复联机重连"
   git push origin v1.1.0
   ```

3. `.github/workflows/release.yml` 会自动完成以下步骤：
   - 在 Windows 和 macOS 上构建**纯大厅**免安装包，只内置根 `package.json` 的 `boardgame.liteGames` 列出的游戏（目前为五子棋、井字棋、扑克合集）。诡镇等游戏不随大厅发布，玩家从游戏商店安装；
   - 编译 Windows 启动器；配置了 `BOARDGAME_SIGN_THUMBPRINT` / `BOARDGAME_SIGN_PFX` / `BOARDGAME_SIGN_COMMAND` 时会给 `桌游大厅.exe` 做代码签名（见 [Windows 的「未知发布者」提示](windows-signing.md)）；
   - 用 `tools/release/pack-update.mjs` 拆出程序包和各平台运行时包。程序包也来自纯大厅版，只有几百 KB；
   - 用 `tools/release/make-manifest.mjs` 生成并签名 `update-manifest.json`；
   - 发布 GitHub Release。

发布的文件：

| 文件 | 用途 |
| --- | --- |
| `BoardgameHall-<平台>-<版本>.zip` | 纯大厅免安装包（`win32-x64`、`darwin-arm64`、`darwin-x64`），首次安装时下载 |
| `BoardgameHall-app-<版本>.zip` | 程序包（平台无关，顶层目录 `app-<版本>/`）。增量更新按需从中分段读取，退回整包时才完整下载 |
| `BoardgameHall-app-<版本>.files.json` | 程序包的文件索引，用于增量更新 |
| `BoardgameHall-runtime-<平台>-<Node 版本>.zip` | 运行时包，只在 Node 版本变化时下载 |
| `update-manifest.json` | 签名清单（含程序包、运行时与纯大厅版内置游戏清单 `liteGames`） |

注意：引入自动更新的第一个版本需要玩家手动下载完整包，因为旧启动器还不支持版本切换。此后的版本都可以自动更新。

**「未知发布者」提示**：免安装包里的 `桌游大厅.exe` 由 `tools/build-windows.ps1` 用 .NET Framework 的 csc 编译，没有证书时是未签名程序。从网上下载的包首次运行会弹「打开文件 - 安全警告」并显示「未知发布者」。本机运行先解除文件锁定即可；对外发布建议给 EXE 签名，证书选择、构建参数和 CI 接法见 [Windows 的「未知发布者」提示](windows-signing.md)。

### 增量更新

发布脚本为每个程序包和游戏包生成文件索引 `<包名>.files.json`，记录每个文件的 sha256，以及它的压缩数据在 ZIP 中的位置。签名清单记录索引的 sha256，索引又记录所属 ZIP 的 sha256，所以信任链和整包下载一样。

更新时，大厅先把本地旧版本中哈希一致的文件硬链接（跨盘时复制）到新版本目录，再用 HTTP Range 从 Release 上的 ZIP 里只取变化的文件，每个文件写入前都会按索引校验 sha256。例如只改了几个脚本时，211 MB 的诡镇游戏包只需下载几 KB。

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

**游戏语言包**：游戏自带的界面语言包放在 `web/locales/`（如 `web/locales/zh-CN.js`、`web/locales/en.js`），随现有 `web/` 目录一起打包、挂载到 `/mods/<id>/`。语言包是 ES module（`export default` 扁平对象），由 Mod 前端自行 `import()`；大厅只负责把 `index.js` 的 `web.locales` 生成绝对 URL，通过 catalog 的 `i18n.files` 交给 Mod（见 [本地化方案](localization.md) §8.2 / §12）。注意：

- `boardgame-mod.json` 的 `exclude` 不要误排除 `web/locales/`；语言包不需要写进 `preserve`（不是运行时生成的文件）。
- 不要把语言包放到 `games/<id>/locales/` 或仓库根目录，否则 `/mods/<id>/` 挂载与本文件的 `exclude` 规则都要改。
- 目录/开局表单的元数据翻译写在 `index.js` 的 `i18n.messages` 里，和界面语言包分开维护；没有前端语言包的语言也可以先只声明 `messages`（此时游戏界面仍是默认语言，见 [本地化方案](localization.md) 的「Mod 契约」一节）。

发布方式和大厅一样（打 tag 触发 CI）。诡镇仓库克隆在 `games/arkhamhorror` 时，可运行其中的 `release.bat`：它会检查**诡镇仓库**工作区干净且与自己的 `origin/main` 同步，只更新该仓库的 `package.json` 和 `boardgame-mod.json`，提交、打 tag 并推送，不改大厅版本。也可以手动修改 `boardgame-mod.json` 的 `version` 后打 tag。诡镇是被大厅忽略的独立 checkout，不是 git submodule；发布游戏后大厅仓库无需提交。诡镇的 `.github/workflows/release.yml` 会签出大厅仓库，调用 `tools/release/pack-mod.mjs` 打包并签名。产物包括 `<id>-<版本>.zip`、增量更新索引 `<id>-<版本>.files.json` 和 `boardgame-mod.release.json`。

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

正式发布的是纯大厅版：Windows 用 `build-windows-hall.bat` 或 `npm run build:windows:hall` 构建，macOS 用 `npm run build:mac:hall`。它只内置根 `package.json` 的 `boardgame.liteGames` 列出的游戏（目前为五子棋、井字棋、扑克合集），诡镇等游戏从游戏商店安装。更新时按签名清单里的 `liteGames` 只下载内置游戏；更新成功后大厅会把这份新清单写回 `edition.json`，所以后来新增进 `liteGames` 的游戏会在下一次更新时一起装上（旧版本遗留的 `edition.json` 不会再把它们过滤掉）。本地自行构建、内置了诡镇的完整版没有 `edition.json`，从 Release 更新时不会带上内置的诡镇，需要从商店重新安装（存档不受影响）。

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
| `dev` | git 仓库 | 只提示运行 `git pull`（诡镇在 `games/arkhamhorror` 里单独 `git pull`） |

游戏商店在所有模式下都可以使用。

### 设置与环境变量

- **GitHub 加速镜像**：在设置页填写一个以 `https://` 开头、以 `/` 结尾的前缀。CDN 与 GitHub 直连都失败时，大厅会改用「前缀 + 原地址」重试。
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
