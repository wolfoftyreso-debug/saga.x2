import { AppShell } from "@/components/app-shell";
import { SagaNewsWorkspace } from "@/components/saga-news-workspace";

export const dynamic = "force-dynamic";

export default function StudioResearchPage() {
  return <AppShell><SagaNewsWorkspace /></AppShell>;
}
