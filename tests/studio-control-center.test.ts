import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioControlCenter, type StudioControlCenterState } from "@/components/studio-control-center";

const ready: StudioControlCenterState = {
  mode: "ready",
  actor: { displayName: "Erik", role: "owner" },
  checkedAt: "2026-08-26T08:30:00.000Z",
    workspace: { name: "Privat arbetsyta", timezone: "Europe/Stockholm" },
    brandEntry: {
      status: "completed",
      brandProfileId: "11111111-1111-4111-8111-111111111111",
      brandName: "Systembyggarna",
    },
    counts: {
    members: 1,
    drafts: 6,
    waitingForReview: 2,
    scheduled: 3,
    activeAutomations: 1,
    pendingJobs: 1,
    media: 8,
  },
};

describe("Studio control center", () => {
  it("puts a real review decision ahead of aggregate status and routes to the calendar", () => {
    const html = renderToStaticMarkup(createElement(StudioControlCenter, { state: ready }));

    expect(html).toContain("Granska 2 utkast.");
    expect(html).toContain("Öppna granskningskön");
    expect(html).toContain('href="/studio/calendar"');
    expect(html).toContain("Verifieringsstatus.");
    expect(html).toContain("Privat arbetsyta");
    expect(html).toContain("Körningar i kö");
    expect(html).toContain("Annonsstudio");
    expect(html).toContain("Aktivitetsplan");
    expect(html).toContain('href="/studio/plan?brandProfileId=11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/studio/create"');
    expect(html).toContain("Klar: Systembyggarna");
  });

  it("sends an otherwise ready workspace without a completed brand to onboarding instead of authoring", () => {
    const html = renderToStaticMarkup(createElement(StudioControlCenter, {
      state: { ...ready, brandEntry: { status: "missing" }, counts: { ...ready.counts, drafts: 0 } },
    }));

    expect(html).toContain("Sätt riktningen före innehållet.");
    expect(html).toContain("Starta varumärkesonboarding");
    expect(html).toContain('href="/studio/brands/new"');
    expect(html).not.toContain('href="/studio/create"');
  });

  it("never invents a selected brand when the workspace has several eligible brands", () => {
    const html = renderToStaticMarkup(createElement(StudioControlCenter, {
      state: {
        ...ready,
        brandEntry: {
          status: "selection_required",
          brands: [
            { brandProfileId: "22222222-2222-4222-8222-222222222222", brandName: "Systembyggarna" },
            { brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Verkstaden" },
          ],
        },
      },
    }));

    expect(html).toContain("Välj vilken varumärkesgrund du ska arbeta i.");
    expect(html).toContain('href="/studio/create"');
    expect(html).not.toContain("brandProfileId=22222222-2222-4222-8222-222222222222");
    expect(html).not.toContain("brandProfileId=33333333-3333-4333-8333-333333333333");
  });

  it("renders the pipeline without inventing work when a saved workspace cannot be read", () => {
    const html = renderToStaticMarkup(createElement(StudioControlCenter, { state: { mode: "database_unconfigured" } }));

    expect(html).toContain("Anslut arbetsytan först.");
    expect(html).toContain("Inga sparade utkast, planer eller körningar kan visas här.");
    expect(html).toContain("Ej verifierat");
    expect(html).not.toContain("0 sparade utkast");
    expect(html).toContain('href="/settings"');
  });
});
