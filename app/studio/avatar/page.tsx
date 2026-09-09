import { AppShell } from "@/components/app-shell";
import { SagaAvatarReferencesWorkspace } from "@/components/saga-avatar-references-workspace";
import { SagaPersonaContextPanel } from "@/components/saga-persona-context-panel";

export const dynamic = "force-dynamic";

/** Private reference images are managed in a dedicated, non-publishing surface. */
export default function StudioAvatarPage() {
  return <AppShell>
    <SagaAvatarReferencesWorkspace />
    <SagaPersonaContextPanel />
  </AppShell>;
}
