import "server-only";

import { z } from "zod";

/**
 * A fail-closed policy boundary for private avatar references.
 *
 * It deliberately does not load an image, call an image provider, write Blob
 * data, or publish anything. A prompt is not proof that a generated image
 * hides a face, so every generated result remains private and review-required
 * until a pixel-level verifier or an authorised human reviewer records a safe
 * decision.
 */

export const SAGA_AVATAR_PRIVACY_POLICY_VERSION = "saga-avatar-privacy/v1" as const;

const uuidSchema = z.string().uuid();
const boundedDirectionSchema = z.string().trim().max(1_500).default("");

export const SAGA_AVATAR_SAFE_PRESENTATIONS = [
  "noir_shadow",
  "back_three_quarter",
  "cropped_profile",
  "silhouette",
] as const;
export type SagaAvatarSafePresentation = (typeof SAGA_AVATAR_SAFE_PRESENTATIONS)[number];

export const sagaAvatarSafePresentationSchema = z.enum(SAGA_AVATAR_SAFE_PRESENTATIONS);

/**
 * Models with image-reference input may have materially different retention
 * terms. The selection must therefore be explicit for every run; it is not a
 * workspace-wide "always on" switch.
 */
export const SAGA_AVATAR_PROVIDER_RETENTION_CHOICES = [
  "not_selected",
  "acknowledged_provider_terms",
] as const;
export type SagaAvatarProviderRetentionChoice = (typeof SAGA_AVATAR_PROVIDER_RETENTION_CHOICES)[number];

export const sagaAvatarProviderTransferConsentSchema = z.object({
  /** Must be affirmatively true before a server may send a private reference to a model provider. */
  allowReferenceTransferForThisRun: z.boolean().default(false),
  /** The user has read the selected model/provider retention disclosure for this run. */
  retentionChoice: z.enum(SAGA_AVATAR_PROVIDER_RETENTION_CHOICES).default("not_selected"),
}).strict();

export const sagaAvatarGenerationRequestSchema = z.object({
  /** Opaque IDs only. Blob paths, URLs and bytes never cross this policy boundary. */
  avatarProfileId: uuidSchema,
  referenceImageIds: z.array(uuidSchema).min(3).max(6),
  presentation: sagaAvatarSafePresentationSchema.default("noir_shadow"),
  /**
   * Validated for unsafe intent but intentionally not copied into the model
   * prompt. The model gets only a finite, server-owned visual direction.
   */
  requestedVisualDirection: boundedDirectionSchema,
  providerTransferConsent: sagaAvatarProviderTransferConsentSchema.default({
    allowReferenceTransferForThisRun: false,
    retentionChoice: "not_selected",
  }),
}).strict();

export type SagaAvatarGenerationRequest = z.input<typeof sagaAvatarGenerationRequestSchema>;
export type ParsedSagaAvatarGenerationRequest = z.output<typeof sagaAvatarGenerationRequestSchema>;

export type SagaAvatarPrivacyFindingCode =
  | "forbidden_face_visibility_request"
  | "unsafe_scene"
  | "provider_transfer_consent_required";

export type SagaAvatarPrivacyFinding = {
  code: SagaAvatarPrivacyFindingCode;
  severity: "blocker" | "warning";
  field: "requestedVisualDirection" | "providerTransferConsent";
  message: string;
};

export type SagaAvatarGenerationStatus = "review_required" | "blocked";

export type SagaAvatarPolicyCapabilities = {
  /** The result may only exist as a protected asset attached to a private draft. */
  canCreatePrivateDraft: boolean;
  /** This module never authorises calendar placement, even after image review. */
  canEnterCalendar: false;
  /** This module never authorises provider delivery or external publication. */
  canPublish: false;
  /** Linking, using, or taking control of an external account is out of scope. */
  canUseExternalAccounts: false;
};

export type SagaAvatarGenerationPolicy = {
  version: typeof SAGA_AVATAR_PRIVACY_POLICY_VERSION;
  status: SagaAvatarGenerationStatus;
  findings: readonly SagaAvatarPrivacyFinding[];
  presentation: SagaAvatarSafePresentation;
  /** Null when the request is blocked; otherwise a finite server-owned prompt. */
  providerPrompt: string | null;
  /**
   * Server-only opaque IDs binding an approved per-run transfer decision to
   * exactly one private profile and its selected reference set. These are not
   * Blob locators and must never be rendered in Studio.
   */
  transferAuthorization: {
    avatarProfileId: string;
    referenceImageIds: readonly string[];
  };
  referenceHandling: {
    source: "private_vercel_blob";
    referenceCount: number;
    /** True only with an explicit, per-run provider-transfer acknowledgement. */
    maySendPrivateReferenceToProvider: boolean;
    /** Do not expose a Blob URL, pathname, or raw bytes to the browser. */
    browserAccess: "never";
  };
  privacy: {
    privateOnly: true;
    fullIdentifiableFaceAllowed: false;
    visualVerificationRequired: true;
    /** A text prompt is a constraint, not a visual verification result. */
    promptIsNotVerification: true;
  };
  capabilities: SagaAvatarPolicyCapabilities;
  review: {
    required: true;
    acceptedReviewers: readonly ["pixel_verifier", "human"];
    releaseCondition: "face_obscured_and_identity_leak_risk_low";
  };
};

// A policy object becomes a transfer capability only after the fail-closed
// assertion below has accepted its explicit per-run acknowledgement. A JSON
// lookalike reconstructed by a caller cannot pass this process-local check.
const approvedTransferPolicies = new WeakSet<SagaAvatarGenerationPolicy>();

export type SagaAvatarVisualReviewStatus = "private_approved" | "review_required" | "blocked";

export type SagaAvatarVisualReview = {
  status: SagaAvatarVisualReviewStatus;
  reviewed: true;
  reviewer: "pixel_verifier" | "human";
  reviewedAt: string;
  faceVisibility: "obscured" | "not_obscured" | "inconclusive";
  fullIdentifiableFaceDetected: boolean;
  identityLeakRisk: "low" | "medium" | "high";
  /** Still private: review cannot grant calendar/public-account permissions. */
  capabilities: SagaAvatarPolicyCapabilities;
};

export const sagaAvatarVisualReviewInputSchema = z.object({
  reviewer: z.enum(["pixel_verifier", "human"]),
  reviewedAt: z.string().trim().refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Granskningstidpunkten måste vara ett giltigt datum.",
  ),
  faceVisibility: z.enum(["obscured", "not_obscured", "inconclusive"]),
  fullIdentifiableFaceDetected: z.boolean(),
  identityLeakRisk: z.enum(["low", "medium", "high"]),
}).strict();

export type SagaAvatarVisualReviewInput = z.input<typeof sagaAvatarVisualReviewInputSchema>;

export class SagaAvatarPrivacyError extends Error {
  constructor(
    message: string,
    readonly options: {
      code: "invalid_request" | "unsafe_avatar_request" | "review_not_permitted" | "invalid_review";
      status: 400 | 422;
      policy?: SagaAvatarGenerationPolicy;
    },
  ) {
    super(message);
    this.name = "SagaAvatarPrivacyError";
  }

  get code(): "invalid_request" | "unsafe_avatar_request" | "review_not_permitted" | "invalid_review" {
    return this.options.code;
  }

  get status(): 400 | 422 {
    return this.options.status;
  }
}

/**
 * Builds a bounded provider prompt and a permission-shaped result. It never
 * contains a user-provided direction or raw private-reference locator.
 */
export function buildSagaAvatarGenerationPolicy(value: SagaAvatarGenerationRequest): SagaAvatarGenerationPolicy {
  const request = parseAvatarRequest(value);
  const findings = assessRequest(request);
  const blocked = findings.some((finding) => finding.severity === "blocker");
  const transferPermitted = hasExplicitProviderTransferConsent(request);
  const status: SagaAvatarGenerationStatus = blocked ? "blocked" : "review_required";

  return {
    version: SAGA_AVATAR_PRIVACY_POLICY_VERSION,
    status,
    findings,
    presentation: request.presentation,
    providerPrompt: blocked ? null : buildSagaAvatarProviderPrompt(request.presentation),
    transferAuthorization: {
      avatarProfileId: request.avatarProfileId,
      referenceImageIds: [...request.referenceImageIds],
    },
    referenceHandling: {
      source: "private_vercel_blob",
      referenceCount: request.referenceImageIds.length,
      maySendPrivateReferenceToProvider: !blocked && transferPermitted,
      browserAccess: "never",
    },
    privacy: {
      privateOnly: true,
      fullIdentifiableFaceAllowed: false,
      visualVerificationRequired: true,
      promptIsNotVerification: true,
    },
    capabilities: privateOnlyCapabilities(!blocked && transferPermitted),
    review: {
      required: true,
      acceptedReviewers: ["pixel_verifier", "human"],
      releaseCondition: "face_obscured_and_identity_leak_risk_low",
    },
  };
}

/** Throws before a worker can hydrate or transfer private reference images. */
export function assertSagaAvatarGenerationCanStart(value: SagaAvatarGenerationRequest): SagaAvatarGenerationPolicy {
  const policy = buildSagaAvatarGenerationPolicy(value);
  if (policy.status !== "blocked" && policy.referenceHandling.maySendPrivateReferenceToProvider) {
    approvedTransferPolicies.add(policy);
    return policy;
  }

  const finding = policy.findings.find((item) => item.severity === "blocker")
    ?? policy.findings.find((item) => item.code === "provider_transfer_consent_required");
  throw new SagaAvatarPrivacyError(
    finding?.message ?? "Avatarbilden kan inte startas utan ett godkänt privat underlag.",
    {
      code: policy.status === "blocked" ? "unsafe_avatar_request" : "invalid_request",
      status: policy.status === "blocked" ? 422 : 400,
      policy,
    },
  );
}

/**
 * Guards the server-only Blob → provider handoff. It is intentionally stricter
 * than profile-level consent: each transfer must use the exact policy object
 * returned by `assertSagaAvatarGenerationCanStart` for this selected profile
 * and its exact source-reference set.
 */
export function assertSagaAvatarReferenceTransferAuthorized(
  policy: SagaAvatarGenerationPolicy,
  avatarProfileId: string,
  referenceImageIds: readonly string[],
): void {
  const sameIds = policy.transferAuthorization.referenceImageIds.length === referenceImageIds.length
    && policy.transferAuthorization.referenceImageIds.every((id, index) => id === referenceImageIds[index]);
  if (
    !approvedTransferPolicies.has(policy)
    || policy.status !== "review_required"
    || !policy.referenceHandling.maySendPrivateReferenceToProvider
    || policy.transferAuthorization.avatarProfileId !== avatarProfileId
    || !sameIds
  ) {
    throw new SagaAvatarPrivacyError(
      "Den privata referensen får inte skickas utan ett uttryckligt, aktuellt samtycke för just denna körning.",
      { code: "invalid_request", status: 400, policy },
    );
  }
}

/**
 * Records the result of an actual pixel-level verifier or authorised human
 * review. The caller is responsible for authenticating that reviewer and for
 * retaining its auditable evidence. This pure function does not pretend to
 * inspect image pixels itself.
 */
export function recordSagaAvatarVisualReview(
  policy: SagaAvatarGenerationPolicy,
  value: SagaAvatarVisualReviewInput,
): SagaAvatarVisualReview {
  if (policy.status === "blocked" || !policy.referenceHandling.maySendPrivateReferenceToProvider) {
    throw new SagaAvatarPrivacyError(
      "En avatarbild som inte fick starta kan inte godkännas i efterhand.",
      { code: "review_not_permitted", status: 422, policy },
    );
  }

  const parsed = sagaAvatarVisualReviewInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new SagaAvatarPrivacyError(
      "Avatargranskningen saknar ett giltigt, granskbart resultat.",
      { code: "invalid_review", status: 400, policy },
    );
  }

  const review = parsed.data;
  const approved = review.faceVisibility === "obscured"
    && review.fullIdentifiableFaceDetected === false
    && review.identityLeakRisk === "low";
  const blocked = review.faceVisibility === "not_obscured"
    || review.fullIdentifiableFaceDetected
    || review.identityLeakRisk === "high";

  return {
    status: approved ? "private_approved" : blocked ? "blocked" : "review_required",
    reviewed: true,
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    faceVisibility: review.faceVisibility,
    fullIdentifiableFaceDetected: review.fullIdentifiableFaceDetected,
    identityLeakRisk: review.identityLeakRisk,
    capabilities: privateOnlyCapabilities(false),
  };
}

/**
 * This safe direction is intentionally finite and independent of any free
 * text supplied by an editor. It is a constraint for the model, not proof of
 * how the pixels eventually look.
 */
export function buildSagaAvatarProviderPrompt(presentation: SagaAvatarSafePresentation): string {
  const direction = safePresentationDirection(presentation);
  return [
    "Skapa en enda privat redaktionell bild för ett SAGA-utkast med den privata referensen endast som bakgrund för övergripande persona och klädstil.",
    `Komposition: ${direction}`,
    "Visa aldrig ett helt, frontalt eller identifierbart ansikte. Ansiktet måste vara skymt, vänt bort, beskuret eller helt i djup skugga; ögon, näsa och mun får inte vara tydligt synliga samtidigt.",
    "Skapa inte en ansiktsbild, ett profilfoto, en selfie, en biometrisk likhetspresentation eller en realism som gör personen igenkännbar.",
    "Ingen text, logotyp, watermark, användargränssnitt eller påstående om publicering. Bilden är ett privat granskningsunderlag.",
  ].join("\n\n");
}

function parseAvatarRequest(value: SagaAvatarGenerationRequest): ParsedSagaAvatarGenerationRequest {
  const parsed = sagaAvatarGenerationRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new SagaAvatarPrivacyError(
    "Avatarunderlaget behöver ett privat profil-ID och tre till sex privata referensbilder.",
    { code: "invalid_request", status: 400 },
  );
}

function assessRequest(request: ParsedSagaAvatarGenerationRequest): SagaAvatarPrivacyFinding[] {
  const findings: SagaAvatarPrivacyFinding[] = [];
  if (containsForbiddenFaceVisibilityRequest(request.requestedVisualDirection)) {
    findings.push({
      code: "forbidden_face_visibility_request",
      severity: "blocker",
      field: "requestedVisualDirection",
      message: "SAGA-avatarer får aldrig beställas med ett helt, frontalt eller igenkännbart ansikte.",
    });
  }
  if (containsUnsafeScene(request.requestedVisualDirection)) {
    findings.push({
      code: "unsafe_scene",
      severity: "blocker",
      field: "requestedVisualDirection",
      message: "Avatarbilden får inte bygga på fara, våld, en krock, skrämsel eller en situation där någon kan skadas.",
    });
  }
  if (!hasExplicitProviderTransferConsent(request)) {
    findings.push({
      code: "provider_transfer_consent_required",
      severity: "warning",
      field: "providerTransferConsent",
      message: "Privata referensbilder stannar i SAGA tills du för just denna körning har godkänt att den valda bildleverantören får ta emot dem och läst dess datavillkor.",
    });
  }
  return findings;
}

function privateOnlyCapabilities(canCreatePrivateDraft: boolean): SagaAvatarPolicyCapabilities {
  return {
    canCreatePrivateDraft,
    canEnterCalendar: false,
    canPublish: false,
    canUseExternalAccounts: false,
  };
}

function hasExplicitProviderTransferConsent(request: ParsedSagaAvatarGenerationRequest): boolean {
  return request.providerTransferConsent.allowReferenceTransferForThisRun
    && request.providerTransferConsent.retentionChoice === "acknowledged_provider_terms";
}

function safePresentationDirection(presentation: SagaAvatarSafePresentation): string {
  switch (presentation) {
    case "back_three_quarter":
      return "personen avbildas bakifrån i trekvarts vinkel, med ansiktet helt vänt bort från kameran och mjukt noir-ljus";
    case "cropped_profile":
      return "en kraftigt beskuren sidoprofil där ansiktet delvis hamnar utanför bild och den synliga delen ligger i mjuk skugga";
    case "silhouette":
      return "en helt anonym silhuett mot dämpat sidoljus, utan synliga ansiktsdrag";
    case "noir_shadow":
    default:
      return "en noir-inspirerad trekvarts bakifrån-komposition, med djup skugga över ansiktet och en diskret ljuskant längs silhuetten";
  }
}

function containsForbiddenFaceVisibilityRequest(value: string): boolean {
  const text = normalize(value);
  if (!text) return false;
  return [
    /\b(?:visa|show|gör|make)\s+(?:mitt\s+|min\s+)?(?:hela|helt|full(?:t)?)\s+(?:ansikte|face)\b/u,
    /\b(?:full\s+face|fullt\s+ansikte|hela\s+ansiktet|ansiktet\s+helt\s+synligt|tydligt\s+ansikte)\b/u,
    /\b(?:frontal(?:t)?|front\s*facing|rakt\s+fram|ansikte\s+framifran|ansiktet\s+framifran)\b/u,
    /\b(?:igenkannbar(?:t)?\s+(?:ansikte|face)|recognizable\s+face|identifiable\s+face|biometric\s+(?:portrait|likeness))\b/u,
    /\b(?:se\s+ut\s+exakt\s+som\s+mig|looks?\s+exactly\s+like\s+me|show\s+my\s+face)\b/u,
  ].some((pattern) => pattern.test(text));
}

function containsUnsafeScene(value: string): boolean {
  const text = normalize(value);
  if (!text) return false;
  if (/\b(?:jump\s*scare|skramsel(?:effekt|film)|skramma\s+tittaren|chocka\s+(?:tittaren|folk))\b/u.test(text)) return true;
  if (/\b(?:bilkrock|krockar|kraschar|crash(?:es|ing)?|collision|smaller\s+in|kor\s+in\s+i|v[aå]ld)\b/u.test(text)) return true;

  const falling = /\b(?:faller|fallande|falla|droppar|droppande|slapps|slapper|kastas|flyger\s+mot|falling|falls|drop|drops|dropping)\b/u.test(text);
  const object = /\b(?:hjul|dack|wheel|tire|foremal|object|sten|skylt|balkong)\b/u.test(text);
  const people = /\b(?:folksamling|mannisk(?:a|or)|person(?:er)?|crowd|people|gata[nr]?\s+nedan|nedanfor)\b/u.test(text);
  const height = /\b(?:balkong|tionde\s+vaning|10(?::e|e)?\s+vaning|hog\s+byggnad|uppifran)\b/u.test(text);
  return falling && object && (people || height);
}

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/\s+/g, " ")
    .trim();
}
