# One-shot installer for the Tenant AI Windows app (run from an UNZIPPED copy
# or a fresh clone, in a NORMAL PowerShell - no admin needed):
#
#   powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1
#   (or double-click INSTALL.cmd in the repo root)
#
# What it does, in order:
#   1. checks Node >= 20 (tells you the winget command if missing)
#   2. npm ci                          - all dependencies (incl. Postgres binaries)
#   3. .env from .env.example          - generates fresh random secrets; never overwrites an existing .env
#   4. node scripts/infra.mjs install  - downloads Redis (and MinIO) for Windows
#   5. infra up + prisma migrate + seed - local database ready, demo logins created
#   6. npm run build                   - production bundles
#   7. offers the desktop shortcut (scripts\win\make-shortcut.ps1)
#
# Then: .\start.cmd serves everything at http://localhost:3000 (dashboard),
# :3001 (API), :3002 (tenant site). Demo logins: admin@tenantai.com/admin123,
# landlord@example.com/demo123, john.smith@email.com/tenant123 - change them.
# Optional afterwards: npm run win:autostart (start at sign-in), npm run
# win:ngrok -- -Domain <your-domain> (public URL; needs your own ngrok account).
param(
  [switch]$EnvOnly,      # only create .env (used for testing the generator)
  [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
function Step([string]$m) { Write-Host "`n=== $m" -ForegroundColor Cyan }

# ---- 1. node ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Install it first:  winget install -e --id OpenJS.NodeJS.LTS  (then reopen this window)" }
$ver = (& node -v) -replace '^v', ''
if ([int]$ver.Split('.')[0] -lt 20) { throw "Node $ver found - this app needs Node 20+. winget upgrade OpenJS.NodeJS.LTS" }
Step "Node $ver at $($node.Source)"

# ---- 3 (early). .env --------------------------------------------------------
Step ".env"
if (Test-Path "$root\.env") {
  "keeping the existing .env"
} else {
  $hex = { param($bytes) -join ((1..$bytes) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
  $lines = Get-Content "$root\.env.example"
  $lines = $lines | ForEach-Object {
    switch -Regex ($_) {
      '^PII_ENCRYPTION_KEY='  { "PII_ENCRYPTION_KEY=$(& $hex 32)" }
      '^NEXTAUTH_SECRET='     { "NEXTAUTH_SECRET=$(& $hex 32)" }
      '^TENANT_AUTH_SECRET='  { "TENANT_AUTH_SECRET=$(& $hex 32)" }
      default                 { $_ }
    }
  }
  [IO.File]::WriteAllLines("$root\.env", $lines, (New-Object Text.UTF8Encoding($false)))
  ".env created with fresh random secrets (integration keys - Twilio/Telnyx/OpenAI/Stripe/Plaid - are blank; fill them when you have them)"
}
if ($EnvOnly) { exit 0 }

# ---- 2. dependencies --------------------------------------------------------
Step "npm ci (a few minutes on the first run)"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm run db:generate
if ($LASTEXITCODE -ne 0) { throw "prisma generate failed" }

# ---- 4. native infra binaries ----------------------------------------------
Step "local infrastructure (native Postgres 16 + Redis - no Docker)"
node scripts/infra.mjs install
if ($LASTEXITCODE -ne 0) { throw "infra install failed" }

# ---- 5. database ------------------------------------------------------------
Step "database (start, migrate, seed demo data)"
node scripts/infra.mjs up postgres redis
if ($LASTEXITCODE -ne 0) { throw "infra up failed" }
npm run db:migrate:deploy
if ($LASTEXITCODE -ne 0) { throw "migrations failed" }
npm run db:seed
if ($LASTEXITCODE -ne 0) { throw "seed failed" }

# ---- 6. build ---------------------------------------------------------------
Step "production build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# ---- 7. shortcut ------------------------------------------------------------
if (-not $NoShortcut) {
  Step "desktop shortcut"
  powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\win\make-shortcut.ps1"
}

Step "done"
"Start it:        .\start.cmd        (or the 'Tenant AI' desktop shortcut)"
"Dashboard:       http://localhost:3000   admin@tenantai.com / admin123 (change this)"
"Tenant site:     http://localhost:3002"
"Start at sign-in: npm run win:autostart"
"Public URL:      npm run win:ngrok -- -Domain <your-domain>   (your own ngrok account)"
"Docs:            README-WINDOWS.md"
