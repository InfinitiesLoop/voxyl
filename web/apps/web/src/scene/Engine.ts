import { boxOf, type Direction, type Region, type SemanticArg } from "@voxyl/core";
import type { CellBox as HiddenBox, LightingMode } from "@voxyl/session";
import { shapeName } from "@voxyl/shapes";
import * as THREE from "three/webgpu";
import { bearingOf } from "../editor/compass.ts";
import { grouped, nudgedBox } from "../editor/counts.ts";
import { Hotbar } from "../editor/hotbar.ts";
import { codesOf, isKey } from "../editor/keymap.ts";
import { boxLines } from "../editor/outline.ts";
import { Store } from "../editor/store.ts";
import {
  cycleTool,
  type EditorTool,
  isBuildTool,
  readBrush,
  readTool,
  rememberBrush,
  rememberTool,
} from "../editor/tool.ts";
import { orbitDegrees, type ViewSettings } from "../editor/view-options.ts";
import type { PasteArgs } from "../world/clipboard.ts";
import type { HistoryState, PaletteInfo } from "../world/editing.ts";
import {
  type ClipboardInfo,
  EMPTY_SELECTION,
  type PartArgs,
  type PartDraw,
  type Ray,
  type SchematicSource,
  type SelectionView,
  type ToolArgs,
  type Vec3,
  type WorldStats,
} from "../world/protocol.ts";
import { WorldClient, type WorldOutput } from "../world/WorldClient.ts";
import type { WorldInfo, WorldSource } from "../worlds.ts";
import { BoxFrame } from "./box-frame.ts";
import { ChunkRenderer, type ChunkRendererStats, usesEdges } from "./ChunkRenderer.ts";
import { CellBoxes } from "./cell-boxes.ts";
import { applyPose, FlyCamera, type FlyPose } from "./FlyCamera.ts";
import {
  type CellBox,
  centreOf,
  ELEVATIONS,
  framePose,
  orbitStep,
  orthoHalfHeight,
} from "./framing.ts";
import { GroundGrid } from "./ground-grid.ts";
import { LightVolume } from "./light-volume.ts";
import { PartOutline } from "./part-outline.ts";
import { PasteGhostView } from "./paste-ghost.ts";
import { PlaceGrid } from "./place-grid.ts";
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
  /** Render mode, shading, projection, background and orbit. */
  readonly view: ViewSettings;
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
  /** Build to me's square and Exchange's reach: 1 is one block, 3 a 3×3. Remembered. */
  readonly brush = new Store<number>(readBrush());
  /**
   * Places a shaped part on the far side of the cell (the inventory's Far side toggle). Held
   * keys and the mouse thumb buttons flip it for as long as they are down.
   */
  readonly farSide = new Store(false);
  /** Keys held down, and the mouse thumb buttons, for the far-side modifier. */
  readonly #held = new Set<string>();
  #thumb = false;
  /** Shift+right-click with Select takes touching blocks of any kind, not only the one clicked. */
  readonly connectAny = new Store(false);
  /** The project's selection, for the panel and the outline. */
  readonly selection = new Store<SelectionView>(EMPTY_SELECTION);
  /** The first corner of a box, before the second click completes it. */
  readonly anchor = new Store<Vec3 | null>(null);
  /** A command the selection panel should say failed, or "". */
  readonly notice = new Store("");
  /** Which of the project's directions is the real north (a setting; changes undo). */
  readonly north = new Store<Direction>("north");
  /** A box of cells hidden in every 3D view (a cutaway), and whether it is switched on. */
  readonly cutaway = new Store<{ readonly box: HiddenBox | null; readonly on: boolean }>({
    box: null,
    on: true,
  });
  /** Show only the selection in the 3D views. */
  readonly isolate = new Store(false);
  /** The cutaway's bounds panel is open, and its box is outlined in the views. */
  readonly cutPanel = new Store(false);
  /** What the clipboard holds (kept in the world worker, across projects), or null. */
  readonly clipboard = new Store<ClipboardInfo | null>(null);
  /** How the Paste tool sets the clipboard down: turn, mirror, air, and a shift. */
  readonly paste = new Store<PasteArgs>({ turn: 0, mirror: false, offset: [0, 0, 0], air: false });
  /** The cell a locked paste is pinned to (left click toggles it), or null while it follows. */
  readonly pasteLock = new Store<Vec3 | null>(null);
  /** The pointer is locked to the view (flying), for the paste panel to tell its two modes. */
  readonly flying = new Store(false);
  /** Counts changes to the prefab list, so every list showing it asks again. */
  readonly prefabsRev = new Store(0);
  /** Asks the screen to open the "Save as a prefab" dialog (Ctrl+P, or Actions). */
  readonly prefabDialog = new Store(false);
  /** The schematic export dialog: what it is cut from, or null while closed. */
  readonly schematicDialog = new Store<SchematicSource | null>(null);
  /** A short line over the hotbar for anything the editor refuses or reports; it fades. */
  readonly toast = new Store<{ readonly text: string; readonly id: number } | null>(null);
  #toastId = 0;
  /** The inventory overlay. E toggles it; opening releases the pointer. */
  readonly inventoryOpen = new Store(false);
  /** A palette the inventory should show when it opens (the palette list's Open), once. */
  readonly inventoryFocus = new Store<number | null>(null);
  /** Closing the inventory locks the pointer again when it was open in fly mode. */
  #resumeFly = false;
  /** Set while something (Home) covers every view: frames are skipped. */
  paused = false;
  /** Called when a click chooses a different 3D pane, so the chrome can follow. */
  onFocusView: ((id: string) => void) | null = null;
  readonly #views = new Map<string, ViewCamera>();
  /** The sky's fog, near and far, for the world on screen. */
  #fogRange: [number, number] = [175, 500];
  /** Whether meshes carry feature edges (some pane draws lines). */
  #edgesOn = false;
  /** The project's bounds (cell corners), for presets and orbiting; asked for as needed. */
  #bounds: CellBox | null = null;
  #boundsAt = 0;
  /** The focused view's flying speed, for the Camera menu. */
  readonly speed = new Store(15);
  /** Called when flying or dragging a pane stops its orbit, so the layout can say so. */
  onOrbitStop: ((id: string) => void) | null = null;
  #viewFrames: ViewFrame[] = [];
  /** False until the panes have reported their rectangles, so the first frames fill the canvas. */
  #framesSet = false;
  #focusedId = "";
  #width = 1;
  #height = 1;
  readonly #target = new TargetOutline();
  /** What a multi-block tool would build where the crosshair aims. */
  readonly #toolPreview = new CellBoxes(0x8be9ff);
  /** The part the crosshair is on, in a cell of parts. */
  readonly #aimedPart = new PartOutline(0x111111, { overlay: false, opacity: 0.8 });
  /** The part a click would place, drawn over everything. */
  readonly #ghost = new PartOutline(0x8be9ff, { overlay: true });
  /** The placement zones of the shaped part in hand, drawn across the aimed face. */
  readonly #placeGrid = new PlaceGrid();
  /** The clipboard as it would land where the Paste tool aims. */
  readonly #pasteGhost = new PasteGhostView();
  /** The cutaway's box, outlined while its bounds panel is open. */
  readonly #cutFrame = new BoxFrame(0xfb923c);
  readonly #selectionOutline = new SelectionOutline();
  readonly #grid = new GroundGrid();
  readonly #sliceGuide = new SliceGuide();
  /** Which 2D view the slice guide belongs to. */
  #sliceOwner: object | null = null;
  /** What every 2D view shows, so each can draw where the others cut it. */
  readonly #flatSlices = new Map<object, SliceWindow>();
  #flatRevision = 0;
  /** A request for the 2D view to slice through a cell (Tab while flying, or 3D aim). */
  readonly sliceRequest = new Store<SliceRequest | null>(null);
  #anchor: Vec3 | null = null;
  /** Where a free-cursor drag orbits, when a selection has a box around it. */
  readonly #orbitTarget = new THREE.Vector3();
  #orbiting = false;
  /** Select and wand clicks, so a second corner waits for the first to be recorded. */
  #clicks: Promise<unknown> = Promise.resolve();
  /** An aim request in flight, and the camera pose and world revision last aimed for. */
  #aiming = false;
  #aimedFor = "";
  /** The cell the Paste tool last aimed at: where a paste freezes when the cursor is freed. */
  #lastPasteAt: Vec3 | null = null;
  #pasteFrozenFor = "";
  #pasteFrozenBusy = false;
  /** The tool Esc goes back to when a paste is cancelled. */
  #toolBeforePaste: EditorTool = "build";
  /** The pointer was freed on purpose for the paste panel (so it is not an Esc). */
  #openingAdjust = false;
  /** The panel is up with a free cursor, and the pointer was locked before. */
  #adjusting = false;
  #wasFlying = false;
  /** A drag of the view with a free cursor. */
  #drag: { x: number; y: number; moved: boolean } | null = null;
  #wheel = 0;
  /** StateLooks.colors for the world on screen. */
  #looks: Uint8Array = new Uint8Array(0);
  #facing: Uint8Array = new Uint8Array(0);
  #partDraws = new Map<number, readonly PartDraw[]>();
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
    this.scene.add(this.#toolPreview.object);
    this.scene.add(this.#aimedPart.object);
    this.scene.add(this.#ghost.object);
    this.scene.add(this.#placeGrid.object);
    this.scene.add(this.#pasteGhost.object);
    this.scene.add(this.#cutFrame.object);
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
    document.addEventListener("keydown", (e) => this.#held.add(e.code), { signal });
    document.addEventListener("keyup", (e) => this.#held.delete(e.code), { signal });
    window.addEventListener("blur", () => this.#clearHeld(), { signal });
    document.addEventListener("pointerlockchange", () => this.#onLockChange(), { signal });
    canvas.addEventListener("mouseup", (e) => this.#onMouseUp(e), { signal });
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
    this.#bounds = null;
    this.#boundsAt = 0;
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
    this.north.set(info.north);
    // A new world starts with nothing hidden (its session is new).
    this.cutaway.set({ box: null, on: true });
    this.isolate.set(false);
    this.cutPanel.set(false);
    this.#cutFrame.show(null);
    void this.syncClipboard();
    this.scene.add(chunks.group);
    this.#grid.setOffset(info.grid);
    this.#updateSky();
    const fogFar = Math.max(500, info.extent * 1.4);
    this.#fogRange = [fogFar * 0.35, fogFar];
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

  /** Closes the world on screen (its project was deleted): nothing is drawn until a load. */
  unload(): void {
    this.#worldId++;
    if (this.#chunks) {
      this.scene.remove(this.#chunks.group);
      this.#chunks.dispose();
    }
    this.#chunks = null;
    this.#info = null;
    this.palettes.set([]);
    this.hotbar.clear();
    this.selection.set(EMPTY_SELECTION);
  }

  /** Undoes the latest step, if there is one. */
  undo(): void {
    void this.world.request({ type: "undo" });
  }

  /** Redoes the latest undone step, if there is one. */
  redo(): void {
    void this.world.request({ type: "redo" });
  }

  /** The parts of each cell state that has any, for the 2D view's footprints. */
  get partDraws(): ReadonlyMap<number, readonly PartDraw[]> {
    return this.#partDraws;
  }

  /** Per state, which way it faces (flat-edit.ts stateFacings), for the 2D view's arrows. */
  get facing(): Uint8Array {
    return this.#facing;
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
    const edges = frames.some((frame) => usesEdges(frame.view.mode));
    if (edges !== this.#edgesOn) {
      this.#edgesOn = edges;
      void this.world.request({ type: "edges", on: edges });
    }
    for (const frame of frames) this.#ensureView(frame.id);
    const focused = frames.find((frame) => frame.focused);
    if (focused) this.#switchFocus(focused.id);
    else if (this.fly.locked) this.fly.unlock();
  }

  /**
   * Opens or closes the inventory. Opening releases the pointer so its controls can be
   * used. Closing locks it again when the inventory interrupted fly mode.
   */
  showPaletteInInventory(palette: number): void {
    this.inventoryFocus.set(palette);
    if (!this.inventoryOpen.get()) this.toggleInventory();
  }

  toggleInventory(): void {
    this.#setInventory(!this.inventoryOpen.get());
  }

  #setInventory(open: boolean, resumeOnKeyUp = false): void {
    if (open === this.inventoryOpen.get()) return;
    if (open) {
      this.#resumeFly = this.fly.locked;
      this.inventoryOpen.set(true);
      this.fly.unlock();
      return;
    }
    this.inventoryOpen.set(false);
    if (!this.#resumeFly) return;
    this.#resumeFly = false;
    if (!resumeOnKeyUp) {
      this.fly.lock();
      return;
    }
    const lock = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      document.removeEventListener("keyup", lock, true);
      this.fly.lock();
    };
    document.addEventListener("keyup", lock, true);
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

  #ensureView(id: string): ViewCamera {
    const existing = this.#views.get(id);
    if (existing) return existing;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
    const pose = this.fly.capture();
    applyPose(camera, pose);
    // Orthographic sees the same way from the same place; near is far behind it, so what is
    // behind the camera still shows, as a drawing would.
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -ORTHO_DEPTH, ORTHO_DEPTH);
    const view: ViewCamera = { camera, pose, ortho, orthoHalf: null };
    this.#views.set(id, view);
    return view;
  }

  /** The camera a pane draws with: its own, or its orthographic twin. */
  #cameraFor(frame: ViewFrame | undefined, aspect: number): THREE.Camera {
    const view = frame ? this.#views.get(frame.id) : undefined;
    const cam = frame && !frame.focused && view ? view.camera : this.camera;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    if (!view || frame?.view.projection !== "orthographic") {
      this.#sky.mesh.scale.setScalar(1);
      return cam;
    }
    if (view.orthoHalf === null) view.orthoHalf = this.#orthoHalfFor(cam);
    const half = view.orthoHalf;
    const ortho = view.ortho;
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.updateProjectionMatrix();
    ortho.position.copy(cam.position);
    ortho.quaternion.copy(cam.quaternion);
    ortho.updateMatrixWorld();
    // The sky is a sphere about the eye; seen without perspective it must be big enough to
    // fill the view (its colour still comes from the direction, so it reads as a gradient).
    this.#sky.mesh.scale.setScalar(Math.max(half * aspect, half) * 1.5);
    return ortho;
  }

  /** An orthographic size that shows about what the perspective camera shows at the build. */
  #orthoHalfFor(cam: THREE.PerspectiveCamera): number {
    const centre = this.#bounds ? centreOf(this.#bounds) : this.#info?.center;
    const distance = centre
      ? cam.position.distanceTo(new THREE.Vector3(centre[0], centre[1], centre[2]))
      : 40;
    return Math.max(2, distance * Math.tan((cam.fov * Math.PI) / 360));
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
    this.#toolPreview.dispose();
    this.#aimedPart.dispose();
    this.#ghost.dispose();
    this.#placeGrid.dispose();
    this.#pasteGhost.dispose();
    this.#cutFrame.dispose();
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
      if (this.#info && this.#info.north !== message.north) {
        this.#info = { ...this.#info, north: message.north };
      }
      this.north.set(message.north);
      return;
    }
    if (message.type === "selection") {
      this.selection.set(message.view);
      // Isolation is of a selection: with none left there is nothing to isolate.
      if (message.view.cells === 0 && this.isolate.get()) this.setIsolate(false);
      this.#setOrbit(message.view.bounds);
      // A pending first corner draws its own cell; the worker's empty selection must not clear it.
      if (this.#anchor === null) this.#showOutline(message.view.lines);
      return;
    }
    if (message.type === "looks") {
      this.#looks = message.colors;
      this.#facing = message.facing;
      this.#partDraws = new Map(message.partDraws.map((d) => [d.state, d.parts]));
    }
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
    // Home covers the view: draw nothing until it closes.
    if (this.paused) {
      this.#lastTime = -1;
      return;
    }
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
      this.#tickOrbits(Math.min(dt, 0.1));
    }
    if (this.speed.get() !== this.fly.speed) this.speed.set(this.fly.speed);
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
      this.renderer.render(this.scene, this.#cameraFor(only, this.#width / this.#height));
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
      const cam = this.#cameraFor(frame, frame.width / frame.height);
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
    const plain = frame?.view.background === "plain";
    this.#grid.visible = (frame?.grid ?? true) && !plain;
    this.#sky.mesh.visible = !plain;
    // A plain backdrop has no sky for faraway blocks to fade into.
    if (plain) this.#sky.setFogRange(1e7, 2e7);
    else this.#sky.setFogRange(this.#fogRange[0], this.#fogRange[1]);
    if (frame) this.#chunks?.setView(frame.view.mode, frame.view.shading);
    else this.#chunks?.setView("textured", "app");
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

  /** Records what a 2D view shows (null when it closes), for the other 2D views' guides. */
  setFlatSlice(owner: object, window: SliceWindow | null): void {
    if (window) this.#flatSlices.set(owner, window);
    else if (!this.#flatSlices.delete(owner)) return;
    this.#flatRevision++;
  }

  /** What the other 2D views show. */
  flatSlices(except: object): SliceWindow[] {
    return [...this.#flatSlices].filter(([owner]) => owner !== except).map(([, w]) => w);
  }

  /** Grows when a 2D view's slice changes. */
  get flatRevision(): number {
    return this.#flatRevision;
  }

  /**
   * Asks the 2D view to slice through the cell the focused 3D view aims at (the crosshair,
   * or the middle of the view when not flying). `turn`: also step to the next slice axis.
   */
  async sliceAtAim(turn: boolean): Promise<void> {
    if (!this.#info) return;
    const aimed = await this.world.request({ type: "aim", ...this.#ray() });
    const cell = aimed?.hit ?? aimed?.place ?? null;
    if (!cell) return;
    const n = (this.sliceRequest.get()?.n ?? 0) + 1;
    this.sliceRequest.set({ cell, turn, n });
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
      this.#toolPreview.show(null);
      this.#aimedPart.show(null);
      this.#ghost.show(null);
      this.#placeGrid.show(null);
      this.#aimedFor = "";
      this.#updateFrozenPaste();
      return;
    }
    if (this.#aiming) return;
    const ray = this.#ray();
    const tool = this.#toolArgs();
    const at = ray.origin.map((v) => v.toFixed(3)).join();
    const toward = ray.dir.map((v) => v.toFixed(4)).join();
    const using = tool ? `${tool.tool}${tool.brush}` : "";
    const part = this.#partArgs();
    const paste =
      this.tool.get() === "paste" && this.clipboard.get()
        ? this.#pasteArgs(this.pasteLock.get())
        : null;
    const key = `${at} ${toward} ${this.#revision} ${using} ${part ? `${JSON.stringify(part.semantic)}${part.opposite}` : ""} ${paste ? JSON.stringify(paste) + this.#clipboardRev : ""}`;
    if (key === this.#aimedFor) return;
    this.#aiming = true;
    this.#aimedFor = key;
    const world = this.#worldId;
    const done = () => {
      this.#aiming = false;
    };
    void this.world
      .request({
        type: "aim",
        ...ray,
        ...(tool && { tool }),
        ...(part && { part }),
        ...(paste && { paste }),
      })
      .then((aim) => {
        done();
        if (world !== this.#worldId || !this.fly.locked) return;
        // In a cell of parts the outline hugs the part met, not the whole cell.
        const met = aim?.aimed && aim.hit ? aim : null;
        this.#target.show(met ? null : aim);
        this.#aimedPart.show(met?.hit ?? null, met?.aimed?.shape, met?.aimed?.slot);
        this.#toolPreview.show(aim?.preview ?? null);
        this.#pasteGhost.show(aim?.pasteGhost ?? null);
        if (paste && aim?.place) this.#lastPasteAt = aim.place;
        const ghost = this.tool.get() === "build" ? (aim?.ghost ?? null) : null;
        this.#ghost.show(ghost?.cell ?? null, ghost?.shape, ghost?.slot);
        this.#placeGrid.show(this.tool.get() === "build" ? (aim?.grid ?? null) : null);
      }, done);
  }

  /** Shows a line over the hotbar for a few seconds. */
  say(text: string): void {
    const id = ++this.#toastId;
    this.toast.set({ text, id });
    setTimeout(() => {
      if (this.#toastId === id) this.toast.set(null);
    }, 4000);
  }

  /**
   * The tools that build whole blocks (Build to me, the Wand, Exchange, 2D drawing) refuse a
   * shaped semantic and say so, rather than put a full cube where a cover was meant.
   */
  refuseShaped(): boolean {
    const current = this.hotbar.current;
    if (!current?.shape) return false;
    this.say(
      `${current.name} places a ${shapeName(current.shape).toLowerCase()}, one part at a time. Use Build in a 3D view; this tool builds whole blocks.`,
    );
    return true;
  }

  /** Whether a shaped part goes on the far side: the toggle, flipped by a held key or button. */
  get opposite(): boolean {
    const held = this.#thumb || codesOf("placeOpposite").some((code) => this.#held.has(code));
    return this.farSide.get() !== held;
  }

  /** Flips the Far side toggle (the inventory's button). */
  setFarSide(on: boolean): void {
    this.farSide.set(on);
    this.#aimedFor = ""; // the ghost moves
  }

  #clearHeld(): void {
    this.#held.clear();
    this.#thumb = false;
  }

  /** The semantic in hand and the far-side modifier, for the aim's ghost; null in other tools. */
  #partArgs(): PartArgs | null {
    const current = this.hotbar.current;
    if (!current || this.tool.get() !== "build") return null;
    return { semantic: current.ref, opposite: this.opposite };
  }

  /** The multi-block tool in hand, for an aim's preview or a click, or null. */
  #toolArgs(): ToolArgs | null {
    const tool = this.tool.get();
    if (!isBuildTool(tool) || this.hotbar.current === null) return null;
    const p = this.camera.position;
    return { tool, brush: this.brush.get(), camera: [p.x, p.y, p.z] };
  }

  /** While flying: left click removes, right click places, middle click picks. */
  #onMouseDown(event: MouseEvent): void {
    if (this.#autopilot || !this.fly.locked) return;
    event.preventDefault();
    // A click while Ctrl is held makes Ctrl a modifier, so letting go does not sprint.
    this.fly.cancelTap();
    if (event.button >= 3) {
      this.#thumb = true; // the thumb buttons place on the far side while held
      this.#aimedFor = "";
      return;
    }
    if (!this.#info) return;
    const ray = this.#ray();
    const tool = this.tool.get();
    if (event.button === 2 && tool === "select") {
      const shift = event.shiftKey;
      this.#enqueue(() => (shift ? this.#applyConnected(ray) : this.#applySelect(ray)));
      return;
    }
    if (event.button === 1 && tool === "paste") {
      this.openPasteAdjust();
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
    if (event.button === 0 && tool === "paste") {
      this.togglePasteLock();
    } else if (event.button === 0) {
      void this.world.request({ type: "erase", ...ray }).then(timed);
    } else if (event.button === 2 && tool === "paste") {
      void this.placePaste().then(timed);
    } else if (event.button === 2) {
      const semantic = this.hotbar.current?.ref;
      if (semantic === undefined) return;
      const args = this.#toolArgs();
      if (args && this.refuseShaped()) return;
      if (args)
        void this.world.request({ type: "toolEdit", semantic, ...args, ...ray }).then(timed);
      else
        void this.world
          .request({ type: "place", semantic, opposite: this.opposite, ...ray })
          .then(timed);
    }
  }

  #onMouseUp(event: MouseEvent): void {
    if (event.button < 3) return;
    this.#thumb = false;
    this.#aimedFor = "";
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
    if (!drag.moved) this.#stopOrbit(this.#focusedId);
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
      const focused = this.#viewFrames.find((f) => f.focused);
      const view = focused ? this.#views.get(focused.id) : undefined;
      if (focused?.view.projection === "orthographic" && view?.orthoHalf) {
        view.orthoHalf = Math.max(
          1,
          Math.min(4000, view.orthoHalf * Math.exp(event.deltaY * 0.0012)),
        );
        return;
      }
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
      // Escape is the gesture that leaves pointer lock, and a lock requested in that
      // keydown is refused. Ask again when the key is released.
      this.#setInventory(false, true);
      return;
    }
    if (isTyping(event.target)) return;
    if (
      event.code === "Escape" &&
      !event.repeat &&
      this.tool.get() === "paste" &&
      !this.inventoryOpen.get()
    ) {
      // Esc stops pasting. While flying the browser frees the pointer on this same press, so
      // it is taken back when the key is released.
      event.preventDefault();
      const flying = this.fly.locked || this.#adjusting;
      this.cancelPaste();
      if (flying) this.#lockOnEscapeUp();
      return;
    }
    // The keys are in editor/keymap.ts. Right Ctrl and right Alt fly up, so while flying
    // they may be held with any of these.
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const flying = this.fly.locked;
    if ((plain || flying) && !event.repeat) {
      if (isKey("inventory", event.code)) {
        event.preventDefault();
        this.toggleInventory();
        return;
      }
      if (isKey("nextTool", event.code)) {
        event.preventDefault();
        this.setTool(cycleTool(this.tool.get(), event.shiftKey ? -1 : 1));
        return;
      }
      if (isKey("toggleCutaway", event.code)) {
        event.preventDefault();
        this.toggleCutaway();
        return;
      }
      if (isKey("rotateBlock", event.code) && this.tool.get() === "paste") {
        event.preventDefault();
        this.turnPaste(event.shiftKey ? -1 : 1);
        return;
      }
      if (isKey("mirrorPaste", event.code) && this.tool.get() === "paste") {
        event.preventDefault();
        this.mirrorPaste();
        return;
      }
      if (isKey("rotateBlock", event.code) && flying) {
        event.preventDefault();
        this.rotateAimed(event.shiftKey);
        return;
      }
    }
    if (flying && isKey("sliceHere", event.code) && !event.repeat) {
      event.preventDefault();
      void this.sliceAtAim(event.shiftKey);
      return;
    }
    // Backspace empties the selection, only while Select is in hand, so a selection left
    // behind never takes the key from building.
    if (
      plain &&
      isKey("clearSelection", event.code) &&
      this.tool.get() === "select" &&
      this.selection.get().cells > 0
    ) {
      event.preventDefault();
      this.clearSelection();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.altKey && !event.repeat && this.#info) {
      if (event.code === "KeyC" || event.code === "KeyX") {
        event.preventDefault();
        void this.copySelection(event.code === "KeyX");
        return;
      }
      if (event.code === "KeyV") {
        event.preventDefault();
        this.takePaste();
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        if (this.selection.get().cells > 0) this.prefabDialog.set(true);
        else this.say("Select something first, then Ctrl+P saves it as a prefab.");
        return;
      }
    }
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

  /**
   * Puts a pane's camera on a preset: the overview, a compass side, from above, iso, or
   * around the selection. Frames the whole build (or the selection) so it fits the pane.
   */
  async frameView(id: string, preset: CameraPreset): Promise<void> {
    const frame = this.#viewFrames.find((f) => f.id === id);
    if (!frame || !this.#info) return;
    if (preset === "overview") {
      if (frame.focused) this.home();
      return;
    }
    const selection = this.selection.get().bounds;
    let box: CellBox | null;
    if (preset === "selection") {
      if (!selection) return;
      box = {
        min: [selection[0], selection[1], selection[2]],
        max: [selection[3] + 1, selection[4] + 1, selection[5] + 1],
      };
    } else {
      box = await this.#freshBounds();
    }
    if (!box) return;
    const view = this.#views.get(id);
    const cam = frame.focused ? this.camera : view?.camera;
    if (!cam || !view) return;
    const north = this.#info.north;
    const here = cam.position;
    const centre = centreOf(box);
    const current = bearingOf(here.x - centre[0], here.z - centre[2], north);
    // Top stands a hair south, so north is up the screen, as on the 2D plan.
    const sides: Record<string, number> = { north: 0, east: 90, south: 180, west: 270, top: 180 };
    const bearing =
      preset === "iso"
        ? 45 + 90 * Math.floor(current / 90)
        : preset in sides
          ? (sides[preset] ?? 0)
          : current;
    const elevation =
      preset === "top" ? ELEVATIONS.top : preset === "iso" ? ELEVATIONS.iso : ELEVATIONS.mid;
    const pose = framePose(
      box,
      bearing,
      elevation,
      north,
      cam.fov,
      frame.width / Math.max(1, frame.height),
    );
    const position = { x: pose.position[0], y: pose.position[1], z: pose.position[2] };
    const target = { x: pose.target[0], y: pose.target[1], z: pose.target[2] };
    if (frame.focused) {
      this.fly.place(position, target);
    } else {
      cam.position.set(position.x, position.y, position.z);
      cam.lookAt(target.x, target.y, target.z);
      cam.updateMatrixWorld();
      view.pose = poseOf(cam, view.pose.speed);
    }
    if (frame.view.projection === "orthographic") {
      const f = new THREE.Vector3();
      cam.getWorldDirection(f);
      view.orthoHalf = orthoHalfHeight(
        box,
        [f.x, f.y, f.z],
        frame.width / Math.max(1, frame.height),
      );
    }
  }

  /** The focused camera's flying speed, in cells a second. */
  setSpeed(speed: number): void {
    this.fly.scaleSpeed(speed / this.fly.speed);
    this.speed.set(this.fly.speed);
  }

  /** Turns each orbiting pane's camera about the build's centre. */
  #tickOrbits(dt: number): void {
    if (dt <= 0 || !this.#info) return;
    for (const frame of this.#viewFrames) {
      const degrees = orbitDegrees(frame.view.orbit);
      if (degrees === 0) continue;
      if (frame.focused && this.fly.locked) {
        this.#stopOrbit(frame.id);
        continue;
      }
      if (performance.now() - this.#boundsAt > 2000) void this.#freshBounds();
      const box = this.#bounds;
      if (!box) continue;
      const centre = centreOf(box);
      const view = this.#views.get(frame.id);
      const cam = frame.focused ? this.camera : view?.camera;
      if (!cam || !view) continue;
      const p = orbitStep(
        [cam.position.x, cam.position.y, cam.position.z],
        centre,
        ((degrees * Math.PI) / 180) * dt,
      );
      const position = { x: p[0], y: p[1], z: p[2] };
      const target = { x: centre[0], y: centre[1], z: centre[2] };
      if (frame.focused) {
        this.fly.place(position, target);
      } else {
        cam.position.set(p[0], p[1], p[2]);
        cam.lookAt(target.x, target.y, target.z);
        cam.updateMatrixWorld();
        view.pose = poseOf(cam, view.pose.speed);
      }
    }
  }

  #stopOrbit(id: string): void {
    const frame = this.#viewFrames.find((f) => f.id === id);
    if (!frame || frame.view.orbit === "off") return;
    this.#viewFrames = this.#viewFrames.map((f) =>
      f.id === id ? { ...f, view: { ...f.view, orbit: "off" } } : f,
    );
    this.onOrbitStop?.(id);
  }

  /** The project's bounds, asked of the world worker (at most every couple of seconds). */
  async #freshBounds(): Promise<CellBox | null> {
    this.#boundsAt = performance.now();
    const world = this.#worldId;
    const bounds = await this.world.request({ type: "bounds" });
    if (world === this.#worldId) this.#bounds = bounds;
    return bounds;
  }

  #clipboardRev = 0;

  /** Copies the selection into the clipboard (cut: and empties it). */
  async copySelection(cut: boolean): Promise<void> {
    if (!this.#info) return;
    try {
      const info = await this.world.request({ type: "clipboardCopy", cut });
      if (!info) {
        this.say("Select something first.");
        return;
      }
      this.#setClipboard(info);
      this.say(`${cut ? "Cut" : "Copied"} ${info.cells} blocks. Ctrl+V pastes.`);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }

  /** Tells the world what the views hide, and redraws the cutaway's frame. */
  #pushVisibility(): void {
    const { box, on } = this.cutaway.get();
    void this.world.request({
      type: "visibility",
      hide: on ? box : null,
      isolate: this.isolate.get(),
    });
    this.#cutFrame.show(this.cutPanel.get() ? box : null);
    this.#aimedFor = ""; // rays now pass through what is hidden
  }

  /** Hides a box of cells (both corners inclusive) in the 3D views, or null brings them back. */
  setCutaway(box: HiddenBox | null, on = true): void {
    this.cutaway.set({ box, on: box === null ? true : on });
    if (box === null) this.cutPanel.set(false);
    this.#pushVisibility();
  }

  /** Changes the project's north and major grid offset (one undo step). */
  async setProjectSettings(change: { north?: Direction; grid?: [number, number] }): Promise<void> {
    await this.world.request({ type: "settings", ...change });
  }

  /** Switches the cutaway off and on (H or End). */
  toggleCutaway(): void {
    const { box, on } = this.cutaway.get();
    if (box === null) {
      this.say("Nothing is cut away. Use the Cutaway menu, or select a region first.");
      return;
    }
    this.cutaway.set({ box, on: !on });
    this.#pushVisibility();
  }

  /** Hides the selected region, and opens the panel to adjust it. */
  cutAwaySelection(): void {
    const b = this.selection.get().bounds;
    if (!b) {
      this.say("Select a region first.");
      return;
    }
    this.cutaway.set({ box: { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, on: true });
    this.cutPanel.set(true);
    this.#pushVisibility();
  }

  /** Lifts the roof off: hides everything above the camera over the whole build. */
  async cutAboveCamera(): Promise<void> {
    const bounds = await this.#freshBounds();
    if (!bounds) {
      this.say("There is nothing to cut.");
      return;
    }
    const lo = bounds.min;
    const hi = bounds.max;
    // The box starts one cell above eye level, and reaches past the build on every side.
    const y = Math.min(Math.max(Math.floor(this.camera.position.y) + 1, lo[1]), hi[1] - 1);
    this.setCutaway({ min: [lo[0] - 1, y, lo[2] - 1], max: [hi[0], hi[1], hi[2]] });
  }

  /** Moves one face of the cutaway box (`axis` 0 x, 1 y, 2 z) by `delta` cells. */
  nudgeCutaway(axis: number, end: "min" | "max", delta: number): void {
    const { box, on } = this.cutaway.get();
    if (!box) return;
    const min = [...box.min] as [number, number, number];
    const max = [...box.max] as [number, number, number];
    if (end === "min") min[axis] = Math.min((min[axis] ?? 0) + delta, max[axis] ?? 0);
    else max[axis] = Math.max((max[axis] ?? 0) + delta, min[axis] ?? 0);
    this.cutaway.set({ box: { min, max }, on });
    this.#pushVisibility();
  }

  /** Shows only the selection in the 3D views (or everything again). */
  setIsolate(on: boolean): void {
    if (on === this.isolate.get()) return;
    this.isolate.set(on);
    this.#pushVisibility();
  }

  /** Opens or closes the cutaway's bounds panel; its box is outlined while it is open. */
  setCutPanel(open: boolean): void {
    this.cutPanel.set(open);
    this.#cutFrame.show(open ? this.cutaway.get().box : null);
  }

  /** Keeps the selection as a prefab. */
  async savePrefab(name: string, tags: string[]): Promise<void> {
    const entry = await this.world.request({ type: "savePrefab", name, tags, from: "selection" });
    this.prefabsRev.set(this.prefabsRev.get() + 1);
    this.say(`Saved ${entry.name} as a prefab. It is in the inventory and on Home.`);
  }

  /**
   * Puts a prefab in the clipboard and takes the Paste tool. The inventory closes (and the
   * pointer locks again if it was open while flying), so the next click places it.
   */
  async pastePrefab(id: string): Promise<void> {
    try {
      this.#setClipboard(await this.world.request({ type: "usePrefab", id }));
      this.setTool("paste");
      if (this.inventoryOpen.get()) this.toggleInventory();
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }

  /** Takes the Paste tool, if the clipboard holds something. */
  takePaste(): void {
    if (!this.clipboard.get()) {
      this.say("The clipboard is empty. Select something and press Ctrl+C, or pick a prefab.");
      return;
    }
    this.setTool("paste");
  }

  /** Sets what the clipboard holds (or empties it), and redraws the paste ghost. */
  setClipboard(info: ClipboardInfo | null): void {
    this.#setClipboard(info);
  }

  #setClipboard(info: ClipboardInfo | null): void {
    this.clipboard.set(info);
    this.pasteLock.set(null);
    this.#clipboardRev++;
    this.#aimedFor = "";
  }

  /** What the clipboard holds in the world worker, after a project opens. */
  async syncClipboard(): Promise<void> {
    this.#setClipboard(await this.world.request({ type: "clipboardInfo" }));
  }

  /** Changes how the Paste tool sets the clipboard down. */
  setPaste(change: Partial<PasteArgs>): void {
    this.paste.set({ ...this.paste.get(), ...change });
    this.#aimedFor = "";
  }

  /** Shifts the paste one step along an axis (0 x, 1 y, 2 z). */
  nudgePaste(axis: number, step: number): void {
    const offset = [...this.paste.get().offset] as [number, number, number];
    offset[axis] = (offset[axis] ?? 0) + step;
    this.setPaste({ offset });
  }

  /** Turns the clipboard a quarter turn (clockwise from above; `step` -1 the other way). */
  turnPaste(step: number): void {
    const turn = (((this.paste.get().turn + step) % 4) + 4) % 4;
    this.setPaste({ turn });
  }

  /** Mirrors the clipboard, east for west. */
  mirrorPaste(): void {
    this.setPaste({ mirror: !this.paste.get().mirror });
  }

  /** What a paste sends: the options, pinned to `at` when it is. */
  #pasteArgs(at: Vec3 | null): PasteArgs {
    return at ? { ...this.paste.get(), at } : this.paste.get();
  }

  /** Where a paste would go now if the cursor is free: its lock, else where it last aimed. */
  #frozenAnchor(): Vec3 | null {
    return this.pasteLock.get() ?? this.#lastPasteAt;
  }

  /** Left click: pins the paste where it is, so you can look around it; again lets it follow. */
  togglePasteLock(): void {
    if (this.pasteLock.get()) {
      this.pasteLock.set(null);
    } else if (this.#lastPasteAt) {
      this.pasteLock.set(this.#lastPasteAt);
    } else {
      this.say("Aim at something first, then click to pin the paste there.");
    }
    this.#aimedFor = "";
  }

  /**
   * Puts the clipboard down: where the crosshair aims, or at the pinned cell. Resolves to
   * whether anything was placed. A pinned paste lets go once it is placed.
   */
  async placePaste(): Promise<boolean> {
    if (!this.clipboard.get()) {
      this.say("The clipboard is empty. Select something and press Ctrl+C, or pick a prefab.");
      return false;
    }
    const locked = this.fly.locked;
    const at = locked ? this.pasteLock.get() : this.#frozenAnchor();
    if (!locked && !at) return false;
    const cells = await this.world.request({
      type: "paste",
      ...this.#pasteArgs(at),
      ...this.#ray(),
    });
    if (cells > 0) this.pasteLock.set(null);
    return cells > 0;
  }

  /**
   * Middle click with the Paste tool: frees the cursor and freezes the paste where it was
   * aimed, so the panel can turn, mirror and shift it while you watch the result.
   */
  openPasteAdjust(): void {
    if (!this.clipboard.get()) {
      this.say("The clipboard is empty. Select something and press Ctrl+C, or pick a prefab.");
      return;
    }
    this.#adjusting = true;
    this.#openingAdjust = this.fly.locked;
    this.fly.unlock();
  }

  /** Back to flying from the paste panel. */
  closePasteAdjust(): void {
    this.#adjusting = false;
    this.fly.lock();
  }

  /** Esc: stop pasting. The tool in hand before comes back; the clipboard stays. */
  cancelPaste(): void {
    if (this.tool.get() !== "paste") return;
    this.setPaste({ offset: [0, 0, 0] });
    this.setTool(this.#toolBeforePaste);
    this.#updateFrozenPaste();
  }

  /** Takes the pointer back when Esc is released: it cannot be asked for in the key press. */
  #lockOnEscapeUp(): void {
    const lock = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      document.removeEventListener("keyup", lock, true);
      this.fly.lock();
    };
    document.addEventListener("keyup", lock, true);
    // If the key was already up, or never reports, the listener must not wait for a later Esc.
    setTimeout(() => document.removeEventListener("keyup", lock, true), 1500);
  }

  #onLockChange(): void {
    this.#clearHeld();
    const flying = this.fly.locked;
    this.flying.set(flying);
    const was = this.#wasFlying;
    this.#wasFlying = flying;
    if (flying) {
      this.#adjusting = false;
      return;
    }
    if (!was) return;
    const voluntary = this.#openingAdjust || this.inventoryOpen.get() || !document.hasFocus();
    this.#openingAdjust = false;
    // The pointer left on its own while pasting: the Esc the browser keeps for itself. It
    // means stop pasting, and the pointer is taken back when the key comes up.
    if (!voluntary && this.tool.get() === "paste") {
      this.cancelPaste();
      this.#lockOnEscapeUp();
    }
  }

  /** While the cursor is free, a Paste tool with a clipboard keeps its ghost where it froze. */
  #updateFrozenPaste(): void {
    const at = this.tool.get() === "paste" && this.clipboard.get() ? this.#frozenAnchor() : null;
    if (!at || !this.#info || this.#autopilot) {
      this.#pasteGhost.show(null);
      this.#pasteFrozenFor = "";
      return;
    }
    const args = this.#pasteArgs(at);
    const key = `${JSON.stringify(args)} ${this.#revision} ${this.#clipboardRev}`;
    if (key === this.#pasteFrozenFor || this.#pasteFrozenBusy) return;
    this.#pasteFrozenFor = key;
    this.#pasteFrozenBusy = true;
    const world = this.#worldId;
    void this.world.request({ type: "pasteGhost", ...args }).then(
      (ghost) => {
        this.#pasteFrozenBusy = false;
        if (world === this.#worldId && !this.fly.locked) this.#pasteGhost.show(ghost);
      },
      () => {
        this.#pasteFrozenBusy = false;
      },
    );
  }

  /** Switches the fly tool. A half-chosen box corner is dropped. */
  setTool(tool: EditorTool): void {
    const before = this.tool.get();
    if (tool === "paste" && before !== "paste") this.#toolBeforePaste = before;
    if (tool !== "paste") {
      this.pasteLock.set(null);
      this.#adjusting = false;
    }
    this.tool.set(tool);
    rememberTool(tool);
    this.#clearAnchor();
    this.#aimedFor = ""; // the preview follows the tool
    // The outline is part of the selection tools. The selection itself stays, for actions.
    this.#showOutline(this.selection.get().lines);
  }

  /** The brush for Build to me and Exchange: 1 to 9 cells across. */
  setBrush(brush: number): void {
    const n = Math.max(1, Math.min(9, Math.round(brush)));
    this.brush.set(n);
    rememberBrush(n);
    this.#aimedFor = "";
  }

  /** Turns the block the crosshair aims at about the face it hits (`reverse`: the other way). */
  rotateAimed(reverse: boolean): void {
    if (!this.#info) return;
    void this.#run(this.world.request({ type: "rotate", reverse, ...this.#ray() }));
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
    await this.#corner(aimed?.hit ?? aimed?.place ?? null);
  }

  /**
   * The Select tool from the 2D view: a corner at a world cell (null, off the grid, clears).
   * The first corner is shared with the 3D view, so a box can start on one layer, or in 3D,
   * and end on another.
   */
  selectCornerAt(cell: Vec3 | null): void {
    this.#enqueue(() => this.#corner(cell));
  }

  /** Shift with the Select tool in the 2D view: the blocks touching a cell (structure). */
  selectConnectedAt(cell: Vec3): void {
    this.#enqueue(async () => {
      const semantic = await this.world.request({ type: "semanticAt", at: cell });
      if (semantic === null) return;
      this.#dropAnchor();
      const seed: [number, number, number] = [cell[0], cell[1], cell[2]];
      await this.#select(
        this.connectAny.get()
          ? { structure: { seed } }
          : { structure: { seed, semantics: [semantic] } },
      );
    });
  }

  /** Middle click in the 2D view: the semantic in a cell into the hotbar. */
  pickAt(cell: Vec3): void {
    void this.world.request({ type: "semanticAt", at: cell }).then((semantic) => {
      if (semantic === null) return;
      const info = this.palettes
        .get()
        .flatMap((p) => p.semantics)
        .find((s) => s.ref === semantic);
      if (info) this.hotbar.pick(info);
    });
  }

  /** Runs a 2D edit and reports a refusal in the selection panel's notice. */
  edit2d(work: Promise<unknown>): void {
    void this.#run(work);
  }

  async #corner(cell: Vec3 | null): Promise<void> {
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

  /** Shift+right-click with Select: the blocks touching the one clicked (`structure`). */
  async #applyConnected(ray: Ray): Promise<void> {
    if (this.tool.get() !== "select") return;
    const hit = await this.world.request({ type: "raycast", ...ray });
    if (this.tool.get() !== "select" || !hit) return;
    this.#dropAnchor();
    const seed: [number, number, number] = [hit.cell[0], hit.cell[1], hit.cell[2]];
    const where: Region = this.connectAny.get()
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

  /** The selection outline while Select is in hand, and nothing while building. */
  #showOutline(lines: Float32Array): void {
    this.#selectionOutline.show(this.tool.get() === "select" ? lines : new Float32Array(0));
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

/** A 3D pane's cameras: the one it flies, its pose while unfocused, an orthographic twin. */
interface ViewCamera {
  readonly camera: THREE.PerspectiveCamera;
  pose: FlyPose;
  readonly ortho: THREE.OrthographicCamera;
  /** Half the orthographic view's height in cells; set the first time it draws orthographic. */
  orthoHalf: number | null;
}

/** Slice the 2D view through `cell`; `turn` steps its axis first. `n` tells requests apart. */
export interface SliceRequest {
  readonly cell: Vec3;
  readonly turn: boolean;
  readonly n: number;
}

/** The camera presets of a 3D pane's Camera menu. */
export type CameraPreset =
  | "overview"
  | "north"
  | "east"
  | "south"
  | "west"
  | "top"
  | "iso"
  | "selection";

/** How far an orthographic view sees in front of and behind its camera. */
const ORTHO_DEPTH = 4000;

/** A camera's pose as FlyCamera keeps it. */
function poseOf(camera: THREE.Camera, speed: number): FlyPose {
  const e = EULER.setFromQuaternion(camera.quaternion, "YXZ");
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    yaw: e.y,
    pitch: e.x,
    speed,
  };
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
