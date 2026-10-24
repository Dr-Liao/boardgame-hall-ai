# Remaining measurements, sequential so they don't contend:
#   1) per-file TAP timings for the arkham node suite (excluding the two heavy files)
#   2) hall browser suite
#   3) arkham + hall browser via tools/run-p7.mjs --browser-only
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$ak = Join-Path $ws 'games\arkhamhorror'
$out = Join-Path $ws '.test-audit'
Push-Location $ws

# ---------- 1) TAP per-file ----------
$exclude = @('replay-fuzz.test.mjs', 'campaign-n4.test.mjs')
$files = Get-ChildItem (Join-Path $ak 'tests') -Filter *.test.mjs -File |
  Where-Object { $exclude -notcontains $_.Name } |
  Sort-Object Name | ForEach-Object { 'tests/' + $_.Name }
Write-Output ("TAP files: " + $files.Count)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $ak
& node --test --test-reporter=tap --test-reporter-destination=stdout @files 2>&1 | Out-File -FilePath (Join-Path $out 'arkham-tap.log') -Encoding utf8
$tapExit = $LASTEXITCODE
Pop-Location
$sw.Stop()
$tapSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Output ('TAP seconds=' + $tapSeconds + ' exit=' + $tapExit)

# ---------- 2) hall browser ----------
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node 'tools/require-playwright-browsers.mjs' 2>&1 | Out-File -FilePath (Join-Path $out 'hall-browser.log') -Encoding utf8
& node 'node_modules/@playwright/test/cli.js' test '--config' 'tests/hall/playwright.config.mjs' 2>&1 | Out-File -FilePath (Join-Path $out 'hall-browser.log') -Append -Encoding utf8
$hallBrowserExit = $LASTEXITCODE
$sw.Stop()
$hallBrowserSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Output ('HALL BROWSER seconds=' + $hallBrowserSeconds + ' exit=' + $hallBrowserExit)

# ---------- 3) arkham + hall browser via run-p7 ----------
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node 'games/arkhamhorror/tools/run-p7.mjs' '--browser-only' 2>&1 | Out-File -FilePath (Join-Path $out 'arkham-browser.log') -Encoding utf8
$arkhamBrowserExit = $LASTEXITCODE
$sw.Stop()
$arkhamBrowserSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Output ('ARKHAM BROWSER seconds=' + $arkhamBrowserSeconds + ' exit=' + $arkhamBrowserExit)

Pop-Location
$summary = [ordered]@{
  tapSeconds = $tapSeconds; tapExit = $tapExit;
  hallBrowserSeconds = $hallBrowserSeconds; hallBrowserExit = $hallBrowserExit;
  arkhamBrowserSeconds = $arkhamBrowserSeconds; arkhamBrowserExit = $arkhamBrowserExit;
  finishedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json | Set-Content (Join-Path $out 'rest-times.json') -Encoding utf8
Write-Output '=== REST SUMMARY ==='
$summary | ConvertTo-Json
