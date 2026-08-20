# Windows port — handoff / resume notes

State as of **2026-08-20** on the Windows 11 Home machine (`DESKTOP-5FGSUVG`,
x64, 12 GB RAM, Node 24.17, npm 11.13). Working copy: `C:\Users\staff\src\tenant-ai`,
branch `main` of **github.com/claurealex-cyber/tenant-ai-windows** (this is the
Windows instance's own repo; the Mac instance stays in `…/tenant-ai`, kept as the
`mac` remote here for cherry-picking shared fixes). Plan + status with evidence:
<https://claude.ai/code/artifact/8877bfe1-8b70-40ec-9045-9d05dbb27305>

Docs for how the Windows build works: `README-WINDOWS.md`.

## The big decision: no Docker / WSL2 VM on this machine

After the reboot Docker Desktop worked, but its WSL2 VM (`vmmemWSL`) held
**2.3 GB of the 12 GB** and left 0.9 GB free with Chrome/Edge open. So the
infra was moved off the VM: **`scripts/infra.mjs`** runs Postgres 16.14
(binaries from the `embedded-postgres` npm devDependency), Redis 8.10.1
(redis-windows msys2 build, sha256-pinned) and optionally MinIO (official exe)
as plain detached Windows processes — same ports/credentials/db as
`docker-compose.yml`, so `.env`, the tests and the launcher are unchanged.
~100 MB resident (Postgres ≈90 MB, Redis ≈13 MB; MinIO ≈200 MB when enabled).
No admin rights, no services, nothing under Program Files; all state in
`.local\infra\` (gitignored).

* `start.cmd` / `npm start` → `--infra=native` by default on Windows
  (`docker` on the Mac; `--infra=docker|none` / `INFRA_MODE` to override).
* `npm run infra:up | infra:status | infra:down`, `npm run infra -- logs postgres`.
* Docker Desktop is still installed but **no longer autostarts** (Run key
  removed, `AutoStart=false` in its settings). Uninstall it whenever you like:
  `winget uninstall Docker.DockerDesktop`; WSL2 can stay (it only costs memory
  while a distro/VM is running).

## Milestone status

| Gate | Status | Evidence |
|---|---|---|
| M0 baseline on the Mac | not done (needs the Mac) | — |
| M1 toolchain + tests | **passed** | `npm ci` clean (no node-gyp), Turbo build 4/4, vitest **1651/1651** on native infra (`parity/win32/vitest-native.json`, 26 s; also green on Docker infra, `vitest-docker.json`) — the old fresh-DB `billing-cycle` quirk is fixed in the test |
| M2 infra | **passed (native)** | Docker path verified once post-reboot (compose up, migrate, seed, tests), then replaced by `infra.mjs`: `up` in ≈3 s, migrate + seed on the native Postgres; **chaos all 3 scenarios recovered** (`parity/win32/chaos-native.txt`, postgres-restart re-run with `sawDown=True` in `chaos-native-postgres.txt`); clean load baseline `http-load --spread-ip` 50 conn × 30 s on `/health/deep`: **5,088 req/s, p50 8.8 ms, p99 22.7 ms, 0 errors** (`http-load-native-clean.txt`, `http-load-health-deep.json`) |
| M3 env + process model | **passed** | `parity/win32/shutdown-drill.txt` — 11/11 clean (ipc/stdin/hard) |
| M4 launcher | **passed** | `parity/win32/relaunch-loop-native.txt` — **5/5 takeovers clean** through the real launcher on native infra (healthy in 7–8 s, one listener per port, 0 orphans, infra untouched); earlier no-infra run 3/3 |
| M5 Mac-only features | **done** | RelayTransport gate + tests; admin banner |
| M6 end-to-end parity | not started (needs Twilio/Telnyx/Stripe/Plaid keys + `PUBLIC_URL`) | harness ready |
| M7 soak | **plumbing done**, 72 h run pending | `npm run win:autostart` → Task Scheduler "Tenant AI" (at log on, hidden, crash-restart loop via `scripts/win/autostart.ps1`) + "Tenant AI soak" (`scripts/stress/soak.mjs`, 1 sample/min → `parity/win32/soak.jsonl`, `--report`). Verified: task start → healthy in 40 s; API killed → launcher exits 1 → supervisor restarts the stack (5 s) → healthy; foreground `start.cmd` takeover → supervisor stands down (task `Ready`). Power settings (Fast Startup off, never sleep) need the UAC half of the installer. Still to do: one real reboot + the 72 h recording |
| M8 sign-off + CI | **CI green** (run #6, `653673a`) | `.github/workflows/ci.yml` on `windows-latest` (native Postgres + Redis via `infra.mjs`, build, full vitest, shutdown drill) in github.com/claurealex-cyber/tenant-ai-windows; run #1 failed (postgres.exe refuses an admin token → DB now created with the `pg` client), run #2 got to tests (fresh-DB billing-cycle → test fixed), run #3 got to the shutdown drill, which exposed two real bugs: the drill process itself could abort on exit (libuv `UV_HANDLE_CLOSING`, Windows — child handles now torn down before exit) and **the API server died with exit 1 when a shutdown landed while jobs were still registering** (BullMQ `'error'` with no listener → fixed in `scheduler.ts`: refuse registration while closing + error listeners on every Queue/Worker; 20/20 cycles clean after). Mac parity (`parity-diff`) out of scope: separate instances |

## What changed in this branch (all cross-platform, Mac behavior unchanged)

- **`scripts/infra.mjs`** (new) — native infra manager; `scripts/lib/start-detached.ps1` (Windows: `CreateProcess` with `bInheritHandles=false` so services never inherit a parent pipe — Node's `spawn` would, and a CI runner / PowerShell pipe then hangs until the service dies); `scripts/lib/dotenv.mjs` shared `.env` reader; root `embedded-postgres` devDependency; `npm run infra*` scripts; `.local/` gitignored.
- `scripts/launch.mjs` + `start.cmd` + `start.ps1` — one launcher for both OSes; `--infra=native|docker|none` (default native on Windows, docker elsewhere; `--no-docker` = `--infra=none`); any server dying now stops the stack with exit 1 (so a supervisor restarts all three together).
- **`scripts/win/autostart.ps1`** (crash-restart supervisor, UTF-8 log in `.local/log/launcher.log`) + **`scripts/win/install-autostart.ps1`** (Task Scheduler tasks, power settings via one UAC prompt; `-Status`, `-Uninstall`, `-WithSoak`); `npm run win:autostart*`.
- **`scripts/stress/soak.mjs`** — soak recorder + `--report`; `npm run stress:soak`, `stress:soak:report`.
- `scripts/stress/chaos.ps1` — infra-aware (`-Infra native|docker|auto`); `infra-restart` scenario (native: all services down/up; docker: Docker Desktop restart).
- `apps/server/src/lib/load-env.ts` — server loads root `.env` itself (never overrides shell vars). `scripts/with-env.mjs` for root `npm run db:*`.
- `apps/server/src/lib/graceful-shutdown.ts` — IPC `{type:"shutdown"}` + stdin-close triggers (Windows has no SIGTERM); `requestShutdown()` for tests/harness.
- `apps/server/src/routes/health.ts`, `lib/redis.ts` — **bounded** Redis ping/quit (with Redis down, ioredis `maxRetriesPerRequest:null` made `/health` hang forever — affects the Mac too).
- `packages/shared/src/relay-platform.ts`, `apps/server/src/services/relay-transport.ts`, `relay-guards.ts`, `routes/telnyx-sms.ts` — Messages.app relay is macOS-only; elsewhere rows park as `deferred/relay-unavailable-on-platform` and replies go via Telnyx. Admin → SMS Relay banner + `relayTransport` in the status API.
- `apps/dashboard/src/lib/phone-system.ts` — `windowsHide` on the ngrok spawn.
- `vitest.config.ts` — backslash-path fix for the `@/` alias; loads `DATABASE_URL`/`REDIS_URL` from `.env`.
- `.gitattributes` (LF), `.gitignore`, root `package.json` scripts (`start`, `test`, `db:migrate:deploy`, `stress:*`, `infra*`).
- Tests: `relay-platform.test.ts`, `load-env.test.ts`, additions in `sms-relay.test.ts` and `monitoring-shutdown.test.ts`.
- `scripts/stress/*` harness, `parity/` artifacts, `README-WINDOWS.md`, CI workflow.

## Resume

```powershell
cd $HOME\src\tenant-ai
npm run infra:status             # postgres/redis UP? (start.cmd brings them up anyway)
.\start.cmd                      # native infra → migrate → build → serve; Ctrl-C to stop
npm test                         # full suite against the native postgres + redis

# Gates (all pass on the native stack; re-run any time)
powershell -ExecutionPolicy Bypass -File scripts\stress\relaunch-loop.ps1 -Cycles 20 -LauncherArgs "--no-open --no-ngrok --no-build"
powershell -ExecutionPolicy Bypass -File scripts\stress\chaos.ps1 -Scenario all   # while the app serves + http-load runs
node scripts\stress\http-load.mjs --url http://127.0.0.1:3001/health/deep --connections 50 --duration 30

# Always-on (M7)
npm run win:autostart            # tasks + (UAC) power settings; npm run win:autostart:status to check
Start-ScheduledTask -TaskName 'Tenant AI'      # test without signing out; Set-Content .launcher.stop 1 to stop
npm run stress:soak              # or let the "Tenant AI soak" task record; npm run stress:soak:report after 72 h

# Then: one real reboot (sign in, touch nothing, expect /health ok) ; push so CI runs ; M6 with keys ; 72 h soak report
# (This Windows box and the Mac are separate instances — no parity work on the Mac is planned; the macOS CI job only
#  guards that shared code still runs there.)
```

Note: the old "first run on a freshly seeded DB fails billing-cycle" quirk is fixed (the test
now asserts on its own subscriptions, not the global invoice count).
