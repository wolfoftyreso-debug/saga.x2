import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SetupRequired } from "@/components/setup-required";
import { SourceCatalog } from "@/components/source-catalog";
import { getSourcePolicies } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SourcesSettingsPage() {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const sources = await getSourcePolicies(await createServerSupabaseClient(), userId);
  return (
    <AppShell>
      <Link className="back-link" href="/settings">‹ Inställningar</Link>
      <header className="page-header">
        <p className="eyebrow">KÄLLOR OCH CREATORS</p>
        <h1>Din källpolicy</h1>
        <p>Olika källor har olika roller. En creator kan bidra med analys, men kan inte ensam verifiera en materiell händelse.</p>
      </header>
      <SourceCatalog initialSources={sources} />
    </AppShell>
  );
}
