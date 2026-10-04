import { chunkKeyToCoords } from "@voxyl/core";
import { LIT_QUAD_BYTES } from "@voxyl/mesher";
import type { LightingMode } from "@voxyl/session";
import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import { type Palette, UNDECIDED_COLOR } from "../palettes.ts";
import type { WorldOutput } from "../world/WorldClient.ts";
import { LightVolume } from "./light-volume.ts";
import {
  createFlatMaterial,
  createLightUniforms,
  createVertexLitMaterial,
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
  /** Light volume memory on the GPU (volume lighting). */
  readonly lightGpuMb: number;
  /** Time to write one chunk's light to the GPU, over recent ones. */
  readonly lightWriteMs: number;
}

/**
 * Draws one world's chunks from what the world worker sends: meshes, light for the light
 * volume, and idle markers, applied in arrival order within a per-frame budget. It owns
 * nothing about the world itself, only GPU state: one mesh per chunk, the materials, the
 * palette texture and the light volume.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly #renderer: THREE.WebGPURenderer;
  readonly #size: number;
  readonly #paletteData: Uint8Array;
  readonly #paletteTexture: THREE.DataTexture;
  readonly #uniforms: LightUniforms = createLightUniforms();
  readonly #flatMaterial: THREE.MeshBasicNodeMaterial;
  readonly #vertexMaterial: THREE.MeshBasicNodeMaterial;
  /** Each chunk mesh's light slot origin, for the volume materials. */
  readonly #slot = uniform(new THREE.Vector3()).onObjectUpdate(
    ({ object }) => object?.userData.lightSlot as THREE.Vector3 | undefined,
  );
  #palette: Palette;
  #semantics: string[] = [""];
  #paletteDirty = true;
  #mode: LightingMode = "off";
  #volume: LightVolume | null = null;
  /** Meshes whose light slot holds their light: they draw lit; the rest draw flat until then. */
  readonly #lit = new Set<number>();
  readonly #meshes = new Map<number, THREE.Mesh>();
  readonly #updates: Update[] = [];
  #appliedSeq = -1;
  #quads = 0;
  #quadBytes = 0;
  readonly #writeTimes: number[] = [];

  constructor(renderer: THREE.WebGPURenderer, chunkSize: number, palette: Palette) {
    this.#renderer = renderer;
    this.#size = chunkSize;
    this.#palette = palette;
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#flatMaterial = createFlatMaterial(this.#paletteTexture);
    this.#vertexMaterial = createVertexLitMaterial(this.#paletteTexture, this.#uniforms);
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
   * Switches how light is drawn. The world worker computes it; here, volume lighting needs a
   * light volume, and meshes draw flat until their chunk's light arrives.
   */
  setLighting(mode: LightingMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#lit.clear();
    this.#volume?.dispose();
    this.#volume =
      mode === "volume"
        ? new LightVolume(this.#renderer, this.#size, (atlas) =>
            createVolumeLitMaterial(this.#paletteTexture, this.#uniforms, atlas, this.#slot),
          )
        : null;
    for (const [key, mesh] of this.#meshes) mesh.material = this.#materialFor(key, mesh);
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

  /** Queues a mesh, light or idle marker from the world worker; applied in update(). */
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
      else if (update.type === "light") this.#applyLight(update.key, update.light);
      else if (update.quadCount === 0) this.#removeMesh(update.key);
      else this.#setMesh(update.key, update.quads, update.quadCount, update.quadBytes);
    }
    this.#updates.splice(0, i);
  }

  stats(): ChunkRendererStats {
    const times = this.#writeTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      quadBytes: this.#quadBytes,
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
    this.#vertexMaterial.dispose();
    this.#volume?.dispose();
    this.#paletteTexture.dispose();
  }

  /** Baked-light quads need the vertex material whatever the mode, until they are remeshed. */
  #materialFor(key: number, mesh: THREE.Mesh): THREE.Material {
    if (mesh.geometry.userData.quadBytes === LIT_QUAD_BYTES) return this.#vertexMaterial;
    if (this.#volume && this.#lit.has(key)) return this.#volume.materialFor(key, mesh);
    return this.#flatMaterial;
  }

  #applyLight(key: number, light: Uint16Array): void {
    const mesh = this.#meshes.get(key);
    const volume = this.#volume;
    if (!mesh || !volume) return;
    volume.materialFor(key, mesh); // gives the chunk a slot
    const start = performance.now();
    volume.upload(key, light);
    this.#writeTimes.push(performance.now() - start);
    if (this.#writeTimes.length > 256) this.#writeTimes.shift();
    this.#lit.add(key);
    mesh.material = this.#materialFor(key, mesh);
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

  #setMesh(key: number, quads: Uint8Array, quadCount: number, quadBytes: number): void {
    const size = this.#size;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.userData.quadBytes = quadBytes;
    // Each geometry owns its base quad: disposing a geometry frees all of its attributes.
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    const packed = new THREE.InstancedInterleavedBuffer(quads, quadBytes);
    const unorm4 = (offset: number) =>
      new THREE.InterleavedBufferAttribute(packed, 4, offset, true);
    geometry.setAttribute("quadA", unorm4(0));
    geometry.setAttribute("quadB", unorm4(4));
    if (quadBytes === LIT_QUAD_BYTES) {
      geometry.setAttribute("corner0", unorm4(8));
      geometry.setAttribute("corner1", unorm4(12));
      geometry.setAttribute("corner2", unorm4(16));
      geometry.setAttribute("corner3", unorm4(20));
      geometry.setAttribute("cornerAo", unorm4(24));
    }
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
      this.#forget(mesh);
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      mesh = new THREE.Mesh(geometry);
      const [cx, cy, cz] = chunkKeyToCoords(key);
      mesh.position.set(cx * size, cy * size, cz * size);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.#meshes.set(key, mesh);
      this.group.add(mesh);
    }
    mesh.material = this.#materialFor(key, mesh);
    this.#quads += quadCount;
    this.#quadBytes += quadCount * quadBytes;
  }

  #removeMesh(key: number): void {
    const mesh = this.#meshes.get(key);
    if (!mesh) return;
    this.#forget(mesh);
    mesh.geometry.dispose();
    this.group.remove(mesh);
    this.#meshes.delete(key);
    this.#volume?.free(key);
    this.#lit.delete(key);
  }

  /** Takes a mesh's quads out of the totals. */
  #forget(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry as THREE.InstancedBufferGeometry;
    this.#quads -= geometry.instanceCount;
    this.#quadBytes -= geometry.instanceCount * (geometry.userData.quadBytes as number);
  }
}
