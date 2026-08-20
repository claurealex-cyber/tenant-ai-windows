# Always-on wrapper for the Tenant AI launcher (Windows, M7).
#
# Runs scripts\launch.mjs --no-open in a loop: if the launcher exits with a
# non-zero code (a server crashed, infra failed, ...), wait and start it again,
# with backoff; if it exits 0 (Ctrl-C, a "relaunch = restart" takeover from a
# double-clicked start.cmd, or an explicit stop), leave it alone. Everything
# the launcher prints goes to .local\log\launcher.log (rotated at 20 MB).
#
# Installed as the "Tenant AI" scheduled task (At log on) by
# scripts\win\install-autostart.ps1; can also be run by hand:
#   powershell -ExecutionPolicy Bypass -File scripts\win\autostart.ps1
param(
  [string[]]$LauncherArgs = @('--no-open'),
  [int]$MaxRestartsPerHour = 10
)
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$logDir = Join-Path $root '.local\log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'launcher.log'

function Log([string]$msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [autostart] $msg"
  $line; Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
function Q([string]$s) { if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
function Rotate() {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) {
    Move-Item -Force $log ($log + '.1')
  }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log 'node.exe not on PATH - install Node.js (winget install OpenJS.NodeJS.LTS)'; exit 1 }

$restarts = @()
Log "starting (args: $($LauncherArgs -join ' '))"
while ($true) {
  Rotate
  $started = Get-Date
  # Inherit this (hidden) console: the launcher's children get no window.
  # cmd.exe appends the tree's stdout/stderr to the log as raw UTF-8 bytes
  # (PowerShell's own >> would transcode through the console codepage and
  # write UTF-16).
  $line = (@($node, 'scripts\launch.mjs') + $LauncherArgs | ForEach-Object { Q $_ }) -join ' '
  & $cmdExe /d /s /c "$line >> $(Q $log) 2>&1"
  $code = $LASTEXITCODE
  $ran = [int]((Get-Date) - $started).TotalSeconds
  if ($code -eq 0) { Log "launcher exited cleanly after ${ran}s (stop / takeover) - not restarting"; break }

  $restarts = @($restarts | Where-Object { $_ -gt (Get-Date).AddHours(-1) }) + (Get-Date)
  if ($restarts.Count -gt $MaxRestartsPerHour) {
    Log "launcher exited with code $code after ${ran}s; $($restarts.Count) restarts in the last hour - giving up (fix the cause, then run start.cmd)"
    exit 1
  }
  $delay = [Math]::Min(300, 5 * [Math]::Pow(2, $restarts.Count - 1))
  Log "launcher exited with code $code after ${ran}s - restart #$($restarts.Count) in ${delay}s"
  Start-Sleep -Seconds $delay
}
exit 0
