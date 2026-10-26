Add-Type -AssemblyName System.Drawing
$cmp = 'G:\boardgame-hall-ai\.tmp-ui-bug\reports\shots\cmp'
$items = @(
  @{ file = 'user.png'; title = '用户截图（screen.png）'; gearCy = 166.5; portCy = 136.6; delta = 'Δ≈-18.7 CSS px'; good = $false },
  @{ file = 'head.png'; title = 'HEAD v0.3.1 复现'; gearCy = 166.5; portCy = 136.9; delta = 'Δ=-18.5 CSS px'; good = $false },
  @{ file = 'fix.png';  title = 'WIP 修复后';        gearCy = 166.5; portCy = 166.5; delta = 'Δ=0 CSS px'; good = $true }
)
$rx = 236; $ry = 86; $rw = 320; $rh = 160; $zoom = 2
$labelH = 30
$gap = 10
$pw = $rw * $zoom; $ph = $rh * $zoom
$W = $pw * 3 + $gap * 2
$H = $ph + $labelH
$out = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.Clear([System.Drawing.Color]::FromArgb(255, 14, 16, 18))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 10.5)
$monoFont = New-Object System.Drawing.Font('Consolas', 10)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 235, 235, 235))
$cyan = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 70, 215, 255), 1.2)
$magenta = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 110, 215), 1.2)
$okPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 110, 230, 140), 2)
$badPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 155, 80), 2)
$dimPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 220, 220, 220), 1)
$dimPen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$backBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 0, 0, 0))
for ($i = 0; $i -lt 3; $i++) {
  $it = $items[$i]
  $src = [System.Drawing.Bitmap]::FromFile("$cmp\$($it.file)")
  $x = $i * ($pw + $gap)
  $destRect = New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)
  $srcRect = New-Object System.Drawing.Rectangle($rx, $ry, $rw, $rh)
  $bmp = New-Object System.Drawing.Bitmap($pw, $ph)
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $gg.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $gg.Dispose()
  $g.DrawImage($bmp, $x, $labelH)
  $bmp.Dispose(); $src.Dispose()
  $g.DrawString($it.title + '   ' + $it.delta, $titleFont, $white, [single]$x, [single]4)
  # guides: gear center / portrait center
  $gcy = ($it.gearCy - $ry) * $zoom
  $pcy = ($it.portCy - $ry) * $zoom
  $g.DrawLine($cyan, [single]($x + 2), [single]($labelH + $gcy), [single]($x + $pw - 2), [single]($labelH + $gcy))
  $g.DrawLine($magenta, [single]($x + 2), [single]($labelH + $pcy), [single]($x + $pw - 2), [single]($labelH + $pcy))
  $mx = $x + 16
  $g.DrawLine($dimPen, [single]$mx, [single]($labelH + $pcy), [single]$mx, [single]($labelH + $gcy))
  $txt = $it.delta
  $sz = $g.MeasureString($txt, $monoFont)
  $ty = $labelH + ($pcy + $gcy) / 2 - $sz.Height / 2
  $g.FillRectangle($backBrush, [single]($x + 22), [single]($ty), [single]($sz.Width + 6), [single]($sz.Height))
  $g.DrawString($txt, $monoFont, $white, [single]($x + 25), [single]$ty)
  $pen = if ($it.good) { $okPen } else { $badPen }
  $g.DrawRectangle($pen, $x, $labelH, $pw - 1, $ph - 1)
}
$g.DrawString('— 齿轮中心   — 头像中心', $monoFont, $white, [single]8, [single]($H - 18))
$g.Dispose()
$out.Save("$cmp\compare-zoom-3up.png", [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
Write-Host 'saved compare-zoom-3up.png'
