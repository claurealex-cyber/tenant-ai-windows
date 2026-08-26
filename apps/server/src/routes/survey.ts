import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { encrypt } from "@tenant-ai/shared";
import { forwardSurveySummary } from "../services/survey-forward.js";

/**
 * Public survey pages for SMS-link intake: GET renders the 11-question form,
 * POST validates and writes the Application in one transaction. Served by
 * Fastify because the server already has the public tunnel URL — no separate
 * website needed.
 */

// ── helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

/** Take the LAST X-Forwarded-For entry — appended by the tunnel, not client-forgeable. */
function lastForwardedFor(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return request.ip;
}

// Absolute global budget on survey traffic, independent of key — header games
// can't exceed this and a keyless scanner can't 429 real tenants forever.
let windowStart = Date.now();
let windowCount = 0;
const GLOBAL_BUDGET_PER_MIN = 120;

function globalBudgetExceeded(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount > GLOBAL_BUDGET_PER_MIN;
}

// ── form definition ────────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "email" | "text" | "tel" | "date" | "number" | "select" | "radio";
  options?: string[];
  maxLen: number;
}

const FIELDS: FieldDef[] = [
  { key: "email", label: "Email", type: "email", maxLen: 100 },
  { key: "full_name", label: "Full name", type: "text", maxLen: 100 },
  { key: "contact_phone", label: "Phone number", type: "tel", maxLen: 20 },
  { key: "dob", label: "Date of birth", type: "date", maxLen: 10 },
  { key: "bedrooms_needed", label: "How many bedrooms do you need?", type: "select", options: ["1", "2", "3", "4+"], maxLen: 2 },
  { key: "household_size", label: "How many people will be living in the apartment?", type: "number", maxLen: 3 },
  { key: "employer", label: "Where do you work?", type: "text", maxLen: 100 },
  { key: "employment_start_date", label: "Date of employment", type: "date", maxLen: 10 },
  { key: "employed_one_year", label: "Have you been employed at your current job for at least one year?", type: "radio", options: ["Yes", "No"], maxLen: 3 },
  { key: "gross_monthly_income", label: "Gross monthly income ($)", type: "number", maxLen: 10 },
  { key: "time_at_current_address", label: "How long have you been living at your current address?", type: "text", maxLen: 60 },
];

// ── page templates ─────────────────────────────────────────────────────────

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f3f4f6; color: #111827; padding: 16px; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: #6b7280; font-size: 14px; margin-bottom: 20px; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 4px; }
  input, select { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #d1d5db; border-radius: 8px; }
  .radio-row { display: flex; gap: 16px; padding: 6px 0; }
  .radio-row label { display: flex; align-items: center; gap: 6px; font-weight: 400; margin: 0; }
  .radio-row input { width: auto; }
  button { width: 100%; margin-top: 22px; padding: 14px; font-size: 16px; font-weight: 600; color: #fff; background: #2563eb; border: 0; border-radius: 8px; }
  .err { background: #fef2f2; color: #991b1b; padding: 10px 12px; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
  .center { text-align: center; padding: 40px 16px; }
`;

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>
<body>${body}</body></html>`;
}

function messagePage(title: string, message: string): string {
  return pageShell(title, `<div class="card center"><h1>${escapeHtml(title)}</h1><p class="sub" style="margin-top:8px">${escapeHtml(message)}</p></div>`);
}

function renderForm(
  token: string,
  propertyName: string,
  values: Record<string, string>,
  errors: string[],
): string {
  const rows = FIELDS.map((f) => {
    const val = values[f.key] ?? "";
    if (f.type === "select") {
      const opts = f.options!
        .map((o) => `<option value="${escapeHtml(o)}"${o === val ? " selected" : ""}>${escapeHtml(o)}</option>`)
        .join("");
      return `<label for="${f.key}">${escapeHtml(f.label)}</label><select id="${f.key}" name="${f.key}" required><option value="">Select…</option>${opts}</select>`;
    }
    if (f.type === "radio") {
      const opts = f.options!
        .map((o) => `<label><input type="radio" name="${f.key}" value="${escapeHtml(o)}"${o === val ? " checked" : ""} required> ${escapeHtml(o)}</label>`)
        .join("");
      return `<label>${escapeHtml(f.label)}</label><div class="radio-row">${opts}</div>`;
    }
    const extra = f.type === "number" ? ' min="0" inputmode="numeric"' : "";
    return `<label for="${f.key}">${escapeHtml(f.label)}</label><input id="${f.key}" name="${f.key}" type="${f.type}" value="${escapeHtml(val)}" maxlength="${f.maxLen}"${extra} required>`;
  }).join("\n");

  const errBlock = errors.length
    ? `<div class="err">${errors.map(escapeHtml).join("<br>")}</div>`
    : "";

  return pageShell(
    "Rental Application",
    `<div class="card">
      <h1>Rental Application</h1>
      <p class="sub">${escapeHtml(propertyName)} — takes about 2 minutes.</p>
      ${errBlock}
      <form method="POST" action="/survey/${escapeHtml(token)}">
        ${rows}
        <button type="submit">Submit application</button>
      </form>
    </div>`,
  );
}

// ── validation ─────────────────────────────────────────────────────────────

function validate(body: Record<string, unknown>): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const f of FIELDS) {
    const raw = typeof body[f.key] === "string" ? (body[f.key] as string) : "";
    const clean = stripHtml(raw).slice(0, f.maxLen);
    values[f.key] = clean;
    if (!clean) {
      errors.push(`${f.label} is required.`);
      continue;
    }
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) errors.push("Email looks invalid.");
    if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) errors.push(`${f.label} must be a date.`);
    if (f.type === "number" && !/^\d+(\.\d+)?$/.test(clean)) errors.push(`${f.label} must be a number.`);
    if (f.type === "select" && !f.options!.includes(clean)) errors.push(`${f.label}: pick an option.`);
    if (f.type === "radio" && !f.options!.includes(clean)) errors.push(`${f.label}: pick an option.`);
  }
  return { values, errors };
}

class DuplicateApplicationError extends Error {}

// ── routes ─────────────────────────────────────────────────────────────────

const surveyRateLimit = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => lastForwardedFor(request),
    },
  },
};

export async function surveyRoutes(server: FastifyInstance): Promise<void> {
  // The public root: webhooks and tokened links live on this host, so a bare
  // visit (e.g. someone trimming an SMS link, or ngrok's "Visit Site" button)
  // should get a human page, not a JSON 404.
  server.get("/", async (_request, reply: FastifyReply) => {
    return reply
      .type("text/html")
      .send(messagePage("Tenant AI", "There's nothing at this address itself. If you received a link by text message, open the complete link from that message."));
  });

  server.get<{ Params: { token: string } }>(
    "/survey/:token",
    surveyRateLimit,
    async (request, reply: FastifyReply) => {
      if (globalBudgetExceeded()) return reply.code(429).send("Too many requests");
      const { token } = request.params;
      if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) {
        return reply.code(404).type("text/html").send(messagePage("Link not found", "This application link is not valid. Please text us to get a fresh link."));
      }
      const invite = await prisma.surveyInvite.findUnique({
        where: { token },
        include: { property: { select: { name: true } } },
      });
      if (!invite) {
        return reply.code(404).type("text/html").send(messagePage("Link not found", "This application link is not valid. Please text us to get a fresh link."));
      }
      if (invite.usedAt) {
        return reply.code(410).type("text/html").send(messagePage("Already submitted", "This application was already submitted. We'll be in touch soon!"));
      }
      if (invite.expiresAt < new Date()) {
        return reply.code(410).type("text/html").send(messagePage("Link expired", "This application link has expired. Text us again and we'll send you a fresh one."));
      }
      return reply
        .type("text/html")
        .send(renderForm(token, invite.property.name, { contact_phone: invite.phone }, []));
    },
  );

  server.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    "/survey/:token",
    surveyRateLimit,
    async (request, reply: FastifyReply) => {
      if (globalBudgetExceeded()) return reply.code(429).send("Too many requests");
      const { token } = request.params;
      if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) {
        return reply.code(404).type("text/html").send(messagePage("Link not found", "This application link is not valid."));
      }

      const invite = await prisma.surveyInvite.findUnique({
        where: { token },
        include: { property: { select: { name: true } } },
      });
      if (!invite) {
        return reply.code(404).type("text/html").send(messagePage("Link not found", "This application link is not valid."));
      }
      if (invite.usedAt) {
        return reply.code(410).type("text/html").send(messagePage("Already submitted", "This application was already submitted. We'll be in touch soon!"));
      }
      if (invite.expiresAt < new Date()) {
        return reply.code(410).type("text/html").send(messagePage("Link expired", "This application link has expired. Text us again for a fresh one."));
      }

      const { values, errors } = validate(request.body ?? {});
      if (errors.length > 0) {
        // Re-render with entered values preserved — a tenant who typed 11
        // fields on a phone will not do it twice.
        return reply.code(400).type("text/html").send(renderForm(token, invite.property.name, values, errors));
      }

      try {
        const applicationId = await prisma.$transaction(async (tx) => {
          // Atomic claim — a racing double-submit loses here.
          const claim = await tx.surveyInvite.updateMany({
            where: { token, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (claim.count === 0) throw new DuplicateApplicationError("claimed");

          // 30-day duplicate check (same phone + property). Throwing rolls the
          // claim back so the token survives for the friendly-duplicate case.
          const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
          const dup = await tx.application.findFirst({
            where: {
              propertyId: invite.propertyId,
              callerPhone: invite.phone,
              channel: "sms_link",
              status: { in: ["completed", "reviewed"] },
              completedAt: { gt: thirtyDaysAgo },
            },
          });
          if (dup) throw new DuplicateApplicationError("duplicate");

          const app = await tx.application.create({
            data: {
              propertyId: invite.propertyId,
              channel: "sms_link",
              status: "completed",
              completedAt: new Date(),
              callerPhone: invite.phone, // authoritative — never the typed value
              fullName: values.full_name,
              email: values.email,
              dateOfBirth: encrypt(values.dob),
              employer: values.employer,
              monthlyIncome: values.gross_monthly_income,
              customResponses: {
                contact_phone: values.contact_phone,
                bedrooms_needed: values.bedrooms_needed,
                household_size: values.household_size,
                employment_start_date: values.employment_start_date,
                employed_one_year: values.employed_one_year,
                time_at_current_address: values.time_at_current_address,
              } as Prisma.InputJsonValue,
            },
          });
          await tx.surveyInvite.update({
            where: { id: invite.id },
            data: { applicationId: app.id },
          });
          return app.id;
        });

        // Thank-you first, then fire-and-forget the (ledger-backed) forward.
        reply.type("text/html").send(messagePage("Application received!", "Thanks — we have your application and will be in touch soon."));
        forwardSurveySummary(applicationId).catch((err) =>
          request.log.error(`survey forward failed: ${err}`),
        );
        return reply;
      } catch (err) {
        if (err instanceof DuplicateApplicationError) {
          if (err.message === "duplicate") {
            return reply.code(200).type("text/html").send(messagePage("Already on file", "We already have a recent application from you — no need to submit again. We'll be in touch!"));
          }
          return reply.code(410).type("text/html").send(messagePage("Already submitted", "This application was already submitted."));
        }
        request.log.error(`survey submit failed: ${err}`);
        return reply.code(500).type("text/html").send(messagePage("Something went wrong", "We couldn't save your application just now. Please go back and resubmit — your link is still valid."));
      }
    },
  );
}
