import { describe, expect, it } from "vitest";
import { parseCalendarPayload } from "@/components/saga-content-calendar";

describe("SAGA calendar thumbnail safety", () => {
  it("renders only the protected same-origin draft media route", () => {
    const calendar = parseCalendarPayload({
      calendar: {
        timezone: "Europe/Stockholm",
        entries: [
          {
            id: "protected", startsAt: "2026-09-01T07:00:00.000Z", localDate: "2026-09-01", localTime: "09:00",
            thumbnail: { assetUrl: "/api/content/drafts/draft-one/media/media-one/asset", altText: "Skyddad bild" },
          },
          {
            id: "blob", startsAt: "2026-09-01T08:00:00.000Z", localDate: "2026-09-01", localTime: "10:00",
            thumbnail: { assetUrl: "blob:https://example.test/a81bf", altText: "Rå Blob" },
          },
          {
            id: "external", startsAt: "2026-09-01T09:00:00.000Z", localDate: "2026-09-01", localTime: "11:00",
            thumbnail: { assetUrl: "https://storage.example.test/signed.jpg", altText: "Extern bild" },
          },
        ],
      },
    });

    expect(calendar.entries.map((entry) => entry.thumbnail?.assetUrl ?? null)).toEqual([
      "/api/content/drafts/draft-one/media/media-one/asset",
      null,
      null,
    ]);
  });
});
