# Per-file timing for the arkham node suite (excluding the two heavy files), via TAP reporter.
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$ak = Join-Path $ws 'games\arkhamhorror'
$out = Join-Path $ws '.test-audit'
$exclude = @('replay-fuzz.test.mjs', 'campaign-n4.test.mjs')
$files = Get-ChildItem (Join-Path $ak 'tests') -Filter *.test.mjs -File |
  Where-Object { $exclude -notcontains $_.Name } |
  Sort-Object Name | ForEach-Object { 'tests/' + $_.Name }
Write-Output ("TAP files: " + $files.Count)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $ak
& node --test --test-reporter=tap --test-reporter-destination=stdout @files 2>&1 | Out-File -FilePath (Join-Path $out 'arkham-tap.log') -Encoding utf8
$code = $LASTEXITCODE
$sw.Stop()
Pop-Location
$summary = [ordered]@{ files = $files.Count; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2); exit = $code; finishedAt = (Get-Date).ToString('o') }
$summary | ConvertTo-Json | Set-Content (Join-Path $out 'wall-times-tap.json') -Encoding utf8
Write-Output '=== TAP SUMMARY ==='
$summary | ConvertTo-Json
