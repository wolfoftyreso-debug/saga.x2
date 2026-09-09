import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  applyCalendarTestPlanOverrides,
  calendarStatusLabel,
  calendarErrorMessage,
  calendarPlacements,
  calendarWeek,
  createCalendarTestPlan,
  eventPosition,
  isCalendarConfigurationRequired,
  localDateTimeToUtcIso,
  parseCalendarPayload,
  parseUnscheduledDrafts,
  scheduleFieldsForCalendarPlacement,
  schedulePatchFor,
} from "@/components/saga-content-calendar";

describe("SAGA content calendar acceptance contract", () => {
  it("labels a scheduled time as SAGA planning, not as an external delivery", () => {
    expect(calendarStatusLabel("scheduled")).toBe("Planerad i SAGA");
    expect(calendarStatusLabel("publishing")).toBe("Extern leverans pågår");
    expect(calendarStatusLabel("published")).toBe("Extern leverans bekräftad");
    expect(calendarStatusLabel("failed")).toBe("Extern leverans misslyckades");
    expect(calendarStatusLabel("future_state")).toBe("Okänt statusläge");
  });

  it("keeps the published instant and the planning-zone wall-clock time together", () => {
    const calendar = parseCalendarPayload({
      calendar: {
        timezone: "Europe/Stockholm",
        entries: [{
          id: "draft:one",
          kind: "draft",
          title: "Provkörning i Sätra",
          status: "scheduled",
          channels: ["instagram"],
          startsAt: "2026-07-15T07:30:00.000Z",
          draftId: "11111111-1111-4111-8111-111111111111",
          editable: true,
          revision: 7,
          thumbnail: { assetUrl: "/api/content/drafts/one/media/two/asset", altText: "Elbil" },
          excerpt: "En kort, tydlig introduktion.",
        }],
      },
    });

    expect(calendar.timezone).toBe("Europe/Stockholm");
    expect(calendar.entries).toEqual([expect.objectContaining({
      startsAt: "2026-07-15T07:30:00.000Z",
      localDate: "2026-07-15",
      localTime: "09:30",
      revision: 7,
      thumbnail: { assetUrl: "/api/content/drafts/one/media/two/asset", altText: "Elbil" },
    })]);
  });

  it("uses a deliberate thumbnail fallback instead of manufacturing a media URL", () => {
    const calendar = parseCalendarPayload({
      timezone: "Europe/Stockholm",
      entries: [{
        id: "draft:no-media",
        title: "Utan bild",
        startsAt: "2026-01-15T08:00:00.000Z",
        draftId: "22222222-2222-4222-8222-222222222222",
        thumbnail: { altText: "Saknar URL" },
      }],
    });

    expect(calendar.entries[0]).toMatchObject({ thumbnail: null, localDate: "2026-01-15", localTime: "09:00" });
  });

  it("keeps unscheduled drafts visible in the real planning tray, without duplicating timed work", () => {
    const drafts = parseUnscheduledDrafts({
      drafts: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          title: "Vinterhjul och räckvidd",
          status: "in_review",
          channels: ["linkedin"],
          updatedAt: "2026-01-14T10:00:00.000Z",
          media: [{ assetUrl: "/api/content/drafts/three/media/four/asset", altText: "Bil i vintermiljö", processingStatus: "ready" }],
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          title: "Redan planerad",
          scheduledAt: "2026-01-15T08:00:00.000Z",
        },
      ],
    });

    expect(drafts).toEqual([expect.objectContaining({
      id: "33333333-3333-4333-8333-333333333333",
      thumbnail: { assetUrl: "/api/content/drafts/three/media/four/asset", altText: "Bil i vintermiljö" },
    })]);
  });

  it("makes a Swedish planning week stable across the DST boundary", () => {
    expect(calendarWeek("2026-03-29")).toEqual([
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
    expect(addCalendarDays("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("converts local time using the selected IANA zone and rejects a nonexistent DST time", () => {
    expect(localDateTimeToUtcIso("2026-01-15", "09:30", "Europe/Stockholm")).toBe("2026-01-15T08:30:00.000Z");
    expect(localDateTimeToUtcIso("2026-07-15", "09:30", "Europe/Stockholm")).toBe("2026-07-15T07:30:00.000Z");
    expect(() => localDateTimeToUtcIso("2026-03-29", "02:30", "Europe/Stockholm")).toThrow(/finns inte/i);
  });

  it("sends an atomic scheduling patch with the expected revision, never a client-side publish action", () => {
    expect(schedulePatchFor("2026-07-15", "09:30", "Europe/Stockholm", 7)).toEqual({
      scheduledAt: "2026-07-15T07:30:00.000Z",
      scheduledLocalDate: "2026-07-15",
      scheduledLocalTime: "09:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 7,
    });
  });

  it("keeps an entry's editorial timezone when a calendar view uses another timezone", () => {
    const calendar = parseCalendarPayload({
      calendar: {
        timezone: "Europe/Stockholm",
        entries: [{
          id: "draft:timezone",
          title: "Egen publiceringstid",
          startsAt: "2026-07-15T13:30:00.000Z",
          localDate: "2026-07-15",
          localTime: "15:30",
          scheduledLocalDate: "2026-07-15",
          scheduledLocalTime: "09:30",
          timezone: "America/New_York",
          draftId: "55555555-5555-4555-8555-555555555555",
          revision: 4,
          editable: true,
        }],
      },
    });
    const entry = calendar.entries[0];

    expect(entry).toMatchObject({
      localDate: "2026-07-15",
      localTime: "15:30",
      scheduledLocalDate: "2026-07-15",
      scheduledLocalTime: "09:30",
      scheduleTimezone: "America/New_York",
    });
    expect(scheduleFieldsForCalendarPlacement("2026-07-15", "16:00", calendar.timezone, entry.scheduleTimezone)).toEqual({
      scheduledLocalDate: "2026-07-15",
      scheduledLocalTime: "10:00",
    });
    expect(schedulePatchFor("2026-07-15", "10:00", entry.scheduleTimezone, entry.revision ?? undefined)).toMatchObject({
      timezone: "America/New_York",
      scheduledAt: "2026-07-15T14:00:00.000Z",
      expectedRevision: 4,
    });
  });

  it("keeps provider and database implementation names out of calendar failures", () => {
    expect(calendarErrorMessage({ error: "Neon database connection failed" }, "Kalendern kunde inte laddas.")).toBe("Arbetsytan behöver vara redo innan sparat innehåll kan visas.");
    expect(calendarErrorMessage({ code: "configuration_missing", error: "A secret is missing" }, "Kalendern kunde inte laddas.")).toBe("Arbetsytan behöver vara redo innan sparat innehåll kan visas.");
  });

  it("only swaps a missing workspace configuration for the browser-only test plan", () => {
    expect(isCalendarConfigurationRequired({ code: "configuration_required" })).toBe(true);
    expect(isCalendarConfigurationRequired({ code: "database_configuration_invalid" })).toBe(true);
    expect(isCalendarConfigurationRequired({ code: "authentication_required" })).toBe(false);
    expect(isCalendarConfigurationRequired({ error: "A temporary network failure" })).toBe(false);
  });

  it("keeps test-plan content explicitly non-persistent and without made-up media", () => {
    const plan = createCalendarTestPlan(new Date("2026-08-25T10:00:00.000Z"), "Europe/Stockholm");

    expect(plan).toMatchObject({ timezone: "Europe/Stockholm" });
    expect(plan.entries).toHaveLength(5);
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "test-plan:time-back",
        localDate: "2026-08-24",
        localTime: "09:30",
        localOnly: true,
        editable: true,
        draftId: null,
        thumbnail: null,
      }),
    ]));
    expect(plan.entries.every((entry) => entry.localOnly && entry.draftId === null && entry.thumbnail === null && entry.revision === null)).toBe(true);
  });

  it("moves a test post in memory without creating a scheduling patch or a draft", () => {
    const plan = createCalendarTestPlan(new Date("2026-08-25T10:00:00.000Z"), "Europe/Stockholm");
    const moved = applyCalendarTestPlanOverrides(plan, {
      "test-plan:time-back": {
        startsAt: "2026-08-28T12:00:00.000Z",
        localDate: "2026-08-28",
        localTime: "14:00",
      },
    });

    expect(moved.entries.find((entry) => entry.id === "test-plan:time-back")).toMatchObject({
      localDate: "2026-08-28",
      localTime: "14:00",
      draftId: null,
      localOnly: true,
    });
  });

  it("places precise-time cards at their true minute offset rather than only on the day", () => {
    expect(eventPosition({ localTime: "09:30" }, 7, 1)).toEqual({ top: 150, height: 52 });
  });

  it("puts overlapping posts in separate lanes without making later independent posts needlessly narrow", () => {
    const entry = (id: string, localDate: string, localTime: string) => ({
      id,
      kind: "draft" as const,
      title: id,
      status: "scheduled",
      channels: ["instagram"] as const,
      startsAt: "2026-07-15T07:00:00.000Z",
      localDate,
      localTime,
      scheduledLocalDate: localDate,
      scheduledLocalTime: localTime,
      scheduleTimezone: "Europe/Stockholm",
      editable: true,
      thumbnail: null,
      excerpt: "",
      revision: 1,
      draftId: "55555555-5555-4555-8555-555555555555",
      automationRuleId: null,
    });
    const placements = calendarPlacements([
      entry("first", "2026-07-15", "09:00"),
      entry("second", "2026-07-15", "09:30"),
      entry("later", "2026-07-15", "11:00"),
      entry("other-day", "2026-07-16", "09:00"),
    ], 7);

    const first = placements.find((placement) => placement.entry.id === "first");
    const second = placements.find((placement) => placement.entry.id === "second");
    const later = placements.find((placement) => placement.entry.id === "later");
    const otherDay = placements.find((placement) => placement.entry.id === "other-day");
    expect(first).toMatchObject({ lane: 0, laneCount: 2 });
    expect(second).toMatchObject({ lane: 1, laneCount: 2 });
    expect(later).toMatchObject({ lane: 0, laneCount: 1 });
    expect(otherDay).toMatchObject({ lane: 0, laneCount: 1 });
  });
});
