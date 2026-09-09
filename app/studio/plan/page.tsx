import { AppShell } from "@/components/app-shell";
import { SagaQuarterlyPlan } from "@/components/saga-quarterly-plan";

export const dynamic = "force-dynamic";

/**
 * The activity plan owns the decision about scope and editorial rhythm. It is
 * deliberately separate from the calendar: planning a slot does not create a
 * draft, schedule a publication, or start an automation.
 */
export default function StudioPlanPage() {
  return <AppShell><SagaQuarterlyPlan /></AppShell>;
}
