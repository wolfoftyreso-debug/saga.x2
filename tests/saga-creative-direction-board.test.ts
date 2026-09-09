import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SagaCreativeDirectionBoard, SAGA_SEASONAL_TYRE_STORYBOARDS } from "@/components/saga-creative-direction-board";

describe("SagaCreativeDirectionBoard", () => {
  it("turns the seasonal tyre idea into three timed short-form storyboards", () => {
    const html = renderToStaticMarkup(createElement(SagaCreativeDirectionBoard));

    expect(SAGA_SEASONAL_TYRE_STORYBOARDS).toHaveLength(3);
    expect(SAGA_SEASONAL_TYRE_STORYBOARDS.map((direction) => direction.format)).toEqual([
      "Vertikal 9:16 · Reels / Stories",
      "Vertikal 9:16 · Reels / Stories",
      "Vertikal 9:16 · Reels / Stories",
    ]);
    expect(SAGA_SEASONAL_TYRE_STORYBOARDS[0]?.beats.map((beat) => beat.id)).toEqual(["hook", "reveal", "value", "offer", "cta"]);
    expect(html).toContain("Från uppmärksamhet till bokning — utan att skapa fara.");
    expect(html).toContain("Hook");
    expect(html).toContain("Avslöja");
    expect(html).toContain("Värde");
    expect(html).toContain("Erbjudande");
    expect(html).toContain("CTA");
  });

  it("uses a contained visual metaphor and blocks unsafe production directions", () => {
    const lead = SAGA_SEASONAL_TYRE_STORYBOARDS[0];
    const html = renderToStaticMarkup(createElement(SagaCreativeDirectionBoard));

    expect(lead?.beats[0]?.visual).toContain("låst display");
    expect(lead?.beats[1]?.copy).toBe("Men ditt däckbyte behöver inte överraska.");
    expect(lead?.safetyNote).toContain("Ingen lös eller fallande rekvisita");
    expect(html).toContain("inte en nära-olycka eller en risksituation");
    expect(html).toContain("Visa aldrig lösa hjul, fallhöjd, trafik, aktiva verktyg eller människor nära något riskfyllt.");
    expect(html).toContain("Erbjudande kräver verifiering");
    expect(html).toContain("aldrig skrämsel, skuld eller påståenden som inte kan styrkas");
  });

  it("keeps the seasonal tyre storyboard separate from the automation reference gallery", () => {
    const gallery = readFileSync(resolve(process.cwd(), "components/saga-preview-gallery.tsx"), "utf8");
    const board = readFileSync(resolve(process.cwd(), "components/saga-creative-direction-board.tsx"), "utf8");

    expect(gallery).not.toContain("<SagaCreativeDirectionBoard />");
    expect(board).not.toMatch(/\bfetch\s*\(/);
    expect(board).not.toMatch(/\/api\//);
    expect(board).not.toMatch(/localStorage|sessionStorage/);
  });
});
