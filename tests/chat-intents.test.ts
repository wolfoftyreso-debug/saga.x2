import { describe, expect, it } from "vitest";
import { parseDeterministicChatIntent } from "@/lib/domain/chat-intents";

describe("strukturerade chattintentioner", () => {
  it("tolkar en uttrycklig källblockering utan att behöva en modell", () => {
    const intent = parseDeterministicChatIntent("Blockera CNN som källa.");
    expect(intent).toMatchObject({ kind: "source_update", operation: "block", sourceQuery: "cnn.com" });
  });

  it("tolkar uttalade källroller", () => {
    const intent = parseDeterministicChatIntent("Använd Reuters bara för verifiering och citering.");
    expect(intent).toMatchObject({ kind: "source_update", operation: "update", sourceQuery: "reuters.com" });
    expect(intent?.sourceRoles).toEqual(["verification", "citation"]);
  });

  it("skapar en veckobrief med ämne och angiven tid", () => {
    const intent = parseDeterministicChatIntent("Skapa en veckobrief om europeisk AI-reglering på måndag kl 08:30.");
    expect(intent).toMatchObject({
      kind: "brief_create",
      operation: "create",
      briefName: "europeisk AI-reglering",
      briefCadence: "weekly",
      briefLocalTime: "08:30",
      briefWeekday: 0,
    });
  });

  it("begär förtydligande för en osäker bevakning utan händelsekontext", () => {
    const intent = parseDeterministicChatIntent("Bevaka detta");
    expect(intent).toMatchObject({ kind: "clarify", operation: "none" });
  });

  it("kopplar en bevakning till den händelse som användaren redan ser", () => {
    const intent = parseDeterministicChatIntent("Bevaka detta när det träder i kraft", "7e84c092-1a41-431c-af1a-07db3c3ad876");
    expect(intent).toMatchObject({ kind: "event_watch_create", operation: "create", triggerStatuses: ["effective"] });
  });

  it("gör ämnesprioriteringar till en avgränsad profiländring", () => {
    const intent = parseDeterministicChatIntent("Visa mindre allmän amerikansk börsdata.");
    expect(intent).toMatchObject({ kind: "weight_adjust", operation: "decrease", weightColumn: "usa_weight", weightDelta: -15 });
  });

  it("lämnar vanliga frågor till den vanliga chatten", () => {
    expect(parseDeterministicChatIntent("Vad innebär den senaste EU-regeln för mig?")).toBeNull();
  });
});
