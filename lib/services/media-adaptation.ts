import "server-only";
import { toFile } from "openai";
import {
  imageAdaptationInputSchema,
  imageAdaptationPreset,
  isAllowedContentImage,
  type ImageAdaptationInput,
  type ImageAdaptationTarget,
} from "@/lib/domain/media-adaptation";
import { getOpenAIClient, MissingOpenAIConfigurationError } from "@/lib/openai/client";
import { sagaDocumentaryImagePromptBaseline } from "@/lib/services/saga-visual-art-direction";

export class MediaAdaptationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MediaAdaptationError";
  }
}

export type AdaptedImage = {
  bytes: Buffer;
  contentType: "image/png";
  target: ImageAdaptationTarget;
  preset: ReturnType<typeof imageAdaptationPreset>;
  model: string;
  appliedPrompt: string;
};

/**
 * Produces a new derivative. The caller must keep the original image intact
 * and persist the returned bytes as a separate attachment/version.
 */
export async function adaptContentImage(input: {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
  userId: string;
  options: ImageAdaptationInput;
}): Promise<AdaptedImage> {
  const options = imageAdaptationInputSchema.parse(input.options);
  if (!isAllowedContentImage(input.contentType, input.bytes.byteLength)) {
    throw new MediaAdaptationError("Bilden måste vara JPG, PNG eller WebP och högst 20 MB.", 400);
  }

  const preset = imageAdaptationPreset(options.target);
  const appliedPrompt = buildAdaptationPrompt(options, preset);
  try {
    const source = await toFile(input.bytes, safeFileName(input.fileName), { type: input.contentType });
    const response = await getOpenAIClient().images.edit({
      // Keep this separately configurable. GPT Image 2 supports generation and
      // editing in the current OpenAI API; callers can pin an approved model.
      model: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
      image: source,
      prompt: appliedPrompt,
      size: preset.size,
      quality: "medium",
      output_format: "png",
      user: input.userId,
    });
    const encoded = response.data?.at(0)?.b64_json;
    if (!encoded) throw new MediaAdaptationError("Bildtjänsten gav ingen sparbar bild. Originalet är oförändrat.", 502);
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.byteLength) throw new MediaAdaptationError("Bildtjänsten gav en tom bild. Originalet är oförändrat.", 502);
    return {
      bytes,
      contentType: "image/png",
      target: options.target,
      preset,
      model: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
      appliedPrompt,
    };
  } catch (error) {
    if (error instanceof MediaAdaptationError) throw error;
    if (error instanceof MissingOpenAIConfigurationError) {
      throw new MediaAdaptationError("Bildförbättring är inte konfigurerad ännu. Lägg till OPENAI_API_KEY först.", 503);
    }
    throw new MediaAdaptationError("Bilden kunde inte förbättras just nu. Originalet är kvar oförändrat.", 502);
  }
}

function buildAdaptationPrompt(
  input: ReturnType<typeof imageAdaptationInputSchema.parse>,
  preset: ReturnType<typeof imageAdaptationPreset>,
): string {
  const preserve = input.preserveSubject
    ? "Behåll motivet, personernas identitet, produktens form och bildens centrala budskap."
    : "Behåll bara de element som behövs för en trovärdig bild enligt anvisningen."
  const userInstruction = input.instruction ? `Extra riktning från användaren: ${input.instruction}` : "Ingen ytterligare kreativ riktning.";
  return `Anpassa den uppladdade bilden för ${preset.use} i ${preset.label} bildformat. Stil: ${input.outputStyle}. Förbättra ljus, kontrast, beskärning och lugn redaktionell tydlighet utan att skapa falska påståenden eller innehåll som ser ut som en verklig nyhetshändelse. ${preserve} Anpassa kompositionen till formatet och lämna rimlig luft runt motivet. ${userInstruction}

Följ alltid denna serverägda visuella riktning:
${sagaDocumentaryImagePromptBaseline()}`;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "content-image";
}
