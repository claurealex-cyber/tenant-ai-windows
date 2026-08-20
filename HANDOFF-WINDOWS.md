# Windows port — handoff / resume notes

State as of **2026-08-20** on the Windows 11 Home machine (`DESKTOP-5FGSUVG`,
x64, 12 GB RAM, Node 24.17, npm 11.13). Working copy: `C:\Users\staff\src\tenant-ai`,
branch `windows-port` on top of `origin/main`. Plan + status with evidence:
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
| M1 toolchain + tests | **passed** | `npm ci` clean (no node-gyp), Turbo build 4/4, vitest **1650/1651** on Docker infra (`parity/win32/vitest-docker.json`) and on native infra (`vitest-native.json`, 26 s) — the 1 is the known first-run `billing-cycle` quirk, passes on re-run |
| M2 infra | **passed (native)** | Docker path verified once post-reboot (compose up, migrate, seed, tests), then replaced by `infra.mjs`: `up` in ≈3 s, migrate + seed on the native Postgres; **chaos all 3 scenarios recovered** (`parity/win32/chaos-native.txt`, postgres-restart re-run with `sawDown=True` in `chaos-native-postgres.txt`); clean load baseline `http-load --spread-ip` 50 conn × 30 s on `/health/deep`: **5,088 req/s, p50 8.8 ms, p99 22.7 ms, 0 errors** (`http-load-native-clean.txt`, `http-load-health-deep.json`) |
| M3 env + process model | **passed** | `parity/win32/shutdown-drill.txt` — 11/11 clean (ipc/stdin/hard) |
| M4 launcher | **passed** | `parity/win32/relaunch-loop-native.txt` — **5/5 takeovers clean** through the real launcher on native infra (healthy in 7–8 s, one listener per port, 0 orphans, infra untouched); earlier no-infra run 3/3 |
| M5 Mac-only features | **done** | RelayTransport gate + tests; admin banner |
| M6 end-to-end parity | not started (needs Twilio/Telnyx/Stripe/Plaid keys + `PUBLIC_URL`) | harness ready |
| M7 soak | not started — now unblocked | checklist in README-WINDOWS.md; autostart = Task Scheduler "at log on → `start.cmd --no-open`" (no Docker sign-in dependency any more) |
| M8 sign-off + CI | partial | `.github/workflows/ci.yml` uses `infra.mjs` on both runners (Postgres + Redis, no Docker); not pushed; no Mac baseline for `parity-diff` |

## What changed in this branch (all cross-platform, Mac behavior unchanged)

- **`scripts/infra.mjs`** (new) — native infra manager; `scripts/lib/start-detached.ps1` (Windows: `CreateProcess` with `bInheritHandles=false` so services never inherit a parent pipe — Node's `spawn` would, and a CI runner / PowerShell pipe then hangs until the service dies); `scripts/lib/dotenv.mjs` shared `.env` reader; root `embedded-postgres` devDependency; `npm run infra*` scripts; `.local/` gitignored.
- `scripts/launch.mjs` + `start.cmd` + `start.ps1` — one launcher for both OSes; `--infra=native|docker|none` (default native on Windows, docker elsewhere; `--no-docker` = `--infra=none`).
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

# Then: M0 on the Mac → parity\mac\ ; npm run stress:parity ; push branch so CI runs both OSes ; M6 with keys ; M7 soak
```

Known quirk: on a freshly seeded DB, `billing-cycle.test.ts` reports 3 invoices
instead of 2 on the first run (seeded demo subscription), then passes forever.
