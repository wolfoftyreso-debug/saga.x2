import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/auth/authorize/route";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "isolated-client-id");
  vi.stubEnv("VERCEL_APP_CLIENT_SECRET", "isolated-server-secret");
});
afterEach(() => vi.unstubAllEnvs());

function expectUncachedRedirect(response: Response) {
  expect(response.status).toBe(307);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("location")).not.toContain("isolated-server-secret");
}

describe("OAuth authorization redirects must never be cached", () => {
  it("sets explicit no-store/no-cache on the real OAuth redirect while retaining PKCE and transaction cookies", () => {
    const response = GET(new NextRequest("https://preview.example.test/api/auth/authorize?next=/studio"));
    expectUncachedRedirect(response);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe("https://vercel.com");
    expect(target.searchParams.get("redirect_uri")).toBe("https://preview.example.test/api/auth/callback");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.cookies.getAll()).toHaveLength(4);
    expect(response.cookies.getAll().every((cookie) => cookie.httpOnly && cookie.sameSite === "lax" && cookie.maxAge === 600)).toBe(true);
    expect(response.cookies.get("brief_oauth_return_to")?.value).toBe("/studio");
    expect(response.cookies.has("brief_session")).toBe(false);
  });

  it.each(["NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET"])("does not cache the setup redirect when %s is missing", (name) => {
    vi.stubEnv(name, "");
    const response = GET(new NextRequest("https://preview.example.test/api/auth/authorize?next=/studio"));
    expectUncachedRedirect(response);
    expect(response.headers.get("location")).toBe("https://preview.example.test/login?error=configuration_required");
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it("retains no-store and a safe internal return path when next contains an encoded backslash redirect", () => {
    const response = GET(new NextRequest("https://preview.example.test/api/auth/authorize?next=%2F%5Coutside.example"));
    expectUncachedRedirect(response);
    expect(response.cookies.get("brief_oauth_return_to")?.value).toBe("/");
  });
});
