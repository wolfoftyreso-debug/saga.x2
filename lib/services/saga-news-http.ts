import "server-only";

import { NextResponse } from "next/server";
import { SagaNewsCoreError } from "@/lib/news-core/errors";
import { isNeonDatabaseConfigured, missingNeonConfiguration } from "@/lib/neon/config";
import { requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaNewsAccessError,
  SagaNewsConflictError,
  SagaNewsNotFoundError,
  SagaNewsPolicyError,
} from "@/lib/neon/saga-news-core-repository";

export const sagaNewsNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

export function sagaNewsNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaNewsNoStoreHeaders });
}

/** The signed session always owns workspace scope; no request can select it. */
export async function requireSagaNewsActor(message: string): Promise<NeonActorResolution> {
  if (!isNeonDatabaseConfigured()) {
    return {
      response: sagaNewsNoStore({
        error: "SAGA Research är inte tillgängligt just nu.",
        code: "configuration_required",
        missing: missingNeonConfiguration(),
      }, 503),
    };
  }
  return requireNeonActor(message);
}

export function sagaNewsErrorResponse(error: unknown, fallback = "SAGA Research kunde inte slutföra åtgärden."): NextResponse {
  if (error instanceof SagaNewsCoreError) {
    return sagaNewsNoStore({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof SagaNewsAccessError) return sagaNewsNoStore({ error: error.message, code: "forbidden" }, 403);
  if (error instanceof SagaNewsNotFoundError) return sagaNewsNoStore({ error: error.message, code: "not_found" }, 404);
  if (error instanceof SagaNewsPolicyError) return sagaNewsNoStore({ error: error.message, code: "policy_rejected" }, 422);
  if (error instanceof SagaNewsConflictError) return sagaNewsNoStore({ error: error.message, code: "conflict" }, 409);
  return sagaNewsNoStore({ error: error instanceof Error ? error.message : fallback, code: "research_unavailable" }, 500);
}

export async function readSagaNewsJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function hasSagaNewsWorkspaceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasSagaNewsWorkspaceField(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || hasSagaNewsWorkspaceField(nested, depth + 1)
  ));
}
