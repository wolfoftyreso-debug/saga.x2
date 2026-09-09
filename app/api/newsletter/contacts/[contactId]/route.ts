import { NextRequest, NextResponse } from "next/server";
import { newsletterContactIdSchema, newsletterContactUpdateSchema } from "@/lib/domain/newsletter-delivery";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { newsletterNeonErrorResponse } from "@/lib/neon/newsletter-http";
import { deleteStudioNewsletterContact, updateStudioNewsletterContact } from "@/lib/neon/newsletter-repository";
import {
  deleteNewsletterContact,
  NewsletterDeliveryError,
  updateNewsletterContact,
} from "@/lib/services/newsletter-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ contactId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ändra en mottagare.");
    if (resolved.response) return resolved.response;
    const { contactId } = await context.params;
    if (!newsletterContactIdSchema.safeParse(contactId).success) return NextResponse.json({ error: "Ogiltigt mottagar-id." }, { status: 400 });
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const input = newsletterContactUpdateSchema.safeParse(body);
    if (!input.success) return NextResponse.json({ error: input.error.issues[0]?.message ?? "Mottagaren är inte giltig." }, { status: 400 });
    if (Object.keys(input.data).length === 0) return NextResponse.json({ error: "Välj minst ett värde att ändra." }, { status: 400 });
    try {
      const contact = await updateStudioNewsletterContact(resolved.actor, contactId, input.data);
      return NextResponse.json({ contact }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte uppdatera mottagaren.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra en mottagare." }, { status: 401 });
  const { contactId } = await context.params;
  if (!newsletterContactIdSchema.safeParse(contactId).success) return NextResponse.json({ error: "Ogiltigt mottagar-id." }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  }
  const input = newsletterContactUpdateSchema.safeParse(body);
  if (!input.success) return NextResponse.json({ error: input.error.issues[0]?.message ?? "Mottagaren är inte giltig." }, { status: 400 });
  if (Object.keys(input.data).length === 0) return NextResponse.json({ error: "Välj minst ett värde att ändra." }, { status: 400 });
  try {
    const contact = await updateNewsletterContact(createAdminClient(), userId, contactId, input.data);
    return NextResponse.json({ contact }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte uppdatera mottagaren.");
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ contactId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ta bort en mottagare.");
    if (resolved.response) return resolved.response;
    const { contactId } = await context.params;
    if (!newsletterContactIdSchema.safeParse(contactId).success) return NextResponse.json({ error: "Ogiltigt mottagar-id." }, { status: 400 });
    try {
      const deleted = await deleteStudioNewsletterContact(resolved.actor, contactId);
      if (!deleted) return NextResponse.json({ error: "Mottagaren hittades inte." }, { status: 404, headers: { "cache-control": "no-store" } });
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte ta bort mottagaren.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort en mottagare." }, { status: 401 });
  const { contactId } = await context.params;
  if (!newsletterContactIdSchema.safeParse(contactId).success) return NextResponse.json({ error: "Ogiltigt mottagar-id." }, { status: 400 });
  try {
    const deleted = await deleteNewsletterContact(createAdminClient(), userId, contactId);
    if (!deleted) return NextResponse.json({ error: "Mottagaren hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return newsletterErrorResponse(error, "Kunde inte ta bort mottagaren.");
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
    const status = error.code === "contact_not_found" ? 404 : error.code === "contact_exists" ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
