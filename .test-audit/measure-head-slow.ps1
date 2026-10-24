# Time the two dominant slow test files against a clean HEAD checkout (git worktree), with watchdogs.
# Goal: determine whether the huge slowdown seen in the dirty working tree is WIP-induced or upstream.
$ErrorActionPreference = 'Continue'
$ws = 'G:\boardgame-hall-ai'
$out = Join-Path $ws '.test-audit'
$wt = Join-Path $out 'arkham-head'
$ak = Join-Path $ws 'games\arkhamhorror'

if (-not (Test-Path $wt)) {
  & git -C $ak worktree add $wt HEAD 2>&1 | Tee-Object -FilePath (Join-Path $out 'head-worktree.log')
}
if (-not (Test-Path (Join-Path $wt 'tests\campaign-n4.test.mjs'))) {
  Write-Output 'WORKTREE FAILED'
  exit 1
}

function Time-Test($name, $file, $capSeconds) {
  $log = Join-Path $out ("head-" + $name + ".log")
  $p = Start-Process -FilePath (Get-Command node).Source -ArgumentList '--test', $file -WorkingDirectory $wt -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $timedOut = $false
  if (-not $p.WaitForExit($capSeconds * 1000)) {
    $timedOut = $true
    try { $p.Kill() } catch {}
  }
  $sw.Stop()
  $seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  Write-Output ("HEAD " + $name + ": seconds=" + $seconds + " timedOut=" + $timedOut + " exit=" + $p.ExitCode)
  return [ordered]@{ name = $name; seconds = $seconds; timedOut = $timedOut; exit = $(if ($timedOut) { $null } else { $p.ExitCode }) }
}

$results = @()
$results += Time-Test 'replay-fuzz' 'tests/replay-fuzz.test.mjs' 300
$results += Time-Test 'campaign-n4' 'tests/campaign-n4.test.mjs' 420
$results | ConvertTo-Json | Set-Content (Join-Path $out 'head-slow-times.json') -Encoding utf8
Write-Output '=== HEAD SLOW SUMMARY ==='
$results | ConvertTo-Json
