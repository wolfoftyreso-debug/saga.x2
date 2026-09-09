import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { allowPublicUnsubscribeRequest } from "@/lib/services/public-unsubscribe-rate-limit";
import {
  createNewsletterUnsubscribeUrl,
  getNewsletterUnsubscribeAvailability,
  readNewsletterUnsubscribeToken,
} from "@/lib/services/newsletter-unsubscribe";

const unsubscribeContact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/newsletter-delivery", () => ({
  unsubscribeNewsletterContact: unsubscribeContact,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}),
}));
import { POST as unsubscribePost } from "@/app/api/newsletter/unsubscribe/route";

const originalBaseUrl = process.env.NEWSLETTER_PUBLIC_BASE_URL;
const originalSecret = process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;

afterEach(() => {
  vi.useRealTimers();
  unsubscribeContact.mockReset();
  if (originalBaseUrl === undefined) delete process.env.NEWSLETTER_PUBLIC_BASE_URL; else process.env.NEWSLETTER_PUBLIC_BASE_URL = originalBaseUrl;
  if (originalSecret === undefined) delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET; else process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = originalSecret;
});

function configure() {
  process.env.NEWSLETTER_PUBLIC_BASE_URL = "https://brief.example";
  process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = randomBytes(32).toString("base64");
}

describe("avprenumeringslänkar", () => {
  it("ger en krypterad, tidsbegränsad länk utan råa interna id:n", () => {
    configure();
    const contactId = "a2f408be-8f50-4f1d-87fe-3d3daa039d0a";
    const audienceId = "bf21bbaf-5c14-4b4e-8f3b-14a68d7c90de";
    const url = new URL(createNewsletterUnsubscribeUrl({ contactId, audienceId }));
    const token = url.searchParams.get("token");
    expect(url.origin).toBe("https://brief.example");
    expect(url.pathname).toBe("/api/newsletter/unsubscribe");
    expect(url.toString()).not.toContain(contactId);
    expect(url.toString()).not.toContain(audienceId);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(readNewsletterUnsubscribeToken(String(token))).toMatchObject({ contactId, audienceId });
  });

  it("avvisar en ändrad eller utgången token utan databasuppslag", () => {
    configure();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T07:00:00.000Z"));
    const token = new URL(createNewsletterUnsubscribeUrl({
      contactId: "a2f408be-8f50-4f1d-87fe-3d3daa039d0a",
      audienceId: "bf21bbaf-5c14-4b4e-8f3b-14a68d7c90de",
      expiresInSeconds: 3_600,
    })).searchParams.get("token")!;
    expect(readNewsletterUnsubscribeToken(`${token}x`)).toBeNull();
    vi.setSystemTime(new Date("2026-08-22T08:00:01.000Z"));
    expect(readNewsletterUnsubscribeToken(token)).toBeNull();
  });

  it("kräver en offentlig URL och en 256-bitars serverhemlighet", () => {
    delete process.env.NEWSLETTER_PUBLIC_BASE_URL;
    delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;
    expect(getNewsletterUnsubscribeAvailability()).toEqual({
      configured: false,
      missing: ["NEWSLETTER_PUBLIC_BASE_URL", "NEWSLETTER_UNSUBSCRIBE_SECRET"],
    });
  });

  it("bromsar upprepade publika anrop utan att behålla rå IP-adress", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.4" });
    const now = 1_000_000;
    for (let index = 0; index < 20; index += 1) expect(allowPublicUnsubscribeRequest(headers, now)).toBe(true);
    expect(allowPublicUnsubscribeRequest(headers, now)).toBe(false);
    expect(allowPublicUnsubscribeRequest(headers, now + 60_001)).toBe(true);
  });

  it("stödjer e-postklienters List-Unsubscribe-POST där token ligger i URL:en", async () => {
    configure();
    const url = createNewsletterUnsubscribeUrl({
      contactId: "a2f408be-8f50-4f1d-87fe-3d3daa039d0a",
      audienceId: "bf21bbaf-5c14-4b4e-8f3b-14a68d7c90de",
    });
    unsubscribeContact.mockResolvedValue(true);
    const response = await unsubscribePost(new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Du kommer inte att få fler nyhetsbrev");
    expect(unsubscribeContact).toHaveBeenCalledWith(expect.anything(), {
      contactId: "a2f408be-8f50-4f1d-87fe-3d3daa039d0a",
      audienceId: "bf21bbaf-5c14-4b4e-8f3b-14a68d7c90de",
      expiresAt: expect.any(String),
    });
  });
});
