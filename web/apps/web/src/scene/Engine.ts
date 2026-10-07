import { boxOf, type Region, type SemanticArg } from "@voxyl/core";
import type { LightingMode } from "@voxyl/session";
import * as THREE from "three/webgpu";
import { grouped, nudgedBox } from "../editor/counts.ts";
import { Hotbar } from "../editor/hotbar.ts";
import { boxLines } from "../editor/outline.ts";
import { Store } from "../editor/store.ts";
import { type EditorTool, readTool, rememberTool } from "../editor/tool.ts";
import type { HistoryState, PaletteInfo } from "../world/editing.ts";
import {
  EMPTY_SELECTION,
  type Ray,
  type SelectionView,
  type Vec3,
  type WorldStats,
} from "../world/protocol.ts";
import { WorldClient, type WorldOutput } from "../world/WorldClient.ts";
import type { WorldInfo, WorldSource } from "../worlds.ts";
import { ChunkRenderer, type ChunkRendererStats } from "./ChunkRenderer.ts";
import { applyPose, FlyCamera, type FlyPose } from "./FlyCamera.ts";
import { GroundGrid } from "./ground-grid.ts";
import { LightVolume } from "./light-volume.ts";
import { SelectionOutline } from "./SelectionOutline.ts";
import { Sky } from "./sky.ts";
import { NOON, skyAt } from "./sky-model.ts";
import { SliceGuide, type SliceWindow } from "./slice-guide.ts";
import { TargetOutline } from "./target.ts";

export type Backend = "WebGPU" | "WebGL2";

/** One 3D pane's rectangle, in CSS pixels from the canvas's top left, and its time of day. */
export interface ViewFrame {
  readonly id: string;
  readonly time: number;
  readonly focused: boolean;
  /** Draw the ground grid in this pane. */
  readonly grid: boolean;
  /** Draw where the active 2D view cuts the world. */
  readonly slice: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const FRAME_WINDOW = 240;
/** How far the crosshair reaches, in cells. */
const REACH = 400;
/** A press that moves the cursor less than this many pixels is a click, not a drag. */
const CLICK_SLOP = 4;
/**
 * Wheel travel per hotbar slot. A mouse notch is about 100 pixels (and a line-mode event
 * is one notch); half of that stepped two slots a notch. Trackpads send small steps that
 * add up to a notch.
 */
const WHEEL_PER_SLOT = 100;
/** Cells moved per unit of wheel travel with a free cursor, at the base speed of 15. */
const DOLLY_PER_WHEEL = 0.02;
const HOTBAR_KEYS = /^(?:Digit|Numpad)([1-9])$/;
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
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
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
  /** The nine semantic slots along the bottom. */
  readonly hotbar = new Hotbar();
  /** Every palette of the open project and what it can place. */
  readonly palettes = new Store<readonly PaletteInfo[]>([]);
  /** What undo and redo would do now. */
  readonly history = new Store<HistoryState>({ undo: null, redo: null });
  /** The open project's name, as it is now (renames undo). */
  readonly projectName = new Store("");
  /** Build, Select or Wand. Remembered across visits. */
  readonly tool = new Store<EditorTool>(readTool());
  /** The project's selection, for the panel and the outline. */
  readonly selection = new Store<SelectionView>(EMPTY_SELECTION);
  /** The first corner of a box, before the second click completes it. */
  readonly anchor = new Store<Vec3 | null>(null);
  /** A command the selection panel should say failed, or "". */
  readonly notice = new Store("");
  /** The inventory overlay. E toggles it; opening releases the pointer. */
  readonly inventoryOpen = new Store(false);
  /** Called when a click chooses a different 3D pane, so the chrome can follow. */
  onFocusView: ((id: string) => void) | null = null;
  readonly #views = new Map<string, { camera: THREE.PerspectiveCamera; pose: FlyPose }>();
  #viewFrames: ViewFrame[] = [];
  /** False until the panes have reported their rectangles, so the first frames fill the canvas. */
  #framesSet = false;
  #focusedId = "";
  #width = 1;
  #height = 1;
  readonly #target = new TargetOutline();
  readonly #selectionOutline = new SelectionOutline();
  readonly #grid = new GroundGrid();
  readonly #sliceGuide = new SliceGuide();
  /** Which 2D view the slice guide belongs to. */
  #sliceOwner: object | null = null;
  #anchor: Vec3 | null = null;
  /** Where a free-cursor drag orbits, when a selection has a box around it. */
  readonly #orbitTarget = new THREE.Vector3();
  #orbiting = false;
  /** Select and wand clicks, so a second corner waits for the first to be recorded. */
  #clicks: Promise<unknown> = Promise.resolve();
  /** An aim request in flight, and the camera pose and world revision last aimed for. */
  #aiming = false;
  #aimedFor = "";
  /** A drag of the view with a free cursor. */
  #drag: { x: number; y: number; moved: boolean } | null = null;
  #wheel = 0;
  /** StateLooks.colors for the world on screen. */
  #looks: Uint8Array = new Uint8Array(0);
  /** Counts world changes seen (meshes, light, looks), so other views know to refresh. */
  #revision = 0;
  #lighting: LightingMode = "off";
  #hours = NOON;
  readonly #sky = new Sky();
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
    this.scene.add(this.#sky.mesh);
    this.scene.add(this.#grid.group);
    this.scene.add(this.#target.object);
    this.scene.add(this.#selectionOutline.object);
    this.scene.add(this.#sliceGuide.object);
    this.scene.fogNode = this.#sky.fog;
    this.#sky.set(skyAt(this.#hours, "north"));
    this.fly = new FlyCamera(this.camera, this.renderer.domElement);
    this.#observer = new ResizeObserver(() => this.#resize());
    const canvas = this.renderer.domElement;
    const signal = this.#abort.signal;
    canvas.addEventListener("mousedown", (e) => this.#onMouseDown(e), { signal });
    canvas.addEventListener("pointerdown", (e) => this.#onPointerDown(e), { signal });
    canvas.addEventListener("pointermove", (e) => this.#onPointerMove(e), { signal });
    canvas.addEventListener("pointerup", (e) => this.#onPointerUp(e), { signal });
    canvas.addEventListener("wheel", (e) => this.#onWheel(e), { signal, passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    document.addEventListener("keydown", (e) => this.#onKey(e), { signal });
    // One core for this thread, one for the world worker, the rest mesh.
    const meshWorkers = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
    this.world = new WorldClient(meshWorkers, (message) => this.#onWorld(message));
  }

  /** Starts the renderer. Resolves to null if the engine was disposed while it started. */
  async init(): Promise<Backend | null> {
    await this.renderer.init();
    this.renderer.setClearColor(0x15171b, 1);
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
    this.hotbar.clear();
    this.palettes.set([]);
    this.history.set({ undo: null, redo: null });
    this.projectName.set("");
    this.selection.set(EMPTY_SELECTION);
    this.#clearAnchor();
    this.#orbiting = false;
    this.#selectionOutline.show(new Float32Array(0));
    this.notice.set("");
    this.#target.show(null);
    const info = await this.world.request({ type: "load", world: id, source, chunkSize, theme });
    if (id !== this.#worldId || this.#disposed) return null;
    // The worker sends nothing about this world before its reply, so nothing was missed.
    const chunks = new ChunkRenderer(this.renderer, chunkSize);
    chunks.setBrightness(this.#brightness);
    chunks.setLighting(this.#lighting);
    this.#chunks = chunks;
    this.#info = info;
    this.scene.add(chunks.group);
    this.#grid.setOffset(info.grid);
    this.#updateSky();
    const fogFar = Math.max(500, info.extent * 1.4);
    this.#sky.setFogRange(fogFar * 0.35, fogFar);
    this.#initialMeshMs = null;
    this.#lastEditMs = null;
    this.home();
    const start = performance.now();
    void this.whenIdle().then(() => {
      if (this.#worldId !== id) return;
      this.#initialMeshMs = performance.now() - start;
      chunks.revealLight();
    });
    return info;
  }

  /** Undoes the latest step, if there is one. */
  undo(): void {
    void this.world.request({ type: "undo" });
  }

  /** Redoes the latest undone step, if there is one. */
  redo(): void {
    void this.world.request({ type: "redo" });
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
    // Every 3D pane starts on the same overview. Each one flies on its own after that.
    const pose = this.fly.capture();
    for (const view of this.#views.values()) {
      view.pose = pose;
      if (view.camera !== this.camera) applyPose(view.camera, pose);
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

  /**
   * The 3D panes to draw, each with its own camera and time of day. An empty list draws the
   * focused camera across the whole canvas (before the panes have been measured).
   */
  setFrames(frames: readonly ViewFrame[]): void {
    this.#framesSet = true;
    this.#viewFrames = [...frames];
    for (const frame of frames) this.#ensureView(frame.id);
    const focused = frames.find((frame) => frame.focused);
    if (focused) this.#switchFocus(focused.id);
    else if (this.fly.locked) this.fly.unlock();
  }

  /** Opens or closes the inventory, releasing the pointer so its controls can be used. */
  toggleInventory(): void {
    const open = !this.inventoryOpen.get();
    this.inventoryOpen.set(open);
    if (open) this.fly.unlock();
  }

  /**
   * Time of day in hours for the sky right now. Each 3D pane supplies its own when it draws;
   * this is the fallback before any pane is measured.
   */
  setTime(hours: number): void {
    this.#hours = hours;
    this.#updateSky(hours);
  }

  #updateSky(hours = this.#hours): void {
    const sky = skyAt(hours, this.#info?.north ?? "north");
    this.#sky.set(sky);
    this.#grid.setDaylight(sky.daylight);
    this.#chunks?.setDaylight(sky.daylight);
  }

  #ensureView(id: string): { camera: THREE.PerspectiveCamera; pose: FlyPose } {
    const existing = this.#views.get(id);
    if (existing) return existing;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
    const pose = this.fly.capture();
    applyPose(camera, pose);
    const view = { camera, pose };
    this.#views.set(id, view);
    return view;
  }

  #switchFocus(id: string): void {
    if (this.#focusedId === id && this.camera === this.#views.get(id)?.camera) return;
    if (this.#focusedId !== "") {
      const prev = this.#views.get(this.#focusedId);
      if (prev) prev.pose = this.fly.capture();
    }
    this.#focusedId = id;
    const next = this.#ensureView(id);
    this.camera = next.camera;
    this.fly.bind(next.camera);
    this.fly.restore(next.pose);
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
    this.#target.dispose();
    this.#selectionOutline.dispose();
    this.#sliceGuide.dispose();
    this.#grid.dispose();
    this.#chunks?.dispose();
    this.#sky.dispose();
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
    if (message.type === "palettes") {
      this.palettes.set(message.palettes);
      this.hotbar.update(message.palettes);
      return;
    }
    if (message.type === "history") {
      this.history.set({ undo: message.undo, redo: message.redo });
      this.projectName.set(message.name);
      this.#grid.setOffset(message.grid);
      return;
    }
    if (message.type === "selection") {
      this.selection.set(message.view);
      this.#setOrbit(message.view.bounds);
      // A pending first corner draws its own cell; the worker's empty selection must not clear it.
      if (this.#anchor === null) this.#showOutline(message.view.lines);
      return;
    }
    if (message.type === "looks") this.#looks = message.colors;
    if (message.type !== "idle") this.#revision++;
    const chunks = this.#chunks;
    if (!chunks) return;
    if (message.type === "looks") chunks.setLooks(message);
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
    this.#updateAim();
    this.#chunks?.update();
    this.#renderViews();
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
    this.#width = this.#host.clientWidth;
    this.#height = Math.max(this.#host.clientHeight, 1);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this.#width, this.#height, false);
    this.camera.aspect = this.#width / this.#height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Draws each 3D pane into its rectangle. One pane that fills the canvas takes the simple
   * path. Several panes clear once, then draw with a scissor, so a later pane does not wipe
   * an earlier one (a WebGPU clear ignores the scissor).
   */
  #renderViews(): void {
    const frames = this.#viewFrames.filter((frame) => frame.width >= 2 && frame.height >= 2);
    const only = frames[0];
    const full =
      frames.length === 1 &&
      only !== undefined &&
      only.x <= 1 &&
      only.y <= 1 &&
      only.width >= this.#width - 2 &&
      only.height >= this.#height - 2;
    if (!this.#framesSet || full) {
      this.renderer.autoClear = true;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.#width, this.#height);
      if (only) this.#updateSky(only.time);
      this.#showOverlays(only);
      this.#grid.follow(this.camera.position);
      this.camera.aspect = this.#width / this.#height;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (frames.length === 0) {
      this.renderer.autoClear = true;
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      return;
    }
    this.renderer.autoClear = false;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.#width, this.#height);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    for (const frame of frames) {
      const view = this.#views.get(frame.id);
      const cam = frame.focused ? this.camera : view?.camera;
      if (!cam) continue;
      cam.aspect = frame.width / frame.height;
      cam.updateProjectionMatrix();
      this.#updateSky(frame.time);
      this.#showOverlays(frame);
      this.#grid.follow(cam.position);
      this.renderer.setViewport(frame.x, frame.y, frame.width, frame.height);
      this.renderer.setScissor(frame.x, frame.y, frame.width, frame.height);
      this.renderer.render(this.scene, cam);
    }
    this.renderer.setScissorTest(false);
  }

  /** The pane's own choices of overlay. Before the panes are measured, everything shows. */
  #showOverlays(frame: ViewFrame | undefined): void {
    this.#grid.visible = frame?.grid ?? true;
    this.#sliceGuide.object.visible =
      (frame?.slice ?? true) && this.#sliceGuide.window !== null && this.#info !== null;
  }

  /**
   * Shows where a 2D view cuts the world, in the 3D panes that want it. `owner` is the 2D
   * view; only the active one should call this, and a later owner takes over.
   */
  setSliceGuide(owner: object, window: SliceWindow | null): void {
    this.#sliceOwner = window ? owner : null;
    this.#sliceGuide.show(window);
  }

  /** Drops the slice guide if `owner` still holds it (its 2D view closed or lost focus). */
  clearSliceGuide(owner: object): void {
    if (this.#sliceOwner !== owner) return;
    this.#sliceOwner = null;
    this.#sliceGuide.show(null);
  }

  /** Every 3D pane's camera, for the 2D view's markers. The focused one is flown. */
  viewCameras(): { readonly camera: THREE.PerspectiveCamera; readonly focused: boolean }[] {
    if (!this.#framesSet) return [{ camera: this.camera, focused: true }];
    const out: { camera: THREE.PerspectiveCamera; focused: boolean }[] = [];
    for (const frame of this.#viewFrames) {
      const camera = frame.focused ? this.camera : this.#views.get(frame.id)?.camera;
      if (camera) out.push({ camera, focused: frame.focused });
    }
    return out;
  }

  /** A 3D pane's heading: its camera's turn about the vertical (0 looks toward -z). */
  viewYaw(id: string): number | null {
    const frame = this.#viewFrames.find((f) => f.id === id);
    const camera = frame?.focused ? this.camera : this.#views.get(id)?.camera;
    if (!camera) return null;
    return yawOf(camera);
  }

  #frameAt(event: { clientX: number; clientY: number }): ViewFrame | null {
    const rect = this.#host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return (
      this.#viewFrames.find(
        (frame) =>
          x >= frame.x && y >= frame.y && x < frame.x + frame.width && y < frame.y + frame.height,
      ) ?? null
    );
  }

  /** The crosshair's ray. */
  #ray(): Ray {
    const p = this.camera.position;
    const d = this.fly.forward();
    return { origin: [p.x, p.y, p.z], dir: [d.x, d.y, d.z], reach: REACH };
  }

  /**
   * Keeps the outline on what the crosshair aims at while flying: asks the world worker
   * again whenever the camera or the world has moved on, one request at a time.
   */
  #updateAim(): void {
    if (!this.fly.locked || !this.#info || this.#autopilot) {
      this.#target.show(null);
      this.#aimedFor = "";
      return;
    }
    if (this.#aiming) return;
    const ray = this.#ray();
    const at = ray.origin.map((v) => v.toFixed(3)).join();
    const toward = ray.dir.map((v) => v.toFixed(4)).join();
    const key = `${at} ${toward} ${this.#revision}`;
    if (key === this.#aimedFor) return;
    this.#aiming = true;
    this.#aimedFor = key;
    const world = this.#worldId;
    const done = () => {
      this.#aiming = false;
    };
    void this.world.request({ type: "aim", ...ray }).then((aim) => {
      done();
      if (world === this.#worldId && this.fly.locked) this.#target.show(aim);
    }, done);
  }

  /** While flying: left click removes, right click places, middle click picks. */
  #onMouseDown(event: MouseEvent): void {
    if (this.#autopilot || !this.fly.locked) return;
    event.preventDefault();
    if (!this.#info) return;
    const ray = this.#ray();
    const tool = this.tool.get();
    if (event.button === 2 && (tool === "select" || tool === "wand")) {
      const shift = event.shiftKey;
      this.#enqueue(() =>
        tool === "select" ? this.#applySelect(ray) : this.#applyWand(ray, shift),
      );
      return;
    }
    if (event.button === 1) {
      void this.world.request({ type: "raycast", ...ray }).then((hit) => {
        if (!hit) return;
        const info = this.palettes
          .get()
          .flatMap((p) => p.semantics)
          .find((s) => s.ref === hit.semanticId);
        if (info) this.hotbar.pick(info);
      });
      return;
    }
    const start = performance.now();
    const timed = async (changed: boolean) => {
      if (!changed) return;
      await this.whenIdle();
      this.#lastEditMs = performance.now() - start;
    };
    if (event.button === 0) {
      void this.world.request({ type: "erase", ...ray }).then(timed);
    } else if (event.button === 2) {
      const semantic = this.hotbar.current?.ref;
      if (semantic === undefined) return;
      void this.world.request({ type: "place", semantic, ...ray }).then(timed);
    }
  }

  /** With a free cursor: drag the view to turn the camera, click it to fly. */
  #onPointerDown(event: PointerEvent): void {
    if (this.fly.locked || this.#autopilot || event.button !== 0) return;
    const frame = this.#frameAt(event);
    if (frame && !frame.focused) {
      this.#switchFocus(frame.id);
      this.onFocusView?.(frame.id);
    }
    this.#drag = { x: event.clientX, y: event.clientY, moved: false };
    this.renderer.domElement.setPointerCapture(event.pointerId);
  }

  #onPointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || this.fly.locked) return;
    const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    if (!drag.moved && distance < CLICK_SLOP) return;
    drag.moved = true;
    if (this.#orbiting) this.fly.orbit(this.#orbitTarget, event.movementX, event.movementY);
    else this.fly.drag(event.movementX, event.movementY);
  }

  #onPointerUp(event: PointerEvent): void {
    const drag = this.#drag;
    this.#drag = null;
    if (drag && event.button === 0 && !drag.moved) this.fly.lock();
  }

  /** The wheel: hotbar slots while flying, forward and back with a free cursor. */
  #onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (this.#autopilot) return;
    const frame = this.#frameAt(event);
    if (frame && !frame.focused && !this.fly.locked) {
      this.#switchFocus(frame.id);
      this.onFocusView?.(frame.id);
    }
    if (!this.fly.locked) {
      this.fly.dolly(-event.deltaY * DOLLY_PER_WHEEL * (this.fly.speed / 15));
      return;
    }
    this.#wheel += wheelPixels(event);
    while (Math.abs(this.#wheel) >= WHEEL_PER_SLOT) {
      const step = Math.sign(this.#wheel);
      this.hotbar.cycle(step);
      this.#wheel -= step * WHEEL_PER_SLOT;
    }
  }

  /** Hotbar slots (1-9, numpad too), undo and redo, wherever the cursor is. */
  #onKey(event: KeyboardEvent): void {
    if (event.code === "Escape" && this.inventoryOpen.get()) {
      event.preventDefault();
      this.inventoryOpen.set(false);
      return;
    }
    if (isTyping(event.target)) return;
    // E, or Delete for the right hand, as in the Godot app.
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plain && (event.code === "KeyE" || event.code === "Delete")) {
      event.preventDefault();
      this.toggleInventory();
      return;
    }
    // Backspace empties the selection, only while a selection tool is in hand, so a
    // selection left behind never takes the key from Build.
    const tool = this.tool.get();
    if (
      plain &&
      event.code === "Backspace" &&
      (tool === "select" || tool === "wand") &&
      this.selection.get().cells > 0
    ) {
      event.preventDefault();
      this.clearSelection();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && (event.code === "KeyZ" || event.code === "KeyY")) {
      event.preventDefault();
      if (event.code === "KeyY" || event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    const slot = HOTBAR_KEYS.exec(event.code);
    if (!slot) return;
    // Right Ctrl and right Alt fly up, so a slot key may come with them while flying; keep
    // the browser from taking Ctrl+digit as a tab switch then.
    if (ctrl && !this.fly.locked) return;
    if (ctrl) event.preventDefault();
    this.hotbar.select(Number(slot[1]) - 1);
  }

  /** Switches the fly tool. A half-chosen box corner is dropped. */
  setTool(tool: EditorTool): void {
    this.tool.set(tool);
    rememberTool(tool);
    this.#clearAnchor();
    // The outline is part of the selection tools. The selection itself stays, for actions.
    this.#showOutline(this.selection.get().lines);
  }

  /**
   * Grows the selection `steps` cells. With `corners`, every direction including diagonals,
   * so a box stays a box. Without, through faces only.
   */
  growSelection(steps: number, corners: boolean): void {
    const n = clampSteps(steps);
    void this.#select(
      corners
        ? { grow: n, of: { selection: true }, corners: true }
        : { grow: n, of: { selection: true } },
    );
  }

  /** Shrinks the selection `steps` cells through every face. */
  shrinkSelection(steps: number): void {
    const n = clampSteps(steps);
    void this.#select({ shrink: n, of: { selection: true } });
  }

  /** Moves one face of a box selection. */
  nudgeSelection(axis: 0 | 1 | 2, maxSide: boolean, delta: number): void {
    const view = this.selection.get();
    if (!view.box || !view.bounds) return;
    void this.#select({ box: nudgedBox(view.bounds, axis, maxSide, delta) });
  }

  /** Fills the selection with the chosen hotbar semantic. */
  fillSelection(): void {
    const semantic = this.hotbar.current?.ref;
    if (semantic === undefined) return;
    void this.#run(this.world.request({ type: "fillSelection", semantic, look: this.#look() }));
  }

  /** Empties the selection. */
  clearSelection(): void {
    void this.#run(this.world.request({ type: "clearSelection" }));
  }

  /** Turns occupied cells into whole blocks of the chosen hotbar semantic. */
  replaceSelection(): void {
    const semantic = this.hotbar.current?.ref;
    if (semantic === undefined) return;
    void this.#run(this.world.request({ type: "replaceSelection", semantic, look: this.#look() }));
  }

  /** Switches one semantic for another inside the selection, keeping geometry. */
  resemanticSelection(from: SemanticArg, to: SemanticArg): void {
    void this.#run(this.world.request({ type: "resemanticSelection", from, to }), (result) =>
      result.skipped > 0 ? `Skipped ${grouped(result.skipped)} that don't fit the new shape` : "",
    );
  }

  /** Drops the selection and any half-chosen corner. */
  deselect(): void {
    this.#dropAnchor();
    if (this.selection.get().cells > 0) void this.#select(null);
  }

  #enqueue(work: () => Promise<void>): void {
    this.#clicks = this.#clicks.then(work, work);
  }

  async #applySelect(ray: Ray): Promise<void> {
    if (this.tool.get() !== "select") return;
    const aimed = await this.world.request({ type: "aim", ...ray });
    if (this.tool.get() !== "select") return;
    const cell = aimed?.hit ?? aimed?.place ?? null;
    const selected = this.selection.get().cells > 0;
    if (selected && this.#anchor === null) {
      await this.#select(null);
      return;
    }
    if (!cell) {
      if (selected) await this.#select(null);
      return;
    }
    if (!this.#anchor) {
      this.#anchor = cell;
      this.anchor.set(cell);
      this.#showOutline(boxLines(cellBox(cell)));
      return;
    }
    const first = this.#anchor;
    this.#dropAnchor();
    const where: Region = { box: [first[0], first[1], first[2], cell[0], cell[1], cell[2]] };
    await this.#select(where, boxLines(boxOf(where.box)));
  }

  async #applyWand(ray: Ray, shift: boolean): Promise<void> {
    if (this.tool.get() !== "wand") return;
    const hit = await this.world.request({ type: "raycast", ...ray });
    if (this.tool.get() !== "wand" || !hit) return;
    this.#dropAnchor();
    const seed: [number, number, number] = [hit.cell[0], hit.cell[1], hit.cell[2]];
    const where: Region = shift
      ? { structure: { seed } }
      : { structure: { seed, semantics: [hit.semanticId] } };
    await this.#select(where);
  }

  /** Runs a select. `preview` is drawn at once; a failure puts the previous outline back. */
  async #select(where: Region | null, preview?: Float32Array): Promise<void> {
    const previous = this.selection.get().lines;
    if (preview) this.#showOutline(preview);
    else if (where === null) this.#showOutline(new Float32Array(0));
    try {
      await this.world.request({ type: "select", where });
      this.notice.set("");
    } catch (error) {
      this.notice.set(error instanceof Error ? error.message : String(error));
      if (this.#anchor === null) this.#showOutline(previous);
    }
  }

  async #run<T>(work: Promise<T>, note: (value: T) => string = () => ""): Promise<void> {
    try {
      this.notice.set(note(await work));
    } catch (error) {
      this.notice.set(error instanceof Error ? error.message : String(error));
    }
  }

  #dropAnchor(): void {
    if (this.#anchor === null) return;
    this.#anchor = null;
    this.anchor.set(null);
    this.#showOutline(this.selection.get().lines);
  }

  /** The selection outline while a selection tool is on, and nothing while Build is. */
  #showOutline(lines: Float32Array): void {
    const tool = this.tool.get();
    this.#selectionOutline.show(tool === "select" || tool === "wand" ? lines : new Float32Array(0));
  }

  #setOrbit(bounds: SelectionView["bounds"]): void {
    if (!bounds) {
      this.#orbiting = false;
      return;
    }
    const [x0, y0, z0, x1, y1, z1] = bounds;
    this.#orbitTarget.set((x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2, (z0 + z1 + 1) / 2);
    this.#orbiting = true;
  }

  #look(): Vec3 {
    const dir = this.fly.forward();
    return [dir.x, dir.y, dir.z];
  }

  #clearAnchor(): void {
    this.#anchor = null;
    this.anchor.set(null);
  }
}

function cellBox(cell: Vec3): {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
} {
  return { x0: cell[0], y0: cell[1], z0: cell[2], x1: cell[0], y1: cell[1], z1: cell[2] };
}

const EULER = new THREE.Euler();

/** A camera's turn about the vertical, as FlyCamera's yaw. */
export function yawOf(camera: THREE.Camera): number {
  return EULER.setFromQuaternion(camera.quaternion, "YXZ").y;
}

function clampSteps(steps: number): number {
  return Math.max(1, Math.min(64, Math.floor(steps)));
}

/** True for keys typed into a text field or menu, which the editor leaves alone. */
/** A notch in pixels. Line and page modes report notches, not pixels. */
function wheelPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * WHEEL_PER_SLOT;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * WHEEL_PER_SLOT;
  return event.deltaY;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function sortedWindow(values: Float64Array, count: number): number[] {
  return Array.from(values.subarray(0, count)).sort((a, b) => a - b);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}
