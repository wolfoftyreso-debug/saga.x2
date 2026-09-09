import { NextRequest, NextResponse } from "next/server";
import {
  exchangeVercelAuthorizationCode,
  safeRelativeReturnTo,
  verifyVercelIdentityToken,
} from "@/lib/auth/vercel-oauth";
import { appSessionCookie, createAppSession, ensureVercelActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const transientCookies = ["brief_oauth_state", "brief_oauth_nonce", "brief_oauth_verifier", "brief_oauth_return_to"] as const;

function loginError(request: NextRequest, reason: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}`, request.url));
  transientCookies.forEach((name) => response.cookies.delete(name));
  return response;
}

export async function GET(request: NextRequest) {
  if (!isNeonDatabaseConfigured()) return loginError(request, "database_not_configured");

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const savedState = request.cookies.get("brief_oauth_state")?.value;
  const nonce = request.cookies.get("brief_oauth_nonce")?.value;
  const codeVerifier = request.cookies.get("brief_oauth_verifier")?.value;
  const returnTo = safeRelativeReturnTo(request.cookies.get("brief_oauth_return_to")?.value);

  if (error || !code || !state || !savedState || state !== savedState || !nonce || !codeVerifier) {
    return loginError(request, error === "access_denied" ? "access_denied" : "invalid_callback");
  }

  try {
    const token = await exchangeVercelAuthorizationCode({ code, codeVerifier, origin: request.nextUrl.origin });
    const identity = await verifyVercelIdentityToken(token.id_token, nonce);
    const actor = await ensureVercelActor(identity);
    const session = await createAppSession(actor);
    const response = NextResponse.redirect(new URL(returnTo, request.url));
    response.cookies.set(appSessionCookie.name, session, appSessionCookie.options);
    transientCookies.forEach((name) => response.cookies.delete(name));
    return response;
  } catch {
    return loginError(request, "sign_in_failed");
  }
}
