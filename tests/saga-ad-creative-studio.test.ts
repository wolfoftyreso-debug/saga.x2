import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SagaAdCreativeStudio } from "@/components/saga-ad-creative-studio";

describe("SAGA Ad Creative Studio", () => {
  it("renders a private format-first production surface, not a fake delivery console", () => {
    const html = renderToStaticMarkup(createElement(SagaAdCreativeStudio));
    expect(html).toContain("En idé. Rätt material för varje format.");
    expect(html).toContain("FORMATBIBLIOTEK");
    expect(html).toContain("EGET FORMAT");
    expect(html).toContain("Material, inte medieköp");
    expect(html).toContain("Google Display");
    expect(html).toContain("Tidningsannons");
    expect(html).toContain("Affisch");
    expect(html).not.toContain("Publicera annons");
  });
});
