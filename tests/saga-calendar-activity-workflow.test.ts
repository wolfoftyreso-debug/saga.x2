import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCalendarTestPlan,
  parseCalendarPayload,
  scheduleFieldsForCalendarPlacement,
  schedulePatchFor,
} from "@/components/saga-content-calendar";

function calendarSource() {
  return readFileSync(resolve(process.cwd(), "components/saga-content-calendar.tsx"), "utf8");
}

describe("SAGA calendar activity workflow", () => {
  it("keeps a post's editorial timezone distinct from the timezone used to draw the calendar", () => {
    const calendar = parseCalendarPayload({
      calendar: {
        timezone: "America/New_York",
        entries: [{
          id: "draft:timezone-safe",
          kind: "draft",
          title: "Ett tidszonssäkert utkast",
          startsAt: "2026-07-15T07:30:00.000Z",
          localDate: "2026-07-15",
          localTime: "03:30",
          scheduledLocalDate: "2026-07-15",
          scheduledLocalTime: "09:30",
          timezone: "Europe/Stockholm",
          draftId: "11111111-1111-4111-8111-111111111111",
          revision: 7,
          editable: true,
        }],
      },
    });

    expect(calendar.entries[0]).toMatchObject({
      localDate: "2026-07-15",
      localTime: "03:30",
      scheduledLocalDate: "2026-07-15",
      scheduledLocalTime: "09:30",
      scheduleTimezone: "Europe/Stockholm",
    });

    // 09:30 in a New York calendar is 15:30 in Stockholm that summer day.
    expect(scheduleFieldsForCalendarPlacement(
      "2026-07-15",
      "09:30",
      "America/New_York",
      "Europe/Stockholm",
    )).toEqual({ scheduledLocalDate: "2026-07-15", scheduledLocalTime: "15:30" });
  });

  it("keeps a time move revision-protected and contains no publishing instruction", () => {
    expect(schedulePatchFor("2026-07-15", "15:30", "Europe/Stockholm", 7)).toEqual({
      scheduledAt: "2026-07-15T13:30:00.000Z",
      scheduledLocalDate: "2026-07-15",
      scheduledLocalTime: "15:30",
      timezone: "Europe/Stockholm",
      expectedRevision: 7,
    });

    const source = calendarSource();
    expect(source).toContain('method: "PATCH"');
    expect(source).toContain("schedulePatchFor(nextDate, nextTime, entry.scheduleTimezone, entry.revision ?? undefined)");
    expect(source).toContain("scheduleFieldsForCalendarPlacement(date, time, activeTimezone, entry.scheduleTimezone)");
    expect(source).toContain("response.status === 409");
    expect(source).toContain("Inlägget har ändrats på annat håll. Kalendern laddades om");
    expect(source).toContain("void loadCalendar(range)");
    expect(source).not.toMatch(/method:\s*["']POST["'][\s\S]{0,120}publish/i);
  });

  it("makes every activity an ordinary keyboard-operable button with a named details panel", () => {
    const source = calendarSource();

    // Native buttons deliberately provide Enter and Space behaviour without a
    // fragile duplicate key handler. The inspector is explicitly named and
    // linked from the card, making the relationship clear to assistive tech.
    expect(source).toMatch(/function CalendarCard[\s\S]*?return <button[\s\S]*?type="button"[\s\S]*?onClick=\{\(\) => onSelect\(entry\)\}/);
    expect(source).toContain('aria-controls="calendar-inspector"');
    expect(source).toContain('id="calendar-inspector"');
    expect(source).toContain('aria-label="Detaljpanel"');
    expect(source).toContain('aria-expanded={selected}');
  });

  it("keeps the inspector a complete route back to preview, editing and a controlled schedule", () => {
    const source = calendarSource();

    expect(source).toContain('const draftHref = entry.draftId ? `/studio/content/${encodeURIComponent(entry.draftId)}` : null;');
    expect(source).toContain('href={draftHref}');
    expect(source).toContain('href={`${draftHref}?edit=1`}');
    expect(source).toContain(">Förhandsvisa");
    expect(source).toContain(">Redigera");
    expect(source).toContain("<input type=\"date\"");
    expect(source).toContain("<input type=\"time\"");
    expect(source).toContain("onSubmit={onSubmit}");
    expect(source).toContain('aria-label="Stäng detaljer"');
  });

  it("keeps the local Testplan honestly local, including after a schedule override", () => {
    const plan = createCalendarTestPlan(new Date("2026-08-25T10:00:00.000Z"), "Europe/Stockholm");

    expect(plan.entries).toHaveLength(5);
    expect(plan.entries.every((entry) => (
      entry.localOnly === true
      && entry.draftId === null
      && entry.revision === null
      && entry.thumbnail === null
      && entry.scheduleTimezone === "Europe/Stockholm"
    ))).toBe(true);

    const source = calendarSource();
    expect(source).toContain("Testplan · sparas inte");
    expect(source).toContain("Ingenting sparas eller skickas vidare.");
    // Test-plan moves stay above the only network PATCH branch.
    expect(source.indexOf("if (entry.localOnly) {")).toBeLessThan(source.indexOf('method: "PATCH"'));
  });
});
