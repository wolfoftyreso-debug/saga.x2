import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  apiAccessKeyCreateSchema,
  apiAccessScopeSchema,
  hasApiAccessScope,
  type ApiAccessKeyCreateInput,
  type ApiAccessKeyView,
  type ApiAccessPrincipal,
  type ApiAccessScope,
  type CreatedApiAccessKey,
  type ExternalApiAuthenticationOptions,
} from "@/lib/domain/api-access";
import { createAdminClient } from "@/lib/supabase/admin";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

const TOKEN_NAMESPACE = "pdb_live";
const PREFIX_ID_LENGTH = 12;
const SECRET_LENGTH = 43;

type TokenMaterial = {
  plaintextKey: string;
  prefix: string;
  secretHash: string;
};

type ParsedToken = {
  plaintextKey: string;
  prefix: string;
};

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

/** Uses a random 256-bit secret; the database never receives this plaintext value. */
export function createApiAccessTokenMaterial(): TokenMaterial {
  const prefixId = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const prefix = `${TOKEN_NAMESPACE}_${prefixId}`;
  const plaintextKey = `${prefix}_${secret}`;
  return { plaintextKey, prefix, secretHash: hashApiAccessToken(plaintextKey) };
}

export function hashApiAccessToken(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey, "utf8").digest("hex");
}

export function parseApiAccessToken(value: string): ParsedToken | null {
  const plaintextKey = value.trim();
  const expression = new RegExp(`^${TOKEN_NAMESPACE}_([A-Za-z0-9_-]{${PREFIX_ID_LENGTH}})_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`);
  const match = expression.exec(plaintextKey);
  if (!match) return null;
  return { plaintextKey, prefix: `${TOKEN_NAMESPACE}_${match[1]}` };
}

export async function createApiAccessKey(
  client: DatabaseClient,
  userId: string,
  input: ApiAccessKeyCreateInput,
): Promise<CreatedApiAccessKey> {
  const payload = apiAccessKeyCreateSchema.parse(input);

  // Prefix collisions are cryptographically unlikely, but retrying makes the
  // uniqueness constraint a durable guarantee rather than a probability.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const material = createApiAccessTokenMaterial();
    const { data, error } = await client
      .from("api_access_keys")
      .insert({
        user_id: userId,
        name: payload.name,
        key_prefix: material.prefix,
        secret_hash: material.secretHash,
        scopes: payload.scopes,
      })
      .select("id, name, key_prefix, scopes, created_at, last_used_at, revoked_at")
      .single();

    if (!error && data) {
      return { key: mapApiAccessKey(data as RawRecord), plaintextKey: material.plaintextKey };
    }
    if ((error as { code?: string } | null)?.code !== "23505") {
      throw databaseError("Kunde inte skapa API-nyckeln", error);
    }
  }

  throw new Error("Kunde inte skapa en unik API-nyckel. Försök igen.");
}

export async function listApiAccessKeys(client: DatabaseClient, userId: string): Promise<ApiAccessKeyView[]> {
  const { data, error } = await client
    .from("api_access_keys")
    .select("id, name, key_prefix, scopes, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw databaseError("Kunde inte läsa API-nycklarna", error);
  return (data ?? []).map((row) => mapApiAccessKey(row as RawRecord));
}

/** Revocation is idempotent for a key owned by this user. */
export async function revokeApiAccessKey(client: DatabaseClient, userId: string, keyId: string): Promise<boolean> {
  const { data: existing, error: existingError } = await client
    .from("api_access_keys")
    .select("id, revoked_at")
    .eq("id", keyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw databaseError("Kunde inte hitta API-nyckeln", existingError);
  if (!existing) return false;
  if ((existing as RawRecord).revoked_at) return true;

  const { error } = await client
    .from("api_access_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw databaseError("Kunde inte återkalla API-nyckeln", error);
  return true;
}

/**
 * Verifies a single key without disclosing whether its prefix, hash, scope or
 * revocation status was the failing condition. Successful use is only granted
 * after a conditional last-used write confirms the key has not been revoked.
 */
export async function verifyApiAccessToken(
  client: DatabaseClient,
  plaintextKey: string,
  requiredScope: ApiAccessScope,
): Promise<ApiAccessPrincipal | null> {
  const parsed = parseApiAccessToken(plaintextKey);
  if (!parsed) return null;

  try {
    const { data, error } = await client
      .from("api_access_keys")
      .select("id, user_id, secret_hash, scopes, revoked_at")
      .eq("key_prefix", parsed.prefix)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as RawRecord;
    const storedHash = typeof row.secret_hash === "string" ? row.secret_hash : "";
    const scopes = parseScopes(row.scopes);
    if (row.revoked_at || !storedHash || !constantTimeHashMatches(storedHash, hashApiAccessToken(parsed.plaintextKey))) return null;
    if (!hasApiAccessScope(scopes, requiredScope)) return null;
    if (typeof row.id !== "string" || typeof row.user_id !== "string") return null;

    const { data: touched, error: touchError } = await client
      .from("api_access_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (touchError || !touched) return null;

    return { userId: row.user_id, keyId: row.id, scopes };
  } catch {
    // Authentication failures are deliberately indistinguishable to callers.
    return null;
  }
}

/** Extracts Bearer/X-API-Key credentials and, only when requested, `?token=`. */
export function readExternalApiToken(request: Request, allowQueryToken = false): string | null {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const headerKey = request.headers.get("x-api-key")?.trim();
  if (headerKey) return headerKey;

  if (!allowQueryToken) return null;
  try {
    return new URL(request.url).searchParams.get("token")?.trim() || null;
  } catch {
    return null;
  }
}

/** Route handlers use this: it never throws or includes a raw key in an error. */
export async function authenticateExternalApiRequest(
  request: Request,
  options: ExternalApiAuthenticationOptions,
): Promise<ApiAccessPrincipal | null> {
  const plaintextKey = readExternalApiToken(request, options.allowQueryToken ?? false);
  if (!plaintextKey) return null;
  try {
    return await verifyApiAccessToken(createAdminClient(), plaintextKey, options.requiredScope);
  } catch {
    // A missing database configuration or transient setup problem must never
    // turn a credential check into an open endpoint or reveal server details.
    return null;
  }
}

function mapApiAccessKey(row: RawRecord): ApiAccessKeyView {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.key_prefix),
    scopes: parseScopes(row.scopes),
    createdAt: String(row.created_at),
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : null,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
  };
}

function parseScopes(value: unknown): ApiAccessScope[] {
  const parsed = zScopeList.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const zScopeList = apiAccessScopeSchema.array();

function constantTimeHashMatches(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
