import "server-only";

import type { AppActor } from "@/lib/neon/auth-repository";
import { listSagaBrandOnboardingOverviews } from "@/lib/neon/saga-brand-onboarding-repository";

/**
 * The authoring and planning entry points need one deliberately small answer:
 * is there an actor-owned brand that is both complete and active?  Do not turn
 * a failed read into "no brand"; callers must keep creation closed instead.
 */
export type SagaBrandEntryState =
  | { status: "completed"; brandProfileId: string; brandName: string }
  | { status: "selection_required"; brands: SagaBrandEntryChoice[] }
  | { status: "missing" }
  | { status: "unavailable" };

/** A deliberately small, serializable selection option for a verified brand. */
export type SagaBrandEntryChoice = {
  brandProfileId: string;
  brandName: string;
};

/**
 * Resolve authoring only from an active, completed onboarding owned by the
 * current actor's workspace.  A URL can request a profile, but it can never
 * widen access: the requested ID must be one of those verified options.
 *
 * When more than one eligible brand exists, leaving the choice implicit is a
 * data-integrity risk. Keep the surface closed until the person chooses the
 * brand that owns this draft, plan, and future series.
 */
export async function readSagaBrandEntryState(
  actor: AppActor,
  requestedBrandProfileId?: string | null,
): Promise<SagaBrandEntryState> {
  try {
    const eligible: SagaBrandEntryChoice[] = (await listSagaBrandOnboardingOverviews(actor))
      .filter((onboarding) => onboarding.completionState === "completed" && onboarding.brandActive)
      .map((onboarding) => ({
        brandProfileId: onboarding.brandProfileId,
        brandName: onboarding.brandName,
      }));

    if (!eligible.length) return { status: "missing" };

    const requestedId = requestedBrandProfileId?.trim() || null;
    if (requestedId) {
      const requested = eligible.filter((brand) => brand.brandProfileId === requestedId);
      if (requested.length === 1) {
        return {
          status: "completed",
          brandProfileId: requested[0]!.brandProfileId,
          brandName: requested[0]!.brandName,
        };
      }

      // Never discard an unverified URL choice and fall through to a brand the
      // person did not select. The selector is the safe recovery path.
      return { status: "selection_required", brands: eligible };
    }

    if (eligible.length === 1) {
      return {
        status: "completed",
        brandProfileId: eligible[0]!.brandProfileId,
        brandName: eligible[0]!.brandName,
      };
    }

    return { status: "selection_required", brands: eligible };
  } catch {
    // The caller must distinguish an unverified workspace from an empty one.
    // Returning "missing" here would invite a duplicate onboarding and open
    // authoring based on a guess.
    return { status: "unavailable" };
  }
}
