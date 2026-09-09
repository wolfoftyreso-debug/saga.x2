import { AppShell } from "@/components/app-shell";
import { SagaAuthoringWorkspace, type SagaAuthoringBrandContext } from "@/components/saga-authoring-workspace";
import { getCurrentActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { readSagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";

export const dynamic = "force-dynamic";

/** The default creation route keeps a one-off draft and a durable series separate. */
export default async function StudioCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ brandProfileId?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestedBrandProfileId = typeof query.brandProfileId === "string" ? query.brandProfileId : null;
  const brandContext = await authoringBrandContext(requestedBrandProfileId);
  return <AppShell><SagaAuthoringWorkspace key={brandContext.status === "completed" ? brandContext.brandProfileId : brandContext.status} brandContext={brandContext} /></AppShell>;
}

/**
 * Keep the authoring page closed until the server can verify its brand basis.
 * This route is dynamic, so a completed onboarding is visible on the next
 * navigation or refresh without trusting browser state.
 */
async function authoringBrandContext(requestedBrandProfileId: string | null): Promise<SagaAuthoringBrandContext> {
  if (!isNeonDatabaseConfigured()) return { status: "unavailable" };

  try {
    const actor = await getCurrentActor();
    if (!actor) return { status: "unavailable" };
    return readSagaBrandEntryState(actor, requestedBrandProfileId);
  } catch {
    return { status: "unavailable" };
  }
}
