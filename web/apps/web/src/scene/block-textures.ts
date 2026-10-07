// The GPU side of block textures (see BlockMaterials in @voxyl/session): which material each
// face of each cell state draws with, the materials (a texture tile, how positions on the
// face map to texture coordinates, and a tint), and the texture atlas. Everything here is a
// table keyed by state id, so a re-skin rewrites tables and never touches a mesh.

import { FACE_SLOTS, MATERIAL_FLOATS, TEXTURE_SIZE } from "@voxyl/session";
import { texture, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import type { LooksUpdate } from "../world/protocol.ts";

/** Face table: two RGBA texels (FACE_SLOTS entries) per state, for every possible state id. */
export const FACE_WIDTH = 512;
const FACE_HEIGHT = (65536 * FACE_SLOTS) / 4 / FACE_WIDTH;
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
type TextureNode = ReturnType<typeof textureNode>;

export class BlockTextures {
  readonly faces: THREE.DataTexture;
  readonly materials: THREE.DataTexture;
  /** The atlas, followed as it grows: sample through this node. */
  readonly atlas: TextureNode;
  /** Tile rows in the atlas, for the shader. */
  readonly atlasRows = uniform(8);
  // Floats rather than integers, which both backends sample alike; exact to 2^24.
  readonly #faceData = new Float32Array(FACE_WIDTH * FACE_HEIGHT * 4);
  readonly #materialData = new Float32Array(
    MATERIALS_PER_ROW * MATERIAL_TEXELS * MATERIAL_ROWS * 4,
  );
  #atlasTexture: THREE.DataTexture;
  #tileCount = 0;

  constructor() {
    this.faces = new THREE.DataTexture(
      this.#faceData,
      FACE_WIDTH,
      FACE_HEIGHT,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    nearest(this.faces);
    this.materials = new THREE.DataTexture(
      this.#materialData,
      MATERIALS_PER_ROW * MATERIAL_TEXELS,
      MATERIAL_ROWS,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    nearest(this.materials);
    this.#atlasTexture = createAtlas(this.atlasRows.value);
    this.atlas = textureNode(this.#atlasTexture);
  }

  /** Bytes held on the GPU (mipmaps aside). */
  get memoryBytes(): number {
    return (
      this.#faceData.byteLength +
      this.#materialData.byteLength +
      (this.#atlasTexture.image.data?.byteLength ?? 0)
    );
  }

  get tileCount(): number {
    return this.#tileCount;
  }

  /** Takes in new looks from the world worker. */
  update(looks: LooksUpdate): void {
    const faces = looks.faces.subarray(0, this.#faceData.length);
    this.#faceData.fill(0);
    this.#faceData.set(faces);
    this.faces.needsUpdate = true;
    this.#materialData.fill(0);
    this.#materialData.set(looks.materials.subarray(0, this.#materialData.length));
    this.materials.needsUpdate = true;

    const { from, rgba } = looks.textures;
    const added = rgba.length / TILE_BYTES;
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
    this.materials.dispose();
    this.#atlasTexture.dispose();
  }
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
