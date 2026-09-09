import "server-only";

import { z } from "zod";

/**
 * A small, deterministic boundary for short-form adverts and video concepts.
 *
 * It deliberately does not call a model, fetch a source, or send a campaign.
 * It tells the calling generation service whether a concept is safe to draft
 * and whether its commercial claim is sufficiently verified to be used in a
 * publishable asset.
 */

export const SAGA_CREATIVE_FORMATS = ["short_form_video", "paid_social", "display"] as const;
export type SagaCreativeFormat = (typeof SAGA_CREATIVE_FORMATS)[number];

export const SAGA_CREATIVE_FLOW_STEPS = ["hook", "value", "offer", "cta"] as const;
export type SagaCreativeFlowStep = (typeof SAGA_CREATIVE_FLOW_STEPS)[number];

export const SAGA_SAFE_VISUAL_METAPHORS = {
  calendar_turn: {
    label: "Kalenderblad och årstidsskifte",
    direction: "En lugn närbild av kalenderblad som vänds, första frost på en bilruta och ett däck som hanteras säkert i en välordnad verkstad. Ingen fara, stress eller människa i riskzonen.",
  },
  day_to_evening: {
    label: "Dagen som glider mot kväll",
    direction: "Ett mjukt tidsskifte från eftermiddag till kväll vid en trygg verkstad, med klocka och bokningsbekräftelse som visuella detaljer. Ingen dramatik eller fara.",
  },
  tread_transition: {
    label: "Säsongsskifte i däckmönster",
    direction: "En grafiskt enkel övergång från sommardäcksmönster till vinterdäcksmönster på ett rent verkstadsgolv. Visa processen stilla, kontrollerat och professionellt.",
  },
  prepared_shelf: {
    label: "Ordning i däckhotellet",
    direction: "Raka rader av märkta däck på säkra hyllor och en medarbetare som förbereder ett hjulskifte i lugn takt. Varmt ljus och mänsklig närvaro.",
  },
} as const;

export type SagaSafeVisualMetaphor = keyof typeof SAGA_SAFE_VISUAL_METAPHORS;
export const sagaSafeVisualMetaphorSchema = z.enum([
  "calendar_turn",
  "day_to_evening",
  "tread_transition",
  "prepared_shelf",
]);

const boundedFlowText = z.string().trim().min(2).max(1_200);
const boundedOfferText = z.string().trim().min(2).max(900);
const timestampSchema = z.string().trim().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "Verifieringstidpunkten måste vara ett giltigt datum.",
);

/**
 * This is intentionally evidence-shaped. A browser or model must never get to
 * turn a bare price string into a verified offer just by claiming that it is
 * verified: a server-owned campaign/promotion record should construct this
 * input in a later delivery flow.
 */
export const sagaCreativeOfferVerificationSchema = z.object({
  status: z.enum(["verified", "unverified"]).default("unverified"),
  sourceReference: z.string().trim().max(240).default(""),
  verifiedAt: timestampSchema.optional(),
}).strict();

export const sagaCreativeOfferSchema = z.object({
  /** Exact wording proposed for the creative. It is only publishable when verified. */
  copy: boundedOfferText,
  /** Important terms such as scope, VAT, dates or availability. */
  terms: z.string().trim().max(2_000).default(""),
  verification: sagaCreativeOfferVerificationSchema.default({ status: "unverified", sourceReference: "" }),
}).strict();

export const sagaCreativeBriefSchema = z.object({
  format: z.enum(SAGA_CREATIVE_FORMATS),
  hook: boundedFlowText,
  value: boundedFlowText,
  offer: sagaCreativeOfferSchema,
  callToAction: boundedFlowText,
  visualMetaphor: sagaSafeVisualMetaphorSchema,
  /** Optional, but it is screened before it can become a model prompt. */
  customVisualDirection: z.string().trim().max(1_500).default(""),
}).strict();

export type SagaCreativeBrief = z.infer<typeof sagaCreativeBriefSchema>;

export type SagaCreativeSafetyViolationCode =
  | "unsafe_scene"
  | "unverified_offer"
  | "unverified_commercial_claim";

export type SagaCreativeSafetyViolation = {
  code: SagaCreativeSafetyViolationCode;
  field: "hook" | "value" | "offer" | "callToAction" | "customVisualDirection";
  message: string;
};

export type SagaCreativeSafeRewrite = {
  visualMetaphor: SagaSafeVisualMetaphor;
  visualDirection: string;
  rationale: string;
};

export type SagaCreativeSafetyAssessment = {
  brief: SagaCreativeBrief;
  flow: readonly SagaCreativeFlowStep[];
  /** A dangerous scene must never reach a model prompt. */
  draftAllowed: boolean;
  /** Commercial claims need a traceable, server-provided verification. */
  publishable: boolean;
  violations: readonly SagaCreativeSafetyViolation[];
  safeRewrite: SagaCreativeSafeRewrite;
  verifiedOffer: {
    exactCopy: string | null;
    terms: string | null;
    sourceReference: string | null;
    verifiedAt: string | null;
  };
};

export class SagaCreativeSafetyError extends Error {
  constructor(
    message: string,
    readonly assessment: SagaCreativeSafetyAssessment | null,
    readonly status = 422,
  ) {
    super(message);
    this.name = "SagaCreativeSafetyError";
  }
}

export type SagaCreativePromptPolicy = {
  version: "saga-creative-safety/v1";
  draftAllowed: boolean;
  publishable: boolean;
  flow: readonly SagaCreativeFlowStep[];
  visualDirection: string;
  offer: SagaCreativeSafetyAssessment["verifiedOffer"];
  safeRewrite: SagaCreativeSafeRewrite;
  instructions: string;
};

/**
 * Evaluates a complete creative concept. Unverified commercial copy remains
 * draftable so the editor can finish verification, but it cannot be treated
 * as publishable and is never passed to a model as usable offer wording.
 */
export function assessSagaCreativeBrief(value: unknown): SagaCreativeSafetyAssessment {
  const parsed = sagaCreativeBriefSchema.safeParse(value);
  if (!parsed.success) {
    throw new SagaCreativeSafetyError(
      "Ett annons- eller videokoncept behöver Hook, värde, erbjudande och CTA i den ordningen, plus en säker visuell metafor.",
      null,
    );
  }
  const brief = parsed.data;
  const violations: SagaCreativeSafetyViolation[] = [];

  for (const [field, text] of Object.entries({
    hook: brief.hook,
    value: brief.value,
    offer: brief.offer.copy,
    callToAction: brief.callToAction,
    customVisualDirection: brief.customVisualDirection,
  }) as Array<[SagaCreativeSafetyViolation["field"], string]>) {
    if (containsUnsafeCreativeScene(text)) {
      violations.push({
        code: "unsafe_scene",
        field,
        message: "Kreativets visuella idé får inte använda överhängande skada, fallande föremål mot människor, krockar eller skrämseleffekter.",
      });
    }
  }

  const verification = brief.offer.verification;
  const offerVerified = verification.status === "verified"
    && Boolean(verification.sourceReference.trim())
    && Boolean(verification.verifiedAt);

  if (!offerVerified) {
    violations.push({
      code: "unverified_offer",
      field: "offer",
      message: "Erbjudandet saknar verifierat underlag. Det får finnas som arbetsnotering men inte användas i publicerbar copy.",
    });
  }

  for (const [field, text] of [
    ["hook", brief.hook],
    ["value", brief.value],
    ["callToAction", brief.callToAction],
  ] as const) {
    if (containsCommercialClaim(text)) {
      violations.push({
        code: "unverified_commercial_claim",
        field,
        message: "Pris-, rabatt- eller kampanjpåståenden får bara förekomma som exakt verifierad erbjudandetext.",
      });
    }
  }

  const hasUnsafeScene = violations.some((violation) => violation.code === "unsafe_scene");
  return {
    brief,
    flow: SAGA_CREATIVE_FLOW_STEPS,
    draftAllowed: !hasUnsafeScene,
    publishable: !hasUnsafeScene && offerVerified && !violations.some((violation) => violation.code === "unverified_commercial_claim"),
    violations,
    safeRewrite: safeRewriteFor(brief.visualMetaphor),
    verifiedOffer: offerVerified ? {
      exactCopy: brief.offer.copy,
      terms: brief.offer.terms || null,
      sourceReference: verification.sourceReference,
      verifiedAt: verification.verifiedAt ?? null,
    } : {
      exactCopy: null,
      terms: null,
      sourceReference: null,
      verifiedAt: null,
    },
  };
}

/** Throws before an unsafe concept can be handed to a Gateway model. */
export function assertSagaCreativeBriefCanGenerate(value: unknown): SagaCreativeSafetyAssessment {
  const assessment = assessSagaCreativeBrief(value);
  if (!assessment.draftAllowed) {
    throw new SagaCreativeSafetyError(
      "Den kreativa idén innehåller en osäker eller chockartad scen. Använd den föreslagna säkra visuella metaforen i stället.",
      assessment,
    );
  }
  return assessment;
}

/**
 * Builds the server-owned prompt boundary. Without a creative brief it still
 * applies the safe baseline, while a verified brief adds exact offer wording.
 */
export function buildSagaCreativePromptPolicy(creativeBrief?: unknown): SagaCreativePromptPolicy {
  const assessment = creativeBrief === undefined
    ? baselineAssessment()
    : assertSagaCreativeBriefCanGenerate(creativeBrief);
  const visualDirection = assessment.brief.customVisualDirection || assessment.safeRewrite.visualDirection;
  const offer = assessment.verifiedOffer;

  return {
    version: "saga-creative-safety/v1",
    draftAllowed: assessment.draftAllowed,
    publishable: assessment.publishable,
    flow: assessment.flow,
    visualDirection,
    offer,
    safeRewrite: assessment.safeRewrite,
    instructions: promptInstructions(assessment, visualDirection),
  };
}

function baselineAssessment(): SagaCreativeSafetyAssessment {
  const brief = sagaCreativeBriefSchema.parse({
    format: "short_form_video",
    hook: "En trygg och igenkännbar öppning.",
    value: "Visa nyttan konkret och tidigt.",
    offer: { copy: "Erbjudande kräver verifiering." },
    callToAction: "Välj ett tydligt nästa steg.",
    visualMetaphor: "calendar_turn",
  });
  return {
    brief,
    flow: SAGA_CREATIVE_FLOW_STEPS,
    draftAllowed: true,
    publishable: false,
    violations: [{
      code: "unverified_offer",
      field: "offer",
      message: "Ingen verifierad erbjudandetext har skickats till den här kreativa körningen.",
    }],
    safeRewrite: safeRewriteFor(brief.visualMetaphor),
    verifiedOffer: { exactCopy: null, terms: null, sourceReference: null, verifiedAt: null },
  };
}

function safeRewriteFor(visualMetaphor: SagaSafeVisualMetaphor): SagaCreativeSafeRewrite {
  const metaphor = SAGA_SAFE_VISUAL_METAPHORS[visualMetaphor];
  return {
    visualMetaphor,
    visualDirection: metaphor.direction,
    rationale: "Skapa igenkänning och tempo med en trygg visuell metafor, inte med en situation där någon kan skadas.",
  };
}

function promptInstructions(assessment: SagaCreativeSafetyAssessment, visualDirection: string): string {
  const offerRule = assessment.verifiedOffer.exactCopy
    ? `Det enda erbjudande eller pris som får förekomma ordagrant är: ${JSON.stringify(assessment.verifiedOffer.exactCopy)}. Villkor: ${JSON.stringify(assessment.verifiedOffer.terms ?? "Inga ytterligare villkor angivna.")}. Uppfinn aldrig rabatt, pris, finansiering, lagerstatus, datum eller begränsning utöver detta.`
    : "Ingen verifierad erbjudandetext finns. Skriv därför aldrig pris, rabatt, kampanj, rea, finansiering, tillgänglighet eller tidsgräns. Markera i stället att erbjudandet behöver verifieras innan publicering.";

  return `SAGA Creative Safety v1 gäller för annons- och videokoncept. Bygg alltid konceptet i denna ordning: Hook → värde → erbjudande → CTA. Hooken ska skapa trygg igenkänning eller nyfikenhet, värdet ska visa den konkreta nyttan tidigt, erbjudandet ska vara exakt verifierat och CTA:n ska beskriva ett tydligt nästa steg.

Använd aldrig chock, överhängande skada, ett fallande föremål nära eller mot människor, krockar, våld, jump-scares eller en situation där någon verkar kunna komma till skada. Byt alltid sådan dramatik mot en säker visuell metafor. Rekommenderad riktning: ${JSON.stringify(visualDirection)}.

${offerRule}

Säker status: ${assessment.publishable ? "verifierat kreativt underlag" : "endast arbetsutkast – inte publicerbart"}.`;
}

function containsCommercialClaim(value: string): boolean {
  const text = normalize(value);
  return [
    /\b\d{1,3}(?:[ .\u00a0]\d{3})*(?:[,.]\d{1,2})?\s*(?:kr|sek)\b/u,
    /\b\d+(?:[,.]\d+)?\s*%(?!\p{L})/u,
    /\b(?:rabatt|rea|kampanjpris|franpris|fran\s+\d|rantefri|avbetalning|leasing fran|gratis)\b/u,
  ].some((pattern) => pattern.test(text));
}

function containsUnsafeCreativeScene(value: string): boolean {
  const text = normalize(value);
  if (!text) return false;
  if (/\b(?:jump\s*scare|skramseleffekt|skramselfilm|skramma\s+tittaren)\b/u.test(text)) return true;
  if (/\b(?:bilkrock|krockar|kraschar|crash(?:es|ing)?|collision|smaller\s+in|kor\s+in\s+i)\b/u.test(text)) return true;

  const hasFallingAction = /\b(?:faller|fallande|falla|droppar|droppande|slapps|slapper|kastas|flyger\s+mot|falling|falls|drop|drops|dropping)\b/u.test(text);
  const hasFallingObject = /\b(?:hjul|dack|wheel|tire|foremal|object|sten|skylt|balkong)\b/u.test(text);
  const hasPeopleAtRisk = /\b(?:folksamling|mannisk(?:a|or)|person(?:er)?|crowd|people|gata[nr]?\s+nedan|nedanfor)\b/u.test(text);
  const hasHeightCue = /\b(?:balkong|tionde\s+vaning|10(?::e|e)?\s+vaning|hog\s+byggnad|uppifran)\b/u.test(text);
  if (hasFallingAction && hasFallingObject && (hasPeopleAtRisk || hasHeightCue)) return true;
  if (/\b(?:nara\s+att\s+(?:traffa|skada)|precis\s+innan\s+.*(?:traffar|skadar)|about\s+to\s+(?:hit|injure))\b/u.test(text)) return true;
  if (/\b(?:traffa|skada|injure|hit)\b.{0,48}\b(?:mannisk(?:a|or)|person(?:er)?|crowd|people)\b/u.test(text)) return true;
  return false;
}

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/\s+/g, " ")
    .trim();
}
