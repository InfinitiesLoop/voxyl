// Reads a zip (a jar) held in memory: the central directory once, then entries on demand,
// stored or deflated. No zip64, encryption or spanning: Minecraft jars use none of them.

import { inflate } from "./streams.ts";

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly headerOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #entries = new Map<string, Entry>();

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const view = this.#view;
    // The end record sits in the last 22 bytes plus up to 64 KB of comment.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === EOCD) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("Not a zip file");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== CENTRAL) throw new Error("Broken zip directory");
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const headerOffset = view.getUint32(at + 42, true);
      const name = latin1(bytes.subarray(at + 46, at + 46 + nameLength));
      this.#entries.set(name, { method, compressedSize, headerOffset });
      at += 46 + nameLength + extraLength + commentLength;
    }
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
    const view = this.#view;
    const h = entry.headerOffset;
    if (view.getUint32(h, true) !== LOCAL) throw new Error(`Broken zip entry ${name}`);
    const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
    const data = this.#bytes.subarray(start, start + entry.compressedSize);
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
