import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { PUT as saveSettings } from "@/app/api/settings/route";
import { GET as getFlowControls, PUT as saveFlowControls } from "@/app/api/settings/flow/route";

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function removeSupabaseConfiguration() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("inställningsrutter utan datalager", () => {
  it("svarar tydligt i stället för med en tom 500 när vanliga inställningar sparas", async () => {
    removeSupabaseConfiguration();

    const response = await saveSettings(new NextRequest("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      missing: expect.arrayContaining(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
    });
  });

  it("svarar tydligt för både läsning och sparning av flödesinställningar", async () => {
    removeSupabaseConfiguration();

    const read = await getFlowControls();
    const save = await saveFlowControls(new NextRequest("http://localhost/api/settings/flow", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }));

    expect(read.status).toBe(503);
    expect(save.status).toBe(503);
    await expect(read.json()).resolves.toMatchObject({ code: "configuration_required" });
    await expect(save.json()).resolves.toMatchObject({ code: "configuration_required" });
  });
});
