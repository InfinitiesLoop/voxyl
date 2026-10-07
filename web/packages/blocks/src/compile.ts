// A block as the renderer needs it for one cell rotation: whether it draws as a whole cube,
// and for each world side the texture and how it maps. Compiled from a library on demand and
// cached; looks name blocks, so this is what a palette swap recomputes (never cells).

import type { Rotation } from "@voxyl/core";
import { inverse, rotate } from "@voxyl/core";
import { type Alpha, type Library, parseBlockRef } from "./library.ts";
import { FACE_SIDES, faceUvMap, SIDE_NORMAL, sideOfNormal } from "./uv.ts";
import { placeBlock } from "./variants.ts";

/** A face's texture: "library:texture", its alpha use, a tint, and its uv map (see uv.ts). */
export interface CompiledFace {
  readonly texture: string;
  readonly alpha: Alpha;
  readonly tint: string | null;
  readonly map: Float32Array;
}

export interface CompiledBlock {
  readonly color: string;
  readonly transparent: boolean;
  readonly emits: number;
  /**
   * When the block draws as one whole cube: its faces in the mesher's order (+X, -X, +Y, -Y,
   * +Z, -Z), null where the model has none. Null for other shapes (drawn in their colour
   * until block models are meshed).
   */
  readonly cube: readonly (CompiledFace | null)[] | null;
}

/** The libraries a viewer has, by id. */
export type Libraries = ReadonlyMap<string, Library>;

const cache = new WeakMap<Library, Map<string, CompiledBlock>>();

/** The block a look names, compiled for a cell rotation; null if no library has it. */
export function compileBlock(
  libraries: Libraries,
  ref: string,
  rotation: Rotation,
): CompiledBlock | null {
  const parsed = parseBlockRef(ref);
  const library = parsed ? libraries.get(parsed.library) : undefined;
  const block = parsed && library ? library.blocks[parsed.block] : undefined;
  if (!parsed || !library || !block) return null;
  let compiled = cache.get(library);
  if (!compiled) {
    compiled = new Map();
    cache.set(library, compiled);
  }
  const key = `${parsed.block}@${rotation}`;
  const hit = compiled.get(key);
  if (hit) return hit;

  const placed = placeBlock(block, rotation);
  const only = placed.length === 1 ? placed[0] : undefined;
  const model = only ? library.models[only.model] : undefined;
  const element = model?.elements.length === 1 ? model.elements[0] : undefined;
  let cube: (CompiledFace | null)[] | null = null;
  if (only && element && isWholeCube(element)) {
    const back = inverse(only.rotation);
    cube = FACE_SIDES.map((worldSide) => {
      const side = sideOfNormal(rotate(back, SIDE_NORMAL[worldSide]));
      const face = element.faces[side];
      const texture = face ? library.textures[face.texture] : undefined;
      if (!face || !texture) return null;
      return {
        texture: `${library.id}:${face.texture}`,
        alpha: texture.alpha,
        tint: face.tint ?? null,
        map: faceUvMap(element, side, face, only.rotation, only.uvlock),
      };
    });
  }
  const seeThrough = cube === null || cube.some((f) => f === null || f.alpha !== "opaque");
  const result: CompiledBlock = {
    color: block.color,
    transparent: block.transparent ?? seeThrough,
    emits: block.emits ?? 0,
    cube,
  };
  compiled.set(key, result);
  return result;
}

function isWholeCube(e: { from: readonly number[]; to: readonly number[]; rotation?: unknown }) {
  return !e.rotation && e.from.every((v) => v === 0) && e.to.every((v) => v === 16);
}
