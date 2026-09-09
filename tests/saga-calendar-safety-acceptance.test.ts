import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  StudioContentConflictError,
  StudioContentValidationError,
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
const now = new Date("2026-08-24T08:00:00.000Z");

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

function scheduledRow(overrides: Record<string, unknown> = {}) {
  return {
    id: draftId,
    author_user_id: actor.userId,
    template_id: null,
    automation_job_id: null,
    content_type: "social_post",
    status: "scheduled",
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
      approvalRequired: false,
      approvedAt: null,
      hashtags: [],
    },
    revision: 4,
    scheduled_at: "2026-09-01T07:00:00.000Z",
    published_at: null,
    created_at: "2026-08-24T08:00:00.000Z",
    updated_at: "2026-08-24T08:00:00.000Z",
    ...overrides,
  };
}

const validMove = {
  scheduledAt: "2026-09-02T07:30:00.000Z",
  scheduledLocalDate: "2026-09-02",
  scheduledLocalTime: "09:30",
  timezone: "Europe/Stockholm",
  expectedRevision: 4,
};

describe("SAGA calendar publishing safety", () => {
  it("never moves cancelled, publishing, or published cards", async () => {
    for (const status of ["cancelled", "publishing", "published"] as const) {
      const { sql, query } = sqlWith([scheduledRow({ status })]);

      await expect(rescheduleStudioDraft(actor, draftId, validMove, sql, { now }))
        .rejects.toBeInstanceOf(StudioContentValidationError);

      // Ownership is checked first; no write is attempted for a terminal card.
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("does not use a calendar move to bypass required editorial approval", async () => {
    const { sql, query } = sqlWith([scheduledRow({
      metadata: { ...scheduledRow().metadata, approvalRequired: true, approvedAt: null },
    })]);

    await expect(rescheduleStudioDraft(actor, draftId, validMove, sql, { now }))
      .rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a calendar date in the past before any schedule write", async () => {
    const { sql, query } = sqlWith([scheduledRow({ status: "in_review" })]);

    await expect(rescheduleStudioDraft(actor, draftId, {
      ...validMove,
      scheduledAt: "2026-08-20T07:30:00.000Z",
      scheduledLocalDate: "2026-08-20",
    }, sql, { now })).rejects.toBeInstanceOf(StudioContentValidationError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("makes stale full-editor saves fail with a conflict instead of erasing a newer schedule", async () => {
    const { sql, query } = sqlWith([scheduledRow()], []);

    await expect(updateStudioDraft(actor, draftId, {
      title: "En äldre redigeringssession",
      expectedRevision: 4,
    }, sql)).rejects.toBeInstanceOf(StudioContentConflictError);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("revision = $12::int");
  });
});
