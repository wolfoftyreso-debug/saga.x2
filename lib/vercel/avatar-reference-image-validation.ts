import "server-only";

import type { AvatarReferenceBlobContentType } from "@/lib/vercel/avatar-reference-blob";
import { VercelBlobMediaError } from "@/lib/vercel/blob-media";

/**
 * Content-type labels are untrusted. Before we store or transfer a private
 * reference, match its actual file signature to the only supported raster
 * formats. SVG, HTML and generic/polyglot payloads do not pass this boundary.
 */
export function assertAvatarReferenceImageBytes(
  bytes: Uint8Array,
  contentType: AvatarReferenceBlobContentType,
): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) {
    throw new VercelBlobMediaError("Referensbilden har inget giltigt bildinnehåll.", 400);
  }
  const valid = contentType === "image/jpeg"
    ? isWellFormedJpeg(bytes)
    : contentType === "image/png"
      ? isWellFormedPng(bytes)
      : isWellFormedWebp(bytes);
  if (!valid) {
    throw new VercelBlobMediaError("Referensbildens filinnehåll matchar inte det angivna bildformatet.", 400);
  }
}

function isWellFormedJpeg(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && offset === bytes.length;
    // Standalone TEM and restart markers have no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    const payloadStart = offset + 2;
    const payloadEnd = offset + segmentLength;
    if (isJpegFrameMarker(marker)) {
      if (segmentLength < 8 || bytes[payloadStart + 1] === 0 || bytes[payloadStart + 2] === 0 || bytes[payloadStart + 3] === 0 || bytes[payloadStart + 4] === 0) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (!sawFrame) return false;
      // Scan data can contain marker-stuffed 0xff 0x00 bytes. Only a terminal
      // EOI at the end is accepted, which prevents appended HTML/polyglots.
      offset = payloadEnd;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (next === 0xd9) return sawFrame && offset + 2 === bytes.length;
        return false;
      }
      return false;
    }
    offset = payloadEnd;
  }
  return false;
}

function isWellFormedPng(bytes: Uint8Array): boolean {
  if (!(bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a)) return false;
  let offset = 8;
  let sawHeader = false;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || readUint32Be(bytes, dataStart) === 0 || readUint32Be(bytes, dataStart + 4) === 0) return false;
      sawHeader = true;
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      return length === 0 && sawImageData && chunkEnd === bytes.length;
    }
    offset = chunkEnd;
  }
  return false;
}

function isWellFormedWebp(bytes: Uint8Array): boolean {
  if (!(bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50)) return false;
  if (readUint32Le(bytes, 4) + 8 !== bytes.length) return false;
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = readUint32Le(bytes, offset + 4);
    const dataEnd = offset + 8 + size;
    const paddedEnd = dataEnd + (size % 2);
    if (dataEnd < offset + 8 || paddedEnd > bytes.length) return false;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") sawImageChunk = true;
    offset = paddedEnd;
  }
  return sawImageChunk && offset === bytes.length;
}

function isJpegFrameMarker(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 3] * 0x1000000) + (bytes[offset + 2] << 16) + (bytes[offset + 1] << 8) + bytes[offset]) >>> 0;
}
