import { AppShell } from "@/components/app-shell";
import { SagaDraftPatternHandoff } from "@/components/saga-draft-pattern-handoff";

export const dynamic = "force-dynamic";

/** A dedicated, reference-first workbench for one existing Studio draft. */
export default async function StudioContentPatternPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><SagaDraftPatternHandoff draftId={id} /></AppShell>;
}
