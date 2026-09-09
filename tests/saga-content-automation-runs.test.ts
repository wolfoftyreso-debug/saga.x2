import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SagaContentAutomationRuns,
  sagaContentAutomationRunsFromPayload,
} from "@/components/saga-content-automation-runs";

describe("SAGA content automation run monitor", () => {
  it("projects only durable run facts and a narrow private draft outcome", () => {
    const value = sagaContentAutomationRunsFromPayload({
      automations: [{
        id: "automation-1",
        name: "Insikter om system",
        active: true,
        timezone: "Europe/Stockholm",
        scheduleMode: "cron",
        nextRunAt: "2026-08-26T07:00:00.000Z",
        lastRunAt: "2026-08-25T07:00:00.000Z",
        channels: ["linkedin"],
        generationPrompt: "Måste inte nå klienten",
      }],
      runs: [{
        id: "job-1",
        automationRuleId: "automation-1",
        automationName: "Insikter om system",
        automationActive: true,
        state: "completed",
        triggerKind: "scheduled",
        scheduledFor: "2026-08-25T07:00:00.000Z",
        timezone: "Europe/Stockholm",
        attemptCount: 1,
        maxAttemptCount: 3,
        claimedAt: "2026-08-25T07:00:01.000Z",
        lockedUntil: null,
        completedAt: "2026-08-25T07:00:04.000Z",
        createdAt: "2026-08-24T07:00:00.000Z",
        lastError: null,
        draft: {
          id: "draft-1",
          title: "Människan ska inte göra maskinens arbete",
          status: "draft",
          body: "Privat text får inte vara i körloggen",
          assetUrl: "https://private.blob.vercel-storage.com/private.jpg",
        },
      }],
    });

    expect(value).toEqual({
      automations: [{
        id: "automation-1",
        name: "Insikter om system",
        active: true,
        timezone: "Europe/Stockholm",
        scheduleMode: "cron",
        nextRunAt: "2026-08-26T07:00:00.000Z",
        lastRunAt: "2026-08-25T07:00:00.000Z",
        channels: ["linkedin"],
      }],
      runs: [expect.objectContaining({
        id: "job-1",
        state: "completed",
        draft: { id: "draft-1", title: "Människan ska inte göra maskinens arbete", status: "draft" },
      })],
    });
    expect(JSON.stringify(value)).not.toContain("generationPrompt");
    expect(JSON.stringify(value)).not.toContain("Privat text");
    expect(JSON.stringify(value)).not.toContain("private.blob");
  });

  it("renders a truthful empty/loading surface, not a fake execution preview", () => {
    const html = renderToStaticMarkup(createElement(SagaContentAutomationRuns));
    expect(html).toContain("Se exakt vad Cron har gjort.");
    expect(html).toContain("Läser verkliga automationskörningar");
    expect(html).toContain("Skapar aldrig publicering");
    expect(html).toContain("Annonsflöden har en separat arbetsyta");
    expect(html).not.toContain("Demokörning");
    expect(html).not.toContain("Fejk");
  });

  it("bounds an unknown failure detail before it reaches the run timeline", () => {
    const [run] = sagaContentAutomationRunsFromPayload({
      runs: [{
        id: "job-2",
        automationRuleId: "automation-1",
        automationName: "Systeminsikter",
        automationActive: true,
        state: "queued",
        triggerKind: "scheduled",
        scheduledFor: "2026-08-25T08:00:00.000Z",
        timezone: "Europe/Stockholm",
        attemptCount: 1,
        maxAttemptCount: 3,
        claimedAt: null,
        lockedUntil: null,
        completedAt: null,
        createdAt: "2026-08-25T07:59:00.000Z",
        failureCode: "unknown_worker_code",
        lastError: "x".repeat(900),
        draft: null,
      }],
    }).runs;

    expect(run?.lastError).toHaveLength(560);
    expect(run?.lastError?.endsWith("…")).toBe(true);
    expect(run?.failureCode).toBe("unknown_worker_code");
  });

  it("uses the actor-scoped run monitor and the existing durable manual receipt", () => {
    const source = readFileSync(resolve(process.cwd(), "components/saga-content-automation-runs.tsx"), "utf8");
    const route = readFileSync(resolve(process.cwd(), "app/studio/automations/page.tsx"), "utf8");

    expect(source).toContain('"/api/content/automation-runs?limit=50"');
    expect(source).toContain('`/api/content/automations/${encodeURIComponent(automation.id)}/run`');
    expect(source).toContain('method: "POST"');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).toContain("idempotencyKey");
    expect(source).toContain("Den skapar bara ett privat utkast och publicerar aldrig.");
    expect(source).not.toContain("localStorage");
    expect(source).not.toMatch(/social\/connections|meta_ads|google_ads/i);
    expect(route).toContain("SagaContentAutomationRuns");
    expect(route).toContain('view === "ads" ? <SagaAdAutomationBuilder />');
  });
});
