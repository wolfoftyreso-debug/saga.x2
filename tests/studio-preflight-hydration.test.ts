import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentStudio } from "@/components/content-studio";

describe("Studio preflight hydration", () => {
  it("renders the same explicit checking state in the server preview", () => {
    const html = renderToStaticMarkup(createElement(ContentStudio, { route: "home" }));

    expect(html).toContain("Kontrollerar");
    expect(html).toContain("Kontrollerar arbetsytan…");
    expect(html).not.toContain("Inställning krävs");
    expect(html).not.toContain("Studio behöver en riktig arbetsyta.");
  });
});
