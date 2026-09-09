import { describe, expect, it } from "vitest";
import {
  allowedDomainsForPolicy,
  evaluateSourceEvidence,
  filterSourcesByPolicy,
  mergeSourcePolicies,
  type SourcePolicyRecord,
} from "@/lib/domain/source-catalog";
import { canAttemptWatchDelivery, nextWatchDeliveryAttempt, shouldCreateBriefRecord, shouldDeliverBriefToConversation, watchMatchesMaterialChange } from "@/lib/domain/watch-delivery";
import { discoveryInstructions } from "@/lib/openai/prompts";
import { DEFAULT_PROFILE_SETTINGS, type Source } from "@/lib/domain/types";

const officialSource: Source = {
  sourceName: "Europeiska kommissionen",
  url: "https://ec.europa.eu/commission/presscorner/example",
  sourceType: "primary",
  publishedAt: "2026-08-18",
  eventDate: "2026-08-18",
  supportsClaim: "Officiellt beslut beskriver den antagna förändringen.",
};

function policy(domain: string, overrides: Partial<SourcePolicyRecord> = {}): SourcePolicyRecord {
  return {
    domain,
    sourceName: domain,
    sourceKind: "editorial",
    active: true,
    blocked: false,
    priority: "normal",
    roles: ["discovery", "verification", "citation"],
    topicFilter: "",
    verificationRequirement: "verify_material",
    frequency: "material",
    ...overrides,
  };
}

describe("källpolicy körs som regler, inte bara UI", () => {
  it("sorterar högprioriterade källor först och tar bort dagliga/veckovisa källor ur bevakningspass", () => {
    const policies = [
      policy("reuters.com", { priority: "low", frequency: "daily" }),
      policy("ec.europa.eu", { priority: "high", frequency: "material" }),
      policy("apnews.com", { priority: "normal", frequency: "weekly" }),
    ];
    const briefDomains = allowedDomainsForPolicy(policies, {
      roles: "discovery",
      purpose: "brief",
      now: new Date("2026-08-16T08:00:00Z"), // Sunday in Stockholm
      timezone: "Europe/Stockholm",
    });
    const watchDomains = allowedDomainsForPolicy(policies, {
      roles: "discovery",
      purpose: "watch",
      now: new Date("2026-08-16T08:00:00Z"),
      timezone: "Europe/Stockholm",
    });
    expect(briefDomains.indexOf("ec.europa.eu")).toBeLessThan(briefDomains.indexOf("reuters.com"));
    expect(briefDomains).toContain("reuters.com");
    expect(briefDomains).not.toContain("apnews.com");
    expect(watchDomains).toContain("ec.europa.eu");
    expect(watchDomains).not.toContain("reuters.com");
    expect(watchDomains).not.toContain("apnews.com");
  });

  it("använder ämnesfilter för det publicerade underlaget", () => {
    const aiOnly = [policy("ec.europa.eu", { topicFilter: "AI, modeller" })];
    expect(filterSourcesByPolicy([officialSource], aiOnly, "verification", "Nya AI-regler för modeller")).toHaveLength(1);
    expect(filterSourcesByPolicy([officialSource], aiOnly, "verification", "Ändrade jordbruksstöd i EU")).toHaveLength(0);
  });

  it("håller isär verifiering och citering", () => {
    const verificationOnly = [policy("ec.europa.eu", { roles: ["verification"] })];
    const result = evaluateSourceEvidence([officialSource], verificationOnly, "EU-regler för AI");
    expect(result.verificationSatisfied).toBe(true);
    expect(result.citationSatisfied).toBe(false);

    const citationOnly = [policy("ec.europa.eu", { roles: ["citation"] })];
    const citationResult = evaluateSourceEvidence([officialSource], citationOnly, "EU-regler för AI");
    expect(citationResult.verificationSatisfied).toBe(false);
  });

  it("kräver extra oberoende stöd när alla beviskällor är lågprioriterade", () => {
    const lowPriority = [policy("ec.europa.eu", { priority: "low" })];
    const result = evaluateSourceEvidence([officialSource], lowPriority, "EU-regler för AI");
    expect(result.verificationSatisfied).toBe(false);
  });

  it("låter en briefspecifik override ärva osatta fält från global policy", () => {
    const merged = mergeSourcePolicies(
      [policy("reuters.com", { priority: "high", roles: ["discovery", "citation"] })],
      [{ domain: "reuters.com", blocked: true }],
    );
    const reuters = merged.find((entry) => entry.domain === "reuters.com");
    expect(reuters).toMatchObject({ blocked: true, priority: "high", roles: ["discovery", "citation"] });
  });
});

describe("tyst brief och bevakningsleverans", () => {
  it("respekterar only_when_changed", () => {
    expect(shouldDeliverBriefToConversation(0, true)).toBe(false);
    expect(shouldDeliverBriefToConversation(0, false)).toBe(true);
    expect(shouldDeliverBriefToConversation(1, true)).toBe(true);
    expect(shouldCreateBriefRecord(0, true)).toBe(false);
    expect(shouldCreateBriefRecord(0, false)).toBe(true);
  });

  it("retryar endast när raden är förfallen och med stigande backoff", () => {
    const now = new Date("2026-08-18T08:00:00Z");
    expect(canAttemptWatchDelivery({ state: "pending", attemptCount: 0, nextAttemptAt: null, claimedAt: null }, now)).toBe(true);
    expect(canAttemptWatchDelivery({ state: "failed", attemptCount: 1, nextAttemptAt: "2026-08-18T08:10:00Z", claimedAt: null }, now)).toBe(false);
    expect(canAttemptWatchDelivery({ state: "delivering", attemptCount: 1, nextAttemptAt: null, claimedAt: "2026-08-18T07:40:00Z" }, now)).toBe(true);
    expect(nextWatchDeliveryAttempt(1, now)).toBe("2026-08-18T08:00:30.000Z");
  });

  it("låter changed betyda en verklig materialförändring, inte varje post", () => {
    expect(watchMatchesMaterialChange({ triggerStatuses: ["changed"], onlyMaterialChange: true, nextStatus: "adopted", updateKind: "impact_change" })).toBe(true);
    expect(watchMatchesMaterialChange({ triggerStatuses: ["changed"], onlyMaterialChange: true, nextStatus: "announced", updateKind: "new_event" })).toBe(true);
    expect(watchMatchesMaterialChange({ triggerStatuses: ["changed"], onlyMaterialChange: true, nextStatus: "adopted", updateKind: "no_material_change" })).toBe(false);
    expect(watchMatchesMaterialChange({ triggerStatuses: ["effective"], onlyMaterialChange: true, nextStatus: "effective", updateKind: "status_change" })).toBe(true);
  });
});

describe("profilstyrda discovery-instruktioner", () => {
  it("antar inte längre en hårdkodad person eller teknikprofil", () => {
    const prompt = discoveryInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      coverageFrom: "2026-08-17T07:00:00Z",
      now: "2026-08-18T07:00:00Z",
      briefInstructions: "Följ restaurangöppningar och fotboll i Göteborg.",
      personalContext: { interests: ["fotboll", "mat"], markets: ["Göteborg"] },
      sourcePolicyGuidance: "[]",
    });
    expect(prompt).not.toContain("Användaren är Erik");
    expect(prompt).toContain("Anta aldrig ett visst namn");
    expect(prompt).toContain("restaurangöppningar och fotboll i Göteborg");
  });
});
