import { prisma } from "../lib/prisma.js";
import { resolveConfig, RELAY_UNAVAILABLE_ERROR } from "@tenant-ai/shared";
import { RelaySendError } from "./messages-relay.js";
import { getRelayTransport } from "./relay-transport.js";

/**
 * Guarded, ledgered sending for the Messages.app relay.
 *
 * Every relay send in the system — survey links, owner forwards, heartbeats,
 * test sends, sweep retries — goes through relaySendWithGuards(). The
 * OutboundRelayMessage row is created BEFORE any send attempt: nothing
 * tenant-facing is fire-and-forget without a persistent record to retry from.
 */

export type RelayKind = "link" | "forward" | "heartbeat" | "test" | "confirmation";

export interface RelayMeta {
  kind: RelayKind;
  inviteId?: string;
  applicationId?: string;
}

const MAX_ATTEMPTS = 5;
const E164 = /^\+1\d{10}$/;

/** Same-tick reservation so two racing calls can't both pass the guards. */
const inFlight = new Set<string>();

async function cfgInt(key: string, def: number): Promise<number> {
  const raw = await resolveConfig("sms_relay", key);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Collapse user-supplied content so it cannot forge message structure when
 * embedded in a relayed SMS (a "name" of "John\n\nGHEM SECURITY: reply with
 * your password" must not render as a second paragraph from a trusted number).
 */
export function sanitizeForSms(value: string, maxLen = 80): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export interface RelayOutcome {
  id: string | null;
  status: "sent" | "deferred" | "failed" | "skipped";
  reason?: string;
}

/**
 * Create a ledger row and attempt the send, subject to:
 *  - opt-out (skipped for kind 'confirmation' — suppressing an opt-out
 *    confirmation is a compliance regression)
 *  - per-tenant cooldown (survey links only, keyed on *sent* links)
 *  - persisted hourly/daily caps + new-recipient/day cap (spoofable sender IDs
 *    mean these caps are what stand between the personal number and a
 *    smishing-signature spam flag; breaches defer, never silently drop)
 */
export async function relaySendWithGuards(
  to: string,
  text: string,
  meta: RelayMeta,
): Promise<RelayOutcome> {
  if (!E164.test(to)) {
    return { id: null, status: "failed", reason: `not E.164: ${to}` };
  }

  // Same-tick reservation (check-then-act without awaits in between)
  const flightKey = `${to}|${meta.kind}`;
  if (inFlight.has(flightKey)) {
    return { id: null, status: "skipped", reason: "duplicate in flight" };
  }
  inFlight.add(flightKey);

  try {
    // Opt-out: checked on every send, not just upstream.
    if (meta.kind !== "confirmation") {
      const optedOut = await prisma.smsOptOut.findFirst({ where: { phone: to } });
      if (optedOut) {
        return { id: null, status: "skipped", reason: "opted out" };
      }
    }

    const row = await prisma.outboundRelayMessage.create({
      data: {
        to,
        body: text,
        kind: meta.kind === "confirmation" ? "link" : meta.kind,
        status: "pending",
        inviteId: meta.inviteId ?? null,
        applicationId: meta.applicationId ?? null,
      },
    });

    // Per-tenant cooldown — survey links only, keyed on delivered-ish links.
    if (meta.kind === "link") {
      const cooldownMin = await cfgInt("cooldown_minutes", 60);
      if (cooldownMin > 0) {
        const since = new Date(Date.now() - cooldownMin * 60_000);
        const recent = await prisma.outboundRelayMessage.findFirst({
          where: {
            to,
            kind: "link",
            status: "sent",
            sentAt: { gt: since },
            id: { not: row.id },
          },
        });
        if (recent) {
          await prisma.outboundRelayMessage.update({
            where: { id: row.id },
            data: { status: "failed", lastError: "cooldown", attempts: MAX_ATTEMPTS },
          });
          return { id: row.id, status: "skipped", reason: "cooldown" };
        }
      }
    }

    const capped = await checkCaps(to, meta.kind);
    if (capped) {
      await prisma.outboundRelayMessage.update({
        where: { id: row.id },
        data: { status: "deferred", lastError: capped },
      });
      return { id: row.id, status: "deferred", reason: capped };
    }

    return await attemptSend(row.id, to, text);
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Cap check. Returns a reason string when the send must be deferred. */
async function checkCaps(to: string, kind: RelayKind): Promise<string | null> {
  const hourlyCap = await cfgInt("hourly_cap", 5);
  const dailyCap = await cfgInt("daily_cap", 25);
  const newRecipientCap = 10;
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 86_400_000);

  const [sentLastHour, sentLastDay] = await Promise.all([
    prisma.outboundRelayMessage.count({ where: { status: "sent", sentAt: { gt: hourAgo } } }),
    prisma.outboundRelayMessage.count({ where: { status: "sent", sentAt: { gt: dayAgo } } }),
  ]);

  // Reserve 2 slots/hour for forwards so links can't starve summaries.
  const effectiveHourly =
    kind === "forward" || kind === "heartbeat" ? hourlyCap : Math.max(1, hourlyCap - 2);
  if (sentLastHour >= effectiveHourly) return "hourly cap";
  if (sentLastDay >= dailyCap) return "daily cap";

  // New-recipient cap: first-contact sends per day.
  const priorToRecipient = await prisma.outboundRelayMessage.count({
    where: { to, status: "sent" },
  });
  if (priorToRecipient === 0) {
    const firstContactsToday = await prisma.outboundRelayMessage.groupBy({
      by: ["to"],
      where: { status: "sent", sentAt: { gt: dayAgo } },
    });
    const knownBefore = await prisma.outboundRelayMessage.groupBy({
      by: ["to"],
      where: { status: "sent", sentAt: { lte: dayAgo } },
    });
    const known = new Set(knownBefore.map((r) => r.to));
    const newToday = firstContactsToday.filter((r) => !known.has(r.to)).length;
    if (newToday >= newRecipientCap) return "new-recipient cap";
  }

  return null;
}

/** Send an existing ledger row and record the outcome on it. */
export async function attemptSend(
  rowId: string,
  to: string,
  text: string,
): Promise<RelayOutcome> {
  const transport = getRelayTransport();
  if (!transport.available) {
    // Not a failure of the send — there is nothing on this host that could
    // send. Park the row (no attempt consumed) so it surfaces in the status
    // panel and is retried by the sweep if the relay ever becomes available.
    await prisma.outboundRelayMessage.update({
      where: { id: rowId },
      data: { status: "deferred", lastError: RELAY_UNAVAILABLE_ERROR },
    });
    return { id: rowId, status: "deferred", reason: RELAY_UNAVAILABLE_ERROR };
  }

  await prisma.outboundRelayMessage.update({
    where: { id: rowId },
    data: { attempts: { increment: 1 } },
  });
  try {
    await transport.send(to, text);
    await prisma.outboundRelayMessage.update({
      where: { id: rowId },
      data: { status: "sent", sentAt: new Date(), lastError: null },
    });
    return { id: rowId, status: "sent" };
  } catch (err) {
    const e = err as RelaySendError;
    const lastError = e.isTcc ? "tcc" : (e.message || "send failed").slice(0, 500);
    await prisma.outboundRelayMessage.update({
      where: { id: rowId },
      data: { status: "failed", lastError },
    });
    if (e.isTcc) {
      transport.notify("Messages automation permission revoked — relay sends are failing. Re-approve in System Settings → Privacy → Automation.");
    }
    return { id: rowId, status: "failed", reason: lastError };
  }
}

// ── Sweep ──────────────────────────────────────────────────────────────────
//
// Deliberately a plain in-process setInterval, NOT a BullMQ job: the retry
// path must exist whenever the server does and must not depend on Redis.

const SWEEP_INTERVAL_MS = 10 * 60_000;
const MAX_SENDS_PER_SWEEP = 2;

let loggedUnavailable = false;

export async function sweepOnce(log: (msg: string) => void = () => {}): Promise<void> {
  let relayEnabled = (await resolveConfig("sms_relay", "enabled")) === "true";

  // On a host without a relay transport (anything but macOS) there is nothing
  // to retry and no heartbeat to send; skip the send steps but keep pruning.
  if (relayEnabled) {
    const transport = getRelayTransport();
    if (!transport.available) {
      if (!loggedUnavailable) {
        log(`relay sweep: relay is enabled in settings but unavailable here — ${transport.reason}`);
        loggedUnavailable = true;
      }
      relayEnabled = false;
    }
  }

  // 1. Retry failed (non-cooldown) and drain deferred rows — trickle, never burst.
  if (relayEnabled) {
    const candidates = await prisma.outboundRelayMessage.findMany({
      where: {
        OR: [
          { status: "deferred" },
          { status: "failed", lastError: { not: "cooldown" }, attempts: { lt: MAX_ATTEMPTS } },
          // pending rows older than 5 min = crashed mid-send before any attempt
          { status: "pending", createdAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
    });

    let sends = 0;
    for (const row of candidates) {
      if (sends >= MAX_SENDS_PER_SWEEP) break;
      const optedOut = await prisma.smsOptOut.findFirst({ where: { phone: row.to } });
      if (optedOut) {
        await prisma.outboundRelayMessage.update({
          where: { id: row.id },
          data: { status: "failed", lastError: "opted out", attempts: MAX_ATTEMPTS },
        });
        continue;
      }
      const capped = await checkCaps(row.to, row.kind as RelayKind);
      if (capped) continue; // stays deferred/failed for a later sweep
      const outcome = await attemptSend(row.id, row.to, row.body);
      log(`relay sweep: row ${row.id} → ${outcome.status}`);
      sends++;
    }
  }

  // 2. Daily heartbeat (only while the relay is on): a missing morning text is
  // the user's signal that forwarding silently died even when the Mac looks fine.
  if (relayEnabled) {
    const forwardTo = await resolveConfig("sms_relay", "forward_to");
    if (forwardTo && E164.test(forwardTo)) {
      const hour = new Date().getHours();
      if (hour >= 8) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const already = await prisma.outboundRelayMessage.findFirst({
          where: { kind: "heartbeat", createdAt: { gt: startOfDay } },
        });
        if (!already) {
          const date = new Date().toISOString().slice(0, 10);
          await relaySendWithGuards(forwardTo, `Tenant AI relay heartbeat ${date} — relay is up.`, { kind: "heartbeat" });
        }
      }
    }
  }

  // 3. Prune webhook-dedupe rows older than 7 days.
  await prisma.processedWebhookEvent.deleteMany({
    where: { receivedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
  });
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startRelaySweep(log: (msg: string) => void): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepOnce(log).catch((err) => log(`relay sweep error: ${err}`));
  }, SWEEP_INTERVAL_MS);
  // unref so the timer never keeps a dying process alive
  sweepTimer.unref?.();
}

export function stopRelaySweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
