import { NextResponse, type NextRequest } from "next/server";
import {
  getNeonConnectionState,
  isLegacySupabaseApiPath,
  isNeonBackedApiPath,
  isVercelOnlyMode,
} from "@/lib/runtime/vercel-only";

/**
 * App sessions are opaque, HttpOnly cookies checked by server routes. Unlike
 * the old Supabase client there is nothing to refresh in middleware, so this
 * stays deliberately side-effect free and never contacts a third party for
 * every navigation.
 */
export function proxy(request: NextRequest) {
  if (!isVercelOnlyMode()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (isLegacySupabaseApiPath(pathname)) {
    return NextResponse.json(
      {
        error: "Den här äldre funktionen är inte flyttad till Vercel ännu. Supabase används inte.",
        code: "vercel_only_mode",
        dataStore: "neon",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (isNeonBackedApiPath(pathname)) {
    const state = getNeonConnectionState();
    if (state !== "configured") {
      return NextResponse.json(
        state === "missing"
          ? {
            error: "Studio kan inte starta förrän Neon är anslutet i Vercel.",
            code: "configuration_required",
            missing: ["DATABASE_URL"],
          }
          : {
            error: "Studio har en ogiltig Neon-anslutning i Vercel.",
            code: "database_configuration_invalid",
          },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
