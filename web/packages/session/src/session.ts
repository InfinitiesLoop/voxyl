import { type CellStateTable, chunkKeyToCoords, type World } from "@voxyl/core";
import { GPU_BRICK_BITS, LightEngine, type LightMaterials } from "@voxyl/light";
import { describeStates, paddedVolume, type StateShape } from "@voxyl/mesher";
import { LightLayout, type LightLayoutUpdate } from "./light-layout.ts";

/**
 * How faces are lit: not at all, or from the light volume (light the renderer reads per
 * fragment from bricks of light the session sends; a light change resends bricks, never
 * meshes).
 */
export type LightingMode = "off" | "volume";

/** Opacity and emission per cell state, from whatever decides looks (the palette). */
export type MaterialsFor = (states: CellStateTable) => LightMaterials;

/** A chunk to mesh: the mesher's input, plus what identifies the result. */
export interface MeshJob {
  readonly jobId: number;
  readonly key: number;
  readonly bits: number;
  /** World.copyPadded() output. */
  readonly cells: Uint16Array;
  /** Brick size for the light bricks the mesh reports (ChunkMesh.lightBricks). */
  readonly lightBrickBits: number;
  /** Also find the chunk's feature edges (chunkEdges), for the line-drawing render modes. */
  readonly edges: boolean;
}

export interface SessionStats {
  readonly lighting: LightingMode;
  /** Chunks waiting to be meshed. */
  readonly queued: number;
  readonly inFlight: number;
  /** Light bricks kept on the GPU, and chunk tables pointing at them. */
  readonly lightBricks: number;
  readonly lightTables: number;
  /** Time the last full relight took, if lighting is on. */
  readonly lightAllMs: number | null;
  /** Light engine memory. */
  readonly lightMb: number;
  /** Time to copy one brick of light for sending, over recent batches, in microseconds. */
  readonly lightCopyUs: number;
}

const perf = (globalThis as { performance?: { now(): number } }).performance;
const now = (): number => (perf ? perf.now() : Date.now());

/** True if two material tables give the same light. */
export function sameMaterials(a: LightMaterials, b: LightMaterials): boolean {
  if (a.opaque.length !== b.opaque.length) return false;
  for (let i = 0; i < a.opaque.length; i++) {
    if (a.opaque[i] !== b.opaque[i] || a.emission[i] !== b.emission[i]) return false;
  }
  return true;
}

/**
 * One World and everything derived from it that the renderer needs: which chunks to mesh,
 * nearest the camera first, and (with lighting on) which bricks of light to send and where
 * they go on the GPU (a LightLayout). It owns the light engine, so lighting the world never
 * runs on the thread that draws.
 *
 * It is a plain state machine, with no workers or timers: edit `world`, call sync(), then
 * hand out work with takeJob() and takeLightUpdate() and report finished meshes with
 * finishJob(). A chunk edited while it is being meshed starts a new job at once; the mesh
 * already running is stale and finishJob says so, so the latest edit is not stuck behind it.
 */
export class WorldSession {
  readonly world: World;
  #mode: LightingMode = "off";
  #materialsFor: MaterialsFor | null = null;
  #materials: LightMaterials | null = null;
  #light: LightEngine | null = null;
  #layout: LightLayout | null = null;
  #lightAllMs: number | null = null;
  readonly #camera = [0, 0, 0];

  readonly #queue = new Set<number>();
  #order: number[] = [];
  #orderStale = false;
  readonly #inFlight = new Map<number, number>(); // chunk key -> job id
  /** Job ids superseded by a later edit of the same chunk. Their meshes are dropped. */
  readonly #stale = new Set<number>();
  readonly #removed: number[] = [];
  #edges = false;
  #nextJob = 1;
  /** The light bricks each meshed chunk's faces read, kept with lighting off too. */
  readonly #meshBricks = new Map<number, Uint16Array>();
  readonly #copyTimes: number[] = [];
  /** States described to the mesher so far (see takeShapes). */
  #described = 0;

  constructor(world: World) {
    this.world = world;
    for (const key of world.chunkKeys()) this.#enqueue(key);
  }

  get lighting(): LightingMode {
    return this.#mode;
  }

  /** The light layout, while lighting is on (for its brick and table sizes). */
  get layout(): LightLayout | null {
    return this.#layout;
  }

  /**
   * Switches lighting. Turning it on lights the whole world now, which takes seconds on big
   * worlds, and then sends every brick of light the meshes read.
   */
  setLighting(mode: LightingMode, materialsFor: MaterialsFor | null = this.#materialsFor): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    if (mode === "off") {
      this.#light = null;
      this.#layout = null;
      this.#materials = null;
      this.#lightAllMs = null;
      this.world.recordChanges(false);
      return;
    }
    if (!materialsFor) throw new Error("lighting needs materials");
    this.#materialsFor = materialsFor;
    this.#materials = materialsFor(this.world.states);
    this.#light = new LightEngine(this.world, this.#materials);
    this.#layout = new LightLayout({
      chunkBits: this.world.layout.bits,
      brickBits: GPU_BRICK_BITS,
    });
    for (const [key, bricks] of this.#meshBricks) this.#layout.setMeshBricks(key, bricks);
    this.world.recordChanges(true);
    this.#relightAll();
  }

  /**
   * New looks (a palette change). Returns true if the light changed, in which case the whole
   * world was relit and every brick is resent.
   */
  setMaterials(materialsFor: MaterialsFor): boolean {
    this.#materialsFor = materialsFor;
    const light = this.#light;
    if (!light || !this.#materials) return false;
    const next = materialsFor(this.world.states);
    if (sameMaterials(next, this.#materials)) return false;
    this.#materials = next;
    light.setMaterials(next);
    this.#relightAll();
    return true;
  }

  /**
   * Whether meshes come with feature edges (the outline, x-ray and wire views need them).
   * Turning them on meshes every chunk again; turning them off only stops sending them.
   */
  setEdges(on: boolean): void {
    if (on === this.#edges) return;
    this.#edges = on;
    if (on) this.remeshAll();
  }

  get edges(): boolean {
    return this.#edges;
  }

  /** Meshes every chunk again: the looks changed which cells hide their neighbours' faces. */
  remeshAll(): void {
    for (const key of this.world.chunkKeys()) this.#enqueue(key);
  }

  /** Where the camera is, so the nearest chunks are meshed first. */
  setCamera(x: number, y: number, z: number): void {
    this.#camera[0] = x;
    this.#camera[1] = y;
    this.#camera[2] = z;
    this.#orderStale = true;
  }

  /** Takes in the edits made to `world` since the last call: relights and queues work. */
  sync(): void {
    const light = this.#light;
    if (light && this.#materialsFor && this.#materials) {
      // New cell states (a semantic used for the first time) need entries in the tables.
      if (this.#materials.opaque.length !== this.world.states.size + 1) {
        this.#materials = this.#materialsFor(this.world.states);
        light.setMaterials(this.#materials);
      }
      light.update(this.world.takeChanges());
      this.#layout?.markDirty(light.takeDirty());
    }
    for (const key of this.world.takeDirtyChunks()) this.#enqueue(key);
  }

  /**
   * The shapes of cell states added since the last call, for the mesher's ShapeTable, or null
   * if there are none. Mesh jobs hold state ids, so deliver these before any job taken after.
   * Describing parts can intern their semantics as new states (see describeStates).
   */
  takeShapes(): { from: number; shapes: StateShape[] } | null {
    const states = this.world.states;
    if (states.size <= this.#described) return null;
    const from = this.#described + 1;
    const shapes = describeStates(states, from);
    this.#described = from + shapes.length - 1;
    return { from, shapes };
  }

  /** The next chunk to mesh, nearest the camera first, or null if none can start now. */
  takeJob(): MeshJob | null {
    if (this.#queue.size === 0) return null;
    if (this.#orderStale) {
      // Farthest first, so the nearest chunk is popped from the end.
      const S = this.world.layout.size;
      const [x, y, z] = this.#camera as [number, number, number];
      const distance = (key: number) => {
        const [cx, cy, cz] = chunkKeyToCoords(key);
        return ((cx + 0.5) * S - x) ** 2 + ((cy + 0.5) * S - y) ** 2 + ((cz + 0.5) * S - z) ** 2;
      };
      this.#order = [...this.#queue].sort((p, q) => distance(q) - distance(p));
      this.#orderStale = false;
    }
    while (this.#order.length > 0) {
      const key = this.#order.pop();
      if (key === undefined || !this.#queue.delete(key)) continue;
      const [cx, cy, cz] = chunkKeyToCoords(key);
      if (!this.world.chunk(cx, cy, cz)) {
        // Emptied: its mesh goes, and nothing reads light for it any more.
        this.#removed.push(key);
        this.#setMeshBricks(key, new Uint16Array(0));
        continue;
      }
      const bits = this.world.layout.bits;
      const job: MeshJob = {
        jobId: this.#nextJob++,
        key,
        bits,
        cells: this.world.copyPadded(cx, cy, cz, new Uint16Array(paddedVolume(bits))),
        lightBrickBits: GPU_BRICK_BITS,
        edges: this.#edges,
      };
      this.#inFlight.set(key, job.jobId);
      return job;
    }
    return null;
  }

  /**
   * Reports a finished mesh job. False when a later edit of the same chunk already started
   * another mesh: this result is stale and must not be drawn or update the light bricks.
   */
  finishJob(key: number, jobId: number, lightBricks: Uint16Array): boolean {
    if (this.#stale.delete(jobId)) return false;
    if (this.#inFlight.get(key) === jobId) this.#inFlight.delete(key);
    this.#setMeshBricks(key, lightBricks);
    return true;
  }

  /** Chunks that became empty since the last call: the renderer drops their meshes. */
  takeRemoved(): number[] {
    return this.#removed.splice(0);
  }

  /**
   * The next batch of GPU writes for the light volume, with at most `maxBricks` bricks of
   * light, or null if nothing is waiting (or lighting is off).
   */
  takeLightUpdate(maxBricks: number): LightLayoutUpdate | null {
    const light = this.#light;
    const layout = this.#layout;
    if (!light || !layout) return null;
    const start = now();
    const update = layout.takeUpdate(
      (origin, size, out) => light.copyBox(origin, size, out, true),
      maxBricks,
    );
    if (update && update.slots.length > 0) {
      this.#copyTimes.push(((now() - start) * 1000) / update.slots.length);
      if (this.#copyTimes.length > 64) this.#copyTimes.shift();
    }
    return update;
  }

  /** True when every edit so far has been meshed and its light sent. Call sync() first. */
  get idle(): boolean {
    return (
      this.world.dirtyCount === 0 &&
      this.#queue.size === 0 &&
      this.#inFlight.size === 0 &&
      this.#stale.size === 0 &&
      this.#removed.length === 0 &&
      !this.#layout?.pending
    );
  }

  stats(): SessionStats {
    const times = this.#copyTimes;
    return {
      lighting: this.#mode,
      queued: this.#queue.size,
      inFlight: this.#inFlight.size,
      lightBricks: this.#layout?.brickCount ?? 0,
      lightTables: this.#layout?.tableCount ?? 0,
      lightAllMs: this.#lightAllMs,
      lightMb: (this.#light?.memoryBytes ?? 0) / 2 ** 20,
      lightCopyUs: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
    };
  }

  #setMeshBricks(key: number, bricks: Uint16Array): void {
    if (bricks.length > 0) this.#meshBricks.set(key, bricks);
    else this.#meshBricks.delete(key);
    this.#layout?.setMeshBricks(key, bricks);
  }

  #relightAll(): void {
    const light = this.#light;
    if (!light) return;
    this.world.takeChanges(); // already reflected in a full relight
    const start = now();
    light.computeAll();
    this.#lightAllMs = now() - start;
    this.#layout?.markDirty(light.takeDirty());
  }

  #enqueue(key: number): void {
    const flight = this.#inFlight.get(key);
    // The mesh already running copied the cells before this edit. Drop it and mesh now,
    // so a second undo is not waiting on a picture of the first.
    if (flight !== undefined) {
      this.#stale.add(flight);
      this.#inFlight.delete(key);
    }
    if (!this.#queue.has(key)) {
      this.#queue.add(key);
      this.#orderStale = true;
    }
  }
}
