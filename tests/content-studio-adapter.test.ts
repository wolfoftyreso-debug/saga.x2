import { describe, expect, it } from "vitest";
import {
  calendarFromPayload,
  createEmptyStudioData,
  draftFrom,
  isDeliveryLockedPrivateBrief,
  isQuarterlyPrivateReviewDraft,
  mediaFromPayload,
  newsletterAudiencesFromPayload,
  newsletterDeliveryStatusFromPayload,
  socialChannelsFromPayload,
  studioBackendReadiness,
} from "@/components/content-studio-adapter";

describe("Content Studio API-adapter", () => {
  it("skapar en ny, deterministisk preflight-snapshot för varje första render", () => {
    const first = createEmptyStudioData();
    first.backendState = "unavailable";
    first.newsletterDelivery.missing.push("DATABASE_URL");

    expect(createEmptyStudioData()).toMatchObject({
      backendState: "checking",
      backendIssue: null,
      loaded: false,
      channelLoadState: "loading",
      newsletterDelivery: { configured: false, missing: [] },
    });
  });

  it("läser den riktiga kalenderns inkapslade svar utan att skapa egna poster", () => {
    const entries = calendarFromPayload({
      calendar: {
        entries: [{
          id: "draft:4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
          kind: "draft",
          title: "Veckans signal",
          status: "in_review",
          startsAt: "2026-08-25T07:00:00.000Z",
          channels: ["linkedin"],
          draftId: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
          automationRuleId: null,
        }],
      },
    });

    expect(entries).toEqual([expect.objectContaining({
      draftId: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
      startAt: "2026-08-25T07:00:00.000Z",
      status: "in_review",
    })]);
  });

  it("bevarar utkastets serverrevision för säkra samtidiga redigeringar", () => {
    const draft = draftFrom({
      id: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
      revision: 7,
      contentType: "social_post",
      channels: ["linkedin"],
    });

    expect(draft?.revision).toBe(7);
    expect(draftFrom({ id: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d", revision: 0 })?.revision).toBeNull();
  });

  it("gör ett servermarkerat privat annonsbrief skrivskyddat redan i klientadaptern", () => {
    const draft = draftFrom({
      id: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
      deliveryLocked: true,
      privateBrief: true,
    });

    expect(draft).toMatchObject({ deliveryLocked: true, privateBrief: true });
    expect(isDeliveryLockedPrivateBrief(draft!)).toBe(true);
    expect(isDeliveryLockedPrivateBrief({ deliveryLocked: false, privateBrief: false })).toBe(false);
    // A partial server response must still fail closed rather than exposing
    // the normal editor after only one immutable lock marker arrives.
    expect(isDeliveryLockedPrivateBrief({ deliveryLocked: true, privateBrief: false })).toBe(true);
  });

  it("känner igen ett servermarkerat privat kvartalsutkast utan att läsa rå metadata", () => {
    const draft = draftFrom({
      id: "4a2e75d8-6d4d-4a1b-a8ea-2604ed629c4d",
      quarterlyPrivateReview: true,
    });

    expect(draft).toMatchObject({ quarterlyPrivateReview: true });
    expect(isQuarterlyPrivateReviewDraft(draft!)).toBe(true);
    expect(isQuarterlyPrivateReviewDraft({ quarterlyPrivateReview: false })).toBe(false);
    expect(isQuarterlyPrivateReviewDraft({ quarterlyPrivateReview: true, status: "approved" })).toBe(false);
    expect(isQuarterlyPrivateReviewDraft({ quarterlyPrivateReview: true, status: "cancelled" })).toBe(false);
  });

  it("använder API:ts säkra signerat-förhandsformat för media", () => {
    const media = mediaFromPayload({
      media: {
        id: "76d361b4-ea3d-4a6c-aa3a-8b7cf57f5956",
        assetUrl: "https://storage.example.test/signed-image.jpg",
        altText: "En redaktionell bild",
        processingStatus: "ready",
      },
    });

    expect(media).toEqual([expect.objectContaining({
      url: "https://storage.example.test/signed-image.jpg",
      alt: "En redaktionell bild",
      state: "ready",
    })]);
  });

  it("exponerar bara mottagarlistans säkra sammanfattning", () => {
    const audiences = newsletterAudiencesFromPayload({
      audiences: [{
        audienceId: "76862e37-749b-4e10-9d55-b84cdbb4fbdd",
        audienceName: "Kunder i Norden",
        audienceActive: true,
        subscribedCount: 42,
      }],
    });

    expect(audiences).toEqual([expect.objectContaining({
      id: "76862e37-749b-4e10-9d55-b84cdbb4fbdd",
      name: "Kunder i Norden",
      active: true,
      contactCount: 42,
      subscribedCount: 42,
    })]);
  });

  it("visar leveransen som ofärdig när konfiguration saknas", () => {
    expect(newsletterDeliveryStatusFromPayload({ configured: false, missing: ["RESEND_API_KEY", "NEWSLETTER_FROM"] })).toEqual({
      configured: false,
      missing: ["RESEND_API_KEY", "NEWSLETTER_FROM"],
    });
  });

  it("behåller OAuth-startlänken när ett konto behöver logga in igen", () => {
    const [channel] = socialChannelsFromPayload({
      channels: [{
        channel: "instagram",
        configured: true,
        connectUrl: "/api/social/connections/instagram_professional/connect?returnTo=/studio",
        canPublish: false,
        missing: [],
        connections: [{
          id: "connection-1",
          state: "needs_reauth",
          accountLabel: "Eriks konto",
          lastVerifiedAt: "2026-08-22T07:00:00.000Z",
        }],
      }],
    });

    expect(channel).toMatchObject({
      kind: "instagram",
      state: "needs_reauth",
      connectUrl: "/api/social/connections/instagram_professional/connect?returnTo=/studio",
    });
  });

  it("skickar med exakt vilka inställningar som saknas för en oanvändbar kanal", () => {
    const [channel] = socialChannelsFromPayload({
      channels: [{
        channel: "linkedin",
        configured: false,
        connectUrl: null,
        canPublish: false,
        missing: ["SOCIAL_OAUTH_BASE_URL", "LINKEDIN_CLIENT_ID"],
        connections: [],
      }],
    });

    expect(channel).toMatchObject({
      kind: "linkedin",
      state: "unavailable",
      connectUrl: null,
      missingConfiguration: ["SOCIAL_OAUTH_BASE_URL", "LINKEDIN_CLIENT_ID"],
    });
  });

  it("låser Studio tills en riktig innehållsbackend är tillgänglig", () => {
    const unconfigured = studioBackendReadiness([
      { ok: false, data: { error: "Databaskopplingen saknas.", code: "configuration_required", missing: ["NEXT_PUBLIC_SUPABASE_URL"] }, establishesPersistence: true },
      { ok: false, data: { error: "Sociala konton är inte konfigurerade ännu.", code: "configuration_required", missing: ["SUPABASE_SERVICE_ROLE_KEY"] }, establishesPersistence: false },
    ]);
    expect(unconfigured).toEqual({
      state: "unconfigured",
      issue: {
        message: "Databaskopplingen saknas.",
        missingConfiguration: ["NEXT_PUBLIC_SUPABASE_URL"],
      },
    });

    expect(studioBackendReadiness([
      { ok: true, data: { drafts: [] }, establishesPersistence: true },
      { ok: false, data: { code: "configuration_required", missing: ["LINKEDIN_CLIENT_ID"] }, establishesPersistence: false },
    ])).toEqual({ state: "ready", issue: null });
  });
});
