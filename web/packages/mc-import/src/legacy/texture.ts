// How a referenced PNG becomes a library texture: read it from the source, decode it, keep
// one square frame, work out its alpha use and average colour (`textureOf`). The shared ingest
// of the legacy importers, the pre-1.8 counterpart of the texture reading in `importer.ts`.
// It knows only the `<ns>/textures/<path>.png` (+ `.mcmeta`) convention.

import { type Texture, textureOf } from "@voxyl/blocks";
import { decodePng } from "../png.ts";
import { type AssetSource, readText } from "../sources/index.ts";
import type { LibraryDraft } from "./draft.ts";
import { splitRef } from "./nei.ts";

/** What reading one PNG gave: a texture, or why not. */
interface Read {
  readonly texture: Texture | null;
  readonly warning?: string;
}

/**
 * Reads textures into drafts, decoding each file of a source once however many drafts or
 * blocks use it (vanilla's `minecraft` textures are reached by many mods' blocks). Make one per
 * import run so the decoded pixels are let go with it. Problems go to `warnings`, once per
 * texture per library.
 */
export class TextureIngest {
  readonly warnings: string[];
  readonly #read = new Map<AssetSource, Map<string, Promise<Read>>>();
  readonly #warned = new Set<string>();

  constructor(warnings: string[] = []) {
    this.warnings = warnings;
  }

  /**
   * Makes sure `draft` has the texture `ref` ("ns:path", without `textures/` and `.png`; a
   * bare path belongs to "minecraft"), reading it from `source` if it isn't there yet.
   * Returns the texture's key in the draft ("ns:path"), or null (with a warning) when the file
   * is missing, unreadable or an odd shape.
   */
  async ensure(draft: LibraryDraft, source: AssetSource, ref: string): Promise<string | null> {
    const { ns, path } = splitRef(ref);
    const key = `${ns}:${path}`;
    if (draft.hasTexture(key)) return key;
    const rel = `${ns}/textures/${path}.png`;
    const bySource = this.#read.get(source) ?? new Map<string, Promise<Read>>();
    this.#read.set(source, bySource);
    let pending = bySource.get(rel);
    if (!pending) {
      pending = readTexture(source, rel, ref);
      bySource.set(rel, pending);
    }
    const { texture, warning } = await pending;
    if (!texture) {
      const once = `${draft.id}\0${key}`;
      if (warning && !this.#warned.has(once)) {
        this.#warned.add(once);
        this.warnings.push(warning);
      }
      return null;
    }
    draft.addTexture(key, texture);
    return key;
  }
}

async function readTexture(source: AssetSource, rel: string, ref: string): Promise<Read> {
  const bytes = await source.bytes(rel);
  if (!bytes) return { texture: null, warning: `texture image missing: ${ref}` };
  let image: Awaited<ReturnType<typeof decodePng>>;
  try {
    image = await decodePng(bytes);
  } catch {
    return { texture: null, warning: `texture image unreadable: ${ref}` };
  }
  const { width, height, rgba } = image;
  if (width !== height) {
    // Animation frames are stacked downwards as squares, so a tall image is a strip when its
    // height is a whole number of frames, or when a .mcmeta says it animates; a wider-than-tall
    // or ragged image is neither, and drawing a guess of it would be wrong.
    const strip =
      height > width && (height % width === 0 || (await hasAnimation(source, `${rel}.mcmeta`)));
    if (!strip) {
      return {
        texture: null,
        warning: `texture image not square (${width}x${height}), skipped: ${ref}`,
      };
    }
  }
  // Only the first frame is kept (the library has no animation yet).
  let square = rgba;
  if (width !== height) {
    square = new Uint8Array(width * width * 4);
    square.set(rgba.subarray(0, width * width * 4));
  }
  return { texture: textureOf(square, width) };
}

async function hasAnimation(source: AssetSource, mcmeta: string): Promise<boolean> {
  const text = await readText(source, mcmeta);
  if (!text) return false;
  try {
    const json: unknown = JSON.parse(text.replace(/^﻿/, ""));
    return typeof json === "object" && json !== null && "animation" in json;
  } catch {
    return false;
  }
}
