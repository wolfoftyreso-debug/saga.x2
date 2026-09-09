import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SagaPreviewGallery, SAGA_PREVIEW_EXAMPLES, type SagaPreviewImageAssets } from "@/components/saga-preview-gallery";

const demoImages: SagaPreviewImageAssets = {
  instagram: "/demo/saga/automation-human-work-v1.png",
  linkedin: "/demo/saga/automation-human-work-v1.png",
  newsletter: "/demo/saga/automation-human-work-v1.png",
  article: "/demo/saga/automation-human-work-v1.png",
  family: "/demo/saga/automation-human-work-v1.png",
};

describe("SagaPreviewGallery", () => {
  it("renders four finished, cross-channel examples with local project media", () => {
    const html = renderToStaticMarkup(createElement(SagaPreviewGallery, { images: demoImages }));

    expect(SAGA_PREVIEW_EXAMPLES).toHaveLength(4);
    expect(new Set(SAGA_PREVIEW_EXAMPLES.map((example) => example.channel))).toEqual(new Set(["instagram", "linkedin", "newsletter", "article"]));
    expect(html).toContain("Systembyggaren");
    expect(html).toContain("När systemet bär repetitionen får livet mer plats.");
    expect(html).toContain("Bra system tar hand om friktionen. Människor tar hand om det viktiga.");
    expect(html).toContain("Ett mindre manuellt moment i taget.");
    expect(html).toContain("Vi är inte skapta för att göra en maskins arbete.");
    expect(html).toContain("/demo/saga/automation-human-work-v1.png");
    expect(html).not.toContain("Sätra Elbilshus");
    expect(html).not.toContain("provkörning");
  });

  it("keeps each channel's copy personal, grounded and distinct", () => {
    const byId = Object.fromEntries(SAGA_PREVIEW_EXAMPLES.map((example) => [example.id, example]));

    expect(byId["maskinens-jobb"].copy.paragraphs).toContain("Jag bygger inte automation för att pressa in mer i dagen. Jag bygger den för att plocka bort sådant som aldrig behövde ligga på en människa från början.");
    expect(byId["friktion-fore-funktion"].copy.cta).toBe("Vilka återkommande moment skulle ni kunna bygga bort utan att bygga bort omdömet?");
    expect(byId["system-slapper"].copy.paragraphs).toContain("Automatisera först det som är tydligt. Låt resten vara synligt tills ni vet att det fungerar. Då blir förändringen mindre dramatisk – och lättare att lita på.");
    expect(byId["frihet-att-bygga"].copy.paragraphs).toContain("Den tid som frigörs behöver inte fyllas med mer arbete. Den kan gå till ett bygge, middag med människor man tycker om, en promenad i skogen eller ett problem som faktiskt behöver ens närvaro.");
  });

  it("makes it unambiguous that the route is a non-persistent example gallery", () => {
    const html = renderToStaticMarkup(createElement(SagaPreviewGallery, { images: demoImages }));

    expect(html).toContain("EXEMPELGALLERI · AUTOMATION AV MÄNSKLIGT ARBETE");
    expect(html).toContain("Inte en förhandsvisning av ditt utkast");
    expect(html).toContain("Systembyggaren är en exempelprofil, inte ett anslutet konto.");
    expect(html).toContain("Ett referensexempel – inte ett sparat utkast.");
    expect(html).toContain("Det kan inte sparas, planeras eller publiceras härifrån.");
    expect(html).toContain("REFERENS &amp; RIKTNING");
    expect(html).toContain("Inga externa nyhets- eller produktpåståenden används.");
    expect(html).toContain("Det visar inte ett schemalagt inlägg.");
    expect(html).not.toContain("Justera visningstiden");
    expect(html).not.toContain("Lokalt visningsdatum");
    expect(html).not.toContain("Lokal visningstid");
  });

  it("keeps the preview route static and free from a production-only dead end", () => {
    const source = readFileSync(resolve(process.cwd(), "app/preview/page.tsx"), "utf8");
    const component = readFileSync(resolve(process.cwd(), "components/saga-preview-gallery.tsx"), "utf8");

    expect(source).toContain('dynamic = "force-static"');
    expect(source).not.toContain("notFound");
    expect(component).not.toMatch(/\bfetch\s*\(/);
    expect(component).not.toMatch(/\/api\//);
    expect(component).not.toMatch(/localStorage|sessionStorage/);
  });

  it("does not include a local planning control that could be mistaken for scheduling", () => {
    const source = readFileSync(resolve(process.cwd(), "components/saga-preview-gallery.tsx"), "utf8");

    expect(source).not.toContain('type="date"');
    expect(source).not.toContain('type="time"');
    expect(source).not.toContain("localSchedule");
    expect(source).not.toContain("formatSagaPreviewDate");
  });
});
