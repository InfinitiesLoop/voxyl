// The GPU side of block textures (see BlockMaterials in @voxyl/session): which material each
// face of each cell state draws with, the materials (a texture layer, how positions on the
// face map to texture coordinates, and a tint), and the texture layers. Everything here is
// a table keyed by state id, so a re-skin rewrites tables and never touches a mesh.

import { FACE_SLOTS, MATERIAL_FLOATS, TEXTURE_SIZE } from "@voxyl/session";
import { texture } from "three/tsl";
import * as THREE from "three/webgpu";
import type { LooksUpdate } from "../world/protocol.ts";

/** Face table: two RGBA texels (FACE_SLOTS entries) per state, for every possible state id. */
export const FACE_WIDTH = 512;
const FACE_HEIGHT = (65536 * FACE_SLOTS) / 4 / FACE_WIDTH;
/** Material table: MATERIAL_TEXELS texels per material, MATERIALS_PER_ROW to a row. */
export const MATERIAL_TEXELS = MATERIAL_FLOATS / 4;
export const MATERIALS_PER_ROW = 256;
const MATERIAL_ROWS = 64;
const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;

const textureNode = (t: THREE.Texture) => texture(t);
type TextureNode = ReturnType<typeof textureNode>;

export class BlockTextures {
  readonly faces: THREE.DataTexture;
  readonly materials: THREE.DataTexture;
  /** The texture layers, followed as the array grows: sample through this node. */
  readonly layers: TextureNode;
  // Floats rather than integers, which both backends sample alike; exact to 2^24.
  readonly #faceData = new Float32Array(FACE_WIDTH * FACE_HEIGHT * 4);
  readonly #materialData = new Float32Array(
    MATERIALS_PER_ROW * MATERIAL_TEXELS * MATERIAL_ROWS * 4,
  );
  #layerData: Uint8Array;
  #layerTexture: THREE.DataArrayTexture;
  #layerCount = 0;

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
    [this.#layerData, this.#layerTexture] = this.#createLayers(16);
    this.layers = textureNode(this.#layerTexture);
  }

  /** Bytes held on the GPU (mipmaps aside). */
  get memoryBytes(): number {
    return this.#faceData.byteLength + this.#materialData.byteLength + this.#layerData.byteLength;
  }

  get layerCount(): number {
    return this.#layerCount;
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
    const added = rgba.length / TEXTURE_BYTES;
    if (added === 0) return;
    if (from !== this.#layerCount) {
      console.warn(`Texture layers out of step: have ${this.#layerCount}, sent from ${from}`);
      return;
    }
    const needed = from + added;
    const depth = this.#layerTexture.image.depth;
    if (needed > depth) {
      let grown = depth;
      while (grown < needed) grown *= 2;
      const [data, tex] = this.#createLayers(grown);
      data.set(this.#layerData);
      this.#layerTexture.dispose();
      this.#layerData = data;
      this.#layerTexture = tex;
      this.layers.value = tex;
    }
    this.#layerData.set(rgba, from * TEXTURE_BYTES);
    this.#layerCount = needed;
    this.#layerTexture.needsUpdate = true;
  }

  dispose(): void {
    this.faces.dispose();
    this.materials.dispose();
    this.#layerTexture.dispose();
  }

  #createLayers(depth: number): [Uint8Array, THREE.DataArrayTexture] {
    const data = new Uint8Array(TEXTURE_BYTES * depth);
    const tex = new THREE.DataArrayTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, depth);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return [data, tex];
  }
}

function nearest(t: THREE.DataTexture): void {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
}
