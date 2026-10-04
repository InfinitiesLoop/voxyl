import * as THREE from "three/webgpu";

/** Target size of one page of light slots. */
const PAGE_BYTES = 16 * 2 ** 20;

interface Page {
  readonly texture: THREE.Data3DTexture;
  readonly gpu: GPUTexture;
  readonly material: THREE.Material;
  readonly free: number[];
}

interface Slot {
  readonly page: number;
  readonly index: number;
  /** Where the slot starts, in cells along world x, y, z (the shader swaps y and z). */
  readonly origin: THREE.Vector3;
}

/** What the volume renderer needs from three's WebGPU backend, which it doesn't type. */
interface WebGPUBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device: GPUDevice;
  get(texture: THREE.Texture): { texture?: GPUTexture };
}

/**
 * Light for the GPU: every chunk with a mesh gets a slot holding its padded light, (size + 2)³
 * cells at 16 bits (sky, red, green, blue; OPAQUE_LIGHT where a cell blocks light), which the
 * volume material reads in the fragment shader. A light change rewrites the slot, never the
 * mesh.
 *
 * Slots live in pages: cubic 3D textures of about PAGE_BYTES, each with its own material
 * (three binds textures per material). A chunk mesh uses its page's material and tells the
 * shader its slot origin through userData.lightSlot. Pages are written straight through the
 * WebGPU queue, a slot at a time: three would re-upload a whole texture.
 */
export class LightVolume {
  readonly #renderer: THREE.WebGPURenderer;
  readonly #backend: WebGPUBackendInternals;
  readonly #padded: number;
  readonly #perAxis: number;
  readonly #makeMaterial: (atlas: THREE.Data3DTexture) => THREE.Material;
  readonly #pages: Page[] = [];
  readonly #slots = new Map<number, Slot>();

  /** True if the renderer can host light volumes (WebGPU, not the WebGL fallback). */
  static supported(renderer: THREE.WebGPURenderer): boolean {
    return (renderer.backend as unknown as WebGPUBackendInternals).isWebGPUBackend === true;
  }

  constructor(
    renderer: THREE.WebGPURenderer,
    chunkSize: number,
    makeMaterial: (atlas: THREE.Data3DTexture) => THREE.Material,
  ) {
    this.#renderer = renderer;
    this.#backend = renderer.backend as unknown as WebGPUBackendInternals;
    this.#padded = chunkSize + 2;
    this.#perAxis = Math.max(1, Math.floor(Math.cbrt(PAGE_BYTES / (2 * this.#padded ** 3))));
    this.#makeMaterial = makeMaterial;
  }

  /** GPU memory held by pages. */
  get memoryBytes(): number {
    return this.#pages.length * 2 * (this.#padded * this.#perAxis) ** 3;
  }

  get slotCount(): number {
    return this.#slots.size;
  }

  has(key: number): boolean {
    return this.#slots.has(key);
  }

  /** The material for the chunk's slot, allocating one if needed. */
  materialFor(key: number, mesh: THREE.Object3D): THREE.Material {
    const slot = this.#slots.get(key) ?? this.#allocate(key);
    mesh.userData.lightSlot = slot.origin;
    const page = this.#pages[slot.page];
    if (!page) throw new Error(`light page ${slot.page} missing`);
    return page.material;
  }

  /** Writes a chunk's padded light (as LightEngine.copyPadded(..., true) gives it). */
  upload(key: number, light: Uint16Array): void {
    const slot = this.#slots.get(key);
    const page = slot && this.#pages[slot.page];
    if (!slot || !page) return;
    const P = this.#padded;
    this.#backend.device.queue.writeTexture(
      { texture: page.gpu, origin: { x: slot.origin.x, y: slot.origin.z, z: slot.origin.y } },
      light,
      { bytesPerRow: P * 2, rowsPerImage: P },
      { width: P, height: P, depthOrArrayLayers: P },
    );
  }

  free(key: number): void {
    const slot = this.#slots.get(key);
    if (!slot) return;
    this.#slots.delete(key);
    this.#pages[slot.page]?.free.push(slot.index);
  }

  dispose(): void {
    for (const page of this.#pages) {
      page.texture.dispose();
      page.material.dispose();
    }
    this.#pages.length = 0;
    this.#slots.clear();
  }

  #allocate(key: number): Slot {
    let page = this.#pages.findIndex((p) => p.free.length > 0);
    if (page < 0) page = this.#addPage();
    const index = this.#pages[page]?.free.pop() ?? 0;
    const n = this.#perAxis;
    const P = this.#padded;
    const origin = new THREE.Vector3(
      (index % n) * P,
      Math.floor(index / (n * n)) * P,
      (Math.floor(index / n) % n) * P,
    );
    const slot = { page, index, origin };
    this.#slots.set(key, slot);
    return slot;
  }

  #addPage(): number {
    const side = this.#padded * this.#perAxis;
    const texture = new THREE.Data3DTexture(null, side, side, side);
    texture.name = `light page ${this.#pages.length}`;
    texture.format = THREE.RedIntegerFormat;
    texture.type = THREE.UnsignedIntType; // binds as texture_3d<u32>; stored as r16uint below
    texture.internalFormat = "r16uint" as THREE.PixelFormatGPU;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    // Allocate the GPU texture without uploading anything: slots are written one by one.
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    this.#renderer.initTexture(texture);
    const gpu = this.#backend.get(texture).texture;
    if (!gpu) throw new Error("light page texture was not created");
    const slots = this.#perAxis ** 3;
    const free = Array.from({ length: slots }, (_, i) => slots - 1 - i); // pop() hands out 0 first
    this.#pages.push({ texture, gpu, material: this.#makeMaterial(texture), free });
    return this.#pages.length - 1;
  }
}
