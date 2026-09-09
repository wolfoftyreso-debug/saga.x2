import { z } from "zod";
import { generatedContentSchema } from "@/lib/domain/content-generation";

/**
 * Stable product presets. Their provider-qualified Gateway model IDs live in
 * server environment variables, so a provider model can be replaced without
 * changing browser code or accepting arbitrary model IDs from a request.
 */
export const AI_GATEWAY_LAB_PROVIDERS = ["openai", "anthropic", "google", "xai"] as const;
export type AiGatewayLabProvider = (typeof AI_GATEWAY_LAB_PROVIDERS)[number];

export const aiGatewayLabProviderSchema = z.enum(AI_GATEWAY_LAB_PROVIDERS);

export const AI_GATEWAY_LAB_DEFAULT_PROVIDERS = ["openai", "anthropic", "google"] as const satisfies readonly AiGatewayLabProvider[];

export const AI_GATEWAY_LAB_PROVIDER_LABELS: Record<AiGatewayLabProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  google: "Gemini",
  xai: "Grok",
};

const nullableUuid = z.string().uuid().nullable().optional();

/**
 * A lab can use either a legacy Studio template or a Content Engine recipe.
 * Personas are deliberately a bounded reference plus a plain-language
 * instruction snapshot. IDs are opaque references only; identity and
 * workspace never come from this request.
 */
export const aiGatewayLabRequestSchema = z.object({
  topic: z.string().trim().min(3, "Skriv ett ämne med minst tre tecken.").max(2_000),
  /**
   * An opaque Series Reference selector only. The protected route resolves its
   * immutable snapshot for the signed actor; callers can never supply a
   * reference body, controls, media metadata, workspace, or revision here.
   */
  seriesId: nullableUuid.default(null),
  recipe: z.object({
    templateId: nullableUuid.default(null),
    /** Preferred identity for a Content Engine recipe. `templateId` remains a compatible legacy bridge. */
    engineRecipeId: nullableUuid.default(null),
    label: z.string().trim().max(160).default(""),
  }).strict().default({ templateId: null, engineRecipeId: null, label: "" }),
  persona: z.object({
    id: nullableUuid.default(null),
    label: z.string().trim().max(160).default(""),
    instructions: z.string().trim().max(6_000).default(""),
  }).strict().default({ id: null, label: "", instructions: "" }),
  models: z.array(aiGatewayLabProviderSchema).min(2, "Välj minst två AI-modeller för att jämföra utkast.").max(3, "Välj högst tre AI-modeller i ett test.")
    .default([...AI_GATEWAY_LAB_DEFAULT_PROVIDERS]),
}).strict().superRefine((value, context) => {
  if (new Set(value.models).size !== value.models.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["models"],
      message: "Välj varje AI-modell högst en gång.",
    });
  }
});

export type AiGatewayLabRequest = z.infer<typeof aiGatewayLabRequestSchema>;

/** The model returns content and a short display label—never hidden reasoning. */
export const aiGatewayLabModelOutputSchema = z.object({
  variationLabel: z.string().trim().min(2).max(80),
  draft: generatedContentSchema,
});

export type AiGatewayLabModelOutput = z.infer<typeof aiGatewayLabModelOutputSchema>;
