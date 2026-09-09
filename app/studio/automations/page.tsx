import { AppShell } from "@/components/app-shell";
import Link from "next/link";
import { SagaAdAutomationBuilder } from "@/components/saga-ad-automation-builder";
import { SagaContentAutomationRuns } from "@/components/saga-content-automation-runs";
import { ContentStudio } from "@/components/content-studio";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

type StudioAutomationsPageProps = {
  searchParams: Promise<{ view?: string | string[] }>;
};

/**
 * Content receipts and ad briefs have deliberately separate surfaces. A
 * content run can only create a private draft; the ad builder has its own
 * deterministic, non-delivery scheduler.
 */
export default async function StudioAutomationsPage({ searchParams }: StudioAutomationsPageProps) {
  const params = await searchParams;
  const requestedView = Array.isArray(params.view) ? params.view[0] : params.view;
  const view = requestedView === "ads" || requestedView === "build-content" ? requestedView : "content";

  return <AppShell>
    <nav className={styles.surfaceNav} aria-label="Välj automationsyta">
      <Link className={view === "content" ? styles.active : undefined} aria-current={view === "content" ? "page" : undefined} href="/studio/automations">Innehållskörningar</Link>
      <Link className={view === "build-content" ? styles.active : undefined} aria-current={view === "build-content" ? "page" : undefined} href="/studio/automations?view=build-content">Bygg innehållsflöde</Link>
      <Link className={view === "ads" ? styles.active : undefined} aria-current={view === "ads" ? "page" : undefined} href="/studio/automations?view=ads">Annonsflöden</Link>
      <Link href="/studio/ads">Annonsstudio</Link>
    </nav>
    {view === "content" ? <SagaContentAutomationRuns /> : null}
    {view === "build-content" ? <ContentStudio route="automations" /> : null}
    {view === "ads" ? <SagaAdAutomationBuilder /> : null}
  </AppShell>;
}
