import { NextRequest, NextResponse } from "next/server";
import { sagaAdobeAuthoringRunGenerateSchema } from "@/lib/domain/saga-adobe-authoring";
import {
  getSagaAdobeAuthoringGenerationReceipt,
  getSagaAdobeAuthoringRun,
  prepareSagaAdobeAuthoringRunGeneration,
} from "@/lib/neon/saga-adobe-authoring-repository";
import { runSagaAdobeAuthoringWorker } from "@/lib/neon/saga-adobe-authoring-worker";
import {
  containsSagaAdobeAuthoringForbiddenSelector,
  readSagaAdobeAuthoringJson,
  requireSagaAdobeAuthoringActor,
  sagaAdobeAuthoringErrorResponse,
  sagaAdobeAuthoringResponse,
} from "@/lib/services/saga-adobe-authoring-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ runId: string }> };

/**
 * Explicitly reserves/resumes a durable run and processes one private
 * candidate. It never creates a Studio draft, schedule, image or publication.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdobeAuthoringActor("Logga in för att skapa privata textkandidater.", request);
  if (resolved.response) return resolved.response;
  const body = await readSagaAdobeAuthoringJson(request);
  if (body === null || containsSagaAdobeAuthoringForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaAdobeAuthoringRunGenerateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const { runId } = await context.params;
  try {
    const prepared = await prepareSagaAdobeAuthoringRunGeneration(resolved.actor, runId, parsed.data);
    // A command key owns exactly one bounded worker slice. Replaying the same
    // request returns current state only; it must never claim candidate N+1.
    const worker = prepared.command.shouldProcess && prepared.command.claimToken
      ? await runSagaAdobeAuthoringWorker({
        actor: resolved.actor,
        runId: prepared.run.id,
        receiptId: prepared.receipt.id,
        commandId: prepared.command.id,
        commandClaimToken: prepared.command.claimToken,
        workerId: "saga-adobe-authoring-manual",
      })
      : {
        runId: prepared.run.id,
        receiptId: prepared.receipt.id,
        jobsClaimed: 0,
        candidatesReady: 0,
        qualityBlocked: 0,
        failuresRecorded: 0,
        leasesLost: 0,
        timeBudgetReached: false,
        jobs: [],
        noPublication: true as const,
        studioDraftsCreated: 0,
      };
    const [run, receipt] = await Promise.all([
      getSagaAdobeAuthoringRun(resolved.actor, prepared.run.id),
      getSagaAdobeAuthoringGenerationReceipt(resolved.actor, prepared.receipt.id, prepared.receipt.reused),
    ]);
    return sagaAdobeAuthoringResponse({
      run: run ?? prepared.run,
      receipt: receipt ?? prepared.receipt,
      worker,
      noPublication: true,
      studioDraftsCreated: 0,
    });
  } catch (error) {
    return sagaAdobeAuthoringErrorResponse(error, "Kunde inte starta den privata kandidatproduktionen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaAdobeAuthoringResponse({
    error: "Skicka idempotensnyckel och aktuell körningsrevision. Kandidatproduktion kan inte få innehåll, URL, namn, schema eller publicering från webbläsaren.",
    code: "invalid_authoring_generation_request",
  }, 422);
}
