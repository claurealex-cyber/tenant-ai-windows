#!/usr/bin/env node
/**
 * Tenant AI launcher — serves the PRODUCTION build. Cross-platform port of
 * start.sh (macOS/zsh). Same ten steps, same semantics, one source of truth:
 *
 *   0. relaunch = restart (pidfile takeover), clean up orphaned servers
 *   1. infra: native (postgres/redis[/minio] as local processes — default on
 *      Windows, see scripts/infra.mjs) or Docker (start Colima / Docker
 *      Desktop — default on macOS/Linux)
 *   2. bring the infra up (infra.mjs up / docker compose up -d)
 *   3. free port 3000 (stop other projects' containers holding it)
 *   4. pick the API port (3001, else 3005–3008) → SERVER_PORT for everyone
 *   5. wait for Postgres
 *   6. prisma migrate deploy
 *   7. npm run build (Turbo-cached)
 *   8. ngrok tunnel for Twilio/Telnyx (non-fatal)
 *   9. open the dashboard
 *  10. serve all three apps; Ctrl-C stops everything
 *
 * Wrappers: start.sh (macOS/Linux), start.cmd / start.ps1 (Windows).
 * Flags: --no-build --no-ngrok --no-open (for stress/CI runs),
 *        --infra=native|docker|none (or INFRA_MODE env; default: native on
 *        Windows, docker elsewhere). --no-docker is kept as an alias of
 *        --infra=none (bring your own Postgres on DATABASE_URL).
 *        INFRA_SERVICES=postgres,redis,minio picks what native mode starts
 *        (default postgres,redis — MinIO is optional in dev).
 *
 * No dependencies — runs on the Node that ships with the project.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/dotenv.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT_DIR);

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const PIDFILE = path.join(PROJECT_DIR, ".launcher.pid");
const STOPFILE = path.join(PROJECT_DIR, ".launcher.stop");
const FLAGS = new Set(process.argv.slice(2));
const flag = (name) => FLAGS.has(`--${name}`);

const log = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── .env (same as `set -a; . ./.env`: never overrides what the shell set) ──

loadEnvFile(path.join(PROJECT_DIR, ".env"));

// ── infra mode ─────────────────────────────────────────────────────────────
// native: scripts/infra.mjs runs postgres/redis[/minio] as local processes
// docker: Colima / Docker Desktop + docker compose (the original behaviour)
// none:   bring your own (DATABASE_URL / REDIS_URL already point somewhere)
const INFRA = (() => {
  if (flag("no-docker") || flag("no-infra")) return "none";
  const arg = process.argv.find((a) => a.startsWith("--infra="));
  const mode = (arg ? arg.slice("--infra=".length) : process.env.INFRA_MODE || "auto").toLowerCase();
  if (["native", "docker", "none"].includes(mode)) return mode;
  if (mode !== "auto") { console.log(`✗ unknown --infra mode "${mode}" (native|docker|none)`); process.exit(2); }
  return IS_WIN ? "native" : "docker";
})();
const INFRA_SERVICES = (process.env.INFRA_SERVICES || "postgres,redis").split(",").map((s) => s.trim()).filter(Boolean);

// ── process helpers ────────────────────────────────────────────────────────

/** Run to completion, inherit output. npm/npx are .cmd shims on Windows → shell. */
function run(cmd, args, { cwd = PROJECT_DIR, check = true, quiet = false } = {}) {
  const isShim = IS_WIN && /^(npm|npx|turbo)$/.test(cmd);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: quiet ? "ignore" : "inherit",
    shell: isShim,
    env: process.env,
    windowsHide: true,
  });
  if (check && r.status !== 0) {
    log(`✗ ${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
  return r.status;
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...opts });
  return r.status === 0 ? r.stdout : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid, { force = false } = {}) {
  try {
    if (IS_WIN) {
      // Windows has no SIGTERM; taskkill without /F only works for windowed apps,
      // so for console servers /F is the only thing that actually stops them.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch { /* already gone */ }
}

/** PIDs listening on a TCP port. */
function listeningPids(port) {
  if (IS_WIN) {
    const out = capture("netstat", ["-ano", "-p", "tcp"]) || "";
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[2]) === port) pids.add(Number(m[3]));
    }
    return [...pids];
  }
  const out = capture("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]) || "";
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function commandLine(pid) {
  if (IS_WIN) {
    const out = capture("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ]);
    return (out || "").trim();
  }
  return (capture("ps", ["-p", String(pid), "-o", "command="]) || "").trim();
}

const portInUse = (port) => listeningPids(port).length > 0;

function which(bin) {
  const out = capture(IS_WIN ? "where" : "which", [bin]);
  return out ? out.split(/\r?\n/)[0].trim() : null;
}

function openBrowser(url) {
  const child = IS_WIN
    ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(IS_MAC ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

const dockerOk = () => run("docker", ["info"], { check: false, quiet: true }) === 0;

// ── banner ─────────────────────────────────────────────────────────────────

log("▶ Tenant AI launcher (production build)");
log();

// ── 0. takeover: a previous instance running means "restart" ───────────────

if (existsSync(PIDFILE)) {
  const prev = parseInt(readFileSync(PIDFILE, "utf8"), 10);
  if (prev && prev !== process.pid && pidAlive(prev)) {
    log("▶ Stopping previous Tenant AI instance…");
    // Stop-file is the cross-platform signal (Windows cannot SIGTERM); on
    // Unix also send SIGTERM so an old-style instance obeys too.
    writeFileSync(STOPFILE, String(process.pid));
    if (!IS_WIN) { try { process.kill(prev, "SIGTERM"); } catch {} }
    for (let i = 0; i < 60 && pidAlive(prev); i++) await sleep(500);
    if (pidAlive(prev)) {
      log("  previous instance did not stop in 30s — forcing");
      killPid(prev, { force: true });
      await sleep(1000);
    }
    try { unlinkSync(STOPFILE); } catch {}
  }
}
writeFileSync(PIDFILE, String(process.pid));

// Clean up orphaned Next.js servers from a crashed instance (they hold
// 3000/3002 and would block startup).
for (const port of [3000, 3002]) {
  for (const pid of listeningPids(port)) {
    const cmd = commandLine(pid);
    if (/next-server|next start|next[\\/]dist[\\/]bin[\\/]next/.test(cmd)) {
      log(`▶ Stopping orphaned server on port ${port} (pid ${pid})`);
      killPid(pid, { force: true });
      await sleep(1000);
    }
  }
}
// Also stop orphaned API servers so a relaunch takes over their port instead
// of drifting the ngrok tunnel — the SMS webhook depends on the target staying put.
for (const port of [3005, 3006, 3007, 3008, parseInt(process.env.SERVER_PORT || "3001", 10)]) {
  for (const pid of listeningPids(port)) {
    const cmd = commandLine(pid);
    if (/tsx (watch )?src[\\/]index\.ts|server[\\/]dist[\\/]index\.js/.test(cmd)) {
      log(`▶ Stopping orphaned API server on port ${port} (pid ${pid})`);
      killPid(pid, { force: true });
      await sleep(1000);
    }
  }
}

// ── 1+2. infrastructure ────────────────────────────────────────────────────

let infra = null; // scripts/infra.mjs module (native mode)
if (INFRA === "native") {
  infra = await import("./infra.mjs");
  log(`▶ Starting local infra (${INFRA_SERVICES.join(", ")}) — native processes, no Docker…`);
  try {
    await infra.up(INFRA_SERVICES);
  } catch (e) {
    log(`✗ ${e.message || e}`);
    log("  Fix: `npm run infra:install` (Windows: downloads Redis/MinIO; Postgres comes with `npm ci`),");
    log("  or run with --infra=docker / --infra=none (bring your own DATABASE_URL).");
    process.exit(1);
  }
} else if (INFRA === "docker") {
  if (dockerOk()) {
    log("✓ Docker daemon already running");
  } else if (IS_MAC) {
    log("▶ Starting Colima (Docker daemon)… ~30s on a cold start");
    run("colima", ["start"]);
  } else if (IS_WIN) {
    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Docker", "Docker Desktop.exe"),
    ];
    const exe = candidates.find((p) => p && existsSync(p));
    if (!exe) {
      log("✗ Docker Desktop is not installed (looked in Program Files and %LOCALAPPDATA%\\Docker).");
      log("  Install it (winget install Docker.DockerDesktop), reboot once for WSL2, and relaunch.");
      process.exit(1);
    }
    log("▶ Starting Docker Desktop… up to 2 minutes on a cold start");
    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(1000); up = dockerOk(); }
    if (!up) { log("✗ Docker Desktop did not come up within 120s."); process.exit(1); }
    log("✓ Docker Desktop running");
  } else {
    log("✗ Docker daemon not running. Start it and relaunch.");
    process.exit(1);
  }

  // ── 2. infra containers ──────────────────────────────────────────────────
  log("▶ Starting infra containers (postgres, redis, minio)…");
  run("docker", ["compose", "up", "-d", "postgres", "redis", "minio"]);
}

// ── 3. free port 3000 for the dashboard ────────────────────────────────────

if (portInUse(3000)) {
  const ps = INFRA === "docker" ? capture("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"]) || "" : "";
  const holders = ps.split(/\r?\n/).filter((l) => /:3000->/.test(l)).map((l) => l.split("\t")[0]);
  if (holders.length) {
    log(`▶ Port 3000 is held by container(s): ${holders.join(", ")} — stopping them`);
    run("docker", ["stop", ...holders], { quiet: true, check: false });
    await sleep(2000);
  }
  if (portInUse(3000)) {
    log("✗ Port 3000 is still in use by a non-Docker process:");
    for (const pid of listeningPids(3000)) log(`    pid ${pid}: ${commandLine(pid)}`);
    log("  Stop it and relaunch.");
    process.exit(1);
  }
}

// ── 4. pick the API server port ────────────────────────────────────────────

const defaultPort = parseInt(process.env.SERVER_PORT || "3001", 10);
if (portInUse(defaultPort)) {
  for (const candidate of [3005, 3006, 3007, 3008]) {
    if (!portInUse(candidate)) {
      log(`▶ Port ${defaultPort} is busy — API server will use ${candidate}`);
      process.env.SERVER_PORT = String(candidate);
      break;
    }
  }
}
const SERVER_PORT = parseInt(process.env.SERVER_PORT || "3001", 10);

// ── 5. wait for Postgres ───────────────────────────────────────────────────

if (INFRA === "docker") {
  log("▶ Waiting for Postgres (localhost:5433)…");
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = run("docker", ["compose", "exec", "-T", "postgres", "pg_isready"], { check: false, quiet: true }) === 0;
    if (!ready) await sleep(1000);
  }
  log(ready ? "✓ Postgres ready" : "! Postgres not ready after 30s — continuing (migrations may fail)");
} else if (INFRA === "native") {
  // infra.up() already waited for pg_ctl -w; this is the belt to its braces.
  const { postgres } = infra.config();
  const ready = await infra.waitForPort(postgres.port, { timeoutMs: 30_000 });
  log(ready ? `✓ Postgres ready (localhost:${postgres.port})` : `! Postgres not answering on ${postgres.port} after 30s — continuing (migrations may fail)`);
}

// ── 6. migrations ──────────────────────────────────────────────────────────

log("▶ Applying database migrations…");
run("npx", ["prisma", "migrate", "deploy"], { cwd: path.join(PROJECT_DIR, "apps", "server") });

// ── 7. production build (Turbo cache → instant when unchanged) ─────────────

if (!flag("no-build")) {
  log("▶ Building production bundles…");
  run("npm", ["run", "build"]);
}

// ── 8. ngrok tunnel (non-fatal) ────────────────────────────────────────────

const PUBLIC_URL = process.env.PUBLIC_URL || "";
const ngrokBin = process.env.NGROK_PATH || which("ngrok");
if (!flag("no-ngrok") && PUBLIC_URL && ngrokBin) {
  const domain = PUBLIC_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let tunnels = "";
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2000) });
    if (res.ok) tunnels = await res.text();
  } catch { /* agent not running */ }
  if (tunnels.includes(domain) && tunnels.includes(`localhost:${SERVER_PORT}`)) {
    log(`✓ ngrok tunnel already running → localhost:${SERVER_PORT}`);
  } else {
    if (tunnels) {
      log(`▶ Restarting ngrok tunnel to target localhost:${SERVER_PORT}…`);
      if (IS_WIN) spawnSync("taskkill", ["/IM", "ngrok.exe", "/F"], { stdio: "ignore", windowsHide: true });
      else spawnSync("pkill", ["-x", "ngrok"], { stdio: "ignore" });
      await sleep(1000);
    } else {
      log(`▶ Starting ngrok tunnel (${domain} → localhost:${SERVER_PORT})…`);
    }
    spawn(ngrokBin, ["http", `--url=${domain}`, String(SERVER_PORT), "--log=stdout"], {
      detached: true, stdio: "ignore", windowsHide: true,
    }).unref();
  }
} else if (!flag("no-ngrok") && PUBLIC_URL && !ngrokBin) {
  log("! ngrok not found on PATH — tunnel not started (Admin → System Health can start it later)");
}

// ── 9. open the dashboard once the servers have had a moment ───────────────

if (!flag("no-open")) {
  setTimeout(() => openBrowser("http://localhost:3000"), 6000).unref();
}

// ── 10. serve ──────────────────────────────────────────────────────────────

log();
log("▶ Serving production build:");
log("    Dashboard:   http://localhost:3000");
log(`    API server:  http://localhost:${SERVER_PORT}`);
log("    Tenant site: http://localhost:3002");
log("  (Press Ctrl-C in this window to stop.)");
log();

const require = createRequire(import.meta.url);
function nextBin(appDir) {
  return require.resolve("next/dist/bin/next", { paths: [appDir, PROJECT_DIR] });
}

const childEnv = { ...process.env, SERVER_PORT: String(SERVER_PORT), NODE_ENV: process.env.NODE_ENV || "production" };
const children = [];

// API server: spawned directly (not via npm, whose cmd.exe wrapper would hide
// the real PID on Windows) with an IPC channel for graceful shutdown and a
// stdin pipe so it also stops if this launcher dies.
const api = spawn(process.execPath, ["dist/index.js"], {
  cwd: path.join(PROJECT_DIR, "apps", "server"),
  env: { ...childEnv, SHUTDOWN_ON_STDIN_END: "1" },
  stdio: ["pipe", "inherit", "inherit", "ipc"],
  windowsHide: true,
});
children.push({ name: "api", proc: api, graceful: true });

for (const [name, app, port] of [["dashboard", "dashboard", 3000], ["tenant-site", "tenant-site", 3002]]) {
  const appDir = path.join(PROJECT_DIR, "apps", app);
  const proc = spawn(process.execPath, [nextBin(appDir), "start", "--port", String(port)], {
    cwd: appDir,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  children.push({ name, proc, graceful: false });
}

let stopping = false;
async function shutdownAll(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`\n▶ Stopping Tenant AI (${reason})…`);
  const grace = parseInt(process.env.SHUTDOWN_GRACE_MS || "120000", 10) + 10_000;

  // Ask the API server to drain (IPC + stdin close), hard-stop the Next apps.
  for (const c of children) {
    if (c.proc.exitCode !== null) continue;
    if (c.graceful) {
      try { c.proc.send({ type: "shutdown" }); } catch {}
      try { c.proc.stdin?.end(); } catch {}
      if (!IS_WIN) { try { c.proc.kill("SIGTERM"); } catch {} }
    } else {
      killPid(c.proc.pid);
    }
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && children.some((c) => c.proc.exitCode === null && c.proc.signalCode === null)) {
    await sleep(250);
  }
  for (const c of children) {
    if (c.proc.exitCode === null && c.proc.signalCode === null) {
      log(`  ${c.name} did not exit within grace — forcing`);
      killPid(c.proc.pid, { force: true });
    }
  }
  // Only remove the pidfile if it still holds OUR pid — during a takeover the
  // new instance has already overwritten it.
  try { if (readFileSync(PIDFILE, "utf8").trim() === String(process.pid)) unlinkSync(PIDFILE); } catch {}
  process.exit(code);
}

for (const c of children) {
  c.proc.on("exit", (code, signal) => {
    if (!stopping) log(`! ${c.name} exited (${signal || code})`);
    if (children.every((x) => x.proc.exitCode !== null || x.proc.signalCode !== null)) shutdownAll("all servers exited", code || 0);
  });
}

process.on("SIGINT", () => shutdownAll("Ctrl-C"));
process.on("SIGTERM", () => shutdownAll("SIGTERM"));
process.on("SIGHUP", () => shutdownAll("console closed"));
// Takeover signal from a newer launcher instance (works on every OS).
setInterval(() => {
  if (existsSync(STOPFILE)) {
    try { unlinkSync(STOPFILE); } catch {}
    shutdownAll("relaunch takeover");
  }
}, 500).unref();
