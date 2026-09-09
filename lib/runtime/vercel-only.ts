/**
 * Runtime-level migration fence.
 *
 * This module is intentionally free of `server-only` and Node APIs so it can
 * run from Next's Proxy as well as ordinary Node route handlers.  A Vercel
 * deployment must never quietly revive the retired Supabase store when its
 * Neon connection has a temporary setup problem.
 */

export type RuntimeEnvironment = Record<string, string | undefined>;

export type NeonConnectionState = "configured" | "missing" | "invalid";

const postgresProtocols = new Set(["postgres:", "postgresql:"]);

const legacySupabaseApiPrefixes = [
  "/api/access-keys",
  "/api/audio/brief",
  "/api/brief-definitions",
  "/api/brief-source-policies",
  "/api/briefs",
  "/api/chat",
  "/api/cron/media-engine",
  "/api/feedback",
  "/api/media-engine",
  "/api/profile-context",
  "/api/settings",
  "/api/sources",
  "/api/v1",
  "/api/watches",
] as const;

const neonBackedApiPrefixes = ["/api/ad-automations", "/api/content", "/api/content-engine", "/api/newsletter", "/api/social", "/api/saga"] as const;

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "1" || value?.trim().toLowerCase() === "true";
}

function isPathOrChild(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * `VERCEL=1` is present in Vercel Functions.  `VERCEL_ONLY=1` provides the
 * same fail-closed behavior during local/preview migration checks.
 */
export function isVercelOnlyMode(environment: RuntimeEnvironment = process.env): boolean {
  return enabled(environment.VERCEL) || enabled(environment.VERCEL_ONLY);
}

/** Validates only connection shape; it never opens a database connection. */
export function getNeonConnectionState(environment: RuntimeEnvironment = process.env): NeonConnectionState {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) return "missing";

  try {
    const parsed = new URL(databaseUrl);
    if (!postgresProtocols.has(parsed.protocol)) return "invalid";
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") return "invalid";
    if (parsed.searchParams.get("sslmode") === "disable") return "invalid";
    return "configured";
  } catch {
    return "invalid";
  }
}

/** API routes that are still backed exclusively by the retired store. */
export function isLegacySupabaseApiPath(pathname: string): boolean {
  return legacySupabaseApiPrefixes.some((prefix) => isPathOrChild(pathname, prefix));
}

/** API routes whose Vercel implementation requires a valid Neon URL. */
export function isNeonBackedApiPath(pathname: string): boolean {
  return neonBackedApiPrefixes.some((prefix) => isPathOrChild(pathname, prefix));
}

export class VercelOnlySupabaseDisabledError extends Error {
  constructor() {
    super("Supabase är avstängt i Vercel-läget. Anslut Neon i Vercel i stället.");
    this.name = "VercelOnlySupabaseDisabledError";
  }
}

/**
 * Last-line defense for direct Route Handler calls, tests, and any future
 * route accidentally omitted from the Proxy prefix list.
 */
export function assertSupabaseAllowed(environment: RuntimeEnvironment = process.env): void {
  if (isVercelOnlyMode(environment)) throw new VercelOnlySupabaseDisabledError();
}
