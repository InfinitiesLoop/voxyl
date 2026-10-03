import { chunkKeyToCoords, type World } from "@voxyl/core";
import { extractSlab, FACES, QUAD_BYTES } from "@voxyl/mesher";
import * as THREE from "three/webgpu";
import { type Palette, UNDECIDED_COLOR } from "../palettes.ts";
import type { MeshJob, MeshResult } from "./mesh-protocol.ts";
import { createQuadMaterial, PALETTE_SIZE } from "./quad-material.ts";

/** Jobs each worker may hold at once, so one slow chunk doesn't stall the queue. */
const JOBS_PER_WORKER = 2;
/** Main-thread time per frame spent swapping finished meshes in. */
const APPLY_BUDGET_MS = 4;

export interface ChunkRendererStats {
  readonly meshes: number;
  readonly quads: number;
  readonly queued: number;
  readonly inFlight: number;
  /** Worker meshing time per chunk over recent jobs. */
  readonly meshMsAvg: number;
  readonly workers: number;
}

/**
 * Keeps one mesh per chunk in step with the World. Each frame it collects the chunks the
 * World reports dirty, sends snapshots of them (plus neighbouring layers) to a worker pool,
 * nearest the camera first, and swaps finished meshes in. A chunk edited while its mesh is
 * being built is queued again, so the newest state always wins.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly #world: World;
  readonly #size: number;
  readonly #material: THREE.MeshBasicNodeMaterial;
  readonly #paletteData: Uint8Array;
  readonly #paletteTexture: THREE.DataTexture;
  #palette: Palette;
  #paletteStates = -1;

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
  readonly #meshTimes: number[] = [];
  #idleWaiters: (() => void)[] = [];
  readonly #cameraPosition = new THREE.Vector3();

  constructor(world: World, palette: Palette, workerCount: number) {
    this.#world = world;
    this.#size = world.layout.size;
    this.#palette = palette;
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#material = createQuadMaterial(this.#paletteTexture);
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

  setPalette(palette: Palette): void {
    this.#palette = palette;
    this.#paletteStates = -1;
  }

  /** Call once per frame before rendering. */
  update(camera: THREE.Camera): void {
    this.#syncPalette();
    for (const key of this.#world.takeDirtyChunks()) {
      if (this.#inFlightKeys.has(key)) {
        this.#again.add(key);
      } else if (!this.#queue.has(key)) {
        this.#queue.add(key);
        this.#orderStale = true;
      }
    }
    this.#cameraPosition.copy(camera.position);
    this.#applyResults();
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

  /** True when every edit so far is meshed and on screen. */
  get idle(): boolean {
    return (
      this.#world.dirtyCount === 0 &&
      this.#queue.size === 0 &&
      this.#inFlight.size === 0 &&
      this.#results.length === 0 &&
      this.#again.size === 0
    );
  }

  /** Resolves after the first rendered frame in which all edits so far are visible. */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  stats(): ChunkRendererStats {
    const times = this.#meshTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      queued: this.#queue.size + this.#again.size,
      inFlight: this.#inFlight.size,
      meshMsAvg: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
      workers: this.#workers.length,
    };
  }

  dispose(): void {
    for (const worker of this.#workers) worker.terminate();
    for (const mesh of this.#meshes.values()) mesh.geometry.dispose();
    this.#meshes.clear();
    this.group.clear();
    this.#material.dispose();
    this.#paletteTexture.dispose();
  }

  #syncPalette(): void {
    const states = this.#world.states;
    if (states.size === this.#paletteStates) return;
    const data = this.#paletteData;
    for (let id = 1; id <= states.size; id++) {
      const semantic = states.get(id)?.semantic ?? "";
      const hex = this.#palette.colors[semantic] ?? UNDECIDED_COLOR;
      const rgb = Number.parseInt(hex.slice(1), 16);
      data[id * 4] = (rgb >> 16) & 0xff;
      data[id * 4 + 1] = (rgb >> 8) & 0xff;
      data[id * 4 + 2] = rgb & 0xff;
      data[id * 4 + 3] = 0xff;
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
        this.#setMesh(result.key, result.quads, result.quadCount);
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
    const chunk = this.#world.chunk(cx, cy, cz);
    if (!chunk) {
      this.#removeMesh(key);
      return;
    }
    const bits = this.#world.layout.bits;
    const neighbors = FACES.map((face, f) => {
      const c = [cx, cy, cz];
      c[face.axis] = (c[face.axis] ?? 0) + face.sign;
      const neighbor = this.#world.chunk(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
      return neighbor ? extractSlab(neighbor.cells, bits, f) : null;
    });
    const cells = chunk.cells.slice();
    const job: MeshJob = { jobId: this.#nextJob++, key, bits, cells, neighbors };
    const transfer: Transferable[] = [cells.buffer];
    for (const slab of neighbors) if (slab) transfer.push(slab.buffer);
    this.#workers[worker]?.postMessage(job, transfer);
    this.#workerLoad[worker] = (this.#workerLoad[worker] ?? 0) + 1;
    this.#inFlight.set(job.jobId, worker);
    this.#inFlightKeys.add(key);
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

  #recordMeshTime(ms: number): void {
    this.#meshTimes.push(ms);
    if (this.#meshTimes.length > 256) this.#meshTimes.shift();
  }
}
