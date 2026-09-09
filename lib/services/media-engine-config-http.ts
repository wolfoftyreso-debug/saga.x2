import "server-only";

import { NextResponse } from "next/server";
import { MediaEngineServiceError } from "@/lib/services/media-engine";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseServiceConfigured, missingSupabaseServiceConfiguration } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export type MediaEngineConfigRequestContext = {
  userId: string;
  database: ReturnType<typeof createAdminClient>;
};

/**
 * Configuration endpoints deliberately do not require OpenAI.  A team can
 * safely set up tenants, RSS and API connections before enabling the research
 * worker, and receives an honest setup error if Supabase itself is missing.
 */
export async function resolveMediaEngineConfigRequestContext(): Promise<
  | { ok: true; value: MediaEngineConfigRequestContext }
  | { ok: false; response: NextResponse }
> {
  if (!isSupabaseServiceConfigured()) {
    return {
      ok: false,
      response: noStore({
        error: "Researchmotorns arbetsyta är inte ansluten till Supabase ännu.",
        configuration: { ready: false, missing: missingSupabaseServiceConfiguration() },
      }, 503),
    };
  }
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) return { ok: false, response: noStore({ error: "Logga in för att hantera researchmotorn." }, 401) };
    return { ok: true, value: { userId, database: createAdminClient() } };
  } catch {
    return { ok: false, response: noStore({ error: "Inloggningen kunde inte verifieras just nu." }, 503) };
  }
}

export function mediaEngineConfigErrorResponse(error: unknown): NextResponse {
  if (error instanceof MediaEngineServiceError) {
    return noStore({ error: error.message, code: error.code }, error.status);
  }
  return noStore({ error: "Researchmotorns inställning kunde inte sparas." }, 500);
}

export function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
