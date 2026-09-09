import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readSagaNewsJson, requireSagaNewsActor, sagaNewsErrorResponse, sagaNewsNoStore } from "@/lib/services/saga-news-http";
import { runSagaNewsSourceNow } from "@/lib/services/saga-news-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const checkInputSchema = z.object({
  sourceId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
}).strict();

/**
 * A user-triggered, one-source fetch. It never asks an AI to write, creates a
 * private draft, schedules, sends or publishes. Retrying its UUID reuses the
 * durable run receipt rather than hitting a provider twice.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att hämta SAGA-signaler.");
  if (resolved.response) return resolved.response;
  const parsed = checkInputSchema.safeParse(await readSagaNewsJson(request));
  if (!parsed.success) {
    return sagaNewsNoStore({ error: "Skicka ett giltigt käll-id och hämtningskvitto.", code: "invalid_check" }, 422);
  }
  try {
    const data = await runSagaNewsSourceNow(resolved.actor, parsed.data);
    const status = data.status === "processing" ? 202
      : data.status === "failed"
        ? data.run.failureCode === "configuration" ? 503 : data.run.failureCode === "rate_limited" ? 429 : 502
        : 200;
    return sagaNewsNoStore({ data }, status);
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA kunde inte hämta den här källan.");
  }
}
