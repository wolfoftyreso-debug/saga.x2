import { describe, expect, it } from "vitest";
import {
  contentAutomationManualRunInputSchema,
  type ContentAutomationJobView,
  type ContentAutomationRuleView,
} from "@/lib/domain/content-studio";
import { contentAutomationDraftInputForJob } from "@/lib/services/content-studio";

const rule: ContentAutomationRuleView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Produktnyheter",
  active: false,
  contentType: "social_post",
  channels: ["linkedin"],
  templateId: null,
  newsletterAudienceId: null,
  generationPrompt: "Skriv om en produktlärdom.",
  imagePrompt: "En enkel arbetsbild.",
  desiredLength: 180,
  tone: "Rak och varm",
  language: "sv",
  approvalRequired: false,
  timezone: "Europe/Stockholm",
  scheduleMode: "weekly_count",
  weeklyCount: 1,
  weekdays: [1],
  localTimes: ["09:00"],
  cronExpression: null,
  startsOn: null,
  endsOn: null,
  nextRunAt: "2026-08-24T07:00:00.000Z",
  lastRunAt: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function job(triggerKind: ContentAutomationJobView["triggerKind"]): ContentAutomationJobView {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    userId: rule.userId,
    automationRuleId: rule.id,
    contentDraftId: null,
    triggerKind,
    manualRunKey: triggerKind === "manual" ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd" : null,
    state: "processing",
    scheduledFor: "2026-08-22T07:00:00.000Z",
    timezone: "Europe/Stockholm",
    scheduledLocalDate: "2026-08-22",
    scheduledLocalTime: "09:00",
    attemptCount: 1,
    lockedUntil: "2026-08-22T07:12:00.000Z",
    claimedAt: "2026-08-22T07:00:00.000Z",
    completedAt: null,
    lastError: null,
    createdAt: "2026-08-22T07:00:00.000Z",
    updatedAt: "2026-08-22T07:00:00.000Z",
  };
}

describe("manuella automationskörningar", () => {
  it("kräver en UUID-idempotensnyckel för en återförsökssäker körning", () => {
    expect(contentAutomationManualRunInputSchema.safeParse({
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }).success).toBe(true);
    expect(contentAutomationManualRunInputSchema.safeParse({}).success).toBe(false);
    expect(contentAutomationManualRunInputSchema.safeParse({ idempotencyKey: "inte-en-uuid" }).success).toBe(false);
  });

  it("gör ett manuellt kör nu-utkast oschemalagt även när regeln normalt auto-publicerar", () => {
    const draft = contentAutomationDraftInputForJob({
      job: job("manual"),
      rule,
      template: null,
      content: { title: "Ett privat utkast", body: "Det här får inte publiceras automatiskt." },
    });
    expect(draft.status).toBe("draft");
    expect(draft.scheduledAt).toBeNull();
    expect(draft.scheduledLocalDate).toBeNull();
    expect(draft.scheduledLocalTime).toBeNull();
    expect(draft.approvalRequired).toBe(false);
  });

  it("behåller en riktig schemalagd körning när ägaren uttryckligen har valt automatisk publicering", () => {
    const draft = contentAutomationDraftInputForJob({
      job: job("scheduled"),
      rule,
      template: null,
      content: { title: "Planerat utkast", body: "Det här följer den vanliga schemakörningen." },
    });
    expect(draft.status).toBe("scheduled");
    expect(draft.scheduledAt).toBe("2026-08-22T07:00:00.000Z");
    expect(draft.scheduledLocalDate).toBe("2026-08-22");
    expect(draft.scheduledLocalTime).toBe("09:00");
  });
});
