import { describe, expect, it } from "vitest";
import {
  canonicalResearchKey,
  clusterMeetsThreshold,
  countIndependentDomains,
  mediaEngineCheckInputSchema,
  mediaResearchEvidenceSchema,
  neverPublishHandoffMessage,
  normalizeIndependentDomain,
  normalizeSourceHostname,
} from "@/lib/domain/media-engine-pipeline";
import {
  isUnsafeMediaEngineAddress,
  isWithinResearchWindow,
  isStaleMediaEngineRun,
  isSensitiveMediaEngineSourceQueryParameter,
  hasMaterialMediaResearchItemChange,
  enforceMediaEngineEvidenceBoundary,
  isHandoffSnapshotDossierActivated,
  mediaEngineEvidencePosture,
  nextCronOccurrence,
  prioritizeResearchClusters,
  publicMediaEngineApiHeaders,
  safeMediaEngineRedirectInit,
  selectResearchClustersForRun,
} from "@/lib/services/media-engine-pipeline";

const evidence = (url: string) => mediaResearchEvidenceSchema.parse({
  sourceName: new URL(url).hostname,
  sourceUrl: url,
  sourceDomain: new URL(url).hostname,
  sourceType: "secondary",
  publishedAt: "2026-08-23T09:00:00.000Z",
  eventDate: null,
  claim: "Källan rapporterar en konkret, verifierbar förändring.",
  stance: "supports",
  quote: null,
  confidence: 70,
});

describe("Media Engine research trigger", () => {
  it("räknar oberoende normaliserade domäner, inte antal artiklar", () => {
    const repeatedPublisher = [
      evidence("https://www.reuters.com/world/a?utm_source=a"),
      evidence("https://reuters.com/world/b"),
      evidence("https://www.reuters.com/world/c"),
    ];
    expect(countIndependentDomains(repeatedPublisher)).toBe(1);
    expect(clusterMeetsThreshold({
      mentionCount: 3,
      evidence: repeatedPublisher,
      minMentions: 3,
      minUniqueDomains: 2,
    })).toBe(false);
  });

  it("triggar först när både omnämnanden och oberoende domäner räcker", () => {
    const independent = [
      evidence("https://reuters.com/world/a"),
      evidence("https://www.ft.com/content/b"),
      evidence("https://example.org/primary/c"),
    ];
    expect(countIndependentDomains(independent)).toBe(3);
    expect(clusterMeetsThreshold({
      mentionCount: 3,
      evidence: independent,
      minMentions: 3,
      minUniqueDomains: 2,
    })).toBe(true);
  });

  it("har en stabil, URL-oberoende ämnesnyckel och accepterar bara http-källor", () => {
    expect(canonicalResearchKey("OpenAI lanserar en ny modell")).toBe(canonicalResearchKey("  OPENAI lanserar en NY modell  "));
    expect(normalizeIndependentDomain("https://WWW.OpenAI.com/path")).toBe("openai.com");
    expect(normalizeIndependentDomain("https://uk.publisher.com/story")).toBe("publisher.com");
    expect(normalizeIndependentDomain("https://news.bbc.co.uk/world")).toBe("bbc.co.uk");
    expect(normalizeIndependentDomain("https://alice.github.io/post")).toBe("alice.github.io");
    expect(normalizeIndependentDomain("https://bob.github.io/post")).toBe("bob.github.io");
    expect(normalizeSourceHostname("https://ec.europa.eu/commission")).toBe("ec.europa.eu");
    expect(normalizeIndependentDomain("javascript:alert(1)")).toBeNull();
  });

  it("blockerar privata, loopback- och link-local-nät för användarkopplade källor", () => {
    expect(isUnsafeMediaEngineAddress("127.0.0.1")).toBe(true);
    expect(isUnsafeMediaEngineAddress("10.4.2.8")).toBe(true);
    expect(isUnsafeMediaEngineAddress("169.254.169.254")).toBe(true);
    expect(isUnsafeMediaEngineAddress("::1")).toBe(true);
    expect(isUnsafeMediaEngineAddress("::ffff:7f00:1")).toBe(true);
    expect(isUnsafeMediaEngineAddress("[::ffff:ac10:1]")).toBe(true);
    expect(isUnsafeMediaEngineAddress("8.8.8.8")).toBe(false);
    expect(isUnsafeMediaEngineAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("skickar aldrig miljöhemligheter till en tenantstyrd API-källa eller en extern redirect", () => {
    const key = "MEDIA_ENGINE_API_TOKEN_TENANT_A";
    const previous = process.env[key];
    process.env[key] = "must-never-leave-the-server";
    try {
      const publicHeaders = publicMediaEngineApiHeaders();
      expect(publicHeaders.get("authorization")).toBeNull();
      expect(publicHeaders.get("x-api-key")).toBeNull();
      expect([...publicHeaders.values()]).not.toContain(process.env[key]);

      const redirected = safeMediaEngineRedirectInit(
        { headers: { authorization: "Bearer must-never-leave-the-server", "x-api-key": "must-never-leave-the-server", cookie: "session=private" } },
        "https://trusted-provider.example/v1/search",
        "https://other-origin.example/collect",
      );
      const redirectedHeaders = new Headers(redirected.headers);
      expect(redirectedHeaders.get("authorization")).toBeNull();
      expect(redirectedHeaders.get("x-api-key")).toBeNull();
      expect(redirectedHeaders.get("cookie")).toBeNull();

      const sameOrigin = safeMediaEngineRedirectInit(
        { headers: { authorization: "Bearer retained-for-same-origin" } },
        "https://trusted-provider.example/v1/search",
        "https://trusted-provider.example/v1/next",
      );
      expect(new Headers(sameOrigin.headers).get("authorization")).toBe("Bearer retained-for-same-origin");
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });

  it("stoppar samma hemliga query-parametrar även om de kommer från en redirect", () => {
    expect(isSensitiveMediaEngineSourceQueryParameter("client_secret")).toBe(true);
    expect(isSensitiveMediaEngineSourceQueryParameter("access-token")).toBe(true);
    expect(isSensitiveMediaEngineSourceQueryParameter("sig")).toBe(true);
    expect(isSensitiveMediaEngineSourceQueryParameter("page")).toBe(false);
  });

  it("kräver en UUID-idempotensnyckel för varje manuellt check-now", () => {
    expect(mediaEngineCheckInputSchema.safeParse({
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }).success).toBe(true);
    expect(mediaEngineCheckInputSchema.safeParse({
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "inte-en-uuid",
    }).success).toBe(false);
  });

  it("gör säkerheten synlig: handoff betyder inte publicering", () => {
    expect(neverPublishHandoffMessage()).toMatch(/inte.*publicerat|Inget.*publicerat/i);
    expect(neverPublishHandoffMessage()).toMatch(/Studio/i);
  });

  it("låter inte gamla registerposter nå en ny regels tröskel", () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    expect(isWithinResearchWindow({ publishedAt: "2026-08-23T11:00:00.000Z", firstObservedAt: "2026-08-23T11:00:00.000Z", fetchedAt: "2026-08-23T12:00:00.000Z" }, 24, now)).toBe(true);
    // A recurring RSS-poll may fetch this old document today, but its original
    // publication time keeps it outside the trigger window.
    expect(isWithinResearchWindow({ publishedAt: "2026-08-01T11:00:00.000Z", firstObservedAt: "2026-08-01T11:00:00.000Z", fetchedAt: "2026-08-23T12:00:00.000Z" }, 24, now)).toBe(false);
    expect(isWithinResearchWindow({ publishedAt: null, firstObservedAt: "2026-08-01T11:00:00.000Z", fetchedAt: "2026-08-23T12:00:00.000Z" }, 24, now)).toBe(false);
  });

  it("öppnar inte ett färdigt kluster igen när samma dokument pollas på nytt", () => {
    const known = {
      contentHash: "samma-innehall",
      publishedAt: "2026-08-23T11:00:00.000Z",
      eventDate: "2026-08-23T10:00:00.000Z",
    };
    expect(hasMaterialMediaResearchItemChange(known, known)).toBe(false);
    expect(hasMaterialMediaResearchItemChange(known, {
      ...known,
      contentHash: "uppdaterat-innehall",
    })).toBe(true);
    expect(hasMaterialMediaResearchItemChange(known, {
      ...known,
      eventDate: "2026-08-24T10:00:00.000Z",
    })).toBe(true);
  });

  it("prioriterar nya pending-kluster före gamla ready-kluster inom dossiergränsen", () => {
    const ordered = prioritizeResearchClusters([
      { id: "ready-old", status: "ready" as const, lastSeenAt: "2026-08-20T10:00:00.000Z" },
      { id: "pending-new", status: "pending" as const, lastSeenAt: "2026-08-23T11:00:00.000Z" },
      { id: "dismissed", status: "dismissed" as const, lastSeenAt: "2026-08-23T12:00:00.000Z" },
    ]);
    expect(ordered.map((cluster) => cluster.id)).toEqual(["pending-new", "ready-old"]);
  });

  it("tar med en kvarvarande pending-kö även när nästa poll inte har nya dokument", () => {
    const backlog = { id: "deferred-pending", status: "pending" as const, lastSeenAt: "2026-08-23T10:00:00.000Z" };
    expect(selectResearchClustersForRun([], [backlog])).toEqual([backlog]);
    // A fresh material signal must still win when the bounded dossierbudget
    // is reached, without dropping the durable deferred item.
    const selected = selectResearchClustersForRun(
      [{ id: "fresh-pending", status: "pending" as const, lastSeenAt: "2026-08-23T12:00:00.000Z" }],
      [backlog],
    );
    expect(selected.map((cluster) => cluster.id)).toEqual(["fresh-pending", "deferred-pending"]);

    // The backlog reader only supplies `researching` records after their DB
    // lease has expired. They remain reclaimable even when the next source
    // poll contains no changed URLs.
    expect(selectResearchClustersForRun([], [{
      id: "expired-research", status: "researching" as const, lastSeenAt: "2026-08-23T09:00:00.000Z",
    }]).map((cluster) => cluster.id)).toEqual(["expired-research"]);
  });

  it("blockerar Studio-utkast från en provisorisk handoff före dossieraktivering", () => {
    const snapshot = { researchDossierId: "new-revision" };
    // Crashfönster: handoff finns redan, men den nya revisionen är fortfarande
    // draft/non-current. Den får aldrig bli ett Studio-utkast.
    expect(isHandoffSnapshotDossierActivated(snapshot, {
      id: "new-revision", status: "draft", is_current: false,
    })).toBe(false);
    // A completed older revision is still auditable. Its queued immutable
    // handoff may create one private draft even after a newer revision exists.
    expect(isHandoffSnapshotDossierActivated(snapshot, {
      id: "new-revision", status: "ready", is_current: false,
    })).toBe(true);
    expect(isHandoffSnapshotDossierActivated(snapshot, {
      id: "new-revision", status: "ready", is_current: true,
    })).toBe(true);
  });

  it("behandlar RSS, publika API:er och webbsökning som leads tills en verifierad registerkälla finns", () => {
    for (const sourceType of ["rss", "api", "web_search"] as const) {
      const posture = mediaEngineEvidencePosture(sourceType);
      expect(posture.unverifiedLead).toBe(true);
      expect(posture.stance).toBe("context");
      expect(posture.confidence("2026-08-23T11:00:00.000Z")).toBeLessThan(50);
    }
    expect(mediaEngineEvidencePosture("primary")).toMatchObject({ unverifiedLead: false, stance: "supports" });
  });

  it("låter inte en modell märka lead-only RSS/API/webbsökning som känt faktum", () => {
    const reflection = {
      whatWeKnow: ["Modellen påstår att detta är ett bekräftat faktum."],
      whatWeDontKnow: [],
      whyItMatters: "Det kan påverka prioriteringen om uppgiften senare verifieras.",
      suggestedAngle: "Förklara vad som måste verifieras före ett beslut.",
      reflection: "En källa kan vara relevant, men den är fortfarande en okontrollerad lead i denna version.",
      uncertainties: [],
      conflicts: [],
      imageBrief: "En neutral redaktionell researchmiljö utan text eller logotyper.",
    };
    const leadOnly = enforceMediaEngineEvidenceBoundary(reflection, [mediaResearchEvidenceSchema.parse({
      sourceName: "Exempelkälla",
      sourceUrl: "https://example.com/lead",
      sourceDomain: "example.com",
      sourceType: "rss",
      publishedAt: null,
      eventDate: null,
      claim: "Okontrollerad lead från en RSS-källa.",
      stance: "context",
      quote: null,
      confidence: 30,
    })]);
    expect(leadOnly.whatWeKnow).toEqual([]);
    expect(leadOnly.whatWeDontKnow.join(" ")).toMatch(/serververifierade/i);
    expect(leadOnly.uncertainties.join(" ")).toMatch(/serververifierade/i);
  });

  it("beräknar nästa faktiska 5-fälts cron-körning i arbetsytans tidszon", () => {
    // 2026-08-24 är en måndag. 06:30Z är 08:30 i Stockholm (CEST), så
    // nästa vardagskörning 09:00 lokal tid ska bli 07:00Z — inte en timme
    // efter senaste körningen.
    expect(nextCronOccurrence("0 9 * * 1-5", new Date("2026-08-24T06:30:00.000Z"), "Europe/Stockholm"))
      .toBe("2026-08-24T07:00:00.000Z");
  });

  it("återtar bara en avstannad körning, aldrig en färdig eller färsk receipt", () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    expect(isStaleMediaEngineRun({ state: "running", startedAt: "2026-08-23T11:44:59.000Z", createdAt: "2026-08-23T11:00:00.000Z" }, now)).toBe(true);
    expect(isStaleMediaEngineRun({ state: "running", startedAt: "2026-08-23T11:45:01.000Z", createdAt: "2026-08-23T11:00:00.000Z" }, now)).toBe(false);
    expect(isStaleMediaEngineRun({ state: "completed", startedAt: "2026-08-23T10:00:00.000Z", createdAt: "2026-08-23T10:00:00.000Z" }, now)).toBe(false);
  });
});
