/**
 * Graceful shutdown handler for the Fastify server.
 *
 * Step 59: On SIGTERM (Docker stop, deploy):
 * 1. Stop accepting new calls
 * 2. Wait for active calls to finish (grace period: 120s)
 * 3. Close WebSocket connections
 * 4. Close Prisma connection
 * 5. Close Redis connection
 * 6. Exit
 */

import { prisma } from "./prisma.js";
import { closeRedisConnection } from "./redis.js";
import { shutdownScheduler } from "../jobs/scheduler.js";
import { getActiveCalls, getActiveCallCount } from "../services/monitoring.js";

const GRACE_PERIOD_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || "120000", 10);

let isShuttingDown = false;
let shutdownFn: ((reason: string) => Promise<void>) | null = null;

export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

/** Test hook: forget registered state (does not remove process listeners). */
export function _resetShutdownStateForTests(): void {
  isShuttingDown = false;
  shutdownFn = null;
}

/**
 * Programmatic shutdown trigger. Used by the IPC/stdin paths below and by the
 * stress harness. No-op until registerShutdownHandlers() has been called.
 */
export function requestShutdown(reason: string): Promise<void> {
  return shutdownFn ? shutdownFn(reason) : Promise.resolve();
}

/**
 * Register shutdown handlers on the given server.
 * Call this once during startup.
 *
 * Triggers:
 *  - SIGTERM / SIGINT — Docker stop, Ctrl-C, `kill` (macOS/Linux; Ctrl-C on Windows)
 *  - IPC message { type: "shutdown" } — from a launcher that spawned us with an
 *    IPC channel. Needed on Windows, where SIGTERM does not exist and
 *    process.kill() from another process is always a hard kill.
 *  - stdin end (opt-in via SHUTDOWN_ON_STDIN_END=1) — the launcher holds our
 *    stdin pipe; if it dies or closes it, we shut down instead of orphaning.
 */
export function registerShutdownHandlers(
  closeServer: () => Promise<void>,
  opts: { exit?: (code: number) => void } = {}
): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[shutdown] Received ${signal}. Starting graceful shutdown...`);

    // 1. Stop accepting new connections
    try {
      await closeServer();
      console.log("[shutdown] Server stopped accepting new connections.");
    } catch (err) {
      console.error("[shutdown] Error closing server:", err);
    }

    // 2. Wait for active calls to finish
    const activeCount = getActiveCallCount();
    if (activeCount > 0) {
      console.log(
        `[shutdown] Waiting for ${activeCount} active call(s) to complete (grace: ${GRACE_PERIOD_MS / 1000}s)...`
      );

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (getActiveCallCount() === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);

        // Force close after grace period
        setTimeout(() => {
          clearInterval(checkInterval);
          const remaining = getActiveCalls();
          if (remaining.length > 0) {
            console.log(
              `[shutdown] Grace period expired. Force-closing ${remaining.length} call(s).`
            );
          }
          resolve();
        }, GRACE_PERIOD_MS);
      });
    }

    // 3. Shutdown BullMQ workers and queues (bounded: with Redis unreachable,
    //    worker/queue close can wait on replies that never arrive)
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        shutdownScheduler(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn("[shutdown] Scheduler close timed out — continuing.");
            resolve();
          }, 10_000);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      console.log("[shutdown] BullMQ scheduler shut down.");
    } catch (err) {
      console.error("[shutdown] Error shutting down scheduler:", err);
    }

    // 4. Close Redis
    try {
      await closeRedisConnection();
      console.log("[shutdown] Redis connection closed.");
    } catch (err) {
      console.error("[shutdown] Error closing Redis:", err);
    }

    // 5. Close Prisma
    try {
      await prisma.$disconnect();
      console.log("[shutdown] Prisma connection closed.");
    } catch (err) {
      console.error("[shutdown] Error disconnecting Prisma:", err);
    }

    console.log("[shutdown] Graceful shutdown complete.");
    exit(0);
  };

  shutdownFn = shutdown;

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Launcher IPC (cross-platform; the only graceful option on Windows).
  if (typeof process.send === "function") {
    process.on("message", (msg: unknown) => {
      if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "shutdown") {
        shutdown("ipc");
      }
    });
  }

  // Parent-died detection: launcher closes (or loses) our stdin pipe.
  if (process.env.SHUTDOWN_ON_STDIN_END === "1" && process.stdin && !process.stdin.isTTY) {
    process.stdin.on("end", () => shutdown("stdin-end"));
    process.stdin.on("error", () => shutdown("stdin-error"));
    process.stdin.resume();
  }
}
