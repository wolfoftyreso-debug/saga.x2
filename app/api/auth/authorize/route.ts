import { NextRequest, NextResponse } from "next/server";
import {
  createVercelOAuthTransaction,
  isVercelIdentityConfigured,
  safeRelativeReturnTo,
  vercelAuthorizationUrl,
} from "@/lib/auth/vercel-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const oauthRedirectHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

const transactionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 10 * 60,
  path: "/",
};

export function GET(request: NextRequest) {
  if (!isVercelIdentityConfigured()) {
    const login = new URL("/login?error=configuration_required", request.url);
    return NextResponse.redirect(login, { headers: oauthRedirectHeaders });
  }

  const transaction = createVercelOAuthTransaction();
  const returnTo = safeRelativeReturnTo(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(vercelAuthorizationUrl(request.nextUrl.origin, transaction), { headers: oauthRedirectHeaders });
  response.cookies.set("brief_oauth_state", transaction.state, transactionCookieOptions);
  response.cookies.set("brief_oauth_nonce", transaction.nonce, transactionCookieOptions);
  response.cookies.set("brief_oauth_verifier", transaction.codeVerifier, transactionCookieOptions);
  response.cookies.set("brief_oauth_return_to", returnTo, transactionCookieOptions);
  return response;
}
