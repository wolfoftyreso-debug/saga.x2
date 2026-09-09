import { z } from "zod";
import { aiGatewayProviderNamespace, isAiGatewayModelForProvider } from "@/lib/domain/ai-gateway-model-namespace";

/**
 * Browser-safe contract for the Vercel Content Engine.  It intentionally has
 * no provider credential fields: model and delivery credentials belong in
 * Vercel environment variables or dedicated server-only connection stores.
 */

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().min(1);
const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}$/);
const languageSchema = z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const boundedTagSchema = z.string().trim().min(1).max(80);

const forbiddenJsonKeyNames = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secret",
  "password",
  "authorization",
  "privatekey",
  "credential",
  "credentials",
  "bearertoken",
  "serviceaccount",
  "token",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "webhooksecret",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function isForbiddenJsonKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return forbiddenJsonKeyNames.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("clientsecret")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("bearertoken")
    || normalized.endsWith("credential")
    || normalized.endsWith("token")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("sessiontoken")
    || normalized.endsWith("webhooksecret");
}

function validateSafeJson(value: unknown, context: z.RefinementCtx, path: Array<string | number> = [], depth = 0): void {
  if (depth > 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "Konfigurationen får vara högst åtta nivåer djup." });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSafeJson(item, context, [...path, index], depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenJsonKey(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: "API-nycklar, tokens och andra hemligheter får aldrig sparas i Content Engine.",
      });
    }
    validateSafeJson(nested, context, [...path, key], depth + 1);
  }
}

/** A small extensibility envelope that still rejects accidental credentials. */
export const contentEngineSafeJsonSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Konfigurationen måste kunna sparas som JSON." });
    return;
  }
  if (serialized.length > 50_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Konfigurationen får vara högst 50 000 tecken." });
  }
  validateSafeJson(value, context);
});

export const CONTENT_ENGINE_SOURCE_KINDS = ["website", "rss", "social_profile", "document", "manual"] as const;
export const CONTENT_ENGINE_MODEL_PROVIDERS = ["openai", "anthropic", "google", "xai", "other"] as const;
export const CONTENT_ENGINE_OTHER_MODEL_PREFIXES = ["mistral/", "cohere/", "perplexity/", "deepseek/", "meta/", "amazon-bedrock/"] as const;
export const CONTENT_ENGINE_MODEL_TASK_KINDS = ["writing", "research", "image", "vision", "summarization"] as const;
export const CONTENT_ENGINE_MODEL_SELECTION_MODES = ["primary_then_fallback", "quality_first", "cost_aware", "manual"] as const;
export const CONTENT_ENGINE_RECIPE_CONTENT_TYPES = ["newsletter", "social_post", "article", "campaign"] as const;
export const CONTENT_ENGINE_DESTINATION_KINDS = ["newsletter", "rss", "social", "website"] as const;
export const CONTENT_ENGINE_DELIVERY_MODES = ["manual", "scheduled", "event"] as const;
export const CONTENT_ENGINE_ENTITIES = ["brandProfile", "source", "modelPreset", "modelPolicy", "recipe", "destination", "distributionRule"] as const;

export type ContentEngineSourceKind = (typeof CONTENT_ENGINE_SOURCE_KINDS)[number];
export type ContentEngineModelProvider = (typeof CONTENT_ENGINE_MODEL_PROVIDERS)[number];
export type ContentEngineModelTaskKind = (typeof CONTENT_ENGINE_MODEL_TASK_KINDS)[number];
export type ContentEngineModelSelectionMode = (typeof CONTENT_ENGINE_MODEL_SELECTION_MODES)[number];
export type ContentEngineRecipeContentType = (typeof CONTENT_ENGINE_RECIPE_CONTENT_TYPES)[number];
export type ContentEngineDestinationKind = (typeof CONTENT_ENGINE_DESTINATION_KINDS)[number];
export type ContentEngineDeliveryMode = (typeof CONTENT_ENGINE_DELIVERY_MODES)[number];
export type ContentEngineEntity = (typeof CONTENT_ENGINE_ENTITIES)[number];

export const contentEngineSourceKindSchema = z.enum(CONTENT_ENGINE_SOURCE_KINDS);
export const contentEngineModelProviderSchema = z.enum(CONTENT_ENGINE_MODEL_PROVIDERS);
export const contentEngineModelTaskKindSchema = z.enum(CONTENT_ENGINE_MODEL_TASK_KINDS);
export const contentEngineModelSelectionModeSchema = z.enum(CONTENT_ENGINE_MODEL_SELECTION_MODES);
export const contentEngineRecipeContentTypeSchema = z.enum(CONTENT_ENGINE_RECIPE_CONTENT_TYPES);
export const contentEngineDestinationKindSchema = z.enum(CONTENT_ENGINE_DESTINATION_KINDS);
export const contentEngineDeliveryModeSchema = z.enum(CONTENT_ENGINE_DELIVERY_MODES);
export const contentEngineEntitySchema = z.enum(CONTENT_ENGINE_ENTITIES);

export const contentEngineBrandVoiceSchema = z.object({
  positioning: z.string().trim().max(3_000).default(""),
  audience: z.string().trim().max(2_000).default(""),
  toneTraits: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  vocabulary: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  avoidPhrases: z.array(z.string().trim().min(1).max(240)).max(40).default([]),
  writingSamples: z.array(z.string().trim().min(1).max(4_000)).max(8).default([]),
}).strict();

const brandProfileInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  organizationName: z.string().trim().max(240).default(""),
  summary: z.string().trim().max(6_000).default(""),
  defaultLanguage: languageSchema.default("sv"),
  voice: contentEngineBrandVoiceSchema,
  profileConfig: contentEngineSafeJsonSchema.default({}),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export const contentEngineBrandProfileInputSchema = brandProfileInputBaseSchema;
export type ContentEngineBrandProfileInput = z.infer<typeof contentEngineBrandProfileInputSchema>;

export const contentEngineBrandProfileSchema = brandProfileInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineBrandProfile = z.infer<typeof contentEngineBrandProfileSchema>;

const httpsUrlSchema = z.string().trim().url().max(2_000).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password;
}, "Källadressen måste vara HTTPS och får inte innehålla inloggningsuppgifter.");

const sourceInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(240),
  sourceKind: contentEngineSourceKindSchema,
  sourceUrl: httpsUrlSchema.nullable().default(null),
  referenceText: z.string().trim().max(120_000).default(""),
  description: z.string().trim().max(6_000).default(""),
  trustLevel: z.number().int().min(1).max(5).default(3),
  tags: z.array(boundedTagSchema).max(30).default([]),
  sourceConfig: contentEngineSafeJsonSchema.default({}),
  isAllowed: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const contentEngineSourceInputSchema = sourceInputBaseSchema.superRefine((value, context) => {
  if (!value.sourceUrl && !value.referenceText) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceUrl"], message: "Ange en HTTPS-adress eller ett referensunderlag." });
  }
  if (new Set(value.tags.map((tag) => tag.toLocaleLowerCase("sv-SE"))).size !== value.tags.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tags"], message: "En tagg får bara anges en gång." });
  }
});
export type ContentEngineSourceInput = z.infer<typeof contentEngineSourceInputSchema>;

export const contentEngineSourceSchema = sourceInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineSource = z.infer<typeof contentEngineSourceSchema>;

export const contentEngineModelSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxOutputTokens: z.number().int().min(64).max(200_000).nullable().optional(),
  reasoning: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
  extra: contentEngineSafeJsonSchema.optional(),
}).strict().default({});

const modelPresetInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  provider: contentEngineModelProviderSchema,
  modelId: z.string().trim().max(300).regex(
    /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]{0,260}$/,
    "Modell-id måste vara ett provider-kvalificerat AI Gateway-id.",
  ),
  taskKinds: z.array(contentEngineModelTaskKindSchema).min(1).max(5),
  gatewaySettings: contentEngineModelSettingsSchema,
  enabled: z.boolean().default(true),
});

export const contentEngineModelPresetInputSchema = modelPresetInputBaseSchema.superRefine((value, context) => {
  if (new Set(value.taskKinds).size !== value.taskKinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["taskKinds"], message: "En uppgiftstyp får bara väljas en gång." });
  }
  const lowerModelId = value.modelId.toLowerCase();
  const requiredPrefix = value.provider === "other" ? null : `${aiGatewayProviderNamespace(value.provider)}/`;
  const hasAllowedOtherPrefix = CONTENT_ENGINE_OTHER_MODEL_PREFIXES.some((prefix) => lowerModelId.startsWith(prefix));
  if ((requiredPrefix && !isAiGatewayModelForProvider(value.provider, value.modelId)) || (value.provider === "other" && !hasAllowedOtherPrefix)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelId"],
      message: value.provider === "other"
        ? "Andra modeller måste använda en tillåten AI Gateway-providerprefix."
        : `Modell-id måste börja med ${requiredPrefix}.`,
    });
  }
});
export type ContentEngineModelPresetInput = z.infer<typeof contentEngineModelPresetInputSchema>;

export const contentEngineModelPresetSchema = modelPresetInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineModelPreset = z.infer<typeof contentEngineModelPresetSchema>;

export const contentEngineModelPolicyStepSchema = z.object({
  presetId: uuidSchema,
  priority: z.number().int().min(1).max(20),
  enabled: z.boolean().default(true),
}).strict();
export type ContentEngineModelPolicyStep = z.infer<typeof contentEngineModelPolicyStepSchema>;

const modelPolicyInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  taskKind: contentEngineModelTaskKindSchema,
  selectionMode: contentEngineModelSelectionModeSchema.default("primary_then_fallback"),
  policyConfig: contentEngineSafeJsonSchema.default({}),
  steps: z.array(contentEngineModelPolicyStepSchema).min(1).max(20),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export const contentEngineModelPolicyInputSchema = modelPolicyInputBaseSchema.superRefine((value, context) => {
  const presetIds = new Set(value.steps.map((step) => step.presetId));
  const priorities = new Set(value.steps.map((step) => step.priority));
  if (presetIds.size !== value.steps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Samma modell får bara finnas en gång i en policy." });
  }
  if (priorities.size !== value.steps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Varje policyprioritet måste vara unik." });
  }
});
export type ContentEngineModelPolicyInput = z.infer<typeof contentEngineModelPolicyInputSchema>;

export const contentEngineModelPolicySchema = modelPolicyInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineModelPolicy = z.infer<typeof contentEngineModelPolicySchema>;

const recipeInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(6_000).default(""),
  contentType: contentEngineRecipeContentTypeSchema,
  brandProfileId: uuidSchema.nullable().default(null),
  modelPolicyId: uuidSchema.nullable().default(null),
  instructions: z.string().trim().max(30_000).default(""),
  renderingConfig: contentEngineSafeJsonSchema.default({}),
  sourceIds: z.array(uuidSchema).max(50).default([]),
  active: z.boolean().default(true),
});

export const contentEngineRecipeInputSchema = recipeInputBaseSchema.superRefine((value, context) => {
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceIds"], message: "Samma källa får bara kopplas en gång till ett recept." });
  }
});
export type ContentEngineRecipeInput = z.infer<typeof contentEngineRecipeInputSchema>;

export const contentEngineRecipeSchema = recipeInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineRecipe = z.infer<typeof contentEngineRecipeSchema>;

const destinationInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  destinationKind: contentEngineDestinationKindSchema,
  socialConnectionId: uuidSchema.nullable().default(null),
  newsletterAudienceId: uuidSchema.nullable().default(null),
  destinationConfig: contentEngineSafeJsonSchema.default({}),
  active: z.boolean().default(true),
});

function destinationHasSafeTarget(config: Record<string, unknown>): boolean {
  const route = typeof config.route === "string" ? config.route.trim() : "";
  if (isSafeInternalRoute(route)) return true;
  const targetUrl = typeof config.targetUrl === "string" ? config.targetUrl.trim() : "";
  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return true;
    } catch {
      return false;
    }
  }
  const target = typeof config.target === "string" ? config.target.trim() : "";
  return isSafeInternalRoute(target);
}

/** A leading slash is not enough: `//host` is an external scheme-relative URL. */
function isSafeInternalRoute(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\r\n]/.test(value);
}

export const contentEngineDestinationInputSchema = destinationInputBaseSchema.superRefine((value, context) => {
  if (value.socialConnectionId && value.newsletterAudienceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["socialConnectionId"], message: "En destination kan inte vara både social anslutning och mottagarlista." });
  }
  if (value.destinationKind === "social" && value.newsletterAudienceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["newsletterAudienceId"], message: "En social destination får inte peka på en mottagarlista." });
  }
  if (value.destinationKind === "newsletter" && value.socialConnectionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["socialConnectionId"], message: "En nyhetsbrevsdestination får inte peka på ett socialt konto." });
  }
  if (value.destinationKind !== "social" && value.socialConnectionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["socialConnectionId"], message: "Endast en social destination får peka på ett socialt konto." });
  }
  if (value.destinationKind !== "newsletter" && value.newsletterAudienceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["newsletterAudienceId"], message: "Endast en nyhetsbrevsdestination får peka på en mottagarlista." });
  }
  if (value.destinationKind === "social" && !value.socialConnectionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["socialConnectionId"], message: "En social destination behöver ett verifierat anslutet konto." });
  }
  if (value.destinationKind === "newsletter" && !value.newsletterAudienceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["newsletterAudienceId"], message: "En nyhetsbrevsdestination behöver en aktiv mottagarlista." });
  }
  if ((value.destinationKind === "rss" || value.destinationKind === "website") && !destinationHasSafeTarget(value.destinationConfig)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationConfig"], message: "RSS och webbplats behöver en säker intern route eller HTTPS-måladress." });
  }
});
export type ContentEngineDestinationInput = z.infer<typeof contentEngineDestinationInputSchema>;

export const contentEngineDestinationSchema = destinationInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deliveryAvailability: z.enum(["connected", "configuration_only"]),
});
export type ContentEngineDestination = z.infer<typeof contentEngineDestinationSchema>;

const distributionRuleInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  recipeId: uuidSchema,
  destinationId: uuidSchema,
  deliveryMode: contentEngineDeliveryModeSchema.default("manual"),
  scheduleConfig: contentEngineSafeJsonSchema.default({}),
  approvalRequired: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const contentEngineDistributionRuleInputSchema = distributionRuleInputBaseSchema.superRefine((value, context) => {
  if (value.deliveryMode === "scheduled" && Object.keys(value.scheduleConfig).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduleConfig"], message: "En schemalagd regel behöver en schemakonfiguration." });
  }
});
export type ContentEngineDistributionRuleInput = z.infer<typeof contentEngineDistributionRuleInputSchema>;

export const contentEngineDistributionRuleSchema = distributionRuleInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContentEngineDistributionRule = z.infer<typeof contentEngineDistributionRuleSchema>;

/** Safe picker values only — never OAuth ciphertexts, recipient e-mail, or tokens. */
export const contentEngineSocialConnectionOptionSchema = z.object({
  id: uuidSchema,
  label: z.string().min(1),
  provider: z.string().min(1),
  state: z.enum(["active", "needs_reauth", "disconnected", "error"]),
  connected: z.boolean(),
  updatedAt: timestampSchema,
});
export type ContentEngineSocialConnectionOption = z.infer<typeof contentEngineSocialConnectionOptionSchema>;

export const contentEngineNewsletterAudienceOptionSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  active: z.boolean(),
  updatedAt: timestampSchema,
});
export type ContentEngineNewsletterAudienceOption = z.infer<typeof contentEngineNewsletterAudienceOptionSchema>;

export const engineWorkspaceDataSchema = z.object({
  brandProfiles: z.array(contentEngineBrandProfileSchema),
  sources: z.array(contentEngineSourceSchema),
  modelPresets: z.array(contentEngineModelPresetSchema),
  modelPolicies: z.array(contentEngineModelPolicySchema),
  recipes: z.array(contentEngineRecipeSchema),
  destinations: z.array(contentEngineDestinationSchema),
  distributionRules: z.array(contentEngineDistributionRuleSchema),
  availableDestinations: z.object({
    socialConnections: z.array(contentEngineSocialConnectionOptionSchema),
    newsletterAudiences: z.array(contentEngineNewsletterAudienceOptionSchema),
  }),
});
export type EngineWorkspaceData = z.infer<typeof engineWorkspaceDataSchema>;

/** Exact, small GET response for a future `/api/content-engine` route. */
export const contentEngineReadResponseSchema = z.object({ data: engineWorkspaceDataSchema });
export type ContentEngineReadResponse = z.infer<typeof contentEngineReadResponseSchema>;

/**
 * Route handlers can parse this body for a generic `PUT /api/content-engine`
 * endpoint. `slug` is the idempotency key for every upsertable entity.
 */
export const contentEngineMutationRequestSchema = z.union([
  z.object({ entity: z.literal("brandProfile"), input: contentEngineBrandProfileInputSchema }).strict(),
  z.object({ entity: z.literal("source"), input: contentEngineSourceInputSchema }).strict(),
  z.object({ entity: z.literal("modelPreset"), input: contentEngineModelPresetInputSchema }).strict(),
  z.object({ entity: z.literal("modelPolicy"), input: contentEngineModelPolicyInputSchema }).strict(),
  z.object({ entity: z.literal("recipe"), input: contentEngineRecipeInputSchema }).strict(),
  z.object({ entity: z.literal("destination"), input: contentEngineDestinationInputSchema }).strict(),
  z.object({ entity: z.literal("distributionRule"), input: contentEngineDistributionRuleInputSchema }).strict(),
]);
export type ContentEngineMutationRequest = z.infer<typeof contentEngineMutationRequestSchema>;

export const contentEnginePatchRequestSchema = z.union([
  z.object({ entity: z.literal("brandProfile"), id: uuidSchema, input: contentEngineBrandProfileInputSchema }).strict(),
  z.object({ entity: z.literal("source"), id: uuidSchema, input: contentEngineSourceInputSchema }).strict(),
  z.object({ entity: z.literal("modelPreset"), id: uuidSchema, input: contentEngineModelPresetInputSchema }).strict(),
  z.object({ entity: z.literal("modelPolicy"), id: uuidSchema, input: contentEngineModelPolicyInputSchema }).strict(),
  z.object({ entity: z.literal("recipe"), id: uuidSchema, input: contentEngineRecipeInputSchema }).strict(),
  z.object({ entity: z.literal("destination"), id: uuidSchema, input: contentEngineDestinationInputSchema }).strict(),
  z.object({ entity: z.literal("distributionRule"), id: uuidSchema, input: contentEngineDistributionRuleInputSchema }).strict(),
]);
export type ContentEnginePatchRequest = z.infer<typeof contentEnginePatchRequestSchema>;

export const contentEngineDeleteRequestSchema = z.object({ entity: contentEngineEntitySchema, id: uuidSchema }).strict();
export type ContentEngineDeleteRequest = z.infer<typeof contentEngineDeleteRequestSchema>;

export const CONTENT_ENGINE_API_CONTRACT = {
  read: { method: "GET", path: "/api/content-engine", response: "{ data: EngineWorkspaceData }" },
  upsert: { method: "POST", path: "/api/content-engine", body: "ContentEngineMutationRequest" },
  patch: { method: "PATCH", path: "/api/content-engine", body: "ContentEnginePatchRequest" },
  remove: { method: "DELETE", path: "/api/content-engine", body: "ContentEngineDeleteRequest" },
} as const;
