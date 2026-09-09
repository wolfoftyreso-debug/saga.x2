import { z } from "zod";
import { contentEngineSourceKindSchema } from "@/lib/domain/content-engine";

/**
 * A workspace's editorial doctrine. It is deliberately a typed, browser-safe
 * configuration rather than a generic prompt blob: no secrets, provider
 * credentials, delivery instructions, or caller-provided workspace identity
 * can enter this contract.
 */

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().min(1);
const conciseTextSchema = z.string().trim().min(1).max(160);
const domainSchema = z.string().trim().toLowerCase().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Ange ett domännamn utan http:// eller sökväg.",
);

export const SAGA_EDITORIAL_EVIDENCE_THRESHOLDS = [
  "one_allowed_source",
  "one_primary_or_two_independent",
  "two_independent_sources",
  "primary_source_required",
] as const;
export const SAGA_EDITORIAL_CONTROL_MODES = ["advisory", "review_required", "strict"] as const;
export const SAGA_EDITORIAL_SOURCE_SELECTION_ROLES = ["required", "preferred"] as const;

export type SagaEditorialEvidenceThreshold = (typeof SAGA_EDITORIAL_EVIDENCE_THRESHOLDS)[number];
export type SagaEditorialControlMode = (typeof SAGA_EDITORIAL_CONTROL_MODES)[number];
export type SagaEditorialSourceSelectionRole = (typeof SAGA_EDITORIAL_SOURCE_SELECTION_ROLES)[number];

export const sagaEditorialEvidenceThresholdSchema = z.enum(SAGA_EDITORIAL_EVIDENCE_THRESHOLDS);
export const sagaEditorialControlModeSchema = z.enum(SAGA_EDITORIAL_CONTROL_MODES);
export const sagaEditorialSourceSelectionRoleSchema = z.enum(SAGA_EDITORIAL_SOURCE_SELECTION_ROLES);

export const sagaEditorialToneSchema = z.object({
  directness: z.number().int().min(1).max(5).default(4),
  warmth: z.number().int().min(1).max(5).default(3),
  formality: z.number().int().min(1).max(5).default(2),
  technicalDepth: z.number().int().min(1).max(5).default(3),
  pointOfView: z.enum(["neutral", "we", "you"]).default("neutral"),
  avoidJargon: z.boolean().default(true),
  preferredWords: z.array(conciseTextSchema).max(40).default([]),
  avoidedWords: z.array(conciseTextSchema).max(40).default([]),
}).strict().default({});
export type SagaEditorialTone = z.infer<typeof sagaEditorialToneSchema>;

export const sagaEditorialConstructionSchema = z.object({
  openingStyle: z.enum(["direct", "evidence_first", "situation", "question"]).default("direct"),
  paragraphStyle: z.enum(["short", "mixed", "long"]).default("short"),
  callToAction: z.enum(["none", "soft", "direct"]).default("soft"),
  useHeadings: z.boolean().default(true),
  maxParagraphs: z.number().int().min(1).max(16).default(5),
  maxSentencesPerParagraph: z.number().int().min(1).max(8).default(3),
  includeSourceNotes: z.boolean().default(true),
}).strict().default({});
export type SagaEditorialConstruction = z.infer<typeof sagaEditorialConstructionSchema>;

export const sagaEditorialSourceRulesSchema = z.object({
  requireAllowedSources: z.boolean().default(true),
  requireCitations: z.boolean().default(true),
  minimumUniqueSources: z.number().int().min(1).max(5).default(1),
  allowedSourceKinds: z.array(contentEngineSourceKindSchema).min(1).max(5).default(["website", "rss", "document", "manual"]),
  blockedDomains: z.array(domainSchema).max(60).default([]),
  allowUnsupportedInference: z.boolean().default(false),
}).strict().default({});
export type SagaEditorialSourceRules = z.infer<typeof sagaEditorialSourceRulesSchema>;

export const sagaEditorialSourceSelectionSchema = z.object({
  sourceId: uuidSchema,
  role: sagaEditorialSourceSelectionRoleSchema,
  priority: z.number().int().min(1).max(50),
}).strict();
export type SagaEditorialSourceSelection = z.infer<typeof sagaEditorialSourceSelectionSchema>;

const sagaEditorialLensInputBaseSchema = z.object({
  brandProfileId: uuidSchema.nullable().default(null),
  name: z.string().trim().min(2).max(160).default("SAGA Editorial Lens"),
  mission: z.string().trim().max(6_000).default(""),
  strategicPerspective: z.string().trim().max(6_000).default(""),
  industry: z.string().trim().max(240).default(""),
  audience: z.string().trim().max(3_000).default(""),
  themes: z.array(conciseTextSchema).max(40).default([]),
  forbiddenThemes: z.array(conciseTextSchema).max(40).default([]),
  tone: sagaEditorialToneSchema,
  construction: sagaEditorialConstructionSchema,
  evidenceThreshold: sagaEditorialEvidenceThresholdSchema.default("one_primary_or_two_independent"),
  sourceRules: sagaEditorialSourceRulesSchema,
  sourceSelections: z.array(sagaEditorialSourceSelectionSchema).max(50).default([]),
  controlMode: sagaEditorialControlModeSchema.default("review_required"),
  active: z.boolean().default(true),
}).strict();

export const sagaEditorialLensInputSchema = sagaEditorialLensInputBaseSchema.superRefine((value, context) => {
  const normalizedThemes = new Set(value.themes.map((theme) => theme.toLocaleLowerCase("sv-SE")));
  const normalizedForbidden = new Set(value.forbiddenThemes.map((theme) => theme.toLocaleLowerCase("sv-SE")));
  if (normalizedThemes.size !== value.themes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["themes"], message: "Ett tema får bara anges en gång." });
  }
  if (normalizedForbidden.size !== value.forbiddenThemes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["forbiddenThemes"], message: "Ett förbjudet tema får bara anges en gång." });
  }
  for (const theme of normalizedThemes) {
    if (normalizedForbidden.has(theme)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["forbiddenThemes"], message: "Ett tema kan inte samtidigt vara tillåtet och förbjudet." });
      break;
    }
  }
  if (new Set(value.sourceRules.allowedSourceKinds).size !== value.sourceRules.allowedSourceKinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRules", "allowedSourceKinds"], message: "En källtyp får bara väljas en gång." });
  }
  if (new Set(value.sourceRules.blockedDomains).size !== value.sourceRules.blockedDomains.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRules", "blockedDomains"], message: "En blockerad domän får bara anges en gång." });
  }
  const sourceIds = new Set(value.sourceSelections.map((selection) => selection.sourceId));
  const priorities = new Set(value.sourceSelections.map((selection) => selection.priority));
  if (sourceIds.size !== value.sourceSelections.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceSelections"], message: "Samma källa får bara väljas en gång i Lens." });
  }
  if (priorities.size !== value.sourceSelections.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceSelections"], message: "Varje källprioritet måste vara unik." });
  }
  if (value.evidenceThreshold === "two_independent_sources" && value.sourceRules.minimumUniqueSources < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRules", "minimumUniqueSources"], message: "Två oberoende källor kräver minst två unika källor." });
  }
  if (value.controlMode === "strict" && (!value.sourceRules.requireAllowedSources || !value.sourceRules.requireCitations)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRules"], message: "Strikt läge kräver tillåtna källor och synliga belägg." });
  }
  const preferredWords = new Set(value.tone.preferredWords.map((word) => word.toLocaleLowerCase("sv-SE")));
  if (value.tone.avoidedWords.some((word) => preferredWords.has(word.toLocaleLowerCase("sv-SE")))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tone"], message: "Ett ord kan inte både föredras och undvikas." });
  }
});
// Callers may intentionally omit defaulted controls (`tone: {}`, for
// example); repository writes parse this input into the complete output
// shape before it reaches Neon.
export type SagaEditorialLensInput = z.input<typeof sagaEditorialLensInputSchema>;

export const sagaEditorialLensSchema = sagaEditorialLensInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  updatedByUserId: uuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SagaEditorialLens = z.infer<typeof sagaEditorialLensSchema>;

/** Safe shape intended for a future model prompt builder, never a credential channel. */
/**
 * The small, credential-free projection that may cross from the workspace
 * repository into a server-only generation or quality worker. Keeping it as
 * its own schema prevents a worker from accidentally receiving Lens source
 * IDs, profile IDs, or a whole database row.
 */
export const sagaEditorialLensPromptContextSchema = sagaEditorialLensInputBaseSchema.pick({
  mission: true,
  strategicPerspective: true,
  industry: true,
  audience: true,
  themes: true,
  forbiddenThemes: true,
  tone: true,
  construction: true,
  evidenceThreshold: true,
  sourceRules: true,
  controlMode: true,
});
export type SagaEditorialLensPromptContext = z.infer<typeof sagaEditorialLensPromptContextSchema>;

export function sagaEditorialLensPromptContext(lens: SagaEditorialLens): SagaEditorialLensPromptContext {
  return {
    mission: lens.mission,
    strategicPerspective: lens.strategicPerspective,
    industry: lens.industry,
    audience: lens.audience,
    themes: lens.themes,
    forbiddenThemes: lens.forbiddenThemes,
    tone: lens.tone,
    construction: lens.construction,
    evidenceThreshold: lens.evidenceThreshold,
    sourceRules: lens.sourceRules,
    controlMode: lens.controlMode,
  };
}

export const sagaEditorialLensReadResponseSchema = z.object({ data: sagaEditorialLensSchema.nullable() });
export type SagaEditorialLensReadResponse = z.infer<typeof sagaEditorialLensReadResponseSchema>;
export const sagaEditorialLensWriteResponseSchema = z.object({ data: sagaEditorialLensSchema });
export type SagaEditorialLensWriteResponse = z.infer<typeof sagaEditorialLensWriteResponseSchema>;

export const SAGA_EDITORIAL_LENS_API_CONTRACT = {
  read: { method: "GET", path: "/api/content-engine/editorial-lens", response: "{ data: SagaEditorialLens | null }" },
  save: { method: "PUT", path: "/api/content-engine/editorial-lens", body: "SagaEditorialLensInput" },
  patch: { method: "PATCH", path: "/api/content-engine/editorial-lens", body: "SagaEditorialLensInput" },
  remove: { method: "DELETE", path: "/api/content-engine/editorial-lens", response: "{ deleted: boolean }" },
} as const;
