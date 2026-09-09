import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { imageAdaptationInputSchema } from "@/lib/domain/media-adaptation";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { ContentMediaError, adaptContentImageForUser } from "@/lib/services/content-media";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const mediaIdSchema = z.string().uuid();

export async function POST(request: NextRequest, context: { params: Promise<{ mediaId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    return NextResponse.json({
      error: "AI-bildförbättring för privata Vercel Blob-filer är inte flyttad ännu. Originalbilden är kvar och kan fortfarande redigeras eller ersättas.",
      code: "feature_not_available",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att förbättra en bild." }, { status: 401 });
  const { mediaId: rawMediaId } = await context.params;
  const parsedId = mediaIdSchema.safeParse(rawMediaId);
  if (!parsedId.success) return NextResponse.json({ error: "Ogiltigt bild-id." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bildinställningarna måste vara giltig JSON." }, { status: 400 });
  }
  const parsed = imageAdaptationInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bildinställningarna är ogiltiga." }, { status: 400 });

  try {
    const media = await adaptContentImageForUser({
      client: createAdminClient(),
      userId,
      mediaId: parsedId.data,
      ...parsed.data,
    });
    return NextResponse.json({ media }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ContentMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Bilden kunde inte förbättras just nu. Originalet är kvar." }, { status: 502 });
  }
}
