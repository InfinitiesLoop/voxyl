// What a mod-specific healer is handed, and the toolkit it works with. The generic roster
// import turns every namespace into plain one-cube blocks the same neutral way; some mods
// model their blocks in ways that can't be recovered that way (GregTech composites a machine
// from a hull and a transparent overlay in Java and names it from a lang table). A healer runs
// after a namespace's roster import with its draft library and source in hand, and uses this
// toolkit: ingest or synthesise textures, emit a cube or pane, confirm a block's Minecraft
// identity, remove blocks it supersedes, read a text file that sits beside the mods.
//
// Textures here are RGBA arrays in memory (a library holds raw pixels, not PNGs), so a healer
// is a plain async function that tests in Node with no canvas. Everything it writes is made
// from textures the user's own game already holds; nothing is bundled.

import { type Block, type McSide, textureOf } from "@voxyl/blocks";
import { decodePng, type Image } from "../png.ts";
import type { AssetSource } from "../sources/index.ts";
import type { LibraryDraft } from "./draft.ts";
import { splitRef } from "./nei.ts";
import { paneModels } from "./pane-geometry.ts";
import type { TextureIngest } from "./texture.ts";

/** A rectangle of a texture: x, y, width, height in pixels. */
export type Rect = readonly [x: number, y: number, width: number, height: number];

/** A colour as "#rrggbb" or 0..255 channels. */
export type Color = string | readonly [number, number, number, number?];

export interface HealOptions {
  readonly draft: LibraryDraft;
  readonly source: AssetSource;
  /** The namespace being healed (its real, on-disk spelling). */
  readonly ns: string;
  /** Shared with the roster import, so a texture both use is read once and warnings share a list. */
  readonly ingest: TextureIngest;
  /** This install's numeric block id for a registry name (from NEI's block.csv), -1 if unknown. */
  readonly legacyIdFor?: (registry: string) => number;
  /** Text of a file beside the mods ("GregTech.lang"), "" when absent. */
  readonly siblingText?: (name: string) => Promise<string>;
}

/** The Minecraft identity a healed block is confirmed as (see `Block.mc`). */
export interface Identity {
  readonly registry: string;
  readonly meta: number;
  readonly orient?: "" | "half" | "stairs" | "log_axis";
}

export class HealContext {
  readonly draft: LibraryDraft;
  readonly source: AssetSource;
  readonly ns: string;
  /** Problems worth showing in the import report (shared with the ingest). */
  readonly warnings: string[];
  readonly #ingest: TextureIngest;
  readonly #legacyIdFor: (registry: string) => number;
  readonly #siblingText: (name: string) => Promise<string>;
  readonly #images = new Map<string, Promise<Image | null>>();

  constructor(opts: HealOptions) {
    this.draft = opts.draft;
    this.source = opts.source;
    this.ns = opts.ns;
    this.#ingest = opts.ingest;
    this.#legacyIdFor = opts.legacyIdFor ?? (() => -1);
    this.#siblingText = opts.siblingText ?? (async () => "");
    this.warnings = opts.ingest.warnings;
  }

  /**
   * The name of the block a previous run already made for this registry name and meta, if any.
   * Pass it to `addCube` instead of `uniqueName(display)` so running again refreshes that block
   * rather than minting "Name 2": a heal is keyed by Minecraft identity, not by whatever display
   * text it computes this time.
   */
  existingFor(registry: string, meta: number): string | undefined {
    return this.draft.findByIdentity(registry, meta)?.name;
  }

  // --- Textures ---

  /** Copies a texture of the source into the library (once per key). Its key, or null. */
  ensureTexture(ref: string): Promise<string | null> {
    return this.#ingest.ensure(this.draft, this.source, ref);
  }

  /** Whether the source carries this texture (probe for optional pieces before using them). */
  sourceHasTexture(ref: string): boolean {
    return this.source.has(refPath(ref));
  }

  /**
   * Draws `overlayRef` (a transparent icon) over `baseRef` (an opaque tile) and stores the
   * result under `outKey`: what a mod that composites a block's look in Java would draw. An
   * empty `baseRef` fills neutral grey instead (no hull available). An animated overlay
   * contributes its first frame, as every texture does here. Null (with a warning) if the
   * overlay can't be loaded; deduped by `outKey`.
   */
  async compositeTexture(
    outKey: string,
    baseRef: string,
    overlayRef: string,
  ): Promise<string | null> {
    if (this.draft.hasTexture(outKey)) return outKey;
    const overlay = await this.#frame(overlayRef);
    if (!overlay) {
      this.warnings.push(`composite overlay missing: ${overlayRef}`);
      return null;
    }
    const size = overlay.width;
    const out = new Uint8Array(size * size * 4);
    const base = baseRef ? await this.#frame(baseRef) : null;
    if (base) {
      // The base tile repeated to fill the overlay (a hull may be smaller than the overlay).
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const from = ((y % base.height) * base.width + (x % base.width)) * 4;
          out.set(base.rgba.subarray(from, from + 4), (y * size + x) * 4);
        }
      }
    } else {
      for (let i = 0; i < out.length; i += 4) out.set([128, 128, 133, 255], i);
    }
    blend(out, overlay.rgba);
    this.draft.addTexture(outKey, textureOf(out, size));
    return outKey;
  }

  /**
   * A rectangle cropped out of `sourceRef` (a spritesheet icon), stored as its own static
   * texture. For a look that is one small piece of a larger sheet, or one frame that Java picks
   * per placement: voxyl binds one texture per block, so a fixed representative piece beats
   * squashing the whole sheet onto a face. Deduped by `outKey`.
   */
  async croppedTexture(outKey: string, sourceRef: string, rect: Rect): Promise<string | null> {
    if (this.draft.hasTexture(outKey)) return outKey;
    const image = await this.#image(sourceRef);
    if (!image) {
      this.warnings.push(`crop source missing: ${sourceRef}`);
      return null;
    }
    const [x0, y0, w, h] = rect;
    if (w !== h || x0 < 0 || y0 < 0 || x0 + w > image.width || y0 + h > image.height) {
      this.warnings.push(`crop outside the image or not square: ${sourceRef}`);
      return null;
    }
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const from = ((y0 + y) * image.width + x0) * 4;
      out.set(image.rgba.subarray(from, from + w * 4), y * w * 4);
    }
    this.draft.addTexture(outKey, textureOf(out, w));
    return outKey;
  }

  /** A flat single-colour texture with no source art, for a block that is just a colour. */
  solidTexture(outKey: string, color: Color, size = 16): string {
    if (this.draft.hasTexture(outKey)) return outKey;
    const [r, g, b, a] = rgba(color);
    const out = new Uint8Array(size * size * 4);
    for (let i = 0; i < out.length; i += 4) out.set([r, g, b, a], i);
    this.draft.addTexture(outKey, textureOf(out, size));
    return outKey;
  }

  /** A library texture's average colour as "#rrggbb" ("#808080" if it is not there). */
  averageColor(key: string): string {
    return this.draft.texture(key)?.color ?? "#808080";
  }

  /** The first (square) frame of a source texture, decoded once per context. */
  async #frame(ref: string): Promise<Image | null> {
    const image = await this.#image(ref);
    if (!image || image.height <= image.width) return image;
    return {
      width: image.width,
      height: image.width,
      rgba: image.rgba.subarray(0, image.width * image.width * 4),
    };
  }

  #image(ref: string): Promise<Image | null> {
    let pending = this.#images.get(ref);
    if (!pending) {
      pending = (async () => {
        const bytes = await this.source.bytes(refPath(ref));
        if (!bytes) return null;
        try {
          return await decodePng(bytes);
        } catch {
          return null;
        }
      })();
      this.#images.set(ref, pending);
    }
    return pending;
  }

  // --- Blocks ---

  /**
   * Adds or replaces a cube block drawn with one library texture per side. `from`/`to` (in
   * sixteenths) give a block whose real shape is thinner than a cube its own default look; the
   * palette's shaped parts make their own geometry regardless of this model. Returns whether a
   * block was made (when no side had a texture, nothing is added).
   */
  addCube(
    name: string,
    faces: Readonly<Partial<Record<McSide, string>>>,
    opts: {
      readonly color?: string;
      readonly from?: readonly [number, number, number];
      readonly to?: readonly [number, number, number];
      readonly mc?: NonNullable<Block["mc"]>;
    } = {},
  ): boolean {
    return this.draft.addCube(name, faces, { namespace: this.ns, ...opts }) !== null;
  }

  /**
   * Adds or replaces a connecting pane (thin centre post, an arm to each connected neighbour,
   * a cap on each free side): real geometry, not the cube fallback. `sideTexture` is the flat
   * face, `edgeTexture` the rim; both library keys.
   */
  addPane(
    name: string,
    sideTexture: string,
    edgeTexture: string,
    opts: { readonly color?: string; readonly mc?: NonNullable<Block["mc"]> } = {},
  ): void {
    const baseKey = `${this.ns}:heal/${name.replace(/[:/\\?*"|%<>]/g, "_")}`;
    const { models, block } = paneModels(baseKey, sideTexture, edgeTexture);
    for (const [key, model] of Object.entries(models)) this.draft.addModel(key, model);
    const old = this.draft.block(name);
    const mc = opts.mc ? { ...old?.mc, ...opts.mc } : old?.mc;
    this.draft.addBlock(name, {
      ...block,
      color: opts.color ?? this.averageColor(sideTexture),
      transparent: true,
      ...(old?.hidden && { hidden: true }),
      ...(old?.attachment && { attachment: old.attachment }),
      ...(mc && { mc }),
    });
  }

  /**
   * Records a healed block's real Minecraft identity for export. Always a confirmed one: a heal
   * binds a registry and meta straight from the NEI roster row that drove it, never a guess.
   */
  confirmRegistry(name: string, id: Identity): void {
    const block = this.draft.block(name);
    if (!block) return;
    const legacyId = this.#legacyIdFor(id.registry);
    this.draft.addBlock(name, {
      ...block,
      mc: {
        ...block.mc,
        registry: id.registry,
        meta: id.meta,
        ...(id.orient !== undefined && { orient: id.orient }),
        ...(legacyId >= 0 && { legacyId }),
      },
    });
  }

  uniqueName(base: string): string {
    return this.draft.uniqueName(base);
  }

  removeBlock(name: string): void {
    this.draft.removeBlock(name);
  }

  /** The model keys a block draws with (a healed block's are `<ns>:heal/…`). */
  blockModelKeys(name: string): string[] {
    const block = this.draft.block(name);
    return [
      ...Object.values(block?.variants ?? {}).map((v) => v.model),
      ...(block?.multipart ?? []).map((p) => p.apply.model),
    ];
  }

  /** The texture keys a block's models bind (to decide which blocks a heal supersedes). */
  blockTextureKeys(name: string): string[] {
    const keys = new Set<string>();
    for (const key of this.blockModelKeys(name)) {
      for (const element of this.draft.models[key]?.elements ?? []) {
        for (const face of Object.values(element.faces)) if (face) keys.add(face.texture);
      }
    }
    return [...keys];
  }

  // --- Files beside the mods ---

  /** Text of a file that sits next to the mods rather than in them ("GregTech.lang"), or "". */
  siblingText(name: string): Promise<string> {
    return this.#siblingText(name);
  }
}

/** "ns:path" to the source-relative PNG path. */
function refPath(ref: string): string {
  const { ns, path } = splitRef(ref);
  return `${ns}/textures/${path}.png`;
}

/** `over` drawn onto `base` (both RGBA, same size), alpha-composited. */
function blend(base: Uint8Array, over: Uint8Array): void {
  for (let i = 0; i < base.length; i += 4) {
    const a = (over[i + 3] ?? 0) / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      base[i + c] = Math.round((over[i + c] ?? 0) * a + (base[i + c] ?? 0) * (1 - a));
    }
    base[i + 3] = Math.max(base[i + 3] ?? 0, over[i + 3] ?? 0);
  }
}

function rgba(color: Color): [number, number, number, number] {
  if (typeof color !== "string") return [color[0], color[1], color[2], color[3] ?? 255];
  const n = Number.parseInt(color.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}
