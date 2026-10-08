// Gzip through the standard CompressionStream (browsers, workers and Node alike), typed
// locally so this package builds without the DOM lib. A caller whose runtime lacks it passes
// its own `compress` / `decompress` instead.

export type Compress = (bytes: Uint8Array) => Promise<Uint8Array>;

interface ByteStream {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
}
type StreamConstructor = new (format: "gzip") => ByteStream;
const streams = globalThis as unknown as {
  CompressionStream?: StreamConstructor;
  DecompressionStream?: StreamConstructor;
};

export const gzip: Compress = (data) => pipe(streams.CompressionStream, data);
export const gunzip: Compress = (data) => pipe(streams.DecompressionStream, data);

async function pipe(Ctor: StreamConstructor | undefined, data: Uint8Array): Promise<Uint8Array> {
  if (!Ctor) throw new Error("CompressionStream isn't available in this runtime");
  const stream = new Ctor("gzip");
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
