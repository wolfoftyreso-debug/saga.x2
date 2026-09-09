import { NextRequest, NextResponse } from "next/server";
import { contentTemplateIdSchema, contentTemplateUpdateSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { deleteStudioTemplate, getStudioTemplate, updateStudioTemplate } from "@/lib/neon/studio-content-repository";
import { deleteContentTemplate, getContentTemplateForUser, updateContentTemplate } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa mallen.");
    if (resolved.response) return resolved.response;
    const id = contentTemplateIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
    try {
      const template = await getStudioTemplate(resolved.actor, id.data);
      if (!template) return NextResponse.json({ error: "Mallen hittades inte." }, { status: 404 });
      return NextResponse.json({ template }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte läsa mallen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa mallen." }, { status: 401 });
  const id = contentTemplateIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
  try {
    const template = await getContentTemplateForUser(createAdminClient(), userId, id.data);
    if (!template) return NextResponse.json({ error: "Mallen hittades inte." }, { status: 404 });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa mallen." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ändra mallen.");
    if (resolved.response) return resolved.response;
    const id = contentTemplateIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = contentTemplateUpdateSchema.safeParse(body);
    if (!payload.success) return NextResponse.json({ error: "Mallen innehåller ett ogiltigt värde." }, { status: 400 });
    try {
      const template = await updateStudioTemplate(resolved.actor, id.data, payload.data);
      if (!template) return NextResponse.json({ error: "Mallen hittades inte." }, { status: 404 });
      return NextResponse.json({ template }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte uppdatera mallen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra mallen." }, { status: 401 });
  const id = contentTemplateIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentTemplateUpdateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Mallen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const template = await updateContentTemplate(createAdminClient(), userId, id.data, payload.data);
    if (!template) return NextResponse.json({ error: "Mallen hittades inte eller är en låst startmall." }, { status: 404 });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte uppdatera mallen." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ta bort mallen.");
    if (resolved.response) return resolved.response;
    const id = contentTemplateIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
    try {
      const deleted = await deleteStudioTemplate(resolved.actor, id.data);
      if (!deleted) return NextResponse.json({ error: "Mallen hittades inte." }, { status: 404 });
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte ta bort mallen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort mallen." }, { status: 401 });
  const id = contentTemplateIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt mall-id." }, { status: 400 });
  try {
    const deleted = await deleteContentTemplate(createAdminClient(), userId, id.data);
    if (!deleted) return NextResponse.json({ error: "Mallen hittades inte eller är en låst startmall." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte ta bort mallen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
