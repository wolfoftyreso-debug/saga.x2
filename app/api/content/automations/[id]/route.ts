import { NextRequest, NextResponse } from "next/server";
import { contentAutomationRuleIdSchema, contentAutomationRuleUpdateSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { studioAutomationErrorResponse as neonWriteErrorResponse } from "@/lib/services/studio-automation-http";
import { deleteStudioAutomation, getStudioAutomation, updateStudioAutomation } from "@/lib/neon/studio-content-repository";
import { deleteContentAutomationRule, getContentAutomationRuleForUser, updateContentAutomationRule } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa automationen.");
    if (resolved.response) return resolved.response;
    const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
    try {
      const automation = await getStudioAutomation(resolved.actor, id.data);
      if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
      return NextResponse.json({ automation }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte läsa automationen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa automationen." }, { status: 401 });
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  try {
    const automation = await getContentAutomationRuleForUser(createAdminClient(), userId, id.data);
    if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
    return NextResponse.json({ automation });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa automationen." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ändra automationen.");
    if (resolved.response) return resolved.response;
    const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = contentAutomationRuleUpdateSchema.safeParse(body);
    if (!payload.success) return NextResponse.json({ error: "Automationen innehåller ett ogiltigt värde." }, { status: 400 });
    try {
      const automation = await updateStudioAutomation(resolved.actor, id.data, payload.data);
      if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
      return NextResponse.json({ automation }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte uppdatera automationen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra automationen." }, { status: 401 });
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentAutomationRuleUpdateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Automationen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const automation = await updateContentAutomationRule(createAdminClient(), userId, id.data, payload.data);
    if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
    return NextResponse.json({ automation });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte uppdatera automationen." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ta bort automationen.");
    if (resolved.response) return resolved.response;
    const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
    try {
      const deleted = await deleteStudioAutomation(resolved.actor, id.data);
      if (!deleted) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte ta bort automationen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort automationen." }, { status: 401 });
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  try {
    const deleted = await deleteContentAutomationRule(createAdminClient(), userId, id.data);
    if (!deleted) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte ta bort automationen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
