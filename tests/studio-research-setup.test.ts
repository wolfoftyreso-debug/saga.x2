import { afterEach, describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";
import { SagaNewsWorkspace } from "@/components/saga-news-workspace";
import StudioResearchPage from "@/app/studio/research/page";

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnvironment);

describe("SAGA Research route", () => {
  it("keeps an unconfigured durable workspace inside the product shell with the real Research workspace", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    const page = StudioResearchPage();

    expect(page.type).toBe(AppShell);
    expect(page.props.children.type).toBe(SagaNewsWorkspace);
  });

  it("never switches to a retired legacy research surface when old variables exist", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://brief.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    const page = StudioResearchPage();

    expect(page.type).toBe(AppShell);
    expect(page.props.children.type).toBe(SagaNewsWorkspace);
  });
});
