import { NextRequest, NextResponse } from "next/server";
import { watchInputSchema, watchMutationSchema } from "@/lib/domain/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";
import { userCanAccessEvent } from "@/lib/services/workspace";

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en bevakning." }, { status: 401 });
  const payload = watchInputSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Bevakningen innehåller ett ogiltigt värde." }, { status: 400 });
  const database = createAdminClient();
  if (payload.data.eventId && !(await userCanAccessEvent(database, userId, payload.data.eventId))) {
    return NextResponse.json({ error: "Händelsen finns inte i din brief eller dina bevakningar." }, { status: 404 });
  }
  const { error } = await database.from("watches").insert({
    user_id: userId,
    event_id: payload.data.eventId ?? null,
    kind: payload.data.kind,
    title: payload.data.title,
    query_text: payload.data.queryText ?? null,
    rationale: payload.data.rationale,
    trigger_statuses: payload.data.triggerStatuses,
    only_material_change: payload.data.onlyMaterialChange,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra en bevakning." }, { status: 401 });
  const payload = watchMutationSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Bevakningen innehåller ett ogiltigt värde." }, { status: 400 });
  const database = createAdminClient();
  if (payload.data.action === "delete") {
    const { error } = await database.from("watches").delete().eq("id", payload.data.id).eq("user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await database
      .from("watches")
      .update({ state: payload.data.action === "pause" ? "paused" : "active" })
      .eq("id", payload.data.id)
      .eq("user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
