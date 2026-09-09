import { z } from "zod";

export const contentGenerationChannelSchema = z.enum(["facebook_page", "instagram", "linkedin", "newsletter"]);
export const contentGenerationTypeSchema = z.enum(["social_post", "newsletter", "article"]);
export const contentLengthSchema = z.enum(["short", "medium", "long"]);

/**
 * This is deliberately a portable input, rather than a database row. The same
 * copy engine can create a manual draft, an automation draft or a revision
 * without gaining write access to any of them.
 */
export const contentGenerationInputSchema = z.object({
  contentType: contentGenerationTypeSchema,
  channels: z.array(contentGenerationChannelSchema).min(1).max(4),
  topic: z.string().trim().min(3, "Skriv vad innehållet ska handla om.").max(2_000),
  brief: z.string().trim().max(6_000).default(""),
  voice: z.string().trim().max(280).default("Rak, varm och konkret svenska."),
  targetLength: contentLengthSchema.default("medium"),
  templateInstructions: z.string().trim().max(2_000).default(""),
  desiredCallToAction: z.string().trim().max(300).default(""),
  avoid: z.string().trim().max(1_000).default(""),
  imageDirection: z.string().trim().max(1_000).default(""),
  language: z.literal("sv").default("sv"),
});

export type ContentGenerationInput = z.input<typeof contentGenerationInputSchema>;

export const generatedContentSchema = z.object({
  title: z.string().trim().min(1).max(140),
  headline: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(160),
  previewText: z.string().trim().max(180),
  body: z.string().trim().min(1).max(12_000),
  excerpt: z.string().trim().max(320),
  callToAction: z.string().trim().max(220),
  hashtags: z.array(z.string().trim().min(2).max(80)).max(10),
  imagePrompt: z.string().trim().max(1_500),
  altText: z.string().trim().max(500),
});

export type GeneratedContent = z.infer<typeof generatedContentSchema>;

export const generatedContentResponseSchema = z.object({
  draft: generatedContentSchema,
});

export function wordRangeForTargetLength(value: z.infer<typeof contentLengthSchema>): string {
  if (value === "short") return "40–90 ord";
  if (value === "long") return "280–500 ord";
  return "130–240 ord";
}
