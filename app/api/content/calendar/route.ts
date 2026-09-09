import { NextRequest, NextResponse } from "next/server";
import { contentCalendarQuerySchema } from "@/lib/domain/content-studio";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { getStudioContentCalendar, getStudioWorkspaceTimezone } from "@/lib/neon/studio-content-repository";
import { isValidIanaTimezone, localDateInTimezone } from "@/lib/utils/date";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Calendar is a Vercel/Neon-only read model. Its range is rendered in the
 * workspace timezone by default, while every entry retains the post's own
 * scheduled timezone and exact local time for safe rescheduling.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const configuration = neonConfigurationResponse("Studio behöver Neon i Vercel för att läsa kalendern.");
  if (configuration) return configuration;

  const resolved = await requireNeonActor("Logga in för att läsa kalendern.");
  if (resolved.response) return resolved.response;

  const requestedTimezone = request.nextUrl.searchParams.get("timezone")?.trim() || null;
  if (requestedTimezone && !isValidIanaTimezone(requestedTimezone)) {
    return invalidRangeResponse();
  }

  try {
    const timezone = requestedTimezone ?? await getStudioWorkspaceTimezone(resolved.actor);
    const requestedFrom = request.nextUrl.searchParams.get("from");
    const requestedTo = request.nextUrl.searchParams.get("to");
    if ((requestedFrom && !isCalendarDate(requestedFrom)) || (requestedTo && !isCalendarDate(requestedTo))) {
      return invalidRangeResponse();
    }
    const from = requestedFrom ?? localDateInTimezone(timezone);
    const to = requestedTo ?? addDays(from, 42);
    if (!to) return invalidRangeResponse();
    const payload = contentCalendarQuerySchema.safeParse({ from, to, timezone });
    if (!payload.success) return invalidRangeResponse();

    const calendar = await getStudioContentCalendar(resolved.actor, payload.data);
    return NextResponse.json({ calendar }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa kalendern.");
  }
}

function invalidRangeResponse(): NextResponse {
  return NextResponse.json(
    { error: "Kalenderintervallet eller tidszonen innehåller ett ogiltigt värde." },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string | null {
  if (!isCalendarDate(date)) return null;
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
