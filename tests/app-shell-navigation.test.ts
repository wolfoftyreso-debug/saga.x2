import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readProjectFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("SAGA app-shell navigation", () => {
  it("keeps icon-only rail destinations reachable by name", () => {
    const navigation = readProjectFile("components/bottom-nav.tsx");

    expect(navigation).toContain("aria-label={link.accessibleLabel ?? link.label}");
    expect(navigation).toContain('title={variant === "sidebar" ? link.label : undefined}');
  });

  it("keeps the labelled rail through ordinary desktop widths", () => {
    const shell = readProjectFile("components/app-shell.tsx");

    expect(shell).toContain("const MIN_WORKBENCH_WIDTH = 924");
    expect(shell).toContain("width - EXPANDED_RAIL_WIDTH < MIN_WORKBENCH_WIDTH");
  });

  it("does not leave a visible menu label outside a smaller collapsed click target", () => {
    const stylesheet = readProjectFile("app/globals.css");
    const collapsedRail = stylesheet.slice(
      stylesheet.indexOf('.app-shell--with-sidebar[data-rail-state="collapsed"] .sidebar-nav-list'),
      stylesheet.indexOf('.app-shell--with-sidebar .bottom-nav', stylesheet.indexOf('.app-shell--with-sidebar[data-rail-state="collapsed"] .sidebar-nav-list')),
    );

    expect(collapsedRail).toContain("justify-items: stretch");
    expect(collapsedRail).toContain("width: 100%");
    expect(collapsedRail).toContain("min-height: 48px");
    expect(collapsedRail).toContain("pointer-events: auto");
    expect(collapsedRail).toContain('.nav-link-label { display: none; }');
  });

  it("does not let the local Next development indicator cover mobile navigation", () => {
    const config = readProjectFile("next.config.ts");

    expect(config).toContain("devIndicators: false");
  });

  it("keeps the local example gallery clearly separate from a draft preview", () => {
    const navigation = readProjectFile("components/bottom-nav.tsx");

    expect(navigation).toContain('detail: "Referensgalleri"');
    expect(navigation).not.toContain('className="app-topbar-preview" href="/preview"');
  });

  it("names the calendar as an internal content plan rather than a delivery promise", () => {
    const navigation = readProjectFile("components/bottom-nav.tsx");

    expect(navigation).toContain('area: "Kalender", detail: "Innehållsplan"');
    expect(navigation).not.toContain('area: "Kalender", detail: "Publiceringsplan"');
  });

  it("keeps four primary operational work areas while nesting focused routes beneath them", () => {
    const navigation = readProjectFile("components/bottom-nav.tsx");

    expect(navigation).toContain('label: "Skapa"');
    expect(navigation).toContain('href: "/studio/create"');
    expect(navigation).toContain('label: "Kalender"');
    expect(navigation).toContain('label: "Automations"');
    expect(navigation).toContain('label: "Inställningar"');
    expect(navigation).toContain('"/studio/ads",');
    expect(navigation).toContain('area: "Studio", detail: "Annonsverkstad"');
    expect(navigation).toContain('matches: ["/studio/automations", ...automationBuildRoutes.matches]');
  });

  it("keeps the shared workbench chrome industrial rather than conversational", () => {
    const shell = readProjectFile("components/app-shell.tsx");
    const stylesheet = readProjectFile("app/globals.css");
    const industrialChrome = stylesheet.slice(stylesheet.lastIndexOf("Industrial application chrome"));

    expect(shell).toContain('className="sidebar-create-action"');
    expect(shell).toContain(">Skapa utkast<");
    expect(shell).not.toContain("sidebar-new-chat");
    expect(industrialChrome).toContain("--saga-shell-accent: #006fae");
    expect(industrialChrome).toContain("border-radius: 0;");
    expect(industrialChrome).not.toContain("linear-gradient");
  });
});
