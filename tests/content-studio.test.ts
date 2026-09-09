import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentPreview, draftPayload, PrivateAdCreativeBriefReview, SAGA_WORKBENCH_STAGES, sagaWorkbenchHandoff, studioPlanningStatusLabel } from "@/components/content-studio";
import type { StudioDraftView } from "@/components/content-studio-adapter";
import {
  contentAutomationRuleInputSchema,
  contentDraftInputSchema,
  contentMediaAttachmentCreateSchema,
  contentTemplateInputSchema,
} from "@/lib/domain/content-studio";
import { previewContentAutomationOccurrences } from "@/lib/services/content-studio";

const baseDraft = {
  contentType: "social_post" as const,
  channels: ["linkedin"] as const,
  title: "Ett konkret inlägg",
  headline: "Poängen först",
  subject: null,
  body: "Det här är ett riktigt utkast.",
  cta: null,
  excerpt: null,
  hashtags: [],
  status: "draft" as const,
  generationPrompt: null,
  imagePrompt: null,
  language: "sv",
  timezone: "Europe/Stockholm",
  scheduledAt: null,
  scheduledLocalDate: null,
  scheduledLocalTime: null,
  approvalRequired: true,
  templateId: null,
  automationRuleId: null,
  newsletterAudienceId: null,
};

function editorDraft(overrides: Partial<StudioDraftView> = {}): StudioDraftView {
  return {
    id: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
    revision: 7,
    contentType: "social_post",
    channels: ["linkedin"],
    title: "Ett konkret inlägg",
    headline: "Poängen först",
    subject: "",
    body: "Det här är ett riktigt utkast.",
    cta: "",
    excerpt: "",
    hashtags: "#saga",
    status: "in_review",
    generationPrompt: "Skriv sakligt.",
    imagePrompt: "Mänsklig editorialbild.",
    timezone: "Europe/Stockholm",
    scheduledAt: "2026-09-01T07:00:00.000Z",
    scheduledLocalDate: "2026-09-01",
    scheduledLocalTime: "09:00",
    approvalRequired: true,
    media: [],
    templateId: null,
    automationRuleId: null,
    newsletterAudienceId: null,
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    ...overrides,
  };
}

describe("Content Studio-kontrakt", () => {
  it("kallar en satt tid för planering i SAGA tills extern leverans är bekräftad", () => {
    expect(studioPlanningStatusLabel("scheduled")).toBe("Planerad i SAGA");
    expect(studioPlanningStatusLabel("publishing")).toBe("Extern leverans pågår");
    expect(studioPlanningStatusLabel("published")).toBe("Extern leverans bekräftad");

    const html = renderToStaticMarkup(createElement(ContentPreview, {
      draft: editorDraft({ status: "scheduled" }),
      onEdit: () => undefined,
      onApprove: async () => undefined,
    }));
    expect(html).toContain("Planerad i SAGA");
    expect(html).toContain("Tid i kalendern");
    expect(html).toContain("Ingen extern leverans har startats.");
    expect(html).not.toContain("PUBLICERINGSPROFIL");
  });

  it("håller AI-förslaget utanför serie- och automationshand-off tills det är sparat och testbart", () => {
    expect(SAGA_WORKBENCH_STAGES.map((stage) => stage.id)).toEqual([
      "brief",
      "ai",
      "refine",
      "save",
      "reference",
    ]);

    expect(sagaWorkbenchHandoff({ isSaved: false, hasCopy: true, hasChannel: true })).toMatchObject({
      stage: "save",
      title: "Spara den fungerande versionen först.",
    });
    expect(sagaWorkbenchHandoff({ isSaved: true, hasCopy: false, hasChannel: true })).toMatchObject({
      stage: "refine",
    });
    expect(sagaWorkbenchHandoff({ isSaved: true, hasCopy: true, hasChannel: true })).toMatchObject({
      stage: "reference",
      title: "Det här kan bli seriens referensinlägg.",
    });
  });

  it("skickar aktuell revision i en sparad redigeringspayload men aldrig för ett lokalt utkast", () => {
    expect(draftPayload(editorDraft())).toMatchObject({
      title: "Ett konkret inlägg",
      scheduledLocalDate: "2026-09-01",
      scheduledLocalTime: "09:00",
      expectedRevision: 7,
    });
    expect(draftPayload(editorDraft({ id: "local-new", revision: null }))).not.toHaveProperty("expectedRevision");
  });

  it("behåller kvartalsbatchens privata granskningsläge när en redaktionell ändring sparas", () => {
    const payload = draftPayload(editorDraft({
      status: "draft",
      quarterlyPrivateReview: true,
      scheduledAt: "2026-09-01T07:00:00.000Z",
      scheduledLocalDate: "2026-09-01",
      scheduledLocalTime: "09:00",
      approvalRequired: false,
    }));

    expect(payload).toMatchObject({
      status: "in_review",
      scheduledAt: null,
      scheduledLocalDate: null,
      scheduledLocalTime: null,
      approvalRequired: true,
    });

    expect(draftPayload(editorDraft({ quarterlyPrivateReview: true, status: "approved" }))).toMatchObject({
      status: "approved",
      scheduledAt: "2026-09-01T07:00:00.000Z",
    });
  });

  it("låser ett batchgodkänt kvartalsutkast men låter ett returnerat utkast öppnas för redigering", () => {
    const approved = renderToStaticMarkup(createElement(ContentPreview, {
      draft: editorDraft({ quarterlyPrivateReview: true, status: "approved" }),
      onEdit: () => undefined,
      onApprove: async () => undefined,
    }));
    expect(approved).toContain("Batchbeslutet är sparat");
    expect(approved).not.toContain("Redigera");
    expect(approved).not.toContain("Godkänn utkast");
    expect(approved).toContain("Till batchgranskningen");

    const returned = renderToStaticMarkup(createElement(ContentPreview, {
      draft: editorDraft({ quarterlyPrivateReview: true, status: "in_review" }),
      onEdit: () => undefined,
      onApprove: async () => undefined,
    }));
    expect(returned).toContain("Redigera");
    expect(returned).not.toContain("Godkänn utkast");

    const rejected = renderToStaticMarkup(createElement(ContentPreview, {
      draft: editorDraft({ quarterlyPrivateReview: true, status: "cancelled" }),
      onEdit: () => undefined,
      onApprove: async () => undefined,
    }));
    expect(rejected).toContain("Batchbeslutet är avvisat");
    expect(rejected).not.toContain("Redigera");
    expect(rejected).not.toContain("Godkänn utkast");
  });

  it("renderar ett leveranslåst annonsbrief utan generering, media, kanal, schema eller godkännande", () => {
    const html = renderToStaticMarkup(createElement(PrivateAdCreativeBriefReview, {
      draft: editorDraft({
        contentType: "article",
        channels: [],
        status: "draft",
        deliveryLocked: true,
        privateBrief: true,
        body: "# Sätra\n\nDeterministiskt kreativt underlag.",
      }),
    }));

    expect(html).toContain("Extern leverans saknas");
    expect(html).toContain("Deterministiskt kreativt underlag");
    expect(html).toContain("Till annonsflödet");
    expect(html).not.toContain("Skapa med AI");
    expect(html).not.toContain("Lägg till foto");
    expect(html).not.toContain("Förbättra med AI");
    expect(html).not.toContain("Godkänn utkast");
    expect(html).not.toContain("Förbered för kanal");
    expect(html).not.toContain("Datum och tid");
    expect(html).not.toContain("<button");
  });

  it("håller nyhetsbrev på sin egen kanal och sociala inlägg på minst en kanal", () => {
    expect(contentDraftInputSchema.safeParse({
      ...baseDraft,
      contentType: "newsletter",
      channels: ["newsletter"],
      subject: "Veckans viktigaste",
    }).success).toBe(true);
    expect(contentDraftInputSchema.safeParse({
      ...baseDraft,
      contentType: "newsletter",
      channels: ["linkedin"],
    }).success).toBe(false);
    expect(contentDraftInputSchema.safeParse({ ...baseDraft, channels: [] }).success).toBe(false);
  });

  it("kräver en komplett lokal schemaläggning när ett utkast är schemalagt", () => {
    expect(contentDraftInputSchema.safeParse({
      ...baseDraft,
      status: "scheduled",
      scheduledAt: "2026-08-24T07:00:00.000Z",
      scheduledLocalDate: "2026-08-24",
      scheduledLocalTime: "09:00",
    }).success).toBe(true);
    expect(contentDraftInputSchema.safeParse({
      ...baseDraft,
      status: "scheduled",
      scheduledAt: "2026-08-24T07:00:00.000Z",
      scheduledLocalDate: null,
      scheduledLocalTime: "09:00",
    }).success).toBe(false);
  });

  it("har en verklig bildreferens innan ett mediaobjekt kan sparas", () => {
    expect(contentMediaAttachmentCreateSchema.safeParse({
      kind: "image",
      source: "upload",
      storagePath: "user-id/draft-id/hero.webp",
      assetUrl: null,
    }).success).toBe(true);
    expect(contentMediaAttachmentCreateSchema.safeParse({
      kind: "image",
      source: "upload",
      storagePath: null,
      assetUrl: null,
    }).success).toBe(false);
  });

  it("validerar veckofrekvens och enkel, förutsägbar cron", () => {
    const weekly = {
      name: "Tre inlägg varje vecka",
      active: true,
      contentType: "social_post" as const,
      channels: ["instagram"] as const,
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv om produktlärdomar.",
      imagePrompt: "En redaktionell bild.",
      desiredLength: 300,
      tone: "Rak och varm",
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count" as const,
      weeklyCount: 3,
      weekdays: [],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    };
    expect(contentAutomationRuleInputSchema.safeParse(weekly).success).toBe(true);
    expect(contentAutomationRuleInputSchema.safeParse({ ...weekly, weekdays: [1, 3] }).success).toBe(false);
    expect(contentAutomationRuleInputSchema.safeParse({
      ...weekly,
      scheduleMode: "cron",
      weeklyCount: null,
      cronExpression: "0 9 * * 1,3,5",
    }).success).toBe(true);
    expect(contentAutomationRuleInputSchema.safeParse({
      ...weekly,
      scheduleMode: "cron",
      weeklyCount: null,
      cronExpression: "* * * * *",
    }).success).toBe(false);
  });

  it("fördelar tre veckoposter till riktiga framtida köplatser", () => {
    const rule = contentAutomationRuleInputSchema.parse({
      name: "Tre inlägg varje vecka",
      active: true,
      contentType: "social_post",
      channels: ["instagram"],
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv ett inlägg.",
      imagePrompt: "En bild.",
      desiredLength: 300,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 3,
      weekdays: [],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    });
    const occurrences = previewContentAutomationOccurrences(rule, {
      now: new Date("2026-08-17T06:00:00.000Z"),
      horizonDays: 7,
    });
    expect(occurrences.slice(0, 3).map((item) => `${item.localDate} ${item.localTime}`)).toEqual([
      "2026-08-17 09:00",
      "2026-08-19 09:00",
      "2026-08-21 09:00",
    ]);
  });

  it("håller ett uttryckligt veckoschema inom dess datumgränser och i vald tidszon", () => {
    const rule = contentAutomationRuleInputSchema.parse({
      name: "Måndag och torsdag",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv rakt om veckans lärdom.",
      imagePrompt: "",
      desiredLength: 180,
      tone: "Rak",
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 2,
      weekdays: [1, 4],
      localTimes: ["08:15"],
      cronExpression: null,
      startsOn: "2026-08-24",
      endsOn: "2026-08-27",
    });

    const occurrences = previewContentAutomationOccurrences(rule, {
      now: new Date("2026-08-20T08:00:00.000Z"),
      horizonDays: 14,
    });

    expect(occurrences).toEqual([
      { localDate: "2026-08-24", localTime: "08:15", scheduledFor: "2026-08-24T06:15:00.000Z" },
      { localDate: "2026-08-27", localTime: "08:15", scheduledFor: "2026-08-27T06:15:00.000Z" },
    ]);
  });

  it("tolkar cron i automationens tidszon, inte i serverns tidszon", () => {
    const rule = contentAutomationRuleInputSchema.parse({
      name: "New York-måndagar",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv en kort marknadsnotis.",
      imagePrompt: "",
      desiredLength: 120,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "America/New_York",
      scheduleMode: "cron",
      weeklyCount: null,
      weekdays: [],
      localTimes: ["09:00"],
      cronExpression: "0 9 * * 1",
      startsOn: null,
      endsOn: null,
    });

    const [next] = previewContentAutomationOccurrences(rule, {
      now: new Date("2026-08-17T12:00:00.000Z"), // 08:00 i New York
      horizonDays: 7,
    });

    expect(next).toEqual({
      localDate: "2026-08-17",
      localTime: "09:00",
      scheduledFor: "2026-08-17T13:00:00.000Z",
    });
  });

  it("skapar aldrig en omöjlig lokal tid vid sommartidsväxling", () => {
    const rule = contentAutomationRuleInputSchema.parse({
      name: "Nattkörning",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv ett utkast.",
      imagePrompt: "",
      desiredLength: 120,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [0],
      localTimes: ["02:30"],
      cronExpression: null,
      startsOn: "2026-03-29",
      endsOn: "2026-03-29",
    });

    expect(previewContentAutomationOccurrences(rule, {
      now: new Date("2026-03-28T12:00:00.000Z"),
      horizonDays: 2,
    })).toEqual([]);
  });

  it("avvisar osäkra kombinationer före de når automationskön", () => {
    const base = {
      name: "Validerad automation",
      active: true,
      contentType: "social_post" as const,
      channels: ["instagram"] as const,
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Skriv konkret.",
      imagePrompt: "",
      desiredLength: 180,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count" as const,
      weeklyCount: 2,
      weekdays: [1, 4],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    };

    expect(contentAutomationRuleInputSchema.safeParse({ ...base, channels: [] }).success).toBe(false);
    expect(contentAutomationRuleInputSchema.safeParse({ ...base, channels: ["instagram", "instagram"] }).success).toBe(false);
    expect(contentAutomationRuleInputSchema.safeParse({ ...base, weeklyCount: 3 }).success).toBe(false);
    expect(contentAutomationRuleInputSchema.safeParse({ ...base, startsOn: "2026-09-01", endsOn: "2026-08-31" }).success).toBe(false);
    expect(contentAutomationRuleInputSchema.safeParse({
      ...base,
      contentType: "newsletter",
      channels: ["linkedin"],
    }).success).toBe(false);
  });

  it("har systemoberoende mallformat för artikel och kanalformat för nyhetsbrev", () => {
    expect(contentTemplateInputSchema.safeParse({
      slug: null,
      name: "Artikelmall",
      description: "För längre resonemang.",
      contentType: "article",
      channels: [],
      defaultTitle: "",
      defaultHeadline: null,
      defaultSubject: null,
      defaultBody: "",
      defaultCta: null,
      defaultExcerpt: null,
      defaultHashtags: [],
      generationPrompt: "Skriv konkret.",
      imagePrompt: "En bild.",
      defaultLanguage: "sv",
      active: true,
    }).success).toBe(true);
  });
});
