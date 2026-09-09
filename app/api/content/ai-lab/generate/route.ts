import { NextRequest, NextResponse } from "next/server";
import { aiGatewayLabRequestSchema } from "@/lib/domain/ai-gateway-content-lab";
import {
  resolveSagaBrandActor,
  SagaBrandScopeError,
} from "@/lib/neon/saga-brand-api-eligibility";
import type { ContentEngineRecipe } from "@/lib/domain/content-engine";
import { requireNeonActor } from "@/lib/neon/http";
import {
  getContentEngineRecipe,
  getContentEngineRecipeLabModelPlan,
  getContentEngineRecipeLabSources,
  type ContentEngineLabSource,
} from "@/lib/neon/content-engine-repository";
import {
  getSagaEditorialLensLabContext,
  type SagaEditorialLensLabContext,
} from "@/lib/neon/saga-editorial-lens-repository";
import { getSagaSeriesReferenceGuidanceContext } from "@/lib/neon/saga-series-reference-repository";
import { getStudioTemplate } from "@/lib/neon/studio-content-repository";
import {
  AiGatewayContentLabError,
  generateAiGatewayContentLab,
  type AiGatewayLabModelPolicyContext,
  type AiGatewayLabRecipeContext,
} from "@/lib/services/ai-gateway-content-lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

function errorResponse(error: string, status: number, code?: string) {
  return NextResponse.json(
    code ? { error, code } : { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * A protected comparison endpoint. It returns only ephemeral lab drafts and
 * model metadata: it cannot create a draft, schedule a task, send a message
 * or invoke a publisher.
 */
export async function POST(request: NextRequest) {
  const resolved = await requireNeonActor("Logga in för att testa AI-motorn.");
  if (resolved.response) return resolved.response;

  try {
    resolved.actor = await resolveSagaBrandActor(resolved.actor, new URL(request.url).searchParams.get("brandProfileId"));
  } catch (error) {
    if (error instanceof SagaBrandScopeError) return errorResponse(error.message, error.status, error.code);
    return errorResponse("AI-testet kan inte verifiera varumärkesvalet just nu.", 503, "brand_selection_unavailable");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("AI-underlaget måste skickas som giltig JSON.", 400, "invalid_request");
  }

  const parsed = aiGatewayLabRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "AI-underlaget är inte giltigt.", 400, "invalid_request");
  }

  // The browser supplies only an opaque UUID. The server is the sole owner of
  // the actor-scoped, immutable reference snapshot and editorial controls.
  let seriesReference = null;
  if (parsed.data.seriesId) {
    try {
      seriesReference = await getSagaSeriesReferenceGuidanceContext(resolved.actor, parsed.data.seriesId);
    } catch {
      return errorResponse("SAGA-serien kan inte läsas från den Vercel-anslutna databasen.", 503, "series_reference_unavailable");
    }
    if (!seriesReference) {
      // Deliberately covers inactive, missing and another workspace's series.
      return errorResponse("SAGA-serien hittades inte i den här arbetsytan.", 404, "series_reference_not_found");
    }
  }

  let template: AiGatewayLabRecipeContext | null = null;
  const engineRecipeId = parsed.data.recipe.engineRecipeId;
  const templateId = parsed.data.recipe.templateId;
  if (engineRecipeId) {
    try {
      template = await resolveContentEngineRecipe(resolved.actor, engineRecipeId);
    } catch {
      return errorResponse("Content Engine-receptet kan inte läsas från den Vercel-anslutna databasen.", 503, "content_engine_recipe_unavailable");
    }
    if (!template) return errorResponse("Receptet hittades inte i den här arbetsytan.", 404, "recipe_not_found");
  } else if (templateId) {
    // Keep old Studio templates working. A Content Engine recipe ID sent in
    // the legacy field is then resolved as a safe migration bridge for the
    // new workspace UI; both lookups are actor-workspace scoped.
    try {
      template = await getStudioTemplate(resolved.actor, templateId);
    } catch {
      return errorResponse("Mallen kunde inte läsas i den här arbetsytan.", 400, "invalid_recipe");
    }
    if (!template) {
      try {
        template = await resolveContentEngineRecipe(resolved.actor, templateId);
      } catch {
        return errorResponse("Content Engine-receptet kan inte läsas från den Vercel-anslutna databasen.", 503, "content_engine_recipe_unavailable");
      }
      if (!template) return errorResponse("Mallen eller receptet hittades inte i den här arbetsytan.", 404, "recipe_not_found");
    }
  }

  let lensContext: SagaEditorialLensLabContext | null = null;
  try {
    lensContext = await getSagaEditorialLensLabContext(resolved.actor);
  } catch {
    return errorResponse("SAGA Editorial Lens kan inte läsas från den Vercel-anslutna databasen.", 503, "editorial_lens_unavailable");
  }

  const resolvedSourceContext = isContentEngineRecipe(template)
    ? await resolveRecipeSources(resolved.actor, template.id, lensContext?.sourceSelectionIds ?? [])
    : [];
  if (resolvedSourceContext === null) {
    return errorResponse("Receptets källor kan inte läsas från den Vercel-anslutna databasen.", 503, "content_engine_sources_unavailable");
  }
  const sourceContext = applyLensSourceRules(resolvedSourceContext, lensContext);
  if (isContentEngineRecipe(template) && lensContext?.sourceSelectionIds.length && !sourceContext.length) {
    return errorResponse(
      "Det aktiva Lens-källurvalet saknar en aktiv receptkälla som också följer Lens källtyper och domänregler. Justera receptet eller Editorial Lens.",
      422,
      "lens_source_scope_empty",
    );
  }

  const editorialLens = lensContext?.prompt ?? null;

  let modelPolicy: AiGatewayLabModelPolicyContext | null = null;
  if (isContentEngineRecipe(template) && template.modelPolicyId) {
    try {
      const savedPlan = await getContentEngineRecipeLabModelPlan(resolved.actor, template.id);
      if (!savedPlan) {
        return errorResponse("Receptets AI-policy hittades inte i den här arbetsytan.", 422, "model_policy_not_available");
      }
      modelPolicy = {
        id: savedPlan.policyId,
        name: savedPlan.policyName,
        taskKind: savedPlan.taskKind,
        selectionMode: savedPlan.selectionMode,
        active: savedPlan.active,
        models: savedPlan.models.map((model) => ({
          provider: model.provider,
          modelId: model.modelId,
          presetName: model.presetName,
          priority: model.priority,
        })),
      };
    } catch {
      return errorResponse("Receptets AI-policy kan inte läsas från den Vercel-anslutna databasen.", 503, "content_engine_policy_unavailable");
    }
  }

  try {
    const intendedChannels = template && "channels" in template && template.channels.length
      ? template.channels
      : seriesReference?.controls.defaultChannels ?? [];
    const result = await generateAiGatewayContentLab({
      input: parsed.data,
      template,
      sources: sourceContext,
      modelPolicy,
      editorialLens,
      seriesReference,
      intendedChannels,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AiGatewayContentLabError) {
      const response = NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.code === "ai_gateway_not_configured" ? { missing: ["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN"] } : {}),
        },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
      return response;
    }
    return errorResponse("AI-testet kunde inte slutföras. Inget har sparats, skickats eller publicerats.", 502, "ai_gateway_generation_failed");
  }
}

async function resolveContentEngineRecipe(actor: Parameters<typeof getContentEngineRecipe>[0], recipeId: string): Promise<AiGatewayLabRecipeContext | null> {
  const recipe = await getContentEngineRecipe(actor, recipeId);
  if (!recipe || !recipe.active) return null;
  return recipe;
}

function isContentEngineRecipe(value: AiGatewayLabRecipeContext | null): value is ContentEngineRecipe {
  return Boolean(value && "instructions" in value && "renderingConfig" in value && !("generationPrompt" in value));
}

async function resolveRecipeSources(
  actor: Parameters<typeof getContentEngineRecipe>[0],
  recipeId: string,
  selectedSourceIds: readonly string[],
) {
  try {
    return await getContentEngineRecipeLabSources(actor, recipeId, selectedSourceIds);
  } catch {
    return null;
  }
}

/**
 * A Lens can only tighten a recipe's actor-scoped source boundary. It never
 * fetches URLs and never adds a source that the recipe did not already allow.
 */
function applyLensSourceRules(
  sources: readonly ContentEngineLabSource[],
  lensContext: SagaEditorialLensLabContext | null,
): ContentEngineLabSource[] {
  if (!lensContext) return [...sources];
  const rules = lensContext.prompt.sourceRules;
  const allowedKinds = Array.isArray(rules.allowedSourceKinds) ? new Set(rules.allowedSourceKinds) : null;
  const blockedDomains = Array.isArray(rules.blockedDomains)
    ? rules.blockedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)
    : [];
  return sources.filter((source) => {
    if (allowedKinds && !allowedKinds.has(source.sourceKind as never)) return false;
    if (!source.sourceUrl) return true;
    const host = sourceHostname(source.sourceUrl);
    if (!host) return false;
    return !blockedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  });
}

function sourceHostname(sourceUrl: string): string | null {
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
