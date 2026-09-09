import "server-only";

import type { NextResponse } from "next/server";
import type { NeonActorResolution } from "@/lib/neon/http";
import { resolveSagaBrandActor, SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import { SagaNewsAccessError, SagaNewsConflictError, SagaNewsNotFoundError, SagaNewsPolicyError } from "@/lib/neon/saga-news-core-repository";
import { requireSagaNewsActor, sagaNewsErrorResponse, sagaNewsNoStore } from "@/lib/services/saga-news-http";

/** The query selects a brand, never a tenant. Resolve it against the signed workspace. */
export async function requireSagaDailyKnowledgeActor(request: Request, message: string): Promise<NeonActorResolution> {
  const resolved = await requireSagaNewsActor(message);
  if (resolved.response) return resolved;
  try {
    const values = new URL(request.url).searchParams.getAll("brandProfileId");
    if (values.length > 1 || (values.length === 1 && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(values[0]!))) {
      return { response: sagaNewsNoStore({ error: "Välj ett giltigt varumärke.", code: "brand_not_found" }, 404) };
    }
    return { actor: await resolveSagaBrandActor(resolved.actor, values[0]) };
  } catch (error) {
    return { response: sagaDailyKnowledgeErrorResponse(error, "Varumärkets kunskapsinställningar kunde inte kontrolleras.") };
  }
}

export function sagaDailyKnowledgeErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SagaBrandScopeError) return sagaNewsNoStore({ error: error.message, code: error.code }, error.status);
  if (error instanceof SagaNewsAccessError || error instanceof SagaNewsConflictError
      || error instanceof SagaNewsNotFoundError || error instanceof SagaNewsPolicyError) {
    return sagaNewsErrorResponse(error, fallback);
  }
  // Database errors can include SQL, connection data or policy contents.
  return sagaNewsNoStore({ error: fallback, code: "daily_knowledge_unavailable" }, 503);
}
