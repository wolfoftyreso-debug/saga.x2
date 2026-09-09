import "server-only";

import { NextResponse } from "next/server";
import {
  NewsletterAudienceAccessError,
  NewsletterAudienceInUseError,
  NewsletterAudienceNotFoundError,
  NewsletterConsentError,
  NewsletterContactConflictError,
  NewsletterContactNotFoundError,
} from "@/lib/neon/newsletter-repository";

export const VERCEL_NEWSLETTER_DELIVERY_MISSING = ["Vercel e-postleverantör"];

/** The Vercel-only audience slice intentionally has no delivery side effect. */
export function vercelNewsletterDeliveryUnavailableResponse(): NextResponse {
  return NextResponse.json({
    configured: false,
    code: "newsletter_delivery_not_configured",
    missing: VERCEL_NEWSLETTER_DELIVERY_MISSING,
    error: "Mottagarlistor och samtycke körs i Vercel/Neon. Inga brev skickas förrän en e-postleverantör har anslutits.",
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

export function newsletterNeonErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof NewsletterAudienceAccessError) return noStoreError(error.message, 403);
  if (error instanceof NewsletterAudienceNotFoundError || error instanceof NewsletterContactNotFoundError) return noStoreError(error.message, 404);
  if (error instanceof NewsletterAudienceInUseError || error instanceof NewsletterContactConflictError) return noStoreError(error.message, 409);
  if (error instanceof NewsletterConsentError) return noStoreError(error.message, 422);
  return noStoreError(fallback, 500);
}

function noStoreError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
