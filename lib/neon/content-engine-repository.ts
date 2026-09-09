import "server-only";

import {
  contentEngineBrandProfileInputSchema,
  contentEngineBrandProfileSchema,
  contentEngineDestinationInputSchema,
  contentEngineDestinationSchema,
  contentEngineDistributionRuleInputSchema,
  contentEngineDistributionRuleSchema,
  contentEngineModelPolicyInputSchema,
  contentEngineModelPolicySchema,
  contentEngineModelPresetInputSchema,
  contentEngineModelPresetSchema,
  contentEngineRecipeInputSchema,
  contentEngineRecipeSchema,
  contentEngineSourceInputSchema,
  contentEngineSourceSchema,
  type ContentEngineBrandProfile,
  type ContentEngineBrandProfileInput,
  type ContentEngineDeleteRequest,
  type ContentEngineDestination,
  type ContentEngineDestinationInput,
  type ContentEngineDistributionRule,
  type ContentEngineDistributionRuleInput,
  type ContentEngineEntity,
  type ContentEngineModelPolicy,
  type ContentEngineModelPolicyInput,
  type ContentEngineModelPreset,
  type ContentEngineModelPresetInput,
  type ContentEngineMutationRequest,
  type ContentEnginePatchRequest,
  type ContentEngineRecipe,
  type ContentEngineRecipeInput,
  type ContentEngineNewsletterAudienceOption,
  type ContentEngineSocialConnectionOption,
  type ContentEngineSource,
  type ContentEngineSourceInput,
  type EngineWorkspaceData,
} from "@/lib/domain/content-engine";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type JsonObject = Record<string, unknown>;

type BaseRow = {
  id: string;
  created_by_user_id: string;
  slug: string;
  name: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type BrandProfileRow = BaseRow & {
  organization_name: string;
  summary: string;
  default_language: string;
  voice: unknown;
  profile_config: unknown;
  active: boolean;
  is_default: boolean;
};

type SourceRow = BaseRow & {
  source_kind: string;
  source_url: string | null;
  reference_text: string;
  description: string;
  trust_level: number | string;
  tags: unknown;
  source_config: unknown;
  is_allowed: boolean;
  active: boolean;
};

type ModelPresetRow = BaseRow & {
  provider: string;
  model_id: string;
  task_kinds: unknown;
  gateway_settings: unknown;
  enabled: boolean;
};

type ModelPolicyRow = BaseRow & {
  task_kind: string;
  selection_mode: string;
  policy_config: unknown;
  steps: unknown;
  active: boolean;
  is_default: boolean;
};

type RecipeRow = BaseRow & {
  description: string;
  content_type: string;
  brand_profile_id: string | null;
  model_policy_id: string | null;
  instructions: string;
  rendering_config: unknown;
  source_ids: unknown;
  active: boolean;
};

type DestinationRow = BaseRow & {
  destination_kind: string;
  social_connection_id: string | null;
  newsletter_audience_id: string | null;
  destination_config: unknown;
  active: boolean;
};

type DistributionRuleRow = BaseRow & {
  recipe_id: string;
  destination_id: string;
  delivery_mode: string;
  schedule_config: unknown;
  approval_required: boolean;
  active: boolean;
};

type SocialConnectionOptionRow = {
  id: string;
  account_label: string;
  provider: string;
  state: string;
  last_verified_at: string | Date | null;
  updated_at: string | Date;
};

type NewsletterAudienceOptionRow = {
  id: string;
  name: string;
  active: boolean;
  updated_at: string | Date;
};

type LabSourceRow = {
  source_id: string;
  name: string;
  source_kind: string;
  source_url: string | null;
  reference_text: string;
  description: string;
  trust_level: number | string;
};

/**
 * A recipe can bind an ordered AI Gateway policy. This intentionally exposes
 * only a model identity and a display name: credentials and model settings
 * stay server-side and never become part of a browser request.
 */
type LabModelPlanRow = {
  policy_id: string;
  policy_name: string;
  policy_task_kind: string;
  selection_mode: string;
  policy_active: boolean;
  preset_id: string | null;
  preset_name: string | null;
  provider: string | null;
  model_id: string | null;
  priority: number | string | null;
};

export type ContentEngineLabSource = {
  /** Server-only identity used to intersect a recipe with a Lens selection. */
  sourceId: string;
  name: string;
  sourceKind: string;
  sourceUrl: string | null;
  description: string;
  referenceText: string;
  trustLevel: number;
};

export type ContentEngineLabModelPlan = {
  policyId: string;
  policyName: string;
  taskKind: string;
  selectionMode: string;
  active: boolean;
  models: Array<{
    presetId: string;
    presetName: string;
    provider: string;
    modelId: string;
    priority: number;
  }>;
};

export type ContentEngineEntityValue =
  | ContentEngineBrandProfile
  | ContentEngineSource
  | ContentEngineModelPreset
  | ContentEngineModelPolicy
  | ContentEngineRecipe
  | ContentEngineDestination
  | ContentEngineDistributionRule;

export class ContentEngineAccessError extends Error {
  constructor() {
    super("Du har bara läsrättighet i den här arbetsytan.");
    this.name = "ContentEngineAccessError";
  }
}

export class ContentEngineNotFoundError extends Error {
  constructor(entity = "Resurs") {
    super(`${entity} hittades inte i den här arbetsytan.`);
    this.name = "ContentEngineNotFoundError";
  }
}

export class ContentEngineReferenceError extends Error {
  constructor(message = "En vald referens hör inte till den här arbetsytan eller är inte tillgänglig.") {
    super(message);
    this.name = "ContentEngineReferenceError";
  }
}

export class ContentEngineConflictError extends Error {
  constructor(message = "En annan resurs i arbetsytan använder redan detta namn eller denna adress.") {
    super(message);
    this.name = "ContentEngineConflictError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new ContentEngineAccessError();
}

function uuid(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new ContentEngineNotFoundError();
  }
  return normalized;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : stringValue(value);
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function mapBrandProfile(row: BrandProfileRow): ContentEngineBrandProfile {
  return contentEngineBrandProfileSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    organizationName: row.organization_name,
    summary: row.summary,
    defaultLanguage: row.default_language,
    voice: jsonObject(row.voice),
    profileConfig: jsonObject(row.profile_config),
    active: bool(row.active, true),
    isDefault: bool(row.is_default),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapSource(row: SourceRow): ContentEngineSource {
  return contentEngineSourceSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    sourceKind: row.source_kind,
    sourceUrl: stringOrNull(row.source_url),
    referenceText: row.reference_text,
    description: row.description,
    trustLevel: integer(row.trust_level, 3),
    tags: stringArray(row.tags),
    sourceConfig: jsonObject(row.source_config),
    isAllowed: bool(row.is_allowed, true),
    active: bool(row.active, true),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapModelPreset(row: ModelPresetRow): ContentEngineModelPreset {
  return contentEngineModelPresetSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    provider: row.provider,
    modelId: row.model_id,
    taskKinds: stringArray(row.task_kinds),
    gatewaySettings: jsonObject(row.gateway_settings),
    enabled: bool(row.enabled, true),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapModelPolicy(row: ModelPolicyRow): ContentEngineModelPolicy {
  return contentEngineModelPolicySchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    taskKind: row.task_kind,
    selectionMode: row.selection_mode,
    policyConfig: jsonObject(row.policy_config),
    steps: jsonArray(row.steps),
    active: bool(row.active, true),
    isDefault: bool(row.is_default),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapRecipe(row: RecipeRow): ContentEngineRecipe {
  return contentEngineRecipeSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    contentType: row.content_type,
    brandProfileId: stringOrNull(row.brand_profile_id),
    modelPolicyId: stringOrNull(row.model_policy_id),
    instructions: row.instructions,
    renderingConfig: jsonObject(row.rendering_config),
    sourceIds: stringArray(row.source_ids),
    active: bool(row.active, true),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapDestination(row: DestinationRow, verifiedSocialConnectionIds: ReadonlySet<string> = new Set()): ContentEngineDestination {
  return contentEngineDestinationSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    destinationKind: row.destination_kind,
    socialConnectionId: stringOrNull(row.social_connection_id),
    newsletterAudienceId: stringOrNull(row.newsletter_audience_id),
    destinationConfig: jsonObject(row.destination_config),
    active: bool(row.active, true),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    // RSS/website are stored as future adapter configuration, while the
    // current Vercel product has no direct publisher for them. Newsletter
    // delivery likewise remains provider-gated outside this configuration UI.
    // A social destination is only connected while its current, actor-safe
    // account record remains active and verified.
    deliveryAvailability: row.destination_kind === "social" && row.social_connection_id && verifiedSocialConnectionIds.has(row.social_connection_id)
      ? "connected"
      : "configuration_only",
  });
}

function mapDistributionRule(row: DistributionRuleRow): ContentEngineDistributionRule {
  return contentEngineDistributionRuleSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    slug: row.slug,
    name: row.name,
    recipeId: row.recipe_id,
    destinationId: row.destination_id,
    deliveryMode: row.delivery_mode,
    scheduleConfig: jsonObject(row.schedule_config),
    approvalRequired: bool(row.approval_required, true),
    active: bool(row.active, true),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapSocialConnectionOption(row: SocialConnectionOptionRow): ContentEngineSocialConnectionOption {
  return {
    id: row.id,
    label: row.account_label,
    provider: row.provider,
    state: row.state === "needs_reauth" || row.state === "disconnected" || row.state === "error" ? row.state : "active",
    connected: row.state === "active",
    updatedAt: timestamp(row.updated_at),
  };
}

function mapNewsletterAudienceOption(row: NewsletterAudienceOptionRow): ContentEngineNewsletterAudienceOption {
  return {
    id: row.id,
    name: row.name,
    active: bool(row.active, true),
    updatedAt: timestamp(row.updated_at),
  };
}

const brandFields = `id::text, created_by_user_id::text, slug, name, organization_name,
  summary, default_language, voice, profile_config, active, is_default,
  created_at::text, updated_at::text`;
const sourceFields = `id::text, created_by_user_id::text, slug, name, source_kind,
  source_url, reference_text, description, trust_level, tags, source_config,
  is_allowed, active, created_at::text, updated_at::text`;
const modelPresetFields = `id::text, created_by_user_id::text, slug, name, provider,
  model_id, task_kinds, gateway_settings, enabled, created_at::text, updated_at::text`;
const destinationFields = `id::text, created_by_user_id::text, slug, name, destination_kind,
  social_connection_id::text, newsletter_audience_id::text, destination_config,
  active, created_at::text, updated_at::text`;
const ruleFields = `id::text, created_by_user_id::text, slug, name, recipe_id::text,
  destination_id::text, delivery_mode, schedule_config, approval_required, active,
  created_at::text, updated_at::text`;

const modelPolicySelect = `select policy.id::text, policy.created_by_user_id::text,
  policy.slug, policy.name, policy.task_kind, policy.selection_mode,
  policy.policy_config, policy.active, policy.is_default,
  coalesce(
    jsonb_agg(jsonb_build_object(
      'presetId', step.preset_id::text,
      'priority', step.priority,
      'enabled', step.enabled
    ) order by step.priority) filter (where step.preset_id is not null),
    '[]'::jsonb
  ) as steps,
  policy.created_at::text, policy.updated_at::text
from content_engine_model_policies policy
left join content_engine_model_policy_steps step
  on step.workspace_id = policy.workspace_id and step.policy_id = policy.id`;

const recipeSelect = `select recipe.id::text, recipe.created_by_user_id::text,
  recipe.slug, recipe.name, recipe.description, recipe.content_type,
  recipe.brand_profile_id::text, recipe.model_policy_id::text, recipe.instructions,
  recipe.rendering_config, recipe.active,
  coalesce(jsonb_agg(recipe_source.source_id::text order by recipe_source.priority)
    filter (where recipe_source.source_id is not null), '[]'::jsonb) as source_ids,
  recipe.created_at::text, recipe.updated_at::text
from content_engine_recipes recipe
left join content_engine_recipe_sources recipe_source
  on recipe_source.workspace_id = recipe.workspace_id and recipe_source.recipe_id = recipe.id`;

function modelPolicyGroupBy(alias = "policy"): string {
  return `group by ${alias}.id, ${alias}.created_by_user_id, ${alias}.slug, ${alias}.name,
    ${alias}.task_kind, ${alias}.selection_mode, ${alias}.policy_config, ${alias}.active,
    ${alias}.is_default, ${alias}.created_at, ${alias}.updated_at`;
}

function recipeGroupBy(alias = "recipe"): string {
  return `group by ${alias}.id, ${alias}.created_by_user_id, ${alias}.slug, ${alias}.name,
    ${alias}.description, ${alias}.content_type, ${alias}.brand_profile_id,
    ${alias}.model_policy_id, ${alias}.instructions, ${alias}.rendering_config,
    ${alias}.active, ${alias}.created_at, ${alias}.updated_at`;
}

/** Returns a complete, workspace-scoped engine configuration for the editor UI. */
export async function readContentEngineWorkspace(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<EngineWorkspaceData> {
  const [brandRows, sourceRows, presetRows, policyRows, recipeRows, destinationRows, ruleRows, socialConnectionRows, newsletterAudienceRows] = await Promise.all([
    sql.query(`select ${brandFields} from content_engine_brand_profiles where workspace_id = $1::uuid order by is_default desc, lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<BrandProfileRow[]>,
    sql.query(`select ${sourceFields} from content_engine_sources where workspace_id = $1::uuid order by is_allowed desc, lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<SourceRow[]>,
    sql.query(`select ${modelPresetFields} from content_engine_model_presets where workspace_id = $1::uuid order by enabled desc, lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<ModelPresetRow[]>,
    sql.query(`${modelPolicySelect} where policy.workspace_id = $1::uuid ${modelPolicyGroupBy()} order by policy.task_kind, policy.is_default desc, lower(policy.name), policy.created_at`, [actor.workspaceId]) as unknown as Promise<ModelPolicyRow[]>,
    sql.query(`${recipeSelect} where recipe.workspace_id = $1::uuid ${recipeGroupBy()} order by recipe.active desc, lower(recipe.name), recipe.created_at`, [actor.workspaceId]) as unknown as Promise<RecipeRow[]>,
    sql.query(`select ${destinationFields} from content_engine_destinations where workspace_id = $1::uuid order by active desc, lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<DestinationRow[]>,
    sql.query(`select ${ruleFields} from content_engine_distribution_rules where workspace_id = $1::uuid order by active desc, lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<DistributionRuleRow[]>,
    sql.query(`select id::text, account_label, provider, state, last_verified_at::text, updated_at::text
      from social_connections
      where workspace_id = $1::uuid
        and state = 'active'
        and last_verified_at is not null
      order by updated_at desc`, [actor.workspaceId]) as unknown as Promise<SocialConnectionOptionRow[]>,
    sql.query(`select id::text, name, active, updated_at::text
      from newsletter_audiences
      where workspace_id = $1::uuid
        and active = true
      order by lower(name), created_at`, [actor.workspaceId]) as unknown as Promise<NewsletterAudienceOptionRow[]>,
  ]);

  const verifiedSocialConnectionIds = new Set(
    socialConnectionRows
      .filter((row) => row.state === "active" && Boolean(row.last_verified_at))
      .map((row) => row.id),
  );

  return {
    brandProfiles: brandRows.map(mapBrandProfile),
    sources: sourceRows.map(mapSource),
    modelPresets: presetRows.map(mapModelPreset),
    modelPolicies: policyRows.map(mapModelPolicy),
    recipes: recipeRows.map(mapRecipe),
    destinations: destinationRows.map((row) => mapDestination(row, verifiedSocialConnectionIds)),
    distributionRules: ruleRows.map(mapDistributionRule),
    availableDestinations: {
      socialConnections: socialConnectionRows.map(mapSocialConnectionOption),
      newsletterAudiences: newsletterAudienceRows.map(mapNewsletterAudienceOption),
    },
  };
}

/**
 * Reads one Content Engine recipe within the signed actor's workspace. This
 * is intentionally separate from the aggregate read so AI lab callers can
 * never turn a browser-supplied recipe ID into a cross-workspace lookup.
 */
export async function getContentEngineRecipe(
  actor: AppActor,
  recipeId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentEngineRecipe | null> {
  const validatedId = uuid(recipeId);
  const rows = await sql.query(
    `${recipeSelect}
      where recipe.workspace_id = $1::uuid and recipe.id = $2::uuid
      ${recipeGroupBy()}`,
    [actor.workspaceId, validatedId],
  ) as unknown as RecipeRow[];
  return rows[0] ? mapRecipe(rows[0]) : null;
}

/**
 * Resolves the server-owned model plan bound to a recipe. The browser never
 * sends model IDs: it can at most ask to run a saved recipe, and this lookup
 * keeps the policy, presets and workspace boundary together.
 *
 * A plan may deliberately contain no runnable models (for example when an
 * editor has paused all policy steps). The caller must surface that as a
 * configuration issue instead of silently falling back to unrelated models.
 */
export async function getContentEngineRecipeLabModelPlan(
  actor: AppActor,
  recipeId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentEngineLabModelPlan | null> {
  const validatedId = uuid(recipeId);
  const rows = await sql.query(
    `select policy.id::text as policy_id,
            policy.name as policy_name,
            policy.task_kind as policy_task_kind,
            policy.selection_mode,
            policy.active as policy_active,
            step.preset_id::text as preset_id,
            preset.name as preset_name,
            preset.provider,
            preset.model_id,
            step.priority
       from content_engine_recipes recipe
       join content_engine_model_policies policy
         on policy.workspace_id = recipe.workspace_id and policy.id = recipe.model_policy_id
       left join content_engine_model_policy_steps step
         on step.workspace_id = policy.workspace_id
        and step.policy_id = policy.id
        and step.enabled = true
       left join content_engine_model_presets preset
         on preset.workspace_id = step.workspace_id
        and preset.id = step.preset_id
        and preset.enabled = true
        and 'writing' = any(preset.task_kinds)
      where recipe.workspace_id = $1::uuid
        and recipe.id = $2::uuid
      order by step.priority nulls last
      limit 20`,
    [actor.workspaceId, validatedId],
  ) as unknown as LabModelPlanRow[];

  const first = rows[0];
  if (!first) return null;

  return {
    policyId: first.policy_id,
    policyName: first.policy_name,
    taskKind: first.policy_task_kind,
    selectionMode: first.selection_mode,
    active: bool(first.policy_active),
    models: rows.flatMap((row) => {
      if (!row.preset_id || !row.preset_name || !row.provider || !row.model_id || row.priority === null) return [];
      return [{
        presetId: row.preset_id,
        presetName: row.preset_name,
        provider: row.provider,
        modelId: row.model_id,
        priority: integer(row.priority),
      }];
    }),
  };
}

/**
 * Returns only the selected recipe's allowed, active source material. It does
 * not fetch URLs and deliberately omits source configuration/secrets.
 */
export async function getContentEngineRecipeLabSources(
  actor: AppActor,
  recipeId: string,
  /** Empty means the recipe's own allowed source list remains authoritative. */
  selectedSourceIds: readonly string[] = [],
  sql: NeonSql = createNeonSql(),
): Promise<ContentEngineLabSource[]> {
  const validatedId = uuid(recipeId);
  const lensSourceIds = Array.from(new Set(selectedSourceIds.map(uuid)));
  const lensScope = lensSourceIds.length
    ? "and recipe_source.source_id = any($3::uuid[])"
    : "";
  const rows = await sql.query(
    `select source.id::text as source_id, source.name, source.source_kind, source.source_url, source.reference_text,
            source.description, source.trust_level
       from content_engine_recipe_sources recipe_source
       join content_engine_sources source
         on source.workspace_id = recipe_source.workspace_id and source.id = recipe_source.source_id
       join content_engine_recipes recipe
         on recipe.workspace_id = recipe_source.workspace_id and recipe.id = recipe_source.recipe_id
      where recipe_source.workspace_id = $1::uuid
        and recipe_source.recipe_id = $2::uuid
         and recipe.active = true
         and source.active = true
         and source.is_allowed = true
         ${lensScope}
       order by recipe_source.priority, source.created_at
       limit 50`,
    lensSourceIds.length
      ? [actor.workspaceId, validatedId, lensSourceIds]
      : [actor.workspaceId, validatedId],
  ) as unknown as LabSourceRow[];
  return boundLabSources(rows);
}

const MAX_LAB_SOURCE_CONTEXT_CHARS = 32_000;
const MAX_LAB_SOURCE_TEXT_CHARS = 4_000;
const MAX_LAB_SOURCE_DESCRIPTION_CHARS = 1_200;

function boundLabSources(rows: LabSourceRow[]): ContentEngineLabSource[] {
  let remaining = MAX_LAB_SOURCE_CONTEXT_CHARS;
  const sources: ContentEngineLabSource[] = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const name = stringValue(row.name).slice(0, 240);
    const sourceKind = stringValue(row.source_kind).slice(0, 80);
    const sourceUrl = stringOrNull(row.source_url)?.slice(0, 2_000) ?? null;
    remaining -= name.length + sourceKind.length + (sourceUrl?.length ?? 0);
    if (remaining <= 0) break;
    const description = stringValue(row.description).slice(0, Math.min(MAX_LAB_SOURCE_DESCRIPTION_CHARS, remaining));
    remaining -= description.length;
    const referenceText = stringValue(row.reference_text).slice(0, Math.min(MAX_LAB_SOURCE_TEXT_CHARS, remaining));
    remaining -= referenceText.length;
    if (!name && !sourceUrl && !description && !referenceText) continue;
    sources.push({
      sourceId: row.source_id,
      name,
      sourceKind,
      sourceUrl,
      description,
      referenceText,
      trustLevel: integer(row.trust_level, 3),
    });
  }
  return sources;
}

async function assertScopedReference(
  sql: NeonSql,
  actor: AppActor,
  table: "content_engine_brand_profiles" | "content_engine_model_policies" | "content_engine_recipes" | "content_engine_destinations",
  id: string | null,
): Promise<void> {
  if (!id) return;
  const rows = await sql.query(
    `select id::text from ${table} where workspace_id = $1::uuid and id = $2::uuid limit 1`,
    [actor.workspaceId, id],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new ContentEngineReferenceError();
}

async function assertVerifiedSocialConnection(actor: AppActor, connectionId: string | null, sql: NeonSql): Promise<void> {
  if (!connectionId) return;
  const rows = await sql.query(
    `select id::text
       from social_connections
      where workspace_id = $1::uuid
        and id = $2::uuid
        and state = 'active'
        and last_verified_at is not null
      limit 1`,
    [actor.workspaceId, connectionId],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new ContentEngineReferenceError("Den sociala destinationen behöver ett aktivt, verifierat konto i arbetsytan.");
}

async function assertActiveNewsletterAudience(actor: AppActor, audienceId: string | null, sql: NeonSql): Promise<void> {
  if (!audienceId) return;
  const rows = await sql.query(
    `select id::text
       from newsletter_audiences
      where workspace_id = $1::uuid
        and id = $2::uuid
        and active = true
      limit 1`,
    [actor.workspaceId, audienceId],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new ContentEngineReferenceError("Nyhetsbrevsdestinationen behöver en aktiv mottagarlista i arbetsytan.");
}

async function assertCompatibleModelSteps(actor: AppActor, input: ContentEngineModelPolicyInput, sql: NeonSql): Promise<void> {
  const rows = await sql.query(
    `select id::text, task_kinds
       from content_engine_model_presets
      where workspace_id = $1::uuid
        and id = any($2::uuid[])`,
    [actor.workspaceId, input.steps.map((step) => step.presetId)],
  ) as unknown as Array<{ id: string; task_kinds: unknown }>;
  if (rows.length !== input.steps.length || rows.some((row) => !stringArray(row.task_kinds).includes(input.taskKind))) {
    throw new ContentEngineReferenceError("Varje modell i policyn måste finnas i arbetsytan och stödja den valda uppgiften.");
  }
}

function relationFailure(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "23505") throw new ContentEngineConflictError();
    if (code === "23503") throw new ContentEngineReferenceError();
  }
  throw error;
}

export async function saveContentEngineBrandProfile(
  actor: AppActor,
  input: ContentEngineBrandProfileInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineBrandProfile> {
  assertCanWrite(actor);
  const value = contentEngineBrandProfileInputSchema.parse(input);
  const rows = await sql.query(
    id
      ? `update content_engine_brand_profiles set slug = $3, name = $4,
          organization_name = $5, summary = $6, default_language = $7,
          voice = $8::jsonb, profile_config = $9::jsonb, active = $10,
          is_default = $11
         where workspace_id = $1::uuid and id = $2::uuid
         returning ${brandFields}`
      : `insert into content_engine_brand_profiles (
          workspace_id, created_by_user_id, slug, name, organization_name,
          summary, default_language, voice, profile_config, active, is_default
        ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
        on conflict (workspace_id, slug) do update set
          name = excluded.name, organization_name = excluded.organization_name,
          summary = excluded.summary, default_language = excluded.default_language,
          voice = excluded.voice, profile_config = excluded.profile_config,
          active = excluded.active, is_default = excluded.is_default
        returning ${brandFields}`,
    id
      ? [actor.workspaceId, uuid(id), value.slug, value.name, value.organizationName, value.summary, value.defaultLanguage, JSON.stringify(value.voice), JSON.stringify(value.profileConfig), value.active, value.isDefault]
      : [actor.workspaceId, actor.userId, value.slug, value.name, value.organizationName, value.summary, value.defaultLanguage, JSON.stringify(value.voice), JSON.stringify(value.profileConfig), value.active, value.isDefault],
  ) as unknown as BrandProfileRow[];
  const row = rows[0];
  if (!row) throw new ContentEngineNotFoundError("Varumärkesprofilen");
  return mapBrandProfile(row);
}

export async function saveContentEngineSource(
  actor: AppActor,
  input: ContentEngineSourceInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineSource> {
  assertCanWrite(actor);
  const value = contentEngineSourceInputSchema.parse(input);
  try {
    const rows = await sql.query(
      id
        ? `update content_engine_sources set slug = $3, name = $4, source_kind = $5,
            source_url = $6, reference_text = $7, description = $8, trust_level = $9,
            tags = $10::text[], source_config = $11::jsonb, is_allowed = $12, active = $13
           where workspace_id = $1::uuid and id = $2::uuid
           returning ${sourceFields}`
        : `insert into content_engine_sources (
            workspace_id, created_by_user_id, slug, name, source_kind, source_url,
            reference_text, description, trust_level, tags, source_config, is_allowed, active
          ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12, $13)
          on conflict (workspace_id, slug) do update set
            name = excluded.name, source_kind = excluded.source_kind,
            source_url = excluded.source_url, reference_text = excluded.reference_text,
            description = excluded.description, trust_level = excluded.trust_level,
            tags = excluded.tags, source_config = excluded.source_config,
            is_allowed = excluded.is_allowed, active = excluded.active
          returning ${sourceFields}`,
      id
        ? [actor.workspaceId, uuid(id), value.slug, value.name, value.sourceKind, value.sourceUrl, value.referenceText, value.description, value.trustLevel, value.tags, JSON.stringify(value.sourceConfig), value.isAllowed, value.active]
        : [actor.workspaceId, actor.userId, value.slug, value.name, value.sourceKind, value.sourceUrl, value.referenceText, value.description, value.trustLevel, value.tags, JSON.stringify(value.sourceConfig), value.isAllowed, value.active],
    ) as unknown as SourceRow[];
    const row = rows[0];
    if (!row) throw new ContentEngineNotFoundError("Källan");
    return mapSource(row);
  } catch (error) {
    return relationFailure(error);
  }
}

export async function saveContentEngineModelPreset(
  actor: AppActor,
  input: ContentEngineModelPresetInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineModelPreset> {
  assertCanWrite(actor);
  const value = contentEngineModelPresetInputSchema.parse(input);
  const rows = await sql.query(
    id
      ? `update content_engine_model_presets set slug = $3, name = $4, provider = $5,
          model_id = $6, task_kinds = $7::text[], gateway_settings = $8::jsonb,
          enabled = $9
         where workspace_id = $1::uuid and id = $2::uuid
         returning ${modelPresetFields}`
      : `insert into content_engine_model_presets (
          workspace_id, created_by_user_id, slug, name, provider, model_id,
          task_kinds, gateway_settings, enabled
        ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8::jsonb, $9)
        on conflict (workspace_id, slug) do update set
          name = excluded.name, provider = excluded.provider, model_id = excluded.model_id,
          task_kinds = excluded.task_kinds, gateway_settings = excluded.gateway_settings,
          enabled = excluded.enabled
        returning ${modelPresetFields}`,
    id
      ? [actor.workspaceId, uuid(id), value.slug, value.name, value.provider, value.modelId, value.taskKinds, JSON.stringify(value.gatewaySettings), value.enabled]
      : [actor.workspaceId, actor.userId, value.slug, value.name, value.provider, value.modelId, value.taskKinds, JSON.stringify(value.gatewaySettings), value.enabled],
  ) as unknown as ModelPresetRow[];
  const row = rows[0];
  if (!row) throw new ContentEngineNotFoundError("Modellförvalet");
  return mapModelPreset(row);
}

async function saveModelPolicy(
  actor: AppActor,
  input: ContentEngineModelPolicyInput,
  sql: NeonSql,
  id?: string,
): Promise<ContentEngineModelPolicy> {
  assertCanWrite(actor);
  const value = contentEngineModelPolicyInputSchema.parse(input);
  await assertCompatibleModelSteps(actor, value, sql);
  const stepJson = JSON.stringify(value.steps);
  const rows = await sql.query(
    id
      ? `with policy as (
          update content_engine_model_policies set slug = $3, name = $4,
            task_kind = $5, selection_mode = $6, policy_config = $7::jsonb,
            active = $8, is_default = $9
          where workspace_id = $1::uuid and id = $2::uuid
          returning id, workspace_id
        )
        select policy_row.id::text, policy_row.created_by_user_id::text, policy_row.slug,
          policy_row.name, policy_row.task_kind, policy_row.selection_mode,
          policy_row.policy_config, policy_row.active, policy_row.is_default,
          coalesce(jsonb_agg(jsonb_build_object('presetId', step.preset_id::text, 'priority', step.priority, 'enabled', step.enabled)
            order by step.priority) filter (where step.preset_id is not null), '[]'::jsonb) as steps,
          policy_row.created_at::text, policy_row.updated_at::text
        from policy
        cross join lateral (
          select content_engine_replace_model_policy_steps(policy.workspace_id, policy.id, $10::jsonb)
        ) as ensured
        join content_engine_model_policies policy_row on policy_row.id = policy.id
        left join content_engine_model_policy_steps step on step.workspace_id = policy.workspace_id and step.policy_id = policy.id
        ${modelPolicyGroupBy("policy_row")}`
      : `with policy as (
          insert into content_engine_model_policies (
            workspace_id, created_by_user_id, slug, name, task_kind, selection_mode,
            policy_config, active, is_default
          ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9)
          on conflict (workspace_id, slug) do update set
            name = excluded.name, task_kind = excluded.task_kind,
            selection_mode = excluded.selection_mode, policy_config = excluded.policy_config,
            active = excluded.active, is_default = excluded.is_default
          returning id, workspace_id
        )
        select policy_row.id::text, policy_row.created_by_user_id::text, policy_row.slug,
          policy_row.name, policy_row.task_kind, policy_row.selection_mode,
          policy_row.policy_config, policy_row.active, policy_row.is_default,
          coalesce(jsonb_agg(jsonb_build_object('presetId', step.preset_id::text, 'priority', step.priority, 'enabled', step.enabled)
            order by step.priority) filter (where step.preset_id is not null), '[]'::jsonb) as steps,
          policy_row.created_at::text, policy_row.updated_at::text
        from policy
        cross join lateral (
          select content_engine_replace_model_policy_steps(policy.workspace_id, policy.id, $10::jsonb)
        ) as ensured
        join content_engine_model_policies policy_row on policy_row.id = policy.id
        left join content_engine_model_policy_steps step on step.workspace_id = policy.workspace_id and step.policy_id = policy.id
        ${modelPolicyGroupBy("policy_row")}`,
    id
      ? [actor.workspaceId, uuid(id), value.slug, value.name, value.taskKind, value.selectionMode, JSON.stringify(value.policyConfig), value.active, value.isDefault, stepJson]
      : [actor.workspaceId, actor.userId, value.slug, value.name, value.taskKind, value.selectionMode, JSON.stringify(value.policyConfig), value.active, value.isDefault, stepJson],
  ) as unknown as ModelPolicyRow[];
  const row = rows[0];
  if (!row) throw new ContentEngineNotFoundError("Modellpolicyn");
  return mapModelPolicy(row);
}

export async function saveContentEngineModelPolicy(
  actor: AppActor,
  input: ContentEngineModelPolicyInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineModelPolicy> {
  try {
    return await saveModelPolicy(actor, input, sql, id);
  } catch (error) {
    return relationFailure(error);
  }
}

async function saveRecipe(
  actor: AppActor,
  input: ContentEngineRecipeInput,
  sql: NeonSql,
  id?: string,
): Promise<ContentEngineRecipe> {
  assertCanWrite(actor);
  const value = contentEngineRecipeInputSchema.parse(input);
  await assertScopedReference(sql, actor, "content_engine_brand_profiles", value.brandProfileId);
  await assertScopedReference(sql, actor, "content_engine_model_policies", value.modelPolicyId);
  const sourceIdsJson = JSON.stringify(value.sourceIds);
  const rows = await sql.query(
    id
      ? `with recipe as (
          update content_engine_recipes set slug = $3, name = $4, description = $5,
            content_type = $6, brand_profile_id = $7::uuid, model_policy_id = $8::uuid,
            instructions = $9, rendering_config = $10::jsonb, active = $11
          where workspace_id = $1::uuid and id = $2::uuid
          returning id, workspace_id
        )
        select recipe_row.id::text, recipe_row.created_by_user_id::text, recipe_row.slug,
          recipe_row.name, recipe_row.description, recipe_row.content_type,
          recipe_row.brand_profile_id::text, recipe_row.model_policy_id::text,
          recipe_row.instructions, recipe_row.rendering_config, recipe_row.active,
          coalesce(jsonb_agg(recipe_source.source_id::text order by recipe_source.priority)
            filter (where recipe_source.source_id is not null), '[]'::jsonb) as source_ids,
          recipe_row.created_at::text, recipe_row.updated_at::text
        from recipe
        cross join lateral (
          select content_engine_replace_recipe_sources(recipe.workspace_id, recipe.id, $12::jsonb)
        ) as ensured
        join content_engine_recipes recipe_row on recipe_row.id = recipe.id
        left join content_engine_recipe_sources recipe_source on recipe_source.workspace_id = recipe.workspace_id and recipe_source.recipe_id = recipe.id
        ${recipeGroupBy("recipe_row")}`
      : `with recipe as (
          insert into content_engine_recipes (
            workspace_id, created_by_user_id, slug, name, description, content_type,
            brand_profile_id, model_policy_id, instructions, rendering_config, active
          ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10::jsonb, $11)
          on conflict (workspace_id, slug) do update set
            name = excluded.name, description = excluded.description,
            content_type = excluded.content_type, brand_profile_id = excluded.brand_profile_id,
            model_policy_id = excluded.model_policy_id, instructions = excluded.instructions,
            rendering_config = excluded.rendering_config, active = excluded.active
          returning id, workspace_id
        )
        select recipe_row.id::text, recipe_row.created_by_user_id::text, recipe_row.slug,
          recipe_row.name, recipe_row.description, recipe_row.content_type,
          recipe_row.brand_profile_id::text, recipe_row.model_policy_id::text,
          recipe_row.instructions, recipe_row.rendering_config, recipe_row.active,
          coalesce(jsonb_agg(recipe_source.source_id::text order by recipe_source.priority)
            filter (where recipe_source.source_id is not null), '[]'::jsonb) as source_ids,
          recipe_row.created_at::text, recipe_row.updated_at::text
        from recipe
        cross join lateral (
          select content_engine_replace_recipe_sources(recipe.workspace_id, recipe.id, $12::jsonb)
        ) as ensured
        join content_engine_recipes recipe_row on recipe_row.id = recipe.id
        left join content_engine_recipe_sources recipe_source on recipe_source.workspace_id = recipe.workspace_id and recipe_source.recipe_id = recipe.id
        ${recipeGroupBy("recipe_row")}`,
    id
      ? [actor.workspaceId, uuid(id), value.slug, value.name, value.description, value.contentType, value.brandProfileId, value.modelPolicyId, value.instructions, JSON.stringify(value.renderingConfig), value.active, sourceIdsJson]
      : [actor.workspaceId, actor.userId, value.slug, value.name, value.description, value.contentType, value.brandProfileId, value.modelPolicyId, value.instructions, JSON.stringify(value.renderingConfig), value.active, sourceIdsJson],
  ) as unknown as RecipeRow[];
  const row = rows[0];
  if (!row) throw new ContentEngineNotFoundError("Receptet");
  return mapRecipe(row);
}

export async function saveContentEngineRecipe(
  actor: AppActor,
  input: ContentEngineRecipeInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineRecipe> {
  try {
    return await saveRecipe(actor, input, sql, id);
  } catch (error) {
    return relationFailure(error);
  }
}

export async function saveContentEngineDestination(
  actor: AppActor,
  input: ContentEngineDestinationInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineDestination> {
  assertCanWrite(actor);
  const value = contentEngineDestinationInputSchema.parse(input);
  await assertVerifiedSocialConnection(actor, value.socialConnectionId, sql);
  await assertActiveNewsletterAudience(actor, value.newsletterAudienceId, sql);
  try {
    const rows = await sql.query(
      id
        ? `update content_engine_destinations set slug = $3, name = $4,
            destination_kind = $5, social_connection_id = $6::uuid,
            newsletter_audience_id = $7::uuid, destination_config = $8::jsonb,
            active = $9
           where workspace_id = $1::uuid and id = $2::uuid
           returning ${destinationFields}`
        : `insert into content_engine_destinations (
            workspace_id, created_by_user_id, slug, name, destination_kind,
            social_connection_id, newsletter_audience_id, destination_config, active
          ) values ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8::jsonb, $9)
          on conflict (workspace_id, slug) do update set
            name = excluded.name, destination_kind = excluded.destination_kind,
            social_connection_id = excluded.social_connection_id,
            newsletter_audience_id = excluded.newsletter_audience_id,
            destination_config = excluded.destination_config, active = excluded.active
          returning ${destinationFields}`,
      id
        ? [actor.workspaceId, uuid(id), value.slug, value.name, value.destinationKind, value.socialConnectionId, value.newsletterAudienceId, JSON.stringify(value.destinationConfig), value.active]
        : [actor.workspaceId, actor.userId, value.slug, value.name, value.destinationKind, value.socialConnectionId, value.newsletterAudienceId, JSON.stringify(value.destinationConfig), value.active],
    ) as unknown as DestinationRow[];
    const row = rows[0];
    if (!row) throw new ContentEngineNotFoundError("Destinationen");
    return mapDestination(row, value.socialConnectionId ? new Set([value.socialConnectionId]) : undefined);
  } catch (error) {
    return relationFailure(error);
  }
}

export async function saveContentEngineDistributionRule(
  actor: AppActor,
  input: ContentEngineDistributionRuleInput,
  sql: NeonSql = createNeonSql(),
  id?: string,
): Promise<ContentEngineDistributionRule> {
  assertCanWrite(actor);
  const value = contentEngineDistributionRuleInputSchema.parse(input);
  await assertScopedReference(sql, actor, "content_engine_recipes", value.recipeId);
  await assertScopedReference(sql, actor, "content_engine_destinations", value.destinationId);
  try {
    const rows = await sql.query(
      id
        ? `update content_engine_distribution_rules set slug = $3, name = $4,
            recipe_id = $5::uuid, destination_id = $6::uuid, delivery_mode = $7,
            schedule_config = $8::jsonb, approval_required = $9, active = $10
           where workspace_id = $1::uuid and id = $2::uuid
           returning ${ruleFields}`
        : `insert into content_engine_distribution_rules (
            workspace_id, created_by_user_id, slug, name, recipe_id, destination_id,
            delivery_mode, schedule_config, approval_required, active
          ) values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8::jsonb, $9, $10)
          on conflict (workspace_id, slug) do update set
            name = excluded.name, recipe_id = excluded.recipe_id,
            destination_id = excluded.destination_id, delivery_mode = excluded.delivery_mode,
            schedule_config = excluded.schedule_config,
            approval_required = excluded.approval_required, active = excluded.active
          returning ${ruleFields}`,
      id
        ? [actor.workspaceId, uuid(id), value.slug, value.name, value.recipeId, value.destinationId, value.deliveryMode, JSON.stringify(value.scheduleConfig), value.approvalRequired, value.active]
        : [actor.workspaceId, actor.userId, value.slug, value.name, value.recipeId, value.destinationId, value.deliveryMode, JSON.stringify(value.scheduleConfig), value.approvalRequired, value.active],
    ) as unknown as DistributionRuleRow[];
    const row = rows[0];
    if (!row) throw new ContentEngineNotFoundError("Distributionsregeln");
    return mapDistributionRule(row);
  } catch (error) {
    return relationFailure(error);
  }
}

/** Idempotent create: a workspace-local slug is the natural client retry key. */
export async function upsertContentEngineEntity(
  actor: AppActor,
  request: ContentEngineMutationRequest,
  sql: NeonSql = createNeonSql(),
): Promise<ContentEngineEntityValue> {
  switch (request.entity) {
    case "brandProfile": return saveContentEngineBrandProfile(actor, request.input, sql);
    case "source": return saveContentEngineSource(actor, request.input, sql);
    case "modelPreset": return saveContentEngineModelPreset(actor, request.input, sql);
    case "modelPolicy": return saveContentEngineModelPolicy(actor, request.input, sql);
    case "recipe": return saveContentEngineRecipe(actor, request.input, sql);
    case "destination": return saveContentEngineDestination(actor, request.input, sql);
    case "distributionRule": return saveContentEngineDistributionRule(actor, request.input, sql);
  }
}

/** Full replacement edit, scoped to a row that already belongs to the actor workspace. */
export async function patchContentEngineEntity(
  actor: AppActor,
  request: ContentEnginePatchRequest,
  sql: NeonSql = createNeonSql(),
): Promise<ContentEngineEntityValue> {
  switch (request.entity) {
    case "brandProfile": return saveContentEngineBrandProfile(actor, request.input, sql, request.id);
    case "source": return saveContentEngineSource(actor, request.input, sql, request.id);
    case "modelPreset": return saveContentEngineModelPreset(actor, request.input, sql, request.id);
    case "modelPolicy": return saveContentEngineModelPolicy(actor, request.input, sql, request.id);
    case "recipe": return saveContentEngineRecipe(actor, request.input, sql, request.id);
    case "destination": return saveContentEngineDestination(actor, request.input, sql, request.id);
    case "distributionRule": return saveContentEngineDistributionRule(actor, request.input, sql, request.id);
  }
}

const tableByEntity: Record<ContentEngineEntity, string> = {
  brandProfile: "content_engine_brand_profiles",
  source: "content_engine_sources",
  modelPreset: "content_engine_model_presets",
  modelPolicy: "content_engine_model_policies",
  recipe: "content_engine_recipes",
  destination: "content_engine_destinations",
  distributionRule: "content_engine_distribution_rules",
};

/** Deletes only one exact workspace record. Referenced records stay protected by DB FKs. */
export async function deleteContentEngineEntity(
  actor: AppActor,
  request: ContentEngineDeleteRequest,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const table = tableByEntity[request.entity];
  try {
    const rows = await sql.query(
      `delete from ${table} where workspace_id = $1::uuid and id = $2::uuid returning id::text`,
      [actor.workspaceId, uuid(request.id)],
    ) as unknown as Array<{ id: string }>;
    return Boolean(rows[0]);
  } catch (error) {
    return relationFailure(error);
  }
}
