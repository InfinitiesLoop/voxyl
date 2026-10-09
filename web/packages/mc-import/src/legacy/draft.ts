// A block library under construction. A `Library` is immutable data; the importers that fill one
// (the NEI roster pass here, the pack healers after it) need to add, replace and remove
// pieces as they go, look blocks up by their Minecraft identity, and mint names. This holds
// all of that in one place so each of them doesn't keep its own copy, and `toLibrary()` hands
// the result on as a plain `Library`.
//
// Nothing here knows about a mod. It is the "library" half of CLAUDE.md's principle 1: blocks,
// models and textures, with the Minecraft identity in `Block.mc` and nowhere else.

import {
  type Block,
  type Library,
  MC_SIDES,
  type McSide,
  type Model,
  type Texture,
} from "@voxyl/blocks";

/** The key a block's `mc` identity is looked up by: "registry@meta". */
export const identityKey = (registry: string, meta = 0): string => `${registry}@${meta}`;

export interface CubeOptions {
  /**
   * The model's key in the library. Default `<namespace>:heal/<name>`; the NEI roster uses
   * `<texture namespace>:nei/<name>`. Adding a cube again under the same key replaces the model.
   */
  readonly modelKey?: string;
  /** The namespace part of the default model key (default: the library's id). */
  readonly namespace?: string;
  /** Corners in sixteenths of a cell, for a cube that isn't the whole cell. Default 0..16. */
  readonly from?: readonly [number, number, number];
  readonly to?: readonly [number, number, number];
  /** The Minecraft identity to record (see `Block.mc`). Merged over an existing block's. */
  readonly mc?: NonNullable<Block["mc"]>;
  /** Overrides the colour taken from the top-most face's texture, "#rrggbb". */
  readonly color?: string;
  readonly emits?: number;
  readonly hidden?: boolean;
}

/** Which face supplies a cube's colour: seen from above first, the underside last. */
const COLOR_ORDER: readonly McSide[] = ["up", "north", "south", "east", "west", "down"];

export class LibraryDraft {
  readonly id: string;
  name: string;
  /** Null-prototype records, so a block called "constructor" or "__proto__" is just a name. */
  readonly blocks: Record<string, Block> = Object.create(null);
  readonly models: Record<string, Model> = Object.create(null);
  readonly textures: Record<string, Texture> = Object.create(null);
  /** "registry@meta" -> block name, the last block carrying that identity. */
  readonly #byIdentity = new Map<string, string>();

  /** An empty draft, or one that carries on from an existing library (copied, not changed). */
  constructor(id: string, name: string = id, from?: Library) {
    this.id = id;
    this.name = name;
    if (from) {
      Object.assign(this.blocks, from.blocks);
      Object.assign(this.models, from.models);
      Object.assign(this.textures, from.textures);
      for (const [blockName, block] of Object.entries(this.blocks)) this.#index(blockName, block);
    }
  }

  // --- Textures ---

  hasTexture(key: string): boolean {
    return key in this.textures;
  }

  texture(key: string): Texture | undefined {
    return this.textures[key];
  }

  /** Adds or replaces a texture. Keys are "<namespace>:<path>" without `textures/` or `.png`. */
  addTexture(key: string, texture: Texture): void {
    this.textures[key] = texture;
  }

  // --- Models ---

  addModel(key: string, model: Model): void {
    this.models[key] = model;
  }

  // --- Blocks ---

  hasBlock(name: string): boolean {
    return name in this.blocks;
  }

  block(name: string): Block | undefined {
    return this.blocks[name];
  }

  /** Adds or replaces the block called `name`. */
  addBlock(name: string, block: Block): void {
    const old = this.blocks[name];
    if (old?.mc) this.#unindex(name, old);
    this.blocks[name] = block;
    this.#index(name, block);
  }

  removeBlock(name: string): void {
    const old = this.blocks[name];
    if (!old) return;
    this.#unindex(name, old);
    delete this.blocks[name];
  }

  /**
   * The block a previous import already made for this registry name and meta, if any. A
   * re-import (and a heal) looks here first and updates that block in place, so running it
   * again never mints "Name 2", "Name 3". Identity is the registry plus meta, not the display
   * name, which can change between runs.
   */
  findByIdentity(registry: string, meta = 0): { name: string; block: Block } | undefined {
    const name = this.#byIdentity.get(identityKey(registry, meta));
    const block = name === undefined ? undefined : this.blocks[name];
    return name !== undefined && block ? { name, block } : undefined;
  }

  /**
   * A block name not taken yet: `base`, else `base 2`, `base 3`... (or whatever `format`
   * makes of the base and the number; the NEI roster uses "Name (2)"). Display names repeat
   * across machines and mods, so they are safe to use as block names only through this.
   */
  uniqueName(base: string, format: (base: string, n: number) => string = (b, n) => `${b} ${n}`) {
    if (!this.hasBlock(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = format(base, n);
      if (!this.hasBlock(candidate)) return candidate;
    }
  }

  /**
   * A single-cube block, drawn with one texture per side. `faces` maps sides to texture keys
   * already in the draft (`addTexture`); a side whose texture is missing is left out. Returns
   * the block, or null (adding nothing) when no side has a texture.
   *
   * The block is `variants: {"": {model}}`. An opaque texture's face culls against the
   * neighbour on its side; the block is `transparent` when any face's texture isn't opaque
   * (glass, leaves, anything with holes) so light and culling treat it that way; its colour is
   * the average of the top-most face's texture. Calling it for a name that exists updates that
   * block in place: its drawing is replaced and what else it carries (`emits`, `hidden`, `mc`
   * fields not given) is kept.
   */
  addCube(
    name: string,
    faces: Readonly<Partial<Record<McSide, string>>>,
    opts: CubeOptions = {},
  ): Block | null {
    const modelFaces: Partial<Record<McSide, { texture: string; cullface?: McSide }>> = {};
    let transparent = false;
    for (const side of MC_SIDES) {
      const key = faces[side];
      const texture = key === undefined ? undefined : this.textures[key];
      if (key === undefined || !texture) continue;
      const opaque = texture.alpha === "opaque";
      if (!opaque) transparent = true;
      modelFaces[side] = { texture: key, ...(opaque && { cullface: side }) };
    }
    if (Object.keys(modelFaces).length === 0) return null;

    const modelKey =
      opts.modelKey ?? `${opts.namespace ?? this.id}:heal/${name.replace(/[:/\\?*"|%<>]/g, "_")}`;
    this.models[modelKey] = {
      elements: [{ from: opts.from ?? [0, 0, 0], to: opts.to ?? [16, 16, 16], faces: modelFaces }],
    };

    const colorSide = COLOR_ORDER.find((side) => modelFaces[side]);
    const colorKey = colorSide && modelFaces[colorSide]?.texture;
    const color =
      opts.color ?? (colorKey ? this.textures[colorKey]?.color : undefined) ?? "#808080";

    const old = this.blocks[name];
    const mc = opts.mc ? { ...old?.mc, ...opts.mc } : old?.mc;
    const emits = opts.emits ?? old?.emits;
    const hidden = opts.hidden ?? old?.hidden;
    const block: Block = {
      variants: { "": { model: modelKey } },
      color,
      ...(transparent && { transparent: true }),
      ...(emits !== undefined && { emits }),
      ...(hidden && { hidden: true }),
      ...(old?.attachment && { attachment: old.attachment }),
      ...(mc && { mc }),
    };
    this.addBlock(name, block);
    return block;
  }

  /** The library as it stands now. The records are copies; the blocks, models and textures aren't. */
  toLibrary(): Library {
    return {
      id: this.id,
      name: this.name,
      blocks: { ...this.blocks },
      models: { ...this.models },
      textures: { ...this.textures },
    };
  }

  #index(name: string, block: Block) {
    if (block.mc) this.#byIdentity.set(identityKey(block.mc.registry, block.mc.meta ?? 0), name);
  }

  #unindex(name: string, block: Block) {
    if (!block.mc) return;
    const key = identityKey(block.mc.registry, block.mc.meta ?? 0);
    if (this.#byIdentity.get(key) === name) this.#byIdentity.delete(key);
  }
}
