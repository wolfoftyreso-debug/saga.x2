import { NextRequest, NextResponse } from "next/server";
import { socialProviderSchema } from "@/lib/domain/social";
import { getCurrentActor } from "@/lib/neon/auth-repository";
import { upsertNeonSocialConnections } from "@/lib/neon/social-connections-repository";
import { SocialProviderConfigurationError } from "@/lib/services/social-config";
import {
  clearSocialOAuthCookie,
  exchangeSocialOAuthCode,
  finishSocialOAuthConnection,
  readSocialOAuthTransaction,
  resolveSocialAccounts,
  SocialOAuthError,
} from "@/lib/services/social-connections";
import { createAdminClient } from "@/lib/supabase/admin";
import { MissingSupabaseConfigurationError } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  const provider = socialProviderSchema.safeParse(rawProvider);
  if (!provider.success) return redirectWithStatus(request, "/studio", "invalid_provider");

  if (usesNeonStore()) return finishNeonOAuthCallback(request, provider.data);

  const transaction = readSocialOAuthTransaction({
    provider: provider.data,
    cookieValue: request.cookies.get(`pdb_social_oauth_${provider.data}`)?.value,
    returnedState: request.nextUrl.searchParams.get("state"),
  });
  const response = async (returnTo: string, status: string) => {
    const redirected = redirectWithStatus(request, returnTo, status);
    const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    const cookie = clearSocialOAuthCookie(provider.data, secure);
    redirected.cookies.set(cookie.name, cookie.value, cookie.options);
    return redirected;
  };
  if (!transaction) return response("/studio", "invalid_state");

  let currentUserId: string | null;
  try {
    currentUserId = await getAuthenticatedUserId();
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) return response(transaction.returnTo, "configuration_required");
    return response(transaction.returnTo, "session_unavailable");
  }
  if (!currentUserId || currentUserId !== transaction.userId) return response(transaction.returnTo, "session_mismatch");
  if (request.nextUrl.searchParams.get("error")) return response(transaction.returnTo, "denied");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return response(transaction.returnTo, "missing_code");

  try {
    await finishSocialOAuthConnection({
      client: createAdminClient(),
      userId: transaction.userId,
      provider: provider.data,
      code,
    });
    return response(transaction.returnTo, "connected");
  } catch (error) {
    if (error instanceof SocialProviderConfigurationError) return response(transaction.returnTo, "configuration_required");
    return response(transaction.returnTo, "connection_failed");
  }
}

/**
 * Completes an OAuth flow bound to both the signed-in Vercel actor and its
 * workspace. The encrypted, HttpOnly transaction cookie is only a CSRF/state
 * receipt; no OAuth credential is ever placed in it or in the redirect URL.
 */
async function finishNeonOAuthCallback(
  request: NextRequest,
  provider: ReturnType<typeof socialProviderSchema.parse>,
): Promise<NextResponse> {
  const transaction = readSocialOAuthTransaction({
    provider,
    cookieValue: request.cookies.get(`pdb_social_oauth_${provider}`)?.value,
    returnedState: request.nextUrl.searchParams.get("state"),
  });
  const response = async (returnTo: string, status: string) => {
    const redirected = redirectWithStatus(request, returnTo, status);
    const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    const cookie = clearSocialOAuthCookie(provider, secure);
    redirected.cookies.set(cookie.name, cookie.value, cookie.options);
    return redirected;
  };
  if (!transaction?.workspaceId) return response("/studio", "invalid_state");

  let actor;
  try {
    actor = await getCurrentActor();
  } catch {
    return response(transaction.returnTo, "configuration_required");
  }
  if (!actor || actor.userId !== transaction.userId || actor.workspaceId !== transaction.workspaceId) {
    return response(transaction.returnTo, "session_mismatch");
  }
  if (request.nextUrl.searchParams.get("error")) return response(transaction.returnTo, "denied");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return response(transaction.returnTo, "missing_code");

  try {
    const token = await exchangeSocialOAuthCode(provider, code);
    const accounts = await resolveSocialAccounts({ provider, ...token });
    if (!accounts.length) {
      throw new SocialOAuthError(
        provider === "instagram_professional"
          ? "Inget publicerbart Instagram Professional-konto hittades."
          : provider === "facebook_page"
            ? "Inga Facebook-sidor med publiceringsbehörighet hittades."
            : "Inget LinkedIn-konto med publiceringsbehörighet hittades.",
        "no_publishable_account",
      );
    }
    await upsertNeonSocialConnections(actor, accounts);
    return response(transaction.returnTo, "connected");
  } catch (error) {
    if (error instanceof SocialProviderConfigurationError) return response(transaction.returnTo, "configuration_required");
    // Provider and database detail can contain account metadata. Keep it only
    // in server logs managed by the provider integration, never in the URL.
    return response(transaction.returnTo, "connection_failed");
  }
}

function redirectWithStatus(request: NextRequest, returnTo: string, status: string): NextResponse {
  const safePath = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/studio";
  const target = new URL(safePath, request.nextUrl.origin);
  target.searchParams.set("social", status);
  return NextResponse.redirect(target);
}

function usesNeonStore(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
