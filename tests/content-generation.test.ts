import { describe, expect, it } from "vitest";
import {
  contentGenerationInputSchema,
  generatedContentResponseSchema,
  wordRangeForTargetLength,
} from "@/lib/domain/content-generation";

describe("AI-utkast för innehållsstudion", () => {
  it("kräver ämne och minst en målkanal", () => {
    expect(contentGenerationInputSchema.safeParse({ contentType: "social_post", channels: [], topic: "AI" }).success).toBe(false);
    expect(contentGenerationInputSchema.safeParse({ contentType: "social_post", channels: ["linkedin"], topic: "AI-roadmap" }).success).toBe(true);
  });

  it("har en strikt, komplett utkastform", () => {
    const result = generatedContentResponseSchema.safeParse({
      draft: {
        title: "Ett nytt arbetssätt",
        headline: "En sak att ändra denna vecka",
        subject: "En sak att ändra denna vecka",
        previewText: "En konkret idé för veckan.",
        body: "Det här är ett rakt utkast som går att redigera innan publicering.",
        excerpt: "En konkret idé för veckan.",
        callToAction: "Spara idén och testa den i veckan.",
        hashtags: ["#AI"],
        imagePrompt: "Redaktionell arbetsmiljö med en person vid ett skrivbord, utan text.",
        altText: "En person arbetar vid ett skrivbord.",
      },
    });
    expect(result.success).toBe(true);
  });

  it("gör längdkravet begripligt", () => {
    expect(wordRangeForTargetLength("short")).toBe("40–90 ord");
    expect(wordRangeForTargetLength("medium")).toBe("130–240 ord");
    expect(wordRangeForTargetLength("long")).toBe("280–500 ord");
  });
});
