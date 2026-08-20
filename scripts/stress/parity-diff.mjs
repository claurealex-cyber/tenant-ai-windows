#!/usr/bin/env node
/**
 * Compare parity artifacts between two platforms (M6/M8 sign-off).
 *
 *   node scripts/stress/parity-diff.mjs [--a parity/mac] [--b parity/win32] [--tolerance 0.2]
 *
 * For every *.json present in both dirs:
 *   - http-load-*.json: req/s and p99 within ±tolerance (default 20%), error rate ≤1%
 *   - health.json: same top-level keys
 *   - vitest-summary.json: identical total/passed counts
 *   - anything else: deep-equal, reported as info
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const A = args.a || "parity/mac", B = args.b || `parity/${process.platform}`;
const tol = parseFloat(args.tolerance || "0.2");
if (!existsSync(A) || !existsSync(B)) { console.log(`need both ${A} and ${B}`); process.exit(2); }

const files = readdirSync(A).filter((f) => f.endsWith(".json") && existsSync(path.join(B, f)));
let fail = 0;
const within = (x, y) => x != null && y != null && Math.abs(x - y) <= tol * Math.max(Math.abs(x), Math.abs(y), 1e-9);

for (const f of files) {
  const a = JSON.parse(readFileSync(path.join(A, f), "utf8"));
  const b = JSON.parse(readFileSync(path.join(B, f), "utf8"));
  if (f.startsWith("http-load-")) {
    const okRps = within(a.reqPerSec, b.reqPerSec), okP99 = within(a.latencyMs?.p99, b.latencyMs?.p99);
    const okErr = (b.errors / Math.max(1, b.requests)) <= 0.01;
    const ok = okRps && okP99 && okErr; if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${f}: req/s ${a.reqPerSec} vs ${b.reqPerSec}, p99 ${a.latencyMs?.p99} vs ${b.latencyMs?.p99} ms, errors ${b.errors}`);
  } else if (f === "health.json") {
    const ka = Object.keys(a).sort().join(","), kb = Object.keys(b).sort().join(",");
    const ok = ka === kb; if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} health.json keys ${ok ? "identical" : `differ:\n    A: ${ka}\n    B: ${kb}`}`);
  } else if (f === "vitest-summary.json") {
    const ok = a.numTotalTests === b.numTotalTests && a.numPassedTests === b.numPassedTests && (b.numFailedTests || 0) === 0; if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} vitest: ${a.numPassedTests}/${a.numTotalTests} vs ${b.numPassedTests}/${b.numTotalTests} (failed ${b.numFailedTests || 0})`);
  } else {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    console.log(`${ok ? "✓" : "·"} ${f}: ${ok ? "identical" : "differs (info)"}`);
  }
}
console.log(fail ? `\n✗ ${fail} parity check(s) failed` : `\n✓ parity within ${tol * 100}% on ${files.length} artifact(s)`);
process.exit(fail ? 1 : 0);
