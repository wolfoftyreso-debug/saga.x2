import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  activeLabSeriesReferenceFromPayload,
  ContentEngineWorkspace,
  type EngineWorkspaceData,
} from "@/components/content-engine-workspace";

const seriesId = "33333333-3333-4333-8333-333333333333";

const activeSeriesPayload = {
  series: [{
    id: seriesId,
    name: "System som frigör tid",
    slug: "system-som-frigor-tid",
    revision: 4,
    active: true,
    reference: {
      sourceDraftId: "44444444-4444-4444-8444-444444444444",
      sourceDraftRevision: 2,
      title: "Människan ska inte göra maskinens arbete",
      body: "Det här är en fryst referenstext som inte ska skickas från webbläsaren.",
      channels: ["linkedin"],
      media: [{ kind: "generated", contentType: "image/jpeg", url: "https://blob.example/private.jpg" }],
      capturedAt: "2026-08-25T12:00:00.000Z",
    },
    controls: {
      objective: "educate",
      audience: "Företagare som vill bygga system",
      tone: "insightful",
      requiredElements: ["En tydlig insikt"],
      forbiddenElements: ["Tomma superlativ"],
      defaultChannels: ["linkedin"],
      reviewRequired: true,
    },
  }],
};

const engineData: EngineWorkspaceData = {
  brandProfiles: [{ id: "11111111-1111-4111-8111-111111111111", name: "SAGA-röst", instructions: "Rak, mänsklig och konstruktiv." }],
  sources: [{ id: "22222222-2222-4222-8222-222222222222", name: "Egen kunskap", description: "Sparat underlag" }],
  modelPresets: [],
  modelPolicies: [],
  recipes: [{ id: "55555555-5555-4555-8555-555555555555", name: "Branschinsikt", description: "En tydlig insikt" }],
  destinations: [],
  distributionRules: [],
};

describe("Series → AI Lab handoff", () => {
  it("accepts only an active, review-gated series and strips its frozen text and media", () => {
    const selected = activeLabSeriesReferenceFromPayload(activeSeriesPayload, seriesId);

    expect(selected).toEqual({
      id: seriesId,
      name: "System som frigör tid",
      controls: activeSeriesPayload.series[0].controls,
      reference: {
        title: "Människan ska inte göra maskinens arbete",
        channels: ["linkedin"],
        capturedAt: "2026-08-25T12:00:00.000Z",
      },
    });
    const material = JSON.stringify(selected);
    expect(material).not.toContain("fryst referenstext");
    expect(material).not.toContain("blob.example");
    expect(activeLabSeriesReferenceFromPayload({ series: [{ ...activeSeriesPayload.series[0], active: false }] }, seriesId)).toBeNull();
  });

  it("keeps a truthful no-selection state for the legacy lab flow", () => {
    const html = renderToStaticMarkup(createElement(ContentEngineWorkspace, { data: engineData }));

    expect(html).toContain("INGEN SERIESREFERENS VALD");
    expect(html).toContain("Öppna serier");
    expect(html).toContain("Nytt varumärke");
    expect(html).toContain('href="/studio/brands/new"');
    expect(html).not.toContain(">Ny persona<");
    expect(html).not.toContain("private.jpg");
    expect(html).not.toContain("Publicerad");
  });

  it("uses an opaque query selector and never posts a client snapshot", () => {
    const page = readFileSync(resolve(process.cwd(), "app/studio/engine/page.tsx"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "components/content-engine-workspace.tsx"), "utf8");

    expect(page).toContain("await searchParams");
    expect(page).toContain("UUID_PATTERN.test(candidate)");
    expect(page).toContain("<ContentEngineWorkspace seriesId={seriesId} />");
    expect(source).toContain('seriesApiPath = "/api/saga/series"');
    expect(source).toContain("activeLabSeriesReferenceFromPayload(payload, seriesId)");
    expect(source).toContain("...(confirmedSeriesReference ? { seriesId: confirmedSeriesReference.id } : {}),");
    expect(source).not.toContain("seriesReference: seriesReference");
    expect(source).not.toContain("referenceDraftId: series");
  });
});
