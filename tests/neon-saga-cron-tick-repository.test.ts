import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NeonSql } from "@/lib/neon/database";
import {
  claimSagaCronTickLease,
  completeSagaCronTickLease,
} from "@/lib/neon/saga-cron-tick-repository";

const firstToken = "11111111-1111-4111-8111-111111111111";
const secondToken = "22222222-2222-4222-8222-222222222222";

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

describe("durable SAGA cron tick lease", () => {
  it("uses a single atomic row to exclude a live tick and reclaim only an expired one", async () => {
    const { sql, query } = sqlWith(
      [{
        lease_token: firstToken,
        lease_expires_at: "2026-08-28T09:01:15.000Z",
        last_started_at: "2026-08-28T09:00:00.000Z",
      }],
      [],
      [{
        lease_token: secondToken,
        lease_expires_at: "2026-08-28T09:02:30.000Z",
        last_started_at: "2026-08-28T09:01:15.000Z",
      }],
    );

    const first = await claimSagaCronTickLease({ claimToken: firstToken, leaseSeconds: 75 }, sql);
    const overlap = await claimSagaCronTickLease({ claimToken: secondToken, leaseSeconds: 75 }, sql);
    const reclaimed = await claimSagaCronTickLease({ claimToken: secondToken, leaseSeconds: 75 }, sql);

    expect(first).toMatchObject({ claimToken: firstToken });
    expect(overlap).toBeNull();
    expect(reclaimed).toMatchObject({ claimToken: secondToken });
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain("on conflict (lease_key) do update");
    expect(statement).toContain("lease_expires_at <= now()");
    expect(statement).toContain("lease_token = excluded.lease_token");
    expect(parameters).toEqual(["saga-main", firstToken, 75]);
  });

  it("bounds the lease to outlive the 60-second route without accepting an unbounded timeout", async () => {
    const { sql, query } = sqlWith([], []);

    await claimSagaCronTickLease({ claimToken: firstToken, leaseSeconds: 1 }, sql);
    await claimSagaCronTickLease({ claimToken: secondToken, leaseSeconds: 999 }, sql);

    expect(query.mock.calls[0]?.[1]).toEqual(["saga-main", firstToken, 65]);
    expect(query.mock.calls[1]?.[1]).toEqual(["saga-main", secondToken, 120]);
  });

  it("writes completion telemetry only through the current token fence", async () => {
    const { sql, query } = sqlWith([{ lease_key: "saga-main" }], []);
    const lease = { claimToken: firstToken, leaseExpiresAt: "2026-08-28T09:01:15.000Z", startedAt: "2026-08-28T09:00:00.000Z" };

    const completed = await completeSagaCronTickLease(lease, {
      outcome: "time_budget_reached",
      durationMs: 52_000,
      summary: { workPerformed: true, timeBudgetReached: true, studioJobsClaimed: 1 },
    }, sql);
    const stale = await completeSagaCronTickLease(lease, {
      outcome: "completed",
      durationMs: 1,
      summary: { workPerformed: false },
    }, sql);

    expect(completed).toBe(true);
    expect(stale).toBe(false);
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain("lease_token = $2::uuid");
    expect(statement).toContain("lease_expires_at > now()");
    expect(statement).toContain("last_summary = $5::jsonb");
    expect(parameters?.[0]).toBe("saga-main");
    expect(parameters?.[1]).toBe(firstToken);
    expect(parameters?.[2]).toBe("time_budget_reached");
    expect(JSON.parse(parameters?.[4] as string)).toEqual({ workPerformed: true, timeBudgetReached: true, studioJobsClaimed: 1 });
  });

  it("ships a one-row Neon lease rather than a session-only advisory lock", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608280027_neon_saga_cron_tick_lease.sql"), "utf8");
    expect(migration).toContain("create table if not exists saga_cron_tick_leases");
    expect(migration).toContain("lease_key text primary key check (lease_key = 'saga-main')");
    expect(migration).toContain("last_duration_ms");
    expect(migration).toContain("last_summary jsonb");
    expect(migration).not.toContain("pg_advisory_lock");
  });
});
