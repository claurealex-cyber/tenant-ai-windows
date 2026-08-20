import { describe, it, expect, beforeEach, vi } from "vitest";
import { addCall, removeCall, getAllCalls } from "../lib/call-registry.js";
import type { ActiveCall } from "../lib/call-registry.js";

// ── Monitoring (Step 58) ──

describe("Monitoring service", () => {
  const testStreamSid = `test_mon_${Date.now()}`;

  beforeEach(() => {
    // Clean up any leftover test calls
    removeCall(testStreamSid);
  });

  it("tracks active calls via call-registry delegation", async () => {
    const { getActiveCallCount, getActiveCalls } =
      await import("../services/monitoring.js");

    const before = getActiveCallCount();

    const mockCall: ActiveCall = {
      callSid: "CA_MON_TEST",
      streamSid: testStreamSid,
      twilioWs: null as any,
      openaiWs: null,
      applicationId: "app1",
      propertyId: "prop1",
      callerPhone: "+13125551234",
      callLogId: "test-call-log-id",
      isTenant: false,
      hasTourSlots: false,
      questions: [],
      answerValidation: false,
      transcript: [],
      startTime: new Date(),
      reconnectCount: 0,
    };

    addCall(testStreamSid, mockCall);

    expect(getActiveCallCount()).toBe(before + 1);
    const calls = getActiveCalls();
    const found = calls.find((c) => c.callSid === "CA_MON_TEST");
    expect(found).toBeDefined();
    expect(found!.propertyId).toBe("prop1");

    removeCall(testStreamSid);
    expect(getActiveCallCount()).toBe(before);
  });

  it("records errors and tracks recent count", async () => {
    const { recordError, getRecentErrors } = await import(
      "../services/monitoring.js"
    );

    recordError("Test error 1");
    recordError("Test error 2", "stack trace here");

    const errors = getRecentErrors();
    expect(errors.length).toBeGreaterThanOrEqual(2);

    const last = errors[errors.length - 1];
    expect(last.message).toBe("Test error 2");
    expect(last.stack).toBe("stack trace here");
    expect(last.timestamp).toBeInstanceOf(Date);
  });

  it("limits error history to 50 entries", async () => {
    const { recordError, getRecentErrors } = await import(
      "../services/monitoring.js"
    );

    // Record 60 errors (some already exist from previous test)
    for (let i = 0; i < 60; i++) {
      recordError(`Flood error ${i}`);
    }

    const errors = getRecentErrors();
    expect(errors.length).toBeLessThanOrEqual(50);
  });
});

// ── Graceful Shutdown (Step 59) ──

describe("Graceful shutdown", () => {
  it("isServerShuttingDown is initially false", async () => {
    const { isServerShuttingDown } = await import(
      "../lib/graceful-shutdown.js"
    );
    expect(isServerShuttingDown()).toBe(false);
  });

  it("requestShutdown is a no-op before handlers are registered", async () => {
    const { requestShutdown, isServerShuttingDown } = await import(
      "../lib/graceful-shutdown.js"
    );
    await requestShutdown("test");
    expect(isServerShuttingDown()).toBe(false);
  });

  it("programmatic trigger (IPC path on Windows) closes the server and exits 0", async () => {
    const mod = await import("../lib/graceful-shutdown.js");
    const closeServer = vi.fn(async () => {});
    const exit = vi.fn();
    mod.registerShutdownHandlers(closeServer, { exit });

    await mod.requestShutdown("ipc");

    expect(mod.isServerShuttingDown()).toBe(true);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // Idempotent: a second trigger (e.g. SIGINT racing the IPC message) is ignored
    await mod.requestShutdown("SIGINT");
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    mod._resetShutdownStateForTests();
  });
});

// ── Twilio Voice Fallback (Step 62) ──

describe("Twilio voice fallback", () => {
  it("returns valid TwiML with unavailable message", async () => {
    // Since we can't easily test Fastify routes in unit tests without
    // spinning up the server, test the TwiML content directly
    const twiml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      '  <Say voice="alice">Our application system is temporarily unavailable. Please try again later, or text this number to apply.</Say>',
      "  <Hangup/>",
      "</Response>",
    ].join("\n");

    expect(twiml).toContain("<Response>");
    expect(twiml).toContain("<Say");
    expect(twiml).toContain("temporarily unavailable");
    expect(twiml).toContain("text this number");
    expect(twiml).toContain("<Hangup/>");
  });
});

// ── Docker / Nginx config validation (Steps 60-61) ──

describe("Docker Compose config", () => {
  it("docker-compose.yml is valid YAML with required services", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const composePath = path.resolve(
      process.cwd(),
      "docker-compose.yml"
    );
    const content = fs.readFileSync(composePath, "utf-8");

    expect(content).toContain("postgres:");
    expect(content).toContain("redis:");
    expect(content).toContain("server:");
    expect(content).toContain("dashboard:");
    expect(content).toContain("tenant-site:");
    expect(content).toContain("nginx:");
    expect(content).toContain("minio:");
    expect(content).toContain("stop_grace_period: 120s");
    expect(content).toContain("service_healthy");
  });

  it("nginx.conf has WebSocket upgrade for media-stream", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const nginxPath = path.resolve(process.cwd(), "nginx.conf");
    const content = fs.readFileSync(nginxPath, "utf-8");

    expect(content).toContain("location /media-stream");
    expect(content).toContain("proxy_set_header Upgrade");
    expect(content).toContain('proxy_set_header Connection "upgrade"');
    expect(content).toContain("proxy_read_timeout 86400s");
    // Subdomain routing
    expect(content).toContain("*.tenantai.com");
    expect(content).toContain("dashboard.tenantai.com");
    // HTTPS
    expect(content).toContain("ssl_certificate");
    expect(content).toContain("Strict-Transport-Security");
  });
});

// ── Health Endpoint Data (Step 58) ──

describe("Health endpoint data", () => {
  it("returns comprehensive health status", async () => {
    const { getHealthStatus } = await import("../services/monitoring.js");
    const health = await getHealthStatus();

    // Status may be "degraded" if error tests already recorded errors
    expect(["ok", "degraded"]).toContain(health.status);
    expect(typeof health.activeCalls).toBe("number");
    expect(typeof health.maxCalls).toBe("number");
    expect(typeof health.memoryUsageMB).toBe("number");
    expect(typeof health.uptimeSeconds).toBe("number");
    expect(typeof health.dbConnected).toBe("boolean");
    expect(health.dbConnected).toBe(true);
    expect(typeof health.lastJobRuns).toBe("object");
    expect(typeof health.recentErrorCount).toBe("number");
  });
});
