<#
.SYNOPSIS
    给 Windows 发布包里的 EXE 做 Authenticode 代码签名，并校验签名结果。

.DESCRIPTION
    「未知发布者」来自 Windows 的附件管理器：从网上下载的文件带 Mark of the Web 标记，
    运行前系统会确认发布者身份。没有签名、或证书不受本机信任时，发布者一栏就是「未知发布者」。
    用公共 CA 签发的代码签名证书签名（SHA-256 + RFC 3161 时间戳）之后，Windows 能验证发布者，
    对外发布的包不再显示「未知发布者」。自签名证书只对装过该证书的电脑有效，不能用于发布。

    三种签名方式任选其一，按顺序优先：
      -Thumbprint    证书已在 CurrentUser\My 或 LocalMachine\My（SimplySign 虚拟卡、USB 令牌）
      -PfxPath       旧式 PFX 文件；2023-06 之后新签发的证书按 CA/B 规则不再提供 PFX
      -SignCommand   外部签名工具的命令模板，{file} 会替换为 EXE 路径（云签名 CLI）

    签名必须放在构建的最后一步：签名后任何改动（替换资源、重新打包、改配置）都会让签名失效。
    证书与购买渠道见 docs/windows-signing.md。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows/sign-release.ps1 `
        -Path "dist\BoardgameHall-Lite-Windows-x64-20260101-120000\桌游大厅.exe" `
        -Thumbprint 0123456789ABCDEF0123456789ABCDEF01234567

.EXAMPLE
    # 交给云签名工具，参数以服务商文档为准
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows/sign-release.ps1 `
        -Path "dist\BoardgameHall-Lite-Windows-x64-20260101-120000\桌游大厅.exe" `
        -SignCommand 'artifact-signing-cli -e https://example.codesigning.azure.net -a account -c profile "{file}"'
#>
param(
    [Parameter(Position = 0)][string]$Path,
    [string]$Thumbprint,
    [string]$PfxPath,
    [string]$PfxPassword,
    [string]$SignCommand,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$Description = '桌游大厅'
)
$ErrorActionPreference = 'Stop'

if (!$Path) {
    throw '用法：sign-release.ps1 -Path <EXE 路径> [-Thumbprint <证书指纹> | -PfxPath <pfx 文件> -PfxPassword <密码> | -SignCommand <命令模板>] [-TimestampUrl <时间戳地址>]'
}
if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "找不到要签名的文件：$Path" }
$Path = (Resolve-Path -LiteralPath $Path).ProviderPath

function Find-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    # 没加进 PATH 时，到 Windows SDK 里找最新版本（10.0.22621.0\x64\signtool.exe）。
    foreach ($root in @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")) {
        if (!(Test-Path -LiteralPath $root)) { continue }
        $candidate = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $version = $null
            [void][Version]::TryParse($_.Name, [ref]$version)
            [pscustomobject]@{ Path = Join-Path $_.FullName 'x64\signtool.exe'; Version = $version }
        } | Where-Object { $_.Version -and (Test-Path -LiteralPath $_.Path) } |
            Sort-Object Version -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.Path }
    }
    return $null
}

$method = if ($Thumbprint) { 'thumbprint' } elseif ($PfxPath) { 'pfx' } elseif ($SignCommand) { 'command' } else { $null }
if (!$method) {
    throw '没有指定签名方式：请提供 -Thumbprint、-PfxPath 或 -SignCommand（也可用 BOARDGAME_SIGN_THUMBPRINT / BOARDGAME_SIGN_PFX / BOARDGAME_SIGN_COMMAND 环境变量）。'
}

$store = $null
if ($method -eq 'pfx' -and !(Test-Path -LiteralPath $PfxPath)) { throw "找不到 PFX 文件：$PfxPath" }
if ($method -eq 'thumbprint') {
    $normalized = ($Thumbprint -replace '\s', '').ToUpperInvariant()
    foreach ($location in @('CurrentUser', 'LocalMachine')) {
        if (Test-Path -LiteralPath "Cert:\$location\My\$normalized") { $store = $location; break }
    }
    if (!$store) {
        throw "证书存储里找不到指纹为 $Thumbprint 的代码签名证书。SimplySign 请先登录 SimplySign Desktop 并在手机上确认；USB 令牌请先插入。"
    }
}

if ($method -eq 'command') {
    # 模板里写 {file} 或 "{file}" 都可以：统一替换成带引号的完整路径。
    $quoted = '"' + $Path + '"'
    $expanded = $SignCommand.Replace('"{file}"', $quoted).Replace('{file}', $quoted)
    Write-Host "签名命令：$expanded"
    # 清零要写全局变量：在脚本里直接写 $LASTEXITCODE 会遮蔽引擎更新的全局值，原生命令的退出码就看不到了。
    $global:LASTEXITCODE = 0
    Invoke-Expression $expanded
    if ($LASTEXITCODE -ne 0) { throw "签名命令返回退出码 $LASTEXITCODE。" }
} else {
    $signTool = Find-SignTool
    if (!$signTool) {
        throw '找不到 signtool.exe。请安装 Windows SDK 的「Signing Tools for Desktop Apps」，或改用 -SignCommand 调用云签名工具（安装步骤见 docs/windows-signing.md）。'
    }
    $arguments = @('sign', '/fd', 'sha256', '/td', 'sha256', '/tr', $TimestampUrl, '/d', $Description, '/v')
    if ($method -eq 'thumbprint') {
        $arguments += @('/sha1', ($Thumbprint -replace '\s', ''), '/s', 'My', '/a')
        if ($store -eq 'LocalMachine') { $arguments += '/sm' }
    } else {
        $arguments += @('/f', (Resolve-Path -LiteralPath $PfxPath).ProviderPath)
        if ($PfxPassword) { $arguments += @('/p', $PfxPassword) }
    }
    $arguments += $Path
    Write-Host "签名中：$Path"
    & $signTool @arguments
    if ($LASTEXITCODE -ne 0) { throw "signtool 签名失败（退出码 $LASTEXITCODE），请检查证书、时间戳服务或网络代理。" }
}

$signature = Get-AuthenticodeSignature -LiteralPath $Path
if (!$signature -or $signature.Status -ne 'Valid') {
    $status = [string]$signature.Status
    $reason = switch ($status) {
        'NotSigned' { '文件没有签名，签名命令可能没有真正执行。' }
        'HashMismatch' { '签名之后文件又被改动过：签名必须是构建的最后一步。' }
        'NotTrusted' { '证书不受本机信任；自签名证书只对装过该证书的电脑有效。' }
        'UnknownError' { '无法验证签名，常见原因是证书链不完整或缺少中间证书。' }
        default { $signature.StatusMessage }
    }
    throw "签名校验未通过（$status）：$reason 请检查证书、时间戳服务（$TimestampUrl）和网络代理。"
}
if (!$signature.TimeStamperCertificate) {
    Write-Warning '签名没有 RFC 3161 时间戳：证书到期后签名会失效，请检查 -TimestampUrl 与网络。'
}

Write-Host ('SIGNED=' + $Path)
Write-Host ('SIGNER=' + $signature.SignerCertificate.Subject)
Write-Host ('THUMBPRINT=' + $signature.SignerCertificate.Thumbprint)
