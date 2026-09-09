import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaOutgoingApiAccessError,
  SagaOutgoingApiConflictError,
  SagaOutgoingApiNotFoundError,
  SagaOutgoingApiValidationError,
} from "@/lib/neon/saga-outgoing-api-repository";

/** Used by authenticated configuration routes. */
export const sagaOutgoingApiNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Used by bearer-authenticated exports. There is deliberately no CORS header. */
export const sagaOutgoingContentExternalHeaders = {
  "cache-control": "private, no-store, max-age=0, must-revalidate",
  pragma: "no-cache",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  vary: "Authorization",
};

export function sagaOutgoingApiResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaOutgoingApiNoStoreHeaders });
}

export function sagaOutgoingContentExternalResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaOutgoingContentExternalHeaders });
}

/** Signed session + Neon + owner role are all required for configuration. */
export async function requireSagaOutgoingApiOwner(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("Utgående innehålls-API behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

/** External clients see no details about existence, revocation or expiry. */
export function sagaOutgoingApiExternalUnauthorized(): NextResponse {
  return sagaOutgoingContentExternalResponse({ error: "Otillåten API-hemlighet." }, 401);
}

export function sagaOutgoingApiErrorResponse(error: unknown, fallback = "Kunde inte hantera API-utgåvan."): NextResponse {
  if (error instanceof SagaOutgoingApiAccessError) {
    return sagaOutgoingApiResponse({ error: error.message, code: "forbidden" }, 403);
  }
  if (error instanceof SagaOutgoingApiNotFoundError) {
    return sagaOutgoingApiResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error instanceof SagaOutgoingApiConflictError) {
    return sagaOutgoingApiResponse({ error: error.message, code: "conflict" }, 409);
  }
  if (error instanceof SagaOutgoingApiValidationError) {
    return sagaOutgoingApiResponse({ error: error.message, code: "validation_failed" }, 422);
  }
  // Never serialize a Neon/provider error: a key prefix or an owner-selected
  // API name may occur in it.
  return sagaOutgoingApiResponse({ error: fallback, code: "outgoing_api_unavailable" }, 500);
}

export async function readSagaOutgoingApiJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** No browser request may select a different workspace/user or smuggle a secret. */
export function containsSagaOutgoingApiForbiddenSelector(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaOutgoingApiForbiddenSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "ownerUserId"
    || key === "owner_user_id"
    || key === "secret"
    || key === "secretHash"
    || key === "secret_hash"
    || key === "token"
    || key === "apiKey"
    || key === "api_key"
    || containsSagaOutgoingApiForbiddenSelector(nested, depth + 1)
  ));
}

export function extractSagaOutgoingBearerSecret(request: Request): string | null {
  const value = request.headers.get("authorization");
  const secret = value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!secret || secret.length > 256) return null;
  return secret;
}

/** Query parameters are intentionally allowlisted so a bearer secret cannot become an URL token. */
export function hasOnlySagaOutgoingContentQuery(request: Request): boolean {
  const params = new URL(request.url).searchParams;
  return [...params.keys()].every((key) => key === "limit" || key === "cursor");
}
