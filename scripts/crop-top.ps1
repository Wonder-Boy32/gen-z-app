Add-Type -AssemblyName System.Drawing
$src = "$env:TEMP\around-issue.png"
(New-Object System.Net.WebClient).DownloadFile('https://sc04.alicdn.com/kf/A8bd1b8a2daed4a938a205ad7c9d9a4f5e.jpg', $src)
$img = [System.Drawing.Bitmap]::FromFile($src)
$w = $img.Width
$h = $img.Height
Write-Output "size: ${w}x${h}"
$ch = [int]($h * 0.55)
$crop = New-Object System.Drawing.Bitmap($w, $ch)
$g = [System.Drawing.Graphics]::FromImage($crop)
$srcRect = New-Object System.Drawing.Rectangle(0, 0, $w, $ch)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $ch)
$g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save("$env:TEMP\around-top.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$crop.Dispose()
Write-Output "saved: $env:TEMP\around-top.png"
