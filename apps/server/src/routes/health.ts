import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getLastJobRuns } from "../jobs/scheduler.js";
import { getRedisConnection } from "../lib/redis.js";
import {
  getActiveCallCount,
  getRecentErrors,
} from "../services/monitoring.js";

/**
 * Redis probe that cannot hang. The shared ioredis client runs with
 * maxRetriesPerRequest: null (BullMQ requires it), which means a command
 * issued while Redis is down is queued indefinitely instead of rejected —
 * and an awaited ping() would hang this route forever. Bound it.
 */
async function redisPing(timeoutMs = 1500): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const redis = getRedisConnection();
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs);
      }),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function healthRoute(server: FastifyInstance) {
  server.get("/health", async (_req, reply) => {
    let dbConnected = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
    } catch {
      // DB not connected
    }

    const redisConnected = await redisPing();

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentErrorCount = getRecentErrors().filter(
      (e) => e.timestamp > fiveMinAgo
    ).length;

    let status: "ok" | "degraded" | "down" = "ok";
    if (!dbConnected) status = "down";
    else if (recentErrorCount >= 3) status = "degraded";

    const statusCode = status === "down" ? 503 : 200;

    const mem = process.memoryUsage();

    return reply.status(statusCode).send({
      status,
      activeCalls: getActiveCallCount(),
      maxCalls: parseInt(process.env.MAX_CONCURRENT_CALLS || "10", 10),
      memoryUsage: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      uptime: Math.round(process.uptime()),
      database: dbConnected ? "connected" : "disconnected",
      version: process.env.APP_VERSION || "1.0.0",
      dbConnected,
      redisConnected,
      lastJobRuns: getLastJobRuns(),
      recentErrorCount,
    });
  });

  // Deep health: 200 only when Postgres answers. /telnyx/sms 200s before any
  // DB access, so with the DB down the server looks alive while inbound
  // processing silently fails — this is the endpoint external monitors watch.
  server.get("/health/deep", async (_req, reply) => {
    let dbConnected = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
    } catch {
      // DB not reachable
    }
    // Redis failure is reported but non-fatal (and bounded — see redisPing)
    const redisConnected = await redisPing();
    return reply
      .status(dbConnected ? 200 : 503)
      .send({ status: dbConnected ? "ok" : "down", dbConnected, redisConnected });
  });
}
