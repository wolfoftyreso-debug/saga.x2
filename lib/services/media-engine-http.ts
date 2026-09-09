import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getMediaEngineConfiguration,
  getMediaEngineOverview,
  MediaEnginePipelineError,
  type MediaTenantView,
} from "@/lib/services/media-engine-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseServiceConfigured, missingSupabaseServiceConfiguration } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

const optionalTenantSchema = z.string().uuid().optional().nullable();

export type MediaEngineRequestContext = {
  userId: string;
  database: ReturnType<typeof createAdminClient>;
  tenant: MediaTenantView;
};

export async function resolveMediaEngineRequestContext(tenantId: unknown): Promise<
  | { ok: true; value: MediaEngineRequestContext }
  | { ok: false; response: NextResponse }
> {
  if (!isSupabaseServiceConfigured()) {
    return {
      ok: false,
      response: noStore({
        error: "Researchmotorn är inte ansluten till Supabase ännu.",
        configuration: { ready: false, missing: missingSupabaseServiceConfiguration() },
      }, 503),
    };
  }
  const parsedTenant = optionalTenantSchema.safeParse(tenantId);
  if (!parsedTenant.success) return { ok: false, response: noStore({ error: "tenantId måste vara en giltig UUID." }, 400) };
  let userId: string | null;
  try {
    userId = await getAuthenticatedUserId();
  } catch {
    return { ok: false, response: noStore({ error: "Inloggningen kunde inte verifieras just nu." }, 503) };
  }
  if (!userId) return { ok: false, response: noStore({ error: "Logga in för att använda researchmotorn." }, 401) };
  const database = createAdminClient();
  try {
    const overview = await getMediaEngineOverview({ database, userId, tenantId: parsedTenant.data ?? null });
    if (!overview.tenant) {
      const status = overview.configuration.missing.length ? 503 : 422;
      return {
        ok: false,
        response: noStore({
          error: overview.configuration.issues[0] ?? "Ingen researchtenant är vald.",
          configuration: overview.configuration,
          tenant: null,
        }, status),
      };
    }
    return { ok: true, value: { userId, database, tenant: overview.tenant } };
  } catch (error) {
    return { ok: false, response: mediaEngineErrorResponse(error) };
  }
}

export function mediaEngineErrorResponse(error: unknown): NextResponse {
  if (error instanceof MediaEnginePipelineError) {
    return noStore({ error: error.message, code: error.code, configuration: error.code === "configuration" ? getMediaEngineConfiguration() : undefined }, error.status);
  }
  return noStore({ error: "Researchmotorn kunde inte slutföra begäran." }, 500);
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
