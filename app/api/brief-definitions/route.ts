import { NextRequest, NextResponse } from "next/server";
import { briefDefinitionDeleteSchema, briefDefinitionInputSchema } from "@/lib/domain/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en brief." }, { status: 401 });
  const payload = briefDefinitionInputSchema.omit({ id: true }).safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Briefen innehåller ett ogiltigt värde." }, { status: 400 });
  if (payload.data.kind === "main") return NextResponse.json({ error: "Huvudbriefen skapas automatiskt och kan inte dupliceras." }, { status: 400 });
  const { data, error } = await createAdminClient().from("brief_definitions").insert(toRow(userId, payload.data)).select("id").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Kunde inte skapa briefen." }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

export async function PUT(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra en brief." }, { status: 401 });
  const payload = briefDefinitionInputSchema.safeParse(await request.json());
  if (!payload.success || !payload.data.id) return NextResponse.json({ error: "Briefen innehåller ett ogiltigt värde." }, { status: 400 });
  const { id, ...data } = payload.data;
  const database = createAdminClient();
  const { data: owned, error: ownershipError } = await database
    .from("brief_definitions")
    .select("id, is_primary")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownershipError || !owned) return NextResponse.json({ error: "Briefen hittades inte." }, { status: 404 });
  if (owned.is_primary && !data.active) return NextResponse.json({ error: "Huvudbriefen måste vara aktiv. Skapa eller pausa en separat brief i stället." }, { status: 400 });
  if (owned.is_primary && data.kind !== "main") return NextResponse.json({ error: "Huvudbriefen måste behålla typen Huvudbrief." }, { status: 400 });
  const { error } = await database.from("brief_definitions").update(toRow(userId, data)).eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort en brief." }, { status: 401 });
  const payload = briefDefinitionDeleteSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Briefen innehåller ett ogiltigt värde." }, { status: 400 });
  const database = createAdminClient();
  const { data: owned, error: ownershipError } = await database
    .from("brief_definitions")
    .select("id, is_primary")
    .eq("id", payload.data.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownershipError || !owned) return NextResponse.json({ error: "Briefen hittades inte." }, { status: 404 });
  if (owned.is_primary) return NextResponse.json({ error: "Huvudbriefen kan inte tas bort. Pausa eller redigera den i stället." }, { status: 400 });
  const { error } = await database.from("brief_definitions").delete().eq("id", owned.id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

function toRow(userId: string, value: Omit<ReturnType<typeof briefDefinitionInputSchema.parse>, "id">) {
  return {
    user_id: userId,
    name: value.name,
    kind: value.kind,
    instructions: value.instructions,
    cadence: value.cadence,
    local_time: value.localTime,
    weekday: value.cadence === "weekly" ? value.weekday ?? 0 : null,
    timezone: value.timezone,
    max_items: value.maxItems,
    brief_depth: value.briefDepth,
    relevance_threshold: value.relevanceThreshold,
    alert_threshold: value.alertThreshold,
    only_when_changed: value.onlyWhenChanged,
    active: value.active,
  };
}
