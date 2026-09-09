import { NextRequest, NextResponse } from "next/server";
import { contentGenerationInputSchema } from "@/lib/domain/content-generation";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import { getNeonDatabaseConfigurationState } from "@/lib/neon/config";
import { resolveSagaBrandActor, SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import { getSagaEditorialLensPromptContext } from "@/lib/neon/saga-editorial-lens-repository";
import { ContentGenerationError, generateContentDraft, type ContentGenerationServerContext } from "@/lib/services/content-generation";
import { isVercelOnlyMode } from "@/lib/runtime/vercel-only";
import { isSupabasePublicConfigured, MissingSupabaseConfigurationError } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

function errorResponse(error: string, status: number, code?: string) {
  return NextResponse.json(code ? { error, code } : { error }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * AI only returns a structured proposal. It never persists, schedules or
 * publishes it: the editor remains the single explicit write path.
 */
export async function POST(request: NextRequest) {
  let generationContext: ContentGenerationServerContext | undefined;
  if (isVercelOnlyMode() || getNeonDatabaseConfigurationState() !== "missing") {
    const configuration = neonConfigurationResponse("Studio behöver Neon i Vercel för att skapa AI-utkast.");
    if (configuration) return configuration;
    const resolved = await requireNeonActor("Logga in för att skapa ett AI-utkast.");
    if (resolved.response) return resolved.response;
    if (resolved.actor.role === "viewer") {
      return errorResponse("Du har läsbehörighet. Be en ansvarig om redigeringsbehörighet för att skapa AI-utkast.", 403, "write_access_required");
    }
    let brandActor;
    try {
      brandActor = await resolveSagaBrandActor(resolved.actor, new URL(request.url).searchParams.get("brandProfileId"));
    } catch (error) {
      if (error instanceof SagaBrandScopeError) return errorResponse(error.message, error.status, error.code);
      return errorResponse("Varumärket kunde inte verifieras. Inget AI-utkast har skapats.", 503, "brand_unavailable");
    }
    try {
      generationContext = { editorialLens: await getSagaEditorialLensPromptContext(brandActor) };
    } catch {
      return errorResponse("Varumärkets skrivram kunde inte läsas. Försök igen; inget AI-utkast har skapats.", 503, "editorial_lens_unavailable");
    }
  } else {
    // Retained only for explicitly non-Vercel legacy installations without
    // any Neon URL. An invalid/missing Vercel connection never falls back.
    if (!isSupabasePublicConfigured()) {
      return errorResponse("AI-studion är inte konfigurerad ännu.", 503);
    }
    try {
      const userId = await getAuthenticatedUserId();
      if (!userId) return errorResponse("Logga in för att skapa ett AI-utkast.", 401);
    } catch (error) {
      if (error instanceof MissingSupabaseConfigurationError) {
        return errorResponse("AI-studion är inte konfigurerad ännu.", 503);
      }
      return errorResponse("Inloggningen kunde inte verifieras just nu.", 503);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("AI-underlaget måste skickas som giltig JSON.", 400);
  }
  const parsed = contentGenerationInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "AI-underlaget är inte giltigt.", 400);
  }

  try {
    const result = await generateContentDraft(parsed.data, generationContext);
    return NextResponse.json(
      {
        draft: result.draft,
        metadata: {
          model: result.model,
          responseId: result.responseId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ContentGenerationError) return errorResponse(error.message, error.status);
    return errorResponse("AI-utkastet kunde inte skapas just nu. Inget har sparats.", 502);
  }
}
