import { spawn } from "child_process";
import { prisma } from "@/lib/prisma";

/**
 * Phone system orchestration: brings up the ngrok tunnel that exposes the
 * voice/SMS server to Twilio and keeps the Twilio number webhooks pointed
 * at the routes the server actually serves.
 */

const NGROK_API = process.env.NGROK_API_URL || "http://127.0.0.1:4040";
const TUNNEL_NAME = "tenant-ai";

// Paths registered by apps/server (routes/twilio-voice.ts, routes/twilio-sms.ts)
export const WEBHOOK_PATHS = {
  voice: "/voice/incoming",
  voiceFallback: "/voice/fallback",
  sms: "/sms/incoming",
} as const;

export interface PhoneSystemStep {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface PhoneNumberStatus {
  propertyId: string;
  propertyName: string;
  phone: string;
  webhooksOk: boolean | null; // null = could not check
}

export interface PhoneSystemStatus {
  configured: boolean;
  publicUrl: string | null;
  serverPort: number;
  tunnel: { running: boolean; forwardsTo: string | null; correct: boolean };
  publicHealthOk: boolean;
  numbers: PhoneNumberStatus[];
  ready: boolean;
}

function serverPort(): number {
  return parseInt(process.env.SERVER_PORT || "3001", 10);
}

async function getTwilioConfig() {
  const { resolveConfig } = await import("@tenant-ai/shared");
  const accountSid =
    (await resolveConfig("twilio", "account_sid")) ||
    process.env.TWILIO_ACCOUNT_SID ||
    null;
  const authToken =
    (await resolveConfig("twilio", "auth_token")) ||
    process.env.TWILIO_AUTH_TOKEN ||
    null;
  const rawUrl =
    (await resolveConfig("twilio", "public_url")) ||
    process.env.PUBLIC_URL ||
    null;
  const publicUrl = rawUrl ? rawUrl.replace(/\/+$/, "") : null;
  return { accountSid, authToken, publicUrl };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 3000
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

interface NgrokTunnel {
  name: string;
  public_url: string;
  config: { addr: string };
}

/** Returns the agent's tunnels, or null when the ngrok agent isn't running. */
async function listNgrokTunnels(): Promise<NgrokTunnel[] | null> {
  try {
    const res = await fetchWithTimeout(`${NGROK_API}/api/tunnels`, {}, 2000);
    if (!res.ok) return null;
    const data = await res.json();
    return data.tunnels || [];
  } catch {
    return null;
  }
}

function tunnelForDomain(
  tunnels: NgrokTunnel[],
  publicUrl: string
): NgrokTunnel | null {
  const host = new URL(publicUrl).host;
  return tunnels.find((t) => new URL(t.public_url).host === host) || null;
}

function tunnelPortMatches(tunnel: NgrokTunnel, port: number): boolean {
  // addr looks like "http://localhost:3001"
  return tunnel.config.addr.endsWith(`:${port}`);
}

/**
 * Ensure an ngrok tunnel exists for publicUrl → localhost:port.
 * Reuses a matching tunnel, retargets a mismatched one via the agent API,
 * or spawns a new agent when none is running.
 */
async function ensureTunnel(
  publicUrl: string,
  port: number
): Promise<PhoneSystemStep> {
  const name = "ngrok tunnel";
  const domain = new URL(publicUrl).host;

  let tunnels = await listNgrokTunnels();

  if (tunnels) {
    const existing = tunnelForDomain(tunnels, publicUrl);
    if (existing && tunnelPortMatches(existing, port)) {
      return { name, ok: true, detail: `Already running → localhost:${port}` };
    }
    if (existing) {
      // Wrong target port — drop it so we can recreate it correctly.
      await fetchWithTimeout(
        `${NGROK_API}/api/tunnels/${encodeURIComponent(existing.name)}`,
        { method: "DELETE" },
        3000
      ).catch(() => undefined);
    }
    const created = await fetchWithTimeout(
      `${NGROK_API}/api/tunnels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: TUNNEL_NAME,
          proto: "http",
          addr: String(port),
          domain,
        }),
      },
      5000
    ).catch(() => null);
    if (created?.ok) {
      return { name, ok: true, detail: `Started → localhost:${port}` };
    }
    return {
      name,
      ok: false,
      detail:
        "ngrok agent is running but the tunnel could not be created. Restart ngrok manually.",
    };
  }

  // Agent not running — spawn it detached so it outlives this request.
  const ngrokBin = process.env.NGROK_PATH || "ngrok";
  try {
    const child = spawn(
      ngrokBin,
      ["http", `--url=${domain}`, String(port), "--log=stdout"],
      // windowsHide: on Windows a detached console app would otherwise pop
      // its own terminal window on the desktop every time this runs.
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  } catch (err) {
    return {
      name,
      ok: false,
      detail: `Failed to launch ngrok: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Wait for the agent to come up and establish the tunnel.
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    tunnels = await listNgrokTunnels();
    if (tunnels && tunnelForDomain(tunnels, publicUrl)) {
      return { name, ok: true, detail: `Started → localhost:${port}` };
    }
  }
  return {
    name,
    ok: false,
    detail:
      "ngrok did not come up within 15s. Check that ngrok is installed and authenticated (ngrok config check).",
  };
}

/** Verify the server is reachable from the internet through the tunnel. */
async function checkPublicHealth(publicUrl: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetchWithTimeout(`${publicUrl}/health`, {}, 3000);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Real Twilio SIDs are "PN" + 32 hex chars; seed/mock data uses
// placeholders like PN_DEMO_001 or PN_mock_<timestamp>.
const TWILIO_SID_PATTERN = /^PN[0-9a-f]{32}$/;

/** Properties with a real (non-mock, non-demo) provisioned Twilio number. */
async function realNumbers() {
  const properties = await prisma.property.findMany({
    where: { twilioPhoneSid: { not: null } },
    select: { id: true, name: true, twilioPhone: true, twilioPhoneSid: true },
  });
  return properties.filter(
    (p) => p.twilioPhoneSid && TWILIO_SID_PATTERN.test(p.twilioPhoneSid)
  );
}

/** Point every provisioned number's webhooks at the server's real routes. */
async function syncWebhooks(
  accountSid: string,
  authToken: string,
  publicUrl: string
): Promise<PhoneSystemStep> {
  const name = "Twilio webhooks";
  const numbers = await realNumbers();
  if (numbers.length === 0) {
    return { name, ok: true, detail: "No provisioned numbers to update" };
  }

  const twilio = (await import("twilio")).default;
  const client = twilio(accountSid, authToken);

  const updated: string[] = [];
  const failed: string[] = [];
  for (const property of numbers) {
    try {
      await client.incomingPhoneNumbers(property.twilioPhoneSid!).update({
        voiceUrl: `${publicUrl}${WEBHOOK_PATHS.voice}`,
        voiceMethod: "POST",
        voiceFallbackUrl: `${publicUrl}${WEBHOOK_PATHS.voiceFallback}`,
        voiceFallbackMethod: "POST",
        smsUrl: `${publicUrl}${WEBHOOK_PATHS.sms}`,
        smsMethod: "POST",
      });
      updated.push(property.twilioPhone!);
    } catch (err) {
      console.error(`Webhook update failed for ${property.twilioPhone}:`, err);
      failed.push(property.twilioPhone!);
    }
  }

  if (failed.length > 0) {
    return {
      name,
      ok: false,
      detail: `Updated ${updated.length}, failed for ${failed.join(", ")}`,
    };
  }
  return { name, ok: true, detail: `Webhooks set for ${updated.join(", ")}` };
}

/**
 * Start everything the Twilio number needs: tunnel up, server publicly
 * reachable, webhooks pointed at the right routes.
 */
export async function startPhoneSystem(): Promise<{
  ready: boolean;
  steps: PhoneSystemStep[];
}> {
  const steps: PhoneSystemStep[] = [];
  const { accountSid, authToken, publicUrl } = await getTwilioConfig();

  if (!publicUrl) {
    steps.push({
      name: "Twilio configuration",
      ok: false,
      detail:
        "No public URL configured. Set it in Admin → Integrations → Twilio.",
    });
    return { ready: false, steps };
  }
  steps.push({
    name: "Twilio configuration",
    ok: true,
    detail: `Public URL: ${publicUrl}`,
  });

  const port = serverPort();
  const tunnelStep = await ensureTunnel(publicUrl, port);
  steps.push(tunnelStep);
  if (!tunnelStep.ok) return { ready: false, steps };

  const healthy = await checkPublicHealth(publicUrl);
  steps.push({
    name: "Public health check",
    ok: healthy,
    detail: healthy
      ? `${publicUrl}/health responds`
      : `Server not reachable at ${publicUrl}/health — is the API server running on port ${port}?`,
  });
  if (!healthy) return { ready: false, steps };

  if (!accountSid || !authToken) {
    steps.push({
      name: "Twilio webhooks",
      ok: false,
      skipped: true,
      detail:
        "Twilio credentials not configured — set them in Admin → Integrations → Twilio.",
    });
    return { ready: false, steps };
  }
  const webhookStep = await syncWebhooks(accountSid, authToken, publicUrl);
  steps.push(webhookStep);

  return { ready: steps.every((s) => s.ok), steps };
}

/** Current state of the phone system, without changing anything. */
export async function getPhoneSystemStatus(): Promise<PhoneSystemStatus> {
  const { accountSid, authToken, publicUrl } = await getTwilioConfig();
  const port = serverPort();
  const configured = Boolean(accountSid && authToken && publicUrl);

  let tunnelRunning = false;
  let forwardsTo: string | null = null;
  let tunnelCorrect = false;
  if (publicUrl) {
    const tunnels = await listNgrokTunnels();
    const tunnel = tunnels ? tunnelForDomain(tunnels, publicUrl) : null;
    if (tunnel) {
      tunnelRunning = true;
      forwardsTo = tunnel.config.addr;
      tunnelCorrect = tunnelPortMatches(tunnel, port);
    }
  }

  const publicHealthOk =
    publicUrl && tunnelRunning
      ? await fetchWithTimeout(`${publicUrl}/health`, {}, 3000)
          .then((r) => r.ok)
          .catch(() => false)
      : false;

  const numbers: PhoneNumberStatus[] = [];
  const properties = await realNumbers();
  if (properties.length > 0 && accountSid && authToken && publicUrl) {
    const twilio = (await import("twilio")).default;
    const client = twilio(accountSid, authToken);
    for (const property of properties) {
      let webhooksOk: boolean | null = null;
      try {
        const num = await client
          .incomingPhoneNumbers(property.twilioPhoneSid!)
          .fetch();
        webhooksOk =
          num.voiceUrl === `${publicUrl}${WEBHOOK_PATHS.voice}` &&
          num.smsUrl === `${publicUrl}${WEBHOOK_PATHS.sms}`;
      } catch {
        webhooksOk = null;
      }
      numbers.push({
        propertyId: property.id,
        propertyName: property.name,
        phone: property.twilioPhone!,
        webhooksOk,
      });
    }
  } else {
    for (const property of properties) {
      numbers.push({
        propertyId: property.id,
        propertyName: property.name,
        phone: property.twilioPhone!,
        webhooksOk: null,
      });
    }
  }

  return {
    configured,
    publicUrl,
    serverPort: port,
    tunnel: { running: tunnelRunning, forwardsTo, correct: tunnelCorrect },
    publicHealthOk,
    numbers,
    ready:
      configured &&
      tunnelRunning &&
      tunnelCorrect &&
      publicHealthOk &&
      numbers.length > 0 &&
      numbers.every((n) => n.webhooksOk === true),
  };
}
