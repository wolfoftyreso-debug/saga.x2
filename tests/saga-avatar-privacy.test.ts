import { describe, expect, it } from "vitest";
import {
  assertSagaAvatarGenerationCanStart,
  buildSagaAvatarGenerationPolicy,
  buildSagaAvatarProviderPrompt,
  recordSagaAvatarVisualReview,
  SagaAvatarPrivacyError,
} from "@/lib/services/saga-avatar-privacy";

const avatarProfileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const referenceImageIds = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
];

function safeRequest(overrides: Record<string, unknown> = {}) {
  return {
    avatarProfileId,
    referenceImageIds,
    presentation: "noir_shadow" as const,
    requestedVisualDirection: "En stillsam noir-inspirerad bild i en arkitekturstudio.",
    providerTransferConsent: {
      allowReferenceTransferForThisRun: true,
      retentionChoice: "acknowledged_provider_terms" as const,
    },
    ...overrides,
  };
}

describe("SAGA private avatar privacy policy", () => {
  it("builds a finite noir rewrite and never includes a reference locator or user direction in the provider prompt", () => {
    const policy = buildSagaAvatarGenerationPolicy(safeRequest({
      requestedVisualDirection: "En arkitekt i en lugn kvällsstudio med känsla av riktning.",
    }));

    expect(policy).toMatchObject({
      status: "review_required",
      presentation: "noir_shadow",
      referenceHandling: {
        source: "private_vercel_blob",
        referenceCount: 3,
        browserAccess: "never",
        maySendPrivateReferenceToProvider: true,
      },
      privacy: {
        privateOnly: true,
        fullIdentifiableFaceAllowed: false,
        visualVerificationRequired: true,
        promptIsNotVerification: true,
      },
    });
    expect(policy.providerPrompt).toContain("noir-inspirerad");
    expect(policy.providerPrompt).toContain("Visa aldrig ett helt, frontalt eller identifierbart ansikte");
    expect(policy.providerPrompt).not.toContain("arkitekt i en lugn kvällsstudio");
    expect(policy.providerPrompt).not.toContain(referenceImageIds[0]);
  });

  it("rejects an explicit full-face or recognizable-person request before a private reference can be hydrated", () => {
    const policy = buildSagaAvatarGenerationPolicy(safeRequest({
      requestedVisualDirection: "Visa mitt hela ansikte rakt fram, ett igenkännbart porträtt.",
    }));

    expect(policy).toMatchObject({
      status: "blocked",
      providerPrompt: null,
      capabilities: {
        canCreatePrivateDraft: false,
        canEnterCalendar: false,
        canPublish: false,
        canUseExternalAccounts: false,
      },
    });
    expect(policy.findings).toContainEqual(expect.objectContaining({
      code: "forbidden_face_visibility_request",
      severity: "blocker",
    }));
    expect(() => assertSagaAvatarGenerationCanStart(safeRequest({
      requestedVisualDirection: "Show my face in a full face, front facing portrait.",
    }))).toThrow(SagaAvatarPrivacyError);
  });

  it("blocks shock or imminent-injury scenes even when they are requested for an anonymous avatar", () => {
    const policy = buildSagaAvatarGenerationPolicy(safeRequest({
      requestedVisualDirection: "Ett hjul faller från en balkong mot en folksamling på gatan.",
    }));

    expect(policy.status).toBe("blocked");
    expect(policy.findings).toContainEqual(expect.objectContaining({ code: "unsafe_scene" }));
  });

  it("requires an explicit per-run provider-transfer acknowledgement and does not start with a workspace-wide implied consent", () => {
    const policy = buildSagaAvatarGenerationPolicy(safeRequest({
      providerTransferConsent: {
        allowReferenceTransferForThisRun: false,
        retentionChoice: "not_selected",
      },
    }));

    expect(policy.status).toBe("review_required");
    expect(policy.referenceHandling.maySendPrivateReferenceToProvider).toBe(false);
    expect(policy.capabilities).toMatchObject({ canCreatePrivateDraft: false, canEnterCalendar: false, canPublish: false });
    expect(policy.findings).toContainEqual(expect.objectContaining({ code: "provider_transfer_consent_required", severity: "warning" }));
    expect(() => assertSagaAvatarGenerationCanStart(safeRequest({
      providerTransferConsent: { allowReferenceTransferForThisRun: false, retentionChoice: "not_selected" },
    }))).toThrow(SagaAvatarPrivacyError);
  });

  it("keeps every review result private and does not let a visual reviewer grant calendar, publication, or account permissions", () => {
    const policy = assertSagaAvatarGenerationCanStart(safeRequest());
    const reviewed = recordSagaAvatarVisualReview(policy, {
      reviewer: "pixel_verifier",
      reviewedAt: "2026-08-25T11:00:00.000Z",
      faceVisibility: "obscured",
      fullIdentifiableFaceDetected: false,
      identityLeakRisk: "low",
    });

    expect(reviewed).toMatchObject({
      status: "private_approved",
      capabilities: {
        canCreatePrivateDraft: false,
        canEnterCalendar: false,
        canPublish: false,
        canUseExternalAccounts: false,
      },
    });
  });

  it("fails closed when the pixel reviewer sees a full or potentially identifiable face", () => {
    const policy = assertSagaAvatarGenerationCanStart(safeRequest());
    const reviewed = recordSagaAvatarVisualReview(policy, {
      reviewer: "human",
      reviewedAt: "2026-08-25T11:00:00.000Z",
      faceVisibility: "not_obscured",
      fullIdentifiableFaceDetected: true,
      identityLeakRisk: "high",
    });

    expect(reviewed.status).toBe("blocked");
    expect(reviewed.capabilities.canPublish).toBe(false);
  });

  it("exports an independently testable finite prompt for every allowed safe presentation", () => {
    const prompt = buildSagaAvatarProviderPrompt("silhouette");

    expect(prompt).toContain("helt anonym silhuett");
    expect(prompt).toContain("inte vara tydligt synliga samtidigt");
    expect(prompt).not.toContain("private://");
  });
});
