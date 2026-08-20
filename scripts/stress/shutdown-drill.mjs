#!/usr/bin/env node
/**
 * Shutdown drill for the API server (M3 gate).
 *
 *   node scripts/stress/shutdown-drill.mjs [--cycles 20] [--port 3091]
 *        [--mode ipc|stdin|sigint|hard] [--grace 15000]
 *
 * Each cycle: spawn `node dist/index.js` exactly the way the launcher does
 * (IPC channel + stdin pipe), wait for /health, trigger the shutdown via the
 * chosen path, then assert: exit code 0 (or expected kill for --mode hard),
 * the port is released, no process is left behind, and the next cycle can
 * bind the same port immediately. Requires a reachable DATABASE_URL (the
 * server boots without Redis — jobs degrade, which this drill also records).
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null)).filter(Boolean),
);
const cycles = parseInt(args.cycles || "5", 10);
const port = parseInt(args.port || "3091", 10);
const mode = args.mode || "ipc";
const grace = parseInt(args.grace || "15000", 10);
const IS_WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function waitHealthy(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200 || r.status === 503) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`server on :${port} never answered /health`);
}

/**
 * Close every handle we hold on a child (IPC channel, stdin pipe, stderr pipe)
 * and wait for "close". Exiting while one of them is still closing trips a
 * libuv assertion on Windows (src\win\async.c: UV_HANDLE_CLOSING) and turns a
 * passing drill into a non-zero exit — intermittently, which is worse.
 */
async function teardown(child) {
  const closed = new Promise((resolve) => child.once("close", resolve));
  try { child.disconnect(); } catch {}
  try { child.stdin?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
  await Promise.race([closed, sleep(3000)]);
}

const results = [];
let aborted = false;
for (let i = 1; i <= cycles; i++) {
  if (!(await portFree(port))) throw new Error(`cycle ${i}: port ${port} busy before start`);
  const t0 = Date.now();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: path.join(ROOT, "apps", "server"),
    env: { ...process.env, SERVER_PORT: String(port), SHUTDOWN_ON_STDIN_END: "1", SHUTDOWN_GRACE_MS: String(grace), NODE_ENV: "production" },
    stdio: ["pipe", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  let health;
  try {
    health = await waitHealthy();
  } catch (err) {
    // Never leave an orphan behind when the drill itself fails.
    child.kill("SIGKILL");
    console.log(`✗ cycle ${i}: ${err.message}\n    stderr: ${stderr.slice(-1200)}`);
    await teardown(child);
    aborted = true;
    break;
  }
  const tUp = Date.now() - t0;

  const t1 = Date.now();
  if (mode === "ipc") child.send({ type: "shutdown" });
  else if (mode === "stdin") child.stdin.end();
  else if (mode === "sigint") child.kill("SIGINT"); // hard kill on Windows
  else if (mode === "hard") child.kill("SIGKILL");
  else throw new Error(`unknown mode ${mode}`);

  const outcome = await Promise.race([exited, sleep(grace + 30_000).then(() => ({ code: null, signal: "TIMEOUT" }))]);
  const tDown = Date.now() - t1;
  if (outcome.signal === "TIMEOUT") { child.kill("SIGKILL"); }
  await teardown(child);

  // Port must be free promptly after exit
  let freedAfter = null;
  for (let w = 0; w < 40; w++) { if (await portFree(port)) { freedAfter = w * 250; break; } await sleep(250); }

  const expectClean = mode === "ipc" || mode === "stdin" || (mode === "sigint" && !IS_WIN);
  const pass = freedAfter !== null && (expectClean ? outcome.code === 0 : true);
  results.push({ cycle: i, mode, bootMs: tUp, shutdownMs: tDown, exit: outcome, portFreedAfterMs: freedAfter, dbConnected: health.dbConnected, redisConnected: health.redisConnected, pass });
  console.log(`${pass ? "✓" : "✗"} cycle ${i}/${cycles}: boot ${tUp}ms, ${mode} shutdown ${tDown}ms, exit ${JSON.stringify(outcome)}, port freed after ${freedAfter}ms${pass ? "" : `\n    stderr: ${stderr.slice(-800)}`}`);
  if (!pass && /TIMEOUT/.test(String(outcome.signal))) console.log("    (hung in shutdown — check Redis/BullMQ close with Redis down)");
}

const failed = results.filter((r) => !r.pass).length + (aborted ? 1 : 0);
const avg = (k) => Math.round(results.reduce((s, r) => s + (r[k] || 0), 0) / Math.max(1, results.length));
console.log(`\n${failed === 0 ? "✓" : "✗"} ${cycles - failed}/${cycles} clean cycles; avg boot ${avg("bootMs")}ms, avg shutdown ${avg("shutdownMs")}ms, redisConnected=${results[0]?.redisConnected}`);
// Let the event loop drain instead of process.exit() — see teardown().
process.exitCode = failed ? 1 : 0;
