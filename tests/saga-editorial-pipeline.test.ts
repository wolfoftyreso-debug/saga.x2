import { describe, expect, it } from "vitest";
import { sagaEditorialModel } from "@/components/saga-editorial-pipeline";
import {
  createEmptyStudioData,
  type StudioAutomationView,
  type StudioChannelView,
  type StudioData,
  type StudioDraftView,
} from "@/components/content-studio-adapter";

function readyData(overrides: Partial<StudioData> = {}): StudioData {
  return {
    ...createEmptyStudioData(),
    loaded: true,
    backendState: "ready",
    ...overrides,
  };
}

function draft(overrides: Partial<StudioDraftView> = {}): StudioDraftView {
  return {
    id: "draft-1",
    contentType: "social_post",
    channels: ["linkedin"],
    title: "En tydlig tanke",
    headline: "Poängen först",
    subject: "",
    body: "En redigerbar text.",
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
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    ...overrides,
  };
}

const channel: StudioChannelView = {
  id: "channel-1",
  kind: "linkedin",
  accountName: "SAGA",
  state: "connected",
  canPublish: true,
  lastSyncedAt: "2026-08-24T08:00:00.000Z",
};

const automation: StudioAutomationView = {
  id: "automation-1",
  name: "Veckans lärdom",
  active: true,
  contentType: "social_post",
  channels: ["linkedin"],
  postsPerWeek: 1,
  weekdays: [1],
  localTime: "09:00",
  timezone: "Europe/Stockholm",
  topic: "Kundlärdomar",
  prompt: "Skriv kort.",
  tone: "Rak",
  targetLength: "medium",
  imageDirection: "",
  approvalRequired: true,
  nextRunAt: null,
  lastRunAt: null,
  updatedAt: "2026-08-24T08:00:00.000Z",
};

describe("SAGA editorial pipeline", () => {
  it("shows an honest first-run path without inventing research or publishing readiness", () => {
    const model = sagaEditorialModel(readyData());
    const byId = Object.fromEntries(model.stages.map((stage) => [stage.id, stage]));

    expect(model.stages.map((stage) => stage.id)).toEqual([
      "listen",
      "verify",
      "take",
      "create",
      "adapt",
      "review",
      "publish",
      "learn",
    ]);
    expect(byId.listen).toMatchObject({ state: "needs_setup", href: "/studio/research" });
    expect(byId.verify).toMatchObject({ state: "needs_setup", href: "/studio/research" });
    expect(byId.take).toMatchObject({ state: "ready", href: "/studio/lens" });
    expect(byId.publish).toMatchObject({ state: "needs_setup", href: "/studio/channels" });
    expect(model.focus).toMatchObject({ href: "#saga-create", action: "Skriv min vinkel" });
  });

  it("routes actual draft, channel and automation data to the next useful tool", () => {
    const review = draft({
      id: "review-1",
      title: "Det här behöver granskas",
      status: "in_review",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    const model = sagaEditorialModel(readyData({
      drafts: [draft(), review],
      channels: [channel],
      automations: [automation],
    }));
    const byId = Object.fromEntries(model.stages.map((stage) => [stage.id, stage]));

    expect(byId.create).toMatchObject({ state: "in_progress", href: "/studio/content/review-1" });
    expect(byId.adapt).toMatchObject({ state: "in_progress", href: "/studio/content/review-1?edit=1" });
    expect(byId.review).toMatchObject({ state: "in_progress", href: "/studio/content/review-1", action: "Granska nästa" });
    expect(byId.publish).toMatchObject({ state: "ready", href: "/studio/channels" });
    expect(byId.learn).toMatchObject({ state: "in_progress", href: "/studio/automations" });
    expect(model.snapshot).toEqual({ drafts: 2, awaitingReview: 1, readyChannels: 1, activeAutomations: 1 });
    expect(model.focus).toMatchObject({ title: "Det här behöver granskas", href: "/studio/content/review-1" });
  });
});
