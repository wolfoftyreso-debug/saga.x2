import { z } from "zod";

const uuidSchema = z.string().uuid();
const emailSchema = z.string().trim().email("Ange en giltig e-postadress.").max(320);
const timestampSchema = z.string().datetime({ offset: true });

export const NEWSLETTER_CONTACT_STATUSES = ["subscribed", "unsubscribed", "bounced", "complained", "suppressed"] as const;
export const NEWSLETTER_DELIVERY_RECEIPT_STATES = ["queued", "sending", "delivered", "failed", "suppressed", "cancelled", "unknown"] as const;

export type NewsletterContactStatus = (typeof NEWSLETTER_CONTACT_STATUSES)[number];
export type NewsletterDeliveryReceiptState = (typeof NEWSLETTER_DELIVERY_RECEIPT_STATES)[number];

export const newsletterContactStatusSchema = z.enum(NEWSLETTER_CONTACT_STATUSES);
export const newsletterDeliveryReceiptStateSchema = z.enum(NEWSLETTER_DELIVERY_RECEIPT_STATES);

/**
 * Contact input intentionally contains consent state. A newsletter import is
 * never assumed to be consented just because it contains email addresses.
 */
export const newsletterContactInputSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().max(240).nullable().optional(),
  status: newsletterContactStatusSchema.default("subscribed"),
  consentSource: z.string().trim().min(1).max(160).default("manual"),
  consentedAt: timestampSchema.nullable().optional(),
  unsubscribedAt: timestampSchema.nullable().optional(),
  suppressionReason: z.string().trim().max(1_000).nullable().optional(),
  contactMetadata: z.record(z.string(), z.unknown()).default({}),
});

export const newsletterContactCreateSchema = newsletterContactInputSchema.extend({
  audienceId: uuidSchema,
});

export const newsletterContactUpdateSchema = newsletterContactInputSchema.partial();
export const newsletterContactIdSchema = uuidSchema;
export const newsletterAudienceIdSchema = uuidSchema;
export const newsletterDeliveryReceiptIdSchema = uuidSchema;

export const newsletterContactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  status: newsletterContactStatusSchema.optional(),
});

/** Only an owned newsletter draft with its selected audience may be staged. */
export const newsletterDeliveryStageSchema = z.object({
  contentDraftId: uuidSchema,
  newsletterAudienceId: uuidSchema,
});

export const newsletterDeliveryReceiptQuerySchema = z.object({
  contentDraftId: uuidSchema.optional(),
  audienceId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export type NewsletterContactInput = z.infer<typeof newsletterContactInputSchema>;
export type NewsletterContactCreateInput = z.infer<typeof newsletterContactCreateSchema>;
export type NewsletterContactUpdateInput = z.infer<typeof newsletterContactUpdateSchema>;
export type NewsletterDeliveryStageInput = z.infer<typeof newsletterDeliveryStageSchema>;
export type NewsletterDeliveryReceiptQuery = z.infer<typeof newsletterDeliveryReceiptQuerySchema>;

export type NewsletterContactView = {
  id: string;
  audienceId: string;
  email: string;
  displayName: string | null;
  status: NewsletterContactStatus;
  consentSource: string;
  consentedAt: string | null;
  unsubscribedAt: string | null;
  suppressionReason: string | null;
  contactMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** Safe to render next to an authored draft: it contains no recipient PII. */
export type NewsletterAudienceDeliverySummary = {
  audienceId: string;
  audienceName: string;
  audienceActive: boolean;
  contactCount: number;
  subscribedCount: number;
  unsubscribedCount: number;
  suppressedCount: number;
  queuedCount: number;
  sendingCount: number;
  deliveredCount: number;
  failedCount: number;
  unknownCount: number;
};

export type NewsletterDeliveryStageResult = {
  eligibleCount: number;
  insertedCount: number;
};

/** Safe operational history: recipient addresses are intentionally absent. */
export type NewsletterDeliveryReceiptView = {
  id: string;
  contentDraftId: string;
  audienceId: string;
  state: NewsletterDeliveryReceiptState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Private worker-only payload. Do not return this from ordinary UI routes. */
export type ClaimedNewsletterDelivery = {
  receiptId: string;
  claimToken: string;
  userId: string;
  contentDraftId: string;
  newsletterAudienceId: string;
  contactId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  headline: string | null;
  body: string;
  cta: string | null;
  excerpt: string | null;
  idempotencyKey: string;
  attemptNumber: number;
};

export type NewsletterDeliveryOutcome =
  | { kind: "delivered"; providerMessageId: string }
  | { kind: "failed"; errorCode: string; errorMessage: string; nextAttemptAt: string | null }
  | { kind: "unknown"; errorCode: string; errorMessage: string };
