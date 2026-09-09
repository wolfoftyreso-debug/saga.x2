import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sagaEditorialLensInputSchema } from "@/lib/domain/saga-editorial-lens";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  getSagaEditorialLens,
  getSagaEditorialLensLabContext,
  getSagaEditorialLensPromptContext,
  SagaEditorialLensAccessError,
  SagaEditorialLensReferenceError,
  upsertSagaEditorialLens,
} from "@/lib/neon/saga-editorial-lens-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  brandProfileId: "44444444-4444-4444-8444-444444444444",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const lensId = "33333333-3333-4333-8333-333333333333";
const brandId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const now = "2026-08-24T08:00:00.000Z";

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

const lensRow = {
  id: lensId,
  created_by_user_id: actor.userId,
  updated_by_user_id: actor.userId,
  brand_profile_id: brandId,
  name: "SAGA Editorial Lens",
  mission: "Gör bilservice begriplig.",
  strategic_perspective: "Bygg förtroende före räckvidd.",
  industry: "Bilservice",
  audience: "Bilägare i Borås.",
  themes: ["Trygg service"],
  forbidden_themes: ["Partipolitik"],
  tone_config: {},
  construction_config: {},
  evidence_threshold: "one_primary_or_two_independent",
  source_rules: {},
  source_selections: [{ sourceId, role: "required", priority: 1 }],
  control_mode: "review_required",
  active: true,
  created_at: now,
  updated_at: now,
};

const validInput = {
  brandProfileId: brandId,
  name: "SAGA Editorial Lens",
  mission: "Gör bilservice begriplig.",
  strategicPerspective: "Bygg förtroende före räckvidd.",
  industry: "Bilservice",
  audience: "Bilägare i Borås.",
  themes: ["Trygg service"],
  forbiddenThemes: ["Partipolitik"],
  tone: {},
  construction: {},
  evidenceThreshold: "one_primary_or_two_independent" as const,
  sourceRules: {},
  sourceSelections: [{ sourceId, role: "required" as const, priority: 1 }],
  controlMode: "review_required" as const,
  active: true,
};

describe("SAGA Editorial Lens foundation", () => {
  it("ships one tenant-scoped doctrine and only scoped Content Engine references", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608240007_neon_saga_editorial_lens.sql"), "utf8");

    expect(migration).toContain("create table if not exists saga_editorial_lenses");
    expect(migration).toContain("create table if not exists saga_editorial_lens_sources");
    expect(migration).toContain("unique (workspace_id)");
    expect(migration).toContain("references content_engine_brand_profiles(workspace_id, id)");
    expect(migration).toContain("references content_engine_sources(workspace_id, id)");
    expect(migration).toContain("saga_editorial_lens_replace_sources");
    expect(migration).toContain("content_engine_json_has_forbidden_secret_key");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });

  it("accepts a typed doctrine but rejects conflicting themes, unsafe config, and unsupported strict controls", () => {
    expect(sagaEditorialLensInputSchema.safeParse(validInput).success).toBe(true);

    expect(sagaEditorialLensInputSchema.safeParse({
      ...validInput,
      forbiddenThemes: ["TRYGG SERVICE"],
    }).success).toBe(false);

    expect(sagaEditorialLensInputSchema.safeParse({
      ...validInput,
      sourceRules: { apiKey: "must-not-persist" },
    }).success).toBe(false);

    expect(sagaEditorialLensInputSchema.safeParse({
      ...validInput,
      controlMode: "strict",
      sourceRules: { requireAllowedSources: false, requireCitations: true },
    }).success).toBe(false);

    expect(sagaEditorialLensInputSchema.safeParse({
      ...validInput,
      sourceSelections: [
        { sourceId, role: "required", priority: 1 },
        { sourceId: "66666666-6666-4666-8666-666666666666", role: "preferred", priority: 1 },
      ],
    }).success).toBe(false);
  });

  it("reads the Lens only through the signed actor workspace and exposes a safe prompt context", async () => {
    const { sql, query } = sqlWith([lensRow]);

    const lens = await getSagaEditorialLens(actor, sql);

    expect(lens).toMatchObject({ id: lensId, brandProfileId: brandId, sourceSelections: [{ sourceId }] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("where lens.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, brandId]);
    expect(query.mock.calls[0]?.[0]).toContain("lens.brand_profile_id = $2::uuid");

    const promptResult = sqlWith([lensRow]);
    const prompt = await getSagaEditorialLensPromptContext(actor, promptResult.sql);
    expect(prompt).toMatchObject({ mission: lensRow.mission, controlMode: "review_required" });
    expect(prompt).not.toHaveProperty("id");
    expect(prompt).not.toHaveProperty("sourceSelections");

    const labContextResult = sqlWith([lensRow]);
    const labContext = await getSagaEditorialLensLabContext(actor, labContextResult.sql);
    expect(labContext).toEqual(expect.objectContaining({
      prompt: expect.objectContaining({ mission: lensRow.mission }),
      sourceSelectionIds: [sourceId],
    }));
    expect(labContext?.prompt).not.toHaveProperty("sourceSelections");
  });

  it("writes the singleton doctrine and selected sources atomically after proving the brand scope", async () => {
    const { sql, query } = sqlWith([{ id: brandId }], [{ id: lensId }], [lensRow]);

    const lens = await upsertSagaEditorialLens(actor, validInput, sql);

    expect(lens).toMatchObject({ id: lensId, brandProfileId: brandId });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain("content_engine_brand_profiles");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, brandId]);
    const [statement, params] = query.mock.calls[1] ?? [];
    expect(statement).toContain("saga_upsert_brand_editorial_lens");
    expect(params?.[0]).toBe(actor.workspaceId);
    expect(params?.[1]).toBe(actor.userId);
    expect(JSON.parse(params?.[3] as string).sourceSelections).toEqual(validInput.sourceSelections);
  });

  it("does not write a foreign brand or permit a viewer to mutate the workspace Lens", async () => {
    const missingBrand = sqlWith([]);
    await expect(upsertSagaEditorialLens(actor, validInput, missingBrand.sql)).rejects.toBeInstanceOf(SagaEditorialLensReferenceError);
    expect(missingBrand.query).toHaveBeenCalledTimes(1);

    const viewer = sqlWith();
    await expect(upsertSagaEditorialLens({ ...actor, role: "viewer" }, validInput, viewer.sql)).rejects.toBeInstanceOf(SagaEditorialLensAccessError);
    expect(viewer.query).not.toHaveBeenCalled();
  });
});
