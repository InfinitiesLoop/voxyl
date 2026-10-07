// The GPU side of block textures (see BlockMaterials in @voxyl/session): which material each
// face of each cell state draws with, and each slot of a block model's faces, the materials
// (a texture tile, how positions on the face map to texture coordinates, and a tint), and the
// texture atlas. Everything here is a table keyed by state id, so a re-skin rewrites tables
// and touches no mesh, unless it changes a block's shape.

import { FACE_SLOTS, MATERIAL_FLOATS, TEXTURE_SIZE } from "@voxyl/session";
import { texture, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import type { LooksUpdate } from "../world/protocol.ts";

/** Face table: two RGBA texels (FACE_SLOTS entries) per state, for every possible state id. */
export const FACE_WIDTH = 512;
const FACE_HEIGHT = (65536 * FACE_SLOTS) / 4 / FACE_WIDTH;
/** Model slot list: block models' face materials, four a texel, SLOT_WIDTH texels a row. */
export const SLOT_WIDTH = 512;
const SLOT_ROWS = 16;
/** The most slot list rows (4M slots). */
const MAX_SLOT_ROWS = 2048;
/** Material table: MATERIAL_TEXELS texels per material, MATERIALS_PER_ROW to a row. */
export const MATERIAL_TEXELS = MATERIAL_FLOATS / 4;
export const MATERIALS_PER_ROW = 256;
const MATERIAL_ROWS = 64;
/**
 * The atlas is ATLAS_COLUMNS tiles wide and a power of two tall. Tiles sit on a grid of
 * their own size, so the mipmaps of one tile never mix with its neighbours' down to
 * MAX_TEXTURE_LOD (a tile of one pixel); the shader stops there.
 */
export const ATLAS_COLUMNS = 32;
export const MAX_TEXTURE_LOD = Math.log2(TEXTURE_SIZE);
/** The most tile rows: 8192 pixels, the smallest texture size every device allows. */
const MAX_ROWS = 8192 / TEXTURE_SIZE;
const TILE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;

const textureNode = (t: THREE.Texture) => texture(t);
export type TextureNode = ReturnType<typeof textureNode>;

export class BlockTextures {
  readonly faces: THREE.DataTexture;
  /** The model slot list, followed as it grows: read through this node. */
  readonly modelSlots: TextureNode;
  readonly materials: THREE.DataTexture;
  /** The atlas, followed as it grows: sample through this node. */
  readonly atlas: TextureNode;
  /** Tile rows in the atlas, for the shader. */
  readonly atlasRows = uniform(8);
  // Floats rather than integers, which both backends sample alike; exact to 2^24.
  readonly #faceData = new Float32Array(FACE_WIDTH * FACE_HEIGHT * 4);
  #slotTexture: THREE.DataTexture;
  readonly #materialData = new Float32Array(
    MATERIALS_PER_ROW * MATERIAL_TEXELS * MATERIAL_ROWS * 4,
  );
  #atlasTexture: THREE.DataTexture;
  #tileCount = 0;

  constructor() {
    this.faces = floatTable(this.#faceData, FACE_WIDTH, FACE_HEIGHT);
    this.#slotTexture = floatTable(
      new Float32Array(SLOT_WIDTH * SLOT_ROWS * 4),
      SLOT_WIDTH,
      SLOT_ROWS,
    );
    this.modelSlots = textureNode(this.#slotTexture);
    this.materials = floatTable(
      this.#materialData,
      MATERIALS_PER_ROW * MATERIAL_TEXELS,
      MATERIAL_ROWS,
    );
    this.#atlasTexture = createAtlas(this.atlasRows.value);
    this.atlas = textureNode(this.#atlasTexture);
  }

  /** Bytes held on the GPU (mipmaps aside). */
  get memoryBytes(): number {
    return (
      this.#faceData.byteLength +
      (this.#slotTexture.image.data?.byteLength ?? 0) +
      this.#materialData.byteLength +
      (this.#atlasTexture.image.data?.byteLength ?? 0)
    );
  }

  get tileCount(): number {
    return this.#tileCount;
  }

  /** Takes in new looks from the world worker. */
  update(looks: LooksUpdate): void {
    this.#faceData.fill(0);
    this.#faceData.set(looks.faces.subarray(0, this.#faceData.length));
    this.faces.needsUpdate = true;
    this.#setModelSlots(looks.modelSlots);
    this.#materialData.fill(0);
    this.#materialData.set(looks.materials.subarray(0, this.#materialData.length));
    this.materials.needsUpdate = true;

    const { from, rgba } = looks.textures;
    const added = rgba.length / TILE_BYTES;
    if (added === 0) return;
    if (added === 0) return;
    if (from !== this.#tileCount) {
      console.warn(`Texture tiles out of step: have ${this.#tileCount}, sent from ${from}`);
      return;
    }
    const needed = from + added;
    let rows = this.atlasRows.value;
    while (rows * ATLAS_COLUMNS < needed && rows < MAX_ROWS) rows *= 2;
    if (rows !== this.atlasRows.value) {
      // Same width, so the tiles so far keep their place: copy the pixels across.
      const grown = createAtlas(rows);
      (grown.image.data as Uint8Array).set(this.#atlasTexture.image.data as Uint8Array);
      this.#atlasTexture.dispose();
      this.#atlasTexture = grown;
      this.atlas.value = grown;
      this.atlasRows.value = rows;
    }
    const data = this.#atlasTexture.image.data as Uint8Array;
    const width = ATLAS_COLUMNS * TEXTURE_SIZE;
    const count = Math.min(needed, rows * ATLAS_COLUMNS) - from;
    for (let i = 0; i < count; i++) {
      const tile = from + i;
      const x0 = (tile % ATLAS_COLUMNS) * TEXTURE_SIZE;
      const y0 = Math.floor(tile / ATLAS_COLUMNS) * TEXTURE_SIZE;
      for (let y = 0; y < TEXTURE_SIZE; y++) {
        const row = rgba.subarray(
          i * TILE_BYTES + y * TEXTURE_SIZE * 4,
          i * TILE_BYTES + (y + 1) * TEXTURE_SIZE * 4,
        );
        data.set(row, ((y0 + y) * width + x0) * 4);
      }
    }
    this.#tileCount = needed;
    this.#atlasTexture.needsUpdate = true;
  }

  dispose(): void {
    this.faces.dispose();
    this.#slotTexture.dispose();
    this.materials.dispose();
    this.#atlasTexture.dispose();
  }

  /** Writes the model slot list, growing its texture (doubling its rows) if it doesn't fit. */
  #setModelSlots(list: Uint16Array): void {
    let rows = this.#slotTexture.image.height;
    while (rows * SLOT_WIDTH * 4 < list.length && rows < MAX_SLOT_ROWS) rows *= 2;
    if (rows !== this.#slotTexture.image.height) {
      const grown = floatTable(new Float32Array(SLOT_WIDTH * rows * 4), SLOT_WIDTH, rows);
      this.#slotTexture.dispose();
      this.#slotTexture = grown;
      this.modelSlots.value = grown;
    }
    const data = this.#slotTexture.image.data as Float32Array;
    if (list.length > data.length) console.warn(`Model slot list too long: ${list.length} slots`);
    data.fill(0);
    data.set(list.subarray(0, data.length));
    this.#slotTexture.needsUpdate = true;
  }
}

/** A table of floats, read texel by texel. */
function floatTable(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  nearest(t);
  return t;
}

function createAtlas(rows: number): THREE.DataTexture {
  const width = ATLAS_COLUMNS * TEXTURE_SIZE;
  const height = rows * TEXTURE_SIZE;
  const tex = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  // Nearest within a level, so a tile's edge never blends with the next tile; linear
  // between levels.
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function nearest(t: THREE.DataTexture): void {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
}
