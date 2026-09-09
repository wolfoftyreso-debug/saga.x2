import { NextResponse } from "next/server";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { newsletterNeonErrorResponse } from "@/lib/neon/newsletter-http";
import { listStudioNewsletterAudienceSummaries } from "@/lib/neon/newsletter-repository";
import { getNewsletterAudienceDeliverySummaries, NewsletterDeliveryError } from "@/lib/services/newsletter-delivery";
import { contentStudioServiceConfigurationResponse } from "@/lib/services/content-studio-http";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safe overview only. Recipient addresses have a separate contact endpoint. */
export async function GET() {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att se nyhetsbrevets mottagarlistor.");
    if (resolved.response) return resolved.response;
    try {
      return NextResponse.json(
        { audiences: await listStudioNewsletterAudienceSummaries(resolved.actor) },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte läsa mottagarlistorna.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att se nyhetsbrevets mottagargrupper." }, { status: 401 });
  try {
    return NextResponse.json(
      { audiences: await getNewsletterAudienceDeliverySummaries(createAdminClient(), userId) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte läsa mottagargrupperna.");
  }
}

function newsletterErrorResponse(error: unknown, fallback: string) {
  if (error instanceof NewsletterDeliveryError) {
    const status = error.code === "audience_not_found" ? 404 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
