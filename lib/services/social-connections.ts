import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  socialConnectionStateSchema,
  socialProviderSchema,
  type SocialConnectionState,
  type SocialConnectionView,
  type SocialProvider,
} from "@/lib/domain/social";
import {
  getSocialProviderConfig,
  type SocialOAuthProviderConfig,
} from "@/lib/services/social-config";
import { decryptSocialSecret, encryptSocialSecret } from "@/lib/services/social-crypto";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

export type SocialConnectionSecret = SocialConnectionView & {
  userId: string;
  tokenCiphertext: string;
  refreshTokenCiphertext: string | null;
  metadata: Record<string, unknown>;
};

type OAuthTransaction = {
  provider: SocialProvider;
  userId: string;
  /**
   * Present for the Vercel/Neon adapter.  Legacy Supabase transactions omit
   * it, so adding it keeps already-issued short-lived transactions readable.
   */
  workspaceId?: string;
  state: string;
  returnTo: string;
  createdAt: number;
};

export type OAuthTransactionCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: "/";
    maxAge: number;
  };
};

export type ResolvedSocialAccount = {
  provider: SocialProvider;
  providerAccountId: string;
  accountLabel: string;
  accountHandle: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
};

export class SocialOAuthError extends Error {
  constructor(message: string, readonly code = "oauth_failed") {
    super(message);
    this.name = "SocialOAuthError";
  }
}

export async function listSocialConnections(client: DatabaseClient, userId: string): Promise<SocialConnectionView[]> {
  const { data, error } = await client
    .from("social_connections")
    .select("id, provider, provider_account_id, account_label, account_handle, state, scopes, token_expires_at, last_verified_at, last_error, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw databaseError("Kunde inte läsa sociala kopplingar", error);
  return (data ?? []).flatMap((row) => {
    const mapped = mapSocialConnectionView(row as RawRecord);
    return mapped ? [mapped] : [];
  });
}

/** Only server-side callers may retrieve a ciphertext-bearing connection. */
export async function getSocialConnectionSecret(
  client: DatabaseClient,
  userId: string,
  connectionId: string,
): Promise<SocialConnectionSecret | null> {
  const { data, error } = await client
    .from("social_connections")
    .select("id, user_id, provider, provider_account_id, account_label, account_handle, token_ciphertext, refresh_token_ciphertext, token_expires_at, state, scopes, metadata, last_verified_at, last_error, created_at, updated_at")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa den sociala kopplingen", error);
  if (!data) return null;
  return mapSocialConnectionSecret(data as RawRecord);
}

/** Resolves the default active connection only if it is unambiguous. */
export async function getDefaultSocialConnectionSecret(
  client: DatabaseClient,
  userId: string,
  provider: SocialProvider,
): Promise<SocialConnectionSecret | null> {
  const { data, error } = await client
    .from("social_connections")
    .select("id, user_id, provider, provider_account_id, account_label, account_handle, token_ciphertext, refresh_token_ciphertext, token_expires_at, state, scopes, metadata, last_verified_at, last_error, created_at, updated_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("state", "active")
    .order("updated_at", { ascending: false })
    .limit(2);
  if (error) throw databaseError("Kunde inte läsa den sociala kopplingen", error);
  if ((data ?? []).length !== 1) return null;
  return mapSocialConnectionSecret((data ?? [])[0] as RawRecord);
}

export async function upsertSocialConnection(
  client: DatabaseClient,
  userId: string,
  account: ResolvedSocialAccount,
): Promise<SocialConnectionView> {
  const { data, error } = await client
    .from("social_connections")
    .upsert({
      user_id: userId,
      provider: account.provider,
      provider_account_id: account.providerAccountId,
      account_label: account.accountLabel,
      account_handle: account.accountHandle,
      token_ciphertext: encryptSocialSecret(account.accessToken),
      refresh_token_ciphertext: account.refreshToken ? encryptSocialSecret(account.refreshToken) : null,
      token_expires_at: account.tokenExpiresAt,
      scopes: account.scopes,
      metadata: account.metadata,
      state: "active",
      last_verified_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: "user_id,provider,provider_account_id" })
    .select("id, provider, provider_account_id, account_label, account_handle, state, scopes, token_expires_at, last_verified_at, last_error, created_at, updated_at")
    .single();
  if (error || !data) throw databaseError("Kunde inte spara den sociala kopplingen", error);
  const connection = mapSocialConnectionView(data as RawRecord);
  if (!connection) throw new Error("Den sparade sociala kopplingen hade ett ogiltigt format.");
  return connection;
}

/** Removes token material immediately; audit attempts remain without a connection reference. */
export async function disconnectSocialConnection(client: DatabaseClient, userId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await client
    .from("social_connections")
    .delete()
    .eq("id", connectionId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte koppla från det sociala kontot", error);
  return Boolean(data);
}

export async function markSocialConnectionState(
  client: DatabaseClient,
  userId: string,
  connectionId: string,
  state: Exclude<SocialConnectionState, "disconnected">,
  lastError: string | null,
): Promise<void> {
  const { error } = await client
    .from("social_connections")
    .update({ state, last_error: lastError?.slice(0, 1_000) ?? null })
    .eq("id", connectionId)
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte uppdatera den sociala kopplingen", error);
}

export function createSocialOAuthStart(input: {
  provider: SocialProvider;
  userId: string;
  /** A trusted application workspace id; it is never read from the callback URL. */
  workspaceId?: string;
  returnTo?: string | null;
}): { authorizationUrl: string; cookie: OAuthTransactionCookie } {
  const config = getSocialProviderConfig(input.provider);
  const state = randomBytes(32).toString("base64url");
  const transaction: OAuthTransaction = {
    provider: input.provider,
    userId: input.userId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    state,
    returnTo: normalizeReturnTo(input.returnTo),
    createdAt: Date.now(),
  };
  const cookieValue = encryptSocialSecret(JSON.stringify(transaction));
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scopes.join(" "));

  return {
    authorizationUrl: url.toString(),
    cookie: {
      name: oauthCookieName(input.provider),
      value: cookieValue,
      options: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.redirectUri.startsWith("https://"),
        path: "/",
        maxAge: Math.floor(OAUTH_TRANSACTION_TTL_MS / 1_000),
      },
    },
  };
}

export function readSocialOAuthTransaction(input: {
  provider: SocialProvider;
  cookieValue: string | undefined;
  returnedState: string | null;
}): OAuthTransaction | null {
  if (!input.cookieValue || !input.returnedState) return null;
  try {
    const parsed = JSON.parse(decryptSocialSecret(input.cookieValue)) as Partial<OAuthTransaction>;
    if (
      parsed.provider !== input.provider
      || typeof parsed.userId !== "string"
      || !parsed.userId
      || (parsed.workspaceId !== undefined && (typeof parsed.workspaceId !== "string" || !parsed.workspaceId))
      || typeof parsed.state !== "string"
      || typeof parsed.returnTo !== "string"
      || typeof parsed.createdAt !== "number"
      || Date.now() - parsed.createdAt > OAUTH_TRANSACTION_TTL_MS
      || parsed.createdAt > Date.now() + 60_000
      || !constantTimeEqual(parsed.state, input.returnedState)
    ) return null;
    return {
      provider: input.provider,
      userId: parsed.userId,
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      state: parsed.state,
      returnTo: normalizeReturnTo(parsed.returnTo),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearSocialOAuthCookie(provider: SocialProvider, secure = false): OAuthTransactionCookie {
  return {
    name: oauthCookieName(provider),
    value: "",
    options: { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 },
  };
}

/** Exchanges a short-lived authorization code without logging either code or token. */
export async function exchangeSocialOAuthCode(provider: SocialProvider, code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
}> {
  const config = getSocialProviderConfig(provider);
  if (!code || code.length > 4_000) throw new SocialOAuthError("OAuth-koden är ogiltig.", "invalid_code");
  let response: Response;
  if (config.provider === "linkedin") {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    });
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } else {
    const url = new URL(config.tokenUrl);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }).toString();
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  }
  const body = await safeJson(response);
  if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
    throw new SocialOAuthError("Leverantören godkände inte kopplingen. Försök igen och kontrollera appbehörigheterna.", "token_exchange_failed");
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1_000).toISOString() : null;
  const scopes = typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean) : config.scopes;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt,
    scopes: [...new Set(scopes)],
  };
}

/**
 * Resolves only publishable targets. Meta personal profiles are never added:
 * Facebook targets are Pages and Instagram targets must be Professional.
 */
export async function resolveSocialAccounts(input: {
  provider: SocialProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
}): Promise<ResolvedSocialAccount[]> {
  const config = getSocialProviderConfig(input.provider);
  if (config.provider === "linkedin") return resolveLinkedInAccount(config, input);
  return resolveMetaAccounts(config, input);
}

export async function finishSocialOAuthConnection(input: {
  client: DatabaseClient;
  userId: string;
  provider: SocialProvider;
  code: string;
}): Promise<SocialConnectionView[]> {
  const token = await exchangeSocialOAuthCode(input.provider, input.code);
  const accounts = await resolveSocialAccounts({ provider: input.provider, ...token });
  if (!accounts.length) {
    throw new SocialOAuthError(
      input.provider === "instagram_professional"
        ? "Inget publicerbart Instagram Professional-konto hittades. Kontot måste vara Business eller Creator och kopplat till rätt Meta-behörigheter."
        : input.provider === "facebook_page"
          ? "Inga Facebook-sidor med publiceringsbehörighet hittades."
          : "Inget LinkedIn-konto med publiceringsbehörighet hittades.",
      "no_publishable_account",
    );
  }
  return Promise.all(accounts.map((account) => upsertSocialConnection(input.client, input.userId, account)));
}

function oauthCookieName(provider: SocialProvider): string {
  return `pdb_social_oauth_${provider}`;
}

function normalizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/studio";
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function resolveMetaAccounts(
  config: Extract<SocialOAuthProviderConfig, { provider: "facebook_page" | "instagram_professional" }>,
  token: { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] },
): Promise<ResolvedSocialAccount[]> {
  const url = new URL(`${config.graphBaseUrl}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username,name}");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = await safeJson(response);
  if (!response.ok || !Array.isArray(body.data)) {
    throw new SocialOAuthError("Meta-kopplingen kunde inte läsa dina publicerbara konton.", "account_resolution_failed");
  }
  const accounts: ResolvedSocialAccount[] = [];
  for (const value of body.data) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.access_token !== "string" || !value.access_token) continue;
    const pageName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Facebook-sida";
    if (config.provider === "facebook_page") {
      accounts.push({
        provider: "facebook_page",
        providerAccountId: value.id,
        accountLabel: pageName,
        accountHandle: null,
        accessToken: value.access_token,
        refreshToken: null,
        tokenExpiresAt: token.expiresAt,
        scopes: token.scopes,
        metadata: { pageId: value.id, accountType: "page" },
      });
      continue;
    }
    const instagram = isRecord(value.instagram_business_account) ? value.instagram_business_account : null;
    if (!instagram || typeof instagram.id !== "string" || !instagram.id) continue;
    const handle = typeof instagram.username === "string" && instagram.username.trim() ? instagram.username.trim() : null;
    const label = typeof instagram.name === "string" && instagram.name.trim()
      ? instagram.name.trim()
      : handle ? `@${handle}` : pageName;
    accounts.push({
      provider: "instagram_professional",
      providerAccountId: instagram.id,
      accountLabel: label,
      accountHandle: handle,
      accessToken: value.access_token,
      refreshToken: null,
      tokenExpiresAt: token.expiresAt,
      scopes: token.scopes,
      metadata: { pageId: value.id, accountType: "professional", instagramAccountId: instagram.id },
    });
  }
  return accounts;
}

async function resolveLinkedInAccount(
  config: Extract<SocialOAuthProviderConfig, { provider: "linkedin" }>,
  token: { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] },
): Promise<ResolvedSocialAccount[]> {
  // LinkedIn's Posts API explicitly requires a Person URN constructed from
  // the current member Profile API's app-scoped `id`; do not infer it from an
  // OpenID Connect `sub` claim.
  const response = await fetch(`${config.apiBaseUrl}/v2/me`, {
    headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json", "x-restli-protocol-version": "2.0.0" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = await safeJson(response);
  if (!response.ok || typeof body.id !== "string" || !body.id) {
    throw new SocialOAuthError("LinkedIn-kopplingen kunde inte läsa ditt publiceringskonto.", "account_resolution_failed");
  }
  const firstName = typeof body.localizedFirstName === "string" ? body.localizedFirstName.trim() : "";
  const lastName = typeof body.localizedLastName === "string" ? body.localizedLastName.trim() : "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || "LinkedIn-konto";
  const authorUrn = `urn:li:person:${body.id}`;
  return [{
    provider: "linkedin",
    providerAccountId: authorUrn,
    accountLabel: name,
    accountHandle: null,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenExpiresAt: token.expiresAt,
    scopes: token.scopes,
    metadata: { authorUrn, accountType: "member" },
  }];
}

function mapSocialConnectionView(row: RawRecord): SocialConnectionView | null {
  const provider = socialProviderSchema.safeParse(row.provider);
  const state = socialConnectionStateSchema.safeParse(row.state);
  if (!provider.success || !state.success || typeof row.id !== "string" || typeof row.provider_account_id !== "string" || typeof row.account_label !== "string") return null;
  return {
    id: row.id,
    provider: provider.data,
    providerAccountId: row.provider_account_id,
    accountLabel: row.account_label,
    accountHandle: typeof row.account_handle === "string" ? row.account_handle : null,
    state: state.data,
    scopes: stringList(row.scopes),
    tokenExpiresAt: typeof row.token_expires_at === "string" ? row.token_expires_at : null,
    lastVerifiedAt: typeof row.last_verified_at === "string" ? row.last_verified_at : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapSocialConnectionSecret(row: RawRecord): SocialConnectionSecret | null {
  const safe = mapSocialConnectionView(row);
  if (!safe || typeof row.user_id !== "string" || typeof row.token_ciphertext !== "string") return null;
  return {
    ...safe,
    userId: row.user_id,
    tokenCiphertext: row.token_ciphertext,
    refreshTokenCiphertext: typeof row.refresh_token_ciphertext === "string" ? row.refresh_token_ciphertext : null,
    metadata: isRecord(row.metadata) ? row.metadata : {},
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

async function safeJson(response: Response): Promise<RawRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
