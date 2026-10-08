// Block libraries: what a look's `block` ("library:block") refers to. A library holds blocks,
// the models they draw with and the textures those use, in the same shape whether it is the
// built-in default set or imported from a Minecraft jar. Models and blockstates follow
// Minecraft's formats (elements of axis-aligned boxes; variants and multipart), already
// resolved: models have no parents, textures no "#references", so nothing here reads files.
//
// Nothing in a library is ever stored in a cell (CLAUDE.md principle 1): cells hold semantics,
// a palette's looks name blocks, and a library says how a block draws.

/** Minecraft's side names, which models and blockstates use. */
export const MC_SIDES = ["down", "up", "north", "south", "west", "east"] as const;
export type McSide = (typeof MC_SIDES)[number];

/** How a texture's alpha is used: opaque, cut out (alpha 0 or 1), or blended. */
export type Alpha = "opaque" | "cutout" | "blend";

export interface Texture {
  /** Square, a power of two (16 for every vanilla block texture). */
  readonly size: number;
  /** size * size * 4 bytes, rows top to bottom. Animated textures keep their first frame. */
  readonly rgba: Uint8Array;
  readonly alpha: Alpha;
  /** Average colour of its opaque pixels, "#rrggbb". */
  readonly color: string;
}

export interface Face {
  /** A texture key of the library. */
  readonly texture: string;
  /** [u1, v1, u2, v2] in 0..16; Minecraft's default (from the element's box) when absent. */
  readonly uv?: readonly [number, number, number, number];
  readonly rotation?: 0 | 90 | 180 | 270;
  /** Hidden when the neighbour on this side covers it. */
  readonly cullface?: McSide;
  /** A colour to multiply in, "#rrggbb" (the importer resolves Minecraft's tint index). */
  readonly tint?: string;
}

export interface Element {
  /** Corners in sixteenths of a cell, 0..16 (Minecraft allows -16..32). */
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly faces: Readonly<Partial<Record<McSide, Face>>>;
  /**
   * A turn about one axis through `origin` (plants, torches), in degrees; with `rescale` the
   * element is stretched across the other two axes so it still spans the cell, as Minecraft
   * does for its crossed plants.
   */
  readonly rotation?: {
    readonly origin: readonly [number, number, number];
    readonly axis: "x" | "y" | "z";
    readonly angle: number;
    readonly rescale?: boolean;
  };
  readonly shade?: boolean;
}

export interface Model {
  readonly elements: readonly Element[];
}

/** A model placed by a blockstate: Minecraft's x and y turns and uvlock. */
export interface Variant {
  readonly model: string;
  readonly x?: 0 | 90 | 180 | 270;
  readonly y?: 0 | 90 | 180 | 270;
  readonly uvlock?: boolean;
}

/** A multipart condition: property values ("a|b" for either), or OR / AND of conditions. */
export type Condition =
  | Readonly<Record<string, string>>
  | { readonly OR: readonly Condition[] }
  | { readonly AND: readonly Condition[] };

export interface Block {
  /**
   * Blockstate variants by their property string ("facing=north,half=bottom"; "" when the
   * block has no properties). Each holds one variant (Minecraft's random choices: the first).
   */
  readonly variants?: Readonly<Record<string, Variant>>;
  /** Minecraft's multipart blockstates: every case whose condition holds is drawn. */
  readonly multipart?: readonly {
    readonly when?: Condition;
    readonly apply: Variant;
  }[];
  /** Lets light through (glass, leaves, anything not a full opaque cube). */
  readonly transparent?: boolean;
  /** Light level it gives off, 1..15. */
  readonly emits?: number;
  /** Average colour, "#rrggbb": how it draws where textures don't. */
  readonly color: string;
  /** Not offered by the block picker: the app draws with it itself (the undecided look). */
  readonly hidden?: boolean;
}

export interface Library {
  /** The part before the colon in "library:block". */
  readonly id: string;
  readonly name: string;
  readonly blocks: Readonly<Record<string, Block>>;
  readonly models: Readonly<Record<string, Model>>;
  readonly textures: Readonly<Record<string, Texture>>;
}

/** Splits "library:block"; a bare name has no library. */
export function parseBlockRef(ref: string): { library: string; block: string } | null {
  const colon = ref.indexOf(":");
  if (colon <= 0 || colon === ref.length - 1) return null;
  return { library: ref.slice(0, colon), block: ref.slice(colon + 1) };
}
