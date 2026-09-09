import { NextRequest, NextResponse } from "next/server";

/**
 * Compatibility bridge for a previously documented callback path. New Sign in
 * with Vercel apps must register `/api/auth/callback`; preserving this redirect
 * avoids sending a user to a blank legacy Supabase exchange route.
 */
export function GET(request: NextRequest) {
  const target = new URL("/api/auth/callback", request.url);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target);
}
