import { inflateSync } from "node:zlib";
import { ATTACHMENT_LIMITS } from "../shared/attachments.ts";
import { ArtifactError } from "./artifact-validation.ts";

function invalid(): never {
  throw new ArtifactError("Expected a valid static PNG or JPEG image");
}

function dimensions(width: number, height: number) {
  if (!width || !height || width * height > ATTACHMENT_LIMITS.pixels)
    throw new ArtifactError("Image exceeds the 20 megapixel limit", 413);
  return { width, height };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Validate structure and bounded PNG scanlines, and remove metadata. This is
// intentionally not a general image decoder: browsers perform pixel decoding.
export function prepareAttachmentImage(bytes: Buffer, mediaType: unknown) {
  if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.bytes)
    throw new ArtifactError("Images must be at most 5 MiB", 413);
  if (mediaType === "image/png") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
    const parts = [bytes.subarray(0, 8)];
    const data: Buffer[] = [];
    let size: { width: number; height: number } | undefined;
    let depth = 0;
    let channels = 0;
    let interlaced = false;
    let palette = false;
    let indexed = false;
    let ended = false;
    let dataEnded = false;
    for (let at = 8; at < bytes.length; ) {
      if (at + 12 > bytes.length) invalid();
      const length = bytes.readUInt32BE(at);
      const end = at + length + 12;
      if (end > bytes.length) invalid();
      const type = bytes.toString("ascii", at + 4, at + 8);
      const content = bytes.subarray(at + 8, end - 4);
      if (
        !/^[A-Za-z]{4}$/.test(type) ||
        crc(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
      )
        invalid();
      if (!size && type !== "IHDR") invalid();
      if (type === "IHDR") {
        if (size || length !== 13) invalid();
        size = dimensions(content.readUInt32BE(0), content.readUInt32BE(4));
        depth = content[8]!;
        const color = content[9]!;
        const allowed: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        if (
          !allowed[color]?.includes(depth) ||
          content[10] !== 0 ||
          content[11] !== 0 ||
          content[12]! > 1
        )
          invalid();
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
        indexed = color === 3;
        interlaced = content[12] === 1;
      } else if (type === "PLTE") {
        if (palette || data.length || !length || length > 768 || length % 3) invalid();
        palette = true;
      } else if (type === "IDAT") {
        if (dataEnded || (indexed && !palette)) invalid();
        data.push(content);
      } else if (type === "IEND") {
        if (length || !data.length || end !== bytes.length) invalid();
        ended = true;
      } else if (
        type === "acTL" ||
        type === "fcTL" ||
        type === "fdAT" ||
        type[0] === type[0]!.toUpperCase()
      )
        invalid();
      if (data.length && type !== "IDAT") dataEnded = true;
      if (["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "sRGB", "gAMA", "cHRM"].includes(type))
        parts.push(bytes.subarray(at, end));
      at = end;
    }
    if (!ended || !size) invalid();
    const passes = interlaced
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
      const width = Math.max(0, Math.ceil((size.width - x!) / dx!));
      const height = Math.max(0, Math.ceil((size.height - y!) / dy!));
      return { length: Math.ceil((width * channels * depth) / 8) + 1, height: width ? height : 0 };
    });
    const expected = rows.reduce((sum, row) => sum + row.length * row.height, 0);
    let decoded: Buffer;
    try {
      decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
    } catch {
      invalid();
    }
    if (decoded.length !== expected) invalid();
    let at = 0;
    for (const row of rows)
      for (let y = 0; y < row.height; y++, at += row.length) if (decoded[at]! > 4) invalid();
    return { bytes: Buffer.concat(parts), mediaType, ...size } as const;
  }
  if (mediaType !== "image/jpeg" || bytes[0] !== 255 || bytes[1] !== 216) invalid();
  const parts = [bytes.subarray(0, 2)];
  let size: { width: number; height: number } | undefined;
  let scanned = false;
  let ended = false;
  for (let at = 2; at < bytes.length; ) {
    const start = at;
    if (bytes[at++] !== 255) invalid();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) {
      if (!scanned || at !== bytes.length) invalid();
      parts.push(Buffer.from([255, 217]));
      ended = true;
      break;
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 216 ||
      (marker >= 208 && marker <= 215) ||
      at + 2 > bytes.length
    )
      invalid();
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) invalid();
    if ([192, 193, 194].includes(marker)) {
      if (size || length < 8 || bytes[at + 2] !== 8) invalid();
      size = dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
      const components = bytes[at + 7]!;
      if (![1, 3].includes(components) || length !== 8 + 3 * components) invalid();
    } else if (marker >= 195 && marker <= 207 && ![196, 200, 204].includes(marker)) invalid();
    at += length;
    // APP and comment segments may contain EXIF, location, or editor metadata.
    if (!(marker >= 224 && marker <= 239) && marker !== 254) parts.push(bytes.subarray(start, at));
    if (marker === 218) {
      if (!size || length < 6) invalid();
      scanned = true;
      const scanStart = at;
      while (at < bytes.length) {
        if (bytes[at] !== 255) {
          at++;
          continue;
        }
        const next = bytes[at + 1];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) {
          at += 2;
          continue;
        }
        if (next === 255) {
          at++;
          continue;
        }
        break;
      }
      if (at === scanStart) invalid();
      parts.push(bytes.subarray(scanStart, at));
    }
  }
  if (!ended || !size) invalid();
  return { bytes: Buffer.concat(parts), mediaType: "image/jpeg" as const, ...size };
}
