process.env.PII_ENCRYPTION_KEY =
  process.env.PII_ENCRYPTION_KEY ||
  "b18f16b9017984f6a8fa9432ef01309a460666f71e81651f2f1a034e43b49521";
// These tests exercise the Messages.app path (mocked below) and must behave
// identically on macOS, Windows and Linux CI — pin the transport explicitly.
process.env.RELAY_TRANSPORT = "macos-messages";

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { PrismaClient } from "@prisma/client";
import { clearConfigCache, decrypt } from "@tenant-ai/shared";

// ── Mocks: never touch osascript in tests ──
const mockSend = vi.fn();
vi.mock("../services/messages-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/messages-relay.js")>();
  return {
    ...actual,
    sendViaMessagesRelay: (...args: unknown[]) => mockSend(...args),
    notifyOnMac: vi.fn(),
  };
});

// Telnyx API + inbound handler are mocked so the delivery-seam tests can
// assert which outbound path was chosen without network or OpenAI.
const mockTelnyxSend = vi.fn();
vi.mock("../services/telnyx-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/telnyx-client.js")>();
  return { ...actual, sendTelnyxSms: (...args: unknown[]) => mockTelnyxSend(...args) };
});
const mockHandleIncoming = vi.fn();
vi.mock("../handlers/sms-handler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handlers/sms-handler.js")>();
  return { ...actual, handleIncomingSms: (...args: unknown[]) => mockHandleIncoming(...args) };
});

import { aplEscape, aplString, isTccError } from "../services/messages-relay.js";
import {
  relaySendWithGuards,
  sanitizeForSms,
} from "../services/relay-guards.js";
import {
  rewriteForRelay,
  prettyPhone,
  recordWebhookEvent,
  serializedByPhone,
} from "../routes/telnyx-sms.js";
import { surveyRoutes } from "../routes/survey.js";
import {
  generateSurveyToken,
  surveyInviteExpiry,
} from "@tenant-ai/shared";

const prisma = new PrismaClient();
const TEST_PREFIX = `test_smsrelay_${Date.now()}`;
const PHONE_A = `+1312${Date.now().toString().slice(-7)}`;
const PHONE_B = `+1773${Date.now().toString().slice(-7)}`;
const TEST_PHONES = [PHONE_A, PHONE_B];

let userId: string;
let propertyId: string;

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}@test.com`,
      name: "Relay Tester",
      passwordHash: "x",
      role: "client",
      onboarded: true,
    },
  });
  userId = user.id;
  const property = await prisma.property.create({
    data: {
      name: `${TEST_PREFIX}_prop`,
      address: "1 Relay Way",
      userId,
      isActive: true,
      smsIntakeEnabled: true,
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.outboundRelayMessage.deleteMany({ where: { to: { in: TEST_PHONES } } });
  await prisma.smsOptOut.deleteMany({ where: { phone: { in: TEST_PHONES } } });
  await prisma.processedWebhookEvent.deleteMany({
    where: { messageId: { startsWith: TEST_PREFIX } },
  });
  await prisma.surveyInvite.deleteMany({ where: { propertyId } });
  await prisma.application.deleteMany({ where: { propertyId } });
  await prisma.smsConversation.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  process.env.RELAY_TRANSPORT = "macos-messages";
  clearConfigCache();
  // generous defaults; individual tests override
  process.env.SMS_RELAY_ENABLED = "true";
  process.env.SMS_RELAY_COOLDOWN_MIN = "60";
  process.env.SMS_RELAY_HOURLY_CAP = "100";
  process.env.SMS_RELAY_DAILY_CAP = "200";
  await prisma.outboundRelayMessage.deleteMany({ where: { to: { in: TEST_PHONES } } });
});

// ── AppleScript escaping ──

describe("messages-relay escaping", () => {
  it("escapes quotes and backslashes", () => {
    expect(aplEscape('say "hi" \\ bye')).toBe('say \\"hi\\" \\\\ bye');
  });

  it("joins newlines with linefeed expressions", () => {
    expect(aplString("a\nb")).toBe('"a" & linefeed & "b"');
  });

  it("classifies TCC errors", () => {
    expect(isTccError("execution error: Not authorized to send Apple events (-1743)")).toBe(true);
    expect(isTccError("some network failure")).toBe(false);
  });
});

// ── sanitizeForSms ──

describe("sanitizeForSms", () => {
  it("collapses newlines and control chars so structure can't be forged", () => {
    const evil = "John\n\nGHEM SECURITY: reply with your password";
    expect(sanitizeForSms(evil, 200)).toBe("John GHEM SECURITY: reply with your password");
  });

  it("caps length", () => {
    expect(sanitizeForSms("x".repeat(500), 80)).toHaveLength(80);
  });
});

// ── relay copy rewrite ──

describe("rewriteForRelay", () => {
  it("prefixes identity and repoints STOP at the Telnyx number", () => {
    const out = rewriteForRelay(
      "Here is your link\nhttps://x.test/survey/abc\n\nReply STOP to opt out.",
      "Ghem LLC 1",
      "+17089070695",
    );
    expect(out.startsWith("Ghem LLC 1 (you texted (708) 907-0695): ")).toBe(true);
    expect(out).toContain("To opt out, text STOP to (708) 907-0695.");
    expect(out).not.toContain("Reply STOP to opt out.");
  });

  it("prettyPhone formats E.164", () => {
    expect(prettyPhone("+17089070695")).toBe("(708) 907-0695");
  });
});

// ── guards + ledger ──

describe("relaySendWithGuards", () => {
  it("sends and records a sent ledger row", async () => {
    const outcome = await relaySendWithGuards(PHONE_A, "hello", { kind: "link" });
    expect(outcome.status).toBe("sent");
    expect(mockSend).toHaveBeenCalledWith(PHONE_A, "hello");
    const row = await prisma.outboundRelayMessage.findUnique({ where: { id: outcome.id! } });
    expect(row?.status).toBe("sent");
    expect(row?.sentAt).toBeTruthy();
  });

  it("rejects non-E.164 recipients without a ledger row", async () => {
    const outcome = await relaySendWithGuards("708-415-8984", "hi", { kind: "link" });
    expect(outcome.status).toBe("failed");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("suppresses a second link within the cooldown window", async () => {
    const first = await relaySendWithGuards(PHONE_A, "link 1", { kind: "link" });
    expect(first.status).toBe("sent");
    const second = await relaySendWithGuards(PHONE_A, "link 2", { kind: "link" });
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("cooldown");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const row = await prisma.outboundRelayMessage.findUnique({ where: { id: second.id! } });
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("cooldown");
  });

  it("cooldown does not apply to forwards", async () => {
    await relaySendWithGuards(PHONE_A, "link", { kind: "link" });
    const fwd = await relaySendWithGuards(PHONE_A, "forward", { kind: "forward" });
    expect(fwd.status).toBe("sent");
  });

  it("skips sends to opted-out phones but not confirmations", async () => {
    await prisma.smsOptOut.create({ data: { phone: PHONE_B, propertyId } });
    const link = await relaySendWithGuards(PHONE_B, "link", { kind: "link" });
    expect(link.status).toBe("skipped");
    expect(link.reason).toBe("opted out");
    const conf = await relaySendWithGuards(PHONE_B, "You've been unsubscribed.", { kind: "confirmation" });
    expect(conf.status).toBe("sent");
    await prisma.smsOptOut.deleteMany({ where: { phone: PHONE_B } });
  });

  it("defers instead of dropping when the hourly cap is hit", async () => {
    // Three fresh sent rows + cap 5 → effective link cap 3 → next link defers
    process.env.SMS_RELAY_HOURLY_CAP = "5";
    clearConfigCache();
    const now = new Date();
    await prisma.outboundRelayMessage.createMany({
      data: [0, 1, 2].map((i) => ({
        to: PHONE_B,
        body: `warm ${i}`,
        kind: "link",
        status: "sent",
        sentAt: now,
      })),
    });
    const outcome = await relaySendWithGuards(PHONE_A, "one too many", { kind: "link" });
    expect(outcome.status).toBe("deferred");
    const row = await prisma.outboundRelayMessage.findUnique({ where: { id: outcome.id! } });
    expect(row?.status).toBe("deferred");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records failures with TCC classification", async () => {
    const { RelaySendError } = await import("../services/messages-relay.js");
    mockSend.mockRejectedValue(new RelaySendError("Not authorized to send Apple events (-1743)"));
    const outcome = await relaySendWithGuards(PHONE_A, "will fail", { kind: "link" });
    expect(outcome.status).toBe("failed");
    const row = await prisma.outboundRelayMessage.findUnique({ where: { id: outcome.id! } });
    expect(row?.lastError).toBe("tcc");
  });
});

// ── platform transport (Windows/Linux hosts have no Messages.app) ──

describe("relay transport unavailable on this platform", () => {
  beforeEach(() => {
    process.env.RELAY_TRANSPORT = "none";
  });

  it("parks the ledger row as deferred with a platform reason and never calls osascript", async () => {
    const { RELAY_UNAVAILABLE_ERROR } = await import("@tenant-ai/shared");
    const outcome = await relaySendWithGuards(PHONE_A, "hello from windows", { kind: "link" });
    expect(outcome.status).toBe("deferred");
    expect(outcome.reason).toBe(RELAY_UNAVAILABLE_ERROR);
    expect(mockSend).not.toHaveBeenCalled();
    const row = await prisma.outboundRelayMessage.findUnique({ where: { id: outcome.id! } });
    expect(row?.status).toBe("deferred");
    expect(row?.lastError).toBe(RELAY_UNAVAILABLE_ERROR);
    // no attempt consumed — nothing was tried
    expect(row?.attempts).toBe(0);
  });

  it("the sweep does not try to drain deferred rows or send a heartbeat", async () => {
    const { sweepOnce } = await import("../services/relay-guards.js");
    process.env.SMS_RELAY_FORWARD_TO = PHONE_B;
    clearConfigCache();
    const logs: string[] = [];
    await sweepOnce((m) => logs.push(m));
    expect(mockSend).not.toHaveBeenCalled();
    const heartbeat = await prisma.outboundRelayMessage.findFirst({
      where: { to: PHONE_B, kind: "heartbeat" },
    });
    expect(heartbeat).toBeNull();
    delete process.env.SMS_RELAY_FORWARD_TO;
  });

  it("processTelnyxInbound falls back to the Telnyx API when the relay has no transport", async () => {
    mockTelnyxSend.mockResolvedValue(undefined);
    mockHandleIncoming.mockResolvedValue({
      shouldRespond: true,
      replies: ["Thanks — here is your link"],
      replyKind: "link",
    });
    const { processTelnyxInbound } = await import("../routes/telnyx-sms.js");
    const sent = await processTelnyxInbound({
      from: { phone_number: PHONE_A },
      to: [{ phone_number: "+17089070695" }],
      text: "hi",
    } as any);
    expect(sent).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockTelnyxSend).toHaveBeenCalledTimes(1);
    expect(mockTelnyxSend).toHaveBeenCalledWith("+17089070695", PHONE_A, "Thanks — here is your link");
  });

  it("processTelnyxInbound uses the relay when a transport is available", async () => {
    process.env.RELAY_TRANSPORT = "macos-messages";
    mockTelnyxSend.mockResolvedValue(undefined);
    mockHandleIncoming.mockResolvedValue({
      shouldRespond: true,
      replies: ["Thanks — here is your link"],
      replyKind: "link",
    });
    const { processTelnyxInbound } = await import("../routes/telnyx-sms.js");
    await processTelnyxInbound({
      from: { phone_number: PHONE_B },
      to: [{ phone_number: "+17089070695" }],
      text: "hi",
    } as any);
    expect(mockTelnyxSend).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ── webhook dedupe + serialization ──

describe("webhook dedupe and per-phone serialization", () => {
  it("recordWebhookEvent returns true once, false on replay", async () => {
    const id = `${TEST_PREFIX}_msg1`;
    expect(await recordWebhookEvent(id)).toBe(true);
    expect(await recordWebhookEvent(id)).toBe(false);
  });

  it("serializedByPhone runs same-phone work sequentially", async () => {
    const order: number[] = [];
    const slow = serializedByPhone(PHONE_A, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const fast = serializedByPhone(PHONE_A, async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });
});

// ── survey routes ──

describe("survey routes", () => {
  async function makeServer() {
    const server = Fastify();
    await server.register(formbody);
    await server.register(surveyRoutes);
    await server.ready();
    return server;
  }

  // The partial unique index allows only ONE outstanding invite per
  // phone+property, so every invite gets its own phone.
  let phoneSeq = 1000;
  function freshPhone(): string {
    return `+1312555${(phoneSeq++).toString().padStart(4, "0")}`;
  }

  async function makeInvite(phone = freshPhone()) {
    return prisma.surveyInvite.create({
      data: {
        token: generateSurveyToken(),
        propertyId,
        phone,
        channel: "sms",
        expiresAt: surveyInviteExpiry(),
      },
    });
  }

  const VALID_FORM = new URLSearchParams({
    email: "jane@example.com",
    full_name: "Jane Renter",
    contact_phone: "+13125550000",
    dob: "1994-05-12",
    bedrooms_needed: "2",
    household_size: "3",
    employer: "Acme Corp",
    employment_start_date: "2023-01-15",
    employed_one_year: "Yes",
    gross_monthly_income: "4200",
    time_at_current_address: "2 years",
  }).toString();

  it("GET renders the form with all 11 questions for a valid token", async () => {
    const server = await makeServer();
    const invite = await makeInvite();
    const res = await server.inject({ method: "GET", url: `/survey/${invite.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    for (const key of ["email", "full_name", "dob", "bedrooms_needed", "household_size", "employer", "employment_start_date", "employed_one_year", "gross_monthly_income", "time_at_current_address"]) {
      expect(res.body).toContain(`name="${key}"`);
    }
    expect(res.body).toContain(invite.phone); // phone prefilled from invite
    await server.close();
  });

  it("GET 404s unknown tokens and 410s used/expired ones", async () => {
    const server = await makeServer();
    const bad = await server.inject({ method: "GET", url: `/survey/${generateSurveyToken()}` });
    expect(bad.statusCode).toBe(404);

    const used = await makeInvite();
    await prisma.surveyInvite.update({ where: { id: used.id }, data: { usedAt: new Date() } });
    const usedRes = await server.inject({ method: "GET", url: `/survey/${used.token}` });
    expect(usedRes.statusCode).toBe(410);

    const expired = await prisma.surveyInvite.create({
      data: {
        token: generateSurveyToken(),
        propertyId,
        phone: freshPhone(),
        channel: "sms",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expRes = await server.inject({ method: "GET", url: `/survey/${expired.token}` });
    expect(expRes.statusCode).toBe(410);
    await server.close();
  });

  it("POST creates a completed application with encrypted DOB and authoritative phone", async () => {
    const server = await makeServer();
    const invite = await makeInvite();
    const res = await server.inject({
      method: "POST",
      url: `/survey/${invite.token}`,
      payload: VALID_FORM,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Application received");

    const app = await prisma.application.findFirst({
      where: { propertyId, channel: "sms_link", fullName: "Jane Renter" },
    });
    expect(app).toBeTruthy();
    expect(app!.status).toBe("completed");
    expect(app!.completedAt).toBeTruthy();
    // callerPhone is the invite's phone, NOT the typed contact number
    expect(app!.callerPhone).toBe(invite.phone);
    const custom = app!.customResponses as Record<string, string>;
    expect(custom.contact_phone).toBe("+13125550000");
    expect(custom.bedrooms_needed).toBe("2");
    // DOB stored as ciphertext, decrypts to the entered value
    expect(app!.dateOfBirth).not.toBe("1994-05-12");
    expect(decrypt(app!.dateOfBirth!)).toBe("1994-05-12");

    const usedInvite = await prisma.surveyInvite.findUnique({ where: { id: invite.id } });
    expect(usedInvite?.usedAt).toBeTruthy();
    expect(usedInvite?.applicationId).toBe(app!.id);

    // second submit on the same token → 410
    const again = await server.inject({
      method: "POST",
      url: `/survey/${invite.token}`,
      payload: VALID_FORM,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(again.statusCode).toBe(410);
    await server.close();
  });

  it("POST re-renders with preserved values on validation failure", async () => {
    const server = await makeServer();
    const invite = await makeInvite();
    const partial = new URLSearchParams({
      email: "not-an-email",
      full_name: "Preserve Me",
    }).toString();
    const res = await server.inject({
      method: "POST",
      url: `/survey/${invite.token}`,
      payload: partial,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Preserve Me"); // entered value survives
    expect(res.body).toContain("is required"); // errors listed
    // token not burned
    const inv = await prisma.surveyInvite.findUnique({ where: { id: invite.id } });
    expect(inv?.usedAt).toBeNull();
    await server.close();
  });

  it("POST within 30 days of a completed application → friendly duplicate, token survives", async () => {
    const server = await makeServer();
    const dupPhone = freshPhone();
    await prisma.application.create({
      data: {
        propertyId,
        channel: "sms_link",
        status: "completed",
        completedAt: new Date(),
        callerPhone: dupPhone,
        fullName: "Earlier App",
      },
    });
    const invite = await makeInvite(dupPhone);
    const res = await server.inject({
      method: "POST",
      url: `/survey/${invite.token}`,
      payload: VALID_FORM,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Already on file");
    // transaction rolled back — the claim did not stick
    const inv = await prisma.surveyInvite.findUnique({ where: { id: invite.id } });
    expect(inv?.usedAt).toBeNull();
    await server.close();
  });
});

// ── owner view page ──

describe("owner view routes", () => {
  const OWNER_TOKEN = "test-owner-token-abc123";

  async function makeOwnerServer() {
    process.env.SMS_RELAY_OWNER_VIEW_TOKEN = OWNER_TOKEN;
    clearConfigCache();
    const { ownerRoutes } = await import("../routes/owner.js");
    const server = Fastify();
    await server.register(ownerRoutes);
    await server.ready();
    return server;
  }

  it("404s a wrong token", async () => {
    const server = await makeOwnerServer();
    const res = await server.inject({ method: "GET", url: "/owner/wrong-token" });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it("renders applications for the right token, never the DOB", async () => {
    const dobPlain = "1990-02-03";
    const { encrypt } = await import("@tenant-ai/shared");
    await prisma.application.create({
      data: {
        propertyId,
        channel: "sms_link",
        status: "completed",
        completedAt: new Date(),
        callerPhone: "+13125559876",
        fullName: "Owner Page Applicant",
        email: "owner-page@test.com",
        employer: "Page Corp",
        monthlyIncome: "5100",
        dateOfBirth: encrypt(dobPlain),
        customResponses: {
          bedrooms_needed: "3",
          household_size: "2",
          employed_one_year: "Yes",
          time_at_current_address: "4 years",
          contact_phone: "+13125559876",
        },
      },
    });

    const server = await makeOwnerServer();
    const res = await server.inject({ method: "GET", url: `/owner/${OWNER_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Owner Page Applicant");
    expect(res.body).toContain("$5100");
    expect(res.body).toContain("3");
    // DOB must never appear — plaintext or ciphertext
    expect(res.body).not.toContain(dobPlain);
    expect(res.body).not.toContain("v1:");
    await server.close();
  });
});
