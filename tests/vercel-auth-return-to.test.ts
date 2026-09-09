import { describe, expect, it } from "vitest";
import { safeRelativeReturnTo } from "@/lib/auth/vercel-oauth";

describe("OAuth return addresses stay inside the app", () => {
  it.each([
    undefined, null, "", "studio", "?next=/studio", "#studio",
    "https://outside.example/path", "http://outside.example", "javascript:alert(1)",
    "https://saga-return-to.invalid/studio", " https://outside.example", " /studio",
    "//outside.example", "///outside.example", "//user:password@outside.example",
    "/\\outside.example", "\\\\outside.example", "/\\/outside.example",
    "/studio\\..\\..\\outside.example", "/\t/outside.example", "/\n/outside.example", "/\r/outside.example",
    "/studio\u0000", "/studio\u007f", "/studio?next=\n//outside.example",
    "/%5coutside.example", "/%5C%2Foutside.example", "/%2foutside.example", "/%2F%2Foutside.example",
    "/%0a/outside.example", "/%00outside.example", "/%7foutside.example", "/malformed%encoding",
    "/studio/..//outside.example", "/studio/%2e%2e//outside.example", "/.//outside.example",
  ])("rejects unsafe or ambiguous return address %j", (value) => {
    expect(safeRelativeReturnTo(value)).toBe("/");
  });

  it.each([
    ["/", "/"],
    ["/studio", "/studio"],
    ["/studio/content/new?edit=1", "/studio/content/new?edit=1"],
    ["/studio/calendar?from=2026-09-09&timezone=Europe%2FStockholm#week", "/studio/calendar?from=2026-09-09&timezone=Europe%2FStockholm#week"],
    ["/studio?website=https%3A%2F%2Fexample.org", "/studio?website=https%3A%2F%2Fexample.org"],
    ["/studio?filter=one%20two&filter=three#section", "/studio?filter=one%20two&filter=three#section"],
    ["/studio/./calendar", "/studio/calendar"],
    ["/studio/content/../calendar", "/studio/calendar"],
    ["/studio/%2e%2e/calendar", "/calendar"],
    ["/studio/rävar", "/studio/r%C3%A4var"],
    ["/studio/item%2Fpart", "/studio/item%2Fpart"],
    ["/studio#https://example.org", "/studio#https://example.org"],
  ])("preserves and safely normalizes internal return address %j", (input, expected) => {
    const result = safeRelativeReturnTo(input);
    expect(result).toBe(expected);
    expect(safeRelativeReturnTo(result)).toBe(result);
    for (const origin of ["https://preview.example.test", "https://app.example.test:8443", "http://localhost:3010"]) {
      expect(new URL(result, origin).origin).toBe(origin);
    }
  });

  it("applies the same protection after next-query decoding and when a saved cookie is revalidated", () => {
    const supplied = new URL("https://preview.example.test/api/auth/authorize?next=%2F%5Coutside.example").searchParams.get("next");
    expect(supplied).toBe("/\\outside.example");
    const storedReturnTo = safeRelativeReturnTo(supplied);
    expect(new URL(safeRelativeReturnTo(storedReturnTo), "https://preview.example.test").href).toBe("https://preview.example.test/");
  });
});
