import { afterEach, describe, expect, it } from "vitest";
import {
  MissingVercelIdentityConfigurationError,
  createVercelOAuthTransaction,
  isVercelIdentityConfigured,
  missingVercelIdentityConfiguration,
  safeRelativeReturnTo,
  vercelAuthorizationUrl,
  vercelCallbackUrl,
} from "@/lib/auth/vercel-oauth";

const originalClientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
const originalSecret = process.env.VERCEL_APP_CLIENT_SECRET;

afterEach(() => {
  if (originalClientId === undefined) delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  else process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = originalClientId;
  if (originalSecret === undefined) delete process.env.VERCEL_APP_CLIENT_SECRET;
  else process.env.VERCEL_APP_CLIENT_SECRET = originalSecret;
});

describe.sequential("Sign in with Vercel", () => {
  it("reports only missing variable names", () => {
    delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
    delete process.env.VERCEL_APP_CLIENT_SECRET;
    expect(isVercelIdentityConfigured()).toBe(false);
    expect(missingVercelIdentityConfiguration()).toEqual([
      "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
      "VERCEL_APP_CLIENT_SECRET",
    ]);
    expect(() => vercelAuthorizationUrl("http://localhost:3010", createVercelOAuthTransaction())).toThrow(MissingVercelIdentityConfigurationError);
  });

  it("uses PKCE, nonce and the exact app callback without exposing a secret", () => {
    process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "brief-test-client";
    process.env.VERCEL_APP_CLIENT_SECRET = "server-only-secret";
    const transaction = createVercelOAuthTransaction();
    const url = new URL(vercelAuthorizationUrl("https://brief.example", transaction));

    expect(url.origin).toBe("https://vercel.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("brief-test-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://brief.example/api/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe(transaction.state);
    expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(url.toString()).not.toContain("server-only-secret");
  });

  it("accepts local callbacks but blocks insecure non-local callbacks and open redirects", () => {
    expect(vercelCallbackUrl("http://localhost:3010")).toBe("http://localhost:3010/api/auth/callback");
    expect(vercelCallbackUrl("https://brief.example")).toBe("https://brief.example/api/auth/callback");
    expect(() => vercelCallbackUrl("http://brief.example")).toThrow(/HTTPS/);
    expect(safeRelativeReturnTo("/studio/content/new?edit=1")).toBe("/studio/content/new?edit=1");
    expect(safeRelativeReturnTo("//outside.example")).toBe("/");
    expect(safeRelativeReturnTo("https://outside.example")).toBe("/");
  });
});
