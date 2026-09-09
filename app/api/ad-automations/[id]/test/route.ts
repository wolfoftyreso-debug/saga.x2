import { NextRequest, NextResponse } from "next/server";
import { adAutomationIdSchema, adAutomationManualTestInputSchema } from "@/lib/domain/ad-automation";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { runAdAutomationManualTest } from "@/lib/neon/ad-automation-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Manual test seam. It persists a private idempotent receipt and one
 * deterministic creative-brief Studio draft. No AI provider, campaign API,
 * social account, RSS endpoint or newsletter service is contacted.
 */
export async function POST(request: NextRequest, context: Context) {
  const configuration = neonConfigurationResponse("Annonsautomationer behöver en Vercel-ansluten Neon-databas.");
  if (configuration) return configuration;
  const resolved = await requireNeonActor("Logga in för att testa annonsautomationen.");
  if (resolved.response) return resolved.response;
  const id = adAutomationIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  const body = await readJson(request);
  const payload = adAutomationManualTestInputSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Skicka en giltig idempotensnyckel för testet." }, { status: 400 });
  try {
    const prepared = await runAdAutomationManualTest(resolved.actor, {
      automationId: id.data,
      idempotencyKey: payload.data.idempotencyKey,
    });
    if (!prepared) return NextResponse.json({ error: "Annonsautomationen hittades inte." }, { status: 404 });
    return NextResponse.json({
      status: "private_draft_created",
      automation: prepared.automation,
      receipt: prepared.receipt,
      draft: prepared.draft,
      reused: prepared.reused,
      externalExecution: "unavailable",
      message: prepared.reused
        ? "Samma privata kreativa utkast används igen. Ingen AI-copy eller annons har skickats eller publicerats."
        : "Ett privat deterministiskt kreativt utkast är klart. Ingen AI-copy eller annons har skickats eller publicerats.",
    }, {
      status: prepared.reused ? 200 : 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte skapa ett privat kreativt utkast.");
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
