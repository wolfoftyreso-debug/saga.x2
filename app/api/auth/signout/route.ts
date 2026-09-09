import { NextRequest, NextResponse } from "next/server";
import { appSessionCookie, revokeAppSession } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isNeonDatabaseConfigured()) {
    await revokeAppSession(request.cookies.get(appSessionCookie.name)?.value).catch(() => undefined);
  }
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.delete(appSessionCookie.name);
  return response;
}
