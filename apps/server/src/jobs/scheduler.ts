import { Queue, Worker, type Job, type ConnectionOptions } from "bullmq";
import { getRedisConnection, createRedisConnection } from "../lib/redis.js";

// ── Types ──

export interface JobDefinition {
  /** Unique name for this job type (e.g., "rent-posting", "late-fee") */
  name: string;
  /** The handler function that processes the job */
  handler: (job: Job) => Promise<void>;
  /** Cron pattern for recurring jobs (e.g., "0 0 * * *" for daily midnight) */
  cron?: string;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base backoff delay in ms (default: 1000). Exponential: delay * 2^attempt */
  backoffDelay?: number;
  /** Worker concurrency (default: 1) */
  concurrency?: number;
}

interface RegisteredJob {
  definition: JobDefinition;
  queue: Queue;
  worker: Worker;
  lastRunAt: Date | null;
  lastError: string | null;
}

// ── Scheduler ──

const registry = new Map<string, RegisteredJob>();
const workers: Worker[] = [];
// Set by shutdownScheduler(). Registration runs after `listen` and a shutdown
// can arrive in the middle of it; a Queue/Worker created on a connection that
// is being closed emits an 'error' nobody listens to and the process dies.
let shuttingDown = false;

export function isSchedulerShuttingDown(): boolean {
  return shuttingDown;
}

function onBullError(kind: "queue" | "worker", name: string) {
  return (err: Error) => {
    // During shutdown "Connection is closed" is expected noise; otherwise it's
    // worth seeing (Redis dropped, auth, …). Either way it must not be fatal.
    if (!shuttingDown) console.warn(`[scheduler] ${kind} "${name}" error: ${err.message}`);
  };
}

/**
 * Register a job definition. Creates a BullMQ Queue and Worker.
 * Call this during server startup for each job type.
 */
export async function registerJob(definition: JobDefinition): Promise<void> {
  const {
    name,
    handler,
    cron,
    maxRetries = 3,
    backoffDelay = 1000,
    concurrency = 1,
  } = definition;

  if (registry.has(name)) {
    throw new Error(`Job "${name}" is already registered`);
  }
  if (shuttingDown) {
    throw new Error(`Job "${name}" not registered: scheduler is shutting down`);
  }

  const connection = getRedisConnection() as unknown as ConnectionOptions;
  const workerConnection = createRedisConnection() as unknown as ConnectionOptions;

  // Create queue with default job options (retry, backoff, cleanup)
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: maxRetries + 1, // BullMQ counts initial attempt
      backoff: {
        type: "exponential",
        delay: backoffDelay,
      },
      removeOnComplete: { count: 100 }, // Keep last 100 completed
      removeOnFail: { count: 500 }, // Keep last 500 failed for debugging
    },
  });
  queue.on("error", onBullError("queue", name));

  // Create worker
  const worker = new Worker(
    name,
    async (job: Job) => {
      await handler(job);

      // Track last successful run
      const entry = registry.get(name);
      if (entry) {
        entry.lastRunAt = new Date();
        entry.lastError = null;
      }
    },
    {
      connection: workerConnection,
      concurrency,
    }
  );

  worker.on("error", onBullError("worker", name));
  worker.on("failed", (job, err) => {
    const entry = registry.get(name);
    if (entry) {
      entry.lastError = err.message;
    }
  });

  workers.push(worker);

  registry.set(name, {
    definition,
    queue,
    worker,
    lastRunAt: null,
    lastError: null,
  });

  // Schedule recurring job if cron is specified
  if (cron) {
    await queue.upsertJobScheduler(
      `${name}-scheduled`,
      { pattern: cron },
      {
        name,
        opts: {
          attempts: maxRetries + 1,
          backoff: {
            type: "exponential",
            delay: backoffDelay,
          },
        },
      }
    );
  }
}

/**
 * Add a one-off job to a registered queue.
 */
export async function addJob(
  name: string,
  data: Record<string, unknown> = {},
  options?: { jobId?: string; delay?: number }
): Promise<string | undefined> {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`Job "${name}" is not registered`);
  }

  const job = await entry.queue.add(name, data, {
    jobId: options?.jobId,
    delay: options?.delay,
  });

  return job.id;
}

/**
 * Get the last run timestamps for all registered jobs.
 * Used by the health endpoint.
 */
export function getLastJobRuns(): Record<
  string,
  { lastRunAt: string | null; lastError: string | null }
> {
  const result: Record<
    string,
    { lastRunAt: string | null; lastError: string | null }
  > = {};

  for (const [name, entry] of registry) {
    result[name] = {
      lastRunAt: entry.lastRunAt?.toISOString() ?? null,
      lastError: entry.lastError,
    };
  }

  return result;
}

/**
 * Get a registered queue by name.
 */
export function getQueue(name: string): Queue | undefined {
  return registry.get(name)?.queue;
}

/**
 * Get names of all registered jobs.
 */
export function getRegisteredJobNames(): string[] {
  return Array.from(registry.keys());
}

/**
 * Graceful shutdown: close all workers and queues.
 * Workers drain in-progress jobs before closing.
 */
export async function shutdownScheduler(): Promise<void> {
  // Refuse registrations while we close (see `shuttingDown`); once everything
  // is closed the scheduler is simply empty again, so tests (and a restart)
  // can register fresh jobs.
  shuttingDown = true;
  try {
    // Let every BullMQ connection finish initialising before closing it.
    // RedisConnection.close() on a connection that is still *initialising*
    // skips awaiting the init, removes all its listeners, and the pending init
    // then rejects ("Connection is closed" once the shared client goes away)
    // into an 'error' event nobody listens to — process exit 1. Happens when a
    // shutdown lands right after boot (drill, takeover, supervisor restart).
    // With Redis up this takes milliseconds; with Redis down init rejects on
    // the first connection error; the timeout is only a backstop.
    const settle = (p: Promise<unknown> | undefined, ms = 5000): Promise<void> =>
      p
        ? Promise.race([
            p.then(() => undefined, () => undefined),
            new Promise<void>((resolve) => {
              const t = setTimeout(resolve, ms);
              (t as { unref?: () => void }).unref?.();
            }),
          ])
        : Promise.resolve();
    type Internals = { blockingConnection?: { client: Promise<unknown> }; _jobScheduler?: { waitUntilReady(): Promise<unknown> } };
    await Promise.all([
      ...workers.flatMap((w) => [
        settle(w.waitUntilReady()),
        settle((w as unknown as Internals).blockingConnection?.client),
      ]),
      ...[...registry.values()].flatMap((e) => [
        settle(e.queue.waitUntilReady()),
        settle((e.queue as unknown as Internals)._jobScheduler?.waitUntilReady()),
      ]),
    ]);

    // Close workers first (drains in-progress jobs)
    await Promise.all(workers.map((w) => w.close()));

    // Close queues
    for (const [, entry] of registry) {
      await entry.queue.close();
    }

    registry.clear();
    workers.length = 0;
  } finally {
    shuttingDown = false;
  }
}
