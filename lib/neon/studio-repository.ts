import "server-only";
import { assertNeonWorkspaceId, getSingleWorkspaceFallbackId, isNeonDatabaseConfigured } from "@/lib/neon/config";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type StudioBootstrapRow = {
  workspace_id: string;
  workspace_name: string;
  timezone: string;
  member_count: number | string;
  draft_count: number | string;
  review_count: number | string;
  scheduled_count: number | string;
  active_automation_count: number | string;
  pending_job_count: number | string;
  media_count: number | string;
  checked_at: string;
};

export type StudioBootstrap = {
  status: "ready";
  checkedAt: string;
  workspace: {
    id: string;
    name: string;
    timezone: string;
  };
  counts: {
    members: number;
    drafts: number;
    waitingForReview: number;
    scheduled: number;
    activeAutomations: number;
    pendingJobs: number;
    media: number;
  };
};

export type StudioBootstrapRead =
  | StudioBootstrap
  | { status: "database_not_configured" }
  | { status: "workspace_not_configured" }
  | { status: "workspace_not_found"; workspaceId: string };

export type ReadStudioBootstrapOptions = {
  /** A query function can be supplied by a server-side integration or a test. */
  sql?: NeonSql;
  /**
   * Must originate from a future verified server session. This repository does
   * not treat an arbitrary request value as permission to access a workspace.
   */
  trustedWorkspaceId?: string | null;
};

export type NeonDatabaseHealth =
  | { status: "ready"; checkedAt: string }
  | { status: "database_not_configured" };

type HealthRow = { checked_at: string };

function count(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A light, secret-free liveness read for a public deployment probe. */
export async function readNeonDatabaseHealth(sql?: NeonSql): Promise<NeonDatabaseHealth> {
  if (!sql && !isNeonDatabaseConfigured()) return { status: "database_not_configured" };
  const rows = await (sql ?? createNeonSql()).query("select now()::text as checked_at") as unknown as HealthRow[];
  return { status: "ready", checkedAt: rows[0]?.checked_at ?? new Date().toISOString() };
}

/**
 * A one-query, read-only readiness snapshot for the Studio shell. When no
 * trusted session integration exists yet it may use VERCEL_WORKSPACE_ID as a
 * single deployment-level fallback. No tokens, sessions, or user secrets are
 * returned from this read.
 */
export async function readStudioBootstrap(
  options: ReadStudioBootstrapOptions = {},
): Promise<StudioBootstrapRead> {
  if (!options.sql && !isNeonDatabaseConfigured()) {
    return { status: "database_not_configured" };
  }

  const trustedWorkspaceId = options.trustedWorkspaceId?.trim();
  const workspaceId = trustedWorkspaceId
    ? assertNeonWorkspaceId(trustedWorkspaceId)
    : getSingleWorkspaceFallbackId();
  if (!workspaceId) return { status: "workspace_not_configured" };

  const sql = options.sql ?? createNeonSql();
  const rows = await sql.query(
    `select
       w.id::text as workspace_id,
       w.name as workspace_name,
       w.timezone,
       (select count(*)::int from app_workspace_memberships membership where membership.workspace_id = w.id) as member_count,
       (select count(*)::int from studio_drafts draft where draft.workspace_id = w.id) as draft_count,
       (select count(*)::int from studio_drafts draft where draft.workspace_id = w.id and draft.status = 'in_review') as review_count,
       (select count(*)::int from studio_drafts draft where draft.workspace_id = w.id and draft.status = 'scheduled') as scheduled_count,
       (select count(*)::int from studio_automations automation where automation.workspace_id = w.id and automation.enabled = true) as active_automation_count,
       (select count(*)::int from studio_jobs job where job.workspace_id = w.id and job.status in ('queued', 'running')) as pending_job_count,
       (select count(*)::int from studio_media media where media.workspace_id = w.id) as media_count,
       now()::text as checked_at
     from app_workspaces w
     where w.id = $1::uuid`,
    [workspaceId],
  ) as unknown as StudioBootstrapRow[];

  const row = rows[0];
  if (!row) return { status: "workspace_not_found", workspaceId };

  return {
    status: "ready",
    checkedAt: row.checked_at,
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      timezone: row.timezone,
    },
    counts: {
      members: count(row.member_count),
      drafts: count(row.draft_count),
      waitingForReview: count(row.review_count),
      scheduled: count(row.scheduled_count),
      activeAutomations: count(row.active_automation_count),
      pendingJobs: count(row.pending_job_count),
      media: count(row.media_count),
    },
  };
}
