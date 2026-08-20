# Tenant AI on Windows

The same monorepo, the same build — run natively on Windows 11, **without
Docker or a WSL2 VM**: Postgres 16, Redis and (optionally) MinIO run as plain
local processes managed by `scripts/infra.mjs`, on the same ports and
credentials as `docker-compose.yml`, so `.env`, the tests and the launcher
don't care which is behind them. One launcher (`scripts/launch.mjs`) drives
macOS and Windows so the two can't drift; `start.sh` (Mac), `start.cmd` /
`start.ps1` (Windows) are thin wrappers around it.

Why native: Docker Desktop's WSL2 VM (`vmmemWSL`) held 2.3 GB on the 12 GB
laptop and starved Chrome/Edge; the three native processes take ~100 MB
(Postgres ~90 MB + Redis ~13 MB; MinIO adds ~200 MB and is off by default).

## One-time setup

Run from an **elevated** PowerShell once (each line is idempotent):

```powershell
winget install -e --id OpenJS.NodeJS.LTS          # Node 20+ x64 (22/24 fine)
winget install -e --id Git.Git
winget install -e --id Ngrok.Ngrok                 # optional: Twilio/Telnyx tunnel
corepack enable                                     # honors packageManager: npm@11.x
# (No Docker Desktop / WSL2 needed — see "Infra" below. If you want the Docker
#  path anyway: winget install -e --id Docker.DockerDesktop, reboot, --infra=docker.)

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
git clone https://github.com/claurealex-cyber/tenant-ai-windows $HOME\src\tenant-ai   # Windows instance (the Mac one is …/tenant-ai)
cd $HOME\src\tenant-ai
Copy-Item .env.example .env          # fill in secrets; PII_ENCRYPTION_KEY = 64 hex chars
npm ci                               # also brings the Postgres 16 binaries (embedded-postgres)
npm run db:generate
npm run infra:install                # downloads Redis 8 (and MinIO) for Windows into .local\infra\
```

## Infra without Docker (`scripts/infra.mjs`)

```powershell
npm run infra:up                     # postgres + redis (add "minio" to include it): like `docker compose up -d`
npm run infra:status                 # UP :5433 / :6380 / :9002 + pids
npm run infra:down                   # like `docker compose stop`
npm run infra -- logs postgres       # .local\infra\log\<svc>.log
npm run infra -- reset redis --yes   # wipe that service's data
```

* Postgres 16.14 (zonky build from the `embedded-postgres` npm package, no
  installer, no service, no admin rights), cluster in `.local\infra\data\postgres`,
  superuser `tenant_ai`/`tenant_ai`, db `tenant_ai`, port 5433 — exactly the
  compose values, read from `DATABASE_URL`.
* Redis 8.10 ([redis-windows](https://github.com/redis-windows/redis-windows)
  msys2 build, sha256-pinned in `infra.mjs`), RDB snapshots in `.local\infra\data\redis`, port 6380.
* MinIO (official exe, pinned release) on 9002/9003 — optional; only Admin →
  Integrations → S3 test uses it. Start it with `npm run infra -- up minio` or
  `INFRA_SERVICES=postgres,redis,minio` for the launcher.
* Processes are started detached (they survive the shell/launcher that started
  them, like `up -d`), pids in `.local\infra\run\`, logs in `.local\infra\log\`.
  On Windows they are created through `scripts\lib\start-detached.ps1`
  (`CreateProcess` with `bInheritHandles=false`, no console): Node's own
  `spawn` lets a detached child inherit every handle of the parent — including
  the stdout pipe of whatever shell or CI runner invoked `infra.mjs`, which
  then blocks on EOF for as long as the service runs. Everything under
  `.local\` is gitignored. On macOS/Linux the same script works with `brew install redis
  minio` (Postgres still from npm), but the Mac default stays Docker.
* The launcher picks the mode: `--infra=native|docker|none` or `INFRA_MODE`;
  default **native on Windows, docker elsewhere**; `--no-docker` = `--infra=none`.

## Run

* Double-click **`start.cmd`** — the Windows equivalent of the Dock shortcut.
  Or `.\start.ps1`, or `npm start`. `npm run win:shortcut` creates a
  **"Tenant AI" shortcut on the Desktop and in the Start Menu** (target:
  `powershell -File start.ps1`, so Windows allows pinning it); right-click →
  *Pin to taskbar* once — scripts can't pin on Windows 11. It starts infra,
  migrations, build, ngrok (when `PUBLIC_URL` is a real domain; a localhost
  `PUBLIC_URL` skips the tunnel), the three servers, and opens the dashboard.
* Relaunching while it's running means **restart** (same as the Mac).
* Ctrl-C in the window stops all three servers; the API server drains active
  calls first (`SHUTDOWN_GRACE_MS`, default 120 s).

The launcher does exactly what `start.sh` does: stops a previous instance and
orphaned servers, brings the infra up (native `infra.mjs up` on Windows;
Docker Desktop + `docker compose up` with `--infra=docker`), frees :3000, picks
the API port (3001 → 3005–3008), waits for Postgres, `prisma migrate deploy`,
`npm run build` (Turbo-cached), starts the ngrok tunnel when `PUBLIC_URL` is
set and ngrok is installed, opens the dashboard, and serves. Flags for
automation: `--no-build --no-ngrok --no-open --infra=native|docker|none`.

### Public URL (ngrok) for this instance

```powershell
ngrok config add-authtoken <token>                       # https://dashboard.ngrok.com/get-started/your-authtoken
npm run win:ngrok -- -Domain your-name.ngrok-free.app    # reserve it at https://dashboard.ngrok.com/domains
```

`win:ngrok` stores nothing but `PUBLIC_URL=https://<domain>` in `.env`, then
proves `https://<domain>/health` answers through a test tunnel. From then on
every launch (shortcut, `start.cmd`, the sign-in task) starts the tunnel; a
localhost `PUBLIC_URL` means "no tunnel". This instance needs its **own**
domain and carrier numbers — two ngrok agents can't serve one domain.
Don't run `ngrok update`: Defender quarantines the self-updated agent
(`Trojan:Win32/Kepavll!rfn` on 3.39); the winget build (3.3.1) works, and
the scripts use `--domain=` which every 3.x agent understands.

## What's different on Windows (and why)

| Area | Mac | Windows |
|---|---|---|
| `.env` | `start.sh` sourced it into the shell | The API server loads it itself (`apps/server/src/lib/load-env.ts`); root `npm run db:*` go through `scripts/with-env.mjs`; vitest takes `DATABASE_URL`/`REDIS_URL` from it. Nothing overrides a variable the shell already set. |
| Graceful shutdown | `SIGTERM` | No SIGTERM on Windows; the launcher sends an IPC `{type:"shutdown"}` and closes the server's stdin (`SHUTDOWN_ON_STDIN_END=1`). Ctrl-C still works as before. |
| SMS relay (Messages.app) | osascript → iPhone text forwarding | **Not available.** `selectRelayTransport()` reports `none`; the relay row is parked as `deferred` / `relay-unavailable-on-platform` and tenant replies go out via the Telnyx API (the documented rollback path). Admin → SMS Relay shows a banner. Force with `RELAY_TRANSPORT=macos-messages|none`. |
| ngrok from Admin → System Health | `spawn("ngrok")` | Same, plus `windowsHide` so no console window pops up. Set `NGROK_PATH` if ngrok isn't on PATH. |
| Infra | Colima + `docker compose` | **Native processes** via `scripts/infra.mjs` (Postgres 16 from npm, Redis 8 for Windows, MinIO exe) — no VM. `--infra=docker` gives Docker Desktop (WSL2) if you really want it. |
| Port / process inspection | `lsof`, `pkill` | `netstat -ano` + `Get-CimInstance Win32_Process`, `taskkill`. |
| Line endings | — | `.gitattributes` forces LF (scripts, .env, seeds) and CRLF only for `*.cmd/*.ps1`. |

## Tests

```powershell
npm run infra:up         # once per login (native Postgres + Redis; Docker works too)
npm test                 # = vitest run; needs Postgres on :5433 (+ Redis on :6380 for the scheduler tests)
```

Tests assume the database is migrated (`npm run db:migrate:deploy`). Redis is
optional — `scheduler.test.ts` skips itself when it can't connect. The suite
passes on a freshly seeded DB (CI does exactly that on every run).

## Stress harness (`scripts/stress/`)

| Script | Gate | What it proves |
|---|---|---|
| `http-load.mjs` | M0/M2/M6 | req/s, p50/p90/p99, server RSS → `parity/<os>/http-load-*.json`. Use `--spread-ip` to get past the API's 60 req/min per-IP limiter (otherwise ~99% of a 50-connection run is `429` and you are measuring the limiter) |
| `shutdown-drill.mjs` | M3 | N× boot → shutdown via `--mode ipc|stdin|sigint|hard`; exit code, port released, no orphans |
| `relaunch-loop.ps1` | M4 | N launcher takeovers; one listener per port, no leftover node/ngrok |
| `port-squatter.mjs` | M4 | holds :3000/:3001 so the launcher must refuse / fall back to 3005–3008 |
| `chaos.ps1` | M2/M7 | stop/start Postgres, Redis, then the whole infra (native `infra.mjs down/up`, or Docker Desktop with `-Infra docker`) under load; server must recover without restart |
| `parity-diff.mjs` | M6/M8 | compares `parity/mac` vs `parity/win32` artifacts within a tolerance |

## Always-on (M7)

```powershell
npm run win:autostart            # registers the tasks (no UAC) + one UAC prompt for the power settings
npm run win:autostart:status     # task state / last result, Fast Startup, sleep timeout
npm run win:autostart -- -WithSoak   # also record a soak sample every 60 s at sign-in
npm run win:autostart -- -Uninstall
```

* **Task Scheduler "Tenant AI"** — *At log on* of this user (20 s delay), runs
  `scripts\win\autostart.ps1` hidden: the launcher (`--no-open`) in a
  crash-restart loop. Launcher exits non-zero (a server died, infra failed) →
  restart with backoff (5 s, 10 s, … max 5 min, ≤10/hour); exits 0 (Ctrl-C,
  takeover, stop-file) → the supervisor stands down. `launch.mjs` now treats
  any one server dying as a failure of the whole stack and exits 1, so the
  three never run half-up. Log: `.local\log\launcher.log` (rotated at 20 MB).
* **Relaunch = restart still works**: double-click `start.cmd` and the hidden
  instance hands over to the visible window; the task shows `Ready` again.
  `Start-ScheduledTask -TaskName 'Tenant AI'` tests it without signing out;
  `Set-Content .launcher.stop 1` stops whatever is running.
* **Machine settings** (the UAC half of the installer): Fast Startup off —
  otherwise "shut down" is a hibernate and the at-logon task isn't re-run
  cleanly — never sleep/hibernate on AC, lid close does nothing.
* **Soak recorder** `npm run stress:soak` (or the `Tenant AI soak` task):
  one JSON line per minute to `parity\win32\soak.jsonl` — `/health` status,
  DB/Redis flags, API uptime (restart = uptime reset), `/health/deep` latency,
  RSS of the three servers, infra status, free RAM. `npm run stress:soak:report`
  prints uptime %, restarts, latency percentiles, RSS min/max and every
  incident window. The 72 h gate = report with 0 restarts and no incidents
  that weren't deliberate.
* Still manual: Windows Update Active Hours; accept the `node.exe`
  private-network firewall prompt once; an external monitor on
  `https://<tunnel>/health/deep` every 5 minutes; and one real reboot
  (`shutdown /r /t 0`, sign in, touch nothing) to prove recovery.
