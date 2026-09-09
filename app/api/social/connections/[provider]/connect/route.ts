import { NextRequest, NextResponse } from "next/server";
import { socialProviderSchema } from "@/lib/domain/social";
import { requireNeonActor } from "@/lib/neon/http";
import { SocialProviderConfigurationError } from "@/lib/services/social-config";
import { createSocialOAuthStart } from "@/lib/services/social-connections";
import {
  MissingSupabaseConfigurationError,
  missingSupabaseServiceConfiguration,
} from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  const provider = socialProviderSchema.safeParse(rawProvider);
  if (!provider.success) return NextResponse.json({ error: "Okänd social kanal." }, { status: 404 });

  // Vercel/Neon uses the app-owned signed session for the OAuth binding. The
  // provider start is real only when all provider config is present; otherwise
  // the channel card has no connect URL and this route returns structured setup
  // information rather than a misleading redirect.
  if (usesNeonStore()) {
    const resolved = await requireNeonActor("Logga in innan du kopplar ett konto.");
    if (resolved.response) return resolved.response;
    try {
      const start = createSocialOAuthStart({
        provider: provider.data,
        userId: resolved.actor.userId,
        workspaceId: resolved.actor.workspaceId,
        returnTo: request.nextUrl.searchParams.get("returnTo"),
      });
      const response = NextResponse.redirect(start.authorizationUrl);
      response.cookies.set(start.cookie.name, start.cookie.value, start.cookie.options);
      return response;
    } catch (error) {
      if (error instanceof SocialProviderConfigurationError) {
        return NextResponse.json({
          error: "Kopplingen är inte konfigurerad ännu.",
          code: error.code,
          provider: error.provider,
          missing: error.missing,
        }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : "Kopplingen kunde inte startas." }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }

  // OAuth must be able to persist the final connection. Starting a provider
  // login without the database key would only lead to a failed callback.
  const missingSupabase = missingSupabaseServiceConfiguration();
  if (missingSupabase.length) return configurationResponse(missingSupabase);

  let userId: string | null;
  try {
    userId = await getAuthenticatedUserId();
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) return configurationResponse(missingSupabaseServiceConfiguration());
    return NextResponse.json({ error: "Inloggningen kunde inte verifieras just nu. Försök igen senare." }, { status: 503 });
  }
  if (!userId) return NextResponse.json({ error: "Logga in innan du kopplar ett konto." }, { status: 401 });

  try {
    const start = createSocialOAuthStart({
      provider: provider.data,
      userId,
      returnTo: request.nextUrl.searchParams.get("returnTo"),
    });
    const response = NextResponse.redirect(start.authorizationUrl);
    response.cookies.set(start.cookie.name, start.cookie.value, start.cookie.options);
    return response;
  } catch (error) {
    if (error instanceof SocialProviderConfigurationError) {
      return NextResponse.json({
        error: "Kopplingen är inte konfigurerad ännu.",
        code: error.code,
        provider: error.provider,
        missing: error.missing,
      }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kopplingen kunde inte startas." }, { status: 500 });
  }
}

function usesNeonStore(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function configurationResponse(missing: string[]) {
  return NextResponse.json({
    error: "Anslutning av sociala konton är inte konfigurerad ännu.",
    code: "configuration_required",
    missing,
  }, { status: 503, headers: { "cache-control": "no-store" } });
}
