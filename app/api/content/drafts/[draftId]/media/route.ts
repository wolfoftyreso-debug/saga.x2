import { NextRequest, NextResponse } from "next/server";
import { contentDraftIdSchema, contentMediaAttachmentCreateSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { listStudioMediaForDraft } from "@/lib/neon/studio-content-repository";
import { createContentMediaAttachment, listContentMediaForDraft } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ draftId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa mediefiler.");
    if (resolved.response) return resolved.response;
    const draftId = contentDraftIdSchema.safeParse((await context.params).draftId);
    if (!draftId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });
    try {
      const media = await listStudioMediaForDraft(resolved.actor, draftId.data);
      return NextResponse.json({ media }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa mediefilerna." }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa mediefiler." }, { status: 401 });
  const draftId = contentDraftIdSchema.safeParse((await context.params).draftId);
  if (!draftId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });
  try {
    const media = await listContentMediaForDraft(createAdminClient(), userId, draftId.data);
    return NextResponse.json({ media });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa mediefilerna." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att lägga till en mediefil.");
    if (resolved.response) return resolved.response;
    const draftId = contentDraftIdSchema.safeParse((await context.params).draftId);
    if (!draftId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });
    // A Vercel-native media row must originate from the authenticated upload
    // route. Accepting a client supplied asset URL would bypass private Blob
    // ownership and make the Studio preview unsafe.
    return NextResponse.json(
      { error: "Lägg till filer via uppladdningsrutan i Studio." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att lägga till en mediefil." }, { status: 401 });
  const draftId = contentDraftIdSchema.safeParse((await context.params).draftId);
  if (!draftId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentMediaAttachmentCreateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Mediefilen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const media = await createContentMediaAttachment(createAdminClient(), userId, draftId.data, payload.data);
    return NextResponse.json({ media }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunde inte lägga till mediefilen.";
    return NextResponse.json({ error: message }, { status: message === "Utkastet hittades inte." ? 404 : 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
