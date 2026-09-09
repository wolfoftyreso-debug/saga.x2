import { NextRequest, NextResponse } from "next/server";
import { sagaBrandOnboardingAdviceRequestSchema } from "@/lib/domain/saga-brand-onboarding";
import { generateSagaBrandOnboardingAdvice } from "@/lib/services/saga-brand-onboarding-advice";
import {
  containsSagaBrandOnboardingForbiddenSelector,
  readSagaBrandOnboardingJson,
  requireSagaBrandOnboardingActor,
  sagaBrandOnboardingErrorResponse,
  sagaBrandOnboardingResponse,
} from "@/lib/services/saga-brand-onboarding-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A signed user may ask for an in-memory critique before saving. The adviser
 * has no database write, scheduling, advertising or publication capability.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaBrandOnboardingActor("Logga in för att använda AI-rådgivaren.");
  if (resolved.response) return resolved.response;
  const body = await readSagaBrandOnboardingJson(request);
  if (body === null || containsSagaBrandOnboardingForbiddenSelector(body)) return invalidRequest();
  const payload = sagaBrandOnboardingAdviceRequestSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    const advice = await generateSagaBrandOnboardingAdvice({ draft: payload.data.draft });
    return sagaBrandOnboardingResponse({ advice, saved: false });
  } catch (error) {
    return sagaBrandOnboardingErrorResponse(error, "AI-rådgivaren kunde inte granska planen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaBrandOnboardingResponse({
    error: "Skicka ett giltigt onboardingutkast utan arbetsyta, användare, profil-id, aktiveringsflagga eller leveransinstruktion.",
    code: "invalid_brand_onboarding_advice_request",
  }, 422);
}
