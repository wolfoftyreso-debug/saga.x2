import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SourceCatalog } from "@/components/source-catalog";
import { SetupRequired } from "@/components/setup-required";
import { getBriefDefinitions, getBriefSourcePolicyOverrides, getEffectiveSourcePolicyViews } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function BriefSourcesPage({ params }: { params: Promise<{ definitionId: string }> }) {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const { definitionId } = await params;
  const supabase = await createServerSupabaseClient();
  const definitions = await getBriefDefinitions(supabase, userId);
  const definition = definitions.find((item) => item.id === definitionId);
  if (!definition) notFound();
  const [sources, overrides] = await Promise.all([
    getEffectiveSourcePolicyViews(supabase, userId, definitionId),
    getBriefSourcePolicyOverrides(supabase, userId, definitionId),
  ]);

  return (
    <AppShell>
      <Link className="back-link" href="/briefs">‹ Briefar</Link>
      <header className="page-header">
        <p className="eyebrow">BRIEFSPECIFIKA KÄLLOR</p>
        <h1>{definition.name}</h1>
        <p>Den här briefen ärver din globala källpolicy. Här kan du göra avsiktliga undantag utan att påverka övriga briefar.</p>
      </header>
      <SourceCatalog initialSources={sources} briefDefinitionId={definition.id} definitionName={definition.name} overrideDomains={overrides.map((override) => override.domain)} />
    </AppShell>
  );
}
