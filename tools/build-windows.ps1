param([switch]$SkipZip, [switch]$SkipAssets, [switch]$AssetsOnly, [switch]$HallOnly)
$ErrorActionPreference = 'Stop'
if ($SkipAssets -and $AssetsOnly) { throw 'SkipAssets 与 AssetsOnly 不能同时使用。' }
if ($HallOnly -and $AssetsOnly) { throw 'HallOnly 与 AssetsOnly 不能同时使用。' }
$buildLogic = !$AssetsOnly
$buildAssets = !$SkipAssets -and !$HallOnly
$projectRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# 逻辑包：可独立运行，不含诡镇奇谈卡牌图片。资源包：只含卡牌图片，解压覆盖到逻辑包目录即可启用本地卡图。
# 纯大厅版（-HallOnly）：只内置 $bundledGames，其他游戏从游戏商店安装；edition.json 让自动更新也跳过它们。
$bundledGames = @('gobang', 'ox')
$releaseName = if ($HallOnly) { 'BoardgameHall-Lite-Windows-x64-' } else { 'BoardgameHall-Windows-x64-' }
$releaseRoot = Join-Path $projectRoot ('dist/' + $releaseName + $stamp)
$assetsRoot = Join-Path $projectRoot ('dist/BoardgameHall-ArkhamCards-' + $stamp)
# 版本化布局（见 lib/install.js）：app-<大厅版本>/ + runtime-<Node 版本>/ + current.ini，供自动更新并排切换。
$rootPackage = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json
$hallVersion = [string]$rootPackage.version
if ($hallVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json 的 version 必须是 x.y.z。' }
$appDirName = 'app-' + $hallVersion
$appRoot = Join-Path $releaseRoot $appDirName
# 卡图资源包仍解压到 app/，大厅启动时会自动并入当前版本目录。
$assetsAppRoot = Join-Path $assetsRoot 'app'
$imageRelativeRoot = 'games/arkhamhorror/web/img'
$imageSourceRoot = Join-Path $projectRoot $imageRelativeRoot
$cardImagePattern = '^games/arkhamhorror/web/img/(zh/)?cards/'
$cardInventoryPattern = '^(zh/)?cards/'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
if ($buildLogic) {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $architecture = & $nodeExe -p 'process.arch'
    if ($architecture -ne 'x64') { throw '此构建脚本需要 Windows x64 Node.js。' }
    $runtimeVersion = [Version]((& $nodeExe -p 'process.versions.node').Trim())
    if ($runtimeVersion -lt [Version]'22.15.0') { throw '联机版本需要 Node.js 22.15 或更新版本，请先更新打包机器的 Node.js。' }
    $runtimeDirName = 'runtime-' + $runtimeVersion.ToString()
    $runtimeRoot = Join-Path $releaseRoot $runtimeDirName
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (!(Test-Path -LiteralPath $compiler)) { throw '未找到 Windows .NET Framework C# 编译器。' }
    New-Item -ItemType Directory -Path $appRoot,$runtimeRoot | Out-Null
}

# Only ship runtime files. Never copy the project root, home, saves or config.
$cardImageCount = 0
foreach ($folder in @('lib', 'public', 'games')) {
    $sourceRoot = Join-Path $projectRoot $folder
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
        $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
        if ($relative -match '/(tests|test-results|tools|docs|Develop|develop|sessions|user-data|node_modules)/') { continue }
        if ($relative -match '/audit/') { continue }
        if ($relative -match '(^|/)\.git(/|$)|(^|/)\.git(ignore|modules|attributes)$') { continue }
        if ($relative -match '(?i)(^|/)(boardgame\.config\.json|ais\.json|decisions\.jsonl)$|\.(log|tmp|bak|md)$') { continue }
        if ($HallOnly -and $relative -match '^games/([^/]+)/' -and $bundledGames -notcontains $Matches[1]) { continue }
        if ($relative -match $cardImagePattern) {
            if (!$buildAssets) { continue }
            $targetRoot = $assetsAppRoot
            $cardImageCount++
        } else {
            if (!$buildLogic) { continue }
            $targetRoot = $appRoot
        }
        $destination = Join-Path $targetRoot $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        [IO.File]::Copy($file.FullName, $destination)
    }
}

# 拆分本地图库清单：逻辑包只登记随包图片，卡图清单随资源包发布，避免逻辑包请求不存在的本地卡图。
function Write-ImageInventory([string]$Destination, $Source, [string[]]$Files, [string]$PackageName) {
    $bytes = [long]0
    $zh = 0
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Files) {
        $length = ([IO.FileInfo]::new((Join-Path $imageSourceRoot $path))).Length
        $bytes += $length
        if ($path.StartsWith('zh/')) { $zh++ }
        $lines.Add($path + ':' + $length)
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    $digest = $sha.ComputeHash($utf8NoBom.GetBytes([string]::Join("`n", $lines)))
    $inventory = [ordered]@{
        schemaVersion = 1
        host = $Source.host
        scope = $Source.scope
        languages = @($Source.languages)
        package = $PackageName
        total = $Files.Count
        bytes = $bytes
        byLanguage = [ordered]@{ en = $Files.Count - $zh; zh = $zh }
        fingerprint = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
        note = $Source.note
        files = @($Files)
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
    [IO.File]::WriteAllText($Destination, ($inventory | ConvertTo-Json -Depth 4), $utf8NoBom)
}
$inventorySource = Join-Path $projectRoot 'games/arkhamhorror/audit/local-images.json'
$cardInventoryFiles = @()
if (!$HallOnly -and (Test-Path -LiteralPath $inventorySource)) {
    $sourceInventory = [IO.File]::ReadAllText($inventorySource) | ConvertFrom-Json
    $existing = @($sourceInventory.files | Where-Object { [IO.File]::Exists((Join-Path $imageSourceRoot $_)) })
    $logicInventoryFiles = @($existing | Where-Object { $_ -notmatch $cardInventoryPattern })
    $cardInventoryFiles = @($existing | Where-Object { $_ -match $cardInventoryPattern })
    if ($buildLogic) {
        Write-ImageInventory (Join-Path $appRoot 'games/arkhamhorror/audit/local-images.json') $sourceInventory $logicInventoryFiles 'logic'
    }
    if ($buildAssets -and $cardInventoryFiles.Count) {
        Write-ImageInventory (Join-Path $assetsAppRoot 'games/arkhamhorror/audit/local-images.cards.json') $sourceInventory $cardInventoryFiles 'arkham-cards'
    }
}

if ($buildLogic) {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'server.js') -Destination $appRoot
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows/portable.mjs') -Destination $appRoot
    $appPackage = [ordered]@{ name = 'dsh-boardgame-hall'; version = $hallVersion; private = $true; type = 'module'; boardgame = $rootPackage.boardgame }
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), ($appPackage | ConvertTo-Json -Depth 4), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'current.ini'), "app=$appDirName`nruntime=$runtimeDirName`n", $utf8NoBom)
    if ($HallOnly) {
        $edition = [ordered]@{ edition = 'hall-only'; games = $bundledGames }
        [IO.File]::WriteAllText((Join-Path $releaseRoot 'edition.json'), ($edition | ConvertTo-Json -Depth 4), $utf8NoBom)
    }
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtimeRoot 'node.exe')
    $nodeLicense = Join-Path (Split-Path $nodeExe -Parent) 'LICENSE'
    if ($env:BOARDGAME_NODE_LICENSE) {
        if (!(Test-Path -LiteralPath $env:BOARDGAME_NODE_LICENSE)) { throw '指定的 Node.js 许可证文件不存在。' }
        Copy-Item -LiteralPath $env:BOARDGAME_NODE_LICENSE -Destination (Join-Path $runtimeRoot 'LICENSE.txt')
    } elseif (Test-Path -LiteralPath $nodeLicense) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimeRoot 'LICENSE.txt')
    } else {
        $nodeVersion = & $nodeExe --version
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $runtimeRoot 'LICENSE.txt')
    }
    $executable = Join-Path $releaseRoot '桌游大厅.exe'
    & $compiler /nologo /codepage:65001 /target:exe /platform:x64 /optimize+ "/out:$executable" (Join-Path $PSScriptRoot 'windows\Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败。' }
    $instructionsTitle = if ($HallOnly) { '桌游大厅 · Windows x64 免安装版（纯大厅）' } else { '桌游大厅 · Windows x64 免安装版（逻辑包）' }
    $instructionsCommon = @'
1. 完整解压文件夹，双击“桌游大厅.exe”。无需安装 Node.js。
2. 启动后自动打开浏览器；默认地址为 http://127.0.0.1:18787，端口占用时自动顺延。
3. 游戏期间保留启动窗口。结束时在窗口按 Ctrl+C。
4. 模型地址、密钥等请在大厅设置中重新填写。
5. 联机：开局选择“联机房间”，设置总席位并逐席选择玩家或 AI，再复制邀请给朋友。中转地址在“设置 → 联机”修改；朋友在大厅点击“加入联机房间”。
6. 联机双方需使用同一版本。浏览器保持打开时优先直连，失败或关闭浏览器后自动走 Render 中转；无需配置路由器，房主需保持大厅运行。默认保存配置下，重启会尝试恢复房间。
'@
    $instructionsArkham = @'
7. 诡镇存档管理分为单人和联机。房主在“联机存档”中选择“创建房间继续”，朋友按原席位加入并准备，再继续原有进度。
8. 本包不预装诡镇奇谈卡牌图片：使用默认 CDN 时，已显示的卡图会自动缓存到 app/games/arkhamhorror/web/img/，以后可离线复用。
   如需一次获得完整离线卡图，请下载“BoardgameHall-ArkhamCards-*.zip”卡图资源包，解压到本文件夹（与“桌游大厅.exe”同级，合并 app 文件夹），然后重启大厅。
   大厅启动时会把 app 文件夹中的卡图自动并入当前版本（app-版本号 文件夹）。
9. 自动更新：大厅会定期检查新版本。在“设置 → 更新与游戏”中可一键更新大厅、安装或更新游戏；
   新版本准备到旁边的 app-版本号 文件夹（只下载变化的文件），重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。
'@
    $instructionsHallOnly = @'
7. 本版只内置五子棋和井字棋。诡镇奇谈等其他游戏可在“设置 → 更新与游戏”中从游戏商店安装，下载到 user-data 文件夹。
8. 自动更新：大厅会定期检查新版本，在“设置 → 更新与游戏”中可一键更新。更新时只下载变化的文件，
   并保持纯大厅版（不会自动带入其他内置游戏）。重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。
'@
    $instructionsFooter = @'

发布包不包含已有存档、个人 AI 角色、模型密钥、决策日志或浏览器数据。
新存档及设置会在 EXE 同目录的 user-data 文件夹中生成，不读取开发版的旧存档。
存档功能正常保留。再次启动此版本会恢复你在此版本中新建的存档。
请把完整文件夹放在有写入权限的位置；不要单独移动 EXE。
'@
    $instructionsContents = if ($HallOnly) {
        "包含五子棋、井字棋，以及大厅界面资源。"
    } else {
        "包含五子棋、井字棋、诡镇奇谈，以及界面图片和音乐资源（诡镇奇谈卡牌图片见卡图资源包）。`n卡图及音乐版权归各自权利人所有。"
    }
    $instructions = $instructionsTitle + "`n`n" + $instructionsCommon + "`n" + $(if ($HallOnly) { $instructionsHallOnly } else { $instructionsArkham }) + "`n" + $instructionsFooter + "`n" + $instructionsContents + "`n"
    [IO.File]::WriteAllText((Join-Path $releaseRoot '使用说明.txt'), $instructions, [Text.UTF8Encoding]::new($true))
    $files = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File)
    $forbidden = @($files | Where-Object { $_.FullName -match '(?i)[\\/](sessions|user-data)[\\/]|[\\/](boardgame\.config\.json|ais\.json|decisions\.jsonl)$|\.(log|tmp|bak)$' })
    if ($forbidden.Count) { throw '发布包检查失败：包含个人数据文件。' }
    $appRootFull = [IO.Path]::GetFullPath($appRoot)
    $leakedCards = @($files | Where-Object { $_.FullName.StartsWith($appRootFull + '\') -and $_.FullName.Substring($appRootFull.Length + 1).Replace('\', '/') -match $cardImagePattern })
    if ($leakedCards.Count) { throw '逻辑包检查失败：包含诡镇奇谈卡牌图片。' }
    $manifest = @{
        builtAt = (Get-Date).ToString('o')
        nodeVersion = (& $nodeExe --version)
        hallVersion = $hallVersion
        appDir = $appDirName
        runtimeDir = $runtimeDirName
        platform = 'win32-x64'
        package = $(if ($HallOnly) { 'hall-only' } else { 'logic' })
        bundledGames = @(Get-ChildItem -LiteralPath (Join-Path $appRoot 'games') -Directory | ForEach-Object Name)
        bundledSaves = $false
        bundledPersonalConfig = $false
        bundledArkhamCardImages = $false
        files = @($files | ForEach-Object { $_.FullName.Substring($releaseRoot.Length + 1).Replace('\', '/') })
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $releaseRoot 'build-manifest.json') -Encoding utf8
}

$hasAssets = $buildAssets -and $cardImageCount -gt 0
if ($hasAssets) {
    $assetInstructions = @'
桌游大厅 · 诡镇奇谈卡图资源包

1. 将本压缩包解压到桌游大厅逻辑包文件夹（与“桌游大厅.exe”同级），合并 app 文件夹。
2. 重启桌游大厅后，诡镇奇谈优先使用本地卡图，离线也能显示卡面。
3. 未安装本资源包时游戏照常运行：默认 CDN 图片在首次显示后也会按同一目录结构缓存到本地。
4. 卡图资源包与逻辑包版本相互独立，更新逻辑包时无需重新下载本资源包。

卡面美术版权归 Fantasy Flight Games，仅供本地离线使用，不得再分发。
'@
    [IO.File]::WriteAllText((Join-Path $assetsRoot '诡镇奇谈卡图包说明.txt'), $assetInstructions, [Text.UTF8Encoding]::new($true))
    $assetManifest = [ordered]@{
        builtAt = (Get-Date).ToString('o')
        package = 'arkham-cards'
        imageFiles = $cardImageCount
        inventoryFiles = $cardInventoryFiles.Count
    }
    [IO.File]::WriteAllText((Join-Path $assetsRoot 'arkham-cards-manifest.json'), ($assetManifest | ConvertTo-Json -Depth 4), $utf8NoBom)
} elseif ($buildAssets) {
    $message = "未找到诡镇奇谈卡牌图片（$imageRelativeRoot/cards），无法生成卡图资源包。"
    if ($AssetsOnly) { throw $message }
    Write-Warning $message
}

if (!$SkipZip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ($buildLogic) { [IO.Compression.ZipFile]::CreateFromDirectory($releaseRoot, "$releaseRoot.zip", [IO.Compression.CompressionLevel]::Fastest, $true) }
    # 卡图为已压缩的 avif，资源包不再压缩；不含顶层目录，便于直接解压到逻辑包文件夹。
    if ($hasAssets) { [IO.Compression.ZipFile]::CreateFromDirectory($assetsRoot, "$assetsRoot.zip", [IO.Compression.CompressionLevel]::NoCompression, $false) }
}
if ($buildLogic) {
    Write-Output "RELEASE_DIR=$releaseRoot"
    Write-Output "EXE=$executable"
}
if ($hasAssets) { Write-Output "ASSETS_DIR=$assetsRoot" }
