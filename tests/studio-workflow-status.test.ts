import { describe, expect, it } from "vitest";
import {
  EMPTY_STUDIO_DATA,
  type StudioAutomationView,
  type StudioChannelView,
  type StudioData,
  type StudioDraftView,
} from "@/components/content-studio-adapter";
import { STUDIO_WORKFLOW_STAGE_IDS, studioWorkflowStatusFromData } from "@/components/studio-workflow-status";

const now = new Date("2026-08-23T07:00:00.000Z");

function readyData(overrides: Partial<StudioData> = {}): StudioData {
  return {
    ...EMPTY_STUDIO_DATA,
    loaded: true,
    backendState: "ready",
    ...overrides,
  };
}

function draft(overrides: Partial<StudioDraftView>): StudioDraftView {
  return {
    id: "draft-1",
    contentType: "social_post",
    channels: ["linkedin"],
    title: "Ett konkret inlägg",
    headline: "Poängen först",
    subject: "",
    body: "Ett riktigt sparat utkast.",
    cta: "",
    excerpt: "",
    hashtags: "",
    status: "draft",
    generationPrompt: "",
    imagePrompt: "",
    timezone: "Europe/Stockholm",
    scheduledAt: null,
    scheduledLocalDate: null,
    scheduledLocalTime: null,
    revision: null,
    approvalRequired: true,
    media: [],
    templateId: null,
    automationRuleId: null,
    newsletterAudienceId: null,
    createdAt: "2026-08-22T09:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

const automation: StudioAutomationView = {
  id: "automation-1",
  name: "Tre produktlärdomar",
  active: true,
  contentType: "social_post",
  channels: ["linkedin"],
  postsPerWeek: 3,
  weekdays: [1, 3, 5],
  localTime: "09:00",
  timezone: "Europe/Stockholm",
  topic: "Produktlärdomar",
  prompt: "Skriv rakt.",
  tone: "Rak",
  targetLength: "medium",
  imageDirection: "Editorial",
  approvalRequired: true,
  nextRunAt: "2026-08-24T07:00:00.000Z",
  lastRunAt: null,
  updatedAt: "2026-08-22T10:00:00.000Z",
};

const channel: StudioChannelView = {
  id: "channel-1",
  kind: "linkedin",
  accountName: "Eriks konto",
  state: "connected",
  canPublish: true,
  lastSyncedAt: "2026-08-22T10:00:00.000Z",
};

describe("Studio workflow status", () => {
  it("visar inga påhittade arbetsflöden när backend inte går att verifiera", () => {
    const workflow = studioWorkflowStatusFromData({
      ...EMPTY_STUDIO_DATA,
      loaded: true,
      backendState: "unconfigured",
      backendIssue: {
        message: "Databaskopplingen saknas.",
        missingConfiguration: ["NEXT_PUBLIC_SUPABASE_URL"],
      },
    }, now);

    expect(workflow.primaryHref).toBe("/settings");
    expect(workflow.primaryAction).toBe("Öppna inställningar");
    expect(workflow.stages.map((stage) => stage.id)).toEqual(STUDIO_WORKFLOW_STAGE_IDS);
    expect(workflow.stages.every((stage) => stage.tone === "blocked" && stage.metric === "Ej verifierat")).toBe(true);
  });

  it("räknar verkliga steg och leder varje åtgärd till en riktig Studio-route", () => {
    const reviewDraft = draft({ id: "review-1", status: "in_review", title: "Granska detta", updatedAt: "2026-08-23T06:00:00.000Z" });
    const scheduledDraft = draft({
      id: "scheduled-1",
      status: "approved",
      title: "Planerat innehåll",
      scheduledAt: "2026-08-24T08:00:00.000Z",
      scheduledLocalDate: "2026-08-24",
      scheduledLocalTime: "10:00",
    });
    const publishedDraft = draft({ id: "published-1", status: "published", title: "Redan ute" });
    const workflow = studioWorkflowStatusFromData(readyData({
      drafts: [reviewDraft, scheduledDraft, publishedDraft],
      automations: [automation],
      channels: [channel],
      calendarEntries: [{
        id: "calendar-1",
        kind: "draft",
        startAt: "2026-08-24T08:00:00.000Z",
        endAt: null,
        status: "approved",
        draftId: "scheduled-1",
        automationRuleId: null,
        title: "Planerat innehåll",
        channels: ["linkedin"],
      }],
    }), now);

    const byId = Object.fromEntries(workflow.stages.map((stage) => [stage.id, stage]));
    expect(byId.intake).toMatchObject({ tone: "active", href: "/studio/automations" });
    expect(byId.review).toMatchObject({ tone: "attention", href: "/studio/content/review-1", action: "Granska nu" });
    expect(byId.schedule).toMatchObject({ tone: "ready", href: "/studio/calendar" });
    expect(byId.publish).toMatchObject({ tone: "ready", href: "/studio/channels" });
    expect(workflow.primaryHref).toBe("/studio/content/review-1");
    expect(workflow.summary).toContain("2 aktiva utkast");
  });

  it("är tydlig med att en tom men konfigurerad Studio är tom", () => {
    const workflow = studioWorkflowStatusFromData(readyData(), now);

    expect(workflow.headline).toBe("Flödet är redo att starta");
    expect(workflow.description).toContain("Inga utkast, automationer eller publiceringskanaler");
    expect(workflow.stages.map((stage) => stage.href)).toEqual([
      "/studio/automations",
      "/studio/create",
      "/studio/calendar",
      "/studio/calendar",
      "/studio/channels",
    ]);
  });
});
