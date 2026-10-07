// A library as files: its blocks, models and texture details as JSON, and every texture's
// pixels in one binary run (raw RGBA, so nothing encodes images). Imported libraries are
// stored this way in the browser; they are the user's own and never leave their device.

import type { Alpha, Library, Texture } from "./library.ts";

/** Bumped when the stored shape changes; older stored libraries are imported again. */
export const LIBRARY_FORMAT = 1;

interface StoredTexture {
  readonly size: number;
  readonly alpha: Alpha;
  readonly color: string;
  /** Where its pixels start in the pixel run. */
  readonly offset: number;
}

interface StoredLibrary {
  readonly format: number;
  readonly id: string;
  readonly name: string;
  readonly blocks: Library["blocks"];
  readonly models: Library["models"];
  readonly textures: Readonly<Record<string, StoredTexture>>;
}

export function encodeLibrary(library: Library): { json: string; pixels: Uint8Array } {
  const textures: Record<string, StoredTexture> = {};
  let total = 0;
  for (const [key, t] of Object.entries(library.textures)) {
    textures[key] = { size: t.size, alpha: t.alpha, color: t.color, offset: total };
    total += t.rgba.length;
  }
  const pixels = new Uint8Array(total);
  for (const [key, t] of Object.entries(library.textures))
    pixels.set(t.rgba, textures[key]?.offset ?? 0);
  const stored: StoredLibrary = {
    format: LIBRARY_FORMAT,
    id: library.id,
    name: library.name,
    blocks: library.blocks,
    models: library.models,
    textures,
  };
  return { json: JSON.stringify(stored), pixels };
}

/** A stored library, or null if it was stored in another format. */
export function decodeLibrary(json: string, pixels: Uint8Array): Library | null {
  const stored = JSON.parse(json) as StoredLibrary;
  if (stored.format !== LIBRARY_FORMAT) return null;
  const textures: Record<string, Texture> = {};
  for (const [key, t] of Object.entries(stored.textures)) {
    const rgba = pixels.subarray(t.offset, t.offset + t.size * t.size * 4);
    textures[key] = { size: t.size, alpha: t.alpha, color: t.color, rgba };
  }
  return {
    id: stored.id,
    name: stored.name,
    blocks: stored.blocks,
    models: stored.models,
    textures,
  };
}
