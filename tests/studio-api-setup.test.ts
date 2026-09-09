import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { GET as getAutomations, POST as createAutomation } from "@/app/api/content/automations/route";
import { GET as getCalendar } from "@/app/api/content/calendar/route";
import { GET as getDrafts, POST as createDraft } from "@/app/api/content/drafts/route";
import { GET as getNewsletterAudienceConfiguration, POST as createNewsletterAudience } from "@/app/api/content/newsletter-audiences/route";
import { GET as getTemplates, POST as createTemplate } from "@/app/api/content/templates/route";
import { GET as getNewsletterAudienceSummaries } from "@/app/api/newsletter/audiences/route";
import { GET as getNewsletterStatus } from "@/app/api/newsletter/status/route";

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function removeSupabaseConfiguration() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function post(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Studions första API-anrop utan datalager", () => {
  it("svarar tydligt på varje läsning i stället för med en dold 500", async () => {
    removeSupabaseConfiguration();

    const responses = await Promise.all([
      getDrafts(new NextRequest("http://localhost/api/content/drafts?include=media")),
      getTemplates(),
      getAutomations(),
      getCalendar(new NextRequest("http://localhost/api/content/calendar?from=2026-08-01&to=2026-09-12&timezone=Europe%2FStockholm")),
      getNewsletterAudienceConfiguration(),
      getNewsletterAudienceSummaries(),
      getNewsletterStatus(),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      await expect(response.json()).resolves.toMatchObject({ code: "configuration_required" });
    }

    // Calendar and draft reads are now Vercel/Neon-only. They must never
    // revive the retired store merely because DATABASE_URL is absent.
    await expect(getDrafts(new NextRequest("http://localhost/api/content/drafts?include=media"))).resolves.toMatchObject({
      status: 503,
    });
    const draftPayload = await (await getDrafts(new NextRequest("http://localhost/api/content/drafts?include=media"))).json();
    expect(draftPayload).toMatchObject({ missing: ["DATABASE_URL"] });
    const calendarPayload = await (await getCalendar(new NextRequest("http://localhost/api/content/calendar?from=2026-08-01&to=2026-09-12&timezone=Europe%2FStockholm"))).json();
    expect(calendarPayload).toMatchObject({ missing: ["DATABASE_URL"] });
  });

  it("stoppar skrivkontroller före validering eller en instabil Supabase-klient", async () => {
    removeSupabaseConfiguration();

    const responses = await Promise.all([
      createDraft(post("/api/content/drafts")),
      createTemplate(post("/api/content/templates")),
      createAutomation(post("/api/content/automations")),
      createNewsletterAudience(post("/api/content/newsletter-audiences")),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "configuration_required" });
    }
  });
});
