import { deflate, utf8 } from "../src/streams.ts";

/** A zip of these files: even-numbered ones stored, odd ones deflated. */
export async function zip(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? utf8.encode(content) : content;
    const method = i++ % 2 === 0 ? 0 : 8;
    const data = method === 8 ? await deflate(raw, "deflate-raw") : raw;
    const nameBytes = utf8.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An 8-bit RGBA PNG (filter 0 on every row; CRCs left zero, which the decoder ignores). */
export async function png(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const idat = await deflate(rows, "deflate");
  const chunk = (kind: string, body: Uint8Array) => {
    const c = new Uint8Array(12 + body.length);
    new DataView(c.buffer).setUint32(0, body.length);
    c.set(utf8.encode(kind), 4);
    c.set(body, 8);
    return c;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 16-wide texture of one colour, `frames` frames tall. */
export function solid(r: number, g: number, b: number, a = 255, frames = 1): Uint8Array {
  const out = new Uint8Array(16 * 16 * frames * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, a], i);
  return out;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/**
 * A greyscale PNG (`depth` 1, 2, 4 or 8 bits) of grey levels 0..2^depth-1, optionally Adam7
 * interlaced, filter 0 on every row, for testing the decoder's bit handling.
 */
export async function pngGrey(
  width: number,
  height: number,
  levels: readonly number[],
  depth: 1 | 2 | 4 | 8,
  interlaced: boolean,
): Promise<Uint8Array> {
  const pack = (pixels: number[]) => {
    const row = new Uint8Array(1 + Math.ceil((pixels.length * depth) / 8));
    pixels.forEach((v, i) => {
      const bit = i * depth;
      row[1 + (bit >> 3)] = (row[1 + (bit >> 3)] ?? 0) | (v << (8 - depth - (bit & 7)));
    });
    return row;
  };
  const rows: Uint8Array[] = [];
  if (interlaced) {
    for (const [x0, y0, dx, dy] of ADAM7) {
      for (let y = y0; y < height; y += dy) {
        const pixels: number[] = [];
        for (let x = x0; x < width; x += dx) pixels.push(levels[y * width + x] ?? 0);
        if (pixels.length) rows.push(pack(pixels));
      }
    }
  } else {
    for (let y = 0; y < height; y++) rows.push(pack(levels.slice(y * width, (y + 1) * width)));
  }
  const raw = new Uint8Array(rows.reduce((n, r) => n + r.length, 0));
  let at = 0;
  for (const r of rows) {
    raw.set(r, at);
    at += r.length;
  }
  const idat = await deflate(raw, "deflate");
  const chunk = (kind: string, body: Uint8Array) => {
    const c = new Uint8Array(12 + body.length);
    new DataView(c.buffer).setUint32(0, body.length);
    c.set(utf8.encode(kind), 4);
    c.set(body, 8);
    return c;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = 0;
  ihdr[12] = interlaced ? 1 : 0;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
