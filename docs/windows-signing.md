# Windows 的「未知发布者」提示

双击 `桌游大厅.exe`（或 `start.bat`）时，Windows 可能先弹出一个安全提示：

- **打开文件 - 安全警告**：「发布者: 未知发布者」，按钮是「运行 / 取消」；
- **Windows 已保护你的电脑**：SmartScreen，蓝色窗口，要点「更多信息 → 仍要运行」；
- **用户账户控制（UAC）**：黄色窗口，问是否允许程序更改设备。

这三种提示检查的东西不一样，但原因相同：**从网上下载的文件会被打上 Mark of the Web 标记**（NTFS 备用数据流 `Zone.Identifier`），Windows 在运行前要先确认发布者身份。程序没有代码签名、或签名证书不受信任时，发布者一栏就只能写「未知发布者」。这是文件来源检查，不是病毒检测结果。

| 提示 | 触发条件 | 有受信任签名后 |
| --- | --- | --- |
| 打开文件 - 安全警告 | 文件带 Mark of the Web，扩展名在风险名单里（`.exe`、`.bat`、`.cmd`、`.msi` 等） | 系统能验证发布者，不再提示「未知发布者」 |
| SmartScreen | 下载量/发布者声誉不足 | 显示发布者名称；新文件仍可能先被拦一次，声誉靠下载量积累 |
| UAC | 程序要求管理员权限 | 窗口由黄色变成灰色，并显示已验证的发布者；本项目的启动器不要求管理员权限，正常不会弹 |

判断依据：右键文件 → 属性 → 「数字签名」页；没有这一页就是未签名。命令行里用 `Get-AuthenticodeSignature`（见文末）。

## 一、只在自己电脑上运行：解除锁定

不需要买证书。把文件上的 Mark of the Web 去掉即可，一次操作永久生效：

1. **还没解压**：右键下载的 ZIP → 属性 → 常规页底部勾选「解除锁定」→ 确定，然后再解压。这样解压出来的文件都不会带标记。
2. **已经解压**：右键 `桌游大厅.exe` → 属性 → 勾选「解除锁定」→ 确定。
3. **批量处理**（整个发布文件夹）：

   ```powershell
   Get-ChildItem -LiteralPath 'D:\BoardgameHall-Lite-Windows-x64-20260101-120000' -Recurse -File | Unblock-File
   ```

几点说明：

- 只有在**别处构建后下载下来**的包才有这个标记。本机 `npm run build:windows` 直接产出的 EXE 不会被标记，运行不会有提示。
- 文件放在**网络共享**（`\\服务器\共享\...`）上时也会提示，因为来自 Intranet 区域。把共享映射成驱动器或复制到本地再运行即可；企业环境可由管理员把服务器名加入「本地 Intranet」站点。
- 弹窗上的「打开此文件前总是询问」取消勾选也能少点一次，但只对该文件有效。
- **不要**为了省事全局关闭 SmartScreen 或 UAC。那会让所有后续下载的程序都失去这层检查，和这个问题本身无关。

## 二、发布给别人：给 EXE 做代码签名

「未知发布者」能从根上消除的唯一办法，是给 `桌游大厅.exe` 加 Authenticode 签名，并且证书由 Windows 信任的公共 CA 签发。自签名证书只对装过该证书的电脑有效，分发给别人时仍会显示未知发布者。

### 证书怎么选

| 方案 | 费用 | 适合 | 说明 |
| --- | --- | --- | --- |
| Azure Artifact Signing（原 Trusted Signing） | 约 $9.99/月 + 按签名次数 | 有 Azure 付费订阅、走 CI 的项目 | 无需硬件令牌，签名在微软云端完成，官方推荐给非商店分发的 Windows 应用。组织限美国/加拿大/欧盟/英国，**个人开发者目前仅限美国/加拿大** |
| Certum 开源代码签名证书 | €329/年；GitHub 上 1k star 以上的开源项目可申请免费证书 | 开源项目 | 云签名 SimplySign，无 USB 令牌；国内有代理，免费证书要求申请人有中国国籍且项目至少有一个 Release |
| 普通 OV 代码签名证书（DigiCert、Sectigo、SSL.com、Certum 等） | 约 $200–500/年 | 个人或小团队 | 需要实名/单位审核。**2023-06 起 CA/B 规则要求私钥存放在硬件或云 HSM**，新证书不再发放 PFX，通常配 USB 令牌或厂商云签名工具 |
| EV 代码签名证书 | 更贵 | 需要更严格的单位审核 | 微软已明确 EV 不再是绕过 SmartScreen 的捷径，不要只为消除提示买 EV |

### 不花钱的路线

| 路线 | 花费 | 发布者显示 | 限制 |
| --- | --- | --- | --- |
| 从 Steam / Microsoft Store / itch.io 桌面客户端分发 | 0 | 不显示（根本不触发提示） | 只对通过该渠道安装的那份副本有效；同一份 EXE 放到浏览器下载就又会提示 |
| [SignPath Foundation](https://signpath.org/)（开源项目免费签名） | 0 | **SignPath Foundation**，不是你 | 仅 OSI 许可的开源项目，且要求项目已发布、有文档、有可验证的声誉；还要在项目首页写 Code signing policy、设 Authors / Reviewers / Approvers 角色、全员 MFA、每次发版人工批准、强制填写产品名和版本元数据 |
| Certum 开源代码签名证书 | GitHub 上 1k star 以上的项目可免费；否则约 €329/年 | 你的名字 | 免费名额要求项目托管在 GitHub、至少有一个 Release、申请人中国国籍；用于商业发布会被吊销 |
| SSL.com 个人验证（IV）证书 | 约 $65/年 + 云签名订阅 | 你的名字 | 不需要公司，个人身份证件验证即可；云 HSM 签名，要额外订阅 |
| 自签名证书 | 0 | 你（只在装过该证书的电脑上） | 分发出去仍然是未知发布者；只适合自己电脑或公司内统一部署 |
| 不签名，随包附「解除锁定」说明 | 0 | 未知发布者 | 每个用户都要手动解除一次（`使用说明.txt` 里已经自动写上） |

公共 CA 不会给闭源软件发免费证书：签名证书必须签发给经过身份核验的法律主体，这是 CA/B 规则，不是厂商想多收钱。所以对闭源、非商店分发的软件，「免费」只有上面这些变通。

### Steam 等分发渠道

**Steam 不要求代码签名**，上架审核也不看签名。Steam 客户端自己下载、安装、启动游戏，文件不带 Mark of the Web，SmartScreen 根本不会检查——所以大量未签名的独立游戏在 Steam 上不出现「未知发布者」。Steam 本身的成本是每款 $100 的上架费（达到收入门槛可回收），和签名无关。

但它只保护**通过 Steam 安装的那一份**：

- 你在官网或网盘放的同一个 EXE，玩家用浏览器下载后运行，照样提示；
- 游戏自己下载并执行的外部启动器、更新器也可能被标记；
- Windows 11 的 Smart App Control（全新安装时可能默认开启）不看文件来源，未签名且微软不认识的程序可能被直接拦下——这和「未知发布者」是两件事。

结论：只通过 Steam 分发，可以不买证书；还想让官网直下的包也干净，或者担心 Smart App Control，再考虑签名。

签名方式确定后，`tools/windows/sign-release.ps1` 支持三种调用入口，构建脚本会在编译 EXE 之后自动调用它，并把签名信息写进 `build-manifest.json`：

```powershell
# 1) 证书在证书存储里（SimplySign 登录后、或 USB 令牌插入后，指纹用 certmgr.msc 查看）
$env:BOARDGAME_SIGN_THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567'
npm run build:windows:hall

# 2) PFX 文件（只适用于 2023 年之前签发的旧证书）
#    密码建议放环境变量，避免留在命令历史和进程列表里
$env:BOARDGAME_SIGN_PFX = 'C:\keys\codesign.pfx'
$env:BOARDGAME_SIGN_PFX_PASSWORD = '密码'
npm run build:windows:hall

# 3) 云签名工具：把命令模板放进环境变量，{file} 会替换成带引号的 EXE 路径（命令以服务商文档为准）
$env:BOARDGAME_SIGN_COMMAND = 'artifact-signing-cli -e https://xxx.codesigning.azure.net -a 账户 -c 证书配置 "{file}"'
npm run build:windows:hall

# 发布流水线：没配置证书或签名失败就直接让构建失败
npm run build:windows:hall -- -RequireSignature
```

签名使用的是 SHA-256 摘要加 RFC 3161 时间戳（默认 `http://timestamp.digicert.com`，可用 `-TimestampUrl` 或 `BOARDGAME_SIGN_TIMESTAMP_URL` 换），这样证书到期后已发布的旧版本仍然有效。时间戳服务走不通时脚本会留下警告，请检查代理。

需要给已经构建好的目录补签名时（`桌游大厅.exe` 已经编译完成）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows/sign-release.ps1 `
  -Path "dist\BoardgameHall-Lite-Windows-x64-20260101-120000\桌游大厅.exe" `
  -Thumbprint 0123456789ABCDEF0123456789ABCDEF01234567
```

补签之后要**重新生成 ZIP**：签名改动了 EXE 的字节，旧 ZIP 里的 EXE 还是未签名版本。用构建脚本构建时签名在打包之前，不需要手动处理。

### GitHub Actions

`release.yml` 在 `windows-latest` 上构建，签名命令通过环境变量注入即可（把它放在仓库 Secret 或 Variable 里，不要写进仓库）：

```yaml
      - name: Build hall-only portable package
        env:
          BOARDGAME_SIGN_COMMAND: ${{ secrets.WINDOWS_SIGN_COMMAND }}
          # 或者证书已经装进运行器的证书存储时：
          # BOARDGAME_SIGN_THUMBPRINT: ${{ secrets.WINDOWS_SIGN_THUMBPRINT }}
        run: powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-windows.ps1 -HallOnly
```

`release.yml` 里已经留好了这两个环境变量，没配置时是空字符串，构建照常产出未签名包。想让发布在没签名时直接失败，就再加 `-RequireSignature`。

GitHub 托管的运行器是全新的 Windows，没有 USB 令牌，SimplySign 也需要交互登录，所以 CI 里通常选 Azure Artifact Signing 这类云签名工具，用服务商提供的 CLI 或 Action。具体参数以服务商文档为准。

### 验证签名

```powershell
Get-AuthenticodeSignature -LiteralPath '.\桌游大厅.exe' | Format-List Status, SignerCertificate, TimeStamperCertificate
signtool verify /pa /v '.\桌游大厅.exe'
```

`Status` 为 `Valid`、`SignerCertificate.Subject` 是你的名称、`TimeStamperCertificate` 不为空，才说明签名可用于发布。也可以右键 EXE → 属性 →「数字签名」查看。

## 三、签名之后仍可能出现的提示

- **SmartScreen（Windows 已保护你的电脑）**：它按下载量和发布者声誉判断，不看签名合格与否。新签名的文件仍可能被拦一次，点「更多信息 → 仍要运行」；使用同一张证书持续发布，声誉会逐步积累。微软没有提供人工提交审核的入口。
- **Smart App Control（Windows 11 全新安装默认开启）**：只放行微软已知良好的程序或受信任证书签名的程序。自签名程序和未签名程序一样会被拦。
- **企业组策略**：有的公司环境会直接禁用「仍要运行」，这种情况只能由管理员放行。
- **杀毒软件误报**：和「未知发布者」无关，但新编译的启动器偶尔会被启发式引擎拦下，需要向厂商反馈或在发布页说明。

## 四、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 签名后仍显示未知发布者 | 签名之后又改动了文件（替换资源、重新打包、改配置）；或证书链缺中间证书；或用了自签名证书；或证书已过期且签名没带时间戳 |
| `signtool.exe` 找不到 | 安装 Windows SDK 的「Signing Tools for Desktop Apps」。脚本会先查 `PATH`，再找 `C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\signtool.exe` |
| 时间戳失败 | 代理拦住了时间戳服务；换一个地址：`-TimestampUrl http://timestamp.sectigo.com`，或设置 `BOARDGAME_SIGN_TIMESTAMP_URL` |
| SimplySign 找不到证书 | 先登录 SimplySign Desktop，手机 APP 确认后再运行；证书出现在「当前用户 → 个人」存储 |
| 买的证书只给了 PFX | 2023-06 之后按 CA/B 规则不应再发 PFX，这种多半是旧库存，续期时无法沿用；发布流程建议改用云签名 |

参考：[Microsoft：Attachment Manager 与「未知发布者」安全警告](https://learn.microsoft.com/en-us/archive/blogs/askie/how-to-bypass-the-security-warning-unknown-publisher-with-the-checkbox-always-ask-before-opening-this-file)、[四种「未知发布者」提示的区别](https://my-ssl.com/learn/unknown-publisher-warning)、[Steam 为什么不会有 SmartScreen 提示、独立游戏证书成本](https://assethoard.com/blog/windows-protected-your-pc-indie-game)、[SignPath Foundation 开源签名条件](https://signpath.org/terms.html)、[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/)。

## 相关命令

```powershell
# 查看文件是否带 Mark of the Web（有输出就是被标记了）
Get-Item '.\桌游大厅.exe' -Stream Zone.Identifier -ErrorAction SilentlyContinue

# 解除锁定
Unblock-File -LiteralPath '.\桌游大厅.exe'

# 查看签名状态
(Get-AuthenticodeSignature -LiteralPath '.\桌游大厅.exe').Status
```
