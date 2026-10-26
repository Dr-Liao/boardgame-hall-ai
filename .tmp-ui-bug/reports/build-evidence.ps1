# Build compact evidence bundle for the beneath-flicker report.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = 'G:\boardgame-hall-ai'
$reports = Join-Path $root '.tmp-ui-bug\reports'
$out = Join-Path $reports 'out'
$ev = Join-Path $reports 'evidence'
New-Item -ItemType Directory -Force $ev | Out-Null

function Crop-Png([string]$src, [string]$dst, [int]$x, [int]$y, [int]$w, [int]$h) {
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
        $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
        $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $g.Dispose() }
      $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
  } finally { $img.Dispose() }
}

# --- uiturn evidence (normal 结束回合 flow) ---
$uiturn = Join-Path $out 'uiturn-2026-10-26T14-21-01-331Z'
Copy-Item (Join-Path $uiturn '1-before.png') (Join-Path $ev 'uiturn-1-before.png') -Force
Copy-Item (Join-Path $uiturn '2-during.png') (Join-Path $ev 'uiturn-2-during.png') -Force
Copy-Item (Join-Path $uiturn '3-after.png') (Join-Path $ev 'uiturn-3-after.png') -Force
foreach ($name in '1-before', '2-during', '3-after') {
  Crop-Png (Join-Path $uiturn "$name.png") (Join-Path $ev "uiturn-$name-battlefield.png") 240 560 1220 170
}

# --- evidence2 before/during/after crops (refresh with stale revisions) ---
$ev2 = Join-Path $out 'evidence2-2026-10-26T14-20-00-072Z'
Copy-Item (Join-Path $ev2 '1-before-refresh.png') (Join-Path $ev 'refresh-1-before.png') -Force
Copy-Item (Join-Path $ev2 '2-during-gap.png') (Join-Path $ev 'refresh-2-during-gap.png') -Force
Copy-Item (Join-Path $ev2 '3-after-gap.png') (Join-Path $ev 'refresh-3-after-gap.png') -Force
Copy-Item (Join-Path $ev2 '1-before-refresh-crop.png') (Join-Path $ev 'refresh-1-before-crop.png') -Force
Copy-Item (Join-Path $ev2 '2-during-gap-crop.png') (Join-Path $ev 'refresh-2-during-gap-crop.png') -Force
Copy-Item (Join-Path $ev2 '3-after-gap-crop.png') (Join-Path $ev 'refresh-3-after-gap-crop.png') -Force
$ev2Crops = [ordered]@{
  'refresh-1-before-battlefield.png' = '1-before-refresh.png'
  'refresh-2-during-gap-battlefield.png' = '2-during-gap.png'
  'refresh-3-after-gap-battlefield.png' = '3-after-gap.png'
}
foreach ($pair in $ev2Crops.GetEnumerator()) {
  $src = Join-Path $ev2 $pair.Value
  if (Test-Path $src) { Crop-Png $src (Join-Path $ev $pair.Key) 240 560 1220 170 }
}

# --- compact measurements ---
function Read-Json([string]$path) { [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
$monitor = Read-Json (Join-Path $out 'monitor-2026-10-26T14-12-31-331Z\summary.json')
$abControl = Read-Json (Join-Path $out 'ab-control-2026-10-26T14-15-48-945Z\result.json')
$abPatched = Read-Json (Join-Path $out 'ab-patched-2026-10-26T14-16-07-436Z\result.json')
$ev2Control = Read-Json (Join-Path $out 'evidence2-2026-10-26T14-20-00-072Z\evidence.json')
$ev2Patched = Read-Json (Join-Path $out 'evidence2-patched-2026-10-26T14-22-43-272Z\evidence.json')
$uiturnJson = Read-Json (Join-Path $out 'uiturn-2026-10-26T14-21-01-331Z\uiturn.json')

$monitorStep = ($monitor.steps | Where-Object { $_.label -eq 'direct-investigate-then-refresh' })
$measurements = [ordered]@{
  generatedAt = (Get-Date).ToString('s')
  shippedV031 = @{
    head = '94515a5'
    captureTableStateHasBeneath = $false
    note = 'git show HEAD:src/integration/presentation-state.js has no beneath in INV_FIELDS or the investigators mapping'
  }
  workingTreeFix = @{
    presentationStateHasBeneath = $true
    regressionTest = 'tests/state-presentation.test.mjs :: 演出快照保留本人「下方」牌，其他座位只拿到公开张数 (PASS)'
  }
  staticRefreshNoFlicker = @{
    run = 'monitor-2026-10-26T14-12-31-331Z'
    refreshSteps = @('refresh-1', 'refresh-2', 'refresh-3', 'refresh-spam-3', 'timeline-toggle')
    anomalies = 'none: every render kept .ah-beneath-row, art nodes retained'
  }
  checkpointReplayFlicker = @{
    run = 'monitor-2026-10-26T14-12-31-331Z'
    step = 'direct-investigate-then-refresh'
    renders = $monitorStep.renders
    rendersWithoutBeneathRow = 1
    gap = ($monitorStep.rowStates | ForEach-Object { [ordered]@{ t = $_.t; rowState = $_.sig; revision = $_.rev; presenting = $_.presenting } })
    stack = (($monitorStep.anomalies | Where-Object { $_.kind -eq 'rowGone' }) | Select-Object -First 1)
  }
  abControl = [ordered]@{
    run = 'ab-control-2026-10-26T14-15-48-945Z'
    sessionId = $abControl.sessionId
    staleUiRevision = $abControl.staleUiRevision
    serverRevision = $abControl.serverRevisionAfterRefresh
    renders = $abControl.renders
    rendersWithoutBeneathRow = $abControl.rendersWithoutBeneathRow
    totalGapMs = $abControl.totalGapMs
    gaps = $abControl.rowGaps
    hookStack = $abControl.rendersWithoutBeneathRowSample[0].stack
  }
  abPatched = [ordered]@{
    run = 'ab-patched-2026-10-26T14-16-07-436Z'
    sessionId = $abPatched.sessionId
    renders = $abPatched.renders
    rendersWithoutBeneathRow = $abPatched.rendersWithoutBeneathRow
    totalGapMs = $abPatched.totalGapMs
  }
  refreshVisual = [ordered]@{
    run = 'evidence2-2026-10-26T14-20-00-072Z'
    beforeCards = $ev2Control.before.cards
    gapDurationMs = $ev2Control.gapDurationMs
    afterCards = $ev2Control.gapEnd.cards
    note = 'natural (no click-through) run evidence2-2026-10-26T14-19-01-714Z kept the row absent for the whole 18s sample window'
  }
  refreshVisualPatched = [ordered]@{
    run = 'evidence2-patched-2026-10-26T14-22-43-272Z'
    beforeCards = $ev2Patched.before.cards
    gapStart = $ev2Patched.gapStart
    samples = $ev2Patched.samples.Count
  }
  uiEndTurn = [ordered]@{
    run = 'uiturn-2026-10-26T14-21-01-331Z'
    sessionId = $uiturnJson.sessionId
    frames = $uiturnJson.frames
    framesWithoutRow = $uiturnJson.framesWithoutRow
    totalGapMs = $uiturnJson.totalGapMs
    gaps = $uiturnJson.gaps
    screenshots = @('uiturn-1-before.png', 'uiturn-2-during.png', 'uiturn-3-after.png')
  }
  serverEventEvidence = [ordered]@{
    sessionId = 'bg-4-mvpc2wer'
    stateBeneath = @('01051', '01066')
    checkpointEvent = 'seq6 presentation/checkpoint tableState.investigators[0] has hand (8) but no beneath key'
  }
}
$json = $measurements | ConvertTo-Json -Depth 8
Set-Content -Path (Join-Path $ev 'measurements.json') -Value $json -Encoding utf8
Write-Host "evidence dir: $ev"
Get-ChildItem $ev | Select-Object Length, Name | Format-Table -AutoSize
