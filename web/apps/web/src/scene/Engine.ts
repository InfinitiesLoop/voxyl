import type { LightingMode } from "@voxyl/session";
import * as THREE from "three/webgpu";
import type { Vec3, WorldStats } from "../world/protocol.ts";
import { WorldClient, type WorldOutput } from "../world/WorldClient.ts";
import type { WorldInfo, WorldSource } from "../worlds.ts";
import { ChunkRenderer, type ChunkRendererStats } from "./ChunkRenderer.ts";
import { FlyCamera } from "./FlyCamera.ts";
import { LightVolume } from "./light-volume.ts";

export type Backend = "WebGPU" | "WebGL2";

const BACKGROUND = "#15171b";
const FRAME_WINDOW = 240;
const REACH = 400;
const PLACE_SEMANTIC = "Glow";
/** How far the camera moves before the world worker is told (it orders meshing by distance). */
const CAMERA_STEP = 4;

export interface FrameStats {
  readonly fps: number;
  readonly frameP50: number;
  readonly frameP95: number;
  readonly cpuP50: number;
  readonly cpuP95: number;
  /** GPU time per frame (timestamp queries), or null where the browser has none. */
  readonly gpuP50: number | null;
  readonly gpuP95: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
}

export interface EngineStats {
  readonly frame: FrameStats;
  readonly chunks: ChunkRendererStats | null;
  /** The world worker's report, about four times a second. */
  readonly world: WorldStats | null;
  readonly chunkSize: number;
  readonly meshWorkers: number;
  /** Packed quads handed to the GPU. */
  readonly quadMb: number;
  /** JS heap of the main thread, where the browser reports it (Chromium). */
  readonly heapMb: number | null;
  readonly initialMeshMs: number | null;
  readonly lastEditMs: number | null;
  readonly speed: number;
}

export interface FrameRecording {
  readonly frameMs: number[];
  readonly cpuMs: number[];
  readonly gpuMs: number[];
}

export type Autopilot = (seconds: number) => {
  position: THREE.Vector3Like;
  target: THREE.Vector3Like;
};

/**
 * Owns the renderer, scene, camera and frame loop. The world itself lives in the world
 * worker (see WorldClient); a ChunkRenderer draws what it sends. React draws the HUD around
 * this but never touches the scene.
 */
export class Engine {
  readonly renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
  readonly fly: FlyCamera;
  /** The world worker: send commands through this. */
  readonly world: WorldClient;
  readonly #host: HTMLElement;
  readonly #observer: ResizeObserver;
  readonly #abort = new AbortController();
  #worldId = 0;
  #info: WorldInfo | null = null;
  #chunks: ChunkRenderer | null = null;
  #worldStats: WorldStats | null = null;
  #placeId = 0;
  /** StateLooks.colors for the world on screen. */
  #looks: Uint8Array = new Uint8Array(0);
  /** Counts world changes seen (meshes, light, looks), so other views know to refresh. */
  #revision = 0;
  #lighting: LightingMode = "off";
  #daylight = 1;
  #brightness = 0.5;
  readonly #sentCamera = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);

  readonly #frameMs = new Float64Array(FRAME_WINDOW);
  readonly #cpuMs = new Float64Array(FRAME_WINDOW);
  readonly #gpuMs = new Float64Array(FRAME_WINDOW);
  #gpuFrames = 0;
  #gpuPending = false;
  /** Frames rendered since timestamps were last resolved. */
  #unresolved = 0;
  #frames = 0;
  #lastTime = -1;
  #frameWaiters: (() => void)[] = [];
  #idleWaiters: (() => void)[] = [];
  #recording: FrameRecording | null = null;
  #autopilot: { pilot: Autopilot; start: number } | null = null;
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
    // One core for this thread, one for the world worker, the rest mesh.
    const meshWorkers = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
    this.world = new WorldClient(meshWorkers, (message) => this.#onWorld(message));
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

  /** The world on screen, once loaded. */
  get info(): WorldInfo | null {
    return this.#info;
  }

  /**
   * Builds a world in the world worker and shows it, replacing the current one. Resolves to
   * its info, or null if another load replaced it first.
   */
  async load(source: WorldSource, chunkSize: number, theme: number): Promise<WorldInfo | null> {
    const id = ++this.#worldId;
    if (this.#chunks) {
      this.scene.remove(this.#chunks.group);
      this.#chunks.dispose();
    }
    this.#chunks = null;
    this.#info = null;
    this.#worldStats = null;
    const info = await this.world.request({ type: "load", world: id, source, chunkSize, theme });
    if (id !== this.#worldId || this.#disposed) return null;
    // The worker sends nothing about this world before its reply, so nothing was missed.
    const chunks = new ChunkRenderer(this.renderer, chunkSize);
    chunks.setDaylight(this.#daylight);
    chunks.setBrightness(this.#brightness);
    chunks.setLighting(this.#lighting);
    this.#chunks = chunks;
    this.#info = info;
    this.scene.add(chunks.group);
    const fogFar = Math.max(500, info.extent * 1.4);
    this.scene.fog = new THREE.Fog(BACKGROUND, fogFar * 0.35, fogFar);
    this.#initialMeshMs = null;
    this.#lastEditMs = null;
    this.home();
    const start = performance.now();
    void this.whenIdle().then(() => {
      if (this.#worldId !== id) return;
      this.#initialMeshMs = performance.now() - start;
      chunks.revealLight();
    });
    this.#placeId = await this.world.request({ type: "intern", semantic: PLACE_SEMANTIC });
    return info;
  }

  /** Every cell state's look (StateLooks.colors) for the world on screen. */
  get looks(): Uint8Array {
    return this.#looks;
  }

  /** Grows whenever the world worker reports a change, for views that copy what they show. */
  get revision(): number {
    return this.#revision;
  }

  /** Moves the camera to the world's overview position. */
  home(): void {
    const info = this.#info;
    if (!info) return;
    const [cx, , cz] = info.center;
    const e = info.extent;
    if (e <= 32) {
      this.fly.place({ x: cx + 22, y: 18, z: cz + 26 }, { x: cx, y: 7, z: cz });
    } else {
      this.fly.place(
        { x: cx - e * 0.42, y: Math.max(60, e * 0.18), z: cz - e * 0.42 },
        { x: cx, y: 10, z: cz },
      );
    }
  }

  /**
   * Re-skins the sample build with a city theme: the world worker syncs it into the project's
   * linked palette and sends new looks; if light changed, it relights.
   */
  async setTheme(theme: number): Promise<void> {
    await this.world.request({ type: "theme", theme });
  }

  /**
   * Minecraft-style light from a light volume, or off; kept across loads. Without WebGPU the
   * world stays unlit. Resolves once the world worker has lit the world and its light is on
   * screen; drawing carries on meanwhile, unlit until then.
   */
  async setLighting(requested: LightingMode): Promise<void> {
    const mode = this.volumeLighting ? requested : "off";
    this.#lighting = mode;
    const chunks = this.#chunks;
    chunks?.setLighting(mode);
    await this.world.request({ type: "lighting", mode });
    if (mode === "off" || !chunks) return;
    await this.whenIdle();
    if (this.#chunks === chunks && this.#lighting === mode) chunks.revealLight();
  }

  get lighting(): LightingMode {
    return this.#lighting;
  }

  /** Time of day, 0 (midnight) to 1 (noon). */
  setDaylight(daylight: number): void {
    this.#daylight = daylight;
    this.#chunks?.setDaylight(daylight);
  }

  /** Minecraft's Brightness setting, 0 (Moody) to 1 (Bright); 0.5 is its default. */
  setBrightness(brightness: number): void {
    this.#brightness = brightness;
    this.#chunks?.setBrightness(brightness);
  }

  /** True if this renderer can draw volume lighting (WebGPU). */
  get volumeLighting(): boolean {
    return LightVolume.supported(this.renderer);
  }

  /** Flies the camera along a scripted path until cleared with null. */
  setAutopilot(pilot: Autopilot | null): void {
    this.#autopilot = pilot ? { pilot, start: performance.now() } : null;
    if (pilot) this.fly.unlock();
  }

  /** Resolves after the first rendered frame in which every command so far is visible. */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  startRecording(): void {
    this.#recording = { frameMs: [], cpuMs: [], gpuMs: [] };
  }

  stopRecording(): FrameRecording {
    const recording = this.#recording ?? { frameMs: [], cpuMs: [], gpuMs: [] };
    this.#recording = null;
    return recording;
  }

  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.#frameWaiters.push(resolve));
  }

  stats(): EngineStats {
    const chunks = this.#chunks?.stats() ?? null;
    const n = Math.min(this.#frames, FRAME_WINDOW);
    const frame = sortedWindow(this.#frameMs, n);
    const cpu = sortedWindow(this.#cpuMs, n);
    const gpu = sortedWindow(this.#gpuMs, Math.min(this.#gpuFrames, FRAME_WINDOW));
    const mean = frame.length > 0 ? frame.reduce((s, t) => s + t, 0) / frame.length : 0;
    const info = this.renderer.info.render;
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      frame: {
        fps: mean > 0 ? 1000 / mean : 0,
        frameP50: percentile(frame, 0.5),
        frameP95: percentile(frame, 0.95),
        cpuP50: percentile(cpu, 0.5),
        cpuP95: percentile(cpu, 0.95),
        gpuP50: gpu.length > 0 ? percentile(gpu, 0.5) : null,
        gpuP95: gpu.length > 0 ? percentile(gpu, 0.95) : null,
        drawCalls: info.drawCalls,
        triangles: info.triangles,
      },
      chunks,
      world: this.#worldStats,
      chunkSize: this.#info?.chunkSize ?? 0,
      meshWorkers: this.world.meshWorkers,
      quadMb: (chunks?.quadBytes ?? 0) / 2 ** 20,
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
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  #onWorld(message: WorldOutput): void {
    if (message.world !== this.#worldId) return; // about a world since replaced
    if (message.type === "stats") {
      this.#worldStats = message.stats;
      return;
    }
    if (message.type === "looks") this.#looks = message.colors;
    if (message.type !== "idle") this.#revision++;
    const chunks = this.#chunks;
    if (!chunks) return;
    if (message.type === "looks") chunks.setLooks(message.colors);
    else chunks.receive(message);
  }

  /** Every command sent so far has been worked through and applied. */
  get #settled(): boolean {
    const chunks = this.#chunks;
    return !!chunks && chunks.caughtUp && chunks.appliedSeq >= this.world.sentSeq;
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
    const p = this.camera.position;
    if (p.distanceTo(this.#sentCamera) > CAMERA_STEP) {
      this.#sentCamera.copy(p);
      this.world.camera([p.x, p.y, p.z]);
    }
    this.#chunks?.update();
    this.renderer.render(this.scene, this.camera);
    this.#resolveGpuTime();
    if (this.#idleWaiters.length > 0 && this.#settled) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }

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

  /**
   * Reads back GPU time from the timestamp queries, at most one read at a time; a read that
   * covers several frames is split evenly between them.
   */
  #resolveGpuTime(): void {
    this.#unresolved++;
    if (this.#gpuPending) return;
    this.#gpuPending = true;
    const frames = this.#unresolved;
    this.#unresolved = 0;
    this.renderer.resolveTimestampsAsync("render").then(
      (ms) => {
        this.#gpuPending = false;
        if (typeof ms !== "number" || ms <= 0) return;
        const perFrame = ms / frames;
        this.#gpuMs[this.#gpuFrames % FRAME_WINDOW] = perFrame;
        this.#gpuFrames++;
        this.#recording?.gpuMs.push(perFrame);
      },
      () => {
        this.#gpuPending = false;
      },
    );
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
    if (!this.#info) return;
    const p = this.camera.position;
    const d = this.fly.forward();
    const origin: Vec3 = [p.x, p.y, p.z];
    const dir: Vec3 = [d.x, d.y, d.z];
    if (event.button === 1) {
      void this.world.request({ type: "raycast", origin, dir, reach: REACH }).then((hit) => {
        if (hit) this.#placeId = hit.id;
      });
      return;
    }
    const action = event.button === 0 ? "erase" : event.button === 2 ? "place" : null;
    if (!action) return;
    const start = performance.now();
    void this.world
      .request({ type: "rayEdit", origin, dir, reach: REACH, action, id: this.#placeId })
      .then(async (changed) => {
        if (!changed) return;
        await this.whenIdle();
        this.#lastEditMs = performance.now() - start;
      });
  }
}

function sortedWindow(values: Float64Array, count: number): number[] {
  return Array.from(values.subarray(0, count)).sort((a, b) => a - b);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}
