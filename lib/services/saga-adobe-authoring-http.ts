import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  resolveSagaBrandActor,
  SagaBrandScopeError,
} from "@/lib/neon/saga-brand-api-eligibility";
import {
  SagaAdobeAuthoringAccessError,
  SagaAdobeAuthoringConflictError,
  SagaAdobeAuthoringNotFoundError,
  SagaAdobeAuthoringValidationError,
} from "@/lib/neon/saga-adobe-authoring-repository";

export const sagaAdobeAuthoringNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function sagaAdobeAuthoringResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaAdobeAuthoringNoStoreHeaders });
}

export async function requireSagaAdobeAuthoringActor(message: string, request?: Request): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("SAGA Författarstudio behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  const resolved = await requireNeonActor(message);
  if (resolved.response) return resolved;
  try {
    const requested = request ? new URL(request.url).searchParams.get("brandProfileId") : null;
    return { actor: await resolveSagaBrandActor(resolved.actor, requested) };
  } catch (error) {
    if (error instanceof SagaBrandScopeError) {
      return { response: sagaAdobeAuthoringResponse({ error: error.message, code: error.code }, error.status) };
    }
    return {
      response: sagaAdobeAuthoringResponse({
        error: "Författarstudion kan inte verifiera varumärkesvalet just nu.",
        code: "authoring_unavailable",
      }, 503),
    };
  }
}

export function sagaAdobeAuthoringErrorResponse(error: unknown, fallback = "Författarkörningen kunde inte slutföras."): NextResponse {
  if (error instanceof SagaAdobeAuthoringAccessError) return sagaAdobeAuthoringResponse({ error: error.message, code: "forbidden" }, 403);
  if (error instanceof SagaAdobeAuthoringNotFoundError) return sagaAdobeAuthoringResponse({ error: error.message, code: "not_found" }, 404);
  if (error instanceof SagaAdobeAuthoringConflictError) return sagaAdobeAuthoringResponse({ error: error.message, code: "conflict" }, 409);
  if (error instanceof SagaAdobeAuthoringValidationError) return sagaAdobeAuthoringResponse({ error: error.message, code: "validation_failed" }, 422);
  return sagaAdobeAuthoringResponse({ error: fallback, code: "authoring_unavailable" }, 500);
}

export async function readSagaAdobeAuthoringJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The browser may describe a writing goal and select IDs. It must never pass
 * workspace/user authority, a reference/knowledge body, a URL, model choice,
 * schedule, publication/delivery instruction, or a separate author identity.
 */
export function containsSagaAdobeAuthoringForbiddenSelector(value: unknown, depth = 0): boolean {
  if (depth > 10 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaAdobeAuthoringForbiddenSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "authorName"
    || key === "author_name"
    || key === "reference"
    || key === "referenceBody"
    || key === "referenceTitle"
    || key === "knowledge"
    || key === "knowledgeEntries"
    || key === "body"
    || key === "content"
    || key === "canonicalUrl"
    || key === "url"
    || key === "sourceUrl"
    || key === "provider"
    || key === "model"
    || key === "apiKey"
    || key === "accessToken"
    || key === "providerToken"
    || key === "publish"
    || key === "publishAt"
    || key === "scheduledAt"
    || key === "scheduled_at"
    || key === "delivery"
    || key === "recipient"
    || key === "accountId"
    || key === "account_id"
    || containsSagaAdobeAuthoringForbiddenSelector(nested, depth + 1)
  ));
}
