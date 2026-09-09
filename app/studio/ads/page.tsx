import { AppShell } from "@/components/app-shell";
import { SagaAdCreativeStudio } from "@/components/saga-ad-creative-studio";

export const dynamic = "force-dynamic";

/** Private format production is separate from the draft-only ad scheduler. */
export default function StudioAdsPage() {
  return <AppShell><SagaAdCreativeStudio /></AppShell>;
}
