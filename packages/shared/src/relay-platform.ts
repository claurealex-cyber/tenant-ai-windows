/**
 * Platform availability of the Messages.app SMS relay.
 *
 * The relay drives macOS Messages via osascript, so it only exists on a Mac.
 * Both the API server (which does the sending) and the dashboard (which shows
 * relay status) need the same answer, so the selection lives here.
 *
 * Override with RELAY_TRANSPORT=macos-messages|none (tests, or forcing the
 * relay off on a Mac without touching settings).
 */

export type RelayTransportName = "macos-messages" | "none";

export interface RelayTransportSelection {
  name: RelayTransportName;
  available: boolean;
  /** Human-readable reason when unavailable (shown in the admin UI). */
  reason: string | null;
  platform: NodeJS.Platform;
}

export const RELAY_UNAVAILABLE_ERROR = "relay-unavailable-on-platform";

export function selectRelayTransport(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RelayTransportSelection {
  const override = (env.RELAY_TRANSPORT || "").trim().toLowerCase();

  if (override === "none") {
    return {
      name: "none",
      available: false,
      reason: "Relay disabled by RELAY_TRANSPORT=none",
      platform,
    };
  }
  if (override === "macos-messages" || platform === "darwin") {
    return { name: "macos-messages", available: true, reason: null, platform };
  }
  return {
    name: "none",
    available: false,
    reason: `The Messages.app relay only runs on macOS (this host is ${platform}). Outbound texts use the Telnyx API instead.`,
    platform,
  };
}
