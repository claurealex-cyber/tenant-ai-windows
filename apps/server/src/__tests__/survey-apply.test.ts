/**
 * Walk-up applications on the public site: GET /apply (picker/redirect),
 * GET /apply/:propertyId (form), POST /apply/:propertyId (channel "web_link",
 * normalized typed phone, 30-day duplicate policy shared with the SMS path).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { PrismaClient } from "@prisma/client";
import { decrypt } from "@tenant-ai/shared";
import { surveyRoutes } from "../routes/survey.js";

process.env.PII_ENCRYPTION_KEY =
  process.env.PII_ENCRYPTION_KEY ||
  "b18f16b9017984f6a8fa9432ef01309a460666f71e81651f2f1a034e43b49521";

const prisma = new PrismaClient();
const TEST_PREFIX = "webapply_test";

let userId: string;
let propertyId: string;
let secondPropertyId: string | null = null;

async function makeServer() {
  const server = Fastify({ logger: { level: "error" } });
  await server.register(formbody);
  await server.register(surveyRoutes);
  await server.ready();
  return server;
}

const VALID_FORM = (phone: string) =>
  new URLSearchParams({
    email: "walkup@example.com",
    full_name: "Walk Up",
    contact_phone: phone,
    dob: "1991-02-03",
    bedrooms_needed: "1",
    household_size: "2",
    employer: "Acme Corp",
    employment_start_date: "2022-06-01",
    employed_one_year: "Yes",
    gross_monthly_income: "3900",
    time_at_current_address: "3 years",
  }).toString();

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}@test.com`,
      name: "Web Apply Tester",
      passwordHash: "x",
      role: "client",
      onboarded: true,
    },
  });
  userId = user.id;
  const property = await prisma.property.create({
    data: {
      name: `${TEST_PREFIX}_prop`,
      address: "1 Walkup Way",
      userId,
      isActive: true,
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.application.deleteMany({ where: { propertyId: { in: [propertyId, secondPropertyId].filter(Boolean) as string[] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, secondPropertyId].filter(Boolean) as string[] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("walk-up applications (/apply)", () => {
  it("root page links to /apply", async () => {
    const server = await makeServer();
    const res = await server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/apply"');
    await server.close();
  });

  it("GET /apply/:propertyId renders the 11-question form posting back to /apply", async () => {
    const server = await makeServer();
    const res = await server.inject({ method: "GET", url: `/apply/${propertyId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="/apply/${propertyId}"`);
    for (const key of ["email", "full_name", "contact_phone", "dob", "bedrooms_needed", "household_size", "employer", "employment_start_date", "employed_one_year", "gross_monthly_income", "time_at_current_address"]) {
      expect(res.body).toContain(`name="${key}"`);
    }
    await server.close();
  });

  it("GET /apply/:propertyId 404s inactive or unknown properties", async () => {
    const server = await makeServer();
    const inactive = await prisma.property.create({
      data: { name: `${TEST_PREFIX}_off`, address: "2 Walkup Way", userId, isActive: false },
    });
    secondPropertyId = inactive.id;
    const off = await server.inject({ method: "GET", url: `/apply/${inactive.id}` });
    expect(off.statusCode).toBe(404);
    const unknown = await server.inject({ method: "GET", url: "/apply/nope123nope123nope123nope" });
    expect(unknown.statusCode).toBe(404);
    await server.close();
  });

  it("POST creates a completed web_link application with normalized phone and encrypted DOB", async () => {
    const server = await makeServer();
    const res = await server.inject({
      method: "POST",
      url: `/apply/${propertyId}`,
      payload: VALID_FORM("(312) 555-0177"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Application received");

    const app = await prisma.application.findFirst({
      where: { propertyId, channel: "web_link", fullName: "Walk Up" },
    });
    expect(app).not.toBeNull();
    expect(app!.status).toBe("completed");
    expect(app!.callerPhone).toBe("+13125550177"); // 10 digits -> +1 E.164
    expect(app!.dateOfBirth).not.toBe("1991-02-03"); // stored encrypted
    expect(decrypt(app!.dateOfBirth!)).toBe("1991-02-03");
    await server.close();
  });

  it("a second application from the same phone within 30 days is refused politely", async () => {
    const server = await makeServer();
    const res = await server.inject({
      method: "POST",
      url: `/apply/${propertyId}`,
      payload: VALID_FORM("312-555-0177"), // same number, different formatting
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Already on file");
    const count = await prisma.application.count({ where: { propertyId, channel: "web_link" } });
    expect(count).toBe(1);
    await server.close();
  });

  it("invalid input re-renders the form with errors and preserved values", async () => {
    const server = await makeServer();
    const res = await server.inject({
      method: "POST",
      url: `/apply/${propertyId}`,
      payload: new URLSearchParams({ email: "not-an-email", full_name: "Partial Person" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Email looks invalid.");
    expect(res.body).toContain("Partial Person");
    expect(await prisma.application.count({ where: { propertyId, fullName: "Partial Person" } })).toBe(0);
    await server.close();
  });

  it("GET /apply redirects straight to the form when one property is active", async () => {
    const server = await makeServer();
    // make this test independent of the seeded demo data: count active properties
    const active = await prisma.property.findMany({ where: { isActive: true }, select: { id: true } });
    const res = await server.inject({ method: "GET", url: "/apply" });
    if (active.length === 1) {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/apply/${active[0]!.id}`);
    } else {
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`/apply/${propertyId}`); // picker lists ours
    }
    await server.close();
  });
});
