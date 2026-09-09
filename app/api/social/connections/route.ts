import { NextResponse } from "next/server";
import { SOCIAL_PROVIDER_VALUES, type SocialProviderAvailability } from "@/lib/domain/social";
import { requireNeonActor } from "@/lib/neon/http";
import { listNeonSocialConnections } from "@/lib/neon/social-connections-repository";
import { getSocialProviderAvailability } from "@/lib/services/social-config";
import { listSocialConnections } from "@/lib/services/social-connections";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MissingSupabaseConfigurationError,
  missingSupabaseServiceConfiguration,
} from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safe metadata only: encrypted credentials never leave server-side code. */
export async function GET() {
  // Once DATABASE_URL exists, Vercel/Neon is authoritative. Do not surface a
  // second, stale Supabase connection list during a partial deployment.
  if (usesNeonStore()) {
    const resolved = await requireNeonActor("Logga in för att se sociala kopplingar.");
    if (resolved.response) return resolved.response;
    try {
      const providers = providerPayload();
      const connections = await listNeonSocialConnections(resolved.actor);
      return NextResponse.json({
        connections,
        providers,
        publicationAvailable: false,
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Kunde inte läsa sociala kopplingar.",
      }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }
  const missingSupabase = missingSupabaseServiceConfiguration();
  if (missingSupabase.length) return configurationResponse(missingSupabase);

  let userId: string | null;
  try {
    userId = await getAuthenticatedUserId();
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) return configurationResponse(missingSupabaseServiceConfiguration());
    return NextResponse.json({ error: "Inloggningen kunde inte verifieras just nu. Försök igen senare." }, { status: 503 });
  }
  if (!userId) return NextResponse.json({ error: "Logga in för att se sociala kopplingar." }, { status: 401 });
  try {
    const providers = providerPayload();
    const connections = await listSocialConnections(createAdminClient(), userId);
    return NextResponse.json({ connections, providers }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) return configurationResponse(missingSupabaseServiceConfiguration());
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa sociala kopplingar." }, { status: 500 });
  }
}

function providerPayload(): SocialProviderAvailability[] {
  return SOCIAL_PROVIDER_VALUES.map((provider) => {
    const status = getSocialProviderAvailability(provider);
    return {
      provider,
      configured: status.configured,
      missing: status.missing,
      connectUrl: status.configured ? `/api/social/connections/${provider}/connect?returnTo=/studio/channels` : null,
    };
  });
}

function usesNeonStore(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function configurationResponse(missing: string[]) {
  return NextResponse.json({
    error: "Sociala konton är inte konfigurerade ännu.",
    code: "configuration_required",
    missing,
  }, { status: 503, headers: { "cache-control": "no-store" } });
}
