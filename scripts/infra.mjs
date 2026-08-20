#!/usr/bin/env node
/**
 * Native (no-Docker) dev infrastructure: Postgres 16, Redis and MinIO as plain
 * local processes — same ports, credentials and database name as
 * docker-compose.yml, so .env / DATABASE_URL / the tests / the launcher do
 * not care which of the two is behind them.
 *
 *   node scripts/infra.mjs install [svc…]   # fetch Redis + MinIO binaries (Windows); Postgres comes from npm
 *   node scripts/infra.mjs up [svc…]        # start, detached (survives this shell) — like `docker compose up -d`
 *   node scripts/infra.mjs down [svc…]      # stop — like `docker compose stop`
 *   node scripts/infra.mjs restart [svc…]
 *   node scripts/infra.mjs status [--json]
 *   node scripts/infra.mjs logs <svc>
 *   node scripts/infra.mjs reset <svc> --yes  # wipe that service's data directory
 *
 * Services: postgres, redis, minio. Default set for `up`/`status`: postgres +
 * redis; minio is opt-in (name it, or INFRA_SERVICES=postgres,redis,minio for
 * the launcher) — only the Admin → Integrations S3 test uses it.
 *
 * Why this exists: Docker Desktop's WSL2 VM holds 2–3 GB on a 12 GB laptop;
 * these three processes take ~150 MB together. Postgres binaries come from
 * the `embedded-postgres` devDependency (zonky build, all platforms); Redis is
 * the redis-windows msys2 build on Windows (`brew install redis` elsewhere);
 * MinIO is the official single exe.
 *
 * Everything lives under .local/infra/ (gitignored):
 *   redis/ minio/          binaries (Windows)        data/<svc>/   persistent data
 *   run/<svc>.pid          pid of the running service  log/<svc>.log   output
 *
 * No dependencies beyond Node itself.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, rmSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "./lib/dotenv.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const require = createRequire(import.meta.url);

export const INFRA_DIR = path.join(ROOT, ".local", "infra");
const DIRS = {
  data: path.join(INFRA_DIR, "data"),
  run: path.join(INFRA_DIR, "run"),
  log: path.join(INFRA_DIR, "log"),
  dl: path.join(INFRA_DIR, "dl"),
  redis: path.join(INFRA_DIR, "redis"),
  minio: path.join(INFRA_DIR, "minio"),
};

// Pinned downloads (Windows). Bump version + sha256 together.
const DOWNLOADS = {
  redis: {
    version: "8.10.1",
    url: "https://github.com/redis-windows/redis-windows/releases/download/8.10.1/Redis-8.10.1-Windows-x64-msys2.zip",
    sha256: "4e8f2f956ed92feadf3f64b4e137ed34026438821e692e7ae22c9bba5976607a",
    file: "Redis-8.10.1-Windows-x64-msys2.zip",
  },
  minio: {
    version: "RELEASE.2025-09-07T16-13-09Z",
    url: "https://dl.min.io/server/minio/release/windows-amd64/archive/minio.RELEASE.2025-09-07T16-13-09Z",
    sha256: "af709e6ba68488404e85acdd22a3030d0f5e56a108d4b27d744f18ceb50861b4",
    file: "minio.exe",
  },
};

const log = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

// ── configuration (from .env, same values docker-compose uses) ─────────────

loadEnvFile(path.join(ROOT, ".env"));

export function config() {
  const db = new URL(process.env.DATABASE_URL || "postgresql://tenant_ai:tenant_ai@localhost:5433/tenant_ai");
  const redis = new URL(process.env.REDIS_URL || "redis://localhost:6380");
  const s3 = new URL(process.env.S3_ENDPOINT || "http://localhost:9002");
  return {
    postgres: {
      host: db.hostname,
      port: Number(db.port || 5432),
      user: decodeURIComponent(db.username || "tenant_ai"),
      password: decodeURIComponent(db.password || "tenant_ai"),
      database: (db.pathname || "/tenant_ai").replace(/^\//, "").split("?")[0] || "tenant_ai",
    },
    redis: { host: redis.hostname, port: Number(redis.port || 6379) },
    minio: {
      host: s3.hostname,
      port: Number(s3.port || 9000),
      consolePort: Number(process.env.MINIO_CONSOLE_PORT || 9003),
      user: process.env.MINIO_ROOT_USER || "minioadmin",
      password: process.env.MINIO_ROOT_PASSWORD || "minioadmin",
    },
  };
}

const isLocalHost = (h) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(h);

// ── helpers ────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
}

function pidFile(svc) { return path.join(DIRS.run, `${svc}.pid`); }
function logFile(svc) { return path.join(DIRS.log, `${svc}.log`); }
function dataDir(svc) { return path.join(DIRS.data, svc); }

function readPid(svc) {
  try { const n = parseInt(readFileSync(pidFile(svc), "utf8"), 10); return Number.isFinite(n) ? n : null; } catch { return null; }
}
function writePid(svc, pid) { writeFileSync(pidFile(svc), String(pid)); }
function clearPid(svc) { try { unlinkSync(pidFile(svc)); } catch {} }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function killPid(pid) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch { /* gone */ }
}

/** True when something accepts TCP connections on host:port. */
export function portOpen(port, host = "127.0.0.1", timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.removeAllListeners(); s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function waitForPort(port, { timeoutMs = 60_000, host = "127.0.0.1", want = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen(port, host)) === want) return true;
    await sleep(400);
  }
  return false;
}

function which(bin) {
  const r = spawnSync(IS_WIN ? "where" : "which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Run a short command to completion; returns {status, stdout, stderr}. */
function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

// ── process creation ───────────────────────────────────────────────────────
//
// Windows: Node (libuv) creates children with bInheritHandles=TRUE, so a
// detached service would inherit EVERY inheritable handle of this process —
// including the stdout pipe a parent shell or CI runner gave us — and keep it
// open for its whole lifetime (the reader then waits for EOF "forever").
// scripts/lib/start-detached.ps1 calls CreateProcessW(bInheritHandles=FALSE,
// DETACHED_PROCESS) instead: no inherited handles, no console. Output is
// captured by a cmd.exe wrapper that opens the log file itself (">> log 2>&1").
// Unix: plain detached spawn; fds are CLOEXEC there so this problem does not exist.

const COMSPEC = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
const START_DETACHED_PS1 = path.join(ROOT, "scripts", "lib", "start-detached.ps1");
/** Quote one argument for a Windows command line (CRT rules; our args never contain quotes). */
const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
const shellLine = (cmd, args, log) => `${q(COMSPEC)} /d /s /c "${[cmd, ...args].map(q).join(" ")} >> ${q(log)} 2>&1"`;

function winStart(cmdline, { cwd, env, wait }) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", START_DETACHED_PS1], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, INFRA_SPAWN_CMD: cmdline, INFRA_SPAWN_CWD: cwd || ROOT, INFRA_SPAWN_WAIT: wait ? "1" : "0" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const pid = Number((out.match(/PID=(\d+)/) || [])[1]);
  const exitM = out.match(/EXIT=(\d+)/);
  if (!pid) {
    const err = (out.match(/ERROR=(\S+)/) || [])[1];
    throw new Error(`could not start process (${err ? `win32 error ${err}` : out.trim() || r.error || "no output"}): ${cmdline}`);
  }
  return { pid, status: exitM ? Number(exitM[1]) : null };
}

/**
 * Spawn a long-running service detached from this process (and from this
 * console — a process that inherits the console dies with it). stdout/stderr
 * go to the service's log file. `direct` (Windows) skips the cmd.exe log
 * wrapper for services that write their own log file (pid = the service).
 */
function spawnDetached(cmd, args, { cwd, env, svc, direct = false }) {
  if (IS_WIN) {
    const line = direct ? [cmd, ...args].map(q).join(" ") : shellLine(cmd, args, logFile(svc));
    return winStart(line, { cwd, env, wait: false });
  }
  const fd = openSync(logFile(svc), "a");
  const child = spawn(cmd, args, {
    cwd, env: { ...process.env, ...env },
    detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  return child;
}

/**
 * Run a short command to completion, detached from our console/handles, and
 * return its exit status and output — for pg_ctl/initdb, whose *child*
 * (postgres) must not inherit anything from us. Output is appended to `log`.
 */
function runDetachedAndWait(cmd, args, { cwd, env, log } = {}) {
  mkdirSync(DIRS.log, { recursive: true });
  const out = log || logFile("infra-cmd");
  if (IS_WIN) {
    try {
      const r = winStart(shellLine(cmd, args, out), { cwd, env, wait: true });
      return Promise.resolve({ status: r.status, stdout: tail(out, 20), stderr: "" });
    } catch (error) {
      return Promise.resolve({ status: -1, stdout: "", stderr: String(error.message || error) });
    }
  }
  const fd = openSync(out, "a");
  return new Promise((resolve) => {
    const finish = (status, extra = "") => resolve({ status, stdout: tail(out, 20), stderr: extra });
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, env: { ...process.env, ...env },
        detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      return finish(-1, String(error));
    }
    closeSync(fd);
    child.unref();
    child.on("error", (error) => finish(-1, String(error)));
    child.on("exit", (status) => finish(status));
  });
}

// ── binaries ───────────────────────────────────────────────────────────────

export function postgresBinDir() {
  const plat = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[process.arch];
  const pkg = `@embedded-postgres/${plat}-${arch}`;
  // The package has an `exports` map, so resolve its entry and walk up.
  try {
    const entry = require.resolve(pkg, { paths: [ROOT] });
    const bin = path.join(path.dirname(entry), "..", "native", "bin");
    if (existsSync(path.join(bin, exe("pg_ctl")))) return bin;
  } catch { /* not installed */ }
  const fallback = path.join(ROOT, "node_modules", pkg, "native", "bin");
  if (existsSync(path.join(fallback, exe("pg_ctl")))) return fallback;
  // Last resort: a system PostgreSQL on PATH (brew / apt / EDB installer).
  const sys = which("pg_ctl");
  return sys ? path.dirname(sys) : null;
}

export function redisBin() {
  const local = path.join(DIRS.redis, exe("redis-server"));
  if (existsSync(local)) return local;
  return which("redis-server");
}
function redisCli() {
  const local = path.join(DIRS.redis, exe("redis-cli"));
  if (existsSync(local)) return local;
  return which("redis-cli");
}
export function minioBin() {
  const local = path.join(DIRS.minio, exe("minio"));
  if (existsSync(local)) return local;
  return which("minio");
}

// ── install ────────────────────────────────────────────────────────────────

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  if (IS_WIN) {
    const r = runSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
    if (r.status !== 0) throw new Error(`Expand-Archive failed: ${r.stderr || r.stdout}`);
  } else {
    const r = runSync("unzip", ["-q", "-o", zip, "-d", dest]);
    if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr || r.stdout}`);
  }
}

export async function install(services = ["redis", "minio"]) {
  ensureDirs();
  if (!postgresBinDir()) {
    log("✗ Postgres binaries missing — they come from the `embedded-postgres` devDependency. Run: npm ci");
  } else {
    log(`✓ postgres: ${postgresBinDir()}`);
  }
  if (!IS_WIN) {
    log("ℹ On macOS/Linux install Redis and MinIO with your package manager (brew install redis minio /");
    log("  apt install redis-server) — they are picked up from PATH — or keep using Docker (--infra=docker).");
    return;
  }
  for (const svc of services) {
    const d = DOWNLOADS[svc];
    if (!d) continue;
    const target = svc === "redis" ? path.join(DIRS.redis, "redis-server.exe") : path.join(DIRS.minio, "minio.exe");
    if (existsSync(target)) { log(`✓ ${svc}: already installed (${target})`); continue; }
    const file = path.join(DIRS.dl, d.file);
    if (!existsSync(file) || sha256File(file) !== d.sha256) {
      log(`▶ downloading ${svc} ${d.version}…`);
      const n = await download(d.url, file);
      log(`  ${(n / 1e6).toFixed(1)} MB`);
    }
    const got = sha256File(file);
    if (got !== d.sha256) { log(`✗ ${svc}: sha256 mismatch (${got}) — refusing to install`); process.exitCode = 1; continue; }
    if (svc === "redis") {
      const tmp = path.join(DIRS.dl, "redis-unzip");
      rmSync(tmp, { recursive: true, force: true });
      extractZip(file, tmp);
      // zip has a single top-level folder → flatten into .local/infra/redis/
      const inner = path.join(tmp, readdirSync(tmp)[0]);
      mkdirSync(DIRS.redis, { recursive: true });
      for (const f of readdirSync(inner)) renameSync(path.join(inner, f), path.join(DIRS.redis, f));
      rmSync(tmp, { recursive: true, force: true });
    } else {
      mkdirSync(DIRS.minio, { recursive: true });
      copyFileSync(file, target);
    }
    log(`✓ ${svc} ${d.version} → ${target}`);
  }
}

// ── postgres ───────────────────────────────────────────────────────────────

async function pgInit(cfg) {
  const bin = postgresBinDir();
  const data = dataDir("postgres");
  if (existsSync(path.join(data, "PG_VERSION"))) return false;
  log(`▶ postgres: initialising cluster in ${data} (user ${cfg.user})…`);
  mkdirSync(DIRS.data, { recursive: true });
  const pw = path.join(DIRS.run, "pg.pw");
  writeFileSync(pw, cfg.password + "\n");
  try {
    // Same as the postgres:16 image: superuser = the app user, UTF8 database.
    const r = await runDetachedAndWait(path.join(bin, exe("initdb")), [
      "-D", data, "-U", cfg.user, "--pwfile", pw, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C",
    ]);
    if (r.status !== 0) throw new Error(`initdb failed (${r.status}):\n${r.stderr || r.stdout}`);
  } finally {
    try { unlinkSync(pw); } catch {}
  }
  return true;
}

/**
 * Make sure cfg.database exists (the cluster only has `postgres` after
 * initdb). No psql in the zonky bundle, so use the `pg` client that ships as a
 * dependency of embedded-postgres. Not `postgres --single`: postgres.exe
 * refuses to run under an administrator token (GitHub's Windows runners,
 * elevated shells) — only pg_ctl/initdb drop privileges themselves.
 */
async function pgEnsureDatabase(cfg) {
  if (cfg.database === "postgres") return;
  let pg;
  try { pg = require("pg"); } catch { pg = null; }
  if (pg) {
    const client = new pg.Client({ host: "127.0.0.1", port: cfg.port, user: cfg.user, password: cfg.password, database: "postgres", connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [cfg.database]);
      if (!rowCount) await client.query(`CREATE DATABASE "${cfg.database.replace(/"/g, '""')}"`);
    } finally { await client.end(); }
    return;
  }
  // Fallback without the pg module: single-user mode (server must be stopped; not usable as admin).
  const bin = postgresBinDir();
  await pgStop();
  const r = spawnSync(path.join(bin, exe("postgres")), ["--single", "-D", dataDir("postgres"), "postgres"], {
    input: `CREATE DATABASE "${cfg.database.replace(/"/g, '""')}";\n`, encoding: "utf8", windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`CREATE DATABASE failed (${r.status}):\n${r.stderr || r.stdout}`);
  throw new Error("database created in single-user mode — run `up` again to start the server");
}

async function pgStart(cfg) {
  const bin = postgresBinDir();
  if (!bin) throw new Error("postgres binaries not found — run `npm ci` (embedded-postgres) or install PostgreSQL");
  const data = dataDir("postgres");
  await pgInit(cfg);
  // listen_addresses=localhost binds ::1 and 127.0.0.1 (Node resolves
  // "localhost" verbatim, often to ::1 first — same as the compose port map).
  const r = await runDetachedAndWait(path.join(bin, exe("pg_ctl")), [
    "-D", data, "-l", logFile("postgres"), "-w", "-t", "90",
    "-o", `-p ${cfg.port} -c listen_addresses=localhost`,
    "start",
  ], { log: logFile("pg_ctl") });
  if (r.status !== 0) throw new Error(`pg_ctl start failed (${r.status}):\n${r.stderr || r.stdout}\n--- ${logFile("postgres")}:\n${tail(logFile("postgres"), 15)}`);
  writePid("postgres", pgPid() || 0);
  await pgEnsureDatabase(cfg);
}

function pgPid() {
  try { return parseInt(readFileSync(path.join(dataDir("postgres"), "postmaster.pid"), "utf8").split(/\r?\n/)[0], 10) || null; } catch { return null; }
}

async function pgStop() {
  const bin = postgresBinDir();
  const data = dataDir("postgres");
  if (!bin || !existsSync(path.join(data, "PG_VERSION"))) { clearPid("postgres"); return; }
  const r = await runDetachedAndWait(path.join(bin, exe("pg_ctl")), ["-D", data, "-m", "fast", "-w", "-t", "60", "stop"], { log: logFile("pg_ctl") });
  if (r.status !== 0 && !/not running|no server running/i.test(r.stdout + r.stderr)) {
    const pid = pgPid();
    if (pid && pidAlive(pid)) killPid(pid);
  }
  clearPid("postgres");
}

// ── redis ──────────────────────────────────────────────────────────────────

async function redisStart(cfg) {
  const bin = redisBin();
  if (!bin) throw new Error("redis-server not found — run `node scripts/infra.mjs install` (Windows) or `brew install redis`");
  const data = dataDir("redis");
  mkdirSync(data, { recursive: true });
  const child = spawnDetached(bin, [
    "--port", String(cfg.port),
    "--bind", "127.0.0.1", "-::1",
    "--protected-mode", "yes",
    "--dir", data,
    "--save", "60", "1",         // same as the redis:7 image defaults (RDB snapshots)
    "--appendonly", "no",
    "--daemonize", "no",
    "--logfile", logFile("redis"),
  ], { cwd: data, svc: "redis", direct: true });
  writePid("redis", child.pid);
  if (!(await waitForPort(cfg.port, { timeoutMs: 30_000 }))) {
    throw new Error(`redis did not start listening on ${cfg.port}\n--- ${logFile("redis")}:\n${tail(logFile("redis"), 15)}`);
  }
}

async function redisStop(cfg) {
  const cli = redisCli();
  const pid = readPid("redis");
  if (cli && (await portOpen(cfg.port))) {
    runSync(cli, ["-p", String(cfg.port), "shutdown"], { stdio: "ignore" });
    await waitForPort(cfg.port, { timeoutMs: 15_000, want: false });
  }
  if (pid && pidAlive(pid)) killPid(pid);
  clearPid("redis");
}

// ── minio ──────────────────────────────────────────────────────────────────

async function minioStart(cfg) {
  const bin = minioBin();
  if (!bin) throw new Error("minio not found — run `node scripts/infra.mjs install` (Windows) or `brew install minio`");
  const data = dataDir("minio");
  mkdirSync(data, { recursive: true });
  const child = spawnDetached(bin, [
    "server", data, "--address", `:${cfg.port}`, "--console-address", `:${cfg.consolePort}`,
  ], { cwd: data, svc: "minio", env: { MINIO_ROOT_USER: cfg.user, MINIO_ROOT_PASSWORD: cfg.password } });
  writePid("minio", child.pid);
  if (!(await waitForPort(cfg.port, { timeoutMs: 30_000 }))) {
    throw new Error(`minio did not start listening on ${cfg.port}\n--- ${logFile("minio")}:\n${tail(logFile("minio"), 15)}`);
  }
}

async function minioStop(cfg) {
  const pid = readPid("minio");
  if (pid && pidAlive(pid)) killPid(pid);
  await waitForPort(cfg.port, { timeoutMs: 10_000, want: false });
  clearPid("minio");
}

// ── service table ──────────────────────────────────────────────────────────

const SERVICES = {
  postgres: { port: (c) => c.postgres.port, host: (c) => c.postgres.host, start: (c) => pgStart(c.postgres), stop: () => pgStop(), pid: () => pgPid() || readPid("postgres"), installed: () => !!postgresBinDir() },
  redis:    { port: (c) => c.redis.port,    host: (c) => c.redis.host,    start: (c) => redisStart(c.redis), stop: (c) => redisStop(c.redis), pid: () => readPid("redis"), installed: () => !!redisBin() },
  minio:    { port: (c) => c.minio.port,    host: (c) => c.minio.host,    start: (c) => minioStart(c.minio), stop: (c) => minioStop(c.minio), pid: () => readPid("minio"), installed: () => !!minioBin() },
};
export const SERVICE_NAMES = Object.keys(SERVICES);

// MinIO is opt-in (name it explicitly or INFRA_SERVICES=postgres,redis,minio):
// only the Admin → Integrations S3 test uses it and it costs ~200 MB RSS.
function defaultServices() {
  return ["postgres", "redis"];
}

function pickServices(args) {
  const names = args.filter((a) => !a.startsWith("--"));
  for (const n of names) if (!SERVICES[n]) { log(`✗ unknown service "${n}" (choose from ${SERVICE_NAMES.join(", ")})`); process.exit(2); }
  return names.length ? names : defaultServices();
}

export async function status(services = SERVICE_NAMES) {
  const cfg = config();
  const out = [];
  for (const name of services) {
    const s = SERVICES[name];
    const port = s.port(cfg);
    const pid = s.pid();
    out.push({
      service: name, port, pid: pid || null,
      running: pidAlive(pid), listening: await portOpen(port),
      installed: s.installed(), local: isLocalHost(s.host(cfg)),
    });
  }
  return out;
}

/** Start services (idempotent: a service already answering on its port is left alone). */
export async function up(services = defaultServices(), { quiet = false } = {}) {
  ensureDirs();
  const cfg = config();
  const say = quiet ? () => {} : log;
  const results = {};
  for (const name of services) {
    const s = SERVICES[name];
    const port = s.port(cfg);
    if (!isLocalHost(s.host(cfg))) { say(`ℹ ${name}: ${s.host(cfg)}:${port} is remote — not managed here`); results[name] = "remote"; continue; }
    if (await portOpen(port)) { say(`✓ ${name}: already listening on :${port}`); results[name] = "already"; continue; }
    say(`▶ ${name}: starting on :${port}…`);
    await s.start(cfg);
    say(`✓ ${name}: up on :${port} (pid ${s.pid()})`);
    results[name] = "started";
  }
  return results;
}

export async function down(services = [...SERVICE_NAMES].reverse(), { quiet = false } = {}) {
  const cfg = config();
  const say = quiet ? () => {} : log;
  for (const name of services) {
    const s = SERVICES[name];
    const port = s.port(cfg);
    const pid = s.pid();
    if (!(await portOpen(port)) && !pidAlive(pid)) { say(`· ${name}: not running`); clearPidIfOurs(name); continue; }
    say(`▶ ${name}: stopping…`);
    await s.stop(cfg);
    say(`✓ ${name}: stopped`);
  }
}
function clearPidIfOurs(name) { if (name !== "postgres") clearPid(name); }

function tail(file, n) {
  try { return readFileSync(file, "utf8").split(/\r?\n/).slice(-n).join("\n"); } catch { return "(no log)"; }
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "install": await install(rest.filter((a) => !a.startsWith("--")).length ? rest.filter((a) => !a.startsWith("--")) : undefined); break;
    case "up": await up(pickServices(rest)); break;
    case "down": await down(rest.filter((a) => !a.startsWith("--")).length ? pickServices(rest) : undefined); break;
    case "restart": { const svcs = pickServices(rest); await down([...svcs].reverse()); await up(svcs); break; }
    case "stop": await down(pickServices(rest)); break;     // compose-style aliases
    case "start": await up(pickServices(rest)); break;
    case "status": {
      const rows = await status();
      if (rest.includes("--json")) { log(JSON.stringify(rows, null, 2)); }
      else {
        for (const r of rows) {
          const state = !r.installed ? "not installed" : r.listening ? `UP  :${r.port} pid ${r.pid ?? "?"}` : r.running ? `pid ${r.pid} alive but :${r.port} not answering` : "down";
          log(`${r.service.padEnd(9)} ${state}`);
        }
      }
      // exit 0 when the default set (postgres + redis) is up; minio is informational
      const wanted = rows.filter((r) => defaultServices().includes(r.service) && r.local);
      process.exitCode = wanted.length && wanted.every((r) => r.listening) ? 0 : 1;
      break;
    }
    case "logs": {
      const svc = rest[0];
      if (!SERVICES[svc]) { log("usage: infra.mjs logs <postgres|redis|minio>"); process.exit(2); }
      log(tail(logFile(svc), Number((rest.find((a) => a.startsWith("--lines=")) || "").slice(8)) || 80));
      break;
    }
    case "reset": {
      const svc = rest[0];
      if (!SERVICES[svc]) { log("usage: infra.mjs reset <postgres|redis|minio> --yes"); process.exit(2); }
      if (!rest.includes("--yes")) { log(`This deletes ${dataDir(svc)}. Re-run with --yes.`); process.exit(2); }
      await down([svc]);
      rmSync(dataDir(svc), { recursive: true, force: true });
      log(`✓ ${svc}: data directory removed`);
      break;
    }
    case "dir": log(INFRA_DIR); break;
    default:
      log("usage: node scripts/infra.mjs <install|up|down|restart|status|logs|reset|dir> [service…]");
      log(`services: ${SERVICE_NAMES.join(", ")}   data: ${INFRA_DIR}`);
      process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`✗ ${e.message || e}`); process.exit(1); });
}
