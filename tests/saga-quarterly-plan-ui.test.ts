import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SagaQuarterlyPlan } from "@/components/saga-quarterly-plan";
import {
  abandonSagaQuarterlyBatch,
  createSagaQuarterlyBatch,
  deriveSagaQuarterlyPlanPreview,
  materializeSagaQuarterlyBatch,
  validateSagaQuarterlyPlan,
  type SagaQuarterlyPlanInput,
} from "@/lib/client/saga-quarterly-plan";

const brandProfileId = "b6a9db8c-7f92-4f8f-a0fe-ec18db81c64f";
const batchId = "dac994a1-4882-4bdb-97ba-dbb42ca174d3";
const planItemId = "c8d37e5d-a7d0-4f2f-8e0f-f26e7404cbdd";
const idempotencyKey = "d88a7e44-3b7b-47f1-9f3e-6a7ad95cc9c5";

const validPlan: SagaQuarterlyPlanInput = {
  name: "Rullande 13-veckorsplan",
  horizonStartDate: "2026-08-24",
  timezone: "Europe/Stockholm",
  channelPlans: [{
    id: "linkedin-plan",
    channel: "linkedin",
    contentType: "social_post",
    objective: "Hjälpa relevanta beslutsfattare att förstå värdet av välbyggda system.",
    cadence: { unit: "weekly", count: 1, weekdayIds: [1], localTimes: ["09:30"] },
    themes: [{
      id: "systeminsikt",
      title: "System som frigör tid",
      intent: "Visa hur genomtänkta system frigör tid för mänskligt omdöme.",
      contentDirection: "Börja med en konkret vardagssituation och gör nyttan tydlig.",
      approved: true,
    }],
    desiredCallToAction: "Berätta vilken återkommande uppgift du vill frigöra först.",
    imageDirection: "Lugn naturbild med en diskret mänsklig detalj.",
    targetLength: "medium",
  }],
};

describe("SAGA 13-veckorsplan UI", () => {
  it("förhandsgranskar en kanonisk 13-veckorsplan och blockerar felaktig takt", () => {
    expect(validateSagaQuarterlyPlan(validPlan)).toBeNull();
    const preview = deriveSagaQuarterlyPlanPreview(validPlan);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.slots).toHaveLength(13);
      expect(preview.slots.at(-1)).toMatchObject({ weekIndex: 13, plannedLocalTime: "09:30", channel: "linkedin" });
    }

    expect(validateSagaQuarterlyPlan({
      ...validPlan,
      channelPlans: [{
        ...validPlan.channelPlans[0],
        cadence: { unit: "weekly", count: 2, weekdayIds: [1], localTimes: ["09:30"] },
      }],
    })).toContain("Välj en dag för varje inlägg per vecka");
  });

  it("visar omfattning, horisont och private-review-gränser utan publiceringslöfte", () => {
    const html = renderToStaticMarkup(createElement(SagaQuarterlyPlan));

    expect(html).toContain("Första måndagen i 13 veckor");
    expect(html).toContain("Tidszon för önskade tider");
    expect(html).toContain("13 veckor är en planeringssnapshot");
    expect(html).toContain("Högst tio riktiga utkast");
    expect(html).toContain("Privata utkast behöver media separat");
    expect(html).toContain("Webbplatsen är inte ett batchmål här");
    expect(html).not.toContain("Publicera nästa 10");
  });

  it("sänder exakta revisioner och kan starta en redan köad batch med ett nytt kvitto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "test" }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createSagaQuarterlyBatch({
        brandProfileId,
        expectedPlanRevision: 7,
        planItemIds: [planItemId],
        idempotencyKey,
        apiPath: "/api/test-quarterly",
      });
      await materializeSagaQuarterlyBatch({
        brandProfileId,
        batchId,
        expectedPlanRevision: 7,
        expectedBatchRevision: 3,
        idempotencyKey: "e137803a-76cc-4e75-8f1c-b338a8a2bdf8",
        retryFailed: false,
        apiPath: "/api/test-quarterly",
      });
      await abandonSagaQuarterlyBatch({
        brandProfileId,
        batchId,
        expectedPlanRevision: 7,
        expectedBatchRevision: 3,
        idempotencyKey: "4c1da5c8-c33e-46de-b57e-3e7a14d1ddb1",
        note: "Underlaget måste skrivas om.",
        apiPath: "/api/test-quarterly",
      });

      expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/test-quarterly/${brandProfileId}/batches`, expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ idempotencyKey, expectedPlanRevision: 7, planItemIds: [planItemId] });
      expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/test-quarterly/${brandProfileId}/batches/${batchId}/materialize`, expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        idempotencyKey: "e137803a-76cc-4e75-8f1c-b338a8a2bdf8",
        expectedPlanRevision: 7,
        expectedBatchRevision: 3,
        retryFailed: false,
      });
      expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/test-quarterly/${brandProfileId}/batches/${batchId}/abandon`, expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
        idempotencyKey: "4c1da5c8-c33e-46de-b57e-3e7a14d1ddb1",
        expectedPlanRevision: 7,
        expectedBatchRevision: 3,
        note: "Underlaget måste skrivas om.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("kräver en serverobserverad draft-ändring före resubmit", () => {
    const source = readFileSync(resolve(process.cwd(), "components/saga-quarterly-plan.tsx"), "utf8");

    expect(source).toContain("item.returnedDraftRevision !== null");
    expect(source).toContain("(item.draftRevision ?? 0) > item.returnedDraftRevision");
    expect(source).toContain("Starta privat produktion");
    expect(source).toContain("batch.canRetry");
    expect(source).toContain("batch.canAbandon");
    expect(source).toContain("retryExhausted");
    expect(source).toContain("Återhämtning pågår.");
    expect(source).not.toContain("Körningskvittot finns inte i detta fönster");

    const adapterSource = readFileSync(resolve(process.cwd(), "lib/client/saga-quarterly-plan.ts"), "utf8");
    const calendarSource = readFileSync(resolve(process.cwd(), "components/saga-content-calendar.tsx"), "utf8");
    expect(adapterSource).toContain("body?.noPublication !== true");
    expect(adapterSource).not.toContain('"failed", "stale"');
    expect(calendarSource).toContain('entry.editable ? "Välj för detaljer och flytt." : "Välj för detaljer."');
  });
});
