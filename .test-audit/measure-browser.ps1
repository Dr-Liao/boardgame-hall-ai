# Measure browser regression suites: hall (10 cases) and arkham (56 specs via run-p7 --browser-only).
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$out = Join-Path $ws '.test-audit'
Push-Location $ws

# --- hall browser ---
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node 'tools/require-playwright-browsers.mjs' 2>&1 | Tee-Object -FilePath (Join-Path $out 'hall-browser.log')
& node 'node_modules/@playwright/test/cli.js' test '--config' 'tests/hall/playwright.config.mjs' 2>&1 | Tee-Object -FilePath (Join-Path $out 'hall-browser.log') -Append
$hallExit = $LASTEXITCODE
$sw.Stop()
$hallSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Output ('HALL BROWSER seconds=' + $hallSeconds + ' exit=' + $hallExit)

# --- arkham + hall browser via run-p7 browser-only (owns the hall server) ---
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node 'games/arkhamhorror/tools/run-p7.mjs' '--browser-only' 2>&1 | Tee-Object -FilePath (Join-Path $out 'arkham-browser.log')
$arkhamExit = $LASTEXITCODE
$sw.Stop()
$arkhamSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Output ('ARKHAM BROWSER seconds=' + $arkhamSeconds + ' exit=' + $arkhamExit)

Pop-Location
$summary = [ordered]@{
  hallBrowserSeconds = $hallSeconds; hallBrowserExit = $hallExit;
  arkhamBrowserSeconds = $arkhamSeconds; arkhamBrowserExit = $arkhamExit;
  finishedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json | Set-Content (Join-Path $out 'browser-times.json') -Encoding utf8
Write-Output '=== BROWSER SUMMARY ==='
$summary | ConvertTo-Json
