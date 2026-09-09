import { NextRequest, NextResponse } from "next/server";
import { getStudioAutomationRunOverview } from "@/lib/neon/studio-content-repository";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Actor-scoped monitor for durable content-generation receipts. This is not
 * the ad-automation scheduler and never touches a provider or a model.
 */
export async function GET(request: NextRequest) {
  const configuration = neonConfigurationResponse("Studio behöver en Vercel-ansluten arbetsyta för att visa riktiga körningar.");
  if (configuration) return configuration;

  const resolved = await requireNeonActor("Logga in för att se automationskörningarna.");
  if (resolved.response) return resolved.response;

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  if (limit === null) {
    return NextResponse.json(
      { error: "limit måste vara ett heltal mellan 1 och 100." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const overview = await getStudioAutomationRunOverview(resolved.actor, { limit });
    return NextResponse.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa automationskörningarna.");
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}
