import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Vercel-only entry surfaces", () => {
  it("keeps the root and settings routes on the Vercel product path", () => {
    const home = source("app/page.tsx");
    const settings = source("app/settings/page.tsx");

    expect(home).toContain('redirect("/studio")');
    expect(home).not.toMatch(/supabase/i);
    expect(settings).toContain("ProductSettingsHub");
    expect(settings).not.toContain("VercelSettingsPanel");
    expect(settings).not.toContain("SetupRequired");
    expect(settings).not.toMatch(/supabase/i);
  });

  it("keeps technical deployment setup out of the product gate and no retired provider in setup or login", () => {
    const setup = source("components/setup-required.tsx");
    const login = source("app/login/page.tsx");
    const research = source("components/content-studio.tsx");

    for (const text of [setup, login, research]) expect(text).not.toMatch(/supabase/i);
    expect(setup).toContain("Här ska du skapa — inte hantera teknik.");
    expect(setup).toContain('href="/preview"');
    expect(setup).not.toMatch(/marketplace\/neon|vercel-blob|AI_GATEWAY_API_KEY|CRON_SECRET/i);
    expect(login).toContain("/api/auth/authorize?next=/studio");
  });

  it("does not present legacy reader routes in the application navigation", () => {
    const navigation = source("components/bottom-nav.tsx");
    const shell = source("components/app-shell.tsx");
    const studio = source("components/content-studio.tsx");
    const engine = source("components/content-engine-workspace.tsx");

    for (const text of [navigation, shell]) {
      expect(text).not.toContain('href="/briefs"');
      expect(text).not.toContain('href="/watches"');
      expect(text).not.toContain('href="/history"');
    }
    expect(navigation).toContain('href: "/studio/engine"');
    expect(navigation).toContain('href: "/studio/automations"');
    expect(navigation).toContain('href: "/settings"');
    expect(navigation).toContain('matches: ["/studio/engine", "/studio/lens"]');
    expect(studio).toContain('href="/studio/lens"');
    expect(engine).toContain('href="/studio/lens"');
  });
});
