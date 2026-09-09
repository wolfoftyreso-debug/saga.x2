import "server-only";
import {
  newsletterMessageSchema,
  type NewsletterMessage,
  type NewsletterProviderAvailability,
  type NewsletterSendResult,
} from "@/lib/domain/newsletter";
import { getNewsletterUnsubscribeAvailability } from "@/lib/services/newsletter-unsubscribe";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export class NewsletterPublishError extends Error {
  constructor(message: string, readonly code = "newsletter_publish_failed") {
    super(message);
    this.name = "NewsletterPublishError";
  }
}

type NewsletterProviderConfig = {
  apiKey: string;
  from: string;
  replyTo: string | null;
};

/**
 * The studio owns audience consent and durable delivery receipts. This
 * server-only seam only sends one already-approved message to one recipient.
 */
export function getNewsletterProviderAvailability(): NewsletterProviderAvailability {
  const missing: string[] = [];
  if (!process.env.RESEND_API_KEY?.trim()) missing.push("RESEND_API_KEY");
  if (!process.env.NEWSLETTER_FROM?.trim()) missing.push("NEWSLETTER_FROM");
  const unsubscribe = getNewsletterUnsubscribeAvailability();
  missing.push(...unsubscribe.missing);
  return { configured: missing.length === 0, missing };
}

export async function sendNewsletterMessage(input: NewsletterMessage): Promise<NewsletterSendResult> {
  const message = newsletterMessageSchema.parse(input);
  if (!message.unsubscribeUrl) {
    throw new NewsletterPublishError(
      "Nyhetsbrevet saknar en säker avregistreringslänk och skickas därför inte.",
      "unsubscribe_required",
    );
  }
  const config = getNewsletterProviderConfig();
  const response = await safeFetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      authorization: "Bearer " + config.apiKey,
      "content-type": "application/json",
      // Trace ID only. Exactly-once protection is our own delivery receipt.
      "x-entity-ref-id": message.idempotencyKey,
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      html: renderNewsletterHtml(message),
      text: renderNewsletterText(message),
      headers: {
        "List-Unsubscribe": "<" + message.unsubscribeUrl + ">",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await responseJson(response);
  if (!response.ok) {
    throw new NewsletterPublishError(
      response.status === 401 || response.status === 403
        ? "Nyhetsbrevskontot saknar giltig behörighet. Kontrollera Resend-nyckeln och avsändardomänen."
        : "Nyhetsbrevet kunde inte skickas. Försök igen.",
      "resend_" + response.status,
    );
  }
  const id = typeof payload.id === "string" && payload.id.trim() ? payload.id : null;
  if (!id) throw new NewsletterPublishError("E-postleverantören bekräftade inte något meddelande-id.", "resend_invalid_response");
  return { providerMessageId: id };
}

export function renderNewsletterText(input: NewsletterMessage): string {
  const message = newsletterMessageSchema.parse(input);
  const lines = [message.headline, message.body];
  if (message.callToAction) lines.push(message.callToAction);
  if (message.callToActionUrl) lines.push(message.callToActionUrl);
  if (message.unsubscribeUrl) lines.push("Avsluta prenumeration: " + message.unsubscribeUrl);
  return lines.filter(Boolean).join("\n\n");
}

/** Render only plain authored text. The editor cannot inject raw HTML. */
export function renderNewsletterHtml(input: NewsletterMessage): string {
  const message = newsletterMessageSchema.parse(input);
  const heading = message.headline ? "<h1>" + escapeHtml(message.headline) + "</h1>" : "";
  const preview = message.previewText
    ? "<span style=\"display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;\">" + escapeHtml(message.previewText) + "</span>"
    : "";
  const paragraphs = message.body.split(/\n{2,}/).filter(Boolean)
    .map((paragraph) => "<p>" + escapeHtml(paragraph).replace(/\n/g, "<br>") + "</p>")
    .join("");
  const cta = message.callToAction && message.callToActionUrl
    ? "<p><a href=\"" + escapeAttribute(message.callToActionUrl) + "\">" + escapeHtml(message.callToAction) + "</a></p>"
    : message.callToAction ? "<p><strong>" + escapeHtml(message.callToAction) + "</strong></p>" : "";
  const unsubscribe = message.unsubscribeUrl
    ? "<p style=\"margin-top:32px;padding-top:16px;border-top:1px solid #deded8;color:#58635f;font-size:12px;\"><a href=\"" + escapeAttribute(message.unsubscribeUrl) + "\" style=\"color:#58635f;\">Avsluta prenumeration</a></p>"
    : "";
  return "<!doctype html><html lang=\"sv\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"margin:0;background:#f4f3ed;color:#1d342a;font-family:Arial,sans-serif;\"><main style=\"max-width:640px;margin:0 auto;padding:32px 24px;background:#fffefa;line-height:1.55;\">" + preview + heading + paragraphs + cta + unsubscribe + "</main></body></html>";
}

function getNewsletterProviderConfig(): NewsletterProviderConfig {
  const availability = getNewsletterProviderAvailability();
  if (!availability.configured) {
    throw new NewsletterPublishError("Nyhetsbrev är inte konfigurerat: " + availability.missing.join(", ") + ".", "configuration_required");
  }
  return {
    apiKey: process.env.RESEND_API_KEY!.trim(),
    from: process.env.NEWSLETTER_FROM!.trim(),
    replyTo: process.env.NEWSLETTER_REPLY_TO?.trim() || null,
  };
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new NewsletterPublishError("E-postleverantören kunde inte nås just nu.", "provider_unavailable");
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
