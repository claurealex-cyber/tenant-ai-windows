# Parity artifacts

Machine-generated evidence that the Mac and Windows builds behave the same.
One folder per platform (`mac/`, `win32/`, `linux/`); compare with
`npm run stress:parity -- --a parity/mac --b parity/win32`.

| File | Produced by | Compared how |
|---|---|---|
| `vitest-*.json` | `npx vitest run --reporter=json --outputFile=…` | total/passed counts must match, 0 failed |
| `http-load-*.json` | `scripts/stress/http-load.mjs` | req/s and p99 within ±20 %, errors ≤ 1 % |
| `health.json` | `curl http://127.0.0.1:3001/health` | identical key set |
| `shutdown-drill.txt` | `scripts/stress/shutdown-drill.mjs` | all cycles clean |
| `relaunch-loop.txt` | `scripts/stress/relaunch-loop.ps1` | all takeovers clean |

Raw dumps (`*/raw/`) are git-ignored; keep the summaries.
