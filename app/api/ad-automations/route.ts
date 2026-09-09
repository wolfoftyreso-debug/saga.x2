import { NextRequest, NextResponse } from "next/server";
import { adAutomationCreateSchema } from "@/lib/domain/ad-automation";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { createAdAutomation, listAdAutomations } from "@/lib/neon/ad-automation-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att läsa annonsautomationer.");
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json(
      { automations: await listAdAutomations(resolved.actor) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa annonsautomationerna.");
  }
}

export async function POST(request: NextRequest) {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att skapa en annonsautomation.");
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = adAutomationCreateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Annonsflödet innehåller ett ogiltigt eller ofullständigt steg." }, { status: 400 });
  try {
    const created = await createAdAutomation(resolved.actor, payload.data);
    return NextResponse.json(
      created,
      { status: created.reused ? 200 : 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte spara annonsautomationen.");
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
