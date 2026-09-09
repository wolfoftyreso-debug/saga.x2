import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaPersonaContextAccessError,
  SagaPersonaContextConflictError,
  SagaPersonaContextValidationError,
} from "@/lib/neon/saga-persona-context-repository";

export const sagaPersonaContextNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

export function sagaPersonaContextResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaPersonaContextNoStoreHeaders });
}

/** The signed HttpOnly session is the only source of workspace and user scope. */
export async function requireSagaPersonaContextActor(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("Privat personakontext behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

export function sagaPersonaContextErrorResponse(
  error: unknown,
  fallback = "Den privata personakontexten kunde inte slutföras.",
): NextResponse {
  if (error instanceof SagaPersonaContextAccessError) {
    return sagaPersonaContextResponse({ error: error.message, code: "forbidden" }, 403);
  }
  if (error instanceof SagaPersonaContextConflictError) {
    return sagaPersonaContextResponse({ error: error.message, code: "conflict" }, 409);
  }
  if (error instanceof SagaPersonaContextValidationError) {
    return sagaPersonaContextResponse({ error: error.message, code: "validation_failed" }, 422);
  }
  // Do not serialize unknown database, URL or payload errors: they may contain
  // an owner-supplied website or self-description.
  return sagaPersonaContextResponse({ error: fallback, code: "persona_unavailable" }, 500);
}

export async function readSagaPersonaContextJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Reject nested selectors before schema parsing; personal data is owner-scoped only. */
export function containsSagaPersonaScopeSelector(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaPersonaScopeSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "ownerUserId"
    || key === "owner_user_id"
    || containsSagaPersonaScopeSelector(nested, depth + 1)
  ));
}
