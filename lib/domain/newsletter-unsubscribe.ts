import { z } from "zod";

const uuidSchema = z.string().uuid();

export const newsletterUnsubscribeTokenSchema = z.string().trim().min(40).max(4_096)
  .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Avprenumerationslänken är ogiltig.");

export const newsletterUnsubscribeTargetSchema = z.object({
  contactId: uuidSchema,
  audienceId: uuidSchema,
  expiresInSeconds: z.number().int().min(3_600).max(2 * 365 * 24 * 60 * 60).optional(),
});

export type NewsletterUnsubscribeTarget = z.infer<typeof newsletterUnsubscribeTargetSchema>;

export type NewsletterUnsubscribeTokenPayload = {
  contactId: string;
  audienceId: string;
  expiresAt: string;
};
