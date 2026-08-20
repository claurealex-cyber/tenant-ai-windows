import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { runBillingCycle } from "../services/billing-cycle.js";

const prisma = new PrismaClient();
const TEST_PREFIX = `test_billing_${Date.now()}`;

function testEmail(name: string) {
  return `${TEST_PREFIX}_${name}@test.com`;
}

let userId: string;
let trialUserId: string;
let overageUserId: string;
let tierId: string;
let subId: string;
let trialSubId: string;
let overageSubId: string;
let propertyId: string;

const billingMonth = new Date(2026, 0, 1); // January 2026

beforeAll(async () => {
  await prisma.$connect();

  // Create a pricing tier
  const tier = await prisma.pricingTier.create({
    data: {
      name: `test_tier_${Date.now()}`,
      displayName: "Test Tier",
      basePriceCents: 5000, // $50
      includedAiCents: 3000, // $30 included
      aiMarkupPercent: 50, // 1.5x on overage
      maxProperties: 10,
    },
  });
  tierId = tier.id;

  // Active user with subscription
  const user = await prisma.user.create({
    data: {
      email: testEmail("active"),
      name: "Active Landlord",
      passwordHash: await bcrypt.hash("password123", 12),
      role: "client",
      onboarded: true,
    },
  });
  userId = user.id;

  const sub = await prisma.subscription.create({
    data: {
      userId,
      tierId,
      status: "active",
      currentPeriodStart: new Date(2026, 0, 1),
      currentPeriodEnd: new Date(2026, 1, 1),
    },
  });
  subId = sub.id;

  // Trial user (should NOT get invoiced)
  const trialUser = await prisma.user.create({
    data: {
      email: testEmail("trial"),
      name: "Trial Landlord",
      passwordHash: await bcrypt.hash("password123", 12),
      role: "client",
    },
  });
  trialUserId = trialUser.id;

  const trialSub = await prisma.subscription.create({
    data: {
      userId: trialUserId,
      tierId,
      status: "trialing",
      currentPeriodStart: new Date(2026, 0, 1),
      currentPeriodEnd: new Date(2026, 1, 1),
      trialEndsAt: new Date(2026, 0, 15),
    },
  });
  trialSubId = trialSub.id;

  // Overage user (exceeds included AI usage)
  const overageUser = await prisma.user.create({
    data: {
      email: testEmail("overage"),
      name: "Overage Landlord",
      passwordHash: await bcrypt.hash("password123", 12),
      role: "client",
      onboarded: true,
    },
  });
  overageUserId = overageUser.id;

  const overageSub = await prisma.subscription.create({
    data: {
      userId: overageUserId,
      tierId,
      status: "active",
      currentPeriodStart: new Date(2026, 0, 1),
      currentPeriodEnd: new Date(2026, 1, 1),
    },
  });
  overageSubId = overageSub.id;

  // Property for usage records
  const property = await prisma.property.create({
    data: {
      name: "Billing Test Property",
      address: "100 Bill Ave",
      userId,
      isActive: true,
    },
  });
  propertyId = property.id;

  // Usage records for active user (within included amount: $20 < $30)
  await prisma.usageRecord.createMany({
    data: [
      {
        userId,
        propertyId,
        type: "voice_call",
        costCents: 1500,
        quantity: 5,
        billingMonth,
      },
      {
        userId,
        type: "sms",
        costCents: 500,
        quantity: 10,
        billingMonth,
      },
    ],
  });

  // Usage records for overage user ($50 > $30 included)
  await prisma.usageRecord.createMany({
    data: [
      {
        userId: overageUserId,
        type: "voice_call",
        costCents: 4000,
        quantity: 15,
        billingMonth,
      },
      {
        userId: overageUserId,
        type: "sms",
        costCents: 1000,
        quantity: 20,
        billingMonth,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.invoice.deleteMany({
    where: {
      subscriptionId: { in: [subId, trialSubId, overageSubId] },
    },
  });
  await prisma.usageRecord.deleteMany({
    where: { userId: { in: [userId, overageUserId] } },
  });
  await prisma.subscription.deleteMany({
    where: { id: { in: [subId, trialSubId, overageSubId] } },
  });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.user.deleteMany({
    where: { email: { startsWith: TEST_PREFIX } },
  });
  await prisma.pricingTier.deleteMany({ where: { id: tierId } });
  await prisma.$disconnect();
});

describe("runBillingCycle", () => {
  it("creates invoices for active subscriptions", async () => {
    const created = await runBillingCycle(billingMonth);

    // runBillingCycle invoices EVERY active subscription in the database, so
    // the returned total also counts whatever else is active (e.g. the seeded
    // demo landlord on a fresh DB). Assert on our own subscriptions instead:
    // active + overage get an invoice, the trial does not.
    expect(created).toBeGreaterThanOrEqual(2);
    const ours = await prisma.invoice.findMany({
      where: { subscriptionId: { in: [subId, trialSubId, overageSubId] }, billingMonth },
      select: { subscriptionId: true },
    });
    expect(ours.map((i) => i.subscriptionId).sort()).toEqual([subId, overageSubId].sort());
  });

  it("calculates correct base price (no overage)", async () => {
    const invoice = await prisma.invoice.findFirst({
      where: { subscriptionId: subId, billingMonth },
    });

    expect(invoice).not.toBeNull();
    expect(invoice!.basePriceCents).toBe(5000); // $50
    expect(invoice!.aiUsageCostCents).toBe(2000); // $15 + $5 = $20
    expect(invoice!.aiMarkupCents).toBe(0); // $20 < $30 included
    expect(invoice!.totalCents).toBe(5000); // Just base price
    expect(invoice!.status).toBe("finalized");
  });

  it("calculates correct overage when AI usage exceeds included", async () => {
    const invoice = await prisma.invoice.findFirst({
      where: { subscriptionId: overageSubId, billingMonth },
    });

    expect(invoice).not.toBeNull();
    expect(invoice!.basePriceCents).toBe(5000); // $50
    expect(invoice!.aiUsageCostCents).toBe(5000); // $40 + $10 = $50

    // Overage: $50 - $30 included = $20, markup = $20 * 50% = $10
    expect(invoice!.aiMarkupCents).toBe(1000);
    expect(invoice!.totalCents).toBe(6000); // $50 base + $10 markup
  });

  it("does NOT create invoice for trialing subscriptions", async () => {
    const invoice = await prisma.invoice.findFirst({
      where: { subscriptionId: trialSubId, billingMonth },
    });

    expect(invoice).toBeNull();
  });

  it("is idempotent — running twice does not create duplicate invoices", async () => {
    const created = await runBillingCycle(billingMonth);
    expect(created).toBe(0); // All duplicates skipped

    const invoices = await prisma.invoice.findMany({
      where: { subscriptionId: subId },
    });
    expect(invoices).toHaveLength(1);
  });

  it("respects admin override pricing", async () => {
    // Set admin override on overage user's subscription
    await prisma.subscription.update({
      where: { id: overageSubId },
      data: {
        overrideBasePriceCents: 3500, // $35 override
        overrideAiMarkupPercent: 30, // 30% markup override
      },
    });

    // Use a different billing month to test override
    const febMonth = new Date(2026, 1, 1);

    // Create Feb usage for overage user
    await prisma.usageRecord.createMany({
      data: [
        {
          userId: overageUserId,
          type: "voice_call",
          costCents: 4000,
          quantity: 15,
          billingMonth: febMonth,
        },
      ],
    });

    const created = await runBillingCycle(febMonth);
    // Only overage user is active — active user has no Feb usage but still gets an invoice
    expect(created).toBeGreaterThanOrEqual(1);

    const invoice = await prisma.invoice.findFirst({
      where: { subscriptionId: overageSubId, billingMonth: febMonth },
    });

    expect(invoice).not.toBeNull();
    expect(invoice!.basePriceCents).toBe(3500); // Override

    // AI cost: $40, included: $30, overage: $10, markup: $10 * 30% = $3
    expect(invoice!.aiMarkupCents).toBe(300);
    expect(invoice!.totalCents).toBe(3800); // $35 + $3

    // Cleanup
    await prisma.invoice.deleteMany({
      where: { billingMonth: febMonth },
    });
    await prisma.usageRecord.deleteMany({
      where: { billingMonth: febMonth },
    });
    await prisma.subscription.update({
      where: { id: overageSubId },
      data: {
        overrideBasePriceCents: null,
        overrideAiMarkupPercent: null,
      },
    });
  });
});
