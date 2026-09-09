import { NextRequest, NextResponse } from "next/server";
import { briefSourcePolicyDeleteSchema, briefSourcePolicyInputSchema } from "@/lib/domain/workspace";
import { normalizeSourceDomain } from "@/lib/domain/source-catalog";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export async function PUT(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra briefens källregler." }, { status: 401 });
  const payload = briefSourcePolicyInputSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Källregeln innehåller ett ogiltigt värde." }, { status: 400 });
  const domain = normalizeSourceDomain(payload.data.domain);
  if (!domain) return NextResponse.json({ error: "Ange en giltig domän." }, { status: 400 });
  const database = createAdminClient();
  const allowed = await userOwnsDefinitionAndSource(database, userId, payload.data.briefDefinitionId, domain);
  if (!allowed) return NextResponse.json({ error: "Briefen eller källan hittades inte i din profil." }, { status: 404 });
  const { error } = await database.from("brief_source_policies").upsert({
    user_id: userId,
    brief_definition_id: payload.data.briefDefinitionId,
    domain,
    active: payload.data.active,
    blocked: payload.data.blocked,
    priority: payload.data.priority,
    roles: payload.data.roles,
    topic_filter: payload.data.topicFilter,
    verification_requirement: payload.data.verificationRequirement,
    frequency: payload.data.frequency,
  }, { onConflict: "brief_definition_id,domain" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att återställa briefens källregel." }, { status: 401 });
  const payload = briefSourcePolicyDeleteSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Källregeln innehåller ett ogiltigt värde." }, { status: 400 });
  const domain = normalizeSourceDomain(payload.data.domain);
  if (!domain) return NextResponse.json({ error: "Ange en giltig domän." }, { status: 400 });
  const database = createAdminClient();
  const { data: definition, error: definitionError } = await database
    .from("brief_definitions")
    .select("id")
    .eq("id", payload.data.briefDefinitionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (definitionError || !definition) return NextResponse.json({ error: "Briefen hittades inte." }, { status: 404 });
  const { error } = await database
    .from("brief_source_policies")
    .delete()
    .eq("user_id", userId)
    .eq("brief_definition_id", payload.data.briefDefinitionId)
    .eq("domain", domain);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function userOwnsDefinitionAndSource(database: ReturnType<typeof createAdminClient>, userId: string, definitionId: string, domain: string): Promise<boolean> {
  const [{ data: definition, error: definitionError }, { data: catalog, error: catalogError }, { data: ownPolicy, error: policyError }] = await Promise.all([
    database.from("brief_definitions").select("id").eq("id", definitionId).eq("user_id", userId).maybeSingle(),
    database.from("source_catalog").select("id").eq("domain", domain).maybeSingle(),
    database.from("user_source_policies").select("id").eq("user_id", userId).eq("domain", domain).maybeSingle(),
  ]);
  if (definitionError || catalogError || policyError) return false;
  return Boolean(definition && (catalog || ownPolicy));
}
