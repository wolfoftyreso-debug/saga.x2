import { describe, expect, it, vi } from "vitest";
import { newsletterContactCreateSchema, newsletterContactUpdateSchema } from "@/lib/domain/newsletter-delivery";
import {
  newsletterMessageForClaim,
  nextNewsletterRetryAt,
  outcomeForNewsletterDeliveryError,
  claimNewsletterDeliveryReceipts,
  completeNewsletterDeliveryReceipt,
} from "@/lib/services/newsletter-delivery";

describe("nyhetsbrevsleverans", () => {
  it("kräver en giltig mottagare och sätter samtyckt prenumeration som standard", () => {
    const parsed = newsletterContactCreateSchema.parse({
      audienceId: "a2f408be-8f50-4f1d-87fe-3d3daa039d0a",
      email: "  erik@example.com ",
    });
    expect(parsed.email).toBe("erik@example.com");
    expect(parsed.status).toBe("subscribed");
    expect(parsed.consentSource).toBe("manual");
    expect(newsletterContactUpdateSchema.parse({})).toEqual({});
    expect(() => newsletterContactCreateSchema.parse({ audienceId: parsed.audienceId, email: "inte-en-adress" })).toThrow();
  });

  it("bygger alltid ett privat meddelande för exakt en claimad mottagare", () => {
    const message = newsletterMessageForClaim({
      receiptId: "receipt-1",
      claimToken: "claim-1",
      userId: "user-1",
      contentDraftId: "draft-1",
      newsletterAudienceId: "audience-1",
      contactId: "contact-1",
      recipientEmail: "erik@example.com",
      recipientName: "Erik",
      subject: "Veckans viktigaste",
      headline: "Det här ändrades",
      body: "Rakt på sak.",
      cta: "Svara gärna.",
      excerpt: "Kort förhandsvisning.",
      idempotencyKey: "newsletter:stable-key",
      attemptNumber: 1,
    });
    expect(message).toMatchObject({ to: "erik@example.com", subject: "Veckans viktigaste", idempotencyKey: "newsletter:stable-key" });
    expect(Array.isArray(message.to)).toBe(false);
  });

  it("markerar osäker nätverksleverans som okänd i stället för att duplicera den", () => {
    const outcome = outcomeForNewsletterDeliveryError({ code: "provider_unavailable", message: "Nätet bröts" }, 1);
    expect(outcome).toEqual({ kind: "unknown", errorCode: "provider_unavailable", errorMessage: "Nätet bröts" });
  });

  it("backar av bestämda providerfel utan en busy retry-loop", () => {
    const now = new Date("2026-08-22T07:00:00.000Z");
    const outcome = outcomeForNewsletterDeliveryError(Object.assign(new Error("Tillfälligt fel"), { code: "resend_503" }), 2, now);
    expect(outcome).toMatchObject({ kind: "failed", errorCode: "resend_503", nextAttemptAt: "2026-08-22T07:15:00.000Z" });
    expect(nextNewsletterRetryAt(4, now)).toBe("2026-08-22T09:00:00.000Z");
  });

  it("skickar alltid användar-id till både claim och avslut av leveransen", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const client = { rpc } as never;
    const userId = "a2f408be-8f50-4f1d-87fe-3d3daa039d0a";
    await claimNewsletterDeliveryReceipts(client, userId, { limit: 3 });
    await completeNewsletterDeliveryReceipt(client, userId, { receiptId: "receipt-1", claimToken: "claim-1" }, { kind: "delivered", providerMessageId: "email_1" });
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_newsletter_delivery_receipts", expect.objectContaining({ p_user_id: userId, p_limit: 3 }));
    expect(rpc).toHaveBeenNthCalledWith(2, "complete_newsletter_delivery_receipt", expect.objectContaining({ p_user_id: userId, p_receipt_id: "receipt-1" }));
  });
});
