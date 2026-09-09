import { NextRequest, NextResponse } from "next/server";
import { adAutomationIdSchema, adAutomationUpdateSchema } from "@/lib/domain/ad-automation";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { deleteAdAutomation, getAdAutomation, updateAdAutomation } from "@/lib/neon/ad-automation-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att läsa annonsautomationen.");
  if (resolved.response) return resolved.response;
  const id = adAutomationIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  try {
    const automation = await getAdAutomation(resolved.actor, id.data);
    if (!automation) return NextResponse.json({ error: "Annonsautomationen hittades inte." }, { status: 404 });
    return NextResponse.json({ automation }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa annonsautomationen.");
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att ändra annonsautomationen.");
  if (resolved.response) return resolved.response;
  const id = adAutomationIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = adAutomationUpdateSchema.safeParse(body);
  if (!payload.success || Object.keys(payload.data).length <= 1) {
    return NextResponse.json({ error: "Skicka minst ett giltigt fält att spara." }, { status: 400 });
  }
  try {
    const automation = await updateAdAutomation(resolved.actor, id.data, payload.data);
    if (!automation) return NextResponse.json({ error: "Annonsautomationen hittades inte." }, { status: 404 });
    return NextResponse.json({ automation }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte uppdatera annonsautomationen.");
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att ta bort annonsautomationen.");
  if (resolved.response) return resolved.response;
  const id = adAutomationIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  try {
    const deleted = await deleteAdAutomation(resolved.actor, id.data);
    if (!deleted) return NextResponse.json({ error: "Annonsautomationen hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte ta bort annonsautomationen.");
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
