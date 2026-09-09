import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaSeriesReferenceAccessError,
  SagaSeriesReferenceConflictError,
  SagaSeriesReferenceNotFoundError,
  SagaSeriesReferenceValidationError,
} from "@/lib/neon/saga-series-reference-repository";

export const sagaSeriesReferenceNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

export function sagaSeriesReferenceNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaSeriesReferenceNoStoreHeaders });
}

/** The signed session is the sole workspace selector for Series Reference routes. */
export async function requireSagaSeriesReferenceActor(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("SAGA Series References behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

export function sagaSeriesReferenceErrorResponse(
  error: unknown,
  fallback = "SAGA-serien kunde inte slutföra åtgärden.",
): NextResponse {
  if (error instanceof SagaSeriesReferenceAccessError) {
    return sagaSeriesReferenceNoStore({ error: error.message, code: "forbidden" }, 403);
  }
  if (error instanceof SagaSeriesReferenceNotFoundError) {
    return sagaSeriesReferenceNoStore({ error: error.message, code: "not_found" }, 404);
  }
  if (error instanceof SagaSeriesReferenceConflictError) {
    return sagaSeriesReferenceNoStore({ error: error.message, code: "conflict" }, 409);
  }
  if (error instanceof SagaSeriesReferenceValidationError) {
    return sagaSeriesReferenceNoStore({ error: error.message, code: "validation_failed" }, 422);
  }
  return sagaSeriesReferenceNoStore({ error: error instanceof Error ? error.message : fallback, code: "series_unavailable" }, 500);
}

export async function readSagaSeriesReferenceJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Reject a workspace selector at every nested level before parsing the request body. */
export function containsSagaSeriesReferenceWorkspaceId(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaSeriesReferenceWorkspaceId(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || containsSagaSeriesReferenceWorkspaceId(nested, depth + 1)
  ));
}
