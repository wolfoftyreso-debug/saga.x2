import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  StudioContentConflictError,
  StudioContentValidationError,
  createStudioMediaMetadata,
  deleteStudioMediaMetadata,
  getStudioContentCalendar,
  rescheduleStudioDraft,
  updateStudioDraft,
} from "@/lib/neon/studio-content-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "editor",
  email: "editor@example.test",
  displayName: "Editor",
};

const draftId = "33333333-3333-4333-8333-333333333333";
const mediaId = "44444444-4444-4444-8444-444444444444";
const oldAt = "2026-09-01T07:00:00.000Z";
const newAt = "2026-09-02T07:30:00.000Z";

function sqlWith(...responses: unknown[]) {
  const pending = [...responses];
  const query = vi.fn();
  query.mockImplementation(async (...args: unknown[]) => {
    const [statement] = args;
    // The real calendar now overlays review-only quarterly plan slots. These
    // focused draft tests deliberately have no plan slots, so keep their
    // response queue about the Studio query under test rather than faking a
    // quarter-plan row in every case.
    if (typeof statement === "string" && statement.includes("saga_quarterly_activity_plan_slots")) return [];
    return pending.shift() ?? [];
  });
  return { sql: { query } as unknown as NeonSql, query };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: draftId,
    author_user_id: actor.userId,
    template_id: null,
    automation_job_id: null,
    content_type: "social_post",
    status: "in_review",
    title: "Provkörning i Sätra",
    body: "En genomarbetad text.",
    excerpt: "Boka en trygg provkörning.",
    publication_channels: ["instagram"],
    metadata: {
      headline: "Nya elbilar",
      language: "sv",
      timezone: "Europe/Stockholm",
      scheduledLocalDate: "2026-09-01",
      scheduledLocalTime: "09:00",
      approvalRequired: true,
      approvedAt: null,
      hashtags: [],
    },
    revision: 4,
    scheduled_at: oldAt,
    published_at: null,
    created_at: "2026-08-24T08:00:00.000Z",
    updated_at: "2026-08-24T08:00:00.000Z",
    ...overrides,
  };
}

function lockedAdDraftRow(overrides: Record<string, unknown> = {}) {
  return draftRow({
    content_type: "article",
    status: "draft",
    publication_channels: [],
    scheduled_at: null,
    metadata: {
      ...draftRow().metadata,
      scheduledLocalDate: null,
      scheduledLocalTime: null,
      adAutomationRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      adAutomationDraftKind: "deterministic_creative_brief",
      adAutomationDeliveryLocked: true,
      adAutomationOrigin: "private_draft_only",
    },
    ...overrides,
  });
}

function quarterlyDraftRow(overrides: Record<string, unknown> = {}) {
  return draftRow({
    status: "in_review",
    scheduled_at: null,
    metadata: {
      ...draftRow().metadata,
      scheduledLocalDate: null,
      scheduledLocalTime: null,
      sagaQuarterlyActivityPlan: {
        planId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        batchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        batchItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        privateOnly: true,
        calendarScheduled: false,
      },
    },
    ...overrides,
  });
}

function quarterlyReturnedReviewState() {
  return [{ item_state: "returned", review_resolution: null, batch_state: "rework_required" }];
}

function quarterlyApprovedReviewState() {
  return [{ item_state: "approved", review_resolution: "approved", batch_state: "resolved" }];
}

describe("Neon calendar scheduling", () => {
  it("moves an editable draft atomically, retains review state and never writes a publication state", async () => {
    const moved = draftRow({
      revision: 5,
      scheduled_at: newAt,
      metadata: {
        ...draftRow().metadata,
        scheduledLocalDate: "2026-09-02",
        scheduledLocalTime: "09:30",
      },
    });
    const { sql, query } = sqlWith([draftRow()], [moved]);

    const draft = await rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") });

    expect(draft).toMatchObject({
      id: draftId,
      status: "in_review",
      revision: 5,
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      publishedAt: null,
    });
    const [update, params] = query.mock.calls[1] ?? [];
    expect(update).toContain("and revision = $3::int");
    expect(update).not.toContain("status =");
    expect(params?.slice(0, 3)).toEqual([actor.workspaceId, draftId, 4]);
    expect(params?.[4]).toBe(newAt);
    expect(JSON.parse(params?.[3] as string)).toMatchObject({
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
    });
  });

  it("rejects a stale drag before it can overwrite a newer calendar time", async () => {
    const { sql, query } = sqlWith([draftRow({ revision: 5 })]);

    await expect(rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") })).rejects.toBeInstanceOf(StudioContentConflictError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a local time that does not match the persisted ISO instant", async () => {
    const { sql, query } = sqlWith([draftRow()]);

    await expect(rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:31",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") })).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires a revision for a broad editor update whenever a schedule exists", async () => {
    const { sql, query } = sqlWith([draftRow()]);

    await expect(updateStudioDraft(actor, draftId, { title: "Uppdaterad rubrik" }, sql)).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("uses the optional editor revision as an atomic database predicate", async () => {
    const updated = draftRow({ revision: 5, title: "Uppdaterad rubrik" });
    const { sql, query } = sqlWith([draftRow()], [updated]);

    const draft = await updateStudioDraft(actor, draftId, {
      title: "Uppdaterad rubrik",
      expectedRevision: 4,
    }, sql);

    expect(draft).toMatchObject({ title: "Uppdaterad rubrik", revision: 5, status: "in_review" });
    const [update, params] = query.mock.calls[1] ?? [];
    expect(update).toContain("($12::int is null or revision = $12::int)");
    expect(params?.[11]).toBe(4);
  });

  it("keeps server-owned ad creative briefs private when a generic draft PATCH tries to add a channel", async () => {
    const { sql, query } = sqlWith([lockedAdDraftRow()]);

    await expect(updateStudioDraft(actor, draftId, {
      channels: ["instagram"],
      expectedRevision: 4,
    }, sql)).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not allow a calendar drag to add a schedule to a delivery-locked ad brief", async () => {
    const { sql, query } = sqlWith([lockedAdDraftRow()]);

    await expect(rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") })).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not let a generic Studio PATCH approve a private quarterly draft", async () => {
    const { sql, query } = sqlWith([quarterlyDraftRow()], quarterlyReturnedReviewState());

    await expect(updateStudioDraft(actor, draftId, {
      status: "approved",
      expectedRevision: 4,
    }, sql)).rejects.toBeInstanceOf(StudioContentValidationError);

    // Ownership + durable batch item verification; no draft write occurs.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("saga_quarterly_activity_plan_batch_items");
  });

  it("does not let a calendar drag schedule a quarterly draft before its durable batch approval", async () => {
    const { sql, query } = sqlWith([quarterlyDraftRow()], quarterlyReturnedReviewState());

    await expect(rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") })).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("saga_quarterly_activity_plan_batch_items");
  });

  it("does not let generic media APIs bypass unresolved quarterly batch review", async () => {
    const upload = sqlWith([quarterlyDraftRow()], quarterlyReturnedReviewState());
    await expect(createStudioMediaMetadata(actor, {
      draftId,
      blobUrl: "https://private.example.test/image.jpg",
      blobPathname: "studio/workspaces/test/image.jpg",
      contentType: "image/jpeg",
      byteSize: 42,
      fileName: "image.jpg",
    }, upload.sql)).rejects.toBeInstanceOf(StudioContentValidationError);
    expect(upload.query).toHaveBeenCalledTimes(2);

    const remove = sqlWith([quarterlyDraftRow()], quarterlyReturnedReviewState());
    await expect(deleteStudioMediaMetadata(actor, draftId, mediaId, remove.sql)).rejects.toBeInstanceOf(StudioContentValidationError);
    expect(remove.query).toHaveBeenCalledTimes(2);
  });

  it("preserves in_review on a returned quarterly draft when Content Editor saves its draft default", async () => {
    const saved = quarterlyDraftRow({ revision: 5, title: "Förfinad systeminsikt" });
    const { sql, query } = sqlWith([quarterlyDraftRow()], quarterlyReturnedReviewState(), [saved]);

    const draft = await updateStudioDraft(actor, draftId, {
      title: "Förfinad systeminsikt",
      // Content Editor serializes this default for an unscheduled document.
      // The quarterly server guard must preserve in_review for resubmission.
      status: "draft",
      expectedRevision: 4,
    }, sql);

    expect(draft).toMatchObject({ status: "in_review", title: "Förfinad systeminsikt", revision: 5, quarterlyPrivateReview: true });
    const [, parameters] = query.mock.calls[2] ?? [];
    expect(parameters?.[4]).toBe("in_review");
  });

  it("preserves approved after durable batch review when Content Editor sends its in_review transport default", async () => {
    const approved = quarterlyDraftRow({
      status: "approved",
      metadata: { ...quarterlyDraftRow().metadata, approvedAt: "2026-08-25T08:00:00.000Z" },
    });
    const saved = quarterlyDraftRow({
      status: "approved",
      revision: 5,
      metadata: { ...approved.metadata, approvedAt: "2026-08-25T08:00:00.000Z" },
    });
    const { sql, query } = sqlWith([approved], quarterlyApprovedReviewState(), [saved]);

    const draft = await updateStudioDraft(actor, draftId, {
      status: "in_review",
      expectedRevision: 4,
    }, sql);

    expect(draft).toMatchObject({ status: "approved", revision: 5, quarterlyPrivateReview: true });
    const [, parameters] = query.mock.calls[2] ?? [];
    expect(parameters?.[4]).toBe("approved");
  });

  it("does not let a generic Studio edit change editorial content after durable quarterly approval", async () => {
    const approved = quarterlyDraftRow({
      status: "approved",
      metadata: { ...quarterlyDraftRow().metadata, approvedAt: "2026-08-25T08:00:00.000Z" },
    });
    const { sql, query } = sqlWith([approved], quarterlyApprovedReviewState());

    await expect(updateStudioDraft(actor, draftId, {
      title: "En ändring efter batchens beslut",
      status: "in_review",
      expectedRevision: 4,
    }, sql)).rejects.toBeInstanceOf(StudioContentValidationError);

    // The durable item was checked, but no Studio draft mutation happened.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps an automation draft that did not pass production quality out of the calendar", async () => {
    const automated = draftRow({
      automation_job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      metadata: {
        ...draftRow().metadata,
        sagaProductionQuality: {
          version: "saga-production-quality/v1",
          decision: "review_required",
          score: 84,
          findings: [{ code: "body_off_target_length", severity: "warning" }],
          canCreatePrivateDraft: true,
          canEnterCalendar: false,
          canDeliver: false,
        },
        sagaProductionQualityContext: { targetLength: "medium" },
      },
    });
    const { sql, query } = sqlWith([automated]);

    await expect(rescheduleStudioDraft(actor, draftId, {
      scheduledAt: newAt,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 4,
    }, sql, { now: new Date("2026-08-24T08:00:00.000Z") })).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns a safe thumbnail and exact calendar placement without exposing a Blob URL", async () => {
    const { sql, query } = sqlWith(
      [draftRow({
        revision: 4,
        scheduled_at: newAt,
        metadata: {
          ...draftRow().metadata,
          scheduledLocalDate: "2026-09-02",
          scheduledLocalTime: "09:30",
        },
      })],
      [{
        id: mediaId,
        draft_id: draftId,
        blob_url: "https://private.blob.vercel-storage.com/never-expose-this.jpg",
        blob_pathname: "studio/workspace/drafts/photo.jpg",
        content_type: "image/jpeg",
        byte_size: 42,
        kind: "upload",
        status: "ready",
        alt_text: "En elbil framför verkstaden",
        metadata: { contentKind: "image", source: "upload", processingStatus: "ready", sortOrder: 0 },
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T08:00:00.000Z",
      }],
    );

    const calendar = await getStudioContentCalendar(actor, {
      from: "2026-09-01",
      to: "2026-09-07",
      timezone: "Europe/Stockholm",
    }, sql);

    expect(calendar.entries).toEqual([expect.objectContaining({
      id: `draft:${draftId}`,
      draftId,
      localDate: "2026-09-02",
      localTime: "09:30",
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      revision: 4,
      editable: true,
      thumbnail: {
        assetUrl: `/api/content/drafts/${draftId}/media/${mediaId}/asset`,
        altText: "En elbil framför verkstaden",
      },
    })]);
    expect(JSON.stringify(calendar)).not.toContain("private.blob.vercel-storage.com");
    expect(query.mock.calls[2]?.[0]).toContain("draft_id = any($2::uuid[])");
  });

  it("keeps a historical delivery-locked brief readable but never marks it as movable", async () => {
    const locked = lockedAdDraftRow({
      status: "in_review",
      scheduled_at: newAt,
      metadata: {
        ...lockedAdDraftRow().metadata,
        scheduledLocalDate: "2026-09-02",
        scheduledLocalTime: "09:30",
      },
    });
    const { sql } = sqlWith([locked], []);

    const calendar = await getStudioContentCalendar(actor, {
      from: "2026-09-01",
      to: "2026-09-07",
      timezone: "Europe/Stockholm",
    }, sql);

    expect(calendar.entries).toEqual([expect.objectContaining({
      id: `draft:${draftId}`,
      draftId,
      revision: 4,
      editable: false,
      scheduledLocalDate: "2026-09-02",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
    })]);
  });

  it("keeps a published entry inspectable through its exact draft without offering a move", async () => {
    const published = draftRow({
      status: "published",
      scheduled_at: newAt,
      published_at: "2026-09-02T07:31:00.000Z",
      metadata: {
        ...draftRow().metadata,
        scheduledLocalDate: "2026-09-02",
        scheduledLocalTime: "09:30",
        approvalRequired: false,
      },
    });
    const { sql } = sqlWith([published], []);

    const calendar = await getStudioContentCalendar(actor, {
      from: "2026-09-01",
      to: "2026-09-07",
      timezone: "Europe/Stockholm",
    }, sql);

    expect(calendar.entries).toEqual([expect.objectContaining({
      id: `draft:${draftId}`,
      draftId,
      status: "published",
      revision: 4,
      editable: false,
    })]);
  });
});
