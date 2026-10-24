# Per-test attribution for the two heavy files (run each test in isolation with a watchdog).
$ErrorActionPreference = 'Continue'
$ak = 'G:\boardgame-hall-ai\games\arkhamhorror'
$out = 'G:\boardgame-hall-ai\.test-audit'
$node = (Get-Command node).Source

$campaignPatterns = @(
  '检查点后续发生异常时整条命令仍原子回滚',
  '开局固定持久牌组，观察者只见本人无序清单',
  '集结 R2 队长单独多得1XP',
  'R1 丽塔由明确选择加入队长牌组',
  '跨关不重抽基础弱点、不恢复已更换牌组',
  'Core 升级池只在关间开放',
  '新购0级至少1XP',
  '结局重新核对地点残留线索',
  '掩盖罪证剩余线索导致精神创伤',
  '创伤达到印刷上限后更换独立人物',
  '集结R3杀死未撤退者',
  '同次伤害恐惧同时击败时显式选择一种创伤',
  '跨关牌组变化区分本关移除与永久移除',
  '午夜已至在下关换牌后随机弃两张',
  '01094 以资产自身容量承伤',
  '合法战役失败流程 1人/standard',
  '合法战役失败流程 4人/standard'
)
$replayPatterns = @('100 局随机对局', '5,000 步随机走子器')

$results = @()
foreach ($entry in @(@{ file = 'tests/campaign-n4.test.mjs'; patterns = $campaignPatterns }, @{ file = 'tests/replay-fuzz.test.mjs'; patterns = $replayPatterns })) {
  foreach ($pattern in $entry.patterns) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $node -ArgumentList '--test', '--test-name-pattern', $pattern, $entry.file -WorkingDirectory $ak -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $out 'probe-per-test.out.log') -RedirectStandardError (Join-Path $out 'probe-per-test.err.log')
    $timedOut = $false
    if (-not $p.WaitForExit(120000)) {
      $timedOut = $true
      & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
    }
    $sw.Stop()
    $seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    $row = [ordered]@{ file = $entry.file; pattern = $pattern; seconds = $seconds; timedOut = $timedOut; exit = $(if ($timedOut) { $null } else { $p.ExitCode }) }
    $results += $row
    Write-Output ("{0} | {1}s | timeout={2} | {3}" -f $pattern, $seconds, $timedOut, $entry.file)
  }
}
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out 'probe-per-test.json') -Encoding utf8
Write-Output '=== DONE ==='
