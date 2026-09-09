import { AppShell } from "@/components/app-shell";
import { ProfileContextForm } from "@/components/profile-context-form";
import { SetupRequired } from "@/components/setup-required";
import { getProfileContext } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const context = await getProfileContext(await createServerSupabaseClient(), userId);
  return (
    <AppShell>
      <header className="page-header onboarding-header">
        <p className="eyebrow">KOM IGÅNG</p>
        <h1>Vad ska jag hålla koll på åt dig?</h1>
        <p>Börja enkelt. Du kan när som helst fördjupa, blockera källor eller skapa en precis bevakning i chatten.</p>
      </header>
      <ProfileContextForm initialContext={context} onboarding />
    </AppShell>
  );
}
