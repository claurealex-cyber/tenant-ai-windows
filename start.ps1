# Tenant AI launcher (Windows, PowerShell). Same as start.cmd; all logic is in
# scripts/launch.mjs so macOS and Windows run the identical sequence.
#   .\start.ps1            normal launch (relaunch = restart)
#   .\start.ps1 --no-open  flags are passed straight through to the launcher
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js was not found on PATH. Install it with: winget install OpenJS.NodeJS.LTS"
  exit 1
}
& node scripts\launch.mjs @args
exit $LASTEXITCODE
