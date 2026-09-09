import { NextRequest, NextResponse } from "next/server";
import { sagaSignalProductionPolicyInputSchema } from "@/lib/domain/saga-signal-production";
import {
  getSagaSignalProductionPolicy,
  saveSagaSignalProductionPolicy,
} from "@/lib/neon/saga-signal-production-repository";
import {
  hasSagaNewsWorkspaceField,
  readSagaNewsJson,
  requireSagaNewsActor,
  sagaNewsErrorResponse,
  sagaNewsNoStore,
} from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * API-only configuration seam for the explicit Research -> Studio opt-in.
 * Absence of a policy means no Cron-created drafts.  This route cannot select
 * another tenant and exposes no model, image or external delivery controls.
 */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att se SAGA:s produktionspolicy.");
  if (resolved.response) return resolved.response;
  try {
    return sagaNewsNoStore({ data: await getSagaSignalProductionPolicy(resolved.actor) });
  } catch (error) {
    return sagaNewsErrorResponse(error, "Produktionspolicyn kunde inte läsas.");
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att ändra SAGA:s produktionspolicy.");
  if (resolved.response) return resolved.response;
  const body = await readSagaNewsJson(request);
  if (body === null || hasSagaNewsWorkspaceField(body)) {
    return sagaNewsNoStore({ error: "Skicka en giltig policy utan workspaceId.", code: "invalid_production_policy" }, 422);
  }
  const parsed = sagaSignalProductionPolicyInputSchema.safeParse(body);
  if (!parsed.success) {
    return sagaNewsNoStore({
      error: parsed.error.issues[0]?.message ?? "Produktionspolicyn är inte giltig.",
      code: "invalid_production_policy",
    }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await saveSagaSignalProductionPolicy(resolved.actor, parsed.data) });
  } catch (error) {
    return sagaNewsErrorResponse(error, "Produktionspolicyn kunde inte sparas.");
  }
}

