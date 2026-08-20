# Wire this instance's ngrok tunnel (Windows):
#   1. store the authtoken in the ngrok agent config (once per machine)
#   2. set PUBLIC_URL=https://<domain> in .env (the launcher starts the tunnel from then on)
#   3. bring a test tunnel up for a few seconds and prove the public URL answers /health
#
#   npm run win:ngrok -- -Domain your-name.ngrok-free.app [-AuthToken <token>]
#   (or run `ngrok config add-authtoken <token>` yourself first and omit -AuthToken)
#
# Domain: reserve one at https://dashboard.ngrok.com/domains (the free plan gives
# one static *.ngrok-free.app domain). This instance needs its OWN domain - the
# Mac instance keeps its own; two agents cannot serve the same domain at once.
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$AuthToken,
  [int]$ApiPort = 3001,
  [switch]$NoTest
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$Domain = ($Domain -replace '^https?://', '').TrimEnd('/')

$ngrok = $env:NGROK_PATH
if (-not $ngrok) { $ngrok = (Get-Command ngrok.exe -ErrorAction SilentlyContinue).Source }
if (-not $ngrok) { throw "ngrok.exe not found - winget install Ngrok.Ngrok (do NOT 'ngrok update': Defender quarantines the self-updated agent)" }
"ngrok: $ngrok ($(& $ngrok version))"

if ($AuthToken) {
  & $ngrok config add-authtoken $AuthToken | Out-Null
  "authtoken stored in the ngrok agent config"
}
$cfgOk = $false
try { & $ngrok config check 2>&1 | Out-Null; $cfgOk = ($LASTEXITCODE -eq 0) } catch {}
if (-not $cfgOk) { throw "no valid ngrok config/authtoken - run: ngrok config add-authtoken <token>  (https://dashboard.ngrok.com/get-started/your-authtoken)" }
"ngrok config: ok"

# PUBLIC_URL in .env (create the line if missing; keep everything else as is)
$envFile = Join-Path $root '.env'
$url = "https://$Domain"
$lines = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
if ($lines -match '^PUBLIC_URL=') { $lines = $lines | ForEach-Object { if ($_ -match '^PUBLIC_URL=') { "PUBLIC_URL=$url" } else { $_ } } }
else { $lines += "PUBLIC_URL=$url" }
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
"PUBLIC_URL=$url written to .env"

if ($NoTest) { exit 0 }

# Test: if the API is up, tunnel it; otherwise tunnel a throwaway local listener.
$apiUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3; $apiUp = $true } catch {}
$target = if ($apiUp) { $ApiPort } else { $ApiPort }
"test tunnel: https://$Domain -> localhost:$target (API up: $apiUp)"
# If the launcher already runs a tunnel for this domain, leave it alone.
$existing = $null
try { $existing = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4040/api/tunnels -TimeoutSec 2).Content } catch {}
$started = $null
if ($existing -and $existing -match [regex]::Escape($Domain)) {
  "an ngrok agent already serves $Domain - testing through it"
} else {
  $started = Start-Process $ngrok -ArgumentList @('http', "--domain=$Domain", "$target", '--log=stdout') -WindowStyle Hidden -PassThru
  Start-Sleep 4
}
$ok = $false; $detail = ''
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "https://$Domain/health" -TimeoutSec 8
    $ok = ($r.StatusCode -eq 200 -or $r.StatusCode -eq 503); $detail = "HTTP $($r.StatusCode) $($r.Content.Substring(0, [Math]::Min(80, $r.Content.Length)))"
  } catch { $detail = $_.Exception.Message; Start-Sleep 2 }
}
if ($started) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
if ($ok) {
  "[OK] https://$Domain/health answered through the tunnel: $detail"
  ""
  "Next: restart the app (shortcut / start.cmd) - the launcher now starts the tunnel itself."
  "Webhooks for this instance: https://$Domain/telnyx/sms (Telnyx), https://$Domain/twilio/... (Twilio)."
  exit 0
} else {
  "[FAIL] https://$Domain/health did not answer: $detail"
  "Check: domain reserved in your ngrok account? agent authtoken belongs to the same account? API running on :$ApiPort?"
  exit 1
}
