import { chunkKeyToCoords } from "@voxyl/core";
import { GPU_BRICK_BITS } from "@voxyl/light";
import { QUAD_BYTES } from "@voxyl/mesher";
import type { LightingMode } from "@voxyl/session";
import * as THREE from "three/webgpu";
import { type Palette, UNDECIDED_COLOR } from "../palettes.ts";
import type { WorldOutput } from "../world/WorldClient.ts";
import { LightVolume } from "./light-volume.ts";
import {
  createFlatMaterial,
  createLightUniforms,
  createVolumeLitMaterial,
  EMISSIVE_ALPHA,
  type LightUniforms,
  PALETTE_SIZE,
} from "./quad-material.ts";

/** Main-thread time per frame spent applying meshes and light from the world worker. */
const APPLY_BUDGET_MS = 4;

type Update = Extract<WorldOutput, { type: "mesh" } | { type: "light" } | { type: "idle" }>;

export interface ChunkRendererStats {
  readonly meshes: number;
  readonly quads: number;
  /** GPU bytes held by quads. */
  readonly quadBytes: number;
  /** Updates from the world worker waiting to be applied. */
  readonly pending: number;
  readonly lighting: LightingMode;
  /** Light volume memory on the GPU. */
  readonly lightGpuMb: number;
  /** Time to apply one light update (up to 4096 bricks) on this thread, over recent ones. */
  readonly lightWriteMs: number;
}

/**
 * Draws one world's chunks from what the world worker sends: meshes, light volume writes
 * and idle markers, applied in arrival order within a per-frame budget. It owns nothing
 * about the world itself, only GPU state: one mesh per chunk, the materials, the palette
 * texture and the light volume.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly #renderer: THREE.WebGPURenderer;
  readonly #size: number;
  readonly #chunkBits: number;
  readonly #paletteData: Uint8Array;
  readonly #paletteTexture: THREE.DataTexture;
  readonly #uniforms: LightUniforms = createLightUniforms();
  readonly #flatMaterial: THREE.MeshBasicNodeMaterial;
  #palette: Palette;
  #semantics: string[] = [""];
  #paletteDirty = true;
  #mode: LightingMode = "off";
  #volume: LightVolume | null = null;
  #volumeMaterial: THREE.MeshBasicNodeMaterial | null = null;
  /** Whether meshes draw with the light volume yet (see revealLight). */
  #lightShown = false;
  readonly #meshes = new Map<number, THREE.Mesh>();
  readonly #updates: Update[] = [];
  #appliedSeq = -1;
  #quads = 0;
  readonly #writeTimes: number[] = [];

  constructor(renderer: THREE.WebGPURenderer, chunkSize: number, palette: Palette) {
    this.#renderer = renderer;
    this.#size = chunkSize;
    this.#chunkBits = Math.log2(chunkSize);
    this.#palette = palette;
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#flatMaterial = createFlatMaterial(this.#paletteTexture);
    this.group.name = "chunks";
  }

  get lighting(): LightingMode {
    return this.#mode;
  }

  /** The sequence number of the last idle marker applied (see WorldClient.sentSeq). */
  get appliedSeq(): number {
    return this.#appliedSeq;
  }

  /** True when nothing from the world worker is waiting to be applied. */
  get caughtUp(): boolean {
    return this.#updates.length === 0;
  }

  /**
   * Switches how faces are lit. With lighting on, a light volume fills as the world worker
   * sends light; meshes keep drawing flat until revealLight(), so the world lights up at
   * once rather than a few chunks at a time.
   */
  setLighting(mode: LightingMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#volume?.dispose();
    this.#volumeMaterial?.dispose();
    this.#volume = null;
    this.#volumeMaterial = null;
    this.#lightShown = false;
    if (mode === "volume") {
      const brickBits = Math.min(GPU_BRICK_BITS, this.#chunkBits);
      this.#volume = new LightVolume(
        this.#renderer,
        1 << (3 * brickBits),
        (this.#size >> brickBits) ** 3,
      );
      this.#volumeMaterial = createVolumeLitMaterial(
        this.#paletteTexture,
        this.#uniforms,
        this.#volume,
        this.#chunkBits,
        brickBits,
      );
    }
    this.#applyMaterial();
  }

  /** Starts drawing with the light volume. Call once its light has arrived. */
  revealLight(): void {
    if (!this.#volumeMaterial || this.#lightShown) return;
    this.#lightShown = true;
    this.#applyMaterial();
  }

  /** Time of day, 0 (midnight) to 1 (noon). Costs nothing: it's one shader value. */
  setDaylight(daylight: number): void {
    this.#uniforms.daylight.value = daylight;
  }

  /** Minecraft's Brightness: 0 Moody, 0.5 default, 1 Bright. One shader value. */
  setBrightness(brightness: number): void {
    this.#uniforms.brightness.value = brightness;
  }

  /** New colours: only the palette texture changes (the worker relights if light changed). */
  setPalette(palette: Palette): void {
    this.#palette = palette;
    this.#paletteDirty = true;
  }

  /** The semantic of every cell-state id, as the world worker reports it. */
  setStates(semantics: string[]): void {
    this.#semantics = semantics;
    this.#paletteDirty = true;
  }

  /** Queues a mesh, light update or idle marker from the world worker; applied in update(). */
  receive(update: Update): void {
    this.#updates.push(update);
  }

  /** Call once per frame before rendering. */
  update(): void {
    this.#syncPalette();
    const start = performance.now();
    let i = 0;
    for (; i < this.#updates.length && performance.now() - start < APPLY_BUDGET_MS; i++) {
      const update = this.#updates[i];
      if (!update) continue;
      if (update.type === "idle") this.#appliedSeq = update.seq;
      else if (update.type === "light") this.#applyLight(update.update);
      else if (update.quadCount === 0) this.#removeMesh(update.key);
      else this.#setMesh(update.key, update.quads, update.quadCount);
    }
    this.#updates.splice(0, i);
  }

  stats(): ChunkRendererStats {
    const times = this.#writeTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      quadBytes: this.#quads * QUAD_BYTES,
      pending: this.#updates.length,
      lighting: this.#mode,
      lightGpuMb: (this.#volume?.memoryBytes ?? 0) / 2 ** 20,
      lightWriteMs: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
    };
  }

  dispose(): void {
    for (const mesh of this.#meshes.values()) mesh.geometry.dispose();
    this.#meshes.clear();
    this.group.clear();
    this.#flatMaterial.dispose();
    this.#volumeMaterial?.dispose();
    this.#volume?.dispose();
    this.#paletteTexture.dispose();
  }

  get #material(): THREE.Material {
    return this.#lightShown && this.#volumeMaterial ? this.#volumeMaterial : this.#flatMaterial;
  }

  #applyMaterial(): void {
    const material = this.#material;
    for (const mesh of this.#meshes.values()) mesh.material = material;
  }

  #applyLight(update: Parameters<LightVolume["apply"]>[0]): void {
    if (!this.#volume) return;
    const start = performance.now();
    this.#volume.apply(update);
    this.#writeTimes.push(performance.now() - start);
    if (this.#writeTimes.length > 64) this.#writeTimes.shift();
  }

  #syncPalette(): void {
    if (!this.#paletteDirty) return;
    const data = this.#paletteData;
    for (let id = 1; id < this.#semantics.length; id++) {
      const material = this.#palette.materials[this.#semantics[id] ?? ""];
      const rgb = Number.parseInt((material?.color ?? UNDECIDED_COLOR).slice(1), 16);
      data[id * 4] = (rgb >> 16) & 0xff;
      data[id * 4 + 1] = (rgb >> 8) & 0xff;
      data[id * 4 + 2] = rgb & 0xff;
      data[id * 4 + 3] = material?.emits ? EMISSIVE_ALPHA : 0xff;
    }
    this.#paletteTexture.needsUpdate = true;
    this.#paletteDirty = false;
  }

  #setMesh(key: number, quads: Uint8Array, quadCount: number): void {
    const size = this.#size;
    const geometry = new THREE.InstancedBufferGeometry();
    // Each geometry owns its base quad: disposing a geometry frees all of its attributes.
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    const packed = new THREE.InstancedInterleavedBuffer(quads, QUAD_BYTES);
    geometry.setAttribute("quadA", new THREE.InterleavedBufferAttribute(packed, 4, 0, true));
    geometry.setAttribute("quadB", new THREE.InterleavedBufferAttribute(packed, 4, 4, true));
    geometry.instanceCount = quadCount;
    // Bounds can't come from the base quad: they are the chunk's cube.
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(size, size, size),
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(size / 2, size / 2, size / 2),
      (size * Math.sqrt(3)) / 2,
    );

    let mesh = this.#meshes.get(key);
    if (mesh) {
      this.#quads -= (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      mesh = new THREE.Mesh(geometry, this.#material);
      const [cx, cy, cz] = chunkKeyToCoords(key);
      mesh.position.set(cx * size, cy * size, cz * size);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.#meshes.set(key, mesh);
      this.group.add(mesh);
    }
    this.#quads += quadCount;
  }

  #removeMesh(key: number): void {
    const mesh = this.#meshes.get(key);
    if (!mesh) return;
    this.#quads -= (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
    mesh.geometry.dispose();
    this.group.remove(mesh);
    this.#meshes.delete(key);
  }
}
