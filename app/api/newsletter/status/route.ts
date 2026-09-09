import { NextResponse } from "next/server";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { vercelNewsletterDeliveryUnavailableResponse } from "@/lib/neon/newsletter-http";
import { getNewsletterProviderAvailability } from "@/lib/services/newsletter-publishing";
import { contentStudioPublicConfigurationResponse } from "@/lib/services/content-studio-http";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deliberately exposes configuration state, never API keys, sender secrets or
 * recipient information. The Studio uses it to prevent a ready-looking
 * audience list from implying that delivery has been configured.
 */
export async function GET() {
  if (isNeonDatabaseConfigured()) return vercelNewsletterDeliveryUnavailableResponse();
  const configuration = contentStudioPublicConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att se nyhetsbrevsstatus." }, { status: 401 });
  const availability = getNewsletterProviderAvailability();
  return NextResponse.json({
    configured: availability.configured,
    missing: availability.missing,
  }, { headers: { "cache-control": "no-store" } });
}
