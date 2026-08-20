// Must be the first import: populates process.env from .env before any module
// reads it (Prisma, config resolver, the PII key check below).
import "./lib/load-env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import { initConfigResolver } from "@tenant-ai/shared";
import { prismaConfigStore } from "./lib/config-store.js";
import { registerRateLimiting } from "./lib/rate-limit.js";
import { healthRoute } from "./routes/health.js";
import { voiceRoutes } from "./routes/twilio-voice.js";
import { smsRoutes } from "./routes/twilio-sms.js";
import { telnyxSmsRoutes } from "./routes/telnyx-sms.js";
import { telnyxVoiceRoutes } from "./routes/telnyx-voice.js";
import { surveyRoutes } from "./routes/survey.js";
import { ownerRoutes } from "./routes/owner.js";
import { internalRoutes } from "./routes/internal.js";
import { startRelaySweep } from "./services/relay-guards.js";
import { registerJob } from "./jobs/scheduler.js";
import { billingCycleJob } from "./jobs/billing-cycle.js";
import { rentPostingJob } from "./jobs/rent-posting.js";
import { lateFeeJob } from "./jobs/late-fee.js";
import { depositRemindersJob } from "./jobs/deposit-reminders.js";
import { leaseExpirationJob } from "./jobs/lease-expiration.js";
import { smsCleanupJob } from "./jobs/sms-cleanup.js";
import { registerShutdownHandlers } from "./lib/graceful-shutdown.js";
import { registerTwilioValidation } from "./lib/twilio-validate.js";

initConfigResolver(prismaConfigStore);

// Fail fast: a missing/malformed PII key must stop the boot, not burn a
// tenant's survey token mid-transaction later.
const piiKey = process.env.PII_ENCRYPTION_KEY;
if (!piiKey || !/^[0-9a-f]{64}$/i.test(piiKey)) {
  console.error("FATAL: PII_ENCRYPTION_KEY missing or not 64-char hex");
  process.exit(1);
}

const server = Fastify({
  logger: true,
  // Behind the tunnel every request arrives from 127.0.0.1 — trust the
  // forwarded headers so request.ip reflects the real peer.
  trustProxy: true,
});

// Plugins
await server.register(cors, {
  origin: true,
});
await server.register(formbody);
await server.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
await registerRateLimiting(server);
registerTwilioValidation(server);

// Routes
server.register(healthRoute);
server.register(voiceRoutes);
server.register(smsRoutes);
server.register(telnyxSmsRoutes);
server.register(telnyxVoiceRoutes);
server.register(surveyRoutes);
server.register(ownerRoutes);
server.register(internalRoutes);

// Graceful shutdown
registerShutdownHandlers(() => server.close());

const port = parseInt(process.env.SERVER_PORT || "3001", 10);
const host = process.env.SERVER_HOST || "0.0.0.0";

try {
  await server.listen({ port, host });
  server.log.info(`Server listening on ${host}:${port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// SMS relay sweep — plain setInterval (Prisma only, no Redis dependency):
// retries/drains the send ledger, daily heartbeat, webhook-dedupe pruning.
startRelaySweep((msg) => server.log.info(msg));

// Background jobs — registered AFTER listen so a hung Redis connection can
// never block the webhook endpoint from coming up. Each registration races a
// 10s timeout: Redis absence degrades (logged, skipped) instead of hanging.
const jobs = [billingCycleJob, rentPostingJob, lateFeeJob, depositRemindersJob, leaseExpirationJob, smsCleanupJob];
for (const job of jobs) {
  try {
    await Promise.race([
      registerJob(job),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("registerJob timed out after 10s")), 10_000)
      ),
    ]);
    server.log.info(`Registered job: ${job.name}`);
  } catch (err) {
    server.log.warn(`Failed to register job ${job.name} (Redis may be unavailable): ${err}`);
  }
}
