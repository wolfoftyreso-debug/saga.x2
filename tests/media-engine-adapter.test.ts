import { describe, expect, it } from "vitest";
import { mediaEngineFromPayload } from "@/components/media-engine-adapter";

describe("Media Engine UI-adapter", () => {
  it("kopplar det riktiga översiktssvaret till research, evidens och handoff utan exempeldata", () => {
    const snapshot = mediaEngineFromPayload({
      tenant: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Eriks arbetsyta",
        slug: "eriks-arbetsyta",
        role: "owner",
        timezone: "Europe/Stockholm",
      },
      configuration: { ready: true, missing: [] },
      sources: [{
        id: "22222222-2222-4222-8222-222222222222",
        kind: "api",
        provider: "News API",
        displayName: "Marknadskälla",
        baseUrl: "https://example.test/news",
        active: true,
      }],
      rules: [{
        id: "33333333-3333-4333-8333-333333333333",
        name: "AI i Europa",
        query: "AI regulation",
        includeDomains: ["ec.europa.eu"],
        sourceIds: ["22222222-2222-4222-8222-222222222222"],
        minMentions: 3,
        minUniqueDomains: 2,
        windowHours: 24,
        contentType: "social_post",
        channels: ["linkedin", "instagram"],
        frameworkKey: "transparent-analysis",
        imageStyle: "editorial",
        scheduleMode: "threshold",
        cadence: "hourly",
        approvalRequired: true,
        active: true,
      }],
      clusters: [{
        id: "44444444-4444-4444-8444-444444444444",
        title: "Nya AI-regler",
        status: "ready",
        mentionCount: 4,
        uniqueDomainCount: 3,
        summary: "Underlaget har passerat regeln.",
      }],
      dossiers: [{
        id: "55555555-5555-4555-8555-555555555555",
        clusterId: "44444444-4444-4444-8444-444444444444",
        status: "ready",
        reflection: {
          whatWeKnow: ["EU har publicerat ett verifierbart beslut."],
          whatWeDontKnow: ["Exakt praktisk tillämpning saknas fortfarande."],
          whyItMatters: "Det påverkar hur produktteam behöver dokumentera sina system.",
          suggestedAngle: "Vad beslutet faktiskt ändrar för mindre teknikbolag.",
          reflection: "Skilj det beslutade från vad som ännu är oklart.",
          uncertainties: ["Tillämpningsdatum kan förändras."],
          conflicts: ["Två sekundärkällor beskriver omfattningen olika."],
          imageBrief: "Saklig redaktionell bild av regelverk och arbete.",
        },
        evidence: [{
          sourceName: "EU-kommissionen",
          sourceUrl: "https://ec.europa.eu/example",
          sourceDomain: "ec.europa.eu",
          sourceType: "primary",
          publishedAt: "2026-08-23T08:00:00.000Z",
          eventDate: "2026-08-22T00:00:00.000Z",
          claim: "Det officiella dokumentet bekräftar beslutet.",
          stance: "supports",
        }],
      }],
      handoffs: [{
        id: "66666666-6666-4666-8666-666666666666",
        clusterId: "44444444-4444-4444-8444-444444444444",
        state: "queued",
        contentDraftId: null,
        draftSnapshot: {
          contentType: "social_post",
          frameworkKey: "transparent-analysis",
          imageBrief: "Saklig redaktionell bild av regelverk och arbete.",
          approvalRequired: true,
        },
      }],
      runs: [{
        id: "77777777-7777-4777-8777-777777777777",
        state: "completed",
        startedAt: "2026-08-23T09:00:00.000Z",
        finishedAt: "2026-08-23T09:01:00.000Z",
        stats: { sourceCount: 1, clusterCount: 1 },
      }],
    });

    expect(snapshot.tenant?.name).toBe("Eriks arbetsyta");
    expect(snapshot.sources[0]).toMatchObject({ kind: "api", status: "active" });
    expect(snapshot.rules[0]).toMatchObject({ domains: ["ec.europa.eu"], channels: ["linkedin", "instagram"], cadence: "hourly" });
    expect(snapshot.clusters[0]?.dossier).toMatchObject({
      whatWeKnow: "EU har publicerat ett verifierbart beslut.",
      conflicts: ["Två sekundärkällor beskriver omfattningen olika."],
    });
    expect(snapshot.clusters[0]?.dossier?.evidence[0]).toMatchObject({
      url: "https://ec.europa.eu/example",
      supportsClaim: "Det officiella dokumentet bekräftar beslutet.",
      stance: "supports",
    });
    expect(snapshot.clusters[0]?.handoff).toMatchObject({
      status: "queued",
      frameworkKey: "transparent-analysis",
      approvalRequired: true,
    });
    expect(snapshot.runs[0]).toMatchObject({ status: "completed", sourceCount: 1, clusterCount: 1 });
  });
});
