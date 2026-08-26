import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.SERVER_PORT = "3001";

const PUBLIC_URL = "https://example.ngrok-free.dev";
const NGROK_API = "http://127.0.0.1:4040";

// ── Mocks ──

const mockGetServerSession = vi.fn();

vi.mock("next-auth", () => ({
  getServerSession: (...args: any[]) => mockGetServerSession(...args),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

const mockPropertyFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    property: {
      findMany: (...args: any[]) => mockPropertyFindMany(...args),
    },
  },
}));

const mockResolveConfig = vi.fn();

vi.mock("@tenant-ai/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tenant-ai/shared")>();
  return {
    ...actual,
    resolveConfig: (...args: any[]) => mockResolveConfig(...args),
  };
});

const mockNumberUpdate = vi.fn();
const mockNumberFetch = vi.fn();
const mockIncomingPhoneNumbers = vi.fn(() => ({
  update: mockNumberUpdate,
  fetch: mockNumberFetch,
}));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    incomingPhoneNumbers: mockIncomingPhoneNumbers,
  })),
}));

const mockSpawn = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ──

function mockAdminSession() {
  mockGetServerSession.mockResolvedValue({
    user: { id: "admin-1", role: "admin", email: "admin@test.com" },
  });
}

function mockConfig({
  sid = "ACtest",
  token = "tok",
  publicUrl = PUBLIC_URL,
}: { sid?: string | null; token?: string | null; publicUrl?: string | null } = {}) {
  mockResolveConfig.mockImplementation(async (_ns: string, key: string) => {
    if (key === "account_sid") return sid;
    if (key === "auth_token") return token;
    if (key === "public_url") return publicUrl;
    return null;
  });
}

const RUNNING_TUNNEL = {
  name: "tenant-ai",
  public_url: PUBLIC_URL,
  config: { addr: "http://localhost:3001" },
};

/** Route fetch calls by URL: ngrok agent API + public health check. */
function mockFetchRoutes({
  tunnels,
  healthOk = true,
}: {
  tunnels: unknown[] | null; // null = agent not running
  healthOk?: boolean;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith(`${NGROK_API}/api/tunnels`)) {
      if (tunnels === null) throw new Error("ECONNREFUSED");
      return {
        ok: true,
        json: async () => ({ tunnels }),
      };
    }
    if (url === `${PUBLIC_URL}/health`) {
      return { ok: healthOk, json: async () => ({ status: "ok" }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const REAL_SID = "PN340c9568d2381380dca04c7ea297aa6b";

const REAL_PROPERTY = {
  id: "prop-1",
  name: "Ghem Properties",
  twilioPhone: "+17088158559",
  twilioPhoneSid: REAL_SID,
};

function makeRequest(method: string) {
  return new NextRequest("http://localhost:3000/api/admin/phone-system", {
    method,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPropertyFindMany.mockResolvedValue([REAL_PROPERTY]);
});

// ── Tests ──

describe("GET /api/admin/phone-system", () => {
  it("returns 403 for non-admin users", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: "user-1", role: "manager" },
    });
    const { GET } = await import("../app/api/admin/phone-system/route");
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(403);
  });

  it("reports ready when tunnel, health, and webhooks are all correct", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });
    mockNumberFetch.mockResolvedValue({
      voiceUrl: `${PUBLIC_URL}/voice/incoming`,
      smsUrl: `${PUBLIC_URL}/sms/incoming`,
    });

    const { GET } = await import("../app/api/admin/phone-system/route");
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
    const { status } = await res.json();

    expect(status.ready).toBe(true);
    expect(status.tunnel).toEqual({
      running: true,
      forwardsTo: "http://localhost:3001",
      correct: true,
    });
    expect(status.publicHealthOk).toBe(true);
    expect(status.numbers).toHaveLength(1);
    expect(status.numbers[0]).toMatchObject({
      phone: "+17088158559",
      webhooksOk: true,
    });
  });

  it("reports not ready with stale webhooks", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });
    mockNumberFetch.mockResolvedValue({
      voiceUrl: `${PUBLIC_URL}/twilio/voice`,
      smsUrl: `${PUBLIC_URL}/twilio/sms`,
    });

    const { GET } = await import("../app/api/admin/phone-system/route");
    const res = await GET(makeRequest("GET"));
    const { status } = await res.json();

    expect(status.ready).toBe(false);
    expect(status.numbers[0].webhooksOk).toBe(false);
  });

  it("reports tunnel not running when the ngrok agent is down", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: null });

    const { GET } = await import("../app/api/admin/phone-system/route");
    const res = await GET(makeRequest("GET"));
    const { status } = await res.json();

    expect(status.ready).toBe(false);
    expect(status.tunnel.running).toBe(false);
    expect(status.publicHealthOk).toBe(false);
  });

  it("ignores mock- and demo-provisioned numbers", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });
    mockPropertyFindMany.mockResolvedValue([
      { ...REAL_PROPERTY, twilioPhoneSid: "PN_mock_123" },
      { ...REAL_PROPERTY, id: "prop-2", twilioPhoneSid: "PN_DEMO_001" },
      { ...REAL_PROPERTY, id: "prop-3", twilioPhoneSid: "PN_1770760838900" },
    ]);

    const { GET } = await import("../app/api/admin/phone-system/route");
    const res = await GET(makeRequest("GET"));
    const { status } = await res.json();

    expect(status.numbers).toHaveLength(0);
    expect(mockNumberFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/phone-system", () => {
  it("returns 403 for non-admin users", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: "user-1", role: "manager" },
    });
    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(403);
  });

  it("reuses a running tunnel and syncs webhooks to the server routes", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });
    mockNumberUpdate.mockResolvedValue({});

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(200);
    const result = await res.json();

    expect(result.ready).toBe(true);
    expect(result.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIncomingPhoneNumbers).toHaveBeenCalledWith(REAL_SID);
    expect(mockNumberUpdate).toHaveBeenCalledWith({
      voiceUrl: `${PUBLIC_URL}/voice/incoming`,
      voiceMethod: "POST",
      voiceFallbackUrl: `${PUBLIC_URL}/voice/fallback`,
      voiceFallbackMethod: "POST",
      smsUrl: `${PUBLIC_URL}/sms/incoming`,
      smsMethod: "POST",
    });
  });

  it("spawns ngrok when the agent is not running", async () => {
    mockAdminSession();
    mockConfig();
    // Agent down at first; running with the tunnel after spawn.
    let spawned = false;
    mockSpawn.mockImplementation(() => {
      spawned = true;
      return { unref: () => undefined };
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith(`${NGROK_API}/api/tunnels`)) {
        if (!spawned) throw new Error("ECONNREFUSED");
        return { ok: true, json: async () => ({ tunnels: [RUNNING_TUNNEL] }) };
      }
      if (url === `${PUBLIC_URL}/health`) {
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    mockNumberUpdate.mockResolvedValue({});

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    const result = await res.json();

    expect(mockSpawn).toHaveBeenCalledWith(
      "ngrok",
      expect.arrayContaining(["http", "--domain=example.ngrok-free.dev", "3001"]),
      expect.objectContaining({ detached: true })
    );
    expect(result.ready).toBe(true);
  }, 20000);

  it("fails early when no public URL is configured", async () => {
    mockAdminSession();
    mockConfig({ publicUrl: null });
    delete process.env.PUBLIC_URL;

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    const result = await res.json();

    expect(result.ready).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].ok).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockNumberUpdate).not.toHaveBeenCalled();
  });

  it("skips webhook sync when Twilio credentials are missing", async () => {
    mockAdminSession();
    mockConfig({ sid: null, token: null });
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    const result = await res.json();

    expect(result.ready).toBe(false);
    const webhookStep = result.steps.find(
      (s: { name: string }) => s.name === "Twilio webhooks"
    );
    expect(webhookStep.skipped).toBe(true);
    expect(mockNumberUpdate).not.toHaveBeenCalled();
  });

  it("only syncs webhooks for numbers with real Twilio SIDs", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL] });
    mockPropertyFindMany.mockResolvedValue([
      REAL_PROPERTY,
      { ...REAL_PROPERTY, id: "prop-2", twilioPhoneSid: "PN_DEMO_001" },
    ]);
    mockNumberUpdate.mockResolvedValue({});

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    const result = await res.json();

    expect(result.ready).toBe(true);
    expect(mockIncomingPhoneNumbers).toHaveBeenCalledTimes(1);
    expect(mockIncomingPhoneNumbers).toHaveBeenCalledWith(REAL_SID);
  });

  it("reports failure when the public health check never passes", async () => {
    mockAdminSession();
    mockConfig();
    mockFetchRoutes({ tunnels: [RUNNING_TUNNEL], healthOk: false });

    const { POST } = await import("../app/api/admin/phone-system/route");
    const res = await POST(makeRequest("POST"));
    const result = await res.json();

    expect(result.ready).toBe(false);
    const healthStep = result.steps.find(
      (s: { name: string }) => s.name === "Public health check"
    );
    expect(healthStep.ok).toBe(false);
    expect(mockNumberUpdate).not.toHaveBeenCalled();
  }, 20000);
});
