import { NextResponse } from "next/server";
import { BriefRunError, runDailyBrief } from "@/lib/services/brief-runner";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const maxDuration = 300;

export async function POST() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att köra en brief." }, { status: 401 });

  try {
    const result = await runDailyBrief({ userId, triggeredBy: "manual" });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunde inte köra briefen.", runId: error instanceof BriefRunError ? error.runId : undefined },
      { status: 500 },
    );
  }
}
