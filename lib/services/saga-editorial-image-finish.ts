import "server-only";

import sharp from "sharp";
import { executionAbortSignal, executionTimeRemainingMs } from "@/lib/server/execution-deadline";

/**
 * A deliberately small, deterministic finishing pass for generated stills.
 *
 * It only adjusts global tone/saturation and overlays low-opacity monochrome
 * grain. It never crops, resizes, redraws, masks, restores, or changes any
 * subject, face, body, product or scene geometry.
 */
export const SAGA_EDITORIAL_IMAGE_FINISH_VERSION = "saga-editorial-image-finish/v1" as const;

const MAX_FINISH_PIXELS = 4_000_000;
const MAX_FINISHED_IMAGE_BYTES = 20 * 1024 * 1024;

export type SagaEditorialImageFinishInput = {
  bytes: Uint8Array;
  contentType: "image/png";
};

export type SagaEditorialImageFinishResult = {
  bytes: Uint8Array;
  contentType: "image/png";
  version: typeof SAGA_EDITORIAL_IMAGE_FINISH_VERSION;
};

export class SagaEditorialImageFinishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SagaEditorialImageFinishError";
  }
}

/**
 * Applies an intentionally restrained editorial finish after a Gateway image
 * has passed the PNG signature boundary. The byte-derived seed makes grain
 * stable for a given source image, which keeps production retries auditable.
 */
export async function applySagaEditorialImageFinish(
  input: SagaEditorialImageFinishInput,
): Promise<SagaEditorialImageFinishResult> {
  if (input.contentType !== "image/png" || input.bytes.byteLength === 0) {
    throw new SagaEditorialImageFinishError("SAGA kan bara efterbehandla en giltig privat PNG-bild.");
  }

  const source = Buffer.from(input.bytes);
  try {
    executionAbortSignal();
    const metadata = await sharp(source, { limitInputPixels: MAX_FINISH_PIXELS, failOn: "error" }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height || width * height > MAX_FINISH_PIXELS) {
      throw new SagaEditorialImageFinishError("SAGA:s bild är för stor för den återhållsamma redaktionella efterbehandlingen.");
    }

    const grain = createDeterministicGrainOverlay(width, height, seedFor(source));
    executionAbortSignal();
    const result = await sharp(source, { limitInputPixels: MAX_FINISH_PIXELS, failOn: "error" })
      // libvips can stop active CPU processing; the following cancellation
      // check also prevents any Blob write if queued work outlived its budget.
      .timeout({ seconds: Math.max(1, Math.min(10, Math.floor(executionTimeRemainingMs() / 1_000))) })
      .modulate({ brightness: 0.99, saturation: 0.91 })
      .composite([{
        input: grain,
        raw: { width, height, channels: 4 },
        blend: "soft-light",
      }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    executionAbortSignal();

    if (result.byteLength === 0 || result.byteLength > MAX_FINISHED_IMAGE_BYTES) {
      throw new SagaEditorialImageFinishError("SAGA:s efterbehandlade bild ryms inte i den privata bildgränsen.");
    }

    return {
      bytes: new Uint8Array(result),
      contentType: "image/png",
      version: SAGA_EDITORIAL_IMAGE_FINISH_VERSION,
    };
  } catch (error) {
    executionAbortSignal();
    if (error instanceof SagaEditorialImageFinishError) throw error;
    throw new SagaEditorialImageFinishError(
      "SAGA kunde inte lägga den återhållsamma redaktionella finishen på bilden. Ingen bild lagrades.",
    );
  }
}

/** No text, symbols or geometry are introduced: only a nearly transparent tonal grain field. */
function createDeterministicGrainOverlay(width: number, height: number, initialSeed: number): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  let seed = initialSeed;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const shade = 119 + ((seed >>> 24) % 19);
    pixels[offset] = shade;
    pixels[offset + 1] = shade;
    pixels[offset + 2] = shade;
    pixels[offset + 3] = 9;
  }
  return pixels;
}

function seedFor(bytes: Uint8Array): number {
  let seed = 2_166_136_261;
  const sampleStride = Math.max(1, Math.floor(bytes.byteLength / 4_096));
  for (let index = 0; index < bytes.byteLength; index += sampleStride) {
    seed ^= bytes[index] ?? 0;
    seed = Math.imul(seed, 16_777_619) >>> 0;
  }
  return seed || 1;
}
