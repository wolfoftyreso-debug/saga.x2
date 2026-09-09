import { describe, expect, it } from "vitest";
import {
  canDeliverDirectAlertNow,
  DEFAULT_FLOW_CONTROLS,
  flowControlsSchema,
  isWithinQuietHours,
  resolvePrimaryBriefModules,
} from "@/lib/domain/flow-controls";
import { collectMarketSnapshot } from "@/lib/services/market-data";

describe("flödeskontroller", () => {
  it("behåller alla nuvarande huvudmoduler på som standard", () => {
    expect(DEFAULT_FLOW_CONTROLS.modules).toEqual({
      worldPulse: true,
      weeklyRecap: true,
      strategicRadar: true,
      marketSnapshot: true,
      companyFocus: true,
    });
    expect(DEFAULT_FLOW_CONTROLS.alerts.enabled).toBe(true);
  });

  it("validerar ett fullständigt och tydligt modulval", () => {
    const controls = structuredClone(DEFAULT_FLOW_CONTROLS);
    controls.modules.worldPulse = false;
    controls.modules.companyFocus = false;
    controls.alerts.quietHours.enabled = true;
    controls.alerts.quietHours.start = "21:30";
    controls.alerts.quietHours.end = "06:45";
    expect(flowControlsSchema.safeParse(controls).success).toBe(true);
  });

  it("gör modulvalet till ett faktiskt runner-kontrakt", () => {
    const controls = structuredClone(DEFAULT_FLOW_CONTROLS);
    controls.modules.worldPulse = false;
    controls.modules.marketSnapshot = false;
    expect(resolvePrimaryBriefModules(true, controls)).toEqual({
      worldPulse: false,
      weeklyRecap: true,
      strategicRadar: true,
      marketSnapshot: false,
      companyFocus: false,
    });
    expect(resolvePrimaryBriefModules(false, controls)).toEqual({
      worldPulse: false,
      weeklyRecap: false,
      strategicRadar: false,
      marketSnapshot: false,
      companyFocus: false,
    });
  });

  it("avvisar ett aktiverat tystnadsfönster utan verkligt slut", () => {
    const controls = structuredClone(DEFAULT_FLOW_CONTROLS);
    controls.alerts.quietHours.enabled = true;
    controls.alerts.quietHours.start = "22:00";
    controls.alerts.quietHours.end = "22:00";
    expect(flowControlsSchema.safeParse(controls).success).toBe(false);
  });

  it("tolkar tystnad över midnatt i användarens tidszon", () => {
    const controls = structuredClone(DEFAULT_FLOW_CONTROLS);
    controls.alerts.quietHours.enabled = true;
    controls.alerts.quietHours.start = "22:00";
    controls.alerts.quietHours.end = "07:00";
    expect(isWithinQuietHours(controls, "Europe/Stockholm", new Date("2026-01-12T22:30:00.000Z"))).toBe(true); // 23:30 CET
    expect(isWithinQuietHours(controls, "Europe/Stockholm", new Date("2026-01-13T06:30:00.000Z"))).toBe(false); // 07:30 CET
  });

  it("håller vanliga direktnotiser under tystnad men kan släppa ett tillåtet systemiskt undantag", () => {
    const controls = structuredClone(DEFAULT_FLOW_CONTROLS);
    controls.alerts.quietHours.enabled = true;
    controls.alerts.quietHours.start = "22:00";
    controls.alerts.quietHours.end = "07:00";
    const now = new Date("2026-01-12T22:30:00.000Z"); // 23:30 CET
    expect(canDeliverDirectAlertNow({ controls, timezone: "Europe/Stockholm", systemicOverride: false, now })).toBe(false);
    expect(canDeliverDirectAlertNow({ controls, timezone: "Europe/Stockholm", systemicOverride: true, now })).toBe(true);
    controls.alerts.quietHours.allowSystemicDuringQuietHours = false;
    expect(canDeliverDirectAlertNow({ controls, timezone: "Europe/Stockholm", systemicOverride: true, now })).toBe(false);
  });

  it("hämtar inga bolagskurser när bolagsfokusmodulen är avstängd", async () => {
    const snapshot = await collectMarketSnapshot({
      now: new Date("2026-08-22T05:00:00.000Z"),
      apiKey: "",
      includeCompanyFocus: false,
    });
    expect(snapshot.instruments.map((instrument) => instrument.id)).toEqual([
      "omxs30",
      "sp500",
      "nasdaq_composite",
      "stoxx_europe_600",
      "usd_sek",
      "eur_sek",
    ]);
  });
});
