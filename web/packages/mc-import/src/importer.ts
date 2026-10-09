// Turns a vanilla Minecraft client jar (1.13 or later) into a block library: blockstates as
// they are, models with their parents and "#texture" references resolved, and the textures
// those models use as RGBA. The jar is the user's own; the library stays on their device.

import {
  type Block,
  type Condition,
  type Element,
  type Face,
  type Library,
  MC_SIDES,
  type McSide,
  type Model,
  type Texture,
  textureOf,
  type Variant,
  variantFor,
} from "@voxyl/blocks";
import { IDENTITY } from "@voxyl/core";
import { decodePng } from "./png.ts";
import { utf8 } from "./streams.ts";
import { ZipReader } from "./zip.ts";

export const MINECRAFT_LIBRARY_ID = "minecraft";

const ROOT = "assets/minecraft/";

export interface ImportResult {
  readonly library: Library;
  /** The game version the jar says it is, e.g. "1.21". */
  readonly version: string;
  /** Blocks left out: no model draws anything (air, fluids, entity-drawn blocks like chests). */
  readonly skipped: readonly string[];
}

// --- Minecraft's JSON, as read ---

interface RawFace {
  readonly texture: string;
  readonly uv?: [number, number, number, number];
  readonly rotation?: 0 | 90 | 180 | 270;
  readonly cullface?: string;
  readonly tintindex?: number;
}

interface RawElement {
  readonly from: [number, number, number];
  readonly to: [number, number, number];
  readonly faces?: Readonly<Partial<Record<string, RawFace>>>;
  readonly rotation?: {
    origin: [number, number, number];
    axis: "x" | "y" | "z";
    angle: number;
    rescale?: boolean;
  };
  readonly shade?: boolean;
}

interface RawModel {
  readonly parent?: string;
  readonly textures?: Readonly<Record<string, string>>;
  readonly elements?: readonly RawElement[];
}

interface RawVariant {
  readonly model: string;
  readonly x?: 0 | 90 | 180 | 270;
  readonly y?: 0 | 90 | 180 | 270;
  readonly uvlock?: boolean;
}

type RawCondition =
  | Readonly<Record<string, string | boolean | number>>
  | { readonly OR: readonly RawCondition[] }
  | { readonly AND: readonly RawCondition[] };

interface RawBlockstate {
  readonly variants?: Readonly<Record<string, RawVariant | readonly RawVariant[]>>;
  readonly multipart?: readonly {
    readonly when?: RawCondition;
    readonly apply: RawVariant | readonly RawVariant[];
  }[];
}

/** A model with its parents applied: every texture variable, and the nearest elements. */
interface Resolved {
  readonly textures: Readonly<Record<string, string>>;
  readonly elements: readonly RawElement[] | null;
}

// --- Things the jar doesn't say ---

/** Colours Minecraft computes for tinted faces (biome colours at plains, and fixed ones). */
const GRASS = "#91bd59";
const FOLIAGE = "#77ab2f";
const TINTS: Readonly<Record<string, string>> = {
  grass_block: GRASS,
  short_grass: GRASS,
  grass: GRASS,
  tall_grass: GRASS,
  fern: GRASS,
  large_fern: GRASS,
  potted_fern: GRASS,
  sugar_cane: GRASS,
  birch_leaves: "#80a755",
  spruce_leaves: "#619961",
  lily_pad: "#208030",
  water: "#3f76e4",
  water_cauldron: "#3f76e4",
  redstone_wire: "#fc3100",
  attached_melon_stem: "#e0c71c",
  attached_pumpkin_stem: "#e0c71c",
  melon_stem: "#e0c71c",
  pumpkin_stem: "#e0c71c",
};

/** Light levels of blocks that give light in every state. */
const LIGHT: Readonly<Record<string, number>> = {
  glowstone: 15,
  sea_lantern: 15,
  jack_o_lantern: 15,
  lantern: 15,
  shroomlight: 15,
  beacon: 15,
  conduit: 15,
  ochre_froglight: 15,
  verdant_froglight: 15,
  pearlescent_froglight: 15,
  end_rod: 14,
  torch: 14,
  wall_torch: 14,
  soul_lantern: 10,
  soul_torch: 10,
  soul_wall_torch: 10,
  crying_obsidian: 10,
  redstone_torch: 7,
  redstone_wall_torch: 7,
  glow_lichen: 7,
  amethyst_cluster: 5,
  magma_block: 3,
};

const name = (ref: string) => (ref.startsWith("minecraft:") ? ref.slice(10) : ref);

/** Imports a client jar's blocks. */
export async function importJar(bytes: Uint8Array): Promise<ImportResult> {
  const zip = await ZipReader.fromBytes(bytes);
  const json = async <T>(path: string): Promise<T | null> => {
    const data = await zip.read(path);
    return data ? (JSON.parse(utf8.decode(data)) as T) : null;
  };
  const version = (await json<{ name?: string; id?: string }>("version.json")) ?? {};
  const states: string[] = [];
  for (const entry of zip.names()) {
    if (entry.startsWith(`${ROOT}blockstates/`) && entry.endsWith(".json"))
      states.push(entry.slice(ROOT.length + 12, -5));
  }
  if (states.length === 0) throw new Error("No blockstates: not a Minecraft 1.13+ client jar");
  states.sort();

  const resolved = new Map<string, Promise<Resolved | null>>();
  const resolve = (path: string, depth = 0): Promise<Resolved | null> => {
    let hit = resolved.get(path);
    if (!hit) {
      hit = (async () => {
        if (depth > 32) return null;
        const raw = await json<RawModel>(`${ROOT}models/${path}.json`);
        if (!raw) return null; // builtin/generated, builtin/entity, or missing
        const parent = raw.parent ? await resolve(name(raw.parent), depth + 1) : null;
        return {
          textures: { ...parent?.textures, ...raw.textures },
          elements: raw.elements ?? parent?.elements ?? null,
        };
      })();
      resolved.set(path, hit);
    }
    return hit;
  };

  const models: Record<string, Model> = {};
  const recipes = new Map<string, Layer[]>(); // texture key -> how to make it
  const blocks: Record<string, Block> = {};
  const skipped: string[] = [];

  /** Our model for `path` as drawn for a block with this tint; its key, or null if empty. */
  const modelFor = async (path: string, tint: string | undefined): Promise<string | null> => {
    const key = tint ? `${path}@${tint}` : path;
    if (key in models) return key;
    const r = await resolve(path);
    if (!r?.elements || r.elements.length === 0) return null;
    const resolveRef = (ref: string): string | null => {
      let at = ref;
      for (let i = 0; i < 16 && at.startsWith("#"); i++) {
        const next = r.textures[at.slice(1)];
        if (next === undefined) return null;
        at = next;
      }
      return at.startsWith("#") ? null : name(at);
    };
    const elements: Element[] = r.elements.map((e) => {
      const faces: Partial<Record<McSide, Face>> = {};
      for (const side of MC_SIDES) {
        const f = e.faces?.[side];
        const texture = f && resolveRef(f.texture);
        if (!f || !texture) continue;
        recipes.set(texture, [{ texture }]);
        faces[side] = {
          texture,
          ...(f.uv && { uv: f.uv }),
          ...(f.rotation && { rotation: f.rotation }),
          ...(isSide(f.cullface) && { cullface: f.cullface }),
          ...(f.tintindex !== undefined && tint && { tint }),
        };
      }
      return {
        from: e.from,
        to: e.to,
        faces,
        ...(e.rotation && {
          rotation: {
            origin: e.rotation.origin,
            axis: e.rotation.axis,
            angle: e.rotation.angle,
            ...(e.rotation.rescale && { rescale: true }),
          },
        }),
        ...(e.shade === false && { shade: false }),
      };
    });
    models[key] = { elements: mergeCubes(elements, recipes) };
    return key;
  };

  const variantOf = async (raw: RawVariant | readonly RawVariant[], tint?: string) => {
    // Minecraft picks among several at random; the first will do.
    const v = (Array.isArray(raw) ? raw[0] : raw) as RawVariant | undefined;
    if (!v) return null;
    const model = await modelFor(name(v.model), tint);
    if (!model) return null;
    const out: Variant = {
      model,
      ...(v.x && { x: v.x }),
      ...(v.y && { y: v.y }),
      ...(v.uvlock && { uvlock: true }),
    };
    return out;
  };

  for (const block of states) {
    const raw = await json<RawBlockstate>(`${ROOT}blockstates/${block}.json`);
    if (!raw) continue;
    const tint =
      TINTS[block] ?? (block.endsWith("_leaves") || block === "vine" ? FOLIAGE : undefined);
    const variants: Record<string, Variant> = {};
    for (const [key, v] of Object.entries(raw.variants ?? {})) {
      const variant = await variantOf(v, tint);
      if (variant) variants[key] = variant;
    }
    const multipart: { when?: Condition; apply: Variant }[] = [];
    for (const part of raw.multipart ?? []) {
      const apply = await variantOf(part.apply, tint);
      if (apply) multipart.push({ ...(part.when && { when: condition(part.when) }), apply });
    }
    if (Object.keys(variants).length === 0 && multipart.length === 0) {
      skipped.push(block);
      continue;
    }
    blocks[block] = {
      ...(Object.keys(variants).length > 0 && { variants }),
      ...(multipart.length > 0 && { multipart }),
      ...(LIGHT[block] && { emits: LIGHT[block] }),
      color: "#808080", // set once textures are read
    };
  }

  // The textures the models use, cut to their first frame; layered ones composited.
  const textures: Record<string, Texture> = {};
  const images = new Map<string, Promise<Texture | null>>();
  const image = (key: string): Promise<Texture | null> => {
    let hit = images.get(key);
    if (!hit) {
      hit = (async () => {
        const png = await zip.read(`${ROOT}textures/${key}.png`);
        if (!png) return null;
        const { width, height, rgba } = await decodePng(png);
        const size = Math.min(width, height);
        // Animated textures are frames stacked downwards; keep the first.
        const square = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++)
          square.set(rgba.subarray(y * width * 4, (y * width + size) * 4), y * size * 4);
        return textureOf(square, size);
      })();
      images.set(key, hit);
    }
    return hit;
  };
  for (const [key, layers] of recipes) {
    const texture = await composite(layers, image);
    if (texture) textures[key] = texture;
  }
  // Faces whose texture couldn't be read are dropped.
  for (const model of Object.values(models))
    for (const e of model.elements)
      for (const side of MC_SIDES) {
        const face = e.faces[side];
        if (face && !textures[face.texture])
          delete (e.faces as Partial<Record<McSide, Face>>)[side];
      }

  for (const [key, block] of Object.entries(blocks))
    blocks[key] = { ...block, color: blockColor(block, models, textures) };

  const id = version.name ?? version.id ?? "unknown";
  return {
    library: {
      id: MINECRAFT_LIBRARY_ID,
      name: `Minecraft ${id}`,
      blocks,
      models,
      textures,
    },
    version: id,
    skipped,
  };
}

function isSide(side: string | undefined): side is McSide {
  return side !== undefined && (MC_SIDES as readonly string[]).includes(side);
}

/** Blockstate conditions with every value as a string ("true", "1"). */
function condition(raw: RawCondition): Condition {
  if ("OR" in raw && Array.isArray(raw.OR)) return { OR: raw.OR.map(condition) };
  if ("AND" in raw && Array.isArray(raw.AND)) return { AND: raw.AND.map(condition) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  return out;
}

/** One layer of a texture: a texture of the jar, multiplied by a tint. */
interface Layer {
  readonly texture: string;
  readonly tint?: string;
}

const isWhole = (e: Element) =>
  !e.rotation && e.from.every((v) => v === 0) && e.to.every((v) => v === 16);
const fullUv = (f: Face) =>
  !f.rotation && (!f.uv || (f.uv[0] === 0 && f.uv[1] === 0 && f.uv[2] === 16 && f.uv[3] === 16));

/**
 * Several whole-cell elements (grass block sides: dirt, then a tinted grass overlay) become
 * one, each side's faces layered into one texture with their tints baked in, so a whole
 * cube stays one face per side.
 */
function mergeCubes(elements: readonly Element[], recipes: Map<string, Layer[]>): Element[] {
  if (elements.length < 2 || !elements.every(isWhole)) return [...elements];
  const faces: Partial<Record<McSide, Face>> = {};
  for (const side of MC_SIDES) {
    const stack = elements.flatMap((e) => (e.faces[side] ? [e.faces[side]] : []));
    const first = stack[0];
    if (!first) continue;
    if (stack.length === 1 || !stack.every(fullUv)) {
      faces[side] = first;
      continue;
    }
    const layers = stack.map((f) => ({ texture: f.texture, ...(f.tint && { tint: f.tint }) }));
    const key = layers.map((l) => (l.tint ? `${l.texture}@${l.tint}` : l.texture)).join("+");
    recipes.set(key, layers);
    faces[side] = { texture: key, ...(first.cullface && { cullface: first.cullface }) };
  }
  return [{ from: [0, 0, 0], to: [16, 16, 16], faces }];
}

/** A texture from layers drawn over each other, each tinted. */
async function composite(
  layers: readonly Layer[],
  image: (key: string) => Promise<Texture | null>,
): Promise<Texture | null> {
  const first = layers[0];
  if (!first) return null;
  const base = await image(first.texture);
  if (!base) return null;
  if (layers.length === 1 && !first.tint) return base;
  const rgba = new Uint8Array(base.rgba.length);
  for (const layer of layers) {
    const t = await image(layer.texture);
    if (!t || t.size !== base.size) continue;
    const tint = layer.tint ? rgbOf(layer.tint) : [255, 255, 255];
    for (let i = 0; i < rgba.length; i += 4) {
      const a = (t.rgba[i + 3] ?? 0) / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        const over = ((t.rgba[i + c] ?? 0) * (tint[c] ?? 255)) / 255;
        rgba[i + c] = Math.round(over * a + (rgba[i + c] ?? 0) * (1 - a));
      }
      rgba[i + 3] = Math.max(rgba[i + 3] ?? 0, t.rgba[i + 3] ?? 0);
    }
  }
  return textureOf(rgba, base.size);
}

/**
 * How a block draws where textures don't (the 2D view, untextured shapes): the colour of the
 * top of its plain variant, as a map seen from above shows it, tinted.
 */
function blockColor(
  block: Block,
  models: Readonly<Record<string, Model>>,
  textures: Readonly<Record<string, Texture>>,
): string {
  const variant = variantFor(block, IDENTITY) ?? block.multipart?.[0]?.apply;
  const model = variant ? models[variant.model] : undefined;
  for (const side of ["up", "north", "south", "east", "west", "down"] as const) {
    for (const e of model?.elements ?? []) {
      const face = e.faces[side];
      const texture = face ? textures[face.texture] : undefined;
      if (!face || !texture) continue;
      if (!face.tint) return texture.color;
      const [r, g, b] = rgbOf(texture.color);
      const [tr, tg, tb] = rgbOf(face.tint);
      return hex((r * tr) / 255, (g * tg) / 255, (b * tb) / 255);
    }
  }
  return "#808080";
}

function rgbOf(color: string): [number, number, number] {
  const n = Number.parseInt(color.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function hex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
