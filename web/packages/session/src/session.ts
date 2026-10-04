import { type CellStateTable, chunkKeyToCoords, type World } from "@voxyl/core";
import { LightEngine, type LightMaterials } from "@voxyl/light";
import { paddedVolume } from "@voxyl/mesher";

/**
 * How faces are lit. "vertex" bakes light into the quads (so a light change remeshes);
 * "volume" keeps quads plain and sends each meshed chunk's padded light for the renderer to
 * read on the GPU (so a light change resends light, never meshes). Both compute the same light.
 */
export type LightingMode = "off" | "vertex" | "volume";

/** Opacity and emission per cell state, from whatever decides looks (the palette). */
export type MaterialsFor = (states: CellStateTable) => LightMaterials;

/** A chunk to mesh: the mesher's input, plus what identifies the result. */
export interface MeshJob {
  readonly jobId: number;
  readonly key: number;
  readonly bits: number;
  /** World.copyPadded() output. */
  readonly cells: Uint16Array;
  /** Light to bake into the quads ("vertex" lighting), or null for plain quads. */
  readonly light: Uint16Array | null;
  /** Per cell-state id, nonzero if it blocks light; null for plain quads. */
  readonly opaque: Uint8Array | null;
}

/** A meshed chunk's padded light with light-blocking cells marked ("volume" lighting). */
export interface LightSlot {
  readonly key: number;
  readonly light: Uint16Array;
}

export interface SessionStats {
  readonly lighting: LightingMode;
  /** Chunks waiting to be meshed. */
  readonly queued: number;
  readonly inFlight: number;
  /** Meshed chunks waiting for their light to be sent. */
  readonly lightQueued: number;
  /** Time the last full relight took, if lighting is on. */
  readonly lightAllMs: number | null;
  /** Light engine memory. */
  readonly lightMb: number;
  /** Time to copy one chunk's light for sending, over recent ones. */
  readonly lightCopyMs: number;
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
 * nearest the camera first, and (with volume lighting) which chunks' light to send. It owns
 * the light engine, so lighting the world never runs on the thread that draws.
 *
 * It is a plain state machine, with no workers or timers: edit `world`, call sync(), then
 * hand out work with takeJob() and takeLight() and report finished meshes with finishJob().
 * At most one job per chunk is in flight, so a chunk's meshes finish in the order they
 * started; a chunk edited while it is being meshed is meshed again afterwards.
 */
export class WorldSession {
  readonly world: World;
  #mode: LightingMode = "off";
  #materialsFor: MaterialsFor | null = null;
  #materials: LightMaterials | null = null;
  #light: LightEngine | null = null;
  #lightAllMs: number | null = null;
  readonly #camera = [0, 0, 0];

  readonly #queue = new Set<number>();
  #order: number[] = [];
  #orderStale = false;
  readonly #inFlight = new Map<number, number>(); // chunk key -> job id
  readonly #again = new Set<number>();
  readonly #removed: number[] = [];
  #nextJob = 1;
  /** Chunks whose latest mesh has quads: the ones whose light the renderer needs. */
  readonly #meshed = new Set<number>();
  readonly #lightQueue = new Set<number>();
  /** Meshed chunks whose current light has been sent. */
  readonly #lightSent = new Set<number>();
  readonly #copyTimes: number[] = [];

  constructor(world: World) {
    this.world = world;
    for (const key of world.chunkKeys()) this.#enqueue(key);
  }

  get lighting(): LightingMode {
    return this.#mode;
  }

  /**
   * Switches lighting. Turning it on lights the whole world now, which takes seconds on big
   * worlds. Baked light remeshes every chunk when it starts or stops; volume light resends
   * light for every meshed chunk.
   */
  setLighting(mode: LightingMode, materialsFor: MaterialsFor | null = this.#materialsFor): void {
    if (mode === this.#mode) return;
    if (mode !== "off" && !materialsFor) throw new Error("lighting needs materials");
    const previous = this.#mode;
    this.#mode = mode;
    if (mode === "off") {
      this.#light = null;
      this.#materials = null;
      this.#lightAllMs = null;
      this.world.recordChanges(false);
    } else if (!this.#light && materialsFor) {
      this.#materialsFor = materialsFor;
      this.#materials = materialsFor(this.world.states);
      this.#light = new LightEngine(this.world, this.#materials);
      this.world.recordChanges(true);
      this.#relightAll();
    }
    if (previous === "vertex" || mode === "vertex") this.#remeshAll();
    this.#resendLight();
  }

  /**
   * New looks (a palette change). Returns true if the light changed, in which case the whole
   * world was relit and light is resent (or, baked, every chunk remeshed).
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
    if (this.#mode === "vertex") this.#remeshAll();
    this.#resendLight();
    return true;
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
      for (const key of light.takeDirtyChunks()) {
        if (this.#mode === "vertex") this.#enqueue(key);
        else if (this.#meshed.has(key)) this.#lightQueue.add(key);
      }
    }
    for (const key of this.world.takeDirtyChunks()) this.#enqueue(key);
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
        // Emptied: its mesh goes, and so does its light.
        this.#removed.push(key);
        this.#forget(key);
        continue;
      }
      const bits = this.world.layout.bits;
      const volume = paddedVolume(bits);
      const baked = this.#mode === "vertex" ? this.#light : null;
      const job: MeshJob = {
        jobId: this.#nextJob++,
        key,
        bits,
        cells: this.world.copyPadded(cx, cy, cz, new Uint16Array(volume)),
        light: baked ? baked.copyPadded(cx, cy, cz, new Uint16Array(volume)) : null,
        opaque: baked && this.#materials ? this.#materials.opaque.slice() : null,
      };
      this.#inFlight.set(key, job.jobId);
      return job;
    }
    return null;
  }

  /** Reports a finished mesh job and whether its mesh has any quads. */
  finishJob(key: number, jobId: number, quadCount: number): void {
    if (this.#inFlight.get(key) === jobId) this.#inFlight.delete(key);
    if (this.#again.delete(key)) this.#enqueue(key);
    if (quadCount > 0) {
      this.#meshed.add(key);
      if (this.#mode === "volume" && !this.#lightSent.has(key)) this.#lightQueue.add(key);
    } else {
      this.#forget(key);
    }
  }

  /** Chunks that became empty since the last call: the renderer drops their meshes. */
  takeRemoved(): number[] {
    return this.#removed.splice(0);
  }

  /** The next meshed chunk's light to send (volume lighting), or null if none is due. */
  takeLight(): LightSlot | null {
    const light = this.#light;
    for (const key of this.#lightQueue) {
      this.#lightQueue.delete(key);
      if (!light || !this.#meshed.has(key)) continue;
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const start = now();
      const data = light.copyPadded(
        cx,
        cy,
        cz,
        new Uint16Array(paddedVolume(this.world.layout.bits)),
        true,
      );
      this.#copyTimes.push(now() - start);
      if (this.#copyTimes.length > 256) this.#copyTimes.shift();
      this.#lightSent.add(key);
      return { key, light: data };
    }
    return null;
  }

  /** True when every edit so far has been meshed and its light sent. Call sync() first. */
  get idle(): boolean {
    return (
      this.world.dirtyCount === 0 &&
      this.#queue.size === 0 &&
      this.#inFlight.size === 0 &&
      this.#again.size === 0 &&
      this.#removed.length === 0 &&
      this.#lightQueue.size === 0
    );
  }

  stats(): SessionStats {
    const times = this.#copyTimes;
    return {
      lighting: this.#mode,
      queued: this.#queue.size + this.#again.size,
      inFlight: this.#inFlight.size,
      lightQueued: this.#lightQueue.size,
      lightAllMs: this.#lightAllMs,
      lightMb: (this.#light?.memoryBytes ?? 0) / 2 ** 20,
      lightCopyMs: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
    };
  }

  #relightAll(): void {
    const light = this.#light;
    if (!light) return;
    this.world.takeChanges(); // already reflected in a full relight
    const start = now();
    light.computeAll();
    this.#lightAllMs = now() - start;
    light.takeDirtyChunks();
  }

  #remeshAll(): void {
    for (const key of this.world.chunkKeys()) this.#enqueue(key);
  }

  #resendLight(): void {
    this.#lightQueue.clear();
    this.#lightSent.clear();
    if (this.#mode === "volume") for (const key of this.#meshed) this.#lightQueue.add(key);
  }

  #enqueue(key: number): void {
    if (this.#inFlight.has(key)) {
      this.#again.add(key);
    } else if (!this.#queue.has(key)) {
      this.#queue.add(key);
      this.#orderStale = true;
    }
  }

  #forget(key: number): void {
    this.#meshed.delete(key);
    this.#lightSent.delete(key);
    this.#lightQueue.delete(key);
  }
}
