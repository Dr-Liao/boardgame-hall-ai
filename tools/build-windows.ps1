param([switch]$SkipZip, [switch]$SkipAssets, [switch]$AssetsOnly, [switch]$HallOnly)
$ErrorActionPreference = 'Stop'
if ($SkipAssets -and $AssetsOnly) { throw 'SkipAssets 与 AssetsOnly 不能同时使用。' }
if ($HallOnly -and $AssetsOnly) { throw 'HallOnly 与 AssetsOnly 不能同时使用。' }
$buildLogic = !$AssetsOnly
$buildAssets = !$SkipAssets -and !$HallOnly
$projectRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# 程序包：可独立运行，不含各游戏声明的资源包文件。资源包：解压覆盖到程序包目录即可启用（见 boardgame-mod.json 的 assetPacks）。
# 纯大厅版（-HallOnly）：只内置 package.json 的 boardgame.liteGames，其他游戏从游戏商店安装；edition.json 让自动更新也跳过它们。
# 游戏的暂存、资源包拆分与 prepack 由 tools/release/stage-games.mjs 完成，本脚本不认识具体游戏。
$releaseName = if ($HallOnly) { 'BoardgameHall-Lite-Windows-x64-' } else { 'BoardgameHall-Windows-x64-' }
$releaseRoot = Join-Path $projectRoot ('dist/' + $releaseName + $stamp)
# 版本化布局（见 lib/install.js）：app-<大厅版本>/ + runtime-<Node 版本>/ + current.ini，供自动更新并排切换。
$rootPackage = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json
$hallVersion = [string]$rootPackage.version
if ($hallVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json 的 version 必须是 x.y.z。' }
$appDirName = 'app-' + $hallVersion
$appRoot = Join-Path $releaseRoot $appDirName
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
if ($buildLogic) {
    $architecture = & $nodeExe -p 'process.arch'
    if ($architecture -ne 'x64') { throw '此构建脚本需要 Windows x64 Node.js。' }
    $runtimeVersion = [Version]((& $nodeExe -p 'process.versions.node').Trim())
    if ($runtimeVersion -lt [Version]'22.15.0') { throw '联机版本需要 Node.js 22.15 或更新版本，请先更新打包机器的 Node.js。' }
    $runtimeDirName = 'runtime-' + $runtimeVersion.ToString()
    $runtimeRoot = Join-Path $releaseRoot $runtimeDirName
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (!(Test-Path -LiteralPath $compiler)) { throw '未找到 Windows .NET Framework C# 编译器。' }
    New-Item -ItemType Directory -Path $appRoot,$runtimeRoot | Out-Null

    # Only ship runtime files. Never copy the project root, home, saves or config.
    foreach ($folder in @('lib', 'public')) {
        $sourceRoot = Join-Path $projectRoot $folder
        foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
            $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
            if ($relative -match '/(tests|test-results|tools|docs|Develop|develop|sessions|user-data|node_modules)/') { continue }
            if ($relative -match '(?i)\.(log|tmp|bak|md)$') { continue }
            $destination = Join-Path $appRoot $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.File]::Copy($file.FullName, $destination)
        }
    }
}

$stageReport = [IO.Path]::GetTempFileName()
try {
    $stageArgs = @((Join-Path $PSScriptRoot 'release/stage-games.mjs'), "--report=$stageReport", "--stamp=$stamp")
    if ($buildLogic) { $stageArgs += "--app=$appRoot" }
    if ($buildAssets) { $stageArgs += ('--assets=' + (Join-Path $projectRoot 'dist')) }
    if ($HallOnly) { $stageArgs += '--lite' }
    & $nodeExe @stageArgs
    if ($LASTEXITCODE -ne 0) { throw '游戏暂存失败。' }
    $staged = [IO.File]::ReadAllText($stageReport, [Text.Encoding]::UTF8) | ConvertFrom-Json
} finally {
    Remove-Item -LiteralPath $stageReport -Force -ErrorAction SilentlyContinue
}
$gameNames = (@($staged.games) | ForEach-Object { $_.name }) -join '、'
$assetPacks = @($staged.assetPacks)

if ($buildLogic) {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'server.js') -Destination $appRoot
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows/portable.mjs') -Destination $appRoot
    $appPackage = [ordered]@{ name = 'dsh-boardgame-hall'; version = $hallVersion; private = $true; type = 'module'; boardgame = $rootPackage.boardgame }
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), ($appPackage | ConvertTo-Json -Depth 4), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'current.ini'), "app=$appDirName`nruntime=$runtimeDirName`n", $utf8NoBom)
    if ($HallOnly) {
        $edition = [ordered]@{ edition = 'hall-only'; games = @($staged.games | ForEach-Object { $_.id }) }
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
    $instructionsTitle = if ($HallOnly) { '桌游大厅 · Windows x64 免安装版（纯大厅）' } else { '桌游大厅 · Windows x64 免安装版（程序包）' }
    $instructionsCommon = @'
1. 完整解压文件夹，双击“桌游大厅.exe”。无需安装 Node.js。
2. 启动后自动打开浏览器；默认地址为 http://127.0.0.1:18787，端口占用时自动顺延。
3. 游戏期间保留启动窗口。结束时在窗口按 Ctrl+C。
4. 模型地址、密钥等请在大厅设置中重新填写。
5. 联机：开局选择“联机房间”，设置总席位并逐席选择玩家或 AI，再复制邀请给朋友。中转地址在“设置 → 联机”修改；朋友在大厅点击“加入联机房间”。
6. 联机双方需使用同一版本。浏览器保持打开时优先直连，失败或关闭浏览器后自动走 Render 中转；无需配置路由器，房主需保持大厅运行。默认保存配置下，重启会尝试恢复房间。
'@
    $notes = New-Object System.Collections.Generic.List[string]
    # Windows PowerShell 把中文弯引号也当作字符串定界符，含弯引号的文本只能放在单引号字符串里。
    if ($HallOnly) {
        $notes.Add('本版只内置' + $gameNames + '。其他游戏可在大厅的“游戏中心”中安装，下载到 user-data 文件夹。')
        $notes.Add('自动更新：大厅会定期检查新版本，在“设置 → 大厅更新”中可一键更新。更新时只下载变化的文件，' + "`n   " + '并保持纯大厅版（不会自动带入其他内置游戏）。重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。')
    } else {
        foreach ($note in @($staged.notes)) { $notes.Add($note) }
        $notes.Add('自动更新：大厅会定期检查新版本。在“设置 → 大厅更新”中可一键更新大厅，在大厅的“游戏中心”中安装或更新游戏；' + "`n   " + '新版本准备到旁边的 app-版本号 文件夹（只下载变化的文件），重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。')
    }
    $numbered = for ($i = 0; $i -lt $notes.Count; $i++) { "$($i + 7). $($notes[$i])" }
    $instructionsFooter = @'

发布包不包含已有存档、个人 AI 角色、模型密钥、决策日志或浏览器数据。
新存档及设置会在 EXE 同目录的 user-data 文件夹中生成，不读取开发版的旧存档。
存档功能正常保留。再次启动此版本会恢复你在此版本中新建的存档。
请把完整文件夹放在有写入权限的位置；不要单独移动 EXE。
'@
    $instructionsContents = if ($HallOnly) {
        "包含$gameNames，以及大厅界面资源。"
    } else {
        $packTitles = (@($staged.games | ForEach-Object { $_.assetPacks }) | Where-Object { $_ }) -join '、'
        "包含$gameNames，以及界面图片和音乐资源" + $(if ($packTitles) { '（' + $packTitles + '单独发布）' } else { '' }) + "。`n游戏美术及音乐版权归各自权利人所有。"
    }
    $instructions = $instructionsTitle + "`n`n" + $instructionsCommon + "`n" + ($numbered -join "`n") + "`n" + $instructionsFooter + "`n" + $instructionsContents + "`n"
    [IO.File]::WriteAllText((Join-Path $releaseRoot '使用说明.txt'), $instructions, [Text.UTF8Encoding]::new($true))
    $files = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File)
    $forbidden = @($files | Where-Object { $_.FullName -match '(?i)[\\/](sessions|user-data)[\\/]|[\\/](boardgame\.config\.json|ais\.json|decisions\.jsonl)$|\.(log|tmp|bak)$' })
    if ($forbidden.Count) { throw '发布包检查失败：包含个人数据文件。' }
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
        bundledAssetPacks = @()
        files = @($files | ForEach-Object { $_.FullName.Substring($releaseRoot.Length + 1).Replace('\', '/') })
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $releaseRoot 'build-manifest.json') -Encoding utf8
}

if ($buildAssets -and !$assetPacks.Count) {
    $message = '没有任何游戏声明资源包（或资源文件尚未下载），未生成资源包。'
    if ($AssetsOnly) { throw $message }
    Write-Warning $message
}

if (!$SkipZip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ($buildLogic) { [IO.Compression.ZipFile]::CreateFromDirectory($releaseRoot, "$releaseRoot.zip", [IO.Compression.CompressionLevel]::Fastest, $true) }
    # 资源包多为已压缩的图片/音频，不再压缩；不含顶层目录，便于直接解压到程序包文件夹。
    foreach ($pack in $assetPacks) { [IO.Compression.ZipFile]::CreateFromDirectory($pack.root, "$($pack.root).zip", [IO.Compression.CompressionLevel]::NoCompression, $false) }
}
if ($buildLogic) {
    Write-Output "RELEASE_DIR=$releaseRoot"
    Write-Output "EXE=$executable"
}
foreach ($pack in $assetPacks) { Write-Output "ASSETS_DIR=$($pack.root)" }
