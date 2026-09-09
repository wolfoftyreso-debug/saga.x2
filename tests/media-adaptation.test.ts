import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_IMAGE_BYTES,
  imageAdaptationPreset,
  isAllowedContentImage,
} from "@/lib/domain/media-adaptation";

describe("bildanpassning för publiceringskanaler", () => {
  it("väljer ett porträttformat för Instagram och ett brett format för övriga", () => {
    expect(imageAdaptationPreset("instagram")).toMatchObject({ size: "1024x1536", label: "Porträtt" });
    expect(imageAdaptationPreset("linkedin")).toMatchObject({ size: "1536x1024", label: "Bred" });
  });

  it("släpper bara igenom rimliga bildformat och storlekar", () => {
    expect(isAllowedContentImage("image/jpeg", 1)).toBe(true);
    expect(isAllowedContentImage("image/svg+xml", 1)).toBe(false);
    expect(isAllowedContentImage("image/png", MAX_CONTENT_IMAGE_BYTES + 1)).toBe(false);
  });
});
