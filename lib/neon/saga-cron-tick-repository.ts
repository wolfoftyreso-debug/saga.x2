import "server-only";

import { randomUUID } from "node:crypto";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

const MAIN_TICK_KEY = "saga-main";
const DEFAULT_LEASE_SECONDS = 75;
const MIN_LEASE_SECONDS = 65;
const MAX_LEASE_SECONDS = 120;

export const SAGA_CRON_TICK_OUTCOMES = [
  "idle",
  "completed",
  "completed_with_failures",
  "time_budget_reached",
  "scheduler_unavailable",
] as const;

export type SagaCronTickOutcome = typeof SAGA_CRON_TICK_OUTCOMES[number];

export type SagaCronTickLease = {
  claimToken: string;
  leaseExpiresAt: string;
  startedAt: string;
};

/**
 * The durable record intentionally accepts only aggregate primitive values.
 * It is an operational heartbeat, not an event log and must never become an
 * accidental store for prompts, source data, draft IDs, or failure diagnostics.
 */
export type SagaCronTickSummary = Record<string, boolean | number | string | null>;

type LeaseRow = {
  lease_token: string;
  lease_expires_at: string;
  last_started_at: string;
};

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

/**
 * Claims the process-wide main cron lease atomically. A `null` result means a
 * healthy invocation still owns it; it is not a database or worker failure.
 */
export async function claimSagaCronTickLease(
  input: { leaseSeconds?: number; claimToken?: string } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaCronTickLease | null> {
  const leaseSeconds = boundedInteger(input.leaseSeconds, DEFAULT_LEASE_SECONDS, MIN_LEASE_SECONDS, MAX_LEASE_SECONDS);
  const claimToken = input.claimToken ?? randomUUID();
  const rows = await sql.query(
    `insert into saga_cron_tick_leases (
       lease_key, lease_token, lease_expires_at, last_started_at
     ) values (
       $1, $2::uuid, now() + ($3::int * interval '1 second'), now()
     )
     on conflict (lease_key) do update
       set lease_token = excluded.lease_token,
           lease_expires_at = excluded.lease_expires_at,
           last_started_at = excluded.last_started_at
     where saga_cron_tick_leases.lease_expires_at <= now()
     returning lease_token::text, lease_expires_at::text, last_started_at::text`,
    [MAIN_TICK_KEY, claimToken, leaseSeconds],
  ) as unknown as LeaseRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    claimToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.last_started_at,
  };
}

/**
 * Finishes only the invocation that still owns the live lease. If it returns
 * false, a newer invocation reclaimed the row or this caller ran past its
 * deadline; stale callers must not overwrite newer operational telemetry.
 */
export async function completeSagaCronTickLease(
  lease: Pick<SagaCronTickLease, "claimToken">,
  input: {
    outcome: SagaCronTickOutcome;
    durationMs: number;
    summary: SagaCronTickSummary;
  },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const durationMs = boundedInteger(input.durationMs, 0, 0, 120_000);
  const rows = await sql.query(
    `update saga_cron_tick_leases
        set lease_expires_at = now(),
            last_completed_at = now(),
            last_outcome = $3,
            last_duration_ms = $4::int,
            last_summary = $5::jsonb
      where lease_key = $1
        and lease_token = $2::uuid
        and lease_expires_at > now()
      returning lease_key`,
    [MAIN_TICK_KEY, lease.claimToken, input.outcome, durationMs, JSON.stringify(input.summary)],
  ) as unknown as Array<{ lease_key: string }>;
  return Boolean(rows[0]);
}
