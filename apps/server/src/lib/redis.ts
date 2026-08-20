import IORedis from "ioredis";

let connection: IORedis | null = null;

/**
 * Get a shared Redis connection for BullMQ.
 * BullMQ requires an ioredis instance (not a URL string).
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL || "redis://localhost:6380";
    connection = new IORedis(url, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });
  }
  return connection;
}

/**
 * Create a new Redis connection (for workers — each worker needs its own).
 */
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || "redis://localhost:6380";
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Close the shared Redis connection.
 */
export async function closeRedisConnection(timeoutMs = 3000): Promise<void> {
  if (!connection) return;
  const conn = connection;
  connection = null;
  // quit() waits for a reply; with Redis down (maxRetriesPerRequest: null)
  // that reply never comes and shutdown would hang. Bound it, then hard-close.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conn.quit(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    // already closed / never connected
  } finally {
    if (timer) clearTimeout(timer);
    try { conn.disconnect(); } catch { /* noop */ }
  }
}
