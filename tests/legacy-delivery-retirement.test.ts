import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn(),
  createManualJob: vi.fn(),
  claimManualJob: vi.fn(),
  getDraft: vi.fn(),
  processClaim: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
  neonWriteErrorResponse: mocks.neonWriteErrorResponse,
}));

vi.mock("@/lib/neon/studio-content-repository", () => ({
  createStudioManualAutomationJob: mocks.createManualJob,
  claimStudioManualAutomationJob: mocks.claimManualJob,
  getStudioDraft: mocks.getDraft,
}));

vi.mock("@/lib/neon/studio-automation-worker", () => ({
  processNeonStudioAutomationClaim: mocks.processClaim,
}));

import { GET as retiredDailyBrief } from "@/app/api/cron/daily-brief/route";
import { POST as manualAutomationRun } from "@/app/api/content/automations/[id]/run/route";
import { isLegacySupabaseApiPath } from "@/lib/runtime/vercel-only";

const automationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("retired legacy delivery paths", () => {
  it("keeps the old daily cron URL as an explicit, non-delivering retirement response", async () => {
    const response = await retiredDailyBrief();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "legacy_cron_retired",
      error: "Den äldre dagliga cron-rutten är avvecklad. Inget innehåll har skapats, skickats eller publicerats.",
      noPublication: true,
      replacement: "/api/cron/tick",
    });
  });

  it("allows the retired handler itself to return its safe response in Vercel mode", () => {
    expect(isLegacySupabaseApiPath("/api/cron/daily-brief")).toBe(false);
  });

  it("fails a manual run at the Neon configuration boundary before any legacy fallback can run", async () => {
    const configuration = NextResponse.json(
      { error: "Studio behöver Neon.", code: "configuration_required", missing: ["DATABASE_URL"] },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
    mocks.neonConfigurationResponse.mockReturnValueOnce(configuration);

    const response = await manualAutomationRun(
      new NextRequest(`https://saga.example/api/content/automations/${automationId}/run`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: automationId }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "configuration_required", missing: ["DATABASE_URL"] });
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
    expect(mocks.createManualJob).not.toHaveBeenCalled();
    expect(mocks.claimManualJob).not.toHaveBeenCalled();
    expect(mocks.processClaim).not.toHaveBeenCalled();
  });

  it("does not leave a Supabase delivery import or legacy runner reachable from either route", () => {
    const dailyBrief = source("app/api/cron/daily-brief/route.ts");
    const manualRun = source("app/api/content/automations/[id]/run/route.ts");

    expect(dailyBrief).not.toMatch(/from\s+["']@\/lib\/supabase\//u);
    expect(dailyBrief).not.toContain("runContentStudioScheduler");
    expect(dailyBrief).not.toContain("runDailyBrief");
    expect(manualRun).not.toMatch(/from\s+["']@\/lib\/supabase\//u);
    expect(manualRun).not.toContain("runContentAutomationNow");
  });
});
