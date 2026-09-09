import { AppShell } from "@/components/app-shell";
import { SagaOutgoingApiPanel } from "@/components/saga-outgoing-api-panel";
import { getCurrentActor, type AppActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";

export const dynamic = "force-dynamic";

/**
 * A dedicated settings surface keeps external read access separate from
 * channels and publishing. The API itself remains server/owner scoped.
 */
export default async function OutgoingApiSettingsPage() {
  let actor: AppActor | null = null;
  if (isNeonDatabaseConfigured()) {
    try {
      actor = await getCurrentActor();
    } catch {
      // The panel renders an honest unavailable state without surfacing
      // provisioning details or attempting a client-side fallback.
      actor = null;
    }
  }

  return <AppShell>
    <SagaOutgoingApiPanel workspaceReady={Boolean(actor)} canManage={actor?.role === "owner"} />
  </AppShell>;
}
