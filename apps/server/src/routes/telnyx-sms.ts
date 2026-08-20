import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveConfig } from "@tenant-ai/shared";
import { prisma } from "../lib/prisma.js";
import { handleIncomingSms } from "../handlers/sms-handler.js";
import { smsRateLimitConfig } from "../lib/rate-limit.js";
import { telnyxSignatureHook } from "../lib/telnyx-validate.js";
import { sendTelnyxSms } from "../services/telnyx-client.js";
import { relaySendWithGuards } from "../services/relay-guards.js";
import { getRelayTransport } from "../services/relay-transport.js";

interface TelnyxWebhookBody {
  data?: {
    event_type?: string;
    payload?: {
      id?: string;
      direction?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
    };
  };
}

/** (708) 907-0695-style rendering for message copy. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Adjust reply copy for relay mode, where the tenant receives the text from
 * the personal number rather than the number they texted:
 *  - prefix with the property identity + the number they texted, so the
 *    lock-screen preview explains the unfamiliar sender
 *  - point STOP at the Telnyx number (the only number that processes STOP —
 *    a STOP reply to the personal iPhone reaches nothing)
 */
export function rewriteForRelay(
  text: string,
  propertyName: string,
  telnyxNumber: string,
): string {
  const pretty = prettyPhone(telnyxNumber);
  const rewritten = text
    .replace(/Reply STOP at any time to opt out\./g, `To opt out, text STOP to ${pretty}.`)
    .replace(/Reply STOP to opt out\./g, `To opt out, text STOP to ${pretty}.`);
  return `${propertyName} (you texted ${pretty}): ${rewritten}`;
}

/**
 * Record a Telnyx message id as processed. Returns false when the id was seen
 * before (webhook retry) — DB-backed so it survives restarts across Telnyx's
 * retry window.
 */
export async function recordWebhookEvent(messageId: string): Promise<boolean> {
  try {
    await prisma.processedWebhookEvent.create({
      data: { provider: "telnyx", messageId },
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") return false; // unique violation — already processed
    throw err;
  }
}

// Per-phone serialization: a retry racing the original (or a double-tap send)
// must not mint two tokens or send two texts for the same phone.
const phoneChains = new Map<string, Promise<unknown>>();

export function serializedByPhone<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const prev = phoneChains.get(phone) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  phoneChains.set(
    phone,
    next.catch(() => {}).finally(() => {
      if (phoneChains.get(phone) === next) phoneChains.delete(phone);
    }),
  );
  return next;
}

/**
 * Process an inbound Telnyx message: run it through the shared SMS handler,
 * then deliver replies via the active outbound path — Telnyx API normally, or
 * the Messages.app relay while sms_relay.enabled is on (10DLC pending).
 * Returns the number of replies attempted.
 */
export async function processTelnyxInbound(
  payload: NonNullable<NonNullable<TelnyxWebhookBody["data"]>["payload"]>,
): Promise<number> {
  const from = payload.from?.phone_number;
  const to = payload.to?.[0]?.phone_number;
  const text = payload.text;

  if (!from || !to || !text) {
    return 0;
  }

  return serializedByPhone(from, async () => {
    const result = await handleIncomingSms(from, to, text);

    // The relay can be switched on in settings but have no transport on this
    // host (it needs macOS Messages). In that case replies go out through the
    // Telnyx API exactly as they do with the relay off — the documented
    // rollback path — instead of piling up as deferred ledger rows.
    const relayEnabled =
      (await resolveConfig("sms_relay", "enabled")) === "true" &&
      getRelayTransport().available;

    // Tenant free-text is NOT forwarded to the owner — it is persisted to
    // SmsConversation (dashboard Messages tab). Only completed application
    // summaries are forwarded (survey-forward.ts).

    if (!result.shouldRespond || result.replies.length === 0) {
      return 0;
    }

    // Send sequentially so multi-part replies arrive in order
    for (const reply of result.replies) {
      if (relayEnabled) {
        const property = await prisma.property.findFirst({
          where: { twilioPhone: to },
          select: { name: true },
        });
        await relaySendWithGuards(
          from,
          rewriteForRelay(reply, property?.name ?? "Property", to),
          { kind: result.replyKind === "confirmation" ? "confirmation" : "link" },
        );
      } else {
        await sendTelnyxSms(to, from, reply);
      }
    }
    return result.replies.length;
  });
}

export async function telnyxSmsRoutes(server: FastifyInstance): Promise<void> {
  // Signature validation needs the exact bytes Telnyx signed, so replace the
  // JSON parser within this plugin's scope to keep the raw body around.
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      (request as FastifyRequest & { rawBody?: string }).rawBody =
        body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * POST /telnyx/sms — Telnyx messaging webhook.
   *
   * Acknowledges immediately and processes in the background: Telnyx retries
   * webhooks that don't 2xx quickly, and the AI roundtrip can take seconds.
   * Replies are delivered out-of-band (Telnyx API or Messages relay).
   */
  server.post<{ Body: TelnyxWebhookBody }>(
    "/telnyx/sms",
    { ...smsRateLimitConfig, preHandler: telnyxSignatureHook },
    async (request, reply: FastifyReply) => {
      const data = request.body?.data;

      // Ignore delivery receipts and other non-inbound events
      if (
        data?.event_type !== "message.received" ||
        data.payload?.direction !== "inbound"
      ) {
        reply.code(200).send({ received: true });
        return;
      }

      // Dedupe on the Telnyx message id: retries (ngrok blips dropping the 200
      // mid-flight cause them routinely) must not double-process.
      const messageId = data.payload?.id;
      if (messageId) {
        const fresh = await recordWebhookEvent(messageId).catch(() => true);
        if (!fresh) {
          reply.code(200).send({ received: true, duplicate: true });
          return;
        }
      }

      reply.code(200).send({ received: true });

      processTelnyxInbound(data.payload).catch((err) => {
        request.log.error({ err }, "Telnyx SMS processing failed");
      });
    },
  );
}
