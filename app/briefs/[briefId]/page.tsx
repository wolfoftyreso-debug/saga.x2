import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BriefItemCard } from "@/components/brief-item-card";
import { BriefWorldPulse } from "@/components/brief-world-pulse";
import { SetupRequired } from "@/components/setup-required";
import { StrategicRadarPanel } from "@/components/strategic-radar-panel";
import { WeeklyRecapPanel } from "@/components/weekly-recap-panel";
import { getBrief } from "@/lib/services/brief-reader";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { formatSwedishDate } from "@/lib/utils/date";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BriefDetailPage({ params }: { params: Promise<{ briefId: string }> }) {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const { briefId } = await params;
  const brief = await getBrief(await createServerSupabaseClient(), briefId);
  if (!brief) notFound();

  return (
    <AppShell>
      <Link href="/briefs" className="back-link">‹ Briefar</Link>
      <header className="page-header brief-detail-header">
        <p className="eyebrow">{formatSwedishDate(brief.briefDate)}</p>
        <h1>{brief.noMaterialChanges ? "Lugn dag" : "Dagens beslutssignaler"}</h1>
        <p>{brief.assessment}</p>
      </header>
      {(brief.worldPulse || brief.marketSnapshot) && <BriefWorldPulse pulse={brief.worldPulse} marketSnapshot={brief.marketSnapshot} id={`brief-${brief.id}-world-pulse`} />}
      {brief.items.map((item) => <BriefItemCard key={item.id} item={item} />)}
      {brief.weeklyRecap && <WeeklyRecapPanel recap={brief.weeklyRecap} id={`brief-${brief.id}-weekly-recap`} />}
      {brief.strategicRadar && <StrategicRadarPanel radar={brief.strategicRadar} id={`brief-${brief.id}-strategic-radar`} />}
      <Link className="secondary-button link-button brief-chat-link" href="/">Fortsätt resonera i chatten</Link>
    </AppShell>
  );
}
