import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUserId, createServerSupabaseClient } from "@/lib/supabase/server";

const feedbackSchema = z.object({
  eventId: z.string().uuid(),
  briefItemId: z.string().uuid().nullable().optional(),
  type: z.enum(["important", "not_relevant", "more_like_this", "less_like_this"]),
  selected: z.boolean(),
});

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att lämna återkoppling." }, { status: 401 });

  const payload = feedbackSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Ogiltig återkoppling." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  if (payload.data.selected) {
    const { error } = await supabase.from("feedback").upsert(
      {
        user_id: userId,
        event_id: payload.data.eventId,
        brief_item_id: payload.data.briefItemId ?? null,
        type: payload.data.type,
      },
      { onConflict: "user_id,event_id,type" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from("feedback")
      .delete()
      .eq("user_id", userId)
      .eq("event_id", payload.data.eventId)
      .eq("type", payload.data.type);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
