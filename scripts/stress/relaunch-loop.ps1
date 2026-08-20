# Relaunch/takeover loop for the Windows launcher (M4 gate).
#
#   .\scripts\stress\relaunch-loop.ps1 -Cycles 20 [-LauncherArgs '--no-open','--no-ngrok','--no-build']
#
# Each cycle starts a new launcher while the previous one is still serving,
# waits for the API /health to answer again, and asserts: the previous
# launcher PID is gone, exactly one node.exe is listening on each of
# 3000/3002/<api port>, and no ngrok/node orphans accumulate. Requires Docker
# infra (or DATABASE_URL pointing at a running Postgres + --no-docker).
param(
  [int]$Cycles = 10,
  [string[]]$LauncherArgs = @('--no-open', '--no-ngrok', '--no-build'),
  [int]$ApiPort = 3001,
  [int]$TimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

# Normalize launcher args: when invoked via `powershell -File … -LauncherArgs '--a','--b'`
# from another shell the whole thing arrives as ONE string (quotes included).
$LauncherArgs = @($LauncherArgs | ForEach-Object { ($_ -split '[\s,]+') } | ForEach-Object { $_.Trim("'", '"') } | Where-Object { $_ })
">> launcher args: $($LauncherArgs -join ' ')"

function Wait-Health([int]$port, [int]$timeout) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3; if ($r.StatusCode -in 200,503) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Listeners([int]$port) { @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) }

$nodeBefore = @(Get-Process node -ErrorAction SilentlyContinue).Count
$failures = 0
$prevPid = $null
for ($i = 1; $i -le $Cycles; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath 'node' -ArgumentList (@('scripts\launch.mjs') + $LauncherArgs) -PassThru -WindowStyle Hidden -WorkingDirectory $root
  $pidFileOk = $false
  for ($w = 0; $w -lt 20; $w++) { if ((Test-Path .launcher.pid) -and ((Get-Content .launcher.pid) -eq "$($p.Id)")) { $pidFileOk = $true; break }; Start-Sleep -Milliseconds 500 }
  $healthy = Wait-Health $ApiPort $TimeoutSec
  $prevGone = if ($prevPid) { -not (Get-Process -Id $prevPid -ErrorAction SilentlyContinue) } else { $true }
  # give the old children a moment to be reaped
  Start-Sleep -Seconds 2
  $l3000 = Listeners 3000; $l3002 = Listeners 3002; $lapi = Listeners $ApiPort
  $ngrok = @(Get-Process ngrok -ErrorAction SilentlyContinue).Count
  $ok = $pidFileOk -and $healthy -and $prevGone -and ($l3000.Count -eq 1) -and ($l3002.Count -eq 1) -and ($lapi.Count -eq 1)
  if (-not $ok) { $failures++ }
  "{0} cycle {1}/{2}: launcher pid {3}, healthy={4} in {5}s, prevGone={6}, listeners 3000={7} 3002={8} api={9}, ngrok={10}" -f ($(if ($ok) {'[OK]'} else {'[FAIL]'})), $i, $Cycles, $p.Id, $healthy, [int]$sw.Elapsed.TotalSeconds, $prevGone, $l3000.Count, $l3002.Count, $lapi.Count, $ngrok
  $prevPid = $p.Id
}

# Final stop: create the stop-file (what a relaunch does) and wait for exit
">> stopping final instance"
Set-Content .launcher.stop "$PID"
for ($w = 0; $w -lt 60; $w++) { if (-not (Get-Process -Id $prevPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 2
$nodeAfter = @(Get-Process node -ErrorAction SilentlyContinue).Count
$orphans = @(Listeners 3000) + @(Listeners 3002) + @(Listeners $ApiPort)
"node.exe before={0} after={1}; leftover listeners={2}" -f $nodeBefore, $nodeAfter, $orphans.Count
if ($orphans.Count -gt 0) { $failures++ ; "[FAIL] orphaned listeners: $($orphans -join ', ')" }
if ($failures -eq 0) { "[OK] $Cycles/$Cycles takeovers clean"; exit 0 } else { "[FAIL] $failures failure(s)"; exit 1 }
