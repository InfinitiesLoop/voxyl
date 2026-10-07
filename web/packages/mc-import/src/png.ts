// A small PNG decoder: every colour type and bit depth, to 8-bit RGBA. Not interlaced images
// (Minecraft's textures never are).

import { inflate } from "./streams.ts";

export interface Image {
  readonly width: number;
  readonly height: number;
  /** width * height * 4 bytes, rows top to bottom. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Channels per colour type: grey, RGB, palette, grey + alpha, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function decodePng(bytes: Uint8Array): Promise<Image> {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("Not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 6;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8] ?? 8;
      type = body[9] ?? 6;
      if ((body[12] ?? 0) !== 0) throw new Error("Interlaced PNGs aren't supported");
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") transparency = body;
    else if (kind === "IDAT") data.push(body);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[type];
  if (!channels || width === 0 || height === 0) throw new Error("Unsupported PNG");
  const raw = await inflate(concat(data), "deflate");
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const pixels = unfilter(raw, height, stride, bpp);

  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  const sample = (row: number, index: number): number => {
    // The index-th sample of a row, scaled to 8 bits (palette indices are left as they are).
    const o = row * stride;
    if (depth === 8) return pixels[o + index] ?? 0;
    if (depth === 16) return pixels[o + index * 2] ?? 0;
    const bit = index * depth;
    const value = ((pixels[o + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & max;
    return type === 3 ? value : Math.round((value * 255) / max);
  };
  // A grey image's tRNS names one grey level as transparent (in the image's bit depth).
  const keyRaw =
    transparency && type === 0 ? ((transparency[0] ?? 0) << 8) | (transparency[1] ?? 0) : -1;
  const greyKey =
    keyRaw < 0
      ? -1
      : depth === 16
        ? keyRaw >> 8
        : depth === 8
          ? keyRaw
          : Math.round((keyRaw * 255) / max);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (type === 3) {
        const i = sample(y, s);
        rgba[o] = palette?.[i * 3] ?? 0;
        rgba[o + 1] = palette?.[i * 3 + 1] ?? 0;
        rgba[o + 2] = palette?.[i * 3 + 2] ?? 0;
        rgba[o + 3] = transparency && i < transparency.length ? (transparency[i] ?? 255) : 255;
      } else if (type === 0 || type === 4) {
        const g = sample(y, s);
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = type === 4 ? sample(y, s + 1) : g === greyKey ? 0 : 255;
      } else {
        rgba[o] = sample(y, s);
        rgba[o + 1] = sample(y, s + 1);
        rgba[o + 2] = sample(y, s + 2);
        rgba[o + 3] = type === 6 ? sample(y, s + 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

/** Undoes PNG's per-row filters in place of a copy: one filter byte, then `stride` bytes. */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] ?? 0;
      const a = i >= bpp ? (out[row + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prev + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (out[prev + i - bpp] ?? 0) : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paeth(a, b, c);
      out[row + i] = v & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
