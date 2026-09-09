import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SagaSeriesWorkspace,
  sagaSeriesActivationPayload,
  sagaSeriesControlsValidation,
  sagaSeriesCreatePayload,
  sagaSeriesDraftsFromPayload,
  sagaSeriesFlowState,
  sagaSeriesFromPayload,
  sagaSeriesMessage,
  sagaSeriesUpdatePayload,
} from "@/components/saga-series-workspace";
import type { SagaSeriesChannel } from "@/components/saga-series-workspace";

const controls: {
  objective: "educate";
  audience: string;
  tone: "insightful";
  requiredElements: string;
  forbiddenElements: string;
  defaultChannels: SagaSeriesChannel[];
} = {
  objective: "educate" as const,
  audience: "Företagare som vill bygga system som frigör tid",
  tone: "insightful" as const,
  requiredElements: "En konkret insikt\nEn möjlig nästa handling",
  forbiddenElements: "Tomma superlativ",
  defaultChannels: ["linkedin", "newsletter"],
};

describe("SAGA Series workspace", () => {
  it("narrows saved series snapshots and never retains media addresses", () => {
    const parsed = sagaSeriesFromPayload({
      series: [{
        id: "series-1",
        name: "System som frigör tid",
        slug: "system-som-frigor-tid",
        revision: 4,
        active: false,
        reference: {
          sourceDraftId: "draft-1",
          sourceDraftRevision: 7,
          title: "Människan ska inte göra maskinens arbete",
          body: "Vi bygger hellre tydliga system som ger människor mer utrymme för det som betyder något.",
          channels: ["linkedin", "newsletter"],
          media: [{ id: "media-1", kind: "image", url: "https://blob.example/private-reference.jpg" }],
          capturedAt: "2026-08-25T12:00:00.000Z",
        },
        controls: {
          objective: "educate",
          audience: "Företagare som vill bygga system som frigör tid",
          tone: "insightful",
          requiredElements: ["En konkret insikt"],
          forbiddenElements: ["Tomma superlativ"],
          defaultChannels: ["linkedin"],
          reviewRequired: true,
        },
      }],
    });

    expect(parsed).toEqual([{
      id: "series-1",
      name: "System som frigör tid",
      slug: "system-som-frigor-tid",
      revision: 4,
      active: false,
      reference: {
        sourceDraftId: "draft-1",
        sourceDraftRevision: 7,
        title: "Människan ska inte göra maskinens arbete",
        body: "Vi bygger hellre tydliga system som ger människor mer utrymme för det som betyder något.",
        channels: ["linkedin", "newsletter"],
        mediaCount: 1,
        capturedAt: "2026-08-25T12:00:00.000Z",
      },
      controls: {
        objective: "educate",
        audience: "Företagare som vill bygga system som frigör tid",
        tone: "insightful",
        requiredElements: ["En konkret insikt"],
        forbiddenElements: ["Tomma superlativ"],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
      createdAt: null,
      updatedAt: null,
    }]);
    expect(JSON.stringify(parsed)).not.toContain("blob.example");
    expect(JSON.stringify(parsed)).not.toContain("private-reference.jpg");
  });

  it("requires an actual saved draft and rejects controls that weaken review", () => {
    expect(sagaSeriesFromPayload({ series: [{ id: "series-without-reference" }] })).toEqual([]);
    expect(sagaSeriesFromPayload({ series: [{
      id: "unsafe-series",
      reference: { sourceDraftId: "draft-1", title: "X", body: "", channels: [], media: [] },
      controls: { objective: "educate", audience: "Alla", tone: "direct", requiredElements: [], forbiddenElements: [], defaultChannels: [], reviewRequired: false },
    }] })).toEqual([]);

    const drafts = sagaSeriesDraftsFromPayload({
      drafts: [{ id: "draft-1", revision: 2, title: "Sparad post", body: "Ett riktigt utkast.", channels: ["linkedin"], media: [{ id: "m", url: "https://blob.example/source.jpg" }] }],
    });
    expect(drafts).toEqual([{ id: "draft-1", revision: 2, title: "Sparad post", body: "Ett riktigt utkast.", channels: ["linkedin"], status: "utkast", updatedAt: null, mediaCount: 1 }]);
    expect(JSON.stringify(drafts)).not.toContain("source.jpg");
    expect(sagaSeriesMessage({ code: "configuration_required", error: "DATABASE_URL" }, "fallback")).toBe("Arbetsytan behöver vara redo innan innehållsserier kan sparas.");
  });

  it("sends the exact series contract with review locked and no scheduling or publication fields", () => {
    expect(sagaSeriesControlsValidation(controls)).toBeNull();
    expect(sagaSeriesControlsValidation({ ...controls, audience: "" })).toContain("Målgruppen");
    expect(sagaSeriesControlsValidation({ ...controls, requiredElements: "A\nA" })).toContain("flera gånger");

    const create = sagaSeriesCreatePayload({ name: " System som frigör tid ", slug: " system-som-frigor-tid ", referenceDraftId: "draft-1", controls });
    expect(create).toEqual({
      name: "System som frigör tid",
      slug: "system-som-frigor-tid",
      referenceDraftId: "draft-1",
      controls: {
        objective: "educate",
        audience: "Företagare som vill bygga system som frigör tid",
        tone: "insightful",
        requiredElements: ["En konkret insikt", "En möjlig nästa handling"],
        forbiddenElements: ["Tomma superlativ"],
        defaultChannels: ["linkedin", "newsletter"],
        reviewRequired: true,
      },
      active: false,
    });

    const saved = sagaSeriesFromPayload({ series: [{
      id: "series-1", name: "System som frigör tid", slug: "system-som-frigor-tid", revision: 5, active: false,
      reference: { sourceDraftId: "draft-1", sourceDraftRevision: 2, title: "Sparad post", body: "Ett riktigt utkast.", channels: ["linkedin"], media: [] },
    }] })?.[0];
    expect(saved).toBeTruthy();
    const update = sagaSeriesUpdatePayload(saved!, controls);
    expect(update).toEqual({ id: "series-1", expectedRevision: 5, controls: { objective: "educate", audience: "Företagare som vill bygga system som frigör tid", tone: "insightful", requiredElements: ["En konkret insikt", "En möjlig nästa handling"], forbiddenElements: ["Tomma superlativ"], defaultChannels: ["linkedin", "newsletter"], reviewRequired: true } });
    const serialized = JSON.stringify({ create, update });
    expect(serialized).not.toMatch(/calendar|schedule|publish|automation/i);
  });

  it("activates only a saved, review-gated reference with the observed revision", () => {
    const series = sagaSeriesFromPayload({ series: [{
      id: "series-1", name: "System som frigör tid", slug: "system-som-frigor-tid", revision: 8, active: false,
      reference: { sourceDraftId: "draft-1", sourceDraftRevision: 2, title: "Sparad post", body: "Ett riktigt utkast.", channels: ["linkedin"], media: [] },
      controls: {
        objective: "educate", audience: "Företagare", tone: "insightful", requiredElements: ["Insikt"], forbiddenElements: [], defaultChannels: ["linkedin"], reviewRequired: true,
      },
    }] })?.[0];
    expect(series).toBeTruthy();
    expect(sagaSeriesActivationPayload(series!)).toEqual({ id: "series-1", expectedRevision: 8, active: true });
    expect(JSON.stringify(sagaSeriesActivationPayload(series!))).not.toMatch(/calendar|schedule|publish|automation/i);

    const active = { ...series!, active: true };
    const withoutControls = { ...series!, controls: null };
    expect(sagaSeriesActivationPayload(active)).toBeNull();
    expect(sagaSeriesActivationPayload(withoutControls)).toBeNull();
  });

  it("locks later stages until the persisted reference is controlled and active", () => {
    expect(sagaSeriesFlowState(null)).toEqual({ reference: "required", controls: "locked", variants: "locked", calendar: "locked" });
    const series = sagaSeriesFromPayload({ series: [{ id: "series-1", reference: { sourceDraftId: "draft-1", title: "X", body: "", channels: [], media: [] } }] })?.[0] ?? null;
    expect(sagaSeriesFlowState(series)).toEqual({ reference: "complete", controls: "ready", variants: "locked", calendar: "locked" });
  });

  it("renders a truthful reference-first surface without image previews or fake publication", () => {
    const html = renderToStaticMarkup(createElement(SagaSeriesWorkspace));
    expect(html.indexOf("Referenspost")).toBeLessThan(html.indexOf("Kontroller"));
    expect(html).toContain("Välj ett verkligt, sparat utkast.");
    expect(html).toContain("Inga varianter är skapade här.");
    expect(html).toContain("Ingen kalenderpost skapad");
    expect(html).toContain("Granskning är obligatorisk.");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Publicerad");
  });

  it("uses only the actor-scoped list/create/update/delete contract", () => {
    const page = readFileSync(resolve(process.cwd(), "app/studio/series/page.tsx"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "components/saga-series-workspace.tsx"), "utf8");
    const navigation = readFileSync(resolve(process.cwd(), "components/bottom-nav.tsx"), "utf8");

    expect(page).toContain("SagaSeriesWorkspace");
    expect(source).toContain('seriesApiPath = "/api/saga/series"');
    expect(source).toContain('draftsApiPath = "/api/content/drafts?limit=250&include=media"');
    expect(source).toContain('method: "PATCH"');
    expect(source).toContain("sagaSeriesActivationPayload");
    expect(source).toContain("Aktivera för AI-labbet");
    expect(source).toContain("/studio/engine?seriesId=");
    expect(source).toContain('method: "DELETE"');
    expect(source).toContain('expectedRevision: item.revision');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("previewUrl");
    expect(source).not.toContain("assetUrl");
    expect(source).not.toContain("social/connections");
    expect(navigation).toContain('pathname.startsWith("/studio/series")');
  });
});
