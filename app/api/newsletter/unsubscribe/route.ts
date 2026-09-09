import { NextRequest, NextResponse } from "next/server";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { unsubscribeNewsletterContact } from "@/lib/services/newsletter-delivery";
import { allowPublicUnsubscribeRequest } from "@/lib/services/public-unsubscribe-rate-limit";
import { readNewsletterUnsubscribeToken } from "@/lib/services/newsletter-unsubscribe";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isNeonDatabaseConfigured()) return deliveryUnavailablePage();
  if (!allowPublicUnsubscribeRequest(request.headers)) return neutralRateLimitedResponse();
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const target = readNewsletterUnsubscribeToken(token);
  if (!target) return neutralInvalidResponse();
  return new NextResponse(confirmPage(token), { status: 200, headers: pageHeaders() });
}

export async function POST(request: NextRequest) {
  if (isNeonDatabaseConfigured()) return deliveryUnavailablePage();
  if (!allowPublicUnsubscribeRequest(request.headers)) return neutralRateLimitedResponse();
  // RFC 8058 one-click clients POST `List-Unsubscribe=One-Click` but retain
  // our opaque token in the URL. The confirmation form uses its hidden field.
  let token = request.nextUrl.searchParams.get("token") ?? "";
  try {
    const form = await request.formData();
    const raw = form.get("token");
    if (typeof raw === "string" && raw) token = raw;
  } catch {
    // A valid List-Unsubscribe POST may use an unsupported body encoding; the
    // signed URL token is still enough to process it safely.
  }
  const target = readNewsletterUnsubscribeToken(token);
  if (!target) return neutralInvalidResponse();
  try {
    // Both an already-unsubscribed contact and a contact removed after the
    // email was sent receive the same response. Nothing identifies a person.
    await unsubscribeNewsletterContact(createAdminClient(), target);
  } catch {
    // Do not claim success when the database was unavailable. The response
    // remains neutral and reveals no subscription or operational detail.
    return new NextResponse(
      page("Kunde inte slutföra", "Försök igen om en stund."),
      { status: 503, headers: { ...pageHeaders(), "retry-after": "60" } },
    );
  }
  return new NextResponse(successPage(), { status: 200, headers: pageHeaders() });
}

function neutralInvalidResponse() {
  return new NextResponse(
    page("Länken kan inte användas", "Den här avprenumeringslänken är ogiltig eller har gått ut."),
    { status: 200, headers: pageHeaders() },
  );
}

function neutralRateLimitedResponse() {
  return new NextResponse(
    page("För många försök", "Försök igen om en stund."),
    { status: 429, headers: { ...pageHeaders(), "retry-after": "60" } },
  );
}

/** No old Supabase unsubscribe write may run in a Vercel/Neon deployment. */
function deliveryUnavailablePage() {
  return new NextResponse(
    page("Utskick är inte aktiverat", "Den här installationen har ännu ingen e-postleverantör. Kontakta avsändaren om du behöver hjälp."),
    { status: 503, headers: { ...pageHeaders(), "retry-after": "3600" } },
  );
}

function confirmPage(token: string): string {
  const safeToken = escapeHtml(token);
  return page(
    "Avsluta prenumeration",
    "Bekräfta om du inte längre vill få dessa nyhetsbrev.",
    `<form method="post" action="/api/newsletter/unsubscribe"><input type="hidden" name="token" value="${safeToken}"><button type="submit">Avsluta prenumeration</button></form>`,
  );
}

function successPage(): string {
  return page("Klart", "Du kommer inte att få fler nyhetsbrev från den här listan.");
}

function page(title: string, message: string, extra = ""): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f3ed;color:#1d342a;font-family:Arial,sans-serif"><main style="max-width:560px;margin:64px auto;padding:32px;background:#fffefa;border-radius:18px"><h1 style="margin-top:0">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}</main></body></html>`;
}

function pageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, private",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
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
