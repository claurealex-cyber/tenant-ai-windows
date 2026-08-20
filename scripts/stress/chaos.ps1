# Infra chaos for the M2/M7 gates (Windows). Run while the app is serving and
# while http-load.mjs is hammering /health/deep in another window.
#
#   .\scripts\stress\chaos.ps1 -Scenario postgres-restart   # stop 30s, start, expect recovery
#   .\scripts\stress\chaos.ps1 -Scenario redis-restart      # stop 60s, start; webhooks must stay up
#   .\scripts\stress\chaos.ps1 -Scenario infra-restart      # native: all services down/up; docker: restart Docker Desktop
#   .\scripts\stress\chaos.ps1 -Scenario all
#
# -Infra native|docker|auto (default auto): native when the app runs on the
# scripts/infra.mjs processes (the default on Windows), docker when it runs
# on docker compose. 'docker-restart' is accepted as an alias of infra-restart.
param(
  [ValidateSet('postgres-restart','redis-restart','infra-restart','docker-restart','all')]
  [string]$Scenario = 'postgres-restart',
  [ValidateSet('auto','native','docker')]
  [string]$Infra = 'auto',
  [int]$ApiPort = 3001
)
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
if ($Scenario -eq 'docker-restart') { $Scenario = 'infra-restart' }

if ($Infra -eq 'auto') {
  $Infra = if ($env:INFRA_MODE -in 'native','docker') { $env:INFRA_MODE }
           elseif (Test-Path '.local\infra\data\postgres\PG_VERSION') { 'native' }
           else { 'docker' }
}
">> infra mode: $Infra"

function Stop-Svc([string]$name)  { if ($Infra -eq 'native') { node scripts\infra.mjs down $name | Out-Null } else { docker compose stop $name | Out-Null } }
function Start-Svc([string]$name) { if ($Infra -eq 'native') { node scripts\infra.mjs up $name | Out-Null }   else { docker compose start $name | Out-Null } }

function Health() {
  # /health answers 503 (status "down") while the DB is unreachable - after
  # Prisma's ~4 s reconnect attempt, hence the 8 s probe timeout. Windows
  # PowerShell throws on non-2xx, so read the body out of the exception too.
  try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 8).Content | ConvertFrom-Json }
  catch {
    # Both Windows PowerShell 5.1 and pwsh 7 put the response body here.
    $body = $_.ErrorDetails.Message
    if (-not $body -and $_.Exception.Response) { try { $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $sr.ReadToEnd() } catch {} }
    if ($body) { try { $body | ConvertFrom-Json } catch { $null } } else { $null }
  }
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
  Stop-Svc postgres
  $down = Wait-Status 'down' 30
  Start-Sleep 30
  Start-Svc postgres
  $back = Wait-Status 'ok' 60
  $results += [pscustomobject]@{ scenario='postgres-restart'; sawDown=$down; recovered=$back }
}
if ($Scenario -in 'redis-restart','all') {
  ">> redis: stop for 60s (server must stay up, redisConnected=false)"
  Stop-Svc redis
  $down = Wait-Field 'redisConnected' $false 30
  $stillUp = (Health) -ne $null
  Start-Sleep 60
  Start-Svc redis
  $back = Wait-Field 'redisConnected' $true 90
  $results += [pscustomobject]@{ scenario='redis-restart'; sawDown=$down; serverStayedUp=$stillUp; recovered=$back }
}
if ($Scenario -in 'infra-restart','all') {
  if ($Infra -eq 'native') {
    ">> infra: stop every native service, wait 10s, start them again"
    node scripts\infra.mjs down | Out-Null
    $down = Wait-Status 'down' 30
    Start-Sleep 10
    node scripts\infra.mjs up | Out-Null
    $engine = ($LASTEXITCODE -eq 0)
  } else {
    ">> docker: restart Docker Desktop (containers come back via restart: unless-stopped)"
    Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 5
    Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    $engine = $false
    for ($i = 0; $i -lt 180; $i++) { docker info 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $engine = $true; break }; Start-Sleep 1 }
    $down = $null
  }
  $back = Wait-Status 'ok' 120
  $results += [pscustomobject]@{ scenario='infra-restart'; sawDown=$down; infraBack=$engine; recovered=$back }
}
$results | Format-Table -AutoSize | Out-String
$bad = @($results | Where-Object { $_.recovered -ne $true }).Count
if ($bad -eq 0) { "[OK] all scenarios recovered without a restart"; exit 0 } else { "[FAIL] $bad scenario(s) did not recover"; exit 1 }
