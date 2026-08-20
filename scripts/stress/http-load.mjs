#!/usr/bin/env node
/**
 * HTTP load generator — no dependencies (uses Node's keep-alive fetch).
 *
 *   node scripts/stress/http-load.mjs --url http://127.0.0.1:3001/health \
 *        --connections 50 --duration 30 --name health [--out parity/win] [--spread-ip]
 *
 * Prints p50/p90/p99 latency, req/s, error count and (for /health targets)
 * the server's RSS before/after. Writes JSON so parity-diff.mjs can compare
 * the Mac and Windows numbers. Used at M0, M2, M6.
 *
 * --spread-ip: the API rate-limits 60 req/min per client IP (X-Forwarded-For
 * wins over the socket address), so a single-host load test is 99% 429s after
 * the first second. With this flag every request carries a distinct
 * X-Forwarded-For (10.x.y.z), so the numbers measure the server, not the
 * limiter. Without it you measure the limiter — also useful, just different.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null)).filter(Boolean),
);
const url = args.url || "http://127.0.0.1:3001/health";
const connections = parseInt(args.connections || "50", 10);
const durationS = parseInt(args.duration || "30", 10);
const name = args.name || new URL(url).pathname.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "root";
const outDir = args.out || path.join("parity", process.platform === "darwin" ? "mac" : process.platform);

async function rss() {
  try {
    const r = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j.memoryUsage?.rss ?? null;
  } catch { return null; }
}

const spreadIp = args["spread-ip"] === "true";
let seq = 0;
const nextHeaders = () => {
  if (!spreadIp) return undefined;
  const n = seq++;
  return { "x-forwarded-for": `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` };
};

const latencies = [];
let ok = 0, errors = 0, statusCounts = {};
const rssBefore = await rss();
const end = Date.now() + durationS * 1000;

async function worker() {
  while (Date.now() < end) {
    const t0 = process.hrtime.bigint();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: nextHeaders() });
      await r.arrayBuffer();
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      if (r.ok) ok++; else errors++;
    } catch {
      errors++;
    }
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

console.log(`▶ ${connections} connections × ${durationS}s → ${url}`);
const t0 = Date.now();
await Promise.all(Array.from({ length: connections }, worker));
const elapsed = (Date.now() - t0) / 1000;
const rssAfter = await rss();

latencies.sort((a, b) => a - b);
const pct = (p) => latencies.length ? +latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(2) : null;
const result = {
  name, url, connections, durationS, spreadIp,
  platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length,
  requests: latencies.length, ok, errors, statusCounts,
  reqPerSec: +(latencies.length / elapsed).toFixed(1),
  latencyMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: +latencies[latencies.length - 1]?.toFixed(2) },
  serverRssMB: { before: rssBefore && +(rssBefore / 1048576).toFixed(1), after: rssAfter && +(rssAfter / 1048576).toFixed(1) },
  at: new Date().toISOString(),
};
console.log(JSON.stringify(result, null, 2));
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `http-load-${name}.json`);
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(`✓ wrote ${file}`);
if (errors > latencies.length * 0.01) { console.log("✗ >1% errors"); process.exit(1); }
