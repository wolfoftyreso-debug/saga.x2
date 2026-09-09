import { AppShell } from "@/components/app-shell";
import { SagaEditorialLensWorkspace } from "@/components/saga-editorial-lens-workspace";
import Link from "next/link";
import { getCurrentActor } from "@/lib/neon/auth-repository";
import { readSagaBrandEntryState, type SagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";

export const dynamic = "force-dynamic";

export default async function SagaEditorialLensPage({ searchParams }: { searchParams: Promise<{ brandProfileId?: string }> }) {
  let entry: SagaBrandEntryState = { status: "unavailable" };
  try {
    const actor = await getCurrentActor();
    if (actor) entry = await readSagaBrandEntryState(actor, (await searchParams).brandProfileId);
  } catch { /* The recovery view keeps the editor closed on unavailable data. */ }
  return <AppShell>{entry.status === "completed"
    ? <SagaEditorialLensWorkspace key={entry.brandProfileId} brandProfileId={entry.brandProfileId} />
    : <section className="page-section"><h1>Redaktionell riktning</h1>
      <p>{entry.status === "selection_required" ? "Välj vilket varumärke riktningen gäller." : entry.status === "missing" ? "Slutför ett varumärke innan du utformar riktningen." : "Varumärkena kunde inte läsas. Försök igen när anslutningen fungerar."}</p>
      {entry.status === "selection_required" && <ul>{entry.brands.map((brand) => <li key={brand.brandProfileId}><Link href={`/studio/lens?brandProfileId=${encodeURIComponent(brand.brandProfileId)}`}>{brand.brandName}</Link></li>)}</ul>}
      <Link href={entry.status === "missing" ? "/studio/brands/new" : "/studio"}>{entry.status === "missing" ? "Skapa varumärke" : "Till Studio"}</Link>
    </section>}</AppShell>;
}
