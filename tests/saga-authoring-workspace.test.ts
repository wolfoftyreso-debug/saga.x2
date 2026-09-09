import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StudioDraftView } from "@/components/content-studio-adapter";
import {
  SAGA_AUTHORING_MAX_SERIES_SIZE,
  SagaAuthoringWorkspace,
  sagaAuthoringCanSelectCandidate,
  sagaAuthoringDraftFromPreviewPayload,
  sagaAuthoringGenerationPayload,
  sagaAuthoringObjective,
  sagaAuthoringPreviewPayload,
  sagaAuthoringReferenceRevisionAdvanced,
  sagaAuthoringRunFromPayload,
  sagaAuthoringRunPayload,
  sagaAuthoringTopics,
  sagaKnowledgeEntriesFromPayload,
  sagaKnowledgeEntriesUrl,
  sagaKnowledgePolicyPayload,
  type SagaAuthoringCandidate,
  type SagaAuthoringForm,
  type SagaAuthoringRun,
  type SagaKnowledgePolicy,
} from "@/components/saga-authoring-workspace";

const entryId = "11111111-1111-4111-8111-111111111111";
const referenceDraftId = "22222222-2222-4222-8222-222222222222";

const form: SagaAuthoringForm = {
  objective: "explain",
  topics: ["Automation av mänskligt arbete"],
  prompt: "Beskriv hur stabila system frigör tid för människors viktigare arbete.",
  includeAuthorName: true,
  contentType: "social_post",
  channels: ["linkedin"],
  targetLength: "medium",
  selectedKnowledgeEntryIds: [entryId],
};

const referenceDraft: StudioDraftView = {
  id: referenceDraftId,
  contentType: "social_post",
  channels: ["linkedin"],
  title: "Referenspost",
  headline: "System ska frigöra tid",
  subject: "",
  body: "En sparad referenstext som inte får skickas från webbläsaren till batchen.",
  cta: "",
  excerpt: "",
  hashtags: "#system",
  status: "draft",
  generationPrompt: "Skriv med lugn och tydlig svenska om system som frigör mänsklig tid.",
  imagePrompt: "",
  timezone: "Europe/Stockholm",
  scheduledAt: null,
  scheduledLocalDate: null,
  scheduledLocalTime: null,
  revision: 3,
  approvalRequired: true,
  media: [],
  templateId: null,
  automationRuleId: null,
  newsletterAudienceId: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:00:00.000Z",
};

const readyCandidate: SagaAuthoringCandidate = {
  id: "33333333-3333-4333-8333-333333333333",
  revision: 2,
  state: "ready",
  title: "En kandidatrubrik",
  headline: "En kandidatrubrik",
  body: "En privat kandidat.",
  selectedDraftId: null,
  quality: null,
  error: null,
};

const readyRun: SagaAuthoringRun = {
  id: "44444444-4444-4444-8444-444444444444",
  revision: 4,
  state: "ready_to_select",
  candidateCount: 1,
  candidates: [readyCandidate],
  canGenerate: false,
  canRetry: false,
  canSelect: true,
  hasPendingWork: false,
  canContinue: false,
  failureMessage: null,
  generationProgress: {
    total: 1,
    pending: 0,
    completed: 1,
    queued: 0,
    generating: 0,
    ready: 1,
    blocked: 0,
    failed: 0,
    selected: 0,
    notSelected: 0,
  },
  knowledge: [],
};

describe("SAGA authoring workspace adapters", () => {
  it("keeps authoring closed until the server confirms a completed brand onboarding", () => {
    const html = renderToStaticMarkup(createElement(SagaAuthoringWorkspace, { brandContext: { status: "missing" } }));

    expect(html).toContain("Slutför varumärkesonboarding innan du skriver.");
    expect(html).toContain('href="/studio/brands/new"');
    expect(html).not.toContain("Skapa första utkastet");
    expect(html).not.toContain("Frys referensen");
  });

  it("shows the completed brand's planning path before the reference flow", () => {
    const html = renderToStaticMarkup(createElement(SagaAuthoringWorkspace, {
      brandContext: { status: "completed", brandProfileId: referenceDraftId, brandName: "Systembyggarna" },
    }));

    expect(html).toContain("VARUMÄRKESGRUND VERIFIERAD");
    expect(html).toContain("Systembyggarna");
    expect(html).toContain(`href="/studio/plan?brandProfileId=${referenceDraftId}"`);
    expect(html).toContain("Skapa första utkastet");
  });

  it("requires an explicit verified brand choice when multiple brands are eligible", () => {
    const firstBrandId = "66666666-6666-4666-8666-666666666666";
    const secondBrandId = "77777777-7777-4777-8777-777777777777";
    const html = renderToStaticMarkup(createElement(SagaAuthoringWorkspace, {
      brandContext: {
        status: "selection_required",
        brands: [
          { brandProfileId: firstBrandId, brandName: "Systembyggarna" },
          { brandProfileId: secondBrandId, brandName: "Verkstaden" },
        ],
      },
    }));

    expect(html).toContain("Vilket varumärke ska utkastet tillhöra?");
    expect(html).toContain(`href="/studio/create?brandProfileId=${firstBrandId}"`);
    expect(html).toContain(`href="/studio/create?brandProfileId=${secondBrandId}"`);
    expect(html).not.toContain("Skapa första utkastet");
  });

  it("maps the short UI objective to a bounded, human-readable server goal", () => {
    const objective = sagaAuthoringObjective("explain");
    const payload = sagaAuthoringRunPayload({
      referenceDraft,
      form,
      candidateCount: 99,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    expect(objective.length).toBeGreaterThanOrEqual(12);
    expect(payload.objective).toBe(objective);
    expect(payload.objective).not.toBe("explain");
    expect(payload.candidateCount).toBe(SAGA_AUTHORING_MAX_SERIES_SIZE);
  });

  it("keeps Daily Knowledge out of the legacy-compatible generation payload", () => {
    const payload = sagaAuthoringGenerationPayload(form);

    expect(payload).not.toHaveProperty("selectedKnowledgeEntryIds");
    expect(JSON.stringify(payload)).not.toContain(entryId);
    expect(payload.brief).not.toContain("hemlig sammanfattning");
  });

  it("sends only opaque Daily Knowledge IDs to the server-owned preview route", () => {
    const payload = sagaAuthoringPreviewPayload({
      ...form,
      selectedKnowledgeEntryIds: [entryId, "not-an-id"],
    });

    expect(payload.selectedKnowledgeEntryIds).toEqual([entryId]);
    expect(payload).not.toHaveProperty("knowledge");
    expect(payload).not.toHaveProperty("summary");
    expect(JSON.stringify(payload)).not.toContain("hemlig sammanfattning");
  });

  it("keeps a fully edited prompt when the first draft is generated again", () => {
    const editedPrompt = "Den här redigerade prompten ska följa nästa utkast utan att byggas om från formuläret.";
    const draft = sagaAuthoringDraftFromPreviewPayload({ draft: {
      title: "Nytt utkast",
      headline: "En tydlig rubrik",
      subject: "Ämnesrad",
      body: "En redigerbar text.",
      excerpt: "Kort ingress.",
      callToAction: "Ta nästa steg.",
      hashtags: ["#system"],
      imagePrompt: "Naturligt ljus.",
    } }, form, editedPrompt);

    expect(draft?.generationPrompt).toBe(editedPrompt);
  });

  it("uses the signed-account-name flag without ever sending a freeform author name", () => {
    const payload = sagaAuthoringRunPayload({
      referenceDraft,
      form,
      candidateCount: 1,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });

    expect(payload.includeAuthorName).toBe(true);
    expect(payload).not.toHaveProperty("authorName");
    expect(JSON.stringify(payload)).not.toContain("Anna Andersson");
  });

  it("requires a fresh series after a saved reference revision advances", () => {
    expect(sagaAuthoringReferenceRevisionAdvanced(null, 1)).toBe(true);
    expect(sagaAuthoringReferenceRevisionAdvanced(3, 4)).toBe(true);
    expect(sagaAuthoringReferenceRevisionAdvanced(4, 4)).toBe(false);
    expect(sagaAuthoringReferenceRevisionAdvanced(4, 3)).toBe(false);
  });

  it("permits materialization only after the exact server review gate", () => {
    expect(sagaAuthoringCanSelectCandidate(readyRun, readyCandidate)).toBe(true);
    expect(sagaAuthoringCanSelectCandidate({ ...readyRun, state: "generating" }, readyCandidate)).toBe(false);
    expect(sagaAuthoringCanSelectCandidate(readyRun, { ...readyCandidate, state: "generating" })).toBe(false);
  });

  it("reads only server-projected run progress, candidate content and frozen knowledge", () => {
    const run = sagaAuthoringRunFromPayload({ run: {
      id: readyRun.id,
      revision: 4,
      state: "generating",
      candidateCount: 2,
      canGenerate: false,
      canRetry: false,
      canSelect: false,
      hasPendingWork: true,
      canContinue: true,
      failureMessage: null,
      generationProgress: {
        total: 2, pending: 1, completed: 1, queued: 1, generating: 0,
        ready: 1, blocked: 0, failed: 0, selected: 0, notSelected: 0,
      },
      candidates: [{
        ...readyCandidate,
        content: {
          title: "Serverns kandidat", headline: "Rubrik", subject: "", previewText: "",
          body: "Endast servern har skapat den här kandidaten.", excerpt: "", callToAction: "",
          hashtags: [], imagePrompt: "", altText: "",
        },
      }],
      knowledge: [{
        entryId,
        topic: "Automation",
        headline: "Fryst dagsunderlag",
        summary: "En arbetsytans sammanfattning.",
        knowledgeDate: "2026-08-26",
        evidenceCount: 2,
        independentPublisherCount: 2,
      }],
    } });

    expect(run?.canContinue).toBe(true);
    expect(run?.generationProgress).toMatchObject({ total: 2, pending: 1, ready: 1 });
    expect(run?.candidates[0]).toMatchObject({ title: "Serverns kandidat", state: "ready" });
    expect(run?.knowledge).toEqual([{
      id: entryId,
      topic: "Automation",
      title: "Fryst dagsunderlag",
      summary: "En arbetsytans sammanfattning.",
      knowledgeDate: "2026-08-26",
      evidenceCount: 2,
      independentPublisherCount: 2,
    }]);
  });

  it("preserves Daily Knowledge CAS and bounded entry metadata", () => {
    const policy: SagaKnowledgePolicy = {
      topics: ["Automation"],
      revision: 9,
      sourceIds: ["66666666-6666-4666-8666-666666666666"],
      enabled: true,
      timezone: "Europe/Stockholm",
      dailyAt: "06:00",
      minimumIndependentPublishers: 2,
      minimumEvidenceItems: 2,
      maximumEvidenceItems: 8,
      evidenceWindowHours: 72,
      retentionDays: 90,
    };

    expect(sagaKnowledgePolicyPayload(policy, ["Automation"])).toMatchObject({
      expectedRevision: 9,
      sourceIds: policy.sourceIds,
      topics: ["Automation"],
    });
    expect(sagaKnowledgeEntriesUrl("/api/saga/knowledge/entries", "2026-08-26")).toBe("/api/saga/knowledge/entries?date=2026-08-26&limit=24");
    expect(sagaKnowledgeEntriesFromPayload({ data: [{
      id: entryId,
      topic: "Automation",
      headline: "Färsk signal",
      summary: "En kort intern sammanfattning.",
      knowledgeDate: "2026-08-26",
      evidenceCount: 3,
      independentPublisherCount: 2,
    }] })).toEqual([{
      id: entryId,
      topic: "Automation",
      title: "Färsk signal",
      summary: "En kort intern sammanfattning.",
      knowledgeDate: "2026-08-26",
      evidenceCount: 3,
      independentPublisherCount: 2,
    }]);
  });

  it("keeps the topic policy inside the server's twelve-subject boundary", () => {
    expect(sagaAuthoringTopics(Array.from({ length: 20 }, (_, index) => `Ämne ${index}`))).toHaveLength(12);
  });
});
