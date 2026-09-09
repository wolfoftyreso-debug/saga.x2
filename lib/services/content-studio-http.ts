import "server-only";

import { NextResponse } from "next/server";
import {
  isSupabasePublicConfigured,
  isSupabaseServiceConfigured,
  missingSupabasePublicConfiguration,
  missingSupabaseServiceConfiguration,
} from "@/lib/supabase/config";

/**
 * Content Studio makes several parallel requests on first load.  Keep a
 * missing workspace connection explicit for every durable endpoint instead
 * of letting the first Supabase client construction turn into a generic 500.
 */
export function contentStudioServiceConfigurationResponse(): NextResponse | null {
  if (isSupabaseServiceConfigured()) return null;
  return configurationResponse(
    "Studio kan inte läsa eller spara innehåll förrän arbetsytans datalager är anslutet.",
    missingSupabaseServiceConfiguration(),
  );
}

/** The delivery-status endpoint only needs the authenticated public client. */
export function contentStudioPublicConfigurationResponse(): NextResponse | null {
  if (isSupabasePublicConfigured()) return null;
  return configurationResponse(
    "Studio kan inte kontrollera nyhetsbrevsstatus förrän inloggningen är ansluten.",
    missingSupabasePublicConfiguration(),
  );
}

function configurationResponse(error: string, missing: string[]): NextResponse {
  return NextResponse.json(
    { code: "configuration_required", error, missing },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
