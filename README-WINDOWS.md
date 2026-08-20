# Tenant AI on Windows

The same monorepo, the same build, the same Docker images — run natively on
Windows 11. One launcher (`scripts/launch.mjs`) drives macOS and Windows so the
two can't drift; `start.sh` (Mac), `start.cmd` / `start.ps1` (Windows) are thin
wrappers around it.

## One-time setup

Run from an **elevated** PowerShell once (each line is idempotent):

```powershell
winget install -e --id OpenJS.NodeJS.LTS          # Node 20+ x64 (22/24 fine)
winget install -e --id Git.Git
winget install -e --id Ngrok.Ngrok                 # optional: Twilio/Telnyx tunnel
winget install -e --id Docker.DockerDesktop        # WSL2 backend; reboot once afterwards
corepack enable                                     # honors packageManager: npm@11.x

# Reserve the app's ports before Hyper-V/WSL grabs them into a dynamic range
# (symptom: EACCES/EADDRINUSE on :3001 with nothing listening)
netsh int ipv4 add excludedportrange protocol=tcp startport=3000 numberofports=9
netsh int ipv4 add excludedportrange protocol=tcp startport=5433 numberofports=1
netsh int ipv4 add excludedportrange protocol=tcp startport=6380 numberofports=1
netsh int ipv4 add excludedportrange protocol=tcp startport=9002 numberofports=2

# Long paths (node_modules / .next nest deep) and a Defender exclusion for the repo
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
git config --global core.longpaths true
Add-MpPreference -ExclusionPath "$HOME\src\tenant-ai"
```

Then, as a normal user:

```powershell
git clone https://github.com/claurealex-cyber/tenant-ai $HOME\src\tenant-ai
cd $HOME\src\tenant-ai
Copy-Item .env.example .env          # fill in secrets; PII_ENCRYPTION_KEY = 64 hex chars
npm ci
npm run db:generate
```

Docker Desktop: enable *Start Docker Desktop when you sign in* and set a disk
limit under Resources (the Mac once ran out of disk under Colima).

## Run

* Double-click **`start.cmd`** (or pin a shortcut to it) — the Windows
  equivalent of the Dock shortcut. Or `.\start.ps1`, or `npm start`.
* Relaunching while it's running means **restart** (same as the Mac).
* Ctrl-C in the window stops all three servers; the API server drains active
  calls first (`SHUTDOWN_GRACE_MS`, default 120 s).

The launcher does exactly what `start.sh` does: stops a previous instance and
orphaned servers, starts Docker Desktop if needed, `docker compose up` for
postgres/redis/minio, frees :3000, picks the API port (3001 → 3005–3008),
waits for Postgres, `prisma migrate deploy`, `npm run build` (Turbo-cached),
starts the ngrok tunnel when `PUBLIC_URL` is set and ngrok is installed, opens
the dashboard, and serves. Flags for automation: `--no-build --no-ngrok
--no-open --no-docker`.

## What's different on Windows (and why)

| Area | Mac | Windows |
|---|---|---|
| `.env` | `start.sh` sourced it into the shell | The API server loads it itself (`apps/server/src/lib/load-env.ts`); root `npm run db:*` go through `scripts/with-env.mjs`; vitest takes `DATABASE_URL`/`REDIS_URL` from it. Nothing overrides a variable the shell already set. |
| Graceful shutdown | `SIGTERM` | No SIGTERM on Windows; the launcher sends an IPC `{type:"shutdown"}` and closes the server's stdin (`SHUTDOWN_ON_STDIN_END=1`). Ctrl-C still works as before. |
| SMS relay (Messages.app) | osascript → iPhone text forwarding | **Not available.** `selectRelayTransport()` reports `none`; the relay row is parked as `deferred` / `relay-unavailable-on-platform` and tenant replies go out via the Telnyx API (the documented rollback path). Admin → SMS Relay shows a banner. Force with `RELAY_TRANSPORT=macos-messages|none`. |
| ngrok from Admin → System Health | `spawn("ngrok")` | Same, plus `windowsHide` so no console window pops up. Set `NGROK_PATH` if ngrok isn't on PATH. |
| Docker | Colima | Docker Desktop (WSL2). |
| Port / process inspection | `lsof`, `pkill` | `netstat -ano` + `Get-CimInstance Win32_Process`, `taskkill`. |
| Line endings | — | `.gitattributes` forces LF (scripts, .env, seeds) and CRLF only for `*.cmd/*.ps1`. |

## Tests

```powershell
npm test                 # = vitest run; needs Postgres on :5433 (Docker or any local PG)
```

Tests assume the database is migrated (`npm run db:migrate:deploy`). Redis is
optional — `scheduler.test.ts` skips itself when it can't connect. Known
first-run quirk on a freshly seeded DB: `billing-cycle.test.ts` counts all
invoices created for the month, so the seeded demo subscription makes the
first run report 3 instead of 2; every run after that passes.

## Stress harness (`scripts/stress/`)

| Script | Gate | What it proves |
|---|---|---|
| `http-load.mjs` | M0/M2/M6 | req/s, p50/p90/p99, server RSS → `parity/<os>/http-load-*.json` |
| `shutdown-drill.mjs` | M3 | N× boot → shutdown via `--mode ipc|stdin|sigint|hard`; exit code, port released, no orphans |
| `relaunch-loop.ps1` | M4 | N launcher takeovers; one listener per port, no leftover node/ngrok |
| `port-squatter.mjs` | M4 | holds :3000/:3001 so the launcher must refuse / fall back to 3005–3008 |
| `chaos.ps1` | M2/M7 | stop/start Postgres, Redis, Docker Desktop under load; server must recover without restart |
| `parity-diff.mjs` | M6/M8 | compares `parity/mac` vs `parity/win32` artifacts within a tolerance |

## Always-on (M7)

* Power plan: never sleep on AC, lid-close does nothing, Fast Startup off.
* Windows Update: set Active Hours; after any reboot the Task Scheduler job
  below brings everything back.
* Task Scheduler: *At log on* → `start.cmd --no-open` (restart on failure).
* Firewall: accept the `node.exe` private-network prompt once.
* External monitor on `https://<tunnel>/health/deep` every 5 minutes.
