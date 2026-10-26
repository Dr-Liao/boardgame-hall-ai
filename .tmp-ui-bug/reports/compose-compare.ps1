Add-Type -AssemblyName System.Drawing
$root = 'G:\boardgame-hall-ai\.tmp-ui-bug'
$cmp = "$root\reports\shots\cmp"
$screen = [System.Drawing.Bitmap]::FromFile("$root\screen.png")
# user crop = same device window used in make-compare.mjs
$uCropRect = New-Object System.Drawing.Rectangle(252, 416, 1030, 390)
$userBmp = New-Object System.Drawing.Bitmap(1030, 390)
$g0 = [System.Drawing.Graphics]::FromImage($userBmp)
$g0.DrawImage($screen, (New-Object System.Drawing.Rectangle(0,0,1030,390)), $uCropRect, [System.Drawing.GraphicsUnit]::Pixel)
$g0.Dispose()
$userBmp.Save("$cmp\user.png", [System.Drawing.Imaging.ImageFormat]::Png)
$userBmp.Dispose()

$head = [System.Drawing.Bitmap]::FromFile("$cmp\head.png")
$fix  = [System.Drawing.Bitmap]::FromFile("$cmp\fix.png")
$user = [System.Drawing.Bitmap]::FromFile("$cmp\user.png")

$panels = @(
  @{ bmp = $user; title = '用户截图（screen.png 裁剪，红圈处）'; gearCy = 166.5; portCy = 136.6; delta = '-18.7 CSS px'; ok = $false },
  @{ bmp = $head; title = 'HEAD v0.3.1 复现：头像中心比齿轮中心高 18.5 CSS px'; gearCy = 166.5; portCy = 136.9; delta = '-18.5 CSS px'; ok = $false },
  @{ bmp = $fix;  title = 'WIP 修复：头像与齿轮垂直居中对齐'; gearCy = 166.5; portCy = 166.5; delta = '0 CSS px'; ok = $true }
)
$gap = 10; $labelH = 34
$W = 1030*3 + $gap*2
$H = 390 + $labelH
$out = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.Clear([System.Drawing.Color]::FromArgb(255, 16, 18, 20))
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 10.5)
$smallFont = New-Object System.Drawing.Font('Consolas', 10)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 236, 236, 236))
$cyan = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 80, 220, 255), 1.6)
$magenta = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 255, 120, 220), 1.6)
$dim = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 150, 150, 150), 1)
$dim.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$okPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 120, 235, 150), 2)
$badPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 255, 160, 90), 2)
for ($i = 0; $i -lt 3; $i++) {
  $p = $panels[$i]
  $x = $i * (1030 + $gap)
  $g.DrawImage($p.bmp, $x, $labelH, 1030, 390)
  $g.DrawString($p.title, $titleFont, $white, [single]$x, [single]4)
  # horizontal guide lines: cyan = gear center, magenta = portrait center
  $g.DrawLine($cyan, [single]($x + 4), [single]($labelH + $p.gearCy), [single]($x + 1030 - 4), [single]($labelH + $p.gearCy))
  $g.DrawLine($magenta, [single]($x + 4), [single]($labelH + $p.portCy), [single]($x + 1030 - 4), [single]($labelH + $p.portCy))
  # delta marker near x=40
  $mx = $x + 26
  $g.DrawLine($dim, [single]$mx, [single]($labelH + $p.portCy), [single]$mx, [single]($labelH + $p.gearCy))
  $deltaTxt = $p.delta
  $g.DrawString($deltaTxt, $smallFont, $white, [single]($x + 34), [single]($labelH + ($p.gearCy + $p.portCy) / 2 - 6))
  # panel border
  $pen = if ($p.ok) { $okPen } else { $badPen }
  $g.DrawRectangle($pen, $x, $labelH, 1029, 389)
  # legend text
  $g.DrawString('— gear center', $smallFont, $cyan.Brush, [single]($x + 8), [single]($labelH + 8))
}
# legend
$g.DrawString('cyan = 齿轮中心线   magenta = 调查员头像中心线', $smallFont, $white, [single]8, [single]($H - 22))
$g.Dispose()
$out.Save("$cmp\compare-3up.png", [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
foreach ($b in @($screen,$head,$fix,$user)) { $b.Dispose() }
Write-Host "saved compare-3up.png"
