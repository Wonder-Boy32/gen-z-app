Add-Type -AssemblyName System.Drawing

$src = 'C:\Users\USER\OneDrive\Desktop\gen-z-app\assets\icon.png'
$img = [System.Drawing.Bitmap]::FromFile($src)

# corner samples
$pts = @{ 'TL(5,5)' = @(5,5); 'TR(1018,5)' = @(1018,5); 'BL(5,1018)' = @(5,1018); 'BR(1018,1018)' = @(1018,1018); 'C(512,512)' = @(512,512) }
foreach ($k in $pts.Keys) {
  $c = $img.GetPixel($pts[$k][0], $pts[$k][1])
  Write-Output ("{0}: {1},{2},{3} a={4}" -f $k, $c.R, $c.G, $c.B, $c.A)
}

# horizontal scanline y=512 every 64px
$row = @()
for ($x = 0; $x -lt 1024; $x += 64) {
  $c = $img.GetPixel($x, 512)
  $row += ("{0}:{1},{2},{3}" -f $x, $c.R, $c.G, $c.B)
}
Write-Output ("scanline y=512: " + ($row -join '  '))

# vertical scanline x=512 every 64px
$col = @()
for ($y = 0; $y -lt 1024; $y += 64) {
  $c = $img.GetPixel(512, $y)
  $col += ("{0}:{1},{2},{3}" -f $y, $c.R, $c.G, $c.B)
}
Write-Output ("scanline x=512: " + ($col -join '  '))

# white pixel count (all channels > 245) vs total
$whiteCount = 0
for ($y = 0; $y -lt 1024; $y += 4) {
  for ($x = 0; $x -lt 1024; $x += 4) {
    $c = $img.GetPixel($x, $y)
    if ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245) { $whiteCount++ }
  }
}
Write-Output ("sampled white fraction (every 4th px): {0:P1}" -f ($whiteCount / 65536.0))

# save corner crops for visual inspection
$tl = New-Object System.Drawing.Bitmap 200, 200
$g1 = [System.Drawing.Graphics]::FromImage($tl)
$g1.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,200,200)), (New-Object System.Drawing.Rectangle(0,0,200,200)), [System.Drawing.GraphicsUnit]::Pixel)
$g1.Dispose()
$tl.Save('C:\Users\USER\OneDrive\Desktop\gen-z-app\scripts\corner-tl.png', [System.Drawing.Imaging.ImageFormat]::Png)
$tl.Dispose()

$ct = New-Object System.Drawing.Bitmap 400, 400
$g2 = [System.Drawing.Graphics]::FromImage($ct)
$g2.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,400,400)), (New-Object System.Drawing.Rectangle(312,312,400,400)), [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()
$ct.Save('C:\Users\USER\OneDrive\Desktop\gen-z-app\scripts\center.png', [System.Drawing.Imaging.ImageFormat]::Png)
$ct.Dispose()
$img.Dispose()
Write-Output "crops saved"
