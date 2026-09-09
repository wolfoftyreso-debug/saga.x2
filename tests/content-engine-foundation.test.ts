import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  contentEngineDestinationInputSchema,
  contentEngineModelPresetInputSchema,
  contentEngineSourceInputSchema,
} from "@/lib/domain/content-engine";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  ContentEngineAccessError,
  ContentEngineReferenceError,
  getContentEngineRecipe,
  getContentEngineRecipeLabModelPlan,
  getContentEngineRecipeLabSources,
  readContentEngineWorkspace,
  saveContentEngineDestination,
  saveContentEngineModelPolicy,
  saveContentEngineRecipe,
} from "@/lib/neon/content-engine-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const brandId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const presetId = "55555555-5555-4555-8555-555555555555";
const policyId = "66666666-6666-4666-8666-666666666666";
const recipeId = "77777777-7777-4777-8777-777777777777";
const destinationId = "88888888-8888-4888-8888-888888888888";
const ruleId = "99999999-9999-4999-8999-999999999999";
const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const audienceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-08-24T08:00:00.000Z";

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

const brandRow = {
  id: brandId,
  created_by_user_id: actor.userId,
  slug: "min-verkstad",
  name: "Min verkstad",
  organization_name: "Min verkstad AB",
  summary: "Bilservice i Borås.",
  default_language: "sv",
  voice: {},
  profile_config: {},
  active: true,
  is_default: true,
  created_at: now,
  updated_at: now,
};
const sourceRow = {
  id: sourceId,
  created_by_user_id: actor.userId,
  slug: "verkstadsbloggen",
  name: "Verkstadsbloggen",
  source_kind: "website",
  source_url: "https://example.com/blogg",
  reference_text: "",
  description: "Tillåten branschkälla.",
  trust_level: 4,
  tags: ["bil"],
  source_config: {},
  is_allowed: true,
  active: true,
  created_at: now,
  updated_at: now,
};
const presetRow = {
  id: presetId,
  created_by_user_id: actor.userId,
  slug: "claude-skriv",
  name: "Claude skriv",
  provider: "anthropic",
  model_id: "anthropic/claude-sonnet",
  task_kinds: ["writing"],
  gateway_settings: { temperature: 0.4 },
  enabled: true,
  created_at: now,
  updated_at: now,
};
const policyRow = {
  id: policyId,
  created_by_user_id: actor.userId,
  slug: "skriv-kvalitet",
  name: "Skriv kvalitet",
  task_kind: "writing",
  selection_mode: "quality_first",
  policy_config: {},
  steps: [{ presetId, priority: 1, enabled: true }],
  active: true,
  is_default: true,
  created_at: now,
  updated_at: now,
};
const recipeRow = {
  id: recipeId,
  created_by_user_id: actor.userId,
  slug: "veckobrev",
  name: "Veckobrev",
  description: "Veckans serviceerbjudande.",
  content_type: "newsletter",
  brand_profile_id: brandId,
  model_policy_id: policyId,
  instructions: "Skriv rakt och vänligt.",
  rendering_config: {},
  source_ids: [sourceId],
  active: true,
  created_at: now,
  updated_at: now,
};
const destinationRow = {
  id: destinationId,
  created_by_user_id: actor.userId,
  slug: "linkedin",
  name: "LinkedIn",
  destination_kind: "social",
  social_connection_id: connectionId,
  newsletter_audience_id: null,
  destination_config: {},
  active: true,
  created_at: now,
  updated_at: now,
};
const ruleRow = {
  id: ruleId,
  created_by_user_id: actor.userId,
  slug: "veckobrev-linkedin",
  name: "Veckobrev till LinkedIn",
  recipe_id: recipeId,
  destination_id: destinationId,
  delivery_mode: "manual",
  schedule_config: {},
  approval_required: true,
  active: true,
  created_at: now,
  updated_at: now,
};

describe("Vercel/Neon Content Engine foundation", () => {
  it("ships workspace-scoped configuration tables and an explicit no-secrets DB boundary", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608240006_neon_content_engine.sql"), "utf8");

    for (const table of [
      "content_engine_brand_profiles",
      "content_engine_sources",
      "content_engine_model_presets",
      "content_engine_model_policies",
      "content_engine_recipes",
      "content_engine_destinations",
      "content_engine_distribution_rules",
    ]) {
      expect(migration).toContain(`create table if not exists ${table}`);
    }
    expect(migration).toContain("content_engine_replace_recipe_sources");
    expect(migration).toContain("content_engine_replace_model_policy_steps");
    expect(migration).toContain("content_engine_json_has_forbidden_secret_key");
    expect(migration).toContain("content_engine_validate_destination_reference");
    expect(migration).toContain("last_verified_at is not null");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });

  it("rejects accidental credentials and source URLs with embedded login details before Neon", () => {
    expect(contentEngineSourceInputSchema.safeParse({
      slug: "hemlig-kalla",
      name: "Hemlig källa",
      sourceKind: "manual",
      referenceText: "Underlag",
      sourceConfig: { apiKey: "should-never-be-stored" },
    }).success).toBe(false);

    expect(contentEngineSourceInputSchema.safeParse({
      slug: "fel-url",
      name: "Fel URL",
      sourceKind: "website",
      sourceUrl: "https://user:password@example.com/feed",
    }).success).toBe(false);

    expect(contentEngineDestinationInputSchema.safeParse({
      slug: "nyhetsbrev",
      name: "Nyhetsbrev",
      destinationKind: "newsletter",
      destinationConfig: { bearerToken: "nope" },
    }).success).toBe(false);

    expect(contentEngineSourceInputSchema.safeParse({
      slug: "oauth-kalla",
      name: "OAuth-källa",
      sourceKind: "manual",
      referenceText: "Underlag",
      sourceConfig: { oauthToken: "should-never-be-stored", nested: { id_token: "nope" } },
    }).success).toBe(false);
  });

  it("accepts only provider-qualified AI Gateway models and safe destination routes", () => {
    const modelBase = {
      slug: "skrivmodell",
      name: "Skrivmodell",
      taskKinds: ["writing"],
      gatewaySettings: {},
      enabled: true,
    };
    expect(contentEngineModelPresetInputSchema.safeParse({ ...modelBase, provider: "openai", modelId: "anthropic/claude-sonnet" }).success).toBe(false);
    expect(contentEngineModelPresetInputSchema.safeParse({ ...modelBase, provider: "other", modelId: "openai/gpt-5" }).success).toBe(false);
    expect(contentEngineModelPresetInputSchema.safeParse({ ...modelBase, provider: "other", modelId: "mistral/large" }).success).toBe(true);

    const destinationBase = {
      slug: "webbplats",
      name: "Webbplats",
      destinationKind: "website",
      socialConnectionId: null,
      newsletterAudienceId: null,
      active: true,
    };
    expect(contentEngineDestinationInputSchema.safeParse({ ...destinationBase, destinationConfig: { route: "//evil.example/publish" } }).success).toBe(false);
    expect(contentEngineDestinationInputSchema.safeParse({ ...destinationBase, destinationConfig: { target: "/api/content/publish" } }).success).toBe(true);
  });

  it("reads every Content Engine collection through the actor workspace and returns safe picker metadata", async () => {
    const { sql, query } = sqlWith(
      [brandRow], [sourceRow], [presetRow], [policyRow], [recipeRow], [destinationRow], [ruleRow],
      [{ id: connectionId, account_label: "Min sida", provider: "linkedin", state: "active", last_verified_at: now, updated_at: now }],
      [{ id: audienceId, name: "Kunder", active: true, updated_at: now }],
    );

    const data = await readContentEngineWorkspace(actor, sql);

    expect(data).toMatchObject({
      brandProfiles: [{ id: brandId, isDefault: true }],
      recipes: [{ id: recipeId, sourceIds: [sourceId] }],
      availableDestinations: {
        socialConnections: [{ id: connectionId, label: "Min sida", connected: true }],
        newsletterAudiences: [{ id: audienceId, name: "Kunder", active: true }],
      },
      destinations: [{ id: destinationId, deliveryAvailability: "connected" }],
    });
    expect(query).toHaveBeenCalledTimes(9);
    for (const [, params] of query.mock.calls) expect(params).toEqual([actor.workspaceId]);
    expect(query.mock.calls[7]?.[0]).not.toContain("token_ciphertext");
    expect(query.mock.calls[7]?.[0]).toContain("last_verified_at is not null");
    expect(query.mock.calls[8]?.[0]).not.toContain("email");
    expect(query.mock.calls[8]?.[0]).toContain("active = true");
  });

  it("downgrades a social destination to configuration-only when its connection is no longer verified", async () => {
    const { sql } = sqlWith(
      [], [], [], [], [], [destinationRow], [],
      [], [],
    );

    const data = await readContentEngineWorkspace(actor, sql);

    expect(data.destinations).toMatchObject([{ id: destinationId, deliveryAvailability: "configuration_only" }]);
    expect(data.availableDestinations.socialConnections).toEqual([]);
  });

  it("reads an individual Content Engine recipe only through the signed actor workspace", async () => {
    const { sql, query } = sqlWith([recipeRow]);

    const recipe = await getContentEngineRecipe(actor, recipeId, sql);

    expect(recipe).toMatchObject({ id: recipeId, contentType: "newsletter", instructions: recipeRow.instructions });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("recipe.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, recipeId]);
  });

  it("passes only actor-scoped active, allowed recipe sources to the AI lab boundary", async () => {
    const { sql, query } = sqlWith([{
      source_id: sourceId,
      name: "Verkstadens FAQ",
      source_kind: "website",
      source_url: "https://example.com/faq",
      description: "Bokningsregler.",
      reference_text: "Boka i god tid.",
      trust_level: 4,
    }]);

    const sources = await getContentEngineRecipeLabSources(actor, recipeId, [], sql);

    expect(sources).toEqual([{
      sourceId,
      name: "Verkstadens FAQ",
      sourceKind: "website",
      sourceUrl: "https://example.com/faq",
      description: "Bokningsregler.",
      referenceText: "Boka i god tid.",
      trustLevel: 4,
    }]);
    expect(query.mock.calls[0]?.[0]).toContain("recipe_source.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("source.active = true");
    expect(query.mock.calls[0]?.[0]).toContain("source.is_allowed = true");
    expect(query.mock.calls[0]?.[0]).not.toContain("source_config");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, recipeId]);
  });

  it("intersects the actor-scoped recipe sources with explicit Lens IDs without widening source scope", async () => {
    const { sql, query } = sqlWith([{
      source_id: sourceId,
      name: "Verkstadens FAQ",
      source_kind: "website",
      source_url: "https://example.com/faq",
      description: "Bokningsregler.",
      reference_text: "Boka i god tid.",
      trust_level: 4,
    }]);

    const sources = await getContentEngineRecipeLabSources(actor, recipeId, [sourceId], sql);

    expect(sources).toEqual([expect.objectContaining({ sourceId, name: "Verkstadens FAQ" })]);
    expect(query.mock.calls[0]?.[0]).toContain("source.id::text as source_id");
    expect(query.mock.calls[0]?.[0]).toContain("recipe_source.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("source.workspace_id = recipe_source.workspace_id");
    expect(query.mock.calls[0]?.[0]).toContain("recipe_source.source_id = any($3::uuid[])");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, recipeId, [sourceId]]);
  });

  it("resolves a recipe-bound AI policy from the actor workspace without accepting browser model ids", async () => {
    const secondPresetId = "abababab-abab-4bab-8bab-abababababab";
    const { sql, query } = sqlWith([
      {
        policy_id: policyId,
        policy_name: "Skriv kvalitet",
        policy_task_kind: "writing",
        selection_mode: "quality_first",
        policy_active: true,
        preset_id: presetId,
        preset_name: "Claude skriv",
        provider: "anthropic",
        model_id: "anthropic/claude-sonnet",
        priority: 1,
      },
      {
        policy_id: policyId,
        policy_name: "Skriv kvalitet",
        policy_task_kind: "writing",
        selection_mode: "quality_first",
        policy_active: true,
        preset_id: secondPresetId,
        preset_name: "Gemini skriv",
        provider: "google",
        model_id: "google/gemini-editorial",
        priority: 2,
      },
    ]);

    const plan = await getContentEngineRecipeLabModelPlan(actor, recipeId, sql);

    expect(plan).toEqual({
      policyId,
      policyName: "Skriv kvalitet",
      taskKind: "writing",
      selectionMode: "quality_first",
      active: true,
      models: [
        { presetId, presetName: "Claude skriv", provider: "anthropic", modelId: "anthropic/claude-sonnet", priority: 1 },
        { presetId: secondPresetId, presetName: "Gemini skriv", provider: "google", modelId: "google/gemini-editorial", priority: 2 },
      ],
    });
    expect(query.mock.calls[0]?.[0]).toContain("recipe.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("step.enabled = true");
    expect(query.mock.calls[0]?.[0]).toContain("preset.enabled = true");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, recipeId]);
  });

  it("bounds source material before it reaches a model prompt", async () => {
    const { sql } = sqlWith([{
      source_id: sourceId,
      name: "Lång källa",
      source_kind: "manual",
      source_url: null,
      description: "d".repeat(2_000),
      reference_text: "r".repeat(10_000),
      trust_level: 3,
    }]);

    const [source] = await getContentEngineRecipeLabSources(actor, recipeId, [], sql);

    expect(source?.description.length).toBe(1_200);
    expect(source?.referenceText.length).toBe(4_000);
  });

  it("writes a model selection policy only after validating actor-owned compatible presets", async () => {
    const { sql, query } = sqlWith([{ id: presetId, task_kinds: ["writing"] }], [policyRow]);

    const policy = await saveContentEngineModelPolicy(actor, {
      slug: "skriv-kvalitet",
      name: "Skriv kvalitet",
      taskKind: "writing",
      selectionMode: "quality_first",
      policyConfig: {},
      steps: [{ presetId, priority: 1, enabled: true }],
      active: true,
      isDefault: true,
    }, sql);

    expect(policy.id).toBe(policyId);
    expect(query.mock.calls[0]?.[0]).toContain("workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, [presetId]]);
    expect(query.mock.calls[1]?.[0]).toContain("content_engine_replace_model_policy_steps");
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(actor.workspaceId);
  });

  it("saves a recipe with sources through the database-side atomic replacement function", async () => {
    const { sql, query } = sqlWith([recipeRow]);

    const recipe = await saveContentEngineRecipe(actor, {
      slug: "veckobrev",
      name: "Veckobrev",
      description: "Veckans serviceerbjudande.",
      contentType: "newsletter",
      brandProfileId: null,
      modelPolicyId: null,
      instructions: "Skriv rakt och vänligt.",
      renderingConfig: {},
      sourceIds: [sourceId],
      active: true,
    }, sql);

    expect(recipe).toMatchObject({ id: recipeId, sourceIds: [sourceId] });
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("content_engine_replace_recipe_sources");
    expect(params?.[0]).toBe(actor.workspaceId);
    expect(JSON.parse(params?.[11] as string)).toEqual([sourceId]);
  });

  it("does not let a viewer write, and proves destination references before saving", async () => {
    const { sql, query } = sqlWith();
    await expect(saveContentEngineDestination({ ...actor, role: "viewer" }, {
      slug: "linkedin",
      name: "LinkedIn",
      destinationKind: "social",
      socialConnectionId: null,
      newsletterAudienceId: null,
      destinationConfig: {},
      active: true,
    }, sql)).rejects.toBeInstanceOf(ContentEngineAccessError);
    expect(query).not.toHaveBeenCalled();

    const scoped = sqlWith([]);
    await expect(saveContentEngineDestination(actor, {
      slug: "linkedin",
      name: "LinkedIn",
      destinationKind: "social",
      socialConnectionId: connectionId,
      newsletterAudienceId: null,
      destinationConfig: {},
      active: true,
    }, scoped.sql)).rejects.toBeInstanceOf(ContentEngineReferenceError);
    expect(scoped.query).toHaveBeenCalledTimes(1);
    expect(scoped.query.mock.calls[0]?.[0]).toContain("state = 'active'");
    expect(scoped.query.mock.calls[0]?.[0]).toContain("last_verified_at is not null");
    expect(scoped.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, connectionId]);
  });
});
