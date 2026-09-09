import { AppShell } from "@/components/app-shell";
import { StudioControlCenter, type StudioControlCenterState } from "@/components/studio-control-center";
import { getCurrentActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { readSagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";
import { readStudioBootstrap } from "@/lib/neon/studio-repository";

export const dynamic = "force-dynamic";

/**
 * This page is intentionally a server-rendered control surface. The page
 * reads one workspace-scoped, aggregate snapshot so its first render never
 * resembles an editor with placeholder cards or a local-only demo.
 */
export default async function StudioPage() {
  const state = await studioControlCenterState();
  return <AppShell><StudioControlCenter state={state} /></AppShell>;
}

async function studioControlCenterState(): Promise<StudioControlCenterState> {
  if (!isNeonDatabaseConfigured()) return { mode: "database_unconfigured" };

  let actor;
  try {
    actor = await getCurrentActor();
  } catch {
    return { mode: "workspace_unavailable" };
  }
  if (!actor) return { mode: "session_required" };

  try {
    const snapshot = await readStudioBootstrap({ trustedWorkspaceId: actor.workspaceId });
    if (snapshot.status === "ready") {
      return {
        mode: "ready",
        actor: { displayName: actor.displayName, role: actor.role },
        checkedAt: snapshot.checkedAt,
        workspace: snapshot.workspace,
        counts: snapshot.counts,
        brandEntry: await readSagaBrandEntryState(actor),
      };
    }
    if (snapshot.status === "workspace_not_found") return { mode: "workspace_missing" };
    return { mode: "workspace_unavailable" };
  } catch {
    // Do not turn a transient read error into an empty dashboard. The
    // component explains the boundary and offers only an honest next action.
    return { mode: "workspace_unavailable" };
  }
}
