import { afterEach, describe, expect, it, vi } from "vitest";
import { getNewsletterProviderAvailability, renderNewsletterHtml, sendNewsletterMessage } from "@/lib/services/newsletter-publishing";

const originalApiKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.NEWSLETTER_FROM;
const originalReplyTo = process.env.NEWSLETTER_REPLY_TO;
const originalPublicBaseUrl = process.env.NEWSLETTER_PUBLIC_BASE_URL;
const originalUnsubscribeSecret = process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;

const message = {
  to: "erik@example.com",
  subject: "Veckans signaler",
  headline: "Det här ändrades",
  body: "Första stycket.\n\nAndra stycket.",
  callToAction: "Läs mer",
  callToActionUrl: "https://example.com/read",
  unsubscribeUrl: "https://brief.example.com/api/newsletter/unsubscribe?token=opaque-token",
  idempotencyKey: "delivery-12345678",
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalApiKey;
  if (originalFrom === undefined) delete process.env.NEWSLETTER_FROM; else process.env.NEWSLETTER_FROM = originalFrom;
  if (originalReplyTo === undefined) delete process.env.NEWSLETTER_REPLY_TO; else process.env.NEWSLETTER_REPLY_TO = originalReplyTo;
  if (originalPublicBaseUrl === undefined) delete process.env.NEWSLETTER_PUBLIC_BASE_URL; else process.env.NEWSLETTER_PUBLIC_BASE_URL = originalPublicBaseUrl;
  if (originalUnsubscribeSecret === undefined) delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET; else process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = originalUnsubscribeSecret;
});

describe("nyhetsbrev", () => {
  it("escape:ar redaktionellt innehåll och släpper inte in rå HTML", () => {
    const html = renderNewsletterHtml({ ...message, headline: "<script>x</script>", body: "<img src=x>" });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Avsluta prenumeration");
  });

  it("skickar ett privat mottagarutskick när konfigurationen finns", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.NEWSLETTER_FROM = "Brief <hello@example.com>";
    process.env.NEWSLETTER_PUBLIC_BASE_URL = "https://brief.example.com";
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = Buffer.alloc(32, 1).toString("base64");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendNewsletterMessage(message)).resolves.toEqual({ providerMessageId: "email_123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer re_test", "x-entity-ref-id": message.idempotencyKey });
    expect(JSON.parse(String(init.body))).toMatchObject({
      to: [message.to],
      subject: message.subject,
      headers: { "List-Unsubscribe": "<" + message.unsubscribeUrl + ">" },
    });
  });

  it("skickar aldrig utan nyckel och avsändare", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.NEWSLETTER_FROM;
    await expect(sendNewsletterMessage(message)).rejects.toMatchObject({ code: "configuration_required" });
  });

  it("skickar aldrig ett nyhetsbrev utan avregistreringslänk", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.NEWSLETTER_FROM = "Brief <hello@example.com>";
    await expect(sendNewsletterMessage({ ...message, unsubscribeUrl: null })).rejects.toMatchObject({
      code: "unsubscribe_required",
    });
  });

  it("visar att både leverantör och avregistrering måste vara konfigurerade", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.NEWSLETTER_FROM = "Brief <hello@example.com>";
    delete process.env.NEWSLETTER_PUBLIC_BASE_URL;
    delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;
    expect(getNewsletterProviderAvailability()).toEqual(expect.objectContaining({
      configured: false,
      missing: expect.arrayContaining(["NEWSLETTER_PUBLIC_BASE_URL", "NEWSLETTER_UNSUBSCRIBE_SECRET"]),
    }));
  });
});
