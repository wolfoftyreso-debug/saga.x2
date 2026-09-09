import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const VERCEL_ISSUER = "https://vercel.com";
const VERCEL_JWKS = createRemoteJWKSet(new URL("https://vercel.com/.well-known/jwks"));

export type VercelIdentity = {
  subject: string;
  email: string | null;
  name: string | null;
  username: string | null;
  picture: string | null;
};

export type VercelOAuthTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

type VercelTokenExchange = {
  access_token: string;
  token_type: string;
  id_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

export class MissingVercelIdentityConfigurationError extends Error {
  constructor() {
    super("Sign in with Vercel är inte konfigurerat.");
    this.name = "MissingVercelIdentityConfigurationError";
  }
}

/** Only variable names are returned; their values never reach the client. */
export function missingVercelIdentityConfiguration(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim()) missing.push("NEXT_PUBLIC_VERCEL_APP_CLIENT_ID");
  if (!process.env.VERCEL_APP_CLIENT_SECRET?.trim()) missing.push("VERCEL_APP_CLIENT_SECRET");
  return missing;
}

export function isVercelIdentityConfigured(): boolean {
  return missingVercelIdentityConfiguration().length === 0;
}

function identityConfig() {
  const clientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new MissingVercelIdentityConfigurationError();
  return { clientId, clientSecret };
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createVercelOAuthTransaction(): VercelOAuthTransaction {
  return {
    state: randomUrlSafe(),
    nonce: randomUrlSafe(),
    codeVerifier: randomUrlSafe(48),
  };
}

export function vercelCallbackUrl(origin: string): string {
  const callback = new URL("/api/auth/callback", origin);
  if (callback.protocol !== "https:" && callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") {
    throw new Error("Vercel-inloggning kräver HTTPS utanför lokal utveckling.");
  }
  return callback.toString();
}

export function vercelAuthorizationUrl(origin: string, transaction: VercelOAuthTransaction): string {
  const { clientId } = identityConfig();
  const codeChallenge = createHash("sha256").update(transaction.codeVerifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: vercelCallbackUrl(origin),
    response_type: "code",
    scope: "openid email profile offline_access",
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://vercel.com/oauth/authorize?${query.toString()}`;
}

export async function exchangeVercelAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  origin: string;
}): Promise<VercelTokenExchange> {
  const { clientId, clientSecret } = identityConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: vercelCallbackUrl(input.origin),
  });
  const response = await fetch("https://api.vercel.com/login/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Vercel kunde inte slutföra inloggningen.");
  const payload = await response.json() as Partial<VercelTokenExchange>;
  if (!payload.id_token || !payload.access_token || !Number.isFinite(payload.expires_in)) {
    throw new Error("Vercel svarade utan en komplett inloggningssession.");
  }
  return payload as VercelTokenExchange;
}

export async function verifyVercelIdentityToken(idToken: string, expectedNonce: string): Promise<VercelIdentity> {
  const { clientId } = identityConfig();
  const { payload } = await jwtVerify(idToken, VERCEL_JWKS, {
    issuer: VERCEL_ISSUER,
    audience: clientId,
  });
  if (!payload.sub || payload.nonce !== expectedNonce) throw new Error("Vercel-inloggningen kunde inte verifieras.");
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
    username: typeof payload.preferred_username === "string" ? payload.preferred_username : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

export function safeRelativeReturnTo(value: string | null | undefined): string {
  // WHATWG URL parsing treats backslashes as slashes and removes some control
  // characters. A startsWith('/') check alone therefore permits another host.
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(value)) return "/";
  const validationOrigin = "https://saga-return-to.invalid";
  try {
    const parsed = new URL(value, validationOrigin);
    if (parsed.origin !== validationOrigin || parsed.username || parsed.password) return "/";
    // Normalize dot segments before returning a relative value. A same-origin
    // path such as /studio/..//host becomes //host if serialized carelessly.
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (parsed.pathname.startsWith("//") || decodedPath.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(decodedPath)) return "/";
    const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return new URL(relative, validationOrigin).origin === validationOrigin ? relative : "/";
  } catch {
    return "/";
  }
}
