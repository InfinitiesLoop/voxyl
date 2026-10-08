// Shared palettes: the user's own palettes, kept outside any project (web-core.md, decision 2).
// A project brings one in as a read-only linked copy (palette_sync), and re-syncs it when the
// shared palette has moved on and its owner says so; the project never changes by itself.
//
//   palettes/<key>.json   one StoredPalette
//
// Server sync (Phase 6) will carry the same records.

import type { SharedPalette } from "@voxyl/core";
import type { Folder } from "./store.ts";

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
  crypto: { getRandomValues(bytes: Uint8Array): Uint8Array };
};

const SAFE_KEY = /^[a-z0-9_.-]{1,64}$/;

/** A shared palette as stored: the palette, when it last changed, and where it came from. */
export type StoredPalette = SharedPalette & {
  /** When it last changed, in milliseconds since 1970. */
  readonly updated: number;
  /** The project it was shared from, by name, if it was. */
  readonly from?: string;
};

export class PaletteStore {
  readonly #folder: Folder;

  constructor(folder: Folder) {
    this.#folder = folder;
  }

  /** Every stored palette, most recently changed first. */
  async list(): Promise<StoredPalette[]> {
    const out: StoredPalette[] = [];
    for (const name of await this.#folder.list("palettes")) {
      if (!name.endsWith(".json")) continue;
      const palette = await this.load(name.slice(0, -5));
      if (palette) out.push(palette);
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async load(key: string): Promise<StoredPalette | null> {
    if (!SAFE_KEY.test(key)) return null;
    const bytes = await this.#folder.read(`palettes/${key}.json`);
    if (!bytes) return null;
    try {
      return JSON.parse(new runtime.TextDecoder().decode(bytes)) as StoredPalette;
    } catch {
      return null;
    }
  }

  /**
   * Stores a palette. Saving over one with the same key bumps its version when its content
   * changed, so the projects that link it can tell they are behind.
   */
  async save(palette: Omit<StoredPalette, "version" | "updated"> & { version?: number }) {
    if (!SAFE_KEY.test(palette.key)) throw new Error(`Not a palette key: ${palette.key}`);
    const before = await this.load(palette.key);
    const same = before !== null && sameContent(before, palette);
    const version = same ? before.version : (before?.version ?? 0) + 1;
    const stored: StoredPalette = {
      ...palette,
      version,
      updated: same ? before.updated : Date.now(),
    };
    await this.#folder.write(
      `palettes/${palette.key}.json`,
      new runtime.TextEncoder().encode(JSON.stringify(stored)),
    );
    return stored;
  }

  async delete(key: string): Promise<void> {
    if (SAFE_KEY.test(key)) await this.#folder.remove(`palettes/${key}.json`);
  }
}

/** A new key for a palette or a semantic in one. */
export function newPaletteKey(): string {
  const bytes = new Uint8Array(12);
  runtime.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameContent(a: SharedPalette, b: Omit<SharedPalette, "version">): boolean {
  const content = (p: Omit<SharedPalette, "version">) =>
    JSON.stringify([p.name, p.description ?? "", p.semantics]);
  return content(a) === content(b);
}
