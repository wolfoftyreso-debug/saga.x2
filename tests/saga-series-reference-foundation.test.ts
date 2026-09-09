import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  sagaSeriesReferenceCreateSchema,
  sagaSeriesReferenceSnapshotSchema,
  type SagaSeriesReferenceControls,
  type SagaSeriesReferenceCreateInput,
} from "@/lib/domain/saga-series-reference";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  createSagaSeriesReference,
  getSagaSeriesReferenceGuidanceContext,
  listSagaSeriesReferences,
  patchSagaSeriesReference,
  SagaSeriesReferenceAccessError,
} from "@/lib/neon/saga-series-reference-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const seriesId = "33333333-3333-4333-8333-333333333333";
const sourceDraftId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-25T12:00:00.000Z";

const controls: SagaSeriesReferenceControls = {
  objective: "educate",
  audience: "Företagare som vill frigöra tid",
  tone: "insightful",
  requiredElements: ["En konkret insikt"],
  forbiddenElements: ["Tomma superlativ"],
  defaultChannels: ["linkedin"],
  reviewRequired: true,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: seriesId,
    created_by_user_id: actor.userId,
    updated_by_user_id: actor.userId,
    slug: "frigjord-tid",
    name: "Frigjord tid",
    active: true,
    revision: 1,
    source_draft_id: sourceDraftId,
    source_draft_revision: 4,
    content_type: "social_post",
    reference_title: "System som ger människor mer tid",
    reference_body: "När system tar hand om återkommande arbete får människor mer tid till kundmötet.",
    reference_channels: ["linkedin"],
    media_safe_metadata: [{
      kind: "generated",
      contentType: "image/jpeg",
      width: 1600,
      height: 1000,
      altText: "Två personer planerar vid ett bord i ett ljust arbetsrum.",
      status: "ready",
    }],
    controls_snapshot: controls,
    captured_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

describe("SAGA Series Reference Vercel/Neon foundation", () => {
  it("requires meaningful reference copy, a named audience and non-optional review", () => {
    expect(sagaSeriesReferenceCreateSchema.safeParse({
      slug: "frigjord-tid",
      name: "Frigjord tid",
      referenceDraftId: sourceDraftId,
      controls: { ...controls, audience: "" },
    }).success).toBe(false);
    expect(sagaSeriesReferenceCreateSchema.safeParse({
      slug: "frigjord-tid",
      name: "Frigjord tid",
      referenceDraftId: sourceDraftId,
      controls: { ...controls, reviewRequired: false },
    }).success).toBe(false);
    expect(sagaSeriesReferenceSnapshotSchema.safeParse({
      revision: 1,
      sourceDraftId,
      sourceDraftRevision: 1,
      contentType: "social_post",
      title: " ",
      body: " ",
      channels: [],
      media: [],
      capturedAt: now,
    }).success).toBe(false);
  });

  it("ships an append-only workspace snapshot, active guard, no-secrets checks and bounded safe media projection", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608250016_neon_saga_series_references.sql"), "utf8");
    expect(migration).toContain("create table if not exists saga_series_references");
    expect(migration).toContain("create table if not exists saga_series_reference_revisions");
    expect(migration).toContain("saga_series_reference_revision_immutable");
    expect(migration).toContain("saga_series_reference_active_requires_snapshot");
    expect(migration).toContain("saga_series_reference_media_metadata_is_valid");
    expect(migration).toContain("content_engine_json_has_forbidden_secret_key");
    expect(migration).toContain("limit 12");
    expect(migration).not.toContain("blob_url");
    expect(migration).not.toContain("blob_pathname");
    expect(migration).not.toContain("content_hash");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });

  it("reads only the actor workspace and projects controls separately from the frozen reference", async () => {
    const { sql, query } = sqlWith([row()]);
    const [series] = await listSagaSeriesReferences(actor, sql);

    expect(series).toMatchObject({
      id: seriesId,
      active: true,
      reference: { sourceDraftId, contentType: "social_post", media: [{ kind: "generated", status: "ready" }] },
      controls,
    });
    expect(series?.reference).not.toHaveProperty("controls");
    expect(JSON.stringify(series)).not.toContain("blob_url");
    expect(query.mock.calls[0]?.[0]).toContain("series.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId]);
  });

  it("captures a server-side Studio draft and never accepts a snapshot from the browser", async () => {
    const { sql, query } = sqlWith([{ id: seriesId }], [row()]);
    const input: SagaSeriesReferenceCreateInput = {
      slug: "frigjord-tid",
      name: "Frigjord tid",
      active: true,
      referenceDraftId: sourceDraftId,
      controls,
    };
    const series = await createSagaSeriesReference(actor, input, sql);

    expect(series.id).toBe(seriesId);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("saga_series_reference_create");
    expect(query.mock.calls[0]?.[1]).toEqual([
      actor.workspaceId, actor.userId, input.slug, input.name, true, sourceDraftId, JSON.stringify(controls),
    ]);
    expect(query.mock.calls[0]?.[1]).not.toContain(row().reference_body);
  });

  it("rejects a viewer before any reference or draft query", async () => {
    const { sql, query } = sqlWith();
    await expect(createSagaSeriesReference({ ...actor, role: "viewer" }, {
      slug: "frigjord-tid",
      name: "Frigjord tid",
      active: false,
      referenceDraftId: sourceDraftId,
      controls,
    }, sql)).rejects.toBeInstanceOf(SagaSeriesReferenceAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("uses one expected revision for changes and gives AI/quality callers only safe active guidance", async () => {
    const changed = row({ revision: 2, name: "Frigjord tid, uppdaterad", updated_at: "2026-08-25T12:30:00.000Z" });
    const patchSql = sqlWith([row()], [{ id: seriesId }], [changed]);
    const updated = await patchSagaSeriesReference(actor, {
      id: seriesId,
      expectedRevision: 1,
      name: "Frigjord tid, uppdaterad",
    }, patchSql.sql);
    expect(updated.revision).toBe(2);
    expect(patchSql.query.mock.calls[1]?.[0]).toContain("saga_series_reference_update");
    expect(patchSql.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([actor.workspaceId, seriesId, actor.userId, 1]));

    const guidanceSql = sqlWith([row()]);
    const guidance = await getSagaSeriesReferenceGuidanceContext(actor, seriesId, guidanceSql.sql);
    expect(guidance).toMatchObject({ controls, reference: { sourceDraftId, media: [{ kind: "generated" }] } });
    expect(JSON.stringify(guidance)).not.toContain("blob_url");

    const inactiveSql = sqlWith([row({ active: false })]);
    await expect(getSagaSeriesReferenceGuidanceContext(actor, seriesId, inactiveSql.sql)).resolves.toBeNull();
  });

  it("keeps another brand's reference snapshot out of generation while allowing the selected brand", async () => {
    const brandProfileId = "55555555-5555-4555-8555-555555555555";
    const scopedActor = { ...actor, brandProfileId };
    const foreignReference = sqlWith([]);
    await expect(getSagaSeriesReferenceGuidanceContext(scopedActor, seriesId, foreignReference.sql)).resolves.toBeNull();
    expect(foreignReference.query).toHaveBeenCalledTimes(1);
    expect(foreignReference.query.mock.calls[0]?.[0]).toContain("source_draft.id = reference.source_draft_id");
    expect(foreignReference.query.mock.calls[0]?.[0]).toContain("source_draft.brand_profile_id = $3::uuid");
    expect(foreignReference.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, seriesId, brandProfileId]);
    const selectedReference = sqlWith([row()]);
    await expect(getSagaSeriesReferenceGuidanceContext(scopedActor, seriesId, selectedReference.sql)).resolves.toMatchObject({ reference: { sourceDraftId }, controls });
    expect(selectedReference.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, seriesId, brandProfileId]);
  });
});
