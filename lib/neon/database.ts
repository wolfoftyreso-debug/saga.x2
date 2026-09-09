import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { getNeonDatabaseUrl } from "@/lib/neon/config";
import { executionAbortSignal } from "@/lib/server/execution-deadline";

/**
 * The Neon HTTP query function is safe to create per server execution. It
 * uses parameterized queries and does not hold a WebSocket or pooled session
 * between Vercel invocations.
 */
export type NeonSql = NeonQueryFunction<false, false>;

export function createNeonSql(databaseUrl = getNeonDatabaseUrl()): NeonSql {
  const signal = executionAbortSignal();
  return neon(databaseUrl, signal ? { fetchOptions: { signal } } : undefined);
}
