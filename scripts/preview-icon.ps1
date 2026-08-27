Add-Type -AssemblyName System.Drawing

$newIcon = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\assets\icon-launcher.png'
$oldIcon = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\assets\icon.png'
$preview = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\scripts\icon-preview.png'

# corner artifact check on the new icon (top-right corner region, dist<64 from corner)
$im = [System.Drawing.Bitmap]::FromFile($newIcon)
$fill = $im.GetPixel(1023, 1023)
$bad = 0
for ($y = 1024 - 64; $y -lt 1024; $y++) {
  for ($x = 1024 - 64; $x -lt 1024; $x++) {
    $dx = 1023 - $x; $dy = 1023 - $y
    if ([math]::Sqrt($dx * $dx + $dy * $dy) -lt 60) {
      $c = $im.GetPixel($x, $y)
      if ([math]::Abs($c.R - $fill.R) -gt 12 -or [math]::Abs($c.G - $fill.G) -gt 12 -or [math]::Abs($c.B - $fill.B) -gt 12) { $bad++ }
    }
  }
}
Write-Output "non-fill pixels in TR corner (dist<60): $bad"
$im.Dispose()

# ---- preview mockup ----
$W = 1240; $H = 640
$canvas = New-Object System.Drawing.Bitmap $W, $H
$gr = [System.Drawing.Graphics]::FromImage($canvas)
$gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
# dark wallpaper gradient
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 18, 26, 48), [System.Drawing.Color]::FromArgb(255, 8, 12, 26), 90)
$gr.FillRectangle($brush, $rect)
$brush.Dispose()

function Draw-MaskedIcon($g, $bmp, $cx, $cy, $size, $shape) {
  $x = $cx - $size / 2; $y = $cy - $size / 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($shape -eq 'circle') {
    $path.AddEllipse($x, $y, $size, $size)
  } else {
    $r = $size * 0.22
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $size - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $size - $d, $y + $size - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
  }
  $g.SetClip($path)
  $g.DrawImage($bmp, $x, $y, $size, $size)
  $g.ResetClip()
  $path.Dispose()
}

$oldBmp = [System.Drawing.Bitmap]::FromFile($oldIcon)
$newBmp = [System.Drawing.Bitmap]::FromFile($newIcon)
$size = 200
# 1) OLD icon (as-is, reveals white box)
Draw-MaskedIcon $gr $oldBmp 310 260 $size 'squircle'
# 2) NEW icon, Android 14 circle mask (home screen)
Draw-MaskedIcon $gr $newBmp 620 260 $size 'circle'
# 3) NEW icon, squircle mask (app drawer)
Draw-MaskedIcon $gr $newBmp 930 260 $size 'squircle'

$labelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 210, 235))
$font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$smallFont = New-Object System.Drawing.Font('Segoe UI', 11)
$gr.DrawString('BEFORE (white box baked in)', $smallFont, $labelBrush, 310, 470, (New-Object System.Drawing.StringFormat([System.Drawing.StringFormat]::GenericDefault)))
$gr.DrawString('AFTER - home screen', $smallFont, $labelBrush, 620, 470, (New-Object System.Drawing.StringFormat([System.Drawing.StringFormat]::GenericDefault)))
$gr.DrawString('AFTER - app drawer', $smallFont, $labelBrush, 930, 470, (New-Object System.Drawing.StringFormat([System.Drawing.StringFormat]::GenericDefault)))
$titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255))
$titleFont = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$gr.DrawString('GEN Z launcher icon fix', $titleFont, $titleBrush, 60, 60)
$gr.DrawString('No redesign - same logo, checkerboard frame removed', $smallFont, $labelBrush, 60, 100)
$oldBmp.Dispose(); $newBmp.Dispose()
$gr.Dispose()
$canvas.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
Write-Output "preview saved: $preview"
