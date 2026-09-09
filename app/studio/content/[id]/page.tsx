import { AppShell } from "@/components/app-shell";
import { ContentStudio } from "@/components/content-studio";
import { SagaDraftPatternHandoffLink } from "@/components/saga-draft-pattern-handoff-link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StudioContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string; template?: string; date?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  // `/studio/create` is the canonical intake surface. Keep the older editor
  // only when a legacy caller passes a template or a calendar date that the
  // new intake does not yet model, rather than silently dropping its intent.
  if (id === "new" && !query.template && !query.date) redirect("/studio/create");
  return <AppShell>
    <ContentStudio route="content" contentId={id} edit={query.edit === "1" || query.edit === "true"} templateId={query.template} scheduleDate={query.date} />
    <SagaDraftPatternHandoffLink draftId={id} />
  </AppShell>;
}
