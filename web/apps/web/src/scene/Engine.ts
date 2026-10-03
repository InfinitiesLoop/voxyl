import { EMPTY_ID, raycast } from "@voxyl/core";
import * as THREE from "three/webgpu";
import type { Palette } from "../palettes.ts";
import type { BuiltWorld } from "../worlds.ts";
import { ChunkRenderer, type ChunkRendererStats } from "./ChunkRenderer.ts";
import { FlyCamera } from "./FlyCamera.ts";

export type Backend = "WebGPU" | "WebGL2";

const BACKGROUND = "#15171b";
const FRAME_WINDOW = 240;
const REACH = 400;
const PLACE_SEMANTIC = "Glow";

export interface FrameStats {
  readonly fps: number;
  readonly frameP50: number;
  readonly frameP95: number;
  readonly cpuP50: number;
  readonly cpuP95: number;
  readonly drawCalls: number;
  readonly triangles: number;
}

export interface EngineStats {
  readonly frame: FrameStats;
  readonly chunks: ChunkRendererStats | null;
  readonly cells: number;
  readonly chunkCount: number;
  readonly chunkSize: number;
  /** Dense chunk arrays held by the World. */
  readonly storageMb: number;
  /** Packed quads handed to the GPU. */
  readonly quadMb: number;
  /** JS heap, where the browser reports it (Chromium). */
  readonly heapMb: number | null;
  readonly initialMeshMs: number | null;
  readonly lastEditMs: number | null;
  readonly speed: number;
}

export interface FrameRecording {
  readonly frameMs: number[];
  readonly cpuMs: number[];
}

export type Autopilot = (seconds: number) => {
  position: THREE.Vector3Like;
  target: THREE.Vector3Like;
};

/**
 * Owns the renderer, scene, camera and frame loop, and connects them to one World through a
 * ChunkRenderer. React draws the HUD around it but never touches the scene.
 */
export class Engine {
  readonly renderer = new THREE.WebGPURenderer({ antialias: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
  readonly fly: FlyCamera;
  readonly #host: HTMLElement;
  readonly #observer: ResizeObserver;
  readonly #abort = new AbortController();
  #built: BuiltWorld | null = null;
  #chunks: ChunkRenderer | null = null;
  #palette: Palette | null = null;
  #placeId = EMPTY_ID;

  readonly #frameMs = new Float64Array(FRAME_WINDOW);
  readonly #cpuMs = new Float64Array(FRAME_WINDOW);
  #frames = 0;
  #lastTime = -1;
  #frameWaiters: (() => void)[] = [];
  #recording: FrameRecording | null = null;
  #autopilot: { pilot: Autopilot; start: number } | null = null;
  #loadStart = 0;
  #initialMeshMs: number | null = null;
  #lastEditMs: number | null = null;
  #disposed = false;

  constructor(host: HTMLElement) {
    this.#host = host;
    this.scene.background = new THREE.Color(BACKGROUND);
    this.fly = new FlyCamera(this.camera, this.renderer.domElement);
    this.#observer = new ResizeObserver(() => this.#resize());
    const canvas = this.renderer.domElement;
    const signal = this.#abort.signal;
    canvas.addEventListener("mousedown", (e) => this.#onMouseDown(e), { signal });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
  }

  /** Starts the renderer. Resolves to null if the engine was disposed while it started. */
  async init(): Promise<Backend | null> {
    await this.renderer.init();
    // React's development mode mounts, disposes and remounts: an engine disposed during this
    // await must not attach its canvas, or that dead canvas covers the live one.
    if (this.#disposed) return null;
    this.#host.appendChild(this.renderer.domElement);
    this.#observer.observe(this.#host);
    this.#resize();
    this.renderer.setAnimationLoop((time) => this.#frame(time));
    const webgpu = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    return webgpu ? "WebGPU" : "WebGL2";
  }

  get built(): BuiltWorld | null {
    return this.#built;
  }

  get chunks(): ChunkRenderer | null {
    return this.#chunks;
  }

  /** Shows a new world, replacing the current one. Meshing starts on the next frame. */
  load(built: BuiltWorld, palette: Palette): void {
    this.#chunks?.dispose();
    if (this.#chunks) this.scene.remove(this.#chunks.group);
    this.#built = built;
    this.#palette = palette;
    const workers = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
    this.#chunks = new ChunkRenderer(built.world, palette, workers);
    this.scene.add(this.#chunks.group);
    this.#placeId = built.world.states.intern({ semantic: PLACE_SEMANTIC });
    this.#initialMeshMs = null;
    this.#lastEditMs = null;
    this.#loadStart = performance.now();
    const loading = this.#chunks;
    loading.whenIdle().then(() => {
      if (this.#chunks === loading) this.#initialMeshMs = performance.now() - this.#loadStart;
    });
    const fogFar = Math.max(500, built.extent * 1.4);
    this.scene.fog = new THREE.Fog(BACKGROUND, fogFar * 0.35, fogFar);
    this.home();
  }

  /** Moves the camera to the world's overview position. */
  home(): void {
    const built = this.#built;
    if (!built) return;
    const [cx, , cz] = built.center;
    const e = built.extent;
    if (e <= 32) {
      this.fly.place({ x: cx + 22, y: 18, z: cz + 26 }, { x: cx, y: 7, z: cz });
    } else {
      this.fly.place(
        { x: cx - e * 0.42, y: Math.max(60, e * 0.18), z: cz - e * 0.42 },
        { x: cx, y: 10, z: cz },
      );
    }
  }

  setPalette(palette: Palette): void {
    this.#palette = palette;
    this.#chunks?.setPalette(palette);
  }

  get palette(): Palette | null {
    return this.#palette;
  }

  /** Flies the camera along a scripted path until cleared with null. */
  setAutopilot(pilot: Autopilot | null): void {
    this.#autopilot = pilot ? { pilot, start: performance.now() } : null;
    if (pilot) this.fly.unlock();
  }

  /**
   * Call right after writing to the World: sends the dirty chunks to the workers now instead
   * of on the next frame, so the new mesh can be on screen one frame later.
   */
  afterEdit(): void {
    this.#chunks?.update(this.camera);
  }

  startRecording(): void {
    this.#recording = { frameMs: [], cpuMs: [] };
  }

  stopRecording(): FrameRecording {
    const recording = this.#recording ?? { frameMs: [], cpuMs: [] };
    this.#recording = null;
    return recording;
  }

  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.#frameWaiters.push(resolve));
  }

  stats(): EngineStats {
    const built = this.#built;
    const chunks = this.#chunks?.stats() ?? null;
    const n = Math.min(this.#frames, FRAME_WINDOW);
    const frame = sortedWindow(this.#frameMs, n);
    const cpu = sortedWindow(this.#cpuMs, n);
    const mean = frame.length > 0 ? frame.reduce((s, t) => s + t, 0) / frame.length : 0;
    const info = this.renderer.info.render;
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const size = built?.world.layout.size ?? 0;
    return {
      frame: {
        fps: mean > 0 ? 1000 / mean : 0,
        frameP50: percentile(frame, 0.5),
        frameP95: percentile(frame, 0.95),
        cpuP50: percentile(cpu, 0.5),
        cpuP95: percentile(cpu, 0.95),
        drawCalls: info.drawCalls,
        triangles: info.triangles,
      },
      chunks,
      cells: built?.world.cellCount ?? 0,
      chunkCount: built?.world.chunkCount ?? 0,
      chunkSize: size,
      storageMb: ((built?.world.chunkCount ?? 0) * size ** 3 * 2) / 2 ** 20,
      quadMb: ((chunks?.quads ?? 0) * 8) / 2 ** 20,
      heapMb: memory ? memory.usedJSHeapSize / 2 ** 20 : null,
      initialMeshMs: this.#initialMeshMs,
      lastEditMs: this.#lastEditMs,
      speed: this.fly.speed,
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.renderer.setAnimationLoop(null);
    this.#abort.abort();
    this.#observer.disconnect();
    this.fly.dispose();
    this.#chunks?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  #frame(time: number): void {
    const cpuStart = performance.now();
    const delta = this.#lastTime < 0 ? -1 : time - this.#lastTime;
    const dt = delta < 0 ? 0 : delta / 1000;
    this.#lastTime = time;

    if (this.#autopilot) {
      const { pilot, start } = this.#autopilot;
      const pose = pilot((performance.now() - start) / 1000);
      this.fly.place(pose.position, pose.target);
    } else {
      this.fly.update(Math.min(dt, 0.1));
    }
    this.#chunks?.update(this.camera);
    this.renderer.render(this.scene, this.camera);
    this.#chunks?.afterRender();

    // Frame time is the gap between frames (what the user feels); CPU time is this callback's
    // main-thread work. The first frame has no gap, so it isn't recorded.
    const cpu = performance.now() - cpuStart;
    if (delta >= 0) {
      const slot = this.#frames % FRAME_WINDOW;
      this.#frameMs[slot] = delta;
      this.#cpuMs[slot] = cpu;
      this.#recording?.frameMs.push(delta);
      this.#recording?.cpuMs.push(cpu);
      this.#frames++;
    }
    const waiters = this.#frameWaiters;
    this.#frameWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #resize(): void {
    const w = this.#host.clientWidth;
    const h = Math.max(this.#host.clientHeight, 1);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #onMouseDown(event: MouseEvent): void {
    if (this.#autopilot) return;
    if (!this.fly.locked) {
      this.fly.lock();
      return;
    }
    event.preventDefault();
    const world = this.#built?.world;
    const chunks = this.#chunks;
    if (!world || !chunks) return;
    const dir = this.fly.forward();
    const hit = raycast(
      world,
      [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      [dir.x, dir.y, dir.z],
      REACH,
    );
    if (!hit) return;
    const [x, y, z] = hit.cell;
    const start = performance.now();
    let changed = false;
    if (event.button === 0) {
      changed = world.setId(x, y, z, EMPTY_ID);
    } else if (event.button === 2) {
      const [nx, ny, nz] = hit.normal;
      if (nx !== 0 || ny !== 0 || nz !== 0)
        changed = world.setId(x + nx, y + ny, z + nz, this.#placeId);
    } else if (event.button === 1) {
      this.#placeId = hit.id;
    }
    if (changed) {
      this.afterEdit();
      chunks.whenIdle().then(() => {
        this.#lastEditMs = performance.now() - start;
      });
    }
  }
}

function sortedWindow(values: Float64Array, count: number): number[] {
  return Array.from(values.subarray(0, count)).sort((a, b) => a - b);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}
