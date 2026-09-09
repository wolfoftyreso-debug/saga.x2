import { NextRequest, NextResponse } from "next/server";
import { sourcePolicyInputSchema } from "@/lib/domain/workspace";
import { normalizeSourceDomain } from "@/lib/domain/source-catalog";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export async function PUT(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra en källregel." }, { status: 401 });
  const payload = sourcePolicyInputSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Källregeln innehåller ett ogiltigt värde." }, { status: 400 });
  const domain = normalizeSourceDomain(payload.data.domain);
  if (!domain) return NextResponse.json({ error: "Ange en giltig domän." }, { status: 400 });
  const { error } = await createAdminClient().from("user_source_policies").upsert({
    user_id: userId,
    domain,
    source_name: payload.data.sourceName,
    source_kind: payload.data.sourceKind,
    active: payload.data.active,
    blocked: payload.data.blocked,
    priority: payload.data.priority,
    roles: payload.data.roles,
    topic_filter: payload.data.topicFilter,
    verification_requirement: payload.data.verificationRequirement,
    frequency: payload.data.frequency,
  }, { onConflict: "user_id,domain" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
