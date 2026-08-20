# Infra chaos for the M2/M7 gates (Windows). Run while the app is serving and
# while http-load.mjs is hammering /health/deep in another window.
#
#   .\scripts\stress\chaos.ps1 -Scenario postgres-restart   # stop 30s, start, expect recovery
#   .\scripts\stress\chaos.ps1 -Scenario redis-restart      # stop 60s, start; webhooks must stay up
#   .\scripts\stress\chaos.ps1 -Scenario docker-restart     # restart Docker Desktop engine
#   .\scripts\stress\chaos.ps1 -Scenario all
param(
  [ValidateSet('postgres-restart','redis-restart','docker-restart','all')]
  [string]$Scenario = 'postgres-restart',
  [int]$ApiPort = 3001
)
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))

function Health() {
  try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3).Content | ConvertFrom-Json } catch { $null }
}
function Wait-Status([string]$want, [int]$timeout) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) { $h = Health; if ($h -and $h.status -eq $want) { return $true }; Start-Sleep 1 }
  return $false
}
function Wait-Field([string]$field, $want, [int]$timeout) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) { $h = Health; if ($h -and $h.$field -eq $want) { return $true }; Start-Sleep 1 }
  return $false
}

$results = @()
if ($Scenario -in 'postgres-restart','all') {
  ">> postgres: stop for 30s"
  docker compose stop postgres | Out-Null
  $down = Wait-Status 'down' 30
  Start-Sleep 30
  docker compose start postgres | Out-Null
  $back = Wait-Status 'ok' 60
  $results += [pscustomobject]@{ scenario='postgres-restart'; sawDown=$down; recovered=$back }
}
if ($Scenario -in 'redis-restart','all') {
  ">> redis: stop for 60s (server must stay up, redisConnected=false)"
  docker compose stop redis | Out-Null
  $down = Wait-Field 'redisConnected' $false 30
  $stillUp = (Health) -ne $null
  Start-Sleep 60
  docker compose start redis | Out-Null
  $back = Wait-Field 'redisConnected' $true 90
  $results += [pscustomobject]@{ scenario='redis-restart'; sawDown=$down; serverStayedUp=$stillUp; recovered=$back }
}
if ($Scenario -in 'docker-restart','all') {
  ">> docker: restart Docker Desktop (containers come back via restart: unless-stopped)"
  Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 5
  Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  $engine = $false
  for ($i = 0; $i -lt 180; $i++) { docker info 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $engine = $true; break }; Start-Sleep 1 }
  $back = Wait-Status 'ok' 120
  $results += [pscustomobject]@{ scenario='docker-restart'; engineBack=$engine; recovered=$back }
}
$results | Format-Table -AutoSize | Out-String
$bad = @($results | Where-Object { $_.recovered -ne $true }).Count
if ($bad -eq 0) { "[OK] all scenarios recovered without a restart"; exit 0 } else { "[FAIL] $bad scenario(s) did not recover"; exit 1 }
