// Inflating and text decoding through the standard web APIs every runtime here has (browsers,
// workers, Node), typed locally because this package builds without the DOM lib.

interface ByteStream {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
}
type Format = "deflate" | "deflate-raw";
type StreamConstructor = new (format: Format) => ByteStream;
const runtime = globalThis as unknown as {
  CompressionStream?: StreamConstructor;
  DecompressionStream?: StreamConstructor;
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
  TextEncoder: new () => { encode(text: string): Uint8Array };
};

/** Inflates zlib ("deflate") or raw deflate data. */
export function inflate(data: Uint8Array, format: Format): Promise<Uint8Array> {
  return pipe(runtime.DecompressionStream, format, data);
}

/** Deflates data (tests build zips and PNGs with it). */
export function deflate(data: Uint8Array, format: Format): Promise<Uint8Array> {
  return pipe(runtime.CompressionStream, format, data);
}

const decoder = new runtime.TextDecoder();
const encoder = new runtime.TextEncoder();

export const utf8 = {
  decode: (bytes: Uint8Array): string => decoder.decode(bytes),
  encode: (text: string): Uint8Array => encoder.encode(text),
};

async function pipe(
  Ctor: StreamConstructor | undefined,
  format: Format,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (!Ctor) throw new Error("CompressionStream isn't available in this runtime");
  const stream = new Ctor(format);
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
