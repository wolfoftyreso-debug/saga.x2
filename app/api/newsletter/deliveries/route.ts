import { NextRequest, NextResponse } from "next/server";
import { newsletterDeliveryReceiptQuerySchema } from "@/lib/domain/newsletter-delivery";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { vercelNewsletterDeliveryUnavailableResponse } from "@/lib/neon/newsletter-http";
import { listNewsletterDeliveryReceipts, NewsletterDeliveryError } from "@/lib/services/newsletter-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safe delivery ledger: it never includes recipient email addresses. */
export async function GET(request: NextRequest) {
  if (isNeonDatabaseConfigured()) return vercelNewsletterDeliveryUnavailableResponse();
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att se nyhetsbrevsleveranser." }, { status: 401 });
  const query = newsletterDeliveryReceiptQuerySchema.safeParse({
    contentDraftId: request.nextUrl.searchParams.get("draftId") ?? undefined,
    audienceId: request.nextUrl.searchParams.get("audienceId") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) return NextResponse.json({ error: "Leveransfiltret är ogiltigt." }, { status: 400 });
  try {
    return NextResponse.json(
      { deliveries: await listNewsletterDeliveryReceipts(createAdminClient(), userId, query.data) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte läsa nyhetsbrevsleveranserna.");
  }
}

function newsletterErrorResponse(error: unknown, fallback: string) {
  if (error instanceof NewsletterDeliveryError) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ error: fallback }, { status: 500 });
}
