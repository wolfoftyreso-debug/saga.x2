import { z } from "zod";

/**
 * Versioned planning presets for SAGA Ad Creative Studio.
 *
 * A preset prepares a canvas; it never promises that an external provider,
 * publisher or printer will accept the finished material. Google entries are
 * based on the linked official asset documentation. Social and print entries
 * are intentionally labelled as planning canvases and must be rechecked at
 * the point of purchase/delivery.
 */
export const SAGA_AD_CREATIVE_CATALOG_VERSION = "2026-08-v1";

export const SAGA_AD_CREATIVE_UNITS = ["px", "mm", "in"] as const;
export const SAGA_AD_CREATIVE_VARIANT_STATUSES = ["private_draft", "in_review", "approved"] as const;
export const SAGA_AD_CREATIVE_OBJECTIVES = ["awareness", "traffic", "leads", "sales", "retention", "recruitment"] as const;

export type SagaAdCreativeUnit = (typeof SAGA_AD_CREATIVE_UNITS)[number];
export type SagaAdCreativeVariantStatus = (typeof SAGA_AD_CREATIVE_VARIANT_STATUSES)[number];
export type SagaAdCreativeObjective = (typeof SAGA_AD_CREATIVE_OBJECTIVES)[number];
export type SagaAdCreativeMedium = "social" | "display" | "search" | "email" | "direct_mail" | "newspaper" | "poster" | "custom";

export type SagaAdCreativeInsets = { top: number; right: number; bottom: number; left: number };
export type SagaAdCreativeGeometry = {
  width: number;
  height: number;
  unit: SagaAdCreativeUnit;
  dpi: number | null;
  bleed: SagaAdCreativeInsets;
  safeZone: SagaAdCreativeInsets;
};

type SagaAdCreativePreset = {
  id: string;
  label: string;
  medium: SagaAdCreativeMedium;
  geometry: SagaAdCreativeGeometry | null;
  planningOnly: boolean;
  note: string;
  sourceUrls: readonly string[];
};

const zeroInsets: SagaAdCreativeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const planningBleed: SagaAdCreativeInsets = { top: 3, right: 3, bottom: 3, left: 3 };
const planningSafeZone: SagaAdCreativeInsets = { top: 5, right: 5, bottom: 5, left: 5 };
const googleSpecs = [
  "https://support.google.com/google-ads/answer/13676244",
  "https://support.google.com/google-ads/answer/9823397",
] as const;
const googleUploadedSpecs = ["https://support.google.com/google-ads/answer/1722096"] as const;
const linkedInSpecs = ["https://www.linkedin.com/help/linkedin/answer/a427596/"] as const;
const metaReelsGuidance = ["https://www.facebook.com/business/ads/facebook-instagram-reels-ads"] as const;

function px(width: number, height: number): SagaAdCreativeGeometry {
  return { width, height, unit: "px", dpi: null, bleed: zeroInsets, safeZone: zeroInsets };
}

function print(width: number, height: number): SagaAdCreativeGeometry {
  return { width, height, unit: "mm", dpi: 300, bleed: planningBleed, safeZone: planningSafeZone };
}

export const SAGA_AD_CREATIVE_PRESETS = [
  { id: "meta_feed_square_v1", label: "Meta flöde · kvadrat", medium: "social", geometry: px(1080, 1080), planningOnly: true, note: "Planeringscanvas för Facebook/Instagram-flöde. Kontrollera aktuella placements före leverans.", sourceUrls: metaReelsGuidance },
  { id: "meta_feed_portrait_4x5_v1", label: "Meta flöde · stående 4:5", medium: "social", geometry: px(1080, 1350), planningOnly: true, note: "Planeringscanvas för Facebook/Instagram-flöde. Kontrollera aktuella placements före leverans.", sourceUrls: metaReelsGuidance },
  { id: "meta_reels_stories_9x16_v1", label: "Meta Reels/Stories · 9:16", medium: "social", geometry: px(1080, 1920), planningOnly: true, note: "Planeringscanvas för helskärmsformat. Kontrollera safe zones och aktuella placements före leverans.", sourceUrls: metaReelsGuidance },
  { id: "linkedin_single_image_landscape_v1", label: "LinkedIn · en bild liggande", medium: "social", geometry: px(1200, 628), planningOnly: true, note: "Planeringscanvas för LinkedIn. Kontrollera aktuell annonsguide före leverans.", sourceUrls: linkedInSpecs },
  { id: "linkedin_single_image_square_v1", label: "LinkedIn · en bild kvadrat", medium: "social", geometry: px(1200, 1200), planningOnly: true, note: "Planeringscanvas för LinkedIn. Kontrollera aktuell annonsguide före leverans.", sourceUrls: linkedInSpecs },
  { id: "linkedin_single_image_portrait_4x5_v1", label: "LinkedIn · en bild stående", medium: "social", geometry: px(720, 900), planningOnly: true, note: "Planeringscanvas för LinkedIn. Kontrollera aktuell annonsguide före leverans.", sourceUrls: linkedInSpecs },
  { id: "google_responsive_display_landscape_v1", label: "Google responsiv display · liggande", medium: "display", geometry: px(1200, 628), planningOnly: false, note: "Google rekommenderar 1,91:1 som responsiv displaybild. Verifiera konto-/kampanjkrav vid leverans.", sourceUrls: googleSpecs },
  { id: "google_responsive_display_square_v1", label: "Google responsiv display · kvadrat", medium: "display", geometry: px(1200, 1200), planningOnly: false, note: "Google rekommenderar 1:1 som responsiv displaybild. Verifiera konto-/kampanjkrav vid leverans.", sourceUrls: googleSpecs },
  { id: "google_responsive_display_portrait_v1", label: "Google responsiv display · stående", medium: "display", geometry: px(900, 1600), planningOnly: false, note: "Google rekommenderar 9:16 som responsiv displaybild. Verifiera konto-/kampanjkrav vid leverans.", sourceUrls: googleSpecs },
  { id: "google_display_300x250_v1", label: "Google Display · 300×250", medium: "display", geometry: px(300, 250), planningOnly: false, note: "Vanligt uppladdat displayformat. Kontrollera marknad och kampanj före leverans.", sourceUrls: googleUploadedSpecs },
  { id: "google_display_728x90_v1", label: "Google Display · 728×90", medium: "display", geometry: px(728, 90), planningOnly: false, note: "Vanligt uppladdat displayformat. Kontrollera marknad och kampanj före leverans.", sourceUrls: googleUploadedSpecs },
  { id: "google_display_300x600_v1", label: "Google Display · 300×600", medium: "display", geometry: px(300, 600), planningOnly: false, note: "Vanligt uppladdat displayformat. Kontrollera marknad och kampanj före leverans.", sourceUrls: googleUploadedSpecs },
  { id: "google_display_160x600_v1", label: "Google Display · 160×600", medium: "display", geometry: px(160, 600), planningOnly: false, note: "Vanligt uppladdat displayformat. Kontrollera marknad och kampanj före leverans.", sourceUrls: googleUploadedSpecs },
  { id: "google_display_320x50_v1", label: "Google Display · 320×50", medium: "display", geometry: px(320, 50), planningOnly: false, note: "Vanligt mobilformat. Kontrollera marknad och kampanj före leverans.", sourceUrls: googleUploadedSpecs },
  { id: "google_responsive_search_text_v1", label: "Google Sök · texttillgångar", medium: "search", geometry: null, planningOnly: false, note: "Ingen bildcanvas. Planera flera rubriker och beskrivningar; kontrollera aktuella teckenkrav före leverans.", sourceUrls: googleSpecs },
  { id: "email_600px_planning_v1", label: "E-postutskick · 600 px", medium: "email", geometry: px(600, 1200), planningOnly: true, note: "Planeringscanvas för e-post. Den faktiska HTML-mallen styr slutlig höjd och responsivitet.", sourceUrls: [] },
  { id: "direct_mail_a6_v1", label: "Direktutskick · A6", medium: "direct_mail", geometry: print(105, 148), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeri och postdistributör före export.", sourceUrls: [] },
  { id: "direct_mail_dl_v1", label: "Direktutskick · DL", medium: "direct_mail", geometry: print(110, 220), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeri och postdistributör före export.", sourceUrls: [] },
  { id: "newspaper_provider_spec_v1", label: "Tidningsannons · mediespec krävs", medium: "newspaper", geometry: null, planningOnly: true, note: "Tidningar har ingen universell storlek. Ange förlagets faktiska mått, utfall, färgprofil och deadline som custom-format.", sourceUrls: [] },
  { id: "poster_a4_v1", label: "Affisch · A4", medium: "poster", geometry: print(210, 297), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeriets specifikation före export.", sourceUrls: [] },
  { id: "poster_a3_v1", label: "Affisch · A3", medium: "poster", geometry: print(297, 420), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeriets specifikation före export.", sourceUrls: [] },
  { id: "poster_a2_v1", label: "Affisch · A2", medium: "poster", geometry: print(420, 594), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeriets specifikation före export.", sourceUrls: [] },
  { id: "poster_a1_v1", label: "Affisch · A1", medium: "poster", geometry: print(594, 841), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeriets specifikation före export.", sourceUrls: [] },
  { id: "poster_50x70_v1", label: "Affisch · 50×70 cm", medium: "poster", geometry: print(500, 700), planningOnly: true, note: "Planeringsformat med 300 DPI och 3 mm föreslaget utfall. Kontrollera tryckeriets specifikation före export.", sourceUrls: [] },
] as const satisfies readonly SagaAdCreativePreset[];

export type SagaAdCreativePresetId = (typeof SAGA_AD_CREATIVE_PRESETS)[number]["id"];

const presetIds = new Set<string>(SAGA_AD_CREATIVE_PRESETS.map((preset) => preset.id));
export const sagaAdCreativePresetIdSchema = z.string().refine(
  (value): value is SagaAdCreativePresetId => presetIds.has(value),
  "Välj ett känt SAGA-format eller skapa ett eget format.",
);

const finite = (min: number, max: number, message: string) => z.number().finite().min(min, message).max(max, message);
const insetsSchema = z.object({
  top: finite(0, 10_000, "Marginalen är ogiltig."),
  right: finite(0, 10_000, "Marginalen är ogiltig."),
  bottom: finite(0, 10_000, "Marginalen är ogiltig."),
  left: finite(0, 10_000, "Marginalen är ogiltig."),
}).strict();

export const sagaAdCreativeGeometrySchema = z.object({
  width: finite(1, 100_000, "Ange en bredd inom rimligt spann."),
  height: finite(1, 100_000, "Ange en höjd inom rimligt spann."),
  unit: z.enum(SAGA_AD_CREATIVE_UNITS),
  dpi: z.number().int().min(36).max(1_200).nullable(),
  bleed: insetsSchema,
  safeZone: insetsSchema,
}).strict().superRefine((value, context) => {
  if ((value.unit === "mm" || value.unit === "in") && value.dpi === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dpi"], message: "Tryckformat i mm eller tum kräver DPI." });
  }
  if (value.unit === "px" && value.dpi !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dpi"], message: "Digitala px-format ska inte få en påhittad DPI." });
  }
  const horizontal = value.safeZone.left + value.safeZone.right;
  const vertical = value.safeZone.top + value.safeZone.bottom;
  if (horizontal >= value.width || vertical >= value.height) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["safeZone"], message: "Safe zone måste lämna en synlig arbetsyta." });
  }
});

const copySchema = z.object({
  headline: z.string().trim().max(240).default(""),
  primaryText: z.string().trim().max(3_000).default(""),
  description: z.string().trim().max(600).default(""),
  callToAction: z.string().trim().max(300).default(""),
  destinationUrl: z.string().url("Måladressen måste vara en giltig URL.").max(2_000).nullable().default(null),
  legalText: z.string().trim().max(2_000).default(""),
}).strict();

const customFormatInputSchema = z.object({
  kind: z.literal("custom"),
  label: z.string().trim().min(2).max(120),
  medium: z.enum(["social", "display", "search", "email", "direct_mail", "newspaper", "poster", "custom"]),
  geometry: sagaAdCreativeGeometrySchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.medium !== "search" && value.geometry === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["geometry"], message: "Ett eget visuellt eller tryckt format behöver mått." });
  }
});

const formatInputSchema = z.union([
  z.object({ kind: z.literal("preset"), presetId: sagaAdCreativePresetIdSchema }).strict(),
  customFormatInputSchema,
]);

export const sagaAdCreativeVariantInputSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(2).max(160),
  status: z.enum(SAGA_AD_CREATIVE_VARIANT_STATUSES).default("private_draft"),
  format: formatInputSchema,
  copy: copySchema.default({ headline: "", primaryText: "", description: "", callToAction: "", destinationUrl: null, legalText: "" }),
  assetDirection: z.string().trim().max(1_500).default(""),
}).strict();

export const sagaAdCreativeMasterBriefSchema = z.object({
  objective: z.enum(SAGA_AD_CREATIVE_OBJECTIVES),
  audience: z.string().trim().min(2).max(300),
  message: z.string().trim().min(2).max(3_000),
  callToAction: z.string().trim().min(2).max(300),
  sourceReference: z.string().trim().max(500).default(""),
}).strict();

export const sagaAdCreativeProjectCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  createIdempotencyKey: z.string().uuid(),
  masterBrief: sagaAdCreativeMasterBriefSchema,
  variants: z.array(sagaAdCreativeVariantInputSchema).min(1).max(24),
}).strict().superRefine((value, context) => assertUniqueVariantIds(value.variants, context));

export const sagaAdCreativeProjectUpdateSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  name: z.string().trim().min(2).max(160).optional(),
  masterBrief: sagaAdCreativeMasterBriefSchema.optional(),
  variants: z.array(sagaAdCreativeVariantInputSchema).min(1).max(24).optional(),
}).strict().superRefine((value, context) => {
  if (value.name === undefined && value.masterBrief === undefined && value.variants === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ändra minst ett projektfält." });
  }
  if (value.variants) assertUniqueVariantIds(value.variants, context);
});

export const sagaAdCreativeProjectDeleteSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
}).strict();

function assertUniqueVariantIds(
  variants: Array<z.infer<typeof sagaAdCreativeVariantInputSchema>>,
  context: z.RefinementCtx,
) {
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Varje formatvariant behöver ett eget id." });
  }
}

export type SagaAdCreativeMasterBrief = z.infer<typeof sagaAdCreativeMasterBriefSchema>;
export type SagaAdCreativeVariantInput = z.infer<typeof sagaAdCreativeVariantInputSchema>;
export type SagaAdCreativeProjectCreateInput = z.infer<typeof sagaAdCreativeProjectCreateSchema>;
export type SagaAdCreativeProjectUpdateInput = z.infer<typeof sagaAdCreativeProjectUpdateSchema>;

export type SagaAdCreativeFormatSnapshot = {
  kind: "preset";
  presetId: SagaAdCreativePresetId;
  catalogVersion: typeof SAGA_AD_CREATIVE_CATALOG_VERSION;
  label: string;
  medium: SagaAdCreativeMedium;
  geometry: SagaAdCreativeGeometry | null;
  planningOnly: boolean;
  note: string;
  sourceUrls: readonly string[];
  externalDelivery: "unavailable";
} | {
  kind: "custom";
  label: string;
  medium: SagaAdCreativeMedium;
  geometry: SagaAdCreativeGeometry | null;
  planningOnly: true;
  note: string;
  sourceUrls: readonly [];
  externalDelivery: "unavailable";
};

export type SagaAdCreativeVariant = Omit<SagaAdCreativeVariantInput, "format"> & { format: SagaAdCreativeFormatSnapshot };
export type SagaAdCreativeProject = {
  id: string;
  name: string;
  masterBrief: SagaAdCreativeMasterBrief;
  variants: SagaAdCreativeVariant[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export function findSagaAdCreativePreset(id: string): SagaAdCreativePreset | null {
  return SAGA_AD_CREATIVE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function materializeSagaAdCreativeVariant(input: SagaAdCreativeVariantInput): SagaAdCreativeVariant {
  const format = input.format.kind === "preset"
    ? snapshotPreset(input.format.presetId)
    : {
      kind: "custom" as const,
      label: input.format.label,
      medium: input.format.medium,
      geometry: input.format.geometry,
      planningOnly: true as const,
      note: input.format.medium === "newspaper"
        ? "Kontrollera förlagets exakta mått, utfall, färgprofil och deadline före export."
        : "Eget format. Kontrollera den valda leverantörens krav före export.",
      sourceUrls: [] as const,
      externalDelivery: "unavailable" as const,
    };
  return { ...input, format };
}

function snapshotPreset(id: SagaAdCreativePresetId): Extract<SagaAdCreativeFormatSnapshot, { kind: "preset" }> {
  const preset = findSagaAdCreativePreset(id);
  if (!preset) throw new Error("Okänt SAGA-format.");
  return {
    kind: "preset",
    presetId: preset.id as SagaAdCreativePresetId,
    catalogVersion: SAGA_AD_CREATIVE_CATALOG_VERSION,
    label: preset.label,
    medium: preset.medium,
    geometry: preset.geometry,
    planningOnly: preset.planningOnly,
    note: preset.note,
    sourceUrls: preset.sourceUrls,
    externalDelivery: "unavailable",
  };
}

/** Converts a server snapshot back into the small, safe editor input shape. */
export function sagaAdCreativeVariantInputFromProject(variant: SagaAdCreativeVariant): SagaAdCreativeVariantInput {
  const format = variant.format.kind === "preset"
    ? { kind: "preset" as const, presetId: variant.format.presetId }
    : { kind: "custom" as const, label: variant.format.label, medium: variant.format.medium, geometry: variant.format.geometry };
  return {
    id: variant.id,
    label: variant.label,
    status: variant.status,
    format,
    copy: variant.copy,
    assetDirection: variant.assetDirection,
  };
}

const storedPresetFormatSchema = z.object({
  kind: z.literal("preset"),
  presetId: sagaAdCreativePresetIdSchema,
  catalogVersion: z.literal(SAGA_AD_CREATIVE_CATALOG_VERSION),
  label: z.string().trim().min(2).max(160),
  medium: z.enum(["social", "display", "search", "email", "direct_mail", "newspaper", "poster", "custom"]),
  geometry: sagaAdCreativeGeometrySchema.nullable(),
  planningOnly: z.boolean(),
  note: z.string().trim().max(600),
  sourceUrls: z.array(z.string().url().max(2_000)).max(4),
  externalDelivery: z.literal("unavailable"),
}).strict();

const storedCustomFormatSchema = z.object({
  kind: z.literal("custom"),
  label: z.string().trim().min(2).max(120),
  medium: z.enum(["social", "display", "search", "email", "direct_mail", "newspaper", "poster", "custom"]),
  geometry: sagaAdCreativeGeometrySchema.nullable(),
  planningOnly: z.literal(true),
  note: z.string().trim().max(600),
  sourceUrls: z.array(z.string().url()).length(0),
  externalDelivery: z.literal("unavailable"),
}).strict();

const storedVariantSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(2).max(160),
  status: z.enum(SAGA_AD_CREATIVE_VARIANT_STATUSES),
  format: z.discriminatedUnion("kind", [storedPresetFormatSchema, storedCustomFormatSchema]),
  copy: copySchema,
  assetDirection: z.string().trim().max(1_500),
}).strict();

/** Parses only server-materialized format snapshots when reading from Neon. */
export function parseSagaAdCreativeStoredVariants(value: unknown): SagaAdCreativeVariant[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseJsonArray(value)
      : null;
  if (!raw) throw new Error("Annonsprojektets format kunde inte läsas säkert.");
  const variants = z.array(storedVariantSchema).min(1).max(24).safeParse(raw);
  if (!variants.success) throw new Error("Annonsprojektets format kunde inte läsas säkert.");
  if (new Set(variants.data.map((variant) => variant.id)).size !== variants.data.length) {
    throw new Error("Annonsprojektets format kunde inte läsas säkert.");
  }
  return variants.data as SagaAdCreativeVariant[];
}

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
