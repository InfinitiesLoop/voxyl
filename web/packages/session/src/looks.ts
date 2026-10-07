// What each cell state looks like, from the project's registry: semantics resolve their looks
// through palette inheritance, so re-skinning a palette changes this table and never a cell.
// A look that names a block ("library:block") draws with that block's textures when a library
// here has it, and as the look's tint otherwise.

import {
  type CompiledBlock,
  type CompiledFace,
  compileBlock,
  type Libraries,
  parseBlockRef,
  type Texture,
} from "@voxyl/blocks";
import {
  type CellState,
  type CellStateTable,
  IDENTITY,
  type Look,
  ROOT_PALETTE,
  type Rotation,
  type SemanticId,
  type SemanticRegistry,
} from "@voxyl/core";
import { type LightMaterials, packEmission } from "@voxyl/light";
import { slotName } from "@voxyl/shapes";

/** How an undecided semantic with no hint colour draws. */
export const UNDECIDED_COLOR = "#8a8f98";
/** Light level of a glowing look. */
const GLOW_LEVEL = 15;
/** Entries per state in StateLooks.faces: one per face (+X, -X, +Y, -Y, +Z, -Z), then two unused. */
export const FACE_SLOTS = 8;
/**
 * Floats per material in BlockMaterials.data: the face's uv map (two rows of four, see
 * faceUvMap in @voxyl/blocks), then its texture layer and tint (red, green, blue, 0..1).
 */
export const MATERIAL_FLOATS = 12;
/** Every texture in the layers is this size; others draw untextured for now. */
export const TEXTURE_SIZE = 16;
const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;

/**
 * The textured faces the looks use so far, numbered for the renderer: materials (a texture
 * layer, a uv map and a tint) and the texture layers they draw from. Numbers only grow, so
 * the renderer can add what is new; one is kept per open world.
 */
export class BlockMaterials {
  readonly libraries: Libraries;
  readonly #layers = new Map<string, number>();
  readonly #pixels: Uint8Array[] = [];
  #taken = 0;
  readonly #materials = new Map<string, number>();
  /** Material 0 is "untextured", so a face entry of 0 means none. */
  #data: number[] = new Array(MATERIAL_FLOATS).fill(0);

  constructor(libraries: Libraries) {
    this.libraries = libraries;
  }

  /** Materials so far, MATERIAL_FLOATS each, material 0 first. */
  get data(): Float32Array {
    return Float32Array.from(this.#data);
  }

  get layerCount(): number {
    return this.#pixels.length;
  }

  /** The material number of a face, or 0 if its texture can't be drawn. */
  material(face: CompiledFace): number {
    const layer = this.#layer(face.texture);
    if (layer < 0) return 0;
    const tint = face.tint ? hexRgb(face.tint) : [1, 1, 1];
    const values = [...face.map, layer, ...tint];
    const key = values.join(",");
    let index = this.#materials.get(key);
    if (index === undefined) {
      index = this.#data.length / MATERIAL_FLOATS;
      this.#data.push(...values);
      this.#materials.set(key, index);
    }
    return index;
  }

  /** Pixels of the layers added since the last call, TEXTURE_SIZE² RGBA each, from layer `from`. */
  takeTextures(): { from: number; rgba: Uint8Array } {
    const from = this.#taken;
    const rgba = new Uint8Array((this.#pixels.length - from) * TEXTURE_BYTES);
    for (let i = from; i < this.#pixels.length; i++)
      rgba.set(this.#pixels[i] as Uint8Array, (i - from) * TEXTURE_BYTES);
    this.#taken = this.#pixels.length;
    return { from, rgba };
  }

  #layer(ref: string): number {
    const known = this.#layers.get(ref);
    if (known !== undefined) return known;
    const parsed = parseBlockRef(ref);
    const texture: Texture | undefined = parsed
      ? this.libraries.get(parsed.library)?.textures[parsed.block]
      : undefined;
    const layer = texture && texture.size === TEXTURE_SIZE ? this.#pixels.length : -1;
    if (texture && layer >= 0) this.#pixels.push(texture.rgba);
    this.#layers.set(ref, layer);
    return layer;
  }
}

export interface StateLooks {
  /**
   * Four bytes per state id (index 0 is empty): red, green, blue, and 1 if it glows. A state of
   * parts is coloured per part, through the plain state of each part's semantic.
   */
  readonly colors: Uint8Array;
  /**
   * FACE_SLOTS per state id: each face's material (see BlockMaterials), 0 where it draws in its
   * colour. Only states of whole cubes with a block have any.
   */
  readonly faces: Uint16Array;
  /** 1 per state id for a whole cube that can be seen through (ShapeTable.clear). */
  readonly clear: Uint8Array;
  /** Opacity and emission for the light engine. */
  readonly materials: LightMaterials;
}

/** The block a look names, compiled for a rotation, if `blocks` has its library. */
function blockOf(look: Look, rotation: Rotation, blocks?: BlockMaterials): CompiledBlock | null {
  if (!look.block || !blocks) return null;
  return compileBlock(blocks.libraries, look.block, rotation);
}

/** A look's colour: its block's average colour if a library has the block, else its tint. */
export function lookColor(look: Look, blocks?: BlockMaterials): string {
  return blockOf(look, IDENTITY, blocks)?.color ?? look.tint ?? UNDECIDED_COLOR;
}

/**
 * Resolves the look of every state in `states`. Without `blocks`, every look draws as its
 * tint; with it, a look naming a block draws that block's textures, and its light follows
 * the block (glass lets light through, light sources glow).
 */
export function stateLooks(
  states: CellStateTable,
  registry: SemanticRegistry,
  blocks?: BlockMaterials,
): StateLooks {
  const size = states.size + 1;
  const colors = new Uint8Array(size * 4);
  const faces = new Uint16Array(size * FACE_SLOTS);
  const clear = new Uint8Array(size);
  const opaque = new Uint8Array(size);
  const emission = new Uint16Array(size);
  const looks = new Map<SemanticId, Look>();
  const lookOf = (semantic: SemanticId): Look => {
    let look = looks.get(semantic);
    if (!look) {
      look = registry.has(semantic) ? registry.resolve(semantic).look : {};
      looks.set(semantic, look);
    }
    return look;
  };
  for (let id = 1; id < size; id++) {
    const state = states.get(id);
    if (!state) continue;
    const parts = state.parts;
    // A cell of parts is drawn per part; it glows if any part does. Shaped parts let light
    // through, as Minecraft lights slabs and stairs from their neighbours.
    const look =
      parts.length > 0
        ? (parts.map((p) => lookOf(p.semantic)).find((l) => l.glow) ??
          lookOf(parts[0]?.semantic ?? 0))
        : lookOf(state.semantic);
    const block = parts.length > 0 ? null : blockOf(look, state.rotation, blocks);
    const color =
      parts.length > 0 ? lookColor(look, blocks) : (block?.color ?? lookColor(look, blocks));
    const rgb = Number.parseInt(color.slice(1), 16);
    colors[id * 4] = (rgb >> 16) & 0xff;
    colors[id * 4 + 1] = (rgb >> 8) & 0xff;
    colors[id * 4 + 2] = rgb & 0xff;
    colors[id * 4 + 3] = look.glow ? 1 : 0;
    opaque[id] = parts.length > 0 || block?.transparent ? 0 : 1;
    const level = look.glow ? GLOW_LEVEL : (block?.emits ?? 0);
    if (level > 0) emission[id] = packEmission(color, level);
    // Other shapes (slabs, stairs) draw as coloured cubes until block models are meshed.
    if (block?.cube && blocks) {
      block.cube.forEach((face, f) => {
        faces[id * FACE_SLOTS + f] = face ? blocks.material(face) : 0;
      });
      if (block.cube.some((face) => face?.alpha !== "opaque")) clear[id] = 1;
    }
  }
  return { colors, faces, clear, materials: { opaque, emission } };
}

function hexRgb(color: string): [number, number, number] {
  const n = Number.parseInt(color.replace("#", ""), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** A cell state in words: "Trim", or its parts, "Trim strip down, Glass post center-y". */
export function describeState(state: CellState, registry: SemanticRegistry): string {
  const name = (semantic: SemanticId) => {
    if (!registry.has(semantic)) return "unknown";
    const resolved = registry.resolve(semantic);
    const palette =
      resolved.palette === ROOT_PALETTE ? "" : ` (${registry.palette(resolved.palette).name})`;
    return `${resolved.name}${palette}`;
  };
  if (state.parts.length === 0) return name(state.semantic);
  return state.parts
    .map((p) => `${name(p.semantic)} ${p.shape} ${slotName(p.shape, p.slot)}`)
    .join(", ");
}
