import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { GET as socialChannels } from "@/app/api/social/channels/route";
import { proxy } from "@/proxy";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  isSupabasePublicConfigured,
  isSupabaseServiceConfigured,
  missingSupabaseServiceConfiguration,
} from "@/lib/supabase/config";
import { VercelOnlySupabaseDisabledError } from "@/lib/runtime/vercel-only";

const originalEnvironment = {
  VERCEL: process.env.VERCEL,
  VERCEL_ONLY: process.env.VERCEL_ONLY,
  DATABASE_URL: process.env.DATABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function restore(name: keyof typeof originalEnvironment) {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.VERCEL_ONLY = "1";
  delete process.env.VERCEL;
  delete process.env.DATABASE_URL;
  // Keep deliberately valid legacy credentials present: the boundary must not
  // decide to use them just because Neon has a deployment-time problem.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "legacy-public-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy-service-key";
  mocks.createClient.mockReset();
  mocks.createServerClient.mockReset();
});

afterEach(() => {
  (Object.keys(originalEnvironment) as Array<keyof typeof originalEnvironment>).forEach(restore);
});

describe.sequential("Vercel-only runtime boundary", () => {
  it("disables both Supabase clients before either SDK constructor can run", async () => {
    expect(isSupabasePublicConfigured()).toBe(false);
    expect(isSupabaseServiceConfigured()).toBe(false);
    expect(missingSupabaseServiceConfiguration()).toEqual(["Vercel/Neon"]);

    expect(() => createAdminClient()).toThrow(VercelOnlySupabaseDisabledError);
    await expect(createServerSupabaseClient()).rejects.toBeInstanceOf(VercelOnlySupabaseDisabledError);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("fails an old direct handler closed instead of invoking a configured Supabase client", async () => {
    const response = await socialChannels();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: ["Vercel/Neon"],
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("returns a structured 503 from Proxy for legacy Supabase APIs", async () => {
    const response = proxy(new NextRequest("https://brief.example/api/watches"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "vercel_only_mode",
      dataStore: "neon",
    });
  });

  it("does not let a missing or malformed Neon URL route content requests to Supabase", async () => {
    const missing = proxy(new NextRequest("https://brief.example/api/content/drafts"));
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: ["DATABASE_URL"],
    });

    process.env.DATABASE_URL = "https://not-a-postgres-database.example";
    const malformed = proxy(new NextRequest("https://brief.example/api/social/channels"));
    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toMatchObject({ code: "database_configuration_invalid" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("keeps the Content Engine behind the same Neon configuration boundary", async () => {
    const response = proxy(new NextRequest("https://brief.example/api/content-engine"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: ["DATABASE_URL"],
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("keeps the SAGA Research API behind the same Neon configuration boundary", async () => {
    const response = proxy(new NextRequest("https://brief.example/api/saga/news"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: ["DATABASE_URL"],
    });
  });
});
