import { selectRelayTransport, type RelayTransportSelection } from "@tenant-ai/shared";
import { sendViaMessagesRelay, notifyOnMac } from "./messages-relay.js";

/**
 * The relay's platform seam. relay-guards.ts talks to this, never to
 * messages-relay.ts directly, so the ledger/caps/sweep logic is identical on
 * every OS and only the last hop differs:
 *
 *   macos-messages → osascript → Messages.app (the Mac)
 *   none           → no send is attempted; rows defer with a clear reason and
 *                    the reply loop falls back to the Telnyx API
 */
export interface RelayTransport extends RelayTransportSelection {
  send(to: string, text: string): Promise<void>;
  /** Best-effort local notification (used for TCC revocation on the Mac). */
  notify(text: string): void;
}

export function getRelayTransport(): RelayTransport {
  const sel = selectRelayTransport();
  if (sel.name === "macos-messages") {
    return {
      ...sel,
      send: sendViaMessagesRelay,
      notify: notifyOnMac,
    };
  }
  return {
    ...sel,
    send: () => Promise.reject(new Error(sel.reason ?? "relay transport unavailable")),
    notify: () => {},
  };
}
