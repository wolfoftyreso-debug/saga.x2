import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  avatarUploadRequirements,
  avatarReferencesFromPayload,
  avatarWorkspaceMessage,
  SagaAvatarReferencesWorkspace,
} from "@/components/saga-avatar-references-workspace";

describe("SAGA private avatar references", () => {
  it("narrows server data to private metadata and refuses raw media URLs", () => {
    const parsed = avatarReferencesFromPayload({
      profiles: [{
        id: "profile-a",
        label: "Min visuella grund",
        outputVisibilityPolicy: "obscured_noir_only",
        fullFaceAllowed: false,
        providerProcessing: { provider: "vercel_ai_gateway", enabled: false, consented: false, readyForPrivateModelUse: false },
        referenceImages: [{
          id: "reference-a",
          angle: "three_quarter_left",
          position: 2,
          assetUrl: "https://blob.example/private-face.png",
          publicUrl: "https://blob.example/public-face.png",
          createdAt: "2026-08-25T09:00:00.000Z",
        }],
      }],
    });

    expect(parsed).toEqual({
      profiles: [{
        id: "profile-a",
        label: "Min visuella grund",
        providerProcessing: { consented: false, readyForPrivateModelUse: false },
        createdAt: null,
        references: [{ id: "reference-a", angle: "three_quarter_left", position: 2, createdAt: "2026-08-25T09:00:00.000Z" }],
      }],
    });
    expect(JSON.stringify(parsed)).not.toContain("blob.example");
  });

  it("requires a real profile list rather than rendering a fake success state", () => {
    expect(avatarReferencesFromPayload({ profile: { id: "one" } })).toBeNull();
    expect(avatarReferencesFromPayload({ profiles: [{ id: "one", label: "X", references: [{ id: "r", angle: "not-an-angle" }] }] })).toEqual({ profiles: [] });
    expect(avatarWorkspaceMessage({ code: "configuration_required", error: "DATABASE_URL" }, "fallback")).toBe("Privata foton kan sparas när Neon-anslutningen är redo i Vercel.");
  });

  it("matches the API capacity rules for a first batch and later additions", () => {
    expect(avatarUploadRequirements(0)).toEqual({ existingReferenceCount: 0, minimumFiles: 3, maximumFiles: 6 });
    expect(avatarUploadRequirements(3)).toEqual({ existingReferenceCount: 3, minimumFiles: 1, maximumFiles: 3 });
    expect(avatarUploadRequirements(5)).toEqual({ existingReferenceCount: 5, minimumFiles: 1, maximumFiles: 1 });
    expect(avatarUploadRequirements(6)).toEqual({ existingReferenceCount: 6, minimumFiles: 0, maximumFiles: 0 });
  });

  it("states consent, face-obscured output, private review and no public source preview", () => {
    const html = renderToStaticMarkup(createElement(SagaAvatarReferencesWorkspace));

    expect(html).toContain("Jag bekräftar att bilderna föreställer mig");
    expect(html).toContain("Ansiktet döljs som standard.");
    expect(html).toContain("Bilden behöver granskning");
    expect(html).toContain("Inga ansiktsbilder förhandsvisas här.");
    expect(html).toContain("Foton över 4 MB går direkt till privat lagring");
    expect(html).toContain("Lägg in vinklar, inte en profilbild.");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("assetUrl");
    expect(html).not.toContain("publicUrl");
  });

  it("keeps the route private, scoped and free of social account connection UI", () => {
    const page = readFileSync(resolve(process.cwd(), "app/studio/avatar/page.tsx"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "components/saga-avatar-references-workspace.tsx"), "utf8");

    expect(page).toContain("SagaAvatarReferencesWorkspace");
    expect(source).toContain('apiPath = "/api/saga/avatar-profiles"');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).toContain('upload-grant');
    expect(source).toContain('upload-finalize');
    expect(source).toContain('handleUploadUrl: "/api/saga/avatar-upload"');
    expect(source).toContain('clientPayload: JSON.stringify({ grant: grant.grant, uploadId: entry.id })');
    expect(source).toContain('access: "private"');
    expect(source).not.toContain("new FormData");
    expect(source).toContain('providerProcessingConsent: { provider: "vercel_ai_gateway", accepted: true }');
    expect(source).toContain("avatarUploadRequirements(targetProfile?.references.length ?? 0)");
    expect(source).toContain("Du kan fylla på en befintlig referens");
    expect(source).toContain('references/${encodeURIComponent(reference.id)}');
    expect(source).toContain("Ingen bildkörning har startats");
    expect(source).not.toContain("social/connections");
    expect(source).not.toContain("training");
    expect(source).not.toContain("previewUrl");
  });
});
