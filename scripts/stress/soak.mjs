#!/usr/bin/env node
/**
 * Soak recorder (M7) — no dependencies. Samples the running stack every N
 * seconds and appends one JSON line per sample, so a 72 h run leaves evidence:
 *
 *   node scripts/stress/soak.mjs [--interval 60] [--api 3001] [--out parity/win32/soak.jsonl]
 *   node scripts/stress/soak.mjs --report [--out …]          # summarize a recording
 *
 * Each sample: /health (status, dbConnected, redisConnected, uptime, RSS,
 * recentErrorCount, lastJobRuns) + /health/deep latency, whether 3000/3002
 * answer, RSS of the node.exe processes listening on the three ports, infra
 * status (postgres/redis up?), free system memory. The report prints uptime %,
 * API restarts (uptime resets), worst latencies, RSS min/max per server, and
 * every window in which something was down.
 *
 * Runs anywhere; the per-process RSS lookup uses netstat/tasklist on Windows
 * and lsof/ps elsewhere. Ctrl-C stops it; the file is append-only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);
const IS_WIN = process.platform === "win32";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null)).filter(Boolean),
);
const intervalS = parseInt(args.interval || "60", 10);
const apiPort = parseInt(args.api || process.env.SERVER_PORT || "3001", 10);
const out = args.out || path.join("parity", process.platform === "darwin" ? "mac" : process.platform, "soak.jsonl");

// ── helpers ────────────────────────────────────────────────────────────────

async function timedFetch(url, timeoutMs = 8000) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), json };
  } catch (e) {
    return { status: 0, ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), error: e.name || String(e) };
  }
}

function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : "";
}

/** pid listening on a TCP port (first one). */
function listenerPid(port) {
  if (IS_WIN) {
    for (const line of capture("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  const o = capture("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]).trim();
  return o ? Number(o.split(/\s+/)[0]) : null;
}

/** RSS in MB for a pid. */
function rssMB(pid) {
  if (!pid) return null;
  if (IS_WIN) {
    const o = capture("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const m = o.match(/"([\d,.]+) K"/);
    return m ? +(parseInt(m[1].replace(/[,.]/g, ""), 10) / 1024).toFixed(1) : null;
  }
  const o = capture("ps", ["-o", "rss=", "-p", String(pid)]).trim();
  return o ? +(parseInt(o, 10) / 1024).toFixed(1) : null;
}

let infra = null;
async function infraStatus() {
  try {
    infra ??= await import("../infra.mjs");
    const rows = await infra.status(["postgres", "redis"]);
    return Object.fromEntries(rows.map((r) => [r.service, r.listening]));
  } catch { return null; }
}

// ── sample ─────────────────────────────────────────────────────────────────

async function sample() {
  const [health, deep, dash, tenant] = await Promise.all([
    timedFetch(`http://127.0.0.1:${apiPort}/health`),
    timedFetch(`http://127.0.0.1:${apiPort}/health/deep`),
    timedFetch("http://127.0.0.1:3000/", 8000),
    timedFetch("http://127.0.0.1:3002/", 8000),
  ]);
  const pids = { api: listenerPid(apiPort), dashboard: listenerPid(3000), tenantSite: listenerPid(3002) };
  const h = health.json || {};
  return {
    t: new Date().toISOString(),
    api: { http: health.status, ms: health.ms, status: h.status ?? null, db: h.dbConnected ?? null, redis: h.redisConnected ?? null, uptime: h.uptime ?? null, activeCalls: h.activeCalls ?? null, recentErrors: h.recentErrorCount ?? null, rssMB: h.memoryUsage?.rss ? +(h.memoryUsage.rss / 1048576).toFixed(1) : null, jobs: h.lastJobRuns ? Object.fromEntries(Object.entries(h.lastJobRuns).map(([k, v]) => [k, v?.lastError ? `ERR ${v.lastError}` : v?.lastRunAt || null])) : null },
    deep: { http: deep.status, ms: deep.ms },
    dashboard: { http: dash.status, ms: dash.ms, rssMB: rssMB(pids.dashboard) },
    tenantSite: { http: tenant.status, ms: tenant.ms, rssMB: rssMB(pids.tenantSite) },
    infra: await infraStatus(),
    sys: { freeMB: Math.round(os.freemem() / 1048576), load: os.loadavg()[0] },
  };
}

// ── report ─────────────────────────────────────────────────────────────────

function report() {
  if (!existsSync(out)) { console.log(`no recording at ${out}`); process.exit(2); }
  const rows = readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!rows.length) { console.log("empty recording"); process.exit(2); }
  const first = new Date(rows[0].t), last = new Date(rows[rows.length - 1].t);
  const span = (last - first) / 1000;
  const okApi = rows.filter((r) => r.api.http === 200 && r.api.status === "ok").length;
  const okAll = rows.filter((r) => r.api.http === 200 && r.dashboard.http === 200 && r.tenantSite.http === 200).length;
  const pct = (n) => `${((100 * n) / rows.length).toFixed(2)}%`;
  const lat = (sel) => { const v = rows.map(sel).filter((x) => x > 0).sort((a, b) => a - b); const p = (q) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null; return { p50: p(0.5), p99: p(0.99), max: v[v.length - 1] ?? null }; };
  const rss = (sel) => { const v = rows.map(sel).filter((x) => x != null); return v.length ? { min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] } : null; };
  let restarts = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].api.uptime != null && rows[i - 1].api.uptime != null && rows[i].api.uptime < rows[i - 1].api.uptime) restarts++;
  const incidents = [];
  let cur = null;
  for (const r of rows) {
    const bad = [];
    if (!(r.api.http === 200 && r.api.status === "ok")) bad.push(`api:${r.api.http}/${r.api.status}`);
    if (r.api.db === false) bad.push("db");
    if (r.api.redis === false) bad.push("redis");
    if (r.dashboard.http !== 200) bad.push(`dashboard:${r.dashboard.http}`);
    if (r.tenantSite.http !== 200) bad.push(`tenant-site:${r.tenantSite.http}`);
    if (bad.length) { if (cur && cur.what === bad.join(",")) cur.until = r.t; else { cur = { from: r.t, until: r.t, what: bad.join(",") }; incidents.push(cur); } }
    else cur = null;
  }
  console.log(`Soak report: ${rows.length} samples over ${(span / 3600).toFixed(1)} h (${first.toISOString()} → ${last.toISOString()})`);
  console.log(`  API healthy (200 + status ok): ${pct(okApi)}   all three servers 200: ${pct(okAll)}   API restarts (uptime resets): ${restarts}`);
  console.log(`  /health ms: ${JSON.stringify(lat((r) => r.api.ms))}   /health/deep ms: ${JSON.stringify(lat((r) => r.deep.ms))}`);
  console.log(`  RSS MB  api: ${JSON.stringify(rss((r) => r.api.rssMB))}  dashboard: ${JSON.stringify(rss((r) => r.dashboard.rssMB))}  tenant-site: ${JSON.stringify(rss((r) => r.tenantSite.rssMB))}`);
  console.log(`  free system memory MB: ${JSON.stringify(rss((r) => r.sys.freeMB))}`);
  const jobErr = rows.filter((r) => r.api.jobs && Object.values(r.api.jobs).some((v) => typeof v === "string" && v.startsWith("ERR"))).length;
  console.log(`  samples with a failing scheduled job: ${jobErr}`);
  if (incidents.length) { console.log(`  incidents (${incidents.length}):`); for (const i of incidents.slice(0, 40)) console.log(`    ${i.from} → ${i.until}  ${i.what}`); if (incidents.length > 40) console.log(`    … ${incidents.length - 40} more`); }
  else console.log("  incidents: none");
  process.exit(okApi === rows.length ? 0 : 1);
}

// ── main ───────────────────────────────────────────────────────────────────

if (args.report === "true") report();
else {
  mkdirSync(path.dirname(out), { recursive: true });
  console.log(`▶ soak: every ${intervalS}s → ${out}  (Ctrl-C to stop; --report to summarize)`);
  const tick = async () => {
    const s = await sample();
    appendFileSync(out, JSON.stringify(s) + "\n");
    const flag = s.api.http === 200 && s.api.status === "ok" ? "·" : "!";
    console.log(`${flag} ${s.t} api=${s.api.http}/${s.api.status} db=${s.api.db} redis=${s.api.redis} up=${s.api.uptime}s deep=${s.deep.ms}ms dash=${s.dashboard.http} tenant=${s.tenantSite.http} rss=${s.api.rssMB}/${s.dashboard.rssMB}/${s.tenantSite.rssMB}MB free=${s.sys.freeMB}MB`);
  };
  await tick();
  setInterval(tick, intervalS * 1000);
}
