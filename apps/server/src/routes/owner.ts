import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { resolveConfig } from "@tenant-ai/shared";

/**
 * Read-only applications page for the property owner, served on the public
 * tunnel URL behind a secret token — a share-a-link view for someone (Mr. Joe)
 * who has no dashboard login. Shows every survey answer EXCEPT date of birth.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const OWNER_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f3f4f6; color: #111827; padding: 16px; }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  p.sub { color: #6b7280; font-size: 13px; margin-bottom: 16px; }
  .card { background: #fff; border-radius: 12px; padding: 18px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 16px; margin-bottom: 2px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
  dl { display: grid; grid-template-columns: 46% 54%; row-gap: 6px; font-size: 14px; }
  dt { color: #6b7280; }
  dd { font-weight: 500; word-break: break-word; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #166534; margin-left: 6px; vertical-align: 2px; }
  .empty { text-align: center; color: #6b7280; padding: 40px 0; }
  footer { text-align: center; color: #9ca3af; font-size: 11px; margin: 18px 0; }
`;

interface OwnerAppRow {
  fullName: string | null;
  callerPhone: string | null;
  email: string | null;
  employer: string | null;
  monthlyIncome: string | null;
  status: string;
  completedAt: Date | null;
  customResponses: unknown;
  property: { name: string };
}

function renderOwnerPage(apps: OwnerAppRow[]): string {
  const cards = apps
    .map((a) => {
      const c = (a.customResponses as Record<string, string> | null) ?? {};
      const rows: Array<[string, string | null | undefined]> = [
        ["Verified phone", a.callerPhone],
        ["Contact phone", c.contact_phone !== a.callerPhone ? c.contact_phone : null],
        ["Email", a.email],
        ["Bedrooms needed", c.bedrooms_needed],
        ["People in apartment", c.household_size],
        ["Employer", a.employer],
        ["Employment start", c.employment_start_date],
        ["Employed 1+ year", c.employed_one_year],
        ["Gross monthly income", a.monthlyIncome ? `$${a.monthlyIncome}` : null],
        ["Time at current address", c.time_at_current_address],
      ];
      const dl = rows
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
        .join("");
      const when = a.completedAt
        ? a.completedAt.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "";
      return `<div class="card">
        <h2>${escapeHtml(a.fullName ?? "Unknown")}<span class="badge">${escapeHtml(a.status)}</span></h2>
        <div class="meta">${escapeHtml(a.property.name)} — submitted ${escapeHtml(when)}</div>
        <dl>${dl}</dl>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Rental Applications</title><style>${OWNER_CSS}</style></head>
<body><div class="wrap">
  <h1>Rental Applications</h1>
  <p class="sub">Newest first. This page is private — don't share the link.</p>
  ${cards || '<div class="empty">No applications yet.</div>'}
  <footer>Ghem LLC — updated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}</footer>
</div></body></html>`;
}

const ownerRateLimit = {
  config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
};

export async function ownerRoutes(server: FastifyInstance): Promise<void> {
  server.get<{ Params: { token: string } }>(
    "/owner/:token",
    ownerRateLimit,
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const expected = await resolveConfig("sms_relay", "owner_view_token");
      const provided = request.params.token;
      if (!expected || !provided || !tokensMatch(provided, expected)) {
        return reply
          .code(404)
          .type("text/html")
          .send("<!doctype html><html><body style=\"font-family:system-ui;text-align:center;padding:60px\"><h1>Not found</h1></body></html>");
      }

      const apps = await prisma.application.findMany({
        where: {
          channel: { in: ["sms_link", "web_link", "voice"] },
          status: { in: ["completed", "reviewed"] },
        },
        orderBy: { completedAt: "desc" },
        take: 100,
        select: {
          fullName: true,
          callerPhone: true,
          email: true,
          employer: true,
          monthlyIncome: true,
          status: true,
          completedAt: true,
          customResponses: true,
          property: { select: { name: true } },
          // deliberately no dateOfBirth / ssn
        },
      });

      return reply.type("text/html").send(renderOwnerPage(apps));
    },
  );
}
