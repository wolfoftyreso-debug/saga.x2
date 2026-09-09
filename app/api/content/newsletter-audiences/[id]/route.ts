import { NextRequest, NextResponse } from "next/server";
import { newsletterAudienceIdSchema, newsletterAudienceUpdateSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { newsletterNeonErrorResponse } from "@/lib/neon/newsletter-http";
import {
  deleteStudioNewsletterAudience,
  getStudioNewsletterAudience,
  updateStudioNewsletterAudience,
} from "@/lib/neon/newsletter-repository";
import { deleteNewsletterAudience, getNewsletterAudienceForUser, updateNewsletterAudience } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa mottagarlistan.");
    if (resolved.response) return resolved.response;
    const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
    try {
      const audience = await getStudioNewsletterAudience(resolved.actor, id.data);
      if (!audience) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404, headers: { "cache-control": "no-store" } });
      return NextResponse.json({ audience }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte läsa mottagarlistan.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa nyhetsbrevsmålgruppen." }, { status: 401 });
  const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
  try {
    const audience = await getNewsletterAudienceForUser(createAdminClient(), userId, id.data);
    if (!audience) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404 });
    return NextResponse.json({ audience });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa nyhetsbrevsmålgruppen." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ändra mottagarlistan.");
    if (resolved.response) return resolved.response;
    const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = newsletterAudienceUpdateSchema.safeParse(body);
    if (!payload.success || Object.keys(payload.data).length === 0) return NextResponse.json({ error: "Mottagarlistan innehåller inget giltigt värde att ändra." }, { status: 400 });
    try {
      const audience = await updateStudioNewsletterAudience(resolved.actor, id.data, payload.data);
      if (!audience) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404, headers: { "cache-control": "no-store" } });
      return NextResponse.json({ audience }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte uppdatera mottagarlistan.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra nyhetsbrevsmålgruppen." }, { status: 401 });
  const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = newsletterAudienceUpdateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const audience = await updateNewsletterAudience(createAdminClient(), userId, id.data, payload.data);
    if (!audience) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404 });
    return NextResponse.json({ audience });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte uppdatera nyhetsbrevsmålgruppen." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ta bort mottagarlistan.");
    if (resolved.response) return resolved.response;
    const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
    try {
      const deleted = await deleteStudioNewsletterAudience(resolved.actor, id.data);
      if (!deleted) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404, headers: { "cache-control": "no-store" } });
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte ta bort mottagarlistan.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort nyhetsbrevsmålgruppen." }, { status: 401 });
  const id = newsletterAudienceIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt målgrupps-id." }, { status: 400 });
  try {
    const deleted = await deleteNewsletterAudience(createAdminClient(), userId, id.data);
    if (!deleted) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte ta bort nyhetsbrevsmålgruppen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
