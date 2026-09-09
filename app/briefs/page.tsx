import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BriefDefinitionList } from "@/components/brief-definition-list";
import { SetupRequired } from "@/components/setup-required";
import { getHistory } from "@/lib/services/brief-reader";
import { getBriefDefinitions } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { formatSwedishDate } from "@/lib/utils/date";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const supabase = await createServerSupabaseClient();
  const [history, definitions] = await Promise.all([getHistory(supabase, userId), getBriefDefinitions(supabase, userId)]);
  return (
    <AppShell>
      <header className="page-header">
        <p className="eyebrow">LEVERERADE BRIEFS</p>
        <h1>Briefar</h1>
        <p>Briefar är organiserade uppdrag, inte ett ändlöst nyhetsflöde. En körning blir synlig först när urval och källor har klarat kontrollen.</p>
      </header>
      <BriefDefinitionList definitions={definitions} />
      <section className="brief-history-section">
        <p className="eyebrow">HISTORIK</p>
        {history.length ? (
          <ol className="history-list">
            {history.map((brief) => (
              <li key={brief.id}>
                <Link href={`/briefs/${brief.id}`} className="history-card">
                  <div>
                    <p className="eyebrow">{formatSwedishDate(brief.briefDate)} · {brief.definitionName.toLocaleUpperCase("sv-SE")}</p>
                    <h2>{brief.noMaterialChanges ? "Inget väsentligt förändrat" : `${brief.itemCount} relevant${brief.itemCount === 1 ? " förändring" : "a förändringar"}`}</h2>
                    <p>{brief.assessment}</p>
                  </div>
                  <span aria-hidden="true">›</span>
                </Link>
              </li>
            ))}
          </ol>
        ) : <section className="empty-state"><h2>Inga kompletta briefar ännu.</h2><p>Chatten säger till när första verifierade förändringen är klar för dig.</p></section>}
      </section>
    </AppShell>
  );
}
