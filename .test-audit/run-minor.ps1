# Run every arkham test file except the two known-heavy ones, to get failure list + wall time.
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$ak = Join-Path $ws 'games\arkhamhorror'
$out = Join-Path $ws '.test-audit'
$exclude = @('replay-fuzz.test.mjs', 'campaign-n4.test.mjs')
$files = Get-ChildItem (Join-Path $ak 'tests') -Filter *.test.mjs -File |
  Where-Object { $exclude -notcontains $_.Name } |
  Sort-Object Name | ForEach-Object { 'tests/' + $_.Name }
Write-Output ("files: " + $files.Count)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $ak
& node --test --test-reporter=dot --test-reporter-destination=stdout --test-reporter=junit "--test-reporter-destination=$out\junit-arkham-minor.xml" @files 2>&1 | Tee-Object -FilePath (Join-Path $out 'arkham-minor.log')
$code = $LASTEXITCODE
$sw.Stop()
Pop-Location
$summary = [ordered]@{ files = $files.Count; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2); exit = $code; finishedAt = (Get-Date).ToString('o') }
$summary | ConvertTo-Json | Set-Content (Join-Path $out 'wall-times-minor.json') -Encoding utf8
Write-Output '=== MINOR SUMMARY ==='
$summary | ConvertTo-Json
