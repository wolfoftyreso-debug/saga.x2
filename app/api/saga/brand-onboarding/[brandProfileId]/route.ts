import { NextRequest, NextResponse } from "next/server";
import { sagaBrandOnboardingUpdateSchema } from "@/lib/domain/saga-brand-onboarding";
import {
  getSagaBrandOnboarding,
  updateSagaBrandOnboarding,
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

type Context = { params: Promise<{ brandProfileId: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaBrandOnboardingActor("Logga in för att öppna den här varumärkes-onboardingen.");
  if (resolved.response) return resolved.response;
  try {
    const onboarding = await getSagaBrandOnboarding(resolved.actor, (await context.params).brandProfileId);
    if (!onboarding) return sagaBrandOnboardingResponse({ error: "Varumärkes-onboardingen hittades inte i den här arbetsytan.", code: "not_found" }, 404);
    return sagaBrandOnboardingResponse({ onboarding });
  } catch (error) {
    return sagaBrandOnboardingErrorResponse(error, "Kunde inte läsa varumärkes-onboardingen.");
  }
}

/** Full revisioned replacement; a stale tab can never blend two annual plans. */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaBrandOnboardingActor("Logga in för att ändra varumärkes-onboardingen.");
  if (resolved.response) return resolved.response;
  const body = await readSagaBrandOnboardingJson(request);
  if (body === null || containsSagaBrandOnboardingForbiddenSelector(body)) return invalidRequest();
  const payload = sagaBrandOnboardingUpdateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    return sagaBrandOnboardingResponse({
      onboarding: await updateSagaBrandOnboarding(resolved.actor, (await context.params).brandProfileId, payload.data),
    });
  } catch (error) {
    return sagaBrandOnboardingErrorResponse(error, "Kunde inte uppdatera varumärkes-onboardingen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaBrandOnboardingResponse({
    error: "Ändringen behöver aktuell revision och ett komplett, giltigt onboardingunderlag utan profil-id, arbetsyta, aktiveringsflagga eller leveransinstruktion.",
    code: "invalid_brand_onboarding_request",
  }, 422);
}
