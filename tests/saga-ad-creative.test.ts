import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  SAGA_AD_CREATIVE_PRESETS,
  materializeSagaAdCreativeVariant,
  sagaAdCreativeGeometrySchema,
  sagaAdCreativeProjectCreateSchema,
  sagaAdCreativeProjectUpdateSchema,
  type SagaAdCreativeProjectCreateInput,
} from "@/lib/domain/saga-ad-creative";
import {
  createSagaAdCreativeProject,
  SagaAdCreativeProjectAccessError,
} from "@/lib/neon/saga-ad-creative-project-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.test",
  displayName: "Owner",
};

const projectId = "33333333-3333-4333-8333-333333333333";
const createKey = "44444444-4444-4444-8444-444444444444";
const variantId = "55555555-5555-4555-8555-555555555555";

function input(): SagaAdCreativeProjectCreateInput {
  return {
    name: "Automatisera det repetitiva",
    createIdempotencyKey: createKey,
    masterBrief: {
      objective: "awareness",
      audience: "Människor som bygger verksamheter",
      message: "System ska frigöra tid för mänskligt omdöme.",
      callToAction: "Utforska vad som går att förenkla.",
      sourceReference: "Intern kreativ riktning",
    },
    variants: [{
      id: variantId,
      label: "Meta flöde · kvadrat",
      status: "private_draft",
      format: { kind: "preset", presetId: "meta_feed_square_v1" },
      copy: { headline: "Automatisera det repetitiva", primaryText: "Behåll det mänskliga.", description: "", callToAction: "Läs mer", destinationUrl: null, legalText: "" },
      assetDirection: "Dokumentär naturbild, lågmäld och inte överperfekt.",
    }],
  };
}

function row() {
  const parsed = sagaAdCreativeProjectCreateSchema.parse(input());
  return {
    id: projectId,
    name: parsed.name,
    master_brief: parsed.masterBrief,
    variants: parsed.variants.map(materializeSagaAdCreativeVariant),
    revision: 1,
    created_at: "2026-08-26T09:00:00.000Z",
    updated_at: "2026-08-26T09:00:00.000Z",
  };
}

describe("SAGA Ad Creative format contract", () => {
  it("provides the requested media families without pretending they are delivery presets", () => {
    const ids = SAGA_AD_CREATIVE_PRESETS.map((preset) => preset.id);
    expect(ids).toEqual(expect.arrayContaining([
      "meta_reels_stories_9x16_v1",
      "linkedin_single_image_landscape_v1",
      "google_display_300x250_v1",
      "google_responsive_search_text_v1",
      "direct_mail_a6_v1",
      "newspaper_provider_spec_v1",
      "poster_a3_v1",
    ]));
    expect(SAGA_AD_CREATIVE_PRESETS.every((preset) => preset.note.length > 0)).toBe(true);
  });

  it("materializes a server-owned immutable preset snapshot with delivery unavailable", () => {
    const variant = materializeSagaAdCreativeVariant(sagaAdCreativeProjectCreateSchema.parse(input()).variants[0]!);
    expect(variant.format).toMatchObject({
      kind: "preset",
      presetId: "meta_feed_square_v1",
      externalDelivery: "unavailable",
      planningOnly: true,
    });
    expect(JSON.stringify(variant)).not.toMatch(/accountId|budget|publishAt|blobUrl/);
  });

  it("requires DPI for custom physical production and current revision for a canvas update", () => {
    expect(sagaAdCreativeGeometrySchema.safeParse({
      width: 210, height: 297, unit: "mm", dpi: null,
      bleed: { top: 3, right: 3, bottom: 3, left: 3 },
      safeZone: { top: 5, right: 5, bottom: 5, left: 5 },
    }).success).toBe(false);
    expect(sagaAdCreativeProjectUpdateSchema.safeParse({ name: "Nytt namn" }).success).toBe(false);
  });
});

describe("SAGA Ad Creative Neon repository", () => {
  it("denies a workspace viewer before any project data is touched", async () => {
    const query = vi.fn();
    await expect(createSagaAdCreativeProject({ ...actor, role: "viewer" }, input(), { query } as unknown as NeonSql)).rejects.toBeInstanceOf(SagaAdCreativeProjectAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("creates the full revisioned document under workspace/user ownership", async () => {
    const query = vi.fn().mockResolvedValueOnce([row()]);
    const created = await createSagaAdCreativeProject(actor, input(), { query } as unknown as NeonSql);
    expect(created).toMatchObject({ reused: false, project: { id: projectId, revision: 1, name: input().name } });
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("insert into saga_ad_creative_projects");
    expect(params?.slice(0, 3)).toEqual([actor.workspaceId, actor.userId, createKey]);
    expect(JSON.stringify(params)).not.toMatch(/accountId|budget|publishAt|blobUrl/);
  });

  it("documents one project revision boundary rather than a delivery or provider table", () => {
    const migration = readFileSync("db/migrations/202608260021_neon_saga_ad_creative_projects.sql", "utf8");
    const schema = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(migration).toContain("unique (workspace_id, create_idempotency_key)");
    expect(migration).toContain("revision integer not null default 1");
    expect(schema).not.toMatch(/provider_token|access_token|budget|publish_receipt|blob_url/i);
  });
});
