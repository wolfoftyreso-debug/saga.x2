import { z } from "zod";

export const imageAdaptationTargetSchema = z.enum(["instagram", "facebook_page", "linkedin", "newsletter"]);
export type ImageAdaptationTarget = z.infer<typeof imageAdaptationTargetSchema>;

export const imageAdaptationInputSchema = z.object({
  target: imageAdaptationTargetSchema,
  instruction: z.string().trim().max(1_500).default(""),
  preserveSubject: z.boolean().default(true),
  outputStyle: z.enum(["natural", "editorial", "clean_product", "illustrated"]).default("editorial"),
});

export type ImageAdaptationInput = z.input<typeof imageAdaptationInputSchema>;

export type ImageAdaptationPreset = {
  target: ImageAdaptationTarget;
  size: "1024x1536" | "1536x1024";
  label: string;
  use: string;
};

export function imageAdaptationPreset(target: ImageAdaptationTarget): ImageAdaptationPreset {
  if (target === "instagram") {
    return { target, size: "1024x1536", label: "Porträtt", use: "Instagram-inlägg" };
  }
  if (target === "newsletter") {
    return { target, size: "1536x1024", label: "Bred", use: "nyhetsbrev" };
  }
  return { target, size: "1536x1024", label: "Bred", use: target === "linkedin" ? "LinkedIn-inlägg" : "Facebook-inlägg" };
}

export const allowedImageContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_CONTENT_IMAGE_BYTES = 20 * 1024 * 1024;

export function isAllowedContentImage(contentType: string, byteLength: number): boolean {
  return allowedImageContentTypes.has(contentType) && byteLength > 0 && byteLength <= MAX_CONTENT_IMAGE_BYTES;
}
