# Makes a Chrome Web Store screenshot (exactly 1280x800 PNG) from any screenshot: scaled to fit,
# centred, padded with the Web App's dark background. Never stretched.
# Usage: powershell -ExecutionPolicy Bypass -File tools\store-screenshot.ps1 "C:\path\to\screenshot.png"
# (No path: uses the newest file in Pictures\Screenshots.) Output: <name>-1280x800.png next to it.
param([string]$Path)

Add-Type -AssemblyName System.Drawing

if (-not $Path) {
  $dir = Join-Path ([Environment]::GetFolderPath("MyPictures")) "Screenshots"
  $latest = Get-ChildItem $dir -Include *.png, *.jpg, *.jpeg -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Write-Error "No screenshot found in $dir. Pass a file path."; exit 1 }
  $Path = $latest.FullName
}

if (-not (Test-Path -LiteralPath $Path)) { Write-Error "File not found: $Path"; exit 1 }
$Path = (Resolve-Path -LiteralPath $Path).Path

# PowerShell variable names ignore case: keep the canvas and fitted sizes distinctly named.
$CanvasW = 1280; $CanvasH = 800
$src = [System.Drawing.Image]::FromFile($Path)
try {
  $scale = [Math]::Min($CanvasW / $src.Width, $CanvasH / $src.Height)
  $fitW = [int][Math]::Round($src.Width * $scale)
  $fitH = [int][Math]::Round($src.Height * $scale)
  $out = New-Object System.Drawing.Bitmap $CanvasW, $CanvasH
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear([System.Drawing.Color]::FromArgb(13, 19, 28))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, [int](($CanvasW - $fitW) / 2), [int](($CanvasH - $fitH) / 2), $fitW, $fitH)
  $g.Dispose()
  $dest = Join-Path (Split-Path $Path) ([IO.Path]::GetFileNameWithoutExtension($Path) + "-1280x800.png")
  $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Output "Saved $dest (1280x800)"
} finally {
  $src.Dispose()
}
