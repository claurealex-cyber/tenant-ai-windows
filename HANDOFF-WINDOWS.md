# Windows port — handoff / resume notes

State as of **2026-08-20** on the Windows 11 Home machine (`DESKTOP-5FGSUVG`,
x64, Node 24.17, npm 11.13). Working copy: `C:\Users\staff\src\tenant-ai`,
branch `windows-port` on top of `origin/main`. Plan + status with evidence:
<https://claude.ai/code/artifact/8877bfe1-8b70-40ec-9045-9d05dbb27305>

Docs for how the Windows build works: `README-WINDOWS.md`.

## Milestone status

| Gate | Status | Evidence |
|---|---|---|
| M0 baseline on the Mac | not done (needs the Mac) | — |
| M1 toolchain + tests | **passed** | `npm ci` clean (no node-gyp), Turbo build 4/4, vitest **1651/1651** (`parity/win32/vitest-*.json`) |
| M2 infra containers | **reboot pending** | WSL2 enabled, Docker Desktop installed, ports reserved, long paths, Defender exclusion (`.win-setup-elevated.log`). Migrations + seed applied against a temporary embedded Postgres (see below). |
| M3 env + process model | **passed** | `parity/win32/shutdown-drill.txt` — 11/11 clean (ipc/stdin/hard) |
| M4 launcher | **passed** (no-docker mode) | `parity/win32/relaunch-loop.txt` — 3/3 takeovers clean, 0 orphans |
| M5 Mac-only features | **done** | RelayTransport gate + tests; admin banner |
| M6 end-to-end parity | not started (needs Twilio/Telnyx/Stripe/Plaid keys + `PUBLIC_URL`) | harness ready |
| M7 soak | not started (after reboot) | checklist in README-WINDOWS.md |
| M8 sign-off + CI | partial | `.github/workflows/ci.yml` written, not pushed; no Mac baseline for `parity-diff` |

## What changed in this branch (all cross-platform, Mac behavior unchanged)

- `scripts/launch.mjs` + `start.cmd` + `start.ps1` — one launcher for both OSes (`start.sh` left as-is; can become a wrapper once verified on the Mac).
- `apps/server/src/lib/load-env.ts` — server loads root `.env` itself (never overrides shell vars). `scripts/with-env.mjs` for root `npm run db:*`.
- `apps/server/src/lib/graceful-shutdown.ts` — IPC `{type:"shutdown"}` + stdin-close triggers (Windows has no SIGTERM); `requestShutdown()` for tests/harness.
- `apps/server/src/routes/health.ts`, `lib/redis.ts` — **bounded** Redis ping/quit (with Redis down, ioredis `maxRetriesPerRequest:null` made `/health` hang forever — affects the Mac too).
- `packages/shared/src/relay-platform.ts`, `apps/server/src/services/relay-transport.ts`, `relay-guards.ts`, `routes/telnyx-sms.ts` — Messages.app relay is macOS-only; elsewhere rows park as `deferred/relay-unavailable-on-platform` and replies go via Telnyx. Admin → SMS Relay banner + `relayTransport` in the status API.
- `apps/dashboard/src/lib/phone-system.ts` — `windowsHide` on the ngrok spawn.
- `vitest.config.ts` — backslash-path fix for the `@/` alias; loads `DATABASE_URL`/`REDIS_URL` from `.env`.
- `.gitattributes` (LF), `.gitignore`, root `package.json` scripts (`start`, `test`, `db:migrate:deploy`, `stress:*`).
- Tests: `relay-platform.test.ts`, `load-env.test.ts`, additions in `sms-relay.test.ts` and `monitoring-shutdown.test.ts`.
- `scripts/stress/*` harness, `parity/` artifacts, `README-WINDOWS.md`, CI workflow.

## Temporary database (goes away with the reboot)

Until Docker works, Postgres 16 runs unprivileged from the Claude session
scratchpad (`embedded-postgres`), listening on `127.0.0.1:5433` with the
compose credentials (`tenant_ai`/`tenant_ai`, db `tenant_ai`). **It dies with
the reboot** — intended. Afterwards the real one is `docker compose up -d
postgres redis minio` (the launcher does this), then migrations run
automatically and `npm run db:seed` restores the demo data.

## Resume after the reboot

```powershell
cd $HOME\src\tenant-ai
docker info                      # must succeed (Docker Desktop started, WSL2 ok)
.\start.cmd                      # real launch: containers → migrate → build → serve; Ctrl-C to stop
npm run db:seed                  # demo data into the Docker postgres (once)
npm test                         # full suite against Docker postgres (+ redis → scheduler tests run too)

# M2/M4 full gates
powershell -ExecutionPolicy Bypass -File scripts\stress\relaunch-loop.ps1 -Cycles 20 -LauncherArgs "--no-open --no-ngrok --no-build"
powershell -ExecutionPolicy Bypass -File scripts\stress\chaos.ps1 -Scenario all   # while http-load runs in another window
node scripts\stress\http-load.mjs --url http://127.0.0.1:3001/health/deep --connections 50 --duration 30

# Then: M0 on the Mac → parity\mac\ ; npm run stress:parity ; push branch so CI runs both OSes ; M6 with keys ; M7 soak
```

Known quirk: on a freshly seeded DB, `billing-cycle.test.ts` reports 3 invoices
instead of 2 on the first run (seeded demo subscription), then passes forever.
