import { describe, it, expect } from "vitest";
import { selectRelayTransport, RELAY_UNAVAILABLE_ERROR } from "../relay-platform.js";

describe("selectRelayTransport", () => {
  it("picks Messages.app on macOS with no override", () => {
    const sel = selectRelayTransport({}, "darwin");
    expect(sel.name).toBe("macos-messages");
    expect(sel.available).toBe(true);
    expect(sel.reason).toBeNull();
  });

  it("is unavailable on Windows and Linux with a reason naming the platform", () => {
    for (const platform of ["win32", "linux"] as const) {
      const sel = selectRelayTransport({}, platform);
      expect(sel.name).toBe("none");
      expect(sel.available).toBe(false);
      expect(sel.reason).toContain(platform);
      expect(sel.platform).toBe(platform);
    }
  });

  it("RELAY_TRANSPORT=none forces the relay off even on macOS", () => {
    const sel = selectRelayTransport({ RELAY_TRANSPORT: "none" }, "darwin");
    expect(sel.available).toBe(false);
    expect(sel.reason).toMatch(/RELAY_TRANSPORT=none/);
  });

  it("RELAY_TRANSPORT=macos-messages forces it on (tests on Windows CI)", () => {
    const sel = selectRelayTransport({ RELAY_TRANSPORT: "macos-messages" }, "win32");
    expect(sel.available).toBe(true);
    expect(sel.name).toBe("macos-messages");
  });

  it("ignores unknown overrides and falls back to the platform rule", () => {
    expect(selectRelayTransport({ RELAY_TRANSPORT: "carrier-pigeon" }, "darwin").available).toBe(true);
    expect(selectRelayTransport({ RELAY_TRANSPORT: "carrier-pigeon" }, "win32").available).toBe(false);
  });

  it("exports a stable ledger error code", () => {
    expect(RELAY_UNAVAILABLE_ERROR).toBe("relay-unavailable-on-platform");
  });
});
