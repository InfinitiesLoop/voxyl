// Prefabs: pieces the user keeps (a tower, a window, a column), outside any project so every
// project can use them. A prefab is a piece (core's piece.ts), which carries its semantics by
// name and palette, so it pastes into a project that has never seen them.
//
//   prefabs/<id>/entry.json   what the list shows (PrefabEntry)
//   prefabs/<id>/piece.bin    the piece as JSON, deflated
//   prefabs/<id>/thumb.bin    a small RGBA picture, if it has one
//
// Phase 4 gives prefabs a content hash an agent can paste by; the hash here is of the piece.

import { deflate, hash64, inflate, type Piece } from "@voxyl/core";
import type { Folder } from "./store.ts";

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
  crypto: { getRandomValues(bytes: Uint8Array): Uint8Array };
};

const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

/** What a prefab list shows. */
export interface PrefabEntry {
  readonly id: string;
  readonly name: string;
  /** Free words to find it by, lower case. */
  readonly tags: readonly string[];
  /** The cells it holds (air left out), and the box they fill. */
  readonly cells: number;
  readonly size: readonly [number, number, number];
  /** The content hash of its piece. */
  readonly hash: string;
  /** When it was last saved, in milliseconds since 1970. */
  readonly savedAt: number;
  /** Bytes of its piece on disk. */
  readonly bytes: number;
}

/** Tags as stored: trimmed, lower case, no repeats, at most 12 of at most 32 characters. */
export function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, 32);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 12);
}

export class PrefabStore {
  readonly #folder: Folder;

  constructor(folder: Folder) {
    this.#folder = folder;
  }

  /** Every prefab, most recently saved first. */
  async list(): Promise<PrefabEntry[]> {
    const out: PrefabEntry[] = [];
    for (const id of await this.#folder.list("prefabs")) {
      const entry = await this.entry(id);
      if (entry) out.push(entry);
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async entry(id: string): Promise<PrefabEntry | null> {
    if (!SAFE_ID.test(id)) return null;
    const bytes = await this.#folder.read(`prefabs/${id}/entry.json`);
    if (!bytes) return null;
    try {
      return JSON.parse(new runtime.TextDecoder().decode(bytes)) as PrefabEntry;
    } catch {
      return null;
    }
  }

  /** Stores a new prefab. `thumb` is RGBA pixels of any square size the caller keeps track of. */
  async save(
    piece: Piece,
    meta: { readonly name: string; readonly tags?: readonly string[]; readonly thumb?: Uint8Array },
    savedAt = Date.now(),
  ): Promise<PrefabEntry> {
    const name = meta.name.trim().slice(0, 80);
    if (name === "") throw new Error("A prefab needs a name");
    const json = new runtime.TextEncoder().encode(JSON.stringify(piece));
    const packed = await deflate(json);
    const id = newPrefabId();
    const entry: PrefabEntry = {
      id,
      name,
      tags: cleanTags(meta.tags ?? []),
      cells: occupiedCells(piece),
      size: piece.size,
      hash: hash64(json),
      savedAt,
      bytes: packed.byteLength,
    };
    await this.#folder.write(`prefabs/${id}/piece.bin`, packed);
    if (meta.thumb) await this.#folder.write(`prefabs/${id}/thumb.bin`, meta.thumb);
    // The entry goes last: a prefab is only listed once everything it needs is stored.
    await this.#folder.write(`prefabs/${id}/entry.json`, this.#encode(entry));
    return entry;
  }

  /** A prefab's piece. */
  async load(id: string): Promise<Piece | null> {
    if (!SAFE_ID.test(id)) return null;
    const bytes = await this.#folder.read(`prefabs/${id}/piece.bin`);
    if (!bytes) return null;
    try {
      return JSON.parse(new runtime.TextDecoder().decode(await inflate(bytes))) as Piece;
    } catch {
      return null;
    }
  }

  /** A prefab's picture as it was stored, or null. */
  async thumb(id: string): Promise<Uint8Array | null> {
    if (!SAFE_ID.test(id)) return null;
    return this.#folder.read(`prefabs/${id}/thumb.bin`);
  }

  /** Renames a prefab and sets its tags. Its piece, and so its hash, stay. */
  async update(
    id: string,
    changes: { readonly name?: string; readonly tags?: readonly string[] },
  ): Promise<PrefabEntry> {
    const before = await this.entry(id);
    if (!before) throw new Error("That prefab is gone");
    const name = changes.name === undefined ? before.name : changes.name.trim().slice(0, 80);
    if (name === "") throw new Error("A prefab needs a name");
    const entry: PrefabEntry = {
      ...before,
      name,
      tags: changes.tags === undefined ? before.tags : cleanTags(changes.tags),
    };
    await this.#folder.write(`prefabs/${id}/entry.json`, this.#encode(entry));
    return entry;
  }

  async delete(id: string): Promise<void> {
    if (SAFE_ID.test(id)) await this.#folder.remove(`prefabs/${id}`);
  }

  #encode(entry: PrefabEntry): Uint8Array {
    return new runtime.TextEncoder().encode(JSON.stringify(entry));
  }
}

/** The cells of a piece that hold something: its air is not counted. */
function occupiedCells(piece: Piece): number {
  let count = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const n = piece.cells[r] ?? 0;
    if (n !== 0 && piece.states[n - 1] !== null) count += piece.cells[r + 1] ?? 0;
  }
  return count;
}

function newPrefabId(): string {
  const bytes = new Uint8Array(9);
  runtime.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
