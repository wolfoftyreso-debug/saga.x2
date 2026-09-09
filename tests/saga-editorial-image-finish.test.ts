import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  SagaEditorialImageFinishError,
  applySagaEditorialImageFinish,
} from "@/lib/services/saga-editorial-image-finish";

async function sourcePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: { r: 211, g: 165, b: 96 },
    },
  }).png().toBuffer();
}

describe("SAGA editorial image finish", () => {
  it("applies a deterministic, restrained finish without changing image dimensions or file type", async () => {
    const source = await sourcePng();
    const [first, second] = await Promise.all([
      applySagaEditorialImageFinish({ bytes: new Uint8Array(source), contentType: "image/png" }),
      applySagaEditorialImageFinish({ bytes: new Uint8Array(source), contentType: "image/png" }),
    ]);
    const metadata = await sharp(Buffer.from(first.bytes)).metadata();

    expect(first).toMatchObject({
      contentType: "image/png",
      version: "saga-editorial-image-finish/v1",
    });
    expect(metadata).toMatchObject({ width: 96, height: 64, format: "png" });
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(Buffer.from(first.bytes).equals(source)).toBe(false);
  });

  it("fails closed when the source only masquerades as a PNG", async () => {
    const signatureOnly = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    await expect(applySagaEditorialImageFinish({ bytes: signatureOnly, contentType: "image/png" }))
      .rejects.toBeInstanceOf(SagaEditorialImageFinishError);
  });
});
