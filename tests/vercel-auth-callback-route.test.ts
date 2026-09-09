import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// These are isolated unit-test fixtures, never credentials or live sessions.
const auth = vi.hoisted(() => ({
  configured: vi.fn(),
  exchange: vi.fn(),
  verify: vi.fn(),
  actor: vi.fn(),
  session: vi.fn(),
}));

vi.mock("@/lib/neon/config", () => ({ isNeonDatabaseConfigured: auth.configured }));
vi.mock("@/lib/neon/auth-repository", () => ({
  ensureVercelActor: auth.actor,
  createAppSession: auth.session,
  appSessionCookie: {
    name: "brief_session",
    options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 },
  },
}));
vi.mock("@/lib/auth/vercel-oauth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/vercel-oauth")>(),
  exchangeVercelAuthorizationCode: auth.exchange,
  verifyVercelIdentityToken: auth.verify,
}));

import { GET } from "@/app/api/auth/callback/route";

const identity = { subject: "isolated-user", email: null, name: null, username: null, picture: null };
const actor = { id: "isolated-actor" };
const cookieNames = ["brief_oauth_state", "brief_oauth_nonce", "brief_oauth_verifier", "brief_oauth_return_to"];

function callback(options: { query?: string; omit?: string; state?: string; returnTo?: string } = {}) {
  const request = new NextRequest(`https://preview.example.test/api/auth/callback?${options.query ?? "code=isolated-code&state=isolated-state"}`);
  const cookies = {
    brief_oauth_state: options.state ?? "isolated-state",
    brief_oauth_nonce: "isolated-nonce",
    brief_oauth_verifier: "isolated-verifier",
    brief_oauth_return_to: options.returnTo ?? "/studio/calendar",
  };
  for (const [name, value] of Object.entries(cookies)) {
    if (name !== options.omit) request.cookies.set(name, value);
  }
  return request;
}

function expectTransactionCleared(response: Awaited<ReturnType<typeof GET>>) {
  for (const name of cookieNames) {
    expect(response.cookies.get(name)?.value).toBe("");
    const expires = response.cookies.get(name)?.expires;
    expect(expires instanceof Date ? expires.getTime() : expires).toBe(0);
  }
}

function expectNoSession(response: Awaited<ReturnType<typeof GET>>, reason: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`https://preview.example.test/login?error=${reason}`);
  expect(response.cookies.has("brief_session")).toBe(false);
  expectTransactionCleared(response);
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.configured.mockReturnValue(true);
  auth.exchange.mockResolvedValue({ id_token: "isolated-id-token", access_token: "isolated-access-token", expires_in: 3600 });
  auth.verify.mockResolvedValue(identity);
  auth.actor.mockResolvedValue(actor);
  auth.session.mockResolvedValue("isolated-session-fixture");
});

describe("OAuth callback: verified identity precedes any application session", () => {
  it("passes the exact callback origin, verifier and nonce, then redirects to the saved internal route", async () => {
    const response = await GET(callback());
    expect(auth.exchange).toHaveBeenCalledExactlyOnceWith({ code: "isolated-code", codeVerifier: "isolated-verifier", origin: "https://preview.example.test" });
    expect(auth.verify).toHaveBeenCalledExactlyOnceWith("isolated-id-token", "isolated-nonce");
    expect(auth.actor).toHaveBeenCalledExactlyOnceWith(identity);
    expect(auth.session).toHaveBeenCalledExactlyOnceWith(actor);
    expect(auth.verify.mock.invocationCallOrder[0]).toBeLessThan(auth.actor.mock.invocationCallOrder[0]);
    expect(auth.actor.mock.invocationCallOrder[0]).toBeLessThan(auth.session.mock.invocationCallOrder[0]);
    expect(response.headers.get("location")).toBe("https://preview.example.test/studio/calendar");
    expect(response.cookies.get("brief_session")).toMatchObject({ value: "isolated-session-fixture", httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expectTransactionCleared(response);
    expect(response.headers.get("location")).not.toContain("isolated");
  });

  it.each(["//outside.example", "/\\outside.example", "/studio/..//outside.example"])("revalidates a tampered return cookie %j before redirecting", async (returnTo) => {
    const response = await GET(callback({ returnTo }));
    expect(response.headers.get("location")).toBe("https://preview.example.test/");
    expectTransactionCleared(response);
  });

  it.each([
    { query: "state=isolated-state" },
    { query: "code=isolated-code" },
    { state: "different-state" },
    { omit: "brief_oauth_state" },
    { omit: "brief_oauth_nonce" },
    { omit: "brief_oauth_verifier" },
  ])("rejects an incomplete or mismatched transaction before external calls: %j", async (options) => {
    expectNoSession(await GET(callback(options)), "invalid_callback");
    for (const fn of [auth.exchange, auth.verify, auth.actor, auth.session]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["access_denied", "access_denied"],
    ["provider_details_that_must_not_be_echoed", "invalid_callback"],
  ])("handles provider error %s without a token exchange", async (error, reason) => {
    expectNoSession(await GET(callback({ query: `error=${error}&code=isolated-code&state=isolated-state` })), reason);
    expect(auth.exchange).not.toHaveBeenCalled();
    expect(auth.session).not.toHaveBeenCalled();
  });

  it("does not start token exchange when persistence is not configured", async () => {
    auth.configured.mockReturnValue(false);
    expectNoSession(await GET(callback()), "database_not_configured");
    expect(auth.exchange).not.toHaveBeenCalled();
    expect(auth.session).not.toHaveBeenCalled();
  });

  it.each(["exchange", "verify", "actor", "session"] as const)("fails closed when %s fails and does not echo the exception", async (stage) => {
    auth[stage].mockRejectedValue(new Error("isolated-sensitive-error-do-not-echo"));
    const response = await GET(callback());
    expectNoSession(response, "sign_in_failed");
    expect(response.headers.get("location")).not.toContain("isolated-sensitive-error");
    const stages = ["exchange", "verify", "actor", "session"] as const;
    for (const later of stages.slice(stages.indexOf(stage) + 1)) expect(auth[later]).not.toHaveBeenCalled();
  });
});
