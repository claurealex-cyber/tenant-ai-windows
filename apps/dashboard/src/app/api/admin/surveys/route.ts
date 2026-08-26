import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toCSV } from "@tenant-ai/shared";

// Select that NEVER includes dateOfBirth (or raw ssn) — the list payload must be PII-free.
const listSelect = {
  id: true,
  propertyId: true,
  status: true,
  channel: true,
  callerPhone: true,
  fullName: true,
  email: true,
  monthlyIncome: true,
  customResponses: true,
  completedAt: true,
  forwardedAt: true,
  createdAt: true,
  reviewedAt: true,
  property: { select: { id: true, name: true } },
} as const;

function buildWhere(params: URLSearchParams) {
  // Voice applications ask the same questions and store the same shape — the
  // "survey responses" view covers both intake channels.
  const where: Record<string, unknown> = { channel: { in: ["sms_link", "web_link", "voice"] } };

  const propertyId = params.get("propertyId");
  if (propertyId) where.propertyId = propertyId;

  const status = params.get("status");
  if (status) where.status = status;

  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  if (dateFrom || dateTo) {
    where.completedAt = {
      ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { lte: new Date(dateTo) } : {}),
    };
  }

  const q = params.get("q");
  if (q) {
    where.OR = [
      { fullName: { contains: q, mode: "insensitive" } },
      { callerPhone: { contains: q } },
    ];
  }

  return where;
}

/**
 * GET /api/admin/surveys — list sms_link survey applications (admin only).
 *
 * Query params: propertyId, status, dateFrom, dateTo, q, skip, limit,
 *               format=csv (CSV download), view=invites (outstanding invites).
 * The list response never contains dateOfBirth.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as any).role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;

    // Secondary view: outstanding (unused, unexpired) survey invites
    if (params.get("view") === "invites") {
      const invites = await prisma.surveyInvite.findMany({
        where: { usedAt: null, expiresAt: { gt: new Date() } },
        select: {
          id: true,
          phone: true,
          propertyId: true,
          channel: true,
          createdAt: true,
          expiresAt: true,
          property: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return NextResponse.json({ invites });
    }

    const where = buildWhere(params);

    // CSV export of the current filter set
    if (params.get("format") === "csv") {
      const applications = await prisma.application.findMany({
        where,
        select: listSelect,
        orderBy: { completedAt: "desc" },
        take: 10000,
      });

      const rows = applications.map((a) => {
        const custom = (a.customResponses ?? {}) as Record<string, unknown>;
        return {
          submitted: a.completedAt ? a.completedAt.toISOString() : "",
          name: a.fullName || "",
          phone: a.callerPhone || "",
          bedrooms: custom.bedrooms_needed != null ? String(custom.bedrooms_needed) : "",
          income: a.monthlyIncome || "",
          property: a.property.name,
          status: a.status,
        };
      });

      const columns = [
        { key: "submitted", label: "Submitted" },
        { key: "name", label: "Name" },
        { key: "phone", label: "Phone" },
        { key: "bedrooms", label: "Bedrooms" },
        { key: "income", label: "Monthly Income" },
        { key: "property", label: "Property" },
        { key: "status", label: "Status" },
      ];

      const csv = toCSV(rows, columns);
      const today = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="survey-responses-${today}.csv"`,
        },
      });
    }

    const skip = parseInt(params.get("skip") || "0", 10);
    const limit = Math.min(parseInt(params.get("limit") || "50", 10), 100);

    const [entries, total] = await Promise.all([
      prisma.application.findMany({
        where,
        select: listSelect,
        orderBy: { completedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.application.count({ where }),
    ]);

    return NextResponse.json({
      entries,
      pagination: { total, skip, limit },
    });
  } catch (error) {
    console.error("Admin surveys GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
