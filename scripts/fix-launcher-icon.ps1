Add-Type -AssemblyName System.Drawing

$src = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\assets\icon.png'
$out = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\assets\icon-launcher.png'
$img = [System.Drawing.Bitmap]::FromFile($src)
$w = $img.Width
$h = $img.Height

function Is-Checker($c) {
  $maxC = [math]::Max($c.R, [math]::Max($c.G, $c.B))
  $minC = [math]::Min($c.R, [math]::Min($c.G, $c.B))
  return (($maxC - $minC) -lt 14) -and ($maxC -gt 225)
}

# 1) bbox of non-checkerboard pixels
$minX = $w; $minY = $h; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $px = $img.GetPixel($x, $y)
    if (-not (Is-Checker $px) -and $px.A -gt 8) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$bw = $maxX - $minX + 1
$bh = $maxY - $minY + 1
Write-Output "emblem bbox: ${minX},${minY} to ${maxX},${maxY} (${bw}x${bh})"

# 2) corner radius: walk each corner diagonal inward until non-checker found
function Get-CornerRadius($img, $minX, $minY, $maxX, $maxY, $cx0, $cy0, $dx, $dy) {
  $r = 0
  $x = $cx0; $y = $cy0
  while ($x -ge $minX -and $x -le $maxX -and $y -ge $minY -and $y -le $maxY) {
    $px = $img.GetPixel($x, $y)
    if (-not (Is-Checker $px)) { break }
    $r++
    $x += $dx; $y += $dy
  }
  return $r
}
$rTL = Get-CornerRadius $img $minX $minY $maxX $maxY $minX $minY 1 1
$rTR = Get-CornerRadius $img $minX $minY $maxX $maxY $maxX $minY -1 1
$rBL = Get-CornerRadius $img $minX $minY $maxX $maxY $minX $maxY 1 -1
$rBR = Get-CornerRadius $img $minX $minY $maxX $maxY $maxX $maxY -1 -1
Write-Output "corner radii: TL=$rTL TR=$rTR BL=$rBL BR=$rBR"

# 3) crop + blank ONLY corner cutouts (checker inside the rounded-corner arcs); keep all other pixels
$crop = New-Object System.Drawing.Bitmap $bw, $bh
for ($y = 0; $y -lt $bh; $y++) {
  for ($x = 0; $x -lt $bw; $x++) {
    $px = $img.GetPixel($minX + $x, $minY + $y)
    if (Is-Checker $px) {
      $dx = [math]::Min($x, $bw - 1 - $x)
      $dy = [math]::Min($y, $bh - 1 - $y)
      $dist = [math]::Sqrt($dx * $dx + $dy * $dy)
      if ($dist -lt 200) { $px = [System.Drawing.Color]::FromArgb(0, 0, 0, 0) }
    }
    $crop.SetPixel($x, $y, $px)
  }
}

# 4) glow ring color: average of non-checker pixels within 6px of the bbox edge
$rSum = 0; $gSum = 0; $bSum = 0; $n = 0
for ($y = 0; $y -lt $bh; $y++) {
  for ($x = 0; $x -lt $bw; $x++) {
    $px = $crop.GetPixel($x, $y)
    if ($px.A -gt 8) {
      $dx = [math]::Min($x, $bw - 1 - $x)
      $dy = [math]::Min($y, $bh - 1 - $y)
      if ([math]::Min($dx, $dy) -le 6) {
        $rSum += $px.R; $gSum += $px.G; $bSum += $px.B; $n++
      }
    }
  }
}
$r = [int]($rSum / $n); $g = [int]($gSum / $n); $b = [int]($bSum / $n)
$hex = ("#{0:X2}{1:X2}{2:X2}" -f $r, $g, $b)
Write-Output "glow ring color: $hex (from $n px)"

# 5) compose 1024x1024: glow fill + whole emblem fit inside (no cropping, letterbox blends into glow)
$canvas = New-Object System.Drawing.Bitmap 1024, 1024
$gr = [System.Drawing.Graphics]::FromImage($canvas)
$gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gr.Clear([System.Drawing.Color]::FromArgb(255, $r, $g, $b))
$scale = [math]::Min(1024.0 / $bw, 1024.0 / $bh) * 0.94
$dw = [int]($bw * $scale)
$dh = [int]($bh * $scale)
$dstRect = New-Object System.Drawing.Rectangle([int]((1024 - $dw) / 2), [int]((1024 - $dh) / 2), $dw, $dh)
$gr.DrawImage($crop, $dstRect, (New-Object System.Drawing.Rectangle(0, 0, $bw, $bh)), [System.Drawing.GraphicsUnit]::Pixel)
$gr.Dispose()
$canvas.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$crop.Dispose()
$img.Dispose()
Write-Output "saved: $out"
Write-Output "BG_HEX=$hex"
