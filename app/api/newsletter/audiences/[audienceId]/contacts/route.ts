import { NextRequest, NextResponse } from "next/server";
import {
  newsletterAudienceIdSchema,
  newsletterContactCreateSchema,
  newsletterContactListQuerySchema,
} from "@/lib/domain/newsletter-delivery";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { newsletterNeonErrorResponse } from "@/lib/neon/newsletter-http";
import { createStudioNewsletterContact, listStudioNewsletterContacts } from "@/lib/neon/newsletter-repository";
import {
  createNewsletterContact,
  listNewsletterContacts,
  NewsletterDeliveryError,
} from "@/lib/services/newsletter-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ audienceId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att se mottagare.");
    if (resolved.response) return resolved.response;
    const { audienceId } = await context.params;
    if (!newsletterAudienceIdSchema.safeParse(audienceId).success) return NextResponse.json({ error: "Ogiltigt mottagargrupps-id." }, { status: 400 });
    const query = newsletterContactListQuerySchema.safeParse({
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
    });
    if (!query.success) return NextResponse.json({ error: "Filter för mottagare är ogiltigt." }, { status: 400 });
    try {
      return NextResponse.json(
        { contacts: await listStudioNewsletterContacts(resolved.actor, audienceId, query.data) },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte läsa mottagarna.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att se mottagare." }, { status: 401 });
  const { audienceId } = await context.params;
  if (!newsletterAudienceIdSchema.safeParse(audienceId).success) return NextResponse.json({ error: "Ogiltigt mottagargrupps-id." }, { status: 400 });
  const query = newsletterContactListQuerySchema.safeParse({
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    status: request.nextUrl.searchParams.get("status") ?? undefined,
  });
  if (!query.success) return NextResponse.json({ error: "Filter för mottagare är ogiltigt." }, { status: 400 });
  try {
    const contacts = await listNewsletterContacts(createAdminClient(), userId, audienceId, query.data);
    return NextResponse.json({ contacts }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte läsa mottagarna.");
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ audienceId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att lägga till en mottagare.");
    if (resolved.response) return resolved.response;
    const { audienceId } = await context.params;
    if (!newsletterAudienceIdSchema.safeParse(audienceId).success) return NextResponse.json({ error: "Ogiltigt mottagargrupps-id." }, { status: 400 });
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const input = newsletterContactCreateSchema.safeParse({ ...(body && typeof body === "object" ? body : {}), audienceId });
    if (!input.success) return NextResponse.json({ error: input.error.issues[0]?.message ?? "Mottagaren är inte giltig." }, { status: 400 });
    try {
      const contact = await createStudioNewsletterContact(resolved.actor, input.data);
      return NextResponse.json({ contact }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte lägga till mottagaren.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att lägga till en mottagare." }, { status: 401 });
  const { audienceId } = await context.params;
  if (!newsletterAudienceIdSchema.safeParse(audienceId).success) return NextResponse.json({ error: "Ogiltigt mottagargrupps-id." }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  }
  const input = newsletterContactCreateSchema.safeParse({ ...(body && typeof body === "object" ? body : {}), audienceId });
  if (!input.success) return NextResponse.json({ error: input.error.issues[0]?.message ?? "Mottagaren är inte giltig." }, { status: 400 });
  try {
    const contact = await createNewsletterContact(createAdminClient(), userId, input.data);
    return NextResponse.json({ contact }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte lägga till mottagaren.");
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function newsletterErrorResponse(error: unknown, fallback: string) {
  if (error instanceof NewsletterDeliveryError) {
    const status = error.code === "audience_not_found" ? 404 : error.code === "contact_exists" ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
