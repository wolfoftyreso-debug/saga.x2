import { NextRequest, NextResponse } from "next/server";
import {
  SAGA_BRAND_ONBOARDING_CALCULATION_VERSION,
  sagaBrandOnboardingCreateSchema,
} from "@/lib/domain/saga-brand-onboarding";
import {
  createSagaBrandOnboarding,
  listSagaBrandOnboardingOverviews,
} from "@/lib/neon/saga-brand-onboarding-repository";
import {
  containsSagaBrandOnboardingForbiddenSelector,
  readSagaBrandOnboardingJson,
  requireSagaBrandOnboardingActor,
  sagaBrandOnboardingErrorResponse,
  sagaBrandOnboardingResponse,
} from "@/lib/services/saga-brand-onboarding-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A small selector/control-room view; full plans use the opaque profile route. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaBrandOnboardingActor("Logga in för att öppna varumärkes-onboardingen.");
  if (resolved.response) return resolved.response;
  try {
    return sagaBrandOnboardingResponse({
      onboardings: await listSagaBrandOnboardingOverviews(resolved.actor),
      calculationVersion: SAGA_BRAND_ONBOARDING_CALCULATION_VERSION,
    });
  } catch (error) {
    return sagaBrandOnboardingErrorResponse(error, "Kunde inte läsa varumärkes-onboardingarna.");
  }
}

/**
 * The only browser boundary that creates a canonical Content Engine brand.
 * It writes identity, annual plan, budget scenario and revision together.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaBrandOnboardingActor("Logga in för att skapa ett varumärke i onboarding.");
  if (resolved.response) return resolved.response;
  const body = await readSagaBrandOnboardingJson(request);
  if (body === null || containsSagaBrandOnboardingForbiddenSelector(body)) return invalidRequest();
  const payload = sagaBrandOnboardingCreateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    const created = await createSagaBrandOnboarding(resolved.actor, payload.data);
    return sagaBrandOnboardingResponse({ onboarding: created.onboarding, reused: created.reused }, created.reused ? 200 : 201);
  } catch (error) {
    return sagaBrandOnboardingErrorResponse(error, "Kunde inte skapa varumärket och årsplanen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaBrandOnboardingResponse({
    error: "Skicka ett fullständigt, giltigt onboardingunderlag utan arbetsyta, användare, profil-id, aktiveringsflagga eller leveransinstruktion.",
    code: "invalid_brand_onboarding_request",
  }, 422);
}
