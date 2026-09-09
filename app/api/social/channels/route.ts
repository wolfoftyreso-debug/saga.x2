import { NextResponse } from "next/server";
import { SOCIAL_CHANNEL_VALUES, providerForChannel, type SocialChannel } from "@/lib/domain/social";
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

/**
 * Studio-friendly safe projection. It has exactly the connection metadata a
 * calendar/editor needs and intentionally no token, token prefix or ciphertext.
 */
export async function GET() {
  // A deployment that has started the Vercel/Neon migration must never fall
  // back to the retired Supabase records, even if DATABASE_URL is malformed.
  if (usesNeonStore()) {
    const resolved = await requireNeonActor("Logga in för att se publiceringskanaler.");
    if (resolved.response) return resolved.response;
    try {
      const connections = await listNeonSocialConnections(resolved.actor);
      return NextResponse.json({
        channels: channelPayload(connections, false),
        publicationAvailable: false,
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Kunde inte läsa publiceringskanaler.",
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
  if (!userId) return NextResponse.json({ error: "Logga in för att se publiceringskanaler." }, { status: 401 });
  try {
    const connections = await listSocialConnections(createAdminClient(), userId);
    const channels = channelPayload(connections, true);
    return NextResponse.json({ channels }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) return configurationResponse(missingSupabaseServiceConfiguration());
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa publiceringskanaler." }, { status: 500 });
  }
}

function channelPayload(
  connections: Awaited<ReturnType<typeof listSocialConnections>>,
  publicationAvailable: boolean,
) {
  return SOCIAL_CHANNEL_VALUES.map((channel) => {
    const provider = providerForChannel(channel);
    const availability = getSocialProviderAvailability(provider);
    const channelConnections = connections.filter((connection) => connection.provider === provider);
    return {
      channel,
      provider,
      configured: availability.configured,
      missing: availability.missing,
      // The URL is only present after the provider, callback origin and token
      // encryption key have all been configured. A card can never render a
      // button that only leads to a setup error.
      connectUrl: availability.configured ? `/api/social/connections/${provider}/connect?returnTo=/studio/channels` : null,
      // Credential storage is ready in Neon; actual outbound publishing stays
      // false until the Vercel publisher is migrated as a separate safe step.
      canPublish: publicationAvailable && availability.configured && channelConnections.some((connection) => connection.state === "active"),
      connections: channelConnections,
    } satisfies {
      channel: SocialChannel;
      provider: ReturnType<typeof providerForChannel>;
      configured: boolean;
      missing: string[];
      connectUrl: string | null;
      canPublish: boolean;
      connections: Awaited<ReturnType<typeof listSocialConnections>>;
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
