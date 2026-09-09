import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  canonicalSagaPersonaWebsite,
  emptySagaPersonaContextInput,
  sagaPersonaContextFromPayload,
} from "@/lib/client/saga-persona-context-api";
import {
  personaContextFormFromView,
  sagaPersonaContextInputFromForm,
  SagaPersonaContextPanel,
} from "@/components/saga-persona-context-panel";

describe("SAGA private persona context", () => {
  it("keeps a self-described persona private and defaults sensitive identity to not specified", () => {
    const parsed = sagaPersonaContextFromPayload({
      context: {
        selfDescription: "Systembyggare",
        heightCm: 181,
        clothing: ["Mörk overshirt"],
        environments: ["Skogsbryn"],
        visualCountries: ["Sverige"],
        interests: ["System"],
        workSummary: "Bygger verktyg",
        roles: ["Grundare"],
        organizations: [{ name: "SAGA", role: "Grundare" }],
        websites: [{ label: "SAGA", url: "https://example.se/" }],
        political: { mode: "not_specified", description: null },
        religion: { mode: "neutral", description: null },
        origin: null,
        birthCountry: null,
        visualContextConsent: false,
        modelUse: { visualContextConsent: false, activeIntegration: false },
        sensitiveDataStorageConsent: { accepted: true, version: "saga_persona_sensitive_storage_v1" },
        avatarBlobUrl: "https://blob.example/private-face.png",
        workspaceId: "must-not-reach-the-ui",
      },
    });

    expect(parsed?.context?.political).toEqual({ mode: "not_specified" });
    expect(parsed?.context?.religion).toEqual({ mode: "neutral" });
    expect(parsed?.context?.modelUse).toEqual({ visualContextConsent: false, activeIntegration: false });
    expect(JSON.stringify(parsed)).not.toContain("blob.example");
    expect(JSON.stringify(parsed)).not.toContain("workspaceId");
    expect(JSON.stringify(parsed)).not.toContain("saga_persona_sensitive_storage_v1");
  });

  it("stores only public HTTPS homepages and never treats them as fetch targets", () => {
    expect(canonicalSagaPersonaWebsite("https://EXEMPEL.SE/")).toBe("https://exempel.se/");
    expect(canonicalSagaPersonaWebsite("https://exempel.se/om")).toBeNull();
    expect(canonicalSagaPersonaWebsite("https://127.0.0.1/")).toBeNull();
    expect(canonicalSagaPersonaWebsite("http://exempel.se/")).toBeNull();
    expect(canonicalSagaPersonaWebsite("https://person:secret@exempel.se/")).toBeNull();
  });

  it("builds the exact owner-scoped input shape without sensitive defaults", () => {
    const form = personaContextFormFromView(null);
    form.selfDescription = "  En systembyggare  ";
    form.heightCm = "181";
    form.clothing = "Mörk overshirt\nArbetsbyxor";
    form.organizations = [{ id: "company-1", name: "SAGA", role: "Grundare" }];
    form.websites = [{ id: "site-1", label: "SAGA", url: "https://saga.example/" }];
    const input = sagaPersonaContextInputFromForm(form);

    expect(input).toMatchObject({
      selfDescription: "En systembyggare",
      heightCm: 181,
      clothing: ["Mörk overshirt", "Arbetsbyxor"],
      organizations: [{ name: "SAGA", role: "Grundare" }],
      websites: [{ label: "SAGA", url: "https://saga.example/" }],
      political: { mode: "not_specified" },
      religion: { mode: "not_specified" },
      visualContextConsent: false,
    });
    expect(emptySagaPersonaContextInput().visualContextConsent).toBe(false);
  });

  it("requires a fresh storage acknowledgement only when a sensitive self-description is present", () => {
    const form = personaContextFormFromView(null);
    form.politicalMode = "neutral";
    expect(() => sagaPersonaContextInputFromForm(form)).toThrow("Bekräfta att känsliga uppgifter får lagras privat");

    form.sensitiveDataStorageConsent = true;
    const input = sagaPersonaContextInputFromForm(form);
    expect(input.sensitiveDataStorageConsent).toEqual({
      accepted: true,
      version: "saga_persona_sensitive_storage_v1",
    });
  });

  it("renders private self-description, explicit consent and the sensitive section without avatar previews or external pages", () => {
    const html = renderToStaticMarkup(createElement(SagaPersonaContextPanel));

    expect(html).toContain("Beskriv din närvaro — på dina villkor.");
    expect(html).toContain("SAGA fyller inte i identitet från foton");
    expect(html).toContain("Ingen modell, bild, kalender eller publicering startas här.");
    expect(html).toContain("Valfri känslig identitet");
    expect(html).toContain("Väljer att inte ange");
    expect(html).toContain("Jag vill att SAGA får spara detta som privat visuell riktning.");
    expect(html).toContain("Länkar visas och öppnas aldrig här.");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("avatarBlobUrl");
  });

  it("mounts with the private avatar reference workspace and deletes context rather than writing an empty revision", () => {
    const page = readFileSync(resolve(process.cwd(), "app/studio/avatar/page.tsx"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "components/saga-persona-context-panel.tsx"), "utf8");

    expect(page).toContain("SagaPersonaContextPanel");
    expect(source).toContain('apiPath = "/api/saga/persona-context"');
    expect(source).toContain("deleteSagaPersonaContext(apiPath)");
    expect(source).toContain("sensitiveDataStorageConsent");
    expect(source).toContain("Jag bekräftar privat lagring av de valfria känsliga uppgifterna ovan.");
    expect(source).not.toContain("putSagaPersonaContext(emptySagaPersonaContextInput()");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("workspaceId");
    expect(source).not.toContain("userId");
  });
});
