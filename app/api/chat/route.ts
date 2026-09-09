import { NextRequest, NextResponse } from "next/server";
import { chatInputSchema } from "@/lib/domain/workspace";
import { processChatTurn, ChatServiceError } from "@/lib/services/chat-service";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att använda chatten." }, { status: 401 });

  const payload = chatInputSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Meddelandet är inte giltigt." }, { status: 400 });

  try {
    const result = await processChatTurn({
      database: createAdminClient(),
      userId,
      ...payload.data,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ChatServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chatten kunde inte behandla meddelandet." }, { status: 500 });
  }
}
