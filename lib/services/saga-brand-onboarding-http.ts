import "server-only";

import { NextResponse } from "next/server";
import { neonConfigurationResponse, requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  SagaBrandOnboardingAccessError,
  SagaBrandOnboardingConflictError,
  SagaBrandOnboardingNotFoundError,
  SagaBrandOnboardingValidationError,
} from "@/lib/neon/saga-brand-onboarding-repository";
import { SagaBrandOnboardingAdviceError } from "@/lib/services/saga-brand-onboarding-advice";

export const sagaBrandOnboardingNoStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function sagaBrandOnboardingResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sagaBrandOnboardingNoStoreHeaders });
}

export async function requireSagaBrandOnboardingActor(message: string): Promise<NeonActorResolution> {
  const configuration = neonConfigurationResponse("Varumärkes-onboardingen behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}

export function sagaBrandOnboardingErrorResponse(error: unknown, fallback = "Varumärkes-onboardingen kunde inte slutföras."): NextResponse {
  if (error instanceof SagaBrandOnboardingAccessError) return sagaBrandOnboardingResponse({ error: error.message, code: "forbidden" }, 403);
  if (error instanceof SagaBrandOnboardingNotFoundError) return sagaBrandOnboardingResponse({ error: error.message, code: "not_found" }, 404);
  if (error instanceof SagaBrandOnboardingConflictError) return sagaBrandOnboardingResponse({ error: error.message, code: "conflict" }, 409);
  if (error instanceof SagaBrandOnboardingValidationError) return sagaBrandOnboardingResponse({ error: error.message, code: "validation_failed" }, 422);
  if (error instanceof SagaBrandOnboardingAdviceError) {
    return sagaBrandOnboardingResponse({
      error: error.message,
      code: error.code,
      ...(error.code === "ai_gateway_not_configured" ? { missing: ["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN"] } : {}),
    }, error.status);
  }
  return sagaBrandOnboardingResponse({ error: fallback, code: "brand_onboarding_unavailable" }, 500);
}

export async function readSagaBrandOnboardingJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Browser data never controls the actor, workspace, canonical profile ID or a delivery boundary. */
export function containsSagaBrandOnboardingForbiddenSelector(value: unknown, depth = 0): boolean {
  if (depth > 10 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsSagaBrandOnboardingForbiddenSelector(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId"
    || key === "workspace_id"
    || key === "userId"
    || key === "user_id"
    || key === "brandProfileId"
    || key === "brand_profile_id"
    || key === "brandId"
    || key === "brand_id"
    || key === "active"
    || key === "isDefault"
    || key === "is_default"
    || key === "publish"
    || key === "publishAt"
    || key === "delivery"
    || key === "accountId"
    || key === "account_id"
    || key === "accessToken"
    || key === "providerToken"
    || containsSagaBrandOnboardingForbiddenSelector(nested, depth + 1)
  ));
}
