import { chunkKeyToCoords } from "@voxyl/core";
import { GPU_BRICK_BITS } from "@voxyl/light";
import { QUAD_BYTES, QUAD_WORDS, TRI_BYTES, TRI_WORDS } from "@voxyl/mesher";
import type { LightingMode } from "@voxyl/session";
import * as THREE from "three/webgpu";
import type { WorldOutput } from "../world/WorldClient.ts";
import { LightVolume } from "./light-volume.ts";
import {
  createFlatMaterial,
  createLightUniforms,
  createVolumeLitMaterial,
  EMISSIVE_ALPHA,
  type LightUniforms,
  PALETTE_SIZE,
  type SurfaceKind,
} from "./quad-material.ts";

/** Main-thread time per frame spent applying meshes and light from the world worker. */
const APPLY_BUDGET_MS = 4;

type Update = Extract<WorldOutput, { type: "mesh" } | { type: "light" } | { type: "idle" }>;

export interface ChunkRendererStats {
  readonly meshes: number;
  readonly quads: number;
  /** Triangles of shaped parts. */
  readonly tris: number;
  /** GPU bytes held by quads and triangles. */
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
  readonly #flatMaterials: Record<SurfaceKind, THREE.MeshBasicNodeMaterial>;
  /** StateLooks.colors from the world worker. */
  #looks: Uint8Array = new Uint8Array(0);
  #paletteDirty = true;
  #mode: LightingMode = "off";
  #volume: LightVolume | null = null;
  #volumeMaterials: Record<SurfaceKind, THREE.MeshBasicNodeMaterial> | null = null;
  /** Whether meshes draw with the light volume yet (see revealLight). */
  #lightShown = false;
  readonly #meshes = new Map<number, ChunkMeshes>();
  readonly #updates: Update[] = [];
  #appliedSeq = -1;
  #quads = 0;
  #tris = 0;
  readonly #writeTimes: number[] = [];

  constructor(renderer: THREE.WebGPURenderer, chunkSize: number) {
    this.#renderer = renderer;
    this.#size = chunkSize;
    this.#chunkBits = Math.log2(chunkSize);
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#flatMaterials = {
      quad: createFlatMaterial(this.#paletteTexture, "quad"),
      tri: createFlatMaterial(this.#paletteTexture, "tri"),
    };
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
    this.#disposeVolumeMaterials();
    this.#volume = null;
    this.#lightShown = false;
    if (mode === "volume") {
      const brickBits = Math.min(GPU_BRICK_BITS, this.#chunkBits);
      this.#volume = new LightVolume(
        this.#renderer,
        1 << (3 * brickBits),
        (this.#size >> brickBits) ** 3,
      );
      const lit = (kind: SurfaceKind) =>
        createVolumeLitMaterial(
          this.#paletteTexture,
          this.#uniforms,
          this.#volume as LightVolume,
          this.#chunkBits,
          brickBits,
          kind,
        );
      this.#volumeMaterials = { quad: lit("quad"), tri: lit("tri") };
    }
    this.#applyMaterial();
  }

  /** Starts drawing with the light volume. Call once its light has arrived. */
  revealLight(): void {
    if (!this.#volumeMaterials || this.#lightShown) return;
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

  /**
   * Every cell state's look, as the world worker resolves it from the project's palettes (see
   * StateLooks.colors). Only the palette texture changes.
   */
  setLooks(colors: Uint8Array): void {
    this.#looks = colors;
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
      else if (update.quadCount === 0 && update.triCount === 0) this.#removeMesh(update.key);
      else this.#setMesh(update.key, update.quads, update.tris);
    }
    this.#updates.splice(0, i);
  }

  stats(): ChunkRendererStats {
    const times = this.#writeTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      tris: this.#tris,
      quadBytes: this.#quads * QUAD_BYTES + this.#tris * TRI_BYTES,
      pending: this.#updates.length,
      lighting: this.#mode,
      lightGpuMb: (this.#volume?.memoryBytes ?? 0) / 2 ** 20,
      lightWriteMs: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
    };
  }

  dispose(): void {
    for (const key of [...this.#meshes.keys()]) this.#removeMesh(key);
    this.group.clear();
    this.#flatMaterials.quad.dispose();
    this.#flatMaterials.tri.dispose();
    this.#disposeVolumeMaterials();
    this.#volume?.dispose();
    this.#paletteTexture.dispose();
  }

  #material(kind: SurfaceKind): THREE.Material {
    const lit = this.#lightShown ? this.#volumeMaterials : null;
    return (lit ?? this.#flatMaterials)[kind];
  }

  #applyMaterial(): void {
    for (const meshes of this.#meshes.values()) {
      if (meshes.quads) meshes.quads.material = this.#material("quad");
      if (meshes.tris) meshes.tris.material = this.#material("tri");
    }
  }

  #disposeVolumeMaterials(): void {
    this.#volumeMaterials?.quad.dispose();
    this.#volumeMaterials?.tri.dispose();
    this.#volumeMaterials = null;
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
    const looks = this.#looks;
    const count = Math.min(looks.length, data.length);
    for (let i = 4; i < count; i += 4) {
      data[i] = looks[i] ?? 0;
      data[i + 1] = looks[i + 1] ?? 0;
      data[i + 2] = looks[i + 2] ?? 0;
      data[i + 3] = looks[i + 3] ? EMISSIVE_ALPHA : 0xff;
    }
    this.#paletteTexture.needsUpdate = true;
    this.#paletteDirty = false;
  }

  #setMesh(key: number, quads: Uint16Array, tris: Uint16Array): void {
    let meshes = this.#meshes.get(key);
    if (!meshes) {
      meshes = { quads: null, tris: null };
      this.#meshes.set(key, meshes);
    }
    const quadCount = quads.length / QUAD_WORDS;
    const triCount = tris.length / TRI_WORDS;
    this.#quads += quadCount - instances(meshes.quads);
    this.#tris += triCount - instances(meshes.tris);
    meshes.quads = this.#place(
      key,
      meshes.quads,
      "quad",
      quadCount && quadGeometry(quads, this.#size),
    );
    meshes.tris = this.#place(key, meshes.tris, "tri", triCount && triGeometry(tris, this.#size));
  }

  /** Swaps a chunk mesh's geometry, creating or removing the mesh as needed. */
  #place(
    key: number,
    mesh: THREE.Mesh | null,
    kind: SurfaceKind,
    geometry: THREE.InstancedBufferGeometry | 0,
  ): THREE.Mesh | null {
    mesh?.geometry.dispose();
    if (!geometry) {
      if (mesh) this.group.remove(mesh);
      return null;
    }
    if (mesh) {
      mesh.geometry = geometry;
      return mesh;
    }
    const created = new THREE.Mesh(geometry, this.#material(kind));
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const size = this.#size;
    created.position.set(cx * size, cy * size, cz * size);
    created.matrixAutoUpdate = false;
    created.updateMatrix();
    this.group.add(created);
    return created;
  }

  #removeMesh(key: number): void {
    const meshes = this.#meshes.get(key);
    if (!meshes) return;
    this.#quads -= instances(meshes.quads);
    this.#tris -= instances(meshes.tris);
    this.#place(key, meshes.quads, "quad", 0);
    this.#place(key, meshes.tris, "tri", 0);
    this.#meshes.delete(key);
  }
}

/** A chunk's meshes: whole faces as quads, and sloped shaped parts as triangles. */
interface ChunkMeshes {
  quads: THREE.Mesh | null;
  tris: THREE.Mesh | null;
}

const instances = (mesh: THREE.Mesh | null) =>
  mesh ? (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0;

/** Bounds can't come from the base shape: they are the chunk's cube. */
function setChunkBounds(geometry: THREE.BufferGeometry, size: number): void {
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(size, size, size),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(size / 2, size / 2, size / 2),
    (size * Math.sqrt(3)) / 2,
  );
}

/** Instanced quads: a base square, and two normalized Uint16 vec4s per quad. */
function quadGeometry(quads: Uint16Array, size: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  // Each geometry owns its base shape: disposing a geometry frees all of its attributes.
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  const packed = new THREE.InstancedInterleavedBuffer(quads, QUAD_WORDS);
  geometry.setAttribute("quadA", new THREE.InterleavedBufferAttribute(packed, 4, 0, true));
  geometry.setAttribute("quadB", new THREE.InterleavedBufferAttribute(packed, 4, 4, true));
  geometry.instanceCount = quads.length / QUAD_WORDS;
  setChunkBounds(geometry, size);
  return geometry;
}

/** Instanced triangles: a base triangle of corner weights, three Uint16 vec4s per triangle. */
function triGeometry(tris: Uint16Array, size: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3),
  );
  const packed = new THREE.InstancedInterleavedBuffer(tris, TRI_WORDS);
  geometry.setAttribute("triA", new THREE.InterleavedBufferAttribute(packed, 4, 0, true));
  geometry.setAttribute("triB", new THREE.InterleavedBufferAttribute(packed, 4, 4, true));
  geometry.setAttribute("triC", new THREE.InterleavedBufferAttribute(packed, 4, 8, true));
  geometry.instanceCount = tris.length / TRI_WORDS;
  setChunkBounds(geometry, size);
  return geometry;
}
