import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

/**
 * The intentionally small, vendor-neutral workflow contract used by the ad
 * builder. It stores strategy and a publish intent, never credentials or a
 * provider-specific campaign payload. Provider execution gets its own
 * reviewed integration boundary later.
 */
export const AD_AUTOMATION_DESTINATION_PROVIDERS = [
  "meta_ads",
  "google_ads",
  "linkedin_ads",
  "facebook_page",
  "instagram",
  "linkedin",
  "newsletter",
  "rss",
] as const;

export const AD_AUTOMATION_OBJECTIVES = ["awareness", "traffic", "leads", "sales"] as const;
export const AD_AUTOMATION_CREATIVE_FORMATS = ["short_form_video", "paid_social", "display"] as const;
export const AD_AUTOMATION_MEDIA_SOURCES = ["ai", "stock", "owned", "mixed"] as const;
export const AD_AUTOMATION_TRIGGER_KINDS = ["manual", "schedule", "signal"] as const;
export const AD_AUTOMATION_SCHEDULE_MODES = ["manual", "weekly_count", "cron"] as const;

export type AdAutomationDestinationProvider = (typeof AD_AUTOMATION_DESTINATION_PROVIDERS)[number];
export type AdAutomationObjective = (typeof AD_AUTOMATION_OBJECTIVES)[number];
export type AdAutomationCreativeFormat = (typeof AD_AUTOMATION_CREATIVE_FORMATS)[number];
export type AdAutomationMediaSource = (typeof AD_AUTOMATION_MEDIA_SOURCES)[number];
export type AdAutomationTriggerKind = (typeof AD_AUTOMATION_TRIGGER_KINDS)[number];
export type AdAutomationScheduleMode = (typeof AD_AUTOMATION_SCHEDULE_MODES)[number];

const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som YYYY-MM-DD.");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ange tid som HH:MM.");
const timezoneSchema = z.string().min(3).max(80).refine(
  isValidIanaTimezone,
  "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm.",
);
const simpleCronSchema = z.string().trim().min(9).max(160).regex(
  /^[0-5]?\d\s+(?:[01]?\d|2[0-3])\s+\*\s+\*\s+(?:\*|[0-6](?:,[0-6])*)$/,
  "Ange enkel cron: minut timme * * veckodag, till exempel 0 9 * * 1,3,5.",
);

/**
 * Client-safe mirror of SAGA Creative Safety's evidence-shaped brief. The
 * server validates this again with the canonical safety engine before storing
 * or testing it, so a client cannot bypass the unsafe-scene checks.
 */
export const adAutomationCreativeBriefSchema = z.object({
  format: z.enum(AD_AUTOMATION_CREATIVE_FORMATS),
  hook: z.string().trim().min(2).max(1_200),
  value: z.string().trim().min(2).max(1_200),
  offer: z.object({
    copy: z.string().trim().min(2).max(900),
    terms: z.string().trim().max(2_000).default(""),
    /**
     * V1 has no server-owned campaign/offer registry yet. The browser may
     * attach a source note, but may never self-attest that a commercial claim
     * is verified. A later server-side record can introduce `verified`.
     */
    verification: z.object({
      status: z.literal("unverified").default("unverified"),
      sourceReference: z.string().trim().max(240).default(""),
    }).strict().default({ status: "unverified", sourceReference: "" }),
  }).strict(),
  callToAction: z.string().trim().min(2).max(1_200),
  visualMetaphor: z.enum(["calendar_turn", "day_to_evening", "tread_transition", "prepared_shelf"]),
  customVisualDirection: z.string().trim().max(1_500).default(""),
}).strict();

export const adAutomationDestinationSchema = z.object({
  /** Stable canvas-node key, not an advertising account or secret. */
  id: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,79}$/i, "Destinationen behöver ett stabilt id."),
  provider: z.enum(AD_AUTOMATION_DESTINATION_PROVIDERS),
  label: z.string().trim().min(2).max(120),
  campaignName: z.string().trim().max(160).nullable().optional(),
  destinationUrl: z.string().url("Måladressen är ogiltig.").max(2_000).nullable().optional(),
}).strict();

export const adAutomationWorkflowSchema = z.object({
  trigger: z.object({
    kind: z.enum(AD_AUTOMATION_TRIGGER_KINDS),
    summary: z.string().trim().max(500).nullable().optional(),
  }).strict(),
  creative: z.object({
    objective: z.enum(AD_AUTOMATION_OBJECTIVES),
    /** Hook → value → verified offer → CTA. Checked by SAGA Creative Safety server-side. */
    creativeBrief: adAutomationCreativeBriefSchema,
    mediaSource: z.enum(AD_AUTOMATION_MEDIA_SOURCES),
  }).strict(),
  /** A first version always holds the work for human review. */
  review: z.object({
    required: z.literal(true),
  }).strict(),
  schedule: z.object({
    mode: z.enum(AD_AUTOMATION_SCHEDULE_MODES),
    timezone: timezoneSchema,
    weeklyCount: z.number().int().min(1).max(7).nullable(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    localTimes: z.array(timeSchema).max(7),
    cronExpression: simpleCronSchema.nullable(),
    startsOn: dateSchema.nullable(),
    endsOn: dateSchema.nullable(),
  }).strict(),
  destinations: z.array(adAutomationDestinationSchema).min(1).max(12),
}).strict().superRefine((value, context) => {
  const uniqueDestinationIds = new Set(value.destinations.map((destination) => destination.id));
  if (uniqueDestinationIds.size !== value.destinations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinations"], message: "Varje destination behöver ett eget id." });
  }

  if (value.trigger.kind === "manual" && value.schedule.mode !== "manual") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "mode"], message: "En manuell trigger använder manuell planering." });
  }
  if (value.trigger.kind === "schedule" && value.schedule.mode === "manual") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "mode"], message: "En schemalagd trigger behöver veckorytm eller cron." });
  }
  if (value.trigger.kind === "signal" && value.schedule.mode !== "manual") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "mode"], message: "Signalmotorn är inte ansluten ännu; spara den utan aktiv planering." });
  }

  if (value.schedule.mode === "manual") {
    if (value.schedule.weeklyCount || value.schedule.weekdays.length || value.schedule.localTimes.length || value.schedule.cronExpression) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: "Manuell planering får inte innehålla tid eller cron." });
    }
  }
  if (value.schedule.mode === "weekly_count") {
    if (!value.schedule.weeklyCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "weeklyCount"], message: "Ange antal körningar per vecka." });
    }
    if (!value.schedule.localTimes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "localTimes"], message: "Ange minst en lokal tid." });
    }
    if (value.schedule.cronExpression) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "cronExpression"], message: "Veckorytm använder inte cron." });
    }
    if (value.schedule.weekdays.length && value.schedule.weeklyCount && value.schedule.weekdays.length !== value.schedule.weeklyCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "weekdays"], message: "Välj lika många veckodagar som körningar, eller låt dem vara tomma för fördelning." });
    }
    if (value.schedule.localTimes.length !== 1 && value.schedule.weeklyCount && value.schedule.localTimes.length !== value.schedule.weeklyCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "localTimes"], message: "Ange en återkommande tid eller en tid per veckokörning." });
    }
  }
  if (value.schedule.mode === "cron") {
    if (!value.schedule.cronExpression) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "cronExpression"], message: "Ange ett cron-uttryck." });
    }
    if (value.schedule.weeklyCount || value.schedule.weekdays.length || value.schedule.localTimes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: "Cron använder inte veckorytmens fält." });
    }
  }
  if (value.schedule.startsOn && value.schedule.endsOn && value.schedule.startsOn > value.schedule.endsOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "endsOn"], message: "Slutdatum kan inte vara före startdatum." });
  }
});

const adAutomationInputBaseSchema = z.object({
  name: z.string().trim().min(2).max(160),
  active: z.boolean(),
  workflow: adAutomationWorkflowSchema,
}).strict();

function refineAdAutomationInput(
  value: z.infer<typeof adAutomationInputBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (value.active && (value.workflow.trigger.kind !== "schedule" || value.workflow.schedule.mode === "manual")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["active"],
      message: "Endast en färdig schematrigger kan aktiveras. Signal- och extern annonsleverans är inte anslutna.",
    });
  }
  // A custom prompt is necessarily advisory until it has a dedicated visual
  // safety model. Scheduled V1 only permits the finite, reviewed metaphor
  // vocabulary above. Manual draft tests may retain a custom direction, which
  // is still checked by the canonical Creative Safety service before save.
  if (value.workflow.trigger.kind === "schedule" && value.workflow.creative.creativeBrief.customVisualDirection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workflow", "creative", "creativeBrief", "customVisualDirection"],
      message: "Schemalagda V1-flöden använder endast SAGA:s validerade visuella metaforer. Anpassad visuell riktning är endast rådgivande i manuella utkast.",
    });
  }
}

export const adAutomationInputSchema = adAutomationInputBaseSchema.superRefine(refineAdAutomationInput);

/**
 * A create key makes an interrupted canvas save safe to retry. It is scoped
 * by workspace in Neon and is never part of the workflow itself.
 */
export const adAutomationCreateSchema = adAutomationInputBaseSchema.extend({
  createIdempotencyKey: uuidSchema,
}).strict().superRefine(refineAdAutomationInput);

/** PATCH accepts an all-or-nothing workflow so a partially moved canvas never corrupts a saved flow. */
export const adAutomationUpdateSchema = adAutomationInputBaseSchema.partial().extend({
  /** Optimistic lock for canvas saves. Read `automation.revision` before PATCH. */
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
}).strict();
export const adAutomationIdSchema = uuidSchema;
export const adAutomationManualTestInputSchema = z.object({ idempotencyKey: uuidSchema }).strict();

export type AdAutomationDestination = z.infer<typeof adAutomationDestinationSchema>;
export type AdAutomationCreativeBrief = z.infer<typeof adAutomationCreativeBriefSchema>;
export type AdAutomationWorkflow = z.infer<typeof adAutomationWorkflowSchema>;
export type AdAutomationInput = z.infer<typeof adAutomationInputSchema>;
export type AdAutomationCreateInput = z.infer<typeof adAutomationCreateSchema>;
export type AdAutomationUpdateInput = z.infer<typeof adAutomationUpdateSchema>;

export type AdAutomationDestinationExecution = {
  destinationId: string;
  provider: AdAutomationDestinationProvider;
  status: "unavailable";
  message: string;
};

export type AdAutomationView = {
  id: string;
  name: string;
  active: boolean;
  revision: number;
  workflow: AdAutomationWorkflow;
  destinations: Array<AdAutomationDestination & { execution: AdAutomationDestinationExecution }>;
  /** Preview only. The dedicated worker still creates a private draft, never a campaign. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdAutomationTestReceipt = {
  id: string;
  automationId: string;
  idempotencyKey: string;
  state: "queued" | "completed";
  draftId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function adAutomationDestinationExecution(destination: AdAutomationDestination): AdAutomationDestinationExecution {
  const providerName: Record<AdAutomationDestinationProvider, string> = {
    meta_ads: "Meta Ads",
    google_ads: "Google Ads",
    linkedin_ads: "LinkedIn Ads",
    facebook_page: "Facebook-sida",
    instagram: "Instagram",
    linkedin: "LinkedIn",
    newsletter: "Nyhetsbrev",
    rss: "RSS",
  };
  return {
    destinationId: destination.id,
    provider: destination.provider,
    status: "unavailable",
    message: `${providerName[destination.provider]} kan sparas som mål, men extern leverans är inte aktiverad i den här Vercel/Neon-versionen.`,
  };
}
