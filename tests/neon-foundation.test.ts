import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as healthCheck } from "@/app/api/health/route";
import {
  InvalidNeonConfigurationError,
  MissingNeonConfigurationError,
  getNeonDatabaseUrl,
  getSingleWorkspaceFallbackId,
  isNeonDatabaseConfigured,
  missingNeonConfiguration,
} from "@/lib/neon/config";
import type { NeonSql } from "@/lib/neon/database";
import { readStudioBootstrap } from "@/lib/neon/studio-repository";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalWorkspaceId = process.env.VERCEL_WORKSPACE_ID;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalWorkspaceId === undefined) delete process.env.VERCEL_WORKSPACE_ID;
  else process.env.VERCEL_WORKSPACE_ID = originalWorkspaceId;
});

function bootstrapSql(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue(rows);
  return { sql: { query } as unknown as NeonSql, query };
}

describe.sequential("Neon foundation", () => {
  it("keeps database configuration server-only and validates the deployment workspace fallback", () => {
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL_WORKSPACE_ID;
    expect(missingNeonConfiguration()).toEqual(["DATABASE_URL"]);
    expect(isNeonDatabaseConfigured()).toBe(false);
    expect(() => getNeonDatabaseUrl()).toThrow(MissingNeonConfigurationError);
    expect(getSingleWorkspaceFallbackId()).toBeNull();

    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    process.env.VERCEL_WORKSPACE_ID = workspaceId;
    expect(getNeonDatabaseUrl()).toContain("ep-example.neon.tech");
    expect(isNeonDatabaseConfigured()).toBe(true);
    expect(getSingleWorkspaceFallbackId()).toBe(workspaceId);

    process.env.VERCEL_WORKSPACE_ID = "not-a-uuid";
    expect(() => getSingleWorkspaceFallbackId()).toThrow(InvalidNeonConfigurationError);

    process.env.DATABASE_URL = "postgresql://user@host/?sslmode=disable";
    expect(() => getNeonDatabaseUrl()).toThrow(InvalidNeonConfigurationError);
  });

  it("returns an honest first-run state from the health probe", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL_WORKSPACE_ID;
    await expect(readStudioBootstrap()).resolves.toEqual({ status: "database_not_configured" });

    const response = await healthCheck();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "configuration_required",
      missing: ["DATABASE_URL"],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a parameterized workspace-scoped bootstrap query", async () => {
    const { sql, query } = bootstrapSql([{
      workspace_id: workspaceId,
      workspace_name: "Redaktionen",
      timezone: "Europe/Stockholm",
      member_count: 2,
      draft_count: 9,
      review_count: 3,
      scheduled_count: 2,
      active_automation_count: 4,
      pending_job_count: 1,
      media_count: 7,
      checked_at: "2026-08-23 12:00:00+00",
    }]);

    await expect(readStudioBootstrap({ sql, trustedWorkspaceId: workspaceId })).resolves.toEqual({
      status: "ready",
      checkedAt: "2026-08-23 12:00:00+00",
      workspace: { id: workspaceId, name: "Redaktionen", timezone: "Europe/Stockholm" },
      counts: {
        members: 2,
        drafts: 9,
        waitingForReview: 3,
        scheduled: 2,
        activeAutomations: 4,
        pendingJobs: 1,
        media: 7,
      },
    });

    const [queryText, params] = query.mock.calls[0] ?? [];
    expect(queryText).toContain("where w.id = $1::uuid");
    expect(queryText).not.toContain(workspaceId);
    expect(params).toEqual([workspaceId]);
  });

  it("distinguishes an empty database from a configured workspace", async () => {
    const { sql } = bootstrapSql([]);
    await expect(readStudioBootstrap({ sql, trustedWorkspaceId: workspaceId })).resolves.toEqual({
      status: "workspace_not_found",
      workspaceId,
    });
  });

  it("ships the app-owned Neon schema without coupling it to Supabase", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/202608230001_neon_studio_core.sql"), "utf8");
    expect(sql).toContain("create table if not exists app_workspaces");
    expect(sql).toContain("vercel_subject text not null unique");
    expect(sql).toContain("create table if not exists app_sessions");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).toContain("create table if not exists studio_drafts");
    expect(sql).toContain("automation_job_id uuid");
    expect(sql).toContain("create table if not exists studio_templates");
    expect(sql).toContain("create table if not exists studio_automations");
    expect(sql).toContain("create table if not exists studio_jobs");
    expect(sql).toContain("claim_token uuid");
    expect(sql).toContain("create table if not exists studio_media");
    expect(sql).toContain("storage_provider text not null default 'vercel_blob'");
    expect(sql).toContain("studio_templates_workspace_slug_idx");
    expect(sql.toLowerCase()).not.toContain("supabase");
  });
});
