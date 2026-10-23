# Makes the extension icons (extension/icons/icon-16/48/128.png) from one large PNG with a
# transparent background: crops to the artwork, centres it on a square, and leaves Chrome's
# recommended padding (128 px icon: 96 px artwork + 16 px each side).
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1 [assets\icon-source.png]
param([string]$Source = (Join-Path $PSScriptRoot "..\assets\icon-source.png"))

Add-Type -AssemblyName System.Drawing
if (-not (Test-Path -LiteralPath $Source)) { Write-Error "File not found: $Source"; exit 1 }
$Source = (Resolve-Path -LiteralPath $Source).Path
$outDir = Join-Path $PSScriptRoot "..\extension\icons"

$src = New-Object System.Drawing.Bitmap $Source
try {
  # Artwork bounds: pixels that aren't (nearly) transparent. Sampled every 2 px; good enough.
  $minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0
  for ($y = 0; $y -lt $src.Height; $y += 2) {
    for ($x = 0; $x -lt $src.Width; $x += 2) {
      if ($src.GetPixel($x, $y).A -gt 20) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $artW = $maxX - $minX + 1; $artH = $maxY - $minY + 1

  # size -> padding (px of transparent space on each side)
  $targets = [ordered]@{ 16 = 0; 48 = 2; 128 = 16 }
  foreach ($size in $targets.Keys) {
    $pad = $targets[$size]
    $box = $size - 2 * $pad
    $scale = [Math]::Min($box / $artW, $box / $artH)
    $drawW = $artW * $scale; $drawH = $artH * $scale
    $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $dest = New-Object System.Drawing.RectangleF ([single](($size - $drawW) / 2)), ([single](($size - $drawH) / 2)), ([single]$drawW), ([single]$drawH)
    $srcRect = New-Object System.Drawing.RectangleF ([single]$minX), ([single]$minY), ([single]$artW), ([single]$artH)
    $g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $file = Join-Path $outDir "icon-$size.png"
    $out.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
    Write-Output "wrote $file"
  }
} finally {
  $src.Dispose()
}
