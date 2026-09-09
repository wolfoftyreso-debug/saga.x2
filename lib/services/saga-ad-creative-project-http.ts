import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaAdCreativeProjectAccessError,
  SagaAdCreativeProjectConflictError,
  SagaAdCreativeProjectNotFoundError,
  SagaAdCreativeProjectValidationError,
} from "@/lib/neon/saga-ad-creative-project-repository";

export const sagaAdCreativeProjectNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function sagaAdCreativeProjectResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaAdCreativeProjectNoStoreHeaders });
}

export async function requireSagaAdCreativeProjectActor(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("Annonsstudion behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

export function sagaAdCreativeProjectErrorResponse(error: unknown, fallback = "Annonsprojektet kunde inte slutföras."): NextResponse {
  if (error instanceof SagaAdCreativeProjectAccessError) return sagaAdCreativeProjectResponse({ error: error.message, code: "forbidden" }, 403);
  if (error instanceof SagaAdCreativeProjectNotFoundError) return sagaAdCreativeProjectResponse({ error: error.message, code: "not_found" }, 404);
  if (error instanceof SagaAdCreativeProjectConflictError) return sagaAdCreativeProjectResponse({ error: error.message, code: "conflict" }, 409);
  if (error instanceof SagaAdCreativeProjectValidationError) return sagaAdCreativeProjectResponse({ error: error.message, code: "validation_failed" }, 422);
  return sagaAdCreativeProjectResponse({ error: fallback, code: "ad_creative_unavailable" }, 500);
}

export async function readSagaAdCreativeProjectJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Browser data can never choose an account, workspace, user, model or delivery target. */
export function containsSagaAdCreativeForbiddenSelector(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaAdCreativeForbiddenSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "accountId"
    || key === "account_id"
    || key === "providerToken"
    || key === "accessToken"
    || key === "budget"
    || key === "publish"
    || key === "publishAt"
    || key === "blobUrl"
    || key === "blobPathname"
    || key === "assetUrl"
    || key === "assetPath"
    || containsSagaAdCreativeForbiddenSelector(nested, depth + 1)
  ));
}
