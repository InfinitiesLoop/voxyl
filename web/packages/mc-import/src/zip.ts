// Reads a zip (a jar) through ranged reads: the central directory once, then entries on demand,
// stored or deflated. A modpack's `mods/` folder is hundreds of jars, so a jar is never read
// whole: the end record and the directory come first, an entry's bytes only when asked for.
// No zip64, encryption or spanning: Minecraft jars use none of them.

import { inflate } from "./streams.ts";

/** Random access to a blob of bytes: a `File` in the browser, a file or buffer in tests. */
export interface ByteSource {
  readonly size: number;
  /** Bytes [start, end), clamped to the size. */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** A `ByteSource` over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (start, end) => bytes.subarray(start, Math.min(end, bytes.length)),
  };
}

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly headerOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipReader {
  readonly #source: ByteSource;
  readonly #entries: Map<string, Entry>;

  private constructor(source: ByteSource, entries: Map<string, Entry>) {
    this.#source = source;
    this.#entries = entries;
  }

  /** Reads the directory of a zip held in memory. */
  static fromBytes(bytes: Uint8Array): Promise<ZipReader> {
    return ZipReader.open(bytesSource(bytes));
  }

  /** Reads a zip's directory: two ranged reads however many entries it has. */
  static async open(source: ByteSource): Promise<ZipReader> {
    // The end record sits in the last 22 bytes plus up to 64 KB of comment.
    const tailStart = Math.max(0, source.size - 22 - 0xffff);
    const tail = await source.read(tailStart, source.size);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === EOCD) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("Not a zip file");
    const count = tailView.getUint16(end + 10, true);
    const size = tailView.getUint32(end + 12, true);
    const offset = tailView.getUint32(end + 16, true);
    const directory = await source.read(offset, offset + size);
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const entries = new Map<string, Entry>();
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > directory.length || view.getUint32(at, true) !== CENTRAL) {
        throw new Error("Broken zip directory");
      }
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const headerOffset = view.getUint32(at + 42, true);
      const name = latin1(directory.subarray(at + 46, at + 46 + nameLength));
      entries.set(name, { method, compressedSize, headerOffset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipReader(source, entries);
  }

  /** Every entry's name, directories included. */
  names(): IterableIterator<string> {
    return this.#entries.keys();
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** An entry's contents, or null if there is none by that name. */
  async read(name: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(name);
    if (!entry) return null;
    const h = entry.headerOffset;
    const head = await this.#source.read(h, h + 30);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || view.getUint32(0, true) !== LOCAL) {
      throw new Error(`Broken zip entry ${name}`);
    }
    const start = h + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const data = await this.#source.read(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflate(data, "deflate-raw");
    throw new Error(`${name} uses zip method ${entry.method}`);
  }
}

/** Entry names in jars are ASCII; decode bytes one to one. */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
