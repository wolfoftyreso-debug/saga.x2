import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SagaDraftPatternHandoff,
  sagaPatternActivationPayload,
  sagaPatternAutomationPayload,
  sagaPatternDraftFromPayload,
  sagaPatternReferencePayload,
  sagaPatternSeriesFromPayload,
  type SagaPatternDraft,
  type SagaPatternSeries,
} from "@/components/saga-draft-pattern-handoff";

const draft: SagaPatternDraft = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 7,
  title: "System ska ge människor mer utrymme",
  summary: "System ska ta hand om repetition så att människor kan ägna sig åt det som kräver omdöme.",
  contentType: "social_post",
  channels: ["linkedin"],
  status: "approved",
  language: "sv",
  timezone: "Europe/Stockholm",
  mediaCount: 1,
};

const series: SagaPatternSeries = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "System som frigör tid",
  slug: "system-som-frigor-tid",
  active: false,
  revision: 3,
  sourceDraftId: draft.id,
  sourceDraftRevision: draft.revision,
  controls: {
    objective: "educate",
    audience: "Företagare som vill bygga bättre vardag",
    tone: "insightful",
    requiredElements: ["En konkret insikt"],
    forbiddenElements: ["Tomma superlativ"],
    defaultChannels: ["linkedin"],
    reviewRequired: true,
  },
};

describe("SAGA draft-to-pattern handoff", () => {
  it("projects a real saved draft without retaining private media addresses or prompts", () => {
    const parsed = sagaPatternDraftFromPayload({
      draft: {
        id: draft.id,
        revision: 7,
        title: draft.title,
        body: "System ska ta hand om repetition så att människor kan ägna sig åt det som kräver omdöme.",
        contentType: "social_post",
        channels: ["linkedin"],
        status: "approved",
        language: "sv",
        timezone: "Europe/Stockholm",
        generationPrompt: "Privat prompt",
        imagePrompt: "Privat bildprompt",
        media: [{ assetUrl: "https://private.blob.vercel-storage.com/secret.jpg", storagePath: "private/secret.jpg" }],
      },
    });

    expect(parsed).toMatchObject({ id: draft.id, revision: 7, title: draft.title, mediaCount: 1 });
    expect(JSON.stringify(parsed)).not.toContain("private.blob");
    expect(JSON.stringify(parsed)).not.toContain("Privat prompt");
    expect(JSON.stringify(parsed)).not.toContain("storagePath");
  });

  it("creates a reference through the existing inactive Series contract and keeps activation revision-checked", () => {
    const reference = sagaPatternReferencePayload(draft, {
      name: " System som frigör tid ",
      slug: " System som frigör tid ",
      objective: "educate",
      audience: " Företagare som vill bygga bättre vardag ",
      tone: "insightful",
      requiredElements: "En konkret insikt\nEn konkret insikt\nEn väg framåt",
      forbiddenElements: "Tomma superlativ",
      defaultChannels: ["linkedin"],
    });

    expect(reference).toEqual({
      name: "System som frigör tid",
      slug: "system-som-frigor-tid",
      referenceDraftId: draft.id,
      controls: {
        objective: "educate",
        audience: "Företagare som vill bygga bättre vardag",
        tone: "insightful",
        requiredElements: ["En konkret insikt", "En väg framåt"],
        forbiddenElements: ["Tomma superlativ"],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
      active: false,
    });
    expect(sagaPatternActivationPayload(series)).toEqual({ id: series.id, expectedRevision: 3, active: true });
    expect(sagaPatternActivationPayload({ ...series, active: true })).toBeNull();
  });

  it("builds a paused, review-first automation from the active Series ID only", () => {
    const payload = sagaPatternAutomationPayload(draft, { ...series, active: true, revision: 4 }, {
      name: "Systeminsikter varje måndag",
      channels: ["linkedin"],
      generationPrompt: "Gör en ny, konkret variant med en tydlig insikt.",
      imagePrompt: "Dokumentär naturbild.",
      desiredLength: "240",
      tone: "Lugn och precis",
      timezone: "Europe/Stockholm",
      weekday: 1,
      time: "09:00",
    });

    expect(payload).toMatchObject({
      active: false,
      approvalRequired: true,
      seriesId: series.id,
      contentType: "social_post",
      channels: ["linkedin"],
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [1],
      localTimes: ["09:00"],
      cronExpression: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/publish|destination|provider/i);
  });

  it("reads a Series response only when its frozen source and mandatory controls are present", () => {
    const parsed = sagaPatternSeriesFromPayload({
      series: {
        id: series.id,
        name: series.name,
        slug: series.slug,
        active: true,
        revision: 4,
        reference: {
          sourceDraftId: draft.id,
          sourceDraftRevision: 7,
          body: "Detta ska aldrig följa med till handoff-ytans state.",
          media: [{ assetUrl: "https://private.blob.example/secret.png" }],
        },
        controls: series.controls,
      },
    });
    expect(parsed).toMatchObject({ id: series.id, active: true, sourceDraftId: draft.id, controls: { reviewRequired: true } });
    expect(JSON.stringify(parsed)).not.toContain("private.blob");
    expect(JSON.stringify(parsed)).not.toContain("Detta ska aldrig");
  });

  it("renders a truthful reference-first workbench without a fake run or media preview", () => {
    const html = renderToStaticMarkup(createElement(SagaDraftPatternHandoff, { draftId: draft.id }));
    expect(html).toContain("Förädla först. Automatisera sedan.");
    expect(html).toContain("Läser det sparade utkastet");
    expect(html).toContain("Ingen genväg till publicering");
    expect(html).not.toContain("Demokörning");
    expect(html).not.toContain("Demobild");
    expect(html).not.toContain("<img");
  });

  it("uses existing actor-scoped APIs and adds a direct route bridge without editing ContentStudio", () => {
    const handoff = readFileSync(resolve(process.cwd(), "components/saga-draft-pattern-handoff.tsx"), "utf8");
    const link = readFileSync(resolve(process.cwd(), "components/saga-draft-pattern-handoff-link.tsx"), "utf8");
    const page = readFileSync(resolve(process.cwd(), "app/studio/content/[id]/page.tsx"), "utf8");

    expect(handoff).toContain('"/api/saga/series"');
    expect(handoff).toContain('"/api/content/automations"');
    expect(handoff).toContain("/api/content/drafts/");
    expect(handoff).toContain('method: "PATCH"');
    expect(handoff).toContain('credentials: "same-origin"');
    expect(handoff).toContain("expectedRevision: series.revision");
    expect(handoff).not.toContain("localStorage");
    expect(handoff).not.toContain("social/connections");
    expect(link).toContain("/pattern");
    expect(page).toContain("SagaDraftPatternHandoffLink");
    expect(readFileSync(resolve(process.cwd(), "components/content-studio.tsx"), "utf8")).not.toContain("SagaDraftPatternHandoff");
  });
});
