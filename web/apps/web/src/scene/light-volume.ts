import type { LightLayoutUpdate } from "@voxyl/session";
import { texture3D } from "three/tsl";
import * as THREE from "three/webgpu";

/** What the light volume needs from three's WebGPU backend, which it doesn't type. */
interface WebGPUBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device: GPUDevice;
  get(texture: THREE.Texture): { texture?: GPUTexture };
}

type TextureNode = ReturnType<typeof texture3D>;

/**
 * A 3D texture used as one long array of unsigned integers: element i lives at
 * (i % width, (i / width) % height, i / (width * height)). It grows a layer at a time,
 * copying what it holds on the GPU, and is written directly through the WebGPU queue in
 * row-aligned pieces. The shader reads it through `node`, which
 * follows the texture when it grows.
 */
class LinearTexture {
  readonly node: TextureNode;
  readonly widthBits: number;
  readonly heightBits: number;
  readonly #renderer: THREE.WebGPURenderer;
  readonly #backend: WebGPUBackendInternals;
  readonly #format: "r16uint" | "r32uint";
  readonly #bytes: number;
  #texture: THREE.Data3DTexture;
  #gpu: GPUTexture;
  #layers: number;

  constructor(
    renderer: THREE.WebGPURenderer,
    format: "r16uint" | "r32uint",
    widthBits: number,
    heightBits: number,
  ) {
    this.#renderer = renderer;
    this.#backend = renderer.backend as unknown as WebGPUBackendInternals;
    this.#format = format;
    this.#bytes = format === "r16uint" ? 2 : 4;
    this.widthBits = widthBits;
    this.heightBits = heightBits;
    this.#layers = 1;
    [this.#texture, this.#gpu] = this.#create(1);
    this.node = texture3D(this.#texture);
  }

  /** Elements per layer. */
  get #perLayer(): number {
    return 1 << (this.widthBits + this.heightBits);
  }

  get memoryBytes(): number {
    return this.#perLayer * this.#layers * this.#bytes;
  }

  /** Grows (keeping what it holds) to the fewest layers that fit `elements`. */
  ensure(elements: number): void {
    const layers = Math.max(this.#layers, Math.ceil(elements / this.#perLayer));
    if (layers === this.#layers) return;
    const [texture, gpu] = this.#create(layers);
    const encoder = this.#backend.device.createCommandEncoder();
    const W = 1 << this.widthBits;
    const H = 1 << this.heightBits;
    encoder.copyTextureToTexture(
      { texture: this.#gpu },
      { texture: gpu },
      { width: W, height: H, depthOrArrayLayers: this.#layers },
    );
    this.#backend.device.queue.submit([encoder.finish()]);
    this.#texture.dispose();
    this.#texture = texture;
    this.#gpu = gpu;
    this.#layers = layers;
    this.node.value = texture;
  }

  /** Writes `data` starting at element `offset`. */
  write(offset: number, data: Uint16Array | Uint32Array): void {
    const W = 1 << this.widthBits;
    const H = 1 << this.heightBits;
    const queue = this.#backend.device.queue;
    let done = 0;
    while (done < data.length) {
      const i = offset + done;
      const x = i & (W - 1);
      const y = (i >> this.widthBits) & (H - 1);
      const z = Math.floor(i / this.#perLayer);
      const left = data.length - done;
      // Whole rows at once when starting a row, else the rest of this row.
      const rows = x === 0 ? Math.min(Math.floor(left / W), H - y) : 0;
      const width = rows > 0 ? W : Math.min(left, W - x);
      const height = rows > 0 ? rows : 1;
      const count = width * height;
      queue.writeTexture(
        { texture: this.#gpu, origin: { x, y, z } },
        data,
        { offset: done * this.#bytes, bytesPerRow: width * this.#bytes, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      done += count;
    }
  }

  dispose(): void {
    this.#texture.dispose();
  }

  #create(layers: number): [THREE.Data3DTexture, GPUTexture] {
    const texture = new THREE.Data3DTexture(
      null,
      1 << this.widthBits,
      1 << this.heightBits,
      layers,
    );
    texture.format = THREE.RedIntegerFormat;
    texture.type = THREE.UnsignedIntType; // binds as texture_3d<u32>; stored at #format
    texture.internalFormat = this.#format as THREE.PixelFormatGPU;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    // Allocate the GPU texture without uploading anything: it is written piece by piece.
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    this.#renderer.initTexture(texture);
    const gpu = this.#backend.get(texture).texture;
    if (!gpu) throw new Error("light texture was not created");
    return [texture, gpu];
  }
}

/** The grid: a chunk grid of table indices, rebuilt when it changes. */
export interface LightGridUniforms {
  readonly origin: THREE.Vector3;
  readonly size: THREE.Vector3;
}

/**
 * Light for the GPU, laid out by the world worker (LightLayout): a pool of light bricks, a
 * table per chunk mapping its bricks to pool slots, and a grid mapping chunks to tables.
 * This only copies the worker's updates into three textures; the volume material reads
 * them (see createVolumeLitMaterial). Needs WebGPU: textures are written through its queue.
 */
export class LightVolume {
  /** Brick light: 16 bits per cell, brickVolume cells per slot. */
  readonly pool: LinearTexture;
  /** Chunk tables: slot + 1 per brick (0 = none). */
  readonly tables: LinearTexture;
  /** Chunk grid: table + 1 per chunk (0 = none). */
  readonly grid: LinearTexture;
  readonly gridUniforms: LightGridUniforms = {
    origin: new THREE.Vector3(),
    size: new THREE.Vector3(),
  };
  readonly brickVolume: number;
  readonly tableLength: number;

  /** True if the renderer can host light volumes (WebGPU, not the WebGL fallback). */
  static supported(renderer: THREE.WebGPURenderer): boolean {
    return (renderer.backend as unknown as WebGPUBackendInternals).isWebGPUBackend === true;
  }

  constructor(renderer: THREE.WebGPURenderer, brickVolume: number, tableLength: number) {
    this.brickVolume = brickVolume;
    this.tableLength = tableLength;
    // Layers of 4M bricks' cells (8 MB), 512K table entries (2 MB) and 64K chunks (256 KB).
    this.pool = new LinearTexture(renderer, "r16uint", 11, 11);
    this.tables = new LinearTexture(renderer, "r32uint", 11, 8);
    this.grid = new LinearTexture(renderer, "r32uint", 8, 8);
  }

  get memoryBytes(): number {
    return this.pool.memoryBytes + this.tables.memoryBytes + this.grid.memoryBytes;
  }

  /** Applies one update from the world worker: bricks, then tables, then the grid. */
  apply(update: LightLayoutUpdate): void {
    const V = this.brickVolume;
    this.pool.ensure(update.poolBricks * V);
    this.tables.ensure(update.tableCount * this.tableLength);
    // Bricks come in slot order: write each run of consecutive slots in one go.
    const { slots, bricks } = update;
    for (let i = 0; i < slots.length; ) {
      let j = i + 1;
      while (j < slots.length && slots[j] === (slots[j - 1] ?? 0) + 1) j++;
      this.pool.write((slots[i] ?? 0) * V, bricks.subarray(i * V, j * V));
      i = j;
    }
    const L = this.tableLength;
    update.tables.forEach((table, t) => {
      this.tables.write(table * L, update.tableData.subarray(t * L, (t + 1) * L));
    });
    if (update.grid) {
      const { origin, size, data } = update.grid;
      this.grid.ensure(data.length);
      this.grid.write(0, data);
      this.gridUniforms.origin.set(origin[0], origin[1], origin[2]);
      this.gridUniforms.size.set(size[0], size[1], size[2]);
    }
  }

  dispose(): void {
    this.pool.dispose();
    this.tables.dispose();
    this.grid.dispose();
  }
}

export type { LinearTexture };
