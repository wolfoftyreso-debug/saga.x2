import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireNeonActor } from "@/lib/neon/http";
import {
  disconnectNeonSocialConnection,
  NeonSocialConnectionAccessError,
} from "@/lib/neon/social-connections-repository";
import { disconnectSocialConnection } from "@/lib/services/social-connections";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Kept under a static `id` segment so OAuth's provider route can remain
 * `/connections/:provider/connect` without creating two sibling dynamic
 * route names. This endpoint never returns or exposes OAuth credentials.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  if (!z.string().uuid().safeParse(connectionId).success) return NextResponse.json({ error: "Ogiltigt konto-id." }, { status: 400 });

  // No fallback to Supabase after the deployment has chosen Neon. The delete
  // is scoped by the signed session actor's workspace and removes ciphertext
  // material immediately.
  if (usesNeonStore()) {
    const resolved = await requireNeonActor("Logga in för att koppla från ett konto.");
    if (resolved.response) return resolved.response;
    try {
      const disconnected = await disconnectNeonSocialConnection(resolved.actor, connectionId);
      if (!disconnected) return NextResponse.json({ error: "Kontot hittades inte." }, { status: 404, headers: { "cache-control": "no-store" } });
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const status = error instanceof NeonSocialConnectionAccessError ? 403 : 500;
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Kunde inte koppla från kontot.",
      }, { status, headers: { "cache-control": "no-store" } });
    }
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att koppla från ett konto." }, { status: 401 });
  try {
    const disconnected = await disconnectSocialConnection(createAdminClient(), userId, connectionId);
    if (!disconnected) return NextResponse.json({ error: "Kontot hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte koppla från kontot." }, { status: 500 });
  }
}

function usesNeonStore(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
