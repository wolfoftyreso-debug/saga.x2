import { NextRequest, NextResponse } from "next/server";
import { profileContextSchema } from "@/lib/domain/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export async function PUT(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra din profil." }, { status: 401 });
  const payload = profileContextSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Profilen innehåller ett ogiltigt värde." }, { status: 400 });
  const value = payload.data;
  const { error } = await createAdminClient().from("profile_context").upsert({
    user_id: userId,
    work_summary: value.workSummary,
    role_title: value.roleTitle,
    organizations: value.organizations,
    sectors: value.sectors,
    markets: value.markets,
    dependencies: value.dependencies,
    decisions: value.decisions,
    risks: value.risks,
    opportunities: value.opportunities,
    interests: value.interests,
    exclusions: value.exclusions,
    languages: value.languages,
    onboarding_complete: value.onboardingComplete,
  }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
