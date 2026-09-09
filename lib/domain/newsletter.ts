import { z } from "zod";

/**
 * One recipient is one delivery unit. Recipients never appear in each
 * other's email headers and the scheduler can keep an exact receipt.
 */
export const newsletterMessageSchema = z.object({
  to: z.string().trim().email("Mottagarens e-postadress är ogiltig."),
  subject: z.string().trim().min(1, "Nyhetsbrevet behöver en ämnesrad.").max(180),
  headline: z.string().trim().max(220).optional().default(""),
  body: z.string().trim().min(1, "Nyhetsbrevet behöver innehåll.").max(40_000),
  callToAction: z.string().trim().max(500).nullable().optional(),
  callToActionUrl: z.string().url("CTA-länken är ogiltig.").max(2_000).nullable().optional(),
  previewText: z.string().trim().max(300).nullable().optional(),
  // Every delivery created by the studio gets a recipient-specific URL. It is
  // optional in the transport shape so previews can render before a recipient
  // exists; the publisher refuses to send without it.
  unsubscribeUrl: z.string().url("Avregistreringslänken är ogiltig.").max(2_000).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(240),
});

export type NewsletterMessage = z.infer<typeof newsletterMessageSchema>;

export type NewsletterProviderAvailability = {
  configured: boolean;
  missing: string[];
};

export type NewsletterSendResult = {
  providerMessageId: string;
};
