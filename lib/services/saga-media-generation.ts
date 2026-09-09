import "server-only";

import { z } from "zod";
import { executionAbortSignal, executionTimeRemainingMs } from "@/lib/server/execution-deadline";
import {
  SagaCreativeSafetyError,
  buildSagaCreativePromptPolicy,
  sagaCreativeBriefSchema,
  type SagaCreativePromptPolicy,
} from "@/lib/services/saga-creative-safety";
import {
  SAGA_EDITORIAL_IMAGE_FINISH_VERSION,
  applySagaEditorialImageFinish,
} from "@/lib/services/saga-editorial-image-finish";
import {
  buildSagaVisualArtDirectionPolicy,
  type SagaVisualArtDirectionPolicy,
} from "@/lib/services/saga-visual-art-direction";
import {
  MissingVercelBlobConfigurationError,
  VercelBlobMediaError,
  missingVercelBlobConfiguration,
  uploadStudioBlob,
  type StudioBlobContentType,
  type StudioBlobScope,
  type TrustedStudioBlobPath,
  type UploadedStudioBlob,
} from "@/lib/vercel/blob-media";
import {
  InvalidSagaImageGatewayModelConfigurationError,
  createAiGatewayClient,
  missingAiGatewayConfiguration,
  resolveSagaImageGatewayModel,
} from "@/lib/vercel/ai-gateway";

const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The dedicated media worker has a short Vercel lease. Do not inherit the
 * SDK's long default timeout or hidden retries: a durable Neon receipt owns
 * the retry state and must be able to reclaim a timed-out run safely.
 */
export const SAGA_MEDIA_GENERATION_TIMEOUT_MS = 35_000;

const uuidSchema = z.string().uuid();
const outputSchema = z.object({
  aspectRatio: z.enum(["square", "portrait", "landscape"]).default("portrait"),
  altText: z.string().trim().min(2).max(500),
  /** A label only. Blob still creates the opaque server-side path. */
  label: z.string().trim().min(2).max(96).default("saga-editorial"),
}).strict();

/**
 * This input is worker-owned. A browser route must first authenticate a user,
 * resolve the workspace + draft server-side, and create a durable run before
 * invoking it. No workspace ID, Blob path or model is accepted by this service.
 */
export const sagaPrivateMediaGenerationInputSchema = z.object({
  /** Stable job/run ID supplied by the durable production worker. */
  runId: uuidSchema,
  scope: z.object({ workspaceId: uuidSchema, draftId: uuidSchema }).strict(),
  creativeBrief: sagaCreativeBriefSchema,
  output: outputSchema,
}).strict();

export type SagaPrivateMediaGenerationInput = z.input<typeof sagaPrivateMediaGenerationInputSchema>;
type ParsedSagaPrivateMediaGenerationInput = z.output<typeof sagaPrivateMediaGenerationInputSchema>;

export type SagaMediaGenerationConfiguration = {
  model: string;
};

export type SagaGatewayImageGenerationRequest = {
  model: string;
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024";
};

export type SagaGatewayGeneratedImage = {
  bytes: Uint8Array;
  contentType: "image/png";
};

/** The return shape deliberately omits the private Blob URL. */
export type SagaGeneratedPrivateMedia = {
  runId: string;
  source: "ai_gateway";
  privateOnly: true;
  status: "ready";
  storage: {
    pathname: TrustedStudioBlobPath;
    contentType: StudioBlobContentType;
    byteSize: number;
  };
  altText: string;
  generation: {
    model: string;
    aspectRatio: ParsedSagaPrivateMediaGenerationInput["output"]["aspectRatio"];
    safetyPolicyVersion: SagaCreativePromptPolicy["version"];
    artDirectionPolicyVersion: SagaVisualArtDirectionPolicy["version"];
    editorialFinishVersion: typeof SAGA_EDITORIAL_IMAGE_FINISH_VERSION;
  };
};

export type SagaMediaGenerationErrorCode =
  | "configuration_required"
  | "invalid_request"
  | "unsafe_prompt"
  | "gateway_generation_failed"
  | "gateway_image_invalid"
  | "editorial_finish_failed"
  | "blob_upload_failed";

/**
 * A durable Neon job owns scheduling and attempt limits. Keeping this policy
 * exported makes the worker contract explicit without turning this media seam
 * into a queue or silently spending multiple image-generation attempts.
 */
export const sagaMediaGenerationRetryPolicy = {
  automaticAttempts: 1,
  owner: "durable_worker",
  retryableCodes: ["gateway_generation_failed", "gateway_image_invalid", "editorial_finish_failed", "blob_upload_failed"],
  nonRetryableCodes: ["configuration_required", "invalid_request", "unsafe_prompt"],
} as const;

export class SagaMediaGenerationError extends Error {
  constructor(
    message: string,
    readonly options: {
      status: 400 | 422 | 502 | 503;
      code: SagaMediaGenerationErrorCode;
      retryable: boolean;
      missing?: readonly string[];
      stage?: "configuration" | "validation" | "gateway" | "finish" | "blob";
    },
  ) {
    super(message);
    this.name = "SagaMediaGenerationError";
  }

  get status(): 400 | 422 | 502 | 503 {
    return this.options.status;
  }

  get code(): SagaMediaGenerationErrorCode {
    return this.options.code;
  }

  get retryable(): boolean {
    return this.options.retryable;
  }

  get missing(): readonly string[] {
    return this.options.missing ?? [];
  }

  get stage(): "configuration" | "validation" | "gateway" | "finish" | "blob" | undefined {
    return this.options.stage;
  }
}

/** A worker may use this after it has recorded the failed attempt and lease. */
export function isSagaMediaGenerationRetryable(error: unknown): error is SagaMediaGenerationError {
  return error instanceof SagaMediaGenerationError && error.retryable;
}

/**
 * Kept injectable so workers can be tested without a Vercel credential or a
 * Blob store. Production always uses the Vercel-only defaults below.
 */
export type SagaMediaGenerationDependencies = {
  resolveConfiguration: () => SagaMediaGenerationConfiguration;
  generateImage: (input: SagaGatewayImageGenerationRequest) => Promise<SagaGatewayGeneratedImage>;
  /** Explicit seam: production applies SAGA's restrained editorial finish. */
  applyEditorialFinish: (input: SagaGatewayGeneratedImage) => Promise<SagaGatewayGeneratedImage>;
  upload: (input: {
    scope: StudioBlobScope;
    bytes: Uint8Array;
    fileName: string;
    contentType: "image/png";
    /** Stable durable receipt id, never supplied by a browser. */
    stableObjectId: string;
  }) => Promise<UploadedStudioBlob>;
};

const defaultDependencies: SagaMediaGenerationDependencies = {
  resolveConfiguration: resolveSagaMediaGenerationConfiguration,
  generateImage: generateImageWithAiGateway,
  applyEditorialFinish: applySagaEditorialImageFinish,
  upload: uploadStudioBlob,
};

/**
 * Generates exactly one private PNG and persists it into Vercel Blob. It
 * creates neither a public URL nor a database row and never publishes.
 *
 * There is deliberately no hidden retry: image generation is billable. A
 * durable worker owns retries and must retain a successful pathname before it
 * calls this again with the same run ID.
 */
export async function generateSagaPrivateMedia(
  input: SagaPrivateMediaGenerationInput,
  overrides: Partial<SagaMediaGenerationDependencies> = {},
): Promise<SagaGeneratedPrivateMedia> {
  const parsed = parseInput(input);
  const dependencies = { ...defaultDependencies, ...overrides };
  const configuration = dependencies.resolveConfiguration();
  const policy = safePromptPolicy(parsed);
  const artDirection = buildSagaVisualArtDirectionPolicy(policy.safeRewrite.visualMetaphor);
  const size = sizeForAspectRatio(parsed.output.aspectRatio);
  const prompt = buildSagaPrivateMediaPrompt(policy, parsed.output.aspectRatio, artDirection);

  let generated: SagaGatewayGeneratedImage;
  try {
    executionAbortSignal();
    generated = await dependencies.generateImage({ model: configuration.model, prompt, size });
    executionAbortSignal();
    assertGatewayPng(generated);
  } catch (error) {
    executionAbortSignal();
    if (error instanceof SagaMediaGenerationError) throw error;
    throw new SagaMediaGenerationError(
      "SAGA kunde inte skapa bilden just nu. Ingen bild har lagrats eller publicerats.",
      { status: 502, code: "gateway_generation_failed", retryable: true, stage: "gateway" },
    );
  }

  let finished: SagaGatewayGeneratedImage;
  try {
    finished = await dependencies.applyEditorialFinish(generated);
    executionAbortSignal();
    assertGatewayPng(finished);
  } catch {
    executionAbortSignal();
    throw new SagaMediaGenerationError(
      "SAGA kunde inte lägga den återhållsamma redaktionella finishen på bilden. Ingen bild har lagrats eller publicerats.",
      { status: 502, code: "editorial_finish_failed", retryable: true, stage: "finish" },
    );
  }

  let uploaded: UploadedStudioBlob;
  try {
    executionAbortSignal();
    uploaded = await dependencies.upload({
      scope: parsed.scope,
      bytes: finished.bytes,
      fileName: `saga-${parsed.output.label}-${parsed.runId}.png`,
      contentType: "image/png",
      stableObjectId: parsed.runId,
    });
  } catch (error) {
    executionAbortSignal();
    if (error instanceof SagaMediaGenerationError) throw error;
    if (error instanceof MissingVercelBlobConfigurationError || (error instanceof VercelBlobMediaError && error.status === 503)) {
      throw configurationError(["BLOB_READ_WRITE_TOKEN"]);
    }
    throw new SagaMediaGenerationError(
      "SAGA skapade en bild men kunde inte lagra den privat. Körningen kan försökas igen av den beständiga kön.",
      { status: 502, code: "blob_upload_failed", retryable: true, stage: "blob" },
    );
  }

  return {
    runId: parsed.runId,
    source: "ai_gateway",
    privateOnly: true,
    status: "ready",
    storage: {
      pathname: uploaded.pathname,
      contentType: uploaded.contentType,
      byteSize: uploaded.size,
    },
    altText: parsed.output.altText,
    generation: {
      model: configuration.model,
      aspectRatio: parsed.output.aspectRatio,
      safetyPolicyVersion: policy.version,
      artDirectionPolicyVersion: artDirection.version,
      editorialFinishVersion: SAGA_EDITORIAL_IMAGE_FINISH_VERSION,
    },
  };
}

/** Config is intentionally all-or-nothing; no direct provider key is accepted. */
export function resolveSagaMediaGenerationConfiguration(): SagaMediaGenerationConfiguration {
  const missing = [...missingAiGatewayConfiguration(), ...missingVercelBlobConfiguration()];
  if (missing.length) throw configurationError(missing);

  try {
    return { model: resolveSagaImageGatewayModel() };
  } catch (error) {
    if (error instanceof InvalidSagaImageGatewayModelConfigurationError) {
      throw new SagaMediaGenerationError(
        "SAGA:s bildmodell är felkonfigurerad i Vercel. Ingen bildgenerering kördes.",
        { status: 503, code: "configuration_required", retryable: false, missing: ["SAGA_IMAGE_GATEWAY_MODEL"], stage: "configuration" },
      );
    }
    throw error;
  }
}

/**
 * A deterministic, finite safety rewrite is used as model input. We do not
 * pass free-form custom visual direction, copy, price or CTA to the image
 * model: it can be reviewed at the editorial layer without becoming an image
 * prompt-injection or an accidental text overlay.
 */
export function buildSagaPrivateMediaPrompt(
  policy: SagaCreativePromptPolicy,
  aspectRatio: ParsedSagaPrivateMediaGenerationInput["output"]["aspectRatio"],
  artDirection = buildSagaVisualArtDirectionPolicy(policy.safeRewrite.visualMetaphor),
): string {
  const format = aspectRatio === "portrait" ? "stående 4:5-komposition"
    : aspectRatio === "landscape" ? "bred liggande komposition"
      : "kvadratisk komposition";

  return [
    "Skapa en enda illustrativ, redaktionell stillbild för ett privat SAGA-utkast.",
    `Komposition: ${format}.`,
    `Säker bildriktning: ${policy.safeRewrite.visualDirection}`,
    artDirection.instructions,
    "Bildkrav: lugn, mänsklig och professionell känsla; ingen fara, dramatik, våld eller chockeffekt.",
    "Resultatet granskas privat i SAGA och får inte antyda att något redan har publicerats.",
  ].join("\n\n");
}

async function generateImageWithAiGateway(input: SagaGatewayImageGenerationRequest): Promise<SagaGatewayGeneratedImage> {
  try {
    const response = await createAiGatewayClient().images.generate({
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: "medium",
      n: 1,
      background: "opaque",
      moderation: "auto",
      output_format: "png",
      stream: false,
    }, {
      timeout: Math.max(1, Math.min(SAGA_MEDIA_GENERATION_TIMEOUT_MS, executionTimeRemainingMs())),
      signal: executionAbortSignal(),
      // The durable media receipt records retries. An SDK retry here could
      // outlive the Vercel function and spend a second billable image call
      // without an auditable worker attempt.
      maxRetries: 0,
    });
    const encoded = response.data?.at(0)?.b64_json;
    const bytes = decodeGatewayPng(encoded);
    return { bytes, contentType: "image/png" };
  } catch (error) {
    executionAbortSignal();
    if (error instanceof SagaMediaGenerationError) throw error;
    throw new SagaMediaGenerationError(
      "SAGA kunde inte skapa bilden via Vercel AI Gateway. Ingen bild har lagrats eller publicerats.",
      { status: 502, code: "gateway_generation_failed", retryable: true, stage: "gateway" },
    );
  }
}

function parseInput(input: SagaPrivateMediaGenerationInput): ParsedSagaPrivateMediaGenerationInput {
  const parsed = sagaPrivateMediaGenerationInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new SagaMediaGenerationError(
    "SAGA:s bildkörning saknar ett giltigt arbetsunderlag.",
    { status: 400, code: "invalid_request", retryable: false, stage: "validation" },
  );
}

function safePromptPolicy(input: ParsedSagaPrivateMediaGenerationInput): SagaCreativePromptPolicy {
  try {
    return buildSagaCreativePromptPolicy(input.creativeBrief);
  } catch (error) {
    if (error instanceof SagaCreativeSafetyError) {
      throw new SagaMediaGenerationError(
        "Bildriktningen stoppades av SAGA Creative Safety innan någon bildmodell anropades.",
        { status: 422, code: "unsafe_prompt", retryable: false, stage: "validation" },
      );
    }
    throw error;
  }
}

function sizeForAspectRatio(aspectRatio: ParsedSagaPrivateMediaGenerationInput["output"]["aspectRatio"]): SagaGatewayImageGenerationRequest["size"] {
  if (aspectRatio === "square") return "1024x1024";
  return aspectRatio === "landscape" ? "1536x1024" : "1024x1536";
}

function decodeGatewayPng(encoded: string | undefined): Uint8Array {
  if (typeof encoded !== "string" || !encoded.trim()) {
    throw new SagaMediaGenerationError(
      "Vercel AI Gateway returnerade ingen privat PNG-data.",
      { status: 502, code: "gateway_image_invalid", retryable: true, stage: "gateway" },
    );
  }
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 8) {
    throw new SagaMediaGenerationError(
      "Vercel AI Gateway returnerade en bild som är för stor för privat lagring.",
      { status: 502, code: "gateway_image_invalid", retryable: false, stage: "gateway" },
    );
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  assertGatewayPng({ bytes, contentType: "image/png" });
  return bytes;
}

function assertGatewayPng(image: SagaGatewayGeneratedImage): void {
  if (image.contentType !== "image/png" || image.bytes.byteLength <= PNG_SIGNATURE.length || image.bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new SagaMediaGenerationError(
      "Vercel AI Gateway returnerade ett bildformat som SAGA inte kan lagra privat.",
      { status: 502, code: "gateway_image_invalid", retryable: true, stage: "gateway" },
    );
  }
  if (!PNG_SIGNATURE.every((value, index) => image.bytes[index] === value)) {
    throw new SagaMediaGenerationError(
      "Vercel AI Gateway returnerade ingen giltig PNG-bild.",
      { status: 502, code: "gateway_image_invalid", retryable: true, stage: "gateway" },
    );
  }
}

function configurationError(missing: readonly string[]): SagaMediaGenerationError {
  return new SagaMediaGenerationError(
    "SAGA:s privata bildmotor är inte konfigurerad i Vercel. Ingen bildgenerering kördes.",
    { status: 503, code: "configuration_required", retryable: false, missing, stage: "configuration" },
  );
}
