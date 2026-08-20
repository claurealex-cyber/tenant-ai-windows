# Generate scripts\win\tenant-ai.ico (multi-size, PNG-compressed frames) plus a
# 256 px PNG preview, with nothing but System.Drawing. Used by make-shortcut.ps1.
#   powershell -ExecutionPolicy Bypass -File scripts\win\make-icon.ps1
param(
  [string]$Out = (Join-Path $PSScriptRoot 'tenant-ai.ico'),
  [string]$Preview = (Join-Path $PSScriptRoot 'tenant-ai-icon-256.png')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Tile([int]$px) {
  $bmp = [System.Drawing.Bitmap]::new($px, $px, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  [float]$s = $px

  # rounded square, indigo gradient
  [float]$r = $s * 0.22
  [float]$d = $r * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc([float]0, [float]0, $d, $d, [float]180, [float]90)
  $path.AddArc([float]($s - $d), [float]0, $d, $d, [float]270, [float]90)
  $path.AddArc([float]($s - $d), [float]($s - $d), $d, $d, [float]0, [float]90)
  $path.AddArc([float]0, [float]($s - $d), $d, $d, [float]90, [float]90)
  $path.CloseFigure()
  $c1 = [System.Drawing.Color]::FromArgb(255, 58, 104, 224)
  $c2 = [System.Drawing.Color]::FromArgb(255, 26, 58, 143)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new($s, $s), $c1, $c2)
  $g.FillPath($brush, $path)

  # house: roof triangle + body + chimney, white
  $white = [System.Drawing.Brushes]::White
  $roof = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($s * 0.50, $s * 0.16),
    [System.Drawing.PointF]::new($s * 0.85, $s * 0.47),
    [System.Drawing.PointF]::new($s * 0.15, $s * 0.47)
  )
  $g.FillPolygon($white, $roof)
  $g.FillRectangle($white, [float]($s * 0.24), [float]($s * 0.45), [float]($s * 0.52), [float]($s * 0.38))
  $g.FillRectangle($white, [float]($s * 0.66), [float]($s * 0.19), [float]($s * 0.09), [float]($s * 0.17))

  # "AI" inside the body, in the tile colour (skipped on tiny sizes)
  if ($px -ge 24) {
    $font = [System.Drawing.Font]::new('Segoe UI', [float]($s * 0.30), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = [System.Drawing.StringFormat]::new()
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 34, 70, 170))
    $rect = [System.Drawing.RectangleF]::new([float]($s * 0.24), [float]($s * 0.47), [float]($s * 0.52), [float]($s * 0.36))
    $g.DrawString('AI', $font, $ink, $rect, $fmt)
    $font.Dispose(); $ink.Dispose()
  }
  $g.Dispose(); $brush.Dispose(); $path.Dispose()
  return ,$bmp
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$frames = New-Object System.Collections.ArrayList
foreach ($sz in $sizes) {
  $bmp = New-Tile $sz
  $ms = [IO.MemoryStream]::new()
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($sz -eq 256) { $bmp.Save($Preview, [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
  [void]$frames.Add(@{ size = $sz; bytes = $ms.ToArray() })
}

# ICO container: ICONDIR + ICONDIRENTRY[] + PNG payloads (PNG frames are valid since Vista)
$fs = [IO.File]::Create($Out)
$bw = [IO.BinaryWriter]::new($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $dim = if ($f.size -ge 256) { 0 } else { $f.size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$f.bytes.Length); $bw.Write([uint32]$offset)
  $offset += $f.bytes.Length
}
foreach ($f in $frames) { $bw.Write([byte[]]$f.bytes) }
$bw.Flush(); $fs.Close()
"wrote $Out ($((Get-Item $Out).Length) bytes, sizes $($sizes -join '/')) and $Preview"
