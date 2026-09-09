import { AppShell } from "@/components/app-shell";
import { SagaSeriesWorkspace } from "@/components/saga-series-workspace";

export const dynamic = "force-dynamic";

/** A saved Studio draft is deliberately required before a content series exists. */
export default function StudioSeriesPage() {
  return <AppShell><SagaSeriesWorkspace /></AppShell>;
}
