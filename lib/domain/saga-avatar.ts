import { z } from "zod";

/**
 * These are privacy policies, not cosmetic options.  A profile can use source
 * photos to establish a private likeness reference, while every generated
 * output remains face-obscured and requires a later visual review gate.
 */
export const SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY = "obscured_noir_only" as const;
export const SAGA_AVATAR_PROVIDER = "vercel_ai_gateway" as const;
export const SAGA_AVATAR_REFERENCE_CONSENT_VERSION = "saga_avatar_reference_upload_v1" as const;
export const SAGA_AVATAR_PROVIDER_CONSENT_VERSION = "saga_avatar_vercel_gateway_processing_v1" as const;

export const sagaAvatarReferenceAngleSchema = z.enum([
  "front",
  "three_quarter_left",
  "three_quarter_right",
  "left_profile",
  "right_profile",
  "back",
  "other",
]);

export type SagaAvatarReferenceAngle = z.infer<typeof sagaAvatarReferenceAngleSchema>;

export const createSagaAvatarProfileSchema = z.object({
  label: z.string().trim().min(1).max(120),
  /**
   * Explicit upload consent. The UI must show the purpose and the fact that
   * raw source photos stay private before it sends this field.
   */
  uploadConsent: z.literal(true),
}).strict();

export const updateSagaAvatarProfileSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  /**
   * Upload consent and model-provider processing are separate. Enabling this
   * has to be an intentional, per-profile action after upload.
   */
  providerProcessingConsent: z.object({
    provider: z.literal(SAGA_AVATAR_PROVIDER),
    accepted: z.boolean(),
  }).strict().optional(),
}).strict().refine((value) => value.label !== undefined || value.providerProcessingConsent !== undefined, {
  message: "Minst en profilinställning måste ändras.",
});

export const sagaAvatarProfileIdSchema = z.string().uuid();
export const sagaAvatarReferenceIdSchema = z.string().uuid();

export type SagaAvatarReferenceView = {
  id: string;
  angle: SagaAvatarReferenceAngle;
  position: number;
  createdAt: string;
};

export type SagaAvatarProfileView = {
  id: string;
  label: string;
  referenceCount: number;
  references: SagaAvatarReferenceView[];
  outputVisibilityPolicy: typeof SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY;
  /** This invariant is always false and is never writable via an API. */
  fullFaceAllowed: false;
  providerProcessing: {
    provider: typeof SAGA_AVATAR_PROVIDER;
    enabled: boolean;
    consented: boolean;
    /** False until both provider consent and 3–6 references exist. */
    readyForPrivateModelUse: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export function avatarReferenceAngleLabel(angle: SagaAvatarReferenceAngle): string {
  return {
    front: "Framifrån (privat referens)",
    three_quarter_left: "Tre kvarts vänster",
    three_quarter_right: "Tre kvarts höger",
    left_profile: "Vänster profil",
    right_profile: "Höger profil",
    back: "Bakifrån",
    other: "Övrig vinkel",
  }[angle];
}
