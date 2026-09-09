import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as socialChannels } from "@/app/api/social/channels/route";
import { GET as newsletterStatus } from "@/app/api/newsletter/status/route";
import {
  GET as newsletterAudiences,
  POST as createNewsletterAudience,
} from "@/app/api/content/newsletter-audiences/route";
import { POST as adaptMedia } from "@/app/api/content/media/[mediaId]/adapt/route";

const originalDatabaseUrl = process.env.DATABASE_URL;
const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe.sequential("Vercel feature boundaries", () => {
  it("does not fall back to the retired Supabase store when Vercel auth is unavailable", async () => {
    const response = await socialChannels();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: [],
    });
  });

  it("keeps newsletter delivery unavailable while audience storage never falls back to Supabase", async () => {
    const [read, create, status] = await Promise.all([
      newsletterAudiences(),
      createNewsletterAudience(new NextRequest("http://localhost/api/content/newsletter-audiences", { method: "POST", body: "{}" })),
      newsletterStatus(),
    ]);

    expect(read.status).toBe(503);
    await expect(read.json()).resolves.toMatchObject({ code: "configuration_required", missing: [] });
    await expect(create.json()).resolves.toMatchObject({ code: "configuration_required", missing: [] });
    await expect(status.json()).resolves.toMatchObject({
      configured: false,
      code: "newsletter_delivery_not_configured",
      missing: ["Vercel e-postleverantör"],
    });
  });

  it("leaves a private Blob original alone until its Vercel image adapter exists", async () => {
    const response = await adaptMedia(
      new NextRequest(`http://localhost/api/content/media/${mediaId}/adapt`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ mediaId }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "feature_not_available" });
  });
});
