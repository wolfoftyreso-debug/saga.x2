import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaQuarterlyPlanningAccessError,
  SagaQuarterlyPlanningConflictError,
  SagaQuarterlyPlanningNotFoundError,
  SagaQuarterlyPlanningValidationError,
} from "@/lib/neon/saga-quarterly-planning-repository";

export const sagaQuarterlyPlanningNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function sagaQuarterlyPlanningResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaQuarterlyPlanningNoStoreHeaders });
}

export async function requireSagaQuarterlyPlanningActor(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("Kvartalsplanen behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

export function sagaQuarterlyPlanningErrorResponse(error: unknown, fallback = "Kvartalsplanen kunde inte slutföras."): NextResponse {
  if (error instanceof SagaQuarterlyPlanningAccessError) return sagaQuarterlyPlanningResponse({ error: error.message, code: "forbidden" }, 403);
  if (error instanceof SagaQuarterlyPlanningNotFoundError) return sagaQuarterlyPlanningResponse({ error: error.message, code: "not_found" }, 404);
  if (error instanceof SagaQuarterlyPlanningConflictError) return sagaQuarterlyPlanningResponse({ error: error.message, code: "conflict" }, 409);
  if (error instanceof SagaQuarterlyPlanningValidationError) return sagaQuarterlyPlanningResponse({ error: error.message, code: "validation_failed" }, 422);
  return sagaQuarterlyPlanningResponse({ error: fallback, code: "quarterly_planning_unavailable" }, 500);
}

export async function readSagaQuarterlyPlanningJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The actor/workspace and any publication/provider boundary stay server-owned.
 * `brandProfileId` is intentionally not banned because creation has no brand
 * path yet; strict Zod schemas prevent it anywhere else in a request body.
 */
export function containsSagaQuarterlyPlanningForbiddenSelector(value: unknown, depth = 0): boolean {
  if (depth > 10 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaQuarterlyPlanningForbiddenSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "accountId"
    || key === "account_id"
    || key === "providerAccountId"
    || key === "accessToken"
    || key === "providerToken"
    || key === "publish"
    || key === "publishAt"
    || key === "scheduledAt"
    || key === "scheduled_at"
    || key === "delivery"
    || key === "recipient"
    || key === "audienceId"
    || key === "calendarMove"
    || containsSagaQuarterlyPlanningForbiddenSelector(nested, depth + 1)
  ));
}
