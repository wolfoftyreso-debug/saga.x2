import { AppShell } from "@/components/app-shell";
import { SagaBrandOnboarding } from "@/components/saga-brand-onboarding";

export const dynamic = "force-dynamic";

/**
 * A brand cannot be created through a side-panel shortcut. This route is the
 * single entry point for the full, reviewable onboarding and annual plan.
 */
export default function NewBrandOnboardingPage() {
  return <AppShell><SagaBrandOnboarding /></AppShell>;
}
