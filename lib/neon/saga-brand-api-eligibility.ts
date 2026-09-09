import "server-only";

import type { AppActor } from "@/lib/neon/auth-repository";
import { listSagaBrandOnboardingOverviews } from "@/lib/neon/saga-brand-onboarding-repository";
import type { NeonSql } from "@/lib/neon/database";

/**
 * A workspace-scoped API that has not yet gained an explicit brand selector
 * must not silently pick one brand when several active, completed brands are
 * present. The signed actor remains the only scope input; callers never send
 * a workspace or brand id to this boundary.
 */
export type SagaBrandApiEligibility =
  | { status: "zero"; brands: [] }
  | { status: "single"; brands: [SagaBrandApiBrand] }
  | { status: "multiple"; brands: [SagaBrandApiBrand, SagaBrandApiBrand, ...SagaBrandApiBrand[]] };

export type SagaBrandApiBrand = {
  brandProfileId: string;
  brandName: string;
};

/**
 * Resolves only active, completed brands owned by the current signed actor's
 * workspace. A failed repository read intentionally propagates: callers must
 * fail closed rather than treating an unknown workspace as brand-free.
 */
export async function readSagaBrandApiEligibility(actor: AppActor): Promise<SagaBrandApiEligibility> {
  const brands = (await listSagaBrandOnboardingOverviews(actor))
    .filter((onboarding) => onboarding.completionState === "completed" && onboarding.brandActive)
    .map((onboarding) => ({
      brandProfileId: onboarding.brandProfileId,
      brandName: onboarding.brandName,
    }));

  if (brands.length === 0) return { status: "zero", brands: [] };
  if (brands.length === 1) return { status: "single", brands: [brands[0]!] };
  return { status: "multiple", brands: [brands[0]!, brands[1]!, ...brands.slice(2)] };
}

/** The stable machine code used by legacy workspace-scoped routes. */
export const sagaBrandSelectionRequiredBody = {
  error: "Välj varumärke innan den här arbetsytans gemensamma AI- och kunskapsinställning används.",
  code: "brand_selection_required",
} as const;

export class SagaBrandScopeError extends Error {
  constructor(
    public readonly code: "brand_selection_required" | "brand_onboarding_required" | "brand_not_found",
    message: string,
    public readonly status = code === "brand_not_found" ? 404 : 409,
  ) {
    super(message);
    this.name = "SagaBrandScopeError";
  }
}

/** Resolve a selection inside the signed tenant; an explicit invalid selection never falls back. */
export async function resolveSagaBrandActor(
  actor: AppActor,
  requestedBrandProfileId?: string | null,
  sql?: NeonSql,
): Promise<AppActor & { brandProfileId: string }> {
  const brands = (await listSagaBrandOnboardingOverviews(actor, sql))
    .filter((entry) => entry.completionState === "completed" && entry.brandActive);
  const requested = requestedBrandProfileId?.trim() || actor.brandProfileId || null;
  if (requested) {
    const matched = brands.find((entry) => entry.brandProfileId === requested);
    if (!matched) throw new SagaBrandScopeError("brand_not_found", "Varumärket är inte aktivt och färdigställt i den här arbetsytan.");
    return { ...actor, brandProfileId: matched.brandProfileId };
  }
  if (!brands.length) throw new SagaBrandScopeError("brand_onboarding_required", "Slutför ett varumärkes onboarding innan du skapar innehåll.");
  if (brands.length !== 1) throw new SagaBrandScopeError("brand_selection_required", "Välj vilket varumärke innehållet tillhör.");
  return { ...actor, brandProfileId: brands[0]!.brandProfileId };
}
