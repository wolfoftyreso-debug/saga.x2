import "server-only";

import { z } from "zod";
import type { AdAutomationCreativeBrief } from "@/lib/domain/ad-automation";
import type { ContentChannel, ContentType } from "@/lib/domain/content-studio";
import {
  sagaEditorialLensPromptContextSchema,
  type SagaEditorialLensPromptContext,
} from "@/lib/domain/saga-editorial-lens";
import {
  contentGenerationInputSchema,
  contentLengthSchema,
  type ContentGenerationInput,
  type GeneratedContent,
} from "@/lib/domain/content-generation";
import {
  assessSagaSeriesReferenceAlignment,
  resolveSagaSeriesReferenceContext,
  type SagaSeriesReferenceAlignmentAssessment,
  type SagaSeriesReferenceContext,
} from "@/lib/services/saga-series-reference";

/**
 * The deterministic quality gate that sits between generation and the first
 * durable draft. It deliberately does not call a model: a model may help
 * write, but it cannot be the sole authority that decides its own output is
 * fit for a human review queue, calendar, or delivery.
 *
 * The gate has three distinct outcomes:
 * - approved: the content can enter SAGA's calendar (subject to approval).
 * - review_required: it may remain a private draft, but cannot be scheduled.
 * - blocked: it is not stored by an automation at all.
 */
export const SAGA_PRODUCTION_QUALITY_VERSION = "saga-production-quality/v1" as const;

export type SagaProductionQualityDecision = "approved" | "review_required" | "blocked";
export type SagaProductionQualityRequirement = "private_draft" | "calendar" | "delivery";
export type SagaProductionQualitySeverity = "blocker" | "warning";
export type SagaProductionQualityField =
  | "title"
  | "headline"
  | "subject"
  | "body"
  | "callToAction"
  | "offer"
  | "imagePrompt"
  | "editorialLens"
  | "seriesReference"
  | "delivery";

export type SagaProductionQualityFindingCode =
  | "missing_editorial_structure"
  | "missing_newsletter_subject"
  | "missing_newsletter_preview"
  | "body_too_short"
  | "body_off_target_length"
  | "readability_needs_review"
  | "destructive_or_disrespectful_tone"
  | "unsupported_claim_without_evidence"
  | "unsafe_or_non_compliant_image_direction"
  | "missing_image_direction"
  | "offer_evidence_pending"
  | "delivery_unavailable"
  | "ad_private_draft_locked"
  | "editorial_lens_forbidden_theme_present"
  | "editorial_lens_review_required"
  | "series_reference_required_element_missing"
  | "series_reference_forbidden_element_present"
  | "series_reference_tone_mismatch"
  | "series_reference_structure_mismatch"
  | "series_reference_cta_mismatch"
  | "series_reference_channel_mismatch"
  | "series_reference_channel_not_assessable"
  | "series_reference_media_mismatch"
  | "series_reference_media_not_assessable"
  | "series_reference_review_required";

export type SagaProductionQualityFinding = {
  code: SagaProductionQualityFindingCode;
  severity: SagaProductionQualitySeverity;
  field: SagaProductionQualityField;
  message: string;
};

export type SagaProductionQualityAssessment = {
  version: typeof SAGA_PRODUCTION_QUALITY_VERSION;
  decision: SagaProductionQualityDecision;
  score: number;
  findings: readonly SagaProductionQualityFinding[];
  /** A blocked result must not be inserted into the private draft table. */
  canCreatePrivateDraft: boolean;
  /** Review-needed copy stays private until a person has improved it. */
  canEnterCalendar: boolean;
  /** No current SAGA V1 path may invoke an external provider. */
  canDeliver: false;
  /** Present only when a backend supplied a frozen Series Reference context. */
  seriesReferenceAlignment?: SagaSeriesReferenceAlignmentAssessment;
};

type Evidence = {
  sourceReference?: string | null;
  verifiedAt?: string | null;
};

type DeliveryIntent = "private_draft" | "calendar" | "external";

export type SagaContentQualityInput = {
  kind: "content_draft";
  contentType: ContentType;
  channels: readonly ContentChannel[];
  targetLength: "short" | "medium" | "long";
  title: string;
  headline: string | null;
  subject: string | null;
  previewText: string | null;
  body: string;
  callToAction: string | null;
  imagePrompt: string | null;
  altText?: string | null;
  /** Verified source records can be supplied by a future research engine. */
  claimEvidence?: readonly Evidence[];
  /** Server-only, immutable continuity context. No UI payload may create it. */
  seriesReference?: SagaSeriesReferenceContext | null;
  /** Active workspace doctrine resolved by the worker, never from a request body. */
  editorialLens?: SagaEditorialLensPromptContext | null;
  deliveryIntent: DeliveryIntent;
};

export type SagaAdCreativeQualityInput = {
  kind: "ad_creative_brief";
  automationName: string;
  creativeBrief: AdAutomationCreativeBrief;
  /** Ad V1 is deliberately a non-deliverable creative brief. */
  deliveryIntent: DeliveryIntent;
};

export type SagaProductionQualityInput = SagaContentQualityInput | SagaAdCreativeQualityInput;

/**
 * The minimal immutable policy context retained with an automation draft. It
 * is deliberately limited to the existing safe Lens projection and the
 * Series Reference's safe snapshot—never a source URL, Blob path, provider
 * credential, user-entered prompt, or publication instruction.
 */
export type SagaAutomationQualityContext = {
  targetLength: "short" | "medium" | "long";
  editorialLens: SagaEditorialLensPromptContext | null;
  seriesReference: SagaSeriesReferenceContext | null;
};

const sagaAutomationQualityContextSchema = z.object({
  targetLength: contentLengthSchema,
  editorialLens: sagaEditorialLensPromptContextSchema.nullable().optional(),
  // The Series service owns the strict snapshot parser below. Leaving this
  // unknown here lets it preserve the exact immutable data shape without
  // duplicating its schema or weakening its validation.
  seriesReference: z.unknown().nullable().optional(),
}).strict();

/**
 * Parses server-written quality metadata before a later calendar move. Older
 * drafts that predate Lens/Series continue with the safe null defaults; a
 * malformed new context fails closed at the repository boundary.
 */
export function resolveSagaAutomationQualityContext(value: unknown): SagaAutomationQualityContext {
  const parsed = sagaAutomationQualityContextSchema.parse(value);
  return {
    targetLength: parsed.targetLength,
    editorialLens: parsed.editorialLens ?? null,
    seriesReference: parsed.seriesReference ? resolveSagaSeriesReferenceContext(parsed.seriesReference) : null,
  };
}

export class SagaProductionQualityError extends Error {
  constructor(
    message: string,
    readonly assessment: SagaProductionQualityAssessment,
  ) {
    super(message);
    this.name = "SagaProductionQualityError";
  }
}

/**
 * Produces an explainable score and a permission-like decision. The result is
 * JSON-safe and may be retained with the automation draft as an audit trail.
 */
export function assessSagaProductionQuality(input: SagaProductionQualityInput): SagaProductionQualityAssessment {
  const findings = input.kind === "content_draft"
    ? assessContentDraft(input)
    : assessAdCreativeBrief(input);
  if (input.kind === "content_draft" && input.editorialLens) {
    findings.push(...assessEditorialLens(input.editorialLens, input));
  }
  const seriesReferenceAlignment = input.kind === "content_draft" && input.seriesReference
    ? assessSagaSeriesReferenceAlignment(input.seriesReference, {
      title: input.title,
      headline: input.headline,
      body: input.body,
      callToAction: input.callToAction,
      channels: input.channels,
      imagePrompt: input.imagePrompt,
      altText: input.altText,
    })
    : undefined;
  if (seriesReferenceAlignment) {
    for (const finding of seriesReferenceAlignment.findings) {
      if (finding.severity === "warning") {
        findings.push(warning(finding.code, "seriesReference", finding.message));
      }
    }
    // Series controls are intentionally review-only in V1. A perfect match
    // remains a private draft until a person accepts the frozen reference
    // revision and its continuity choices.
    if (seriesReferenceAlignment.requiresReview) {
      findings.push(warning(
        "series_reference_review_required",
        "seriesReference",
        "Serie-referensen kräver mänsklig granskning innan utkastet kan läggas i kalendern.",
      ));
    }
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker").length;
  const warnings = findings.length - blockers;
  const score = Math.max(0, 100 - blockers * 40 - warnings * 8);
  const canCreatePrivateDraft = blockers === 0;
  const canEnterCalendar = input.kind === "content_draft"
    && canCreatePrivateDraft
    && warnings === 0
    && input.deliveryIntent !== "external";

  return {
    version: SAGA_PRODUCTION_QUALITY_VERSION,
    decision: blockers > 0 ? "blocked" : warnings > 0 ? "review_required" : "approved",
    score,
    findings,
    canCreatePrivateDraft,
    canEnterCalendar,
    // There is intentionally no provider delivery adapter in this version.
    canDeliver: false,
    ...(seriesReferenceAlignment ? { seriesReferenceAlignment } : {}),
  };
}

/** Throws an ergonomic, non-provider-specific error when a required gate fails. */
export function assertSagaProductionQuality(
  input: SagaProductionQualityInput,
  requirement: SagaProductionQualityRequirement,
): SagaProductionQualityAssessment {
  const assessment = assessSagaProductionQuality(input);
  const allowed = requirement === "private_draft"
    ? assessment.canCreatePrivateDraft
    : requirement === "calendar"
      ? assessment.canEnterCalendar
      : assessment.canDeliver;
  if (allowed) return assessment;

  const blocker = assessment.findings.find((finding) => finding.severity === "blocker")
    ?? assessment.findings[0];
  const message = requirement === "private_draft"
    ? blocker?.message ?? "Kvalitetsgrinden tillåter inte att det här privata utkastet skapas."
    : requirement === "calendar"
      ? blocker?.message ?? "Utkastet behöver redaktionell bearbetning innan det kan läggas i kalendern."
      : "Extern leverans är inte konfigurerad i denna SAGA-version.";
  throw new SagaProductionQualityError(message, assessment);
}

/** Maps the canonical generated response into the quality gate without a UI boundary. */
export function assessGeneratedContentQuality(
  input: ContentGenerationInput,
  generated: GeneratedContent,
  deliveryIntent: DeliveryIntent = "private_draft",
  seriesReference: SagaSeriesReferenceContext | null = null,
  editorialLens: SagaEditorialLensPromptContext | null = null,
): SagaProductionQualityAssessment {
  const request = contentGenerationInputSchema.parse(input);
  return assessSagaProductionQuality({
    kind: "content_draft",
    ...request,
    title: generated.title,
    headline: generated.headline,
    subject: generated.subject,
    previewText: generated.previewText,
    body: generated.body,
    callToAction: generated.callToAction,
    imagePrompt: generated.imagePrompt,
    altText: generated.altText,
    seriesReference,
    editorialLens,
    deliveryIntent,
  });
}

/** Builds the explicit private-only quality input for the deterministic ad producer. */
export function assessAdAutomationPrivateDraftQuality(
  automationName: string,
  creativeBrief: AdAutomationCreativeBrief,
): SagaProductionQualityAssessment {
  return assessSagaProductionQuality({
    kind: "ad_creative_brief",
    automationName,
    creativeBrief,
    deliveryIntent: "private_draft",
  });
}

function assessContentDraft(input: SagaContentQualityInput): SagaProductionQualityFinding[] {
  const findings: SagaProductionQualityFinding[] = [];
  const title = clean(input.title);
  const headline = clean(input.headline);
  const body = clean(input.body);
  const cta = clean(input.callToAction);
  const imagePrompt = clean(input.imagePrompt);

  if (!title || !headline || !body || !cta) {
    findings.push(blocker(
      "missing_editorial_structure",
      !title ? "title" : !headline ? "headline" : !body ? "body" : "callToAction",
      "Utkastet behöver titel, rubrik, brödtext och ett tydligt nästa steg innan det kan användas.",
    ));
  }
  if (input.contentType === "newsletter" && !clean(input.subject)) {
    findings.push(blocker("missing_newsletter_subject", "subject", "Ett nyhetsbrev behöver ett ämnesfält."));
  }
  if (input.contentType === "newsletter" && !clean(input.previewText)) {
    findings.push(blocker("missing_newsletter_preview", "body", "Ett nyhetsbrev behöver en kort förhandsrad."));
  }

  const words = wordCount(body);
  if (words > 0 && words < 12) {
    findings.push(blocker("body_too_short", "body", "Brödtexten är för kort för att bära ett redaktionellt budskap."));
  } else if (words > 0 && !isNearTargetLength(words, input.targetLength)) {
    findings.push(warning(
      "body_off_target_length",
      "body",
      `Texten är ${words} ord och behöver justeras för den valda längden innan kalendern används.`,
    ));
  }
  if (body && averageSentenceLength(body) > 28) {
    findings.push(warning(
      "readability_needs_review",
      "body",
      "Texten har långa meningar. Dela upp dem för att behålla läsbarheten i flödet.",
    ));
  }
  if (containsDestructiveOrDisrespectfulTone([title, headline, body, cta])) {
    findings.push(blocker(
      "destructive_or_disrespectful_tone",
      "body",
      "SAGA kräver en konstruktiv och respektfull ton; formuleringen behöver skrivas om innan ett utkast skapas.",
    ));
  }
  if (containsUnsupportedClaim([title, headline, body, cta]) && !hasEvidence(input.claimEvidence)) {
    findings.push(blocker(
      "unsupported_claim_without_evidence",
      "body",
      "Pris-, rabatt-, garanti- eller resultatpåståenden behöver ett spårbart underlag innan de får passera kvalitetsgrinden.",
    ));
  }
  if (!imagePrompt) {
    findings.push(blocker("missing_image_direction", "imagePrompt", "Bildriktning saknas. Automationen måste skapa ett granskbart visuellt underlag."));
  } else if (containsUnsafeOrNonCompliantImageDirection(imagePrompt)) {
    findings.push(blocker(
      "unsafe_or_non_compliant_image_direction",
      "imagePrompt",
      "Bildriktningen innehåller riskfylld dramatik eller otillåten inlagd text, logotyp eller watermark.",
    ));
  }
  if (input.deliveryIntent === "external") {
    findings.push(blocker("delivery_unavailable", "delivery", "Extern publicering är inte ansluten. Spara endast ett privat utkast eller använd kalendern efter granskning."));
  }
  return findings;
}

/**
 * Lens controls are deterministic policy checks, not a second model judge.
 * They intentionally do not fetch sources or invent citations: a generic
 * automation with an active review/strict Lens remains a private draft until
 * a person has checked the available evidence path.
 */
function assessEditorialLens(
  lens: SagaEditorialLensPromptContext,
  input: SagaContentQualityInput,
): SagaProductionQualityFinding[] {
  const findings: SagaProductionQualityFinding[] = [];
  const text = normalize([
    input.title,
    input.headline ?? "",
    input.subject ?? "",
    input.previewText ?? "",
    input.body,
    input.callToAction ?? "",
  ].join(" "));

  for (const theme of lens.forbiddenThemes) {
    const normalizedTheme = normalize(theme);
    if (normalizedTheme && text.includes(normalizedTheme)) {
      findings.push(blocker(
        "editorial_lens_forbidden_theme_present",
        "editorialLens",
        `Utkastet berör Lensens förbjudna tema ”${theme}” och måste skrivas om innan det kan sparas.`,
      ));
    }
  }

  if (lens.controlMode !== "advisory") {
    const evidenceNote = lens.controlMode === "strict" && lens.sourceRules.requireCitations
      ? " Lensens strikta läge kräver dessutom redaktionell kontroll av belägg; den generiska automationskön hämtar inga källor själv."
      : "";
    findings.push(warning(
      "editorial_lens_review_required",
      "editorialLens",
      `En aktiv Editorial Lens kräver mänsklig granskning innan utkastet kan läggas i kalendern.${evidenceNote}`,
    ));
  }

  return findings;
}

function assessAdCreativeBrief(input: SagaAdCreativeQualityInput): SagaProductionQualityFinding[] {
  const findings: SagaProductionQualityFinding[] = [];
  const brief = input.creativeBrief;
  if (!clean(input.automationName) || !clean(brief.hook) || !clean(brief.value) || !clean(brief.offer.copy) || !clean(brief.callToAction)) {
    findings.push(blocker(
      "missing_editorial_structure",
      !clean(brief.hook) ? "headline" : !clean(brief.value) ? "body" : !clean(brief.offer.copy) ? "offer" : "callToAction",
      "Annonsunderlaget behöver namn, hook, konkret värde, erbjudande och CTA i den ordningen.",
    ));
  }
  if (containsDestructiveOrDisrespectfulTone([brief.hook, brief.value, brief.offer.copy, brief.callToAction])) {
    findings.push(blocker(
      "destructive_or_disrespectful_tone",
      "body",
      "SAGA:s annonsunderlag ska vara konstruktivt och respektfullt, inte chock- eller konfliktbyggande.",
    ));
  }
  if (containsUnsafeOrNonCompliantImageDirection(brief.customVisualDirection)) {
    findings.push(blocker(
      "unsafe_or_non_compliant_image_direction",
      "imagePrompt",
      "Den visuella riktningen måste vara trygg och fri från inlagd text, logotyper och watermark.",
    ));
  }
  // The browser-facing V1 contract only permits `unverified`. A future
  // server-owned promotion record can add a separate verified evidence type;
  // until then the private brief must retain this transparent warning.
  const hasOfferEvidence = false;
  if (!hasOfferEvidence) {
    findings.push(warning(
      "offer_evidence_pending",
      "offer",
      "Erbjudandet saknar serververifierat underlag. Det får finnas som privat arbetsnotering men inte kalenderläggas eller levereras.",
    ));
  }
  if (input.deliveryIntent !== "private_draft") {
    findings.push(blocker(
      input.deliveryIntent === "external" ? "delivery_unavailable" : "ad_private_draft_locked",
      "delivery",
      input.deliveryIntent === "external"
        ? "Extern annonsleverans är inte ansluten i SAGA V1."
        : "SAGA:s deterministiska annonsunderlag är privat och kan inte läggas i publiceringskalendern.",
    ));
  }
  return findings;
}

function blocker(
  code: SagaProductionQualityFindingCode,
  field: SagaProductionQualityField,
  message: string,
): SagaProductionQualityFinding {
  return { code, severity: "blocker", field, message };
}

function warning(
  code: SagaProductionQualityFindingCode,
  field: SagaProductionQualityField,
  message: string,
): SagaProductionQualityFinding {
  return { code, severity: "warning", field, message };
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

function isNearTargetLength(words: number, targetLength: SagaContentQualityInput["targetLength"]): boolean {
  if (targetLength === "short") return words >= 32 && words <= 115;
  if (targetLength === "long") return words >= 220 && words <= 560;
  return words >= 105 && words <= 270;
}

function averageSentenceLength(value: string): number {
  const sentences = value
    .split(/[.!?]+/u)
    .map((sentence) => wordCount(sentence))
    .filter(Boolean);
  if (!sentences.length) return 0;
  return sentences.reduce((total, count) => total + count, 0) / sentences.length;
}

function hasEvidence(evidence: readonly Evidence[] | undefined): boolean {
  return Boolean(evidence?.some((item) => clean(item.sourceReference) && clean(item.verifiedAt)));
}

function containsUnsupportedClaim(values: readonly string[]): boolean {
  const text = normalize(values.join(" "));
  return /\b\d{1,3}(?:[ .\u00a0]\d{3})*(?:[,.]\d{1,2})?\s*(?:kr|sek)\b/u.test(text)
    || /\b\d{1,3}\s*%\b/u.test(text)
    || /\b(?:rabatt|rea|kampanjpris|fran\s+endast|garanter(?:ad|ar|at)|garanti|bevisat\s+resultat|dubblar|halverar)\b/u.test(text);
}

function containsDestructiveOrDisrespectfulTone(values: readonly string[]): boolean {
  const text = normalize(values.join(" "));
  return /\b(?:idiot|vardelos|dum\s+i\s+huvudet|hata(?:r|s)?|forst(or|ö)r\s+(?:dem|konkurrent)|krossa\s+(?:dem|konkurrent)|smutskasta|skamma|fornedra|förnedra|panik|skr(a|ä)m\s+(?:tittaren|folk)|chocka\s+(?:tittaren|folk))\b/u.test(text);
}

function containsUnsafeOrNonCompliantImageDirection(value: string): boolean {
  const text = normalize(value);
  if (!text) return false;
  // "utan text eller logotyp" is the desired instruction. Only reject an
  // instruction to add an artifact, not the model-safety prohibition itself.
  if (/\b(?:inlagd\s+text|text\s+i\s+bild(?:en)?|(?:lagg|lägg)\s+till\s+(?:text|logotyp|watermark|vattenmarke|vattenm[aä]rke)|(?:med|inkludera|visa)\s+(?:en\s+)?(?:logotyp|watermark|vattenmarke|vattenm[aä]rke)|falsk\s+skarmbild|falsk\s+sk[aä]rmbild)\b/u.test(text)
    && !/\butan\s+(?:inlagd\s+)?(?:text|logotyp|watermark|vattenmarke|vattenm[aä]rke)/u.test(text)) return true;
  if (/\b(?:bilkrock|krockar|kraschar|jump\s*scare|skramseleffekt|skr[aä]msel)\b/u.test(text)) return true;
  const falling = /\b(?:faller|fallande|falla|kastas|flyger\s+mot|droppar)\b/u.test(text);
  const object = /\b(?:hjul|dack|föremal|foremal|sten|skylt)\b/u.test(text);
  const people = /\b(?:folksamling|m[aä]nnisk(?:a|or)|person(?:er)?|crowd|folk\s+nedan)\b/u.test(text);
  return falling && object && people;
}

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/\s+/g, " ")
    .trim();
}
