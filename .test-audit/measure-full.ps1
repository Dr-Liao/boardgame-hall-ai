# Measure the full Node test suite of the hall repo + the arkhamhorror mod.
# Outputs per-file JUnit XML plus wall-clock timings. Run unconfined (needs child-process pipes).
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$out = Join-Path $ws '.test-audit'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$meta = [ordered]@{
  node = (& node --version)
  cpu  = $env:NUMBER_OF_PROCESSORS
  startedAt = (Get-Date).ToString('o')
  hallGit = (& git -C $ws rev-parse --short HEAD)
  hallDirty = ((& git -C $ws status --porcelain) -join "`n")
  arkhamGit = (& git -C (Join-Path $ws 'games\arkhamhorror') rev-parse --short HEAD)
  arkhamDirty = ((& git -C (Join-Path $ws 'games\arkhamhorror') status --porcelain) -join "`n")
}
$meta | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out 'env.json') -Encoding utf8

# ---------- hall node suite ----------
$hallFiles = Get-ChildItem (Join-Path $ws 'tests\hall') -Filter *.test.mjs -File | Sort-Object Name | ForEach-Object { $_.FullName }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $ws
& node --test --test-reporter=dot --test-reporter-destination=stdout --test-reporter=junit "--test-reporter-destination=$out\junit-hall.xml" @hallFiles 2>&1 | Tee-Object -FilePath (Join-Path $out 'hall-run.log')
$hallExit = $LASTEXITCODE
$sw.Stop()
$hallSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Pop-Location

# ---------- arkham node suite (all tiers, one process pool) ----------
$ak = Join-Path $ws 'games\arkhamhorror'
$akFiles = Get-ChildItem (Join-Path $ak 'tests') -Filter *.test.mjs -File | Sort-Object Name | ForEach-Object { 'tests/' + $_.Name }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $ak
& node --test --test-reporter=dot --test-reporter-destination=stdout --test-reporter=junit "--test-reporter-destination=$out\junit-arkham.xml" @akFiles 2>&1 | Tee-Object -FilePath (Join-Path $out 'arkham-run.log')
$arkhamExit = $LASTEXITCODE
$sw.Stop()
$arkhamSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Pop-Location

$summary = [ordered]@{
  hallSeconds = $hallSec
  hallExit = $hallExit
  arkhamSeconds = $arkhamSec
  arkhamExit = $arkhamExit
  totalSeconds = [math]::Round($hallSec + $arkhamSec, 2)
  finishedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json | Set-Content (Join-Path $out 'wall-times.json') -Encoding utf8
Write-Output '=== SUMMARY ==='
$summary | ConvertTo-Json
