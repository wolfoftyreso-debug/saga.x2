import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SagaMediaGenerationError,
  buildSagaPrivateMediaPrompt,
  generateSagaPrivateMedia,
  isSagaMediaGenerationRetryable,
  resolveSagaMediaGenerationConfiguration,
  sagaMediaGenerationRetryPolicy,
  type SagaMediaGenerationDependencies,
} from "@/lib/services/saga-media-generation";
import { buildSagaCreativePromptPolicy } from "@/lib/services/saga-creative-safety";
import { createStudioBlobPath, type TrustedStudioBlobPath } from "@/lib/vercel/blob-media";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draftId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const originalAiGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
const originalImageModel = process.env.SAGA_IMAGE_GATEWAY_MODEL;

afterEach(() => {
  restoreEnv("AI_GATEWAY_API_KEY", originalAiGatewayKey);
  restoreEnv("VERCEL_OIDC_TOKEN", originalOidcToken);
  restoreEnv("BLOB_READ_WRITE_TOKEN", originalBlobToken);
  restoreEnv("SAGA_IMAGE_GATEWAY_MODEL", originalImageModel);
});

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    runId,
    scope: { workspaceId, draftId },
    creativeBrief: {
      format: "paid_social" as const,
      hook: "När hösten kommer ska hjulskiftet inte bli en överraskning.",
      value: "En lugn bokning gör vardagen enklare när temperaturen skiftar.",
      offer: {
        copy: "Boka när det passar dig.",
        terms: "",
        verification: { status: "unverified" as const, sourceReference: "" },
      },
      callToAction: "Välj en tid som passar.",
      visualMetaphor: "calendar_turn" as const,
      customVisualDirection: "",
    },
    output: {
      aspectRatio: "portrait" as const,
      altText: "Kalenderblad och första frost på en bilruta i lugnt morgonljus.",
      label: "vinterhjul",
    },
    ...overrides,
  };
}

function dependencies(overrides: Partial<SagaMediaGenerationDependencies> = {}): SagaMediaGenerationDependencies {
  return {
    resolveConfiguration: () => ({ model: "openai/gpt-image-1.5" }),
    generateImage: async () => ({ bytes: pngBytes, contentType: "image/png" }),
    applyEditorialFinish: async (image) => image,
    upload: async () => ({
      url: "https://store-id.public.blob.vercel-storage.com/studio/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/drafts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/image.png",
      pathname: "studio/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/drafts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/image.png" as TrustedStudioBlobPath,
      contentType: "image/png",
      size: pngBytes.byteLength,
    }),
    ...overrides,
  };
}

describe("SAGA private Vercel media generation", () => {
  it("exports worker-owned retry semantics rather than retrying a billable image call in-process", () => {
    expect(sagaMediaGenerationRetryPolicy).toMatchObject({
      automaticAttempts: 1,
      owner: "durable_worker",
      retryableCodes: expect.arrayContaining(["blob_upload_failed"]),
    });
    expect(isSagaMediaGenerationRetryable(new SagaMediaGenerationError("retry", {
      status: 502,
      code: "blob_upload_failed",
      retryable: true,
      stage: "blob",
    }))).toBe(true);
  });

  it("uses the durable run id as a stable private Blob object key across a resumed receipt", () => {
    const scope = { workspaceId, draftId };
    const first = createStudioBlobPath(scope, "saga-editorial.png", "image/png", runId);
    const resumed = createStudioBlobPath(scope, "saga-editorial.png", "image/png", runId);

    expect(resumed).toBe(first);
    expect(first).toContain(`/${runId}-saga-editorial.png`);
  });

  it("creates a protected attachment shape through the Gateway and private Blob seam", async () => {
    const generateImage = vi.fn(async () => ({ bytes: pngBytes, contentType: "image/png" as const }));
    const applyEditorialFinish = vi.fn(async (image: { bytes: Uint8Array; contentType: "image/png" }) => image);
    const upload = vi.fn(dependencies().upload);

    const media = await generateSagaPrivateMedia(validInput(), dependencies({ generateImage, applyEditorialFinish, upload }));

    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-image-1.5",
      size: "1024x1536",
      prompt: expect.stringContaining("privat SAGA-utkast"),
    }));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      scope: { workspaceId, draftId },
      contentType: "image/png",
      fileName: expect.stringContaining(runId),
    }));
    expect(applyEditorialFinish).toHaveBeenCalledWith({ bytes: pngBytes, contentType: "image/png" });
    expect(media).toEqual(expect.objectContaining({
      runId,
      source: "ai_gateway",
      privateOnly: true,
      status: "ready",
      altText: expect.stringContaining("Kalenderblad"),
      storage: expect.objectContaining({ contentType: "image/png", byteSize: pngBytes.byteLength }),
      generation: expect.objectContaining({
        artDirectionPolicyVersion: "saga-visual-art-direction/v1",
        editorialFinishVersion: "saga-editorial-image-finish/v1",
      }),
    }));
    expect(media).not.toHaveProperty("url");
    expect(media.storage).not.toHaveProperty("url");
  });

  it("fails closed with a 503 before calling a model when Gateway or Blob configuration is absent", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const generateImage = vi.fn(async () => ({ bytes: pngBytes, contentType: "image/png" as const }));

    await expect(generateSagaPrivateMedia(validInput(), {
      generateImage,
    })).rejects.toMatchObject({
      name: "SagaMediaGenerationError",
      status: 503,
      code: "configuration_required",
      retryable: false,
      missing: expect.arrayContaining(["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN", "BLOB_READ_WRITE_TOKEN"]),
    });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("stops an unsafe falling-wheel prompt before any Gateway or Blob operation", async () => {
    const generateImage = vi.fn(async () => ({ bytes: pngBytes, contentType: "image/png" as const }));
    const upload = vi.fn(dependencies().upload);
    const unsafe = validInput({
      creativeBrief: {
        ...validInput().creativeBrief,
        customVisualDirection: "Ett hjul faller från en balkong över en folksamling på gatan.",
      },
    });

    await expect(generateSagaPrivateMedia(unsafe, dependencies({ generateImage, upload }))).rejects.toMatchObject({
      name: "SagaMediaGenerationError",
      status: 422,
      code: "unsafe_prompt",
      retryable: false,
    });
    expect(generateImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("uses the finite safe rewrite rather than free-form creative copy in the image prompt", () => {
    const policy = buildSagaCreativePromptPolicy(validInput().creativeBrief);
    const prompt = buildSagaPrivateMediaPrompt(policy, "portrait");

    expect(prompt).toContain("kalenderblad");
    expect(prompt).toContain("SAGA Visual Art Direction v1");
    expect(prompt).toContain("lätt analogt korn");
    expect(prompt).toContain("Ingen CGI-");
    expect(prompt).toContain("Ingen läsbar text");
    expect(prompt).not.toContain(validInput().creativeBrief.hook);
    expect(prompt).not.toContain(validInput().creativeBrief.offer.copy);
  });

  it("does not upload a generated image when the editorial finish fails", async () => {
    const generateImage = vi.fn(async () => ({ bytes: pngBytes, contentType: "image/png" as const }));
    const upload = vi.fn(dependencies().upload);

    await expect(generateSagaPrivateMedia(validInput(), dependencies({
      generateImage,
      applyEditorialFinish: async () => { throw new Error("finish unavailable"); },
      upload,
    }))).rejects.toMatchObject({
      name: "SagaMediaGenerationError",
      code: "editorial_finish_failed",
      stage: "finish",
      retryable: true,
    });
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not hide a Blob retry: it returns a retryable failure and lets the durable worker retry explicitly", async () => {
    const generateImage = vi.fn(async () => ({ bytes: pngBytes, contentType: "image/png" as const }));
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("Blob unavailable"))
      .mockImplementationOnce(dependencies().upload);
    const seam = dependencies({ generateImage, upload });

    await expect(generateSagaPrivateMedia(validInput(), seam)).rejects.toMatchObject({
      name: "SagaMediaGenerationError",
      status: 502,
      code: "blob_upload_failed",
      retryable: true,
      stage: "blob",
    });
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);

    await expect(generateSagaPrivateMedia(validInput(), seam)).resolves.toMatchObject({ status: "ready", privateOnly: true });
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("rejects a model override outside the supported Gateway image-model family", () => {
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.SAGA_IMAGE_GATEWAY_MODEL = "anthropic/claude-sonnet-4.6";

    expect(() => resolveSagaMediaGenerationConfiguration()).toThrow(expect.objectContaining({
      name: "SagaMediaGenerationError",
      status: 503,
      code: "configuration_required",
      missing: ["SAGA_IMAGE_GATEWAY_MODEL"],
    }));
  });

  it("keeps an invalid Gateway image response out of Blob", async () => {
    const upload = vi.fn(dependencies().upload);

    await expect(generateSagaPrivateMedia(validInput(), dependencies({
      generateImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
      upload,
    }))).rejects.toBeInstanceOf(SagaMediaGenerationError);
    expect(upload).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
