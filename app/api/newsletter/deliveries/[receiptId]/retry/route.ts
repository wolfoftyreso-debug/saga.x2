import { NextRequest, NextResponse } from "next/server";
import { newsletterDeliveryReceiptIdSchema } from "@/lib/domain/newsletter-delivery";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { vercelNewsletterDeliveryUnavailableResponse } from "@/lib/neon/newsletter-http";
import { NewsletterDeliveryError, requeueNewsletterDeliveryReceipt } from "@/lib/services/newsletter-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * This is intentionally explicit: an `unknown` delivery could already have
 * reached the provider, so the user must request any new attempt themselves.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ receiptId: string }> }) {
  if (isNeonDatabaseConfigured()) return vercelNewsletterDeliveryUnavailableResponse();
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att försöka skicka igen." }, { status: 401 });
  const { receiptId } = await context.params;
  if (!newsletterDeliveryReceiptIdSchema.safeParse(receiptId).success) return NextResponse.json({ error: "Ogiltigt leverans-id." }, { status: 400 });
  try {
    const queued = await requeueNewsletterDeliveryReceipt(createAdminClient(), userId, receiptId);
    if (!queued) return NextResponse.json({ error: "Leveransen kan inte köas om. Den är redan skickad eller saknas." }, { status: 409 });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof NewsletterDeliveryError) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ error: "Kunde inte köa om leveransen." }, { status: 500 });
  }
}
