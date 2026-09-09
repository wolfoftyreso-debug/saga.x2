import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductSettingsHub } from "@/components/product-settings-hub";

describe("ProductSettingsHub", () => {
  it("shows a compact, product-only state when no workspace is available", () => {
    const html = renderToStaticMarkup(createElement(ProductSettingsHub, { actor: null }));

    expect(html).toContain("Vi visar inte tomma inställningar.");
    expect(html).toContain("/preview");
    expect(html).toContain("/studio");
    expect(html).not.toContain("DATABASE_URL");
    expect(html).not.toContain("Neon");
    expect(html).not.toContain("Blob");
    expect(html).not.toContain("Cron");
  });

  it("links each real product setting to the corresponding Studio tool", () => {
    const html = renderToStaticMarkup(createElement(ProductSettingsHub, {
      actor: { role: "owner", email: "owner@example.com", displayName: "Northstar" },
    }));

    expect(html).toContain("Northstar");
    expect(html).toContain("Mission, röst &amp; källor");
    expect(html).toContain("/studio/lens");
    expect(html).toContain("/studio/templates");
    expect(html).toContain("/studio/channels");
    expect(html).toContain("/studio/automations");
    expect(html).toContain("Granskning &amp; godkännande");
    expect(html).toContain("Utgående API");
    expect(html).toContain("/settings/api");
  });

  it("never mounts the technical setup checklist at the settings route", () => {
    const source = readFileSync(resolve(process.cwd(), "app/settings/page.tsx"), "utf8");

    expect(source).toContain("ProductSettingsHub");
    expect(source).not.toContain("SetupRequired");
    expect(source).not.toContain("VercelSettingsPanel");
  });
});
