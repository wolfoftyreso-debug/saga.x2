import "server-only";

const postgresProtocols = new Set(["postgres:", "postgresql:"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MissingNeonConfigurationError extends Error {
  constructor() {
    super("Neon är inte konfigurerat. Lägg till DATABASE_URL i Vercel.");
    this.name = "MissingNeonConfigurationError";
  }
}

export class InvalidNeonConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNeonConfigurationError";
  }
}

/** Returns variable names only; no database credentials are ever exposed. */
export function missingNeonConfiguration(): string[] {
  return process.env.DATABASE_URL?.trim() ? [] : ["DATABASE_URL"];
}

export function getNeonDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new MissingNeonConfigurationError();

  try {
    const parsed = new URL(databaseUrl);
    if (!postgresProtocols.has(parsed.protocol)) {
      throw new InvalidNeonConfigurationError("DATABASE_URL måste vara en PostgreSQL-anslutningssträng.");
    }
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
      throw new InvalidNeonConfigurationError("DATABASE_URL måste innehålla både databasvärd och databasnamn.");
    }
    if (parsed.searchParams.get("sslmode") === "disable") {
      throw new InvalidNeonConfigurationError("DATABASE_URL får inte stänga av TLS.");
    }
  } catch (error) {
    if (error instanceof InvalidNeonConfigurationError) throw error;
    throw new InvalidNeonConfigurationError("DATABASE_URL måste vara en giltig PostgreSQL-anslutningssträng.");
  }

  return databaseUrl;
}

export function isNeonDatabaseConfigured(): boolean {
  try {
    getNeonDatabaseUrl();
    return true;
  } catch {
    return false;
  }
}

export function getNeonDatabaseConfigurationState(): "configured" | "missing" | "invalid" {
  if (missingNeonConfiguration().length > 0) return "missing";
  return isNeonDatabaseConfigured() ? "configured" : "invalid";
}

/**
 * Validates an application workspace UUID without accepting request input as
 * authorization. The production fallback is a deployment configuration, not
 * a replacement for a future verified user session.
 */
export function assertNeonWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!uuidPattern.test(workspaceId)) {
    throw new InvalidNeonConfigurationError("Ett arbetsyte-id måste vara ett giltigt UUID.");
  }
  return workspaceId;
}

/**
 * Optional Vercel deployment-level workspace used while the product runs as
 * one protected workspace. It is deliberately not request authentication or
 * cross-workspace authorization.
 */
export function getSingleWorkspaceFallbackId(): string | null {
  const workspaceId = process.env.VERCEL_WORKSPACE_ID?.trim();
  return workspaceId ? assertNeonWorkspaceId(workspaceId) : null;
}
