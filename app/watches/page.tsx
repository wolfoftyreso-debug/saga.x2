import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SetupRequired } from "@/components/setup-required";
import { WatchList } from "@/components/watch-list";
import { getWatches } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function WatchesPage() {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const watches = await getWatches(await createServerSupabaseClient(), userId);
  return (
    <AppShell>
      <header className="page-header">
        <p className="eyebrow">PÅGÅENDE UPPDRAG</p>
        <h1>Bevakningar</h1>
        <p>Det här är frågor du uttryckligen har bett systemet att följa. De är inte samma sak som redaktionens korta bevakningslista.</p>
      </header>
      {watches.length ? <WatchList watches={watches} /> : (
        <section className="empty-state">
          <p className="eyebrow">INGA EGNA BEVAKNINGAR</p>
          <h2>Be systemet följa en fråga tills läget faktiskt förändras.</h2>
          <p>Skriv exempelvis “Följ detta tills lagen antas” på ett händelsekort i chatten.</p>
          <Link className="secondary-button link-button" href="/">Öppna chatten</Link>
        </section>
      )}
    </AppShell>
  );
}
