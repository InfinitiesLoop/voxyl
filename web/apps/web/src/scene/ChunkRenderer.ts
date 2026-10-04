import { chunkKeyToCoords, type World } from "@voxyl/core";
import { LightEngine, type LightMaterials } from "@voxyl/light";
import { LIT_QUAD_BYTES, paddedVolume } from "@voxyl/mesher";
import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import { lightMaterials, type Palette, sameMaterials, UNDECIDED_COLOR } from "../palettes.ts";
import { LightVolume } from "./light-volume.ts";
import type { MeshJob, MeshResult } from "./mesh-protocol.ts";
import {
  createFlatMaterial,
  createLightUniforms,
  createVertexLitMaterial,
  createVolumeLitMaterial,
  EMISSIVE_ALPHA,
  type LightUniforms,
  PALETTE_SIZE,
} from "./quad-material.ts";

/** Jobs each worker may hold at once, so one slow chunk doesn't stall the queue. */
const JOBS_PER_WORKER = 2;
/** Main-thread time per frame spent swapping finished meshes in. */
const APPLY_BUDGET_MS = 4;
/** Main-thread time per frame spent copying changed light to the GPU (volume lighting). */
const UPLOAD_BUDGET_MS = 4;

/**
 * How faces are lit. "vertex" bakes light into the quads (so a light change remeshes);
 * "volume" keeps quads plain and has the shader read light from a 3D texture per chunk (so a
 * light change rewrites the texture). Both compute the same light.
 */
export type LightingMode = "off" | "vertex" | "volume";

export interface ChunkRendererStats {
  readonly meshes: number;
  readonly quads: number;
  /** GPU bytes held by quads. */
  readonly quadBytes: number;
  readonly queued: number;
  readonly inFlight: number;
  /** Worker meshing time per chunk over recent jobs. */
  readonly meshMsAvg: number;
  readonly workers: number;
  readonly lighting: LightingMode;
  /** Time the last full relight took, if lighting is on. */
  readonly lightAllMs: number | null;
  /** Light engine memory on the CPU. */
  readonly lightMb: number;
  /** Light volume memory on the GPU (volume lighting). */
  readonly lightGpuMb: number;
  /** Per chunk light upload over recent ones: [copy on the CPU, hand to the GPU] in ms. */
  readonly lightUploadMs: readonly [number, number];
}

/**
 * Keeps one mesh per chunk in step with the World. Each frame it collects the chunks the
 * World (and, with lighting on, the light engine) reports dirty, sends padded snapshots of
 * them to a worker pool, nearest the camera first, and swaps finished meshes in. A chunk
 * edited while its mesh is being built is queued again, so the newest state always wins.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly #world: World;
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
  #paletteStates = -1;
  #mode: LightingMode = "off";
  #light: LightEngine | null = null;
  #lightMaterials: LightMaterials | null = null;
  #lightAllMs: number | null = null;
  #volume: LightVolume | null = null;
  readonly #uploads = new Set<number>();
  readonly #scratch: Uint16Array;

  readonly #meshes = new Map<number, THREE.Mesh>();
  readonly #queue = new Set<number>();
  #order: number[] = [];
  #orderStale = false;
  readonly #inFlight = new Map<number, number>(); // job id -> worker index
  readonly #inFlightKeys = new Set<number>();
  readonly #again = new Set<number>();
  readonly #results: MeshResult[] = [];
  readonly #workers: Worker[];
  readonly #workerLoad: number[];
  #nextJob = 1;
  #quads = 0;
  #quadBytes = 0;
  readonly #meshTimes: number[] = [];
  readonly #uploadTimes: [number, number][] = [];
  #idleWaiters: (() => void)[] = [];
  readonly #cameraPosition = new THREE.Vector3();

  constructor(world: World, palette: Palette, workerCount: number, renderer: THREE.WebGPURenderer) {
    this.#world = world;
    this.#renderer = renderer;
    this.#size = world.layout.size;
    this.#scratch = new Uint16Array(paddedVolume(world.layout.bits));
    this.#palette = palette;
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#flatMaterial = createFlatMaterial(this.#paletteTexture);
    this.#vertexMaterial = createVertexLitMaterial(this.#paletteTexture, this.#uniforms);
    this.#workers = Array.from({ length: workerCount }, () => {
      const worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<MeshResult>) => {
        this.#onResult(event.data);
      });
      return worker;
    });
    this.#workerLoad = this.#workers.map(() => 0);
    this.group.name = "chunks";
  }

  get lighting(): LightingMode {
    return this.#mode;
  }

  /**
   * Switches lighting. Turning it on lights the whole world now (on this thread, for the
   * moment); off drops light data entirely. Baked light remeshes every chunk when it starts
   * or stops; volume light only swaps materials and uploads light.
   */
  setLighting(requested: LightingMode): void {
    const mode =
      requested === "volume" && !LightVolume.supported(this.#renderer) ? "vertex" : requested;
    if (mode === this.#mode) return;
    const previous = this.#mode;
    this.#mode = mode;
    if (mode === "off") {
      this.#light = null;
      this.#lightMaterials = null;
      this.#lightAllMs = null;
      this.#world.recordChanges(false);
    } else if (!this.#light) {
      this.#lightMaterials = lightMaterials(this.#palette, this.#world);
      this.#light = new LightEngine(this.#world, this.#lightMaterials);
      this.#world.recordChanges(true);
      this.#relightAll();
    }
    this.#uploads.clear();
    this.#volume?.dispose();
    this.#volume =
      mode === "volume"
        ? new LightVolume(this.#renderer, this.#size, (atlas) =>
            createVolumeLitMaterial(this.#paletteTexture, this.#uniforms, atlas, this.#slot),
          )
        : null;
    if (previous === "vertex" || mode === "vertex") this.#remeshAll();
    // With a volume, each plain mesh gets a slot here and its light uploaded straight away.
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

  setPalette(palette: Palette): void {
    this.#palette = palette;
    this.#paletteStates = -1;
    // Colours only touch the palette texture; materials that change light relight everything.
    if (this.#light && this.#lightMaterials) {
      const next = lightMaterials(palette, this.#world);
      if (!sameMaterials(next, this.#lightMaterials)) {
        this.#lightMaterials = next;
        this.#light.setMaterials(next);
        this.#relightAll();
        if (this.#mode === "vertex") this.#remeshAll();
        this.#uploadAll();
      }
    }
  }

  /** Call once per frame before rendering. */
  update(camera: THREE.Camera): void {
    this.#syncPalette();
    const light = this.#light;
    if (light) {
      // New cell states (a semantic used for the first time) need entries in the tables.
      if ((this.#lightMaterials?.opaque.length ?? 0) !== this.#world.states.size + 1) {
        this.#lightMaterials = lightMaterials(this.#palette, this.#world);
        light.setMaterials(this.#lightMaterials);
      }
      light.update(this.#world.takeChanges());
      for (const key of light.takeDirtyChunks()) {
        if (this.#mode === "vertex") this.#enqueue(key);
        else if (this.#volume?.has(key)) this.#uploads.add(key);
      }
    }
    for (const key of this.#world.takeDirtyChunks()) this.#enqueue(key);
    this.#cameraPosition.copy(camera.position);
    this.#applyResults();
    this.#flushUploads();
    this.#dispatch();
  }

  /** Call once per frame after rendering: settles whenIdle() once the last mesh is on screen. */
  afterRender(): void {
    if (this.#idleWaiters.length > 0 && this.idle) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** True when every edit so far is meshed, lit and on screen. */
  get idle(): boolean {
    return (
      this.#world.dirtyCount === 0 &&
      this.#queue.size === 0 &&
      this.#inFlight.size === 0 &&
      this.#results.length === 0 &&
      this.#again.size === 0 &&
      this.#uploads.size === 0
    );
  }

  /** Resolves after the first rendered frame in which all edits so far are visible. */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  stats(): ChunkRendererStats {
    const times = this.#meshTimes;
    const uploads = this.#uploadTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      quadBytes: this.#quadBytes,
      queued: this.#queue.size + this.#again.size,
      inFlight: this.#inFlight.size,
      meshMsAvg: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
      workers: this.#workers.length,
      lighting: this.#mode,
      lightAllMs: this.#lightAllMs,
      lightMb: (this.#light?.memoryBytes ?? 0) / 2 ** 20,
      lightGpuMb: (this.#volume?.memoryBytes ?? 0) / 2 ** 20,
      lightUploadMs: [0, 1].map((k) =>
        uploads.length > 0 ? uploads.reduce((s, t) => s + (t[k] ?? 0), 0) / uploads.length : 0,
      ) as [number, number],
    };
  }

  dispose(): void {
    for (const worker of this.#workers) worker.terminate();
    for (const mesh of this.#meshes.values()) mesh.geometry.dispose();
    this.#meshes.clear();
    this.group.clear();
    this.#flatMaterial.dispose();
    this.#vertexMaterial.dispose();
    this.#volume?.dispose();
    this.#paletteTexture.dispose();
    this.#world.recordChanges(false);
  }

  #relightAll(): void {
    if (!this.#light) return;
    this.#world.takeChanges(); // already reflected in a full relight
    const start = performance.now();
    this.#light.computeAll();
    this.#lightAllMs = performance.now() - start;
    this.#light.takeDirtyChunks();
  }

  #remeshAll(): void {
    for (const key of this.#world.chunkKeys()) this.#enqueue(key);
  }

  #uploadAll(): void {
    if (!this.#volume) return;
    for (const key of this.#meshes.keys()) this.#uploads.add(key);
  }

  #enqueue(key: number): void {
    if (this.#inFlightKeys.has(key)) {
      this.#again.add(key);
    } else if (!this.#queue.has(key)) {
      this.#queue.add(key);
      this.#orderStale = true;
    }
  }

  /** Baked-light quads need the vertex material whatever the mode, until they are remeshed. */
  #materialFor(key: number, mesh: THREE.Mesh): THREE.Material {
    if (mesh.geometry.userData.quadBytes === LIT_QUAD_BYTES) return this.#vertexMaterial;
    if (this.#volume) {
      const fresh = !this.#volume.has(key);
      const material = this.#volume.materialFor(key, mesh);
      if (fresh) this.#uploadLight(key);
      return material;
    }
    return this.#flatMaterial;
  }

  #flushUploads(): void {
    if (this.#uploads.size === 0) return;
    const start = performance.now();
    for (const key of this.#uploads) {
      this.#uploads.delete(key);
      this.#uploadLight(key);
      if (performance.now() - start > UPLOAD_BUDGET_MS) break;
    }
  }

  #uploadLight(key: number): void {
    const light = this.#light;
    if (!this.#volume?.has(key) || !light) return;
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const start = performance.now();
    light.copyPadded(cx, cy, cz, this.#scratch, true);
    const copied = performance.now();
    this.#volume.upload(key, this.#scratch);
    this.#uploadTimes.push([copied - start, performance.now() - copied]);
    if (this.#uploadTimes.length > 256) this.#uploadTimes.shift();
  }

  #syncPalette(): void {
    const states = this.#world.states;
    if (states.size === this.#paletteStates) return;
    const data = this.#paletteData;
    for (let id = 1; id <= states.size; id++) {
      const material = this.#palette.materials[states.get(id)?.semantic ?? ""];
      const rgb = Number.parseInt((material?.color ?? UNDECIDED_COLOR).slice(1), 16);
      data[id * 4] = (rgb >> 16) & 0xff;
      data[id * 4 + 1] = (rgb >> 8) & 0xff;
      data[id * 4 + 2] = rgb & 0xff;
      data[id * 4 + 3] = material?.emits ? EMISSIVE_ALPHA : 0xff;
    }
    this.#paletteTexture.needsUpdate = true;
    this.#paletteStates = states.size;
  }

  // A worker finished: free its slot and hand it the next chunk straight away rather than
  // waiting for the next frame. The mesh itself is swapped in during update(), in arrival
  // order, so a newer result for a chunk is always applied after an older one.
  #onResult(result: MeshResult): void {
    const worker = this.#inFlight.get(result.jobId);
    this.#inFlight.delete(result.jobId);
    this.#inFlightKeys.delete(result.key);
    if (worker !== undefined) this.#workerLoad[worker] = (this.#workerLoad[worker] ?? 1) - 1;
    this.#recordMeshTime(result.ms);
    if (this.#again.delete(result.key)) {
      this.#queue.add(result.key);
      this.#orderStale = true;
    }
    this.#results.push(result);
    this.#dispatch();
  }

  #applyResults(): void {
    const start = performance.now();
    while (this.#results.length > 0 && performance.now() - start < APPLY_BUDGET_MS) {
      const result = this.#results.shift();
      if (!result) break;
      if (result.quadCount === 0) {
        this.#removeMesh(result.key);
      } else {
        this.#setMesh(result.key, result.quads, result.quadCount, result.quadBytes);
      }
    }
  }

  #dispatch(): void {
    if (this.#queue.size === 0) return;
    if (this.#orderStale) {
      // Farthest first, so the nearest chunk is popped from the end.
      const size = this.#size;
      const cx = this.#cameraPosition.x / size;
      const cy = this.#cameraPosition.y / size;
      const cz = this.#cameraPosition.z / size;
      const distance = (key: number) => {
        const [x, y, z] = chunkKeyToCoords(key);
        return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 + (z + 0.5 - cz) ** 2;
      };
      this.#order = [...this.#queue].sort((p, q) => distance(q) - distance(p));
      this.#orderStale = false;
    }
    while (this.#order.length > 0) {
      const worker = this.#freeWorker();
      if (worker < 0) return;
      const key = this.#order.pop();
      if (key === undefined || !this.#queue.delete(key)) continue;
      this.#send(key, worker);
    }
  }

  #freeWorker(): number {
    let best = -1;
    for (let i = 0; i < this.#workerLoad.length; i++) {
      const load = this.#workerLoad[i] ?? 0;
      if (load < JOBS_PER_WORKER && (best < 0 || load < (this.#workerLoad[best] ?? 0))) best = i;
    }
    return best;
  }

  #send(key: number, worker: number): void {
    const [cx, cy, cz] = chunkKeyToCoords(key);
    if (!this.#world.chunk(cx, cy, cz)) {
      this.#removeMesh(key);
      return;
    }
    const bits = this.#world.layout.bits;
    const volume = paddedVolume(bits);
    const cells = this.#world.copyPadded(cx, cy, cz, new Uint16Array(volume));
    // Only baked lighting sends light along; the volume renderer reads it on the GPU.
    const baked = this.#mode === "vertex" ? this.#light : null;
    const light = baked ? baked.copyPadded(cx, cy, cz, new Uint16Array(volume)) : null;
    const opaque = baked && this.#lightMaterials ? this.#lightMaterials.opaque.slice() : null;
    const job: MeshJob = { jobId: this.#nextJob++, key, bits, cells, light, opaque };
    const transfer: Transferable[] = [cells.buffer];
    if (light) transfer.push(light.buffer);
    if (opaque) transfer.push(opaque.buffer);
    this.#workers[worker]?.postMessage(job, transfer);
    this.#workerLoad[worker] = (this.#workerLoad[worker] ?? 0) + 1;
    this.#inFlight.set(job.jobId, worker);
    this.#inFlightKeys.add(key);
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
    this.#uploads.delete(key);
  }

  /** Takes a mesh's quads out of the totals. */
  #forget(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry as THREE.InstancedBufferGeometry;
    this.#quads -= geometry.instanceCount;
    this.#quadBytes -= geometry.instanceCount * (geometry.userData.quadBytes as number);
  }

  #recordMeshTime(ms: number): void {
    this.#meshTimes.push(ms);
    if (this.#meshTimes.length > 256) this.#meshTimes.shift();
  }
}
