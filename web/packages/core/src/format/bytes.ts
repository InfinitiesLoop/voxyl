// Byte-level helpers for the project format: a growable writer and a reader with unsigned
// LEB128 varints, a 64-bit content hash, and deflate through the standard CompressionStream
// (in browsers, workers, Node and Cloudflare Workers alike; typed locally so core stays free
// of DOM types).

export class ByteWriter {
  #buf = new Uint8Array(1024);
  #len = 0;

  get length(): number {
    return this.#len;
  }

  u8(v: number): void {
    this.#reserve(1);
    this.#buf[this.#len++] = v & 0xff;
  }

  /** An unsigned integer, 7 bits per byte. */
  varint(v: number): void {
    if (!Number.isInteger(v) || v < 0)
      throw new RangeError(`varint needs a non-negative integer, got ${v}`);
    let n = v;
    while (n >= 0x80) {
      this.u8((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.u8(n);
  }

  bytes(b: Uint8Array): void {
    this.#reserve(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }

  #reserve(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }
}

export class ByteReader {
  readonly #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  get done(): boolean {
    return this.#pos >= this.#buf.length;
  }

  u8(): number {
    const v = this.#buf[this.#pos++];
    if (v === undefined) throw new RangeError("Unexpected end of data");
    return v;
  }

  varint(): number {
    let v = 0;
    let scale = 1;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * scale;
      if (b < 0x80) return v;
      scale *= 0x80;
      if (scale > 2 ** 49) throw new RangeError("varint too long");
    }
  }

  bytes(n: number): Uint8Array {
    if (this.#pos + n > this.#buf.length) throw new RangeError("Unexpected end of data");
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }
}

/** A 64-bit hash (two murmur-style 32-bit lanes) as 16 hex digits, for content addressing. */
export function hash64(data: Uint8Array): string {
  let h1 = 0x9e3779b9 ^ data.length;
  let h2 = 0x85ebca6b ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] ?? 0;
    h1 = Math.imul(h1 ^ b, 0x5bd1e995);
    h1 ^= h1 >>> 15;
    h2 = Math.imul(h2 ^ b, 0x27d4eb2d);
    h2 ^= h2 >>> 13;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ Math.imul(h2, 0xc2b2ae35);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35) ^ Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 16;
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// --- deflate-raw through CompressionStream ---

interface ByteStream {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
}
type StreamConstructor = new (format: "deflate-raw") => ByteStream;
const streams = globalThis as unknown as {
  CompressionStream?: StreamConstructor;
  DecompressionStream?: StreamConstructor;
};

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(streams.CompressionStream, data);
}

export function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(streams.DecompressionStream, data);
}

async function pipe(Ctor: StreamConstructor | undefined, data: Uint8Array): Promise<Uint8Array> {
  if (!Ctor) throw new Error("CompressionStream isn't available in this runtime");
  const stream = new Ctor("deflate-raw");
  const reader = stream.readable.getReader();
  // Read while writing, or a large input stalls on backpressure.
  const collected = (async () => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  })();
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return collected;
}
