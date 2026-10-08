// A 2D view of one slice of the world: a plan of a layer, or a cut across x or z. It is a lens
// on the world in the world worker (CLAUDE.md principle 2): it asks for the cells it shows and
// colours them from the same looks table the 3D view uses, and owns nothing about the world.
// Edits go to the world worker as commands: a stroke is one command, previewed here while it
// is drawn.

import { type Direction, SIDE_VECTORS, SIDES } from "@voxyl/core";
import * as THREE from "three/webgpu";
import { isKey } from "../editor/keymap.ts";
import type { Engine } from "../scene/Engine.ts";
import type { SliceWindow } from "../scene/slice-guide.ts";
import { FACING_PARTS, FACING_UPSIDE_DOWN } from "../world/flat-edit.ts";
import { MAX_SLICE_CELLS, type Vec3 } from "../world/protocol.ts";
import { footprint } from "./footprint.ts";
import {
  type Orientation,
  orientationFor,
  planeToScreen,
  planeToWorld,
  type SliceAxis,
  screenToPlane,
  turnedOrientation,
  worldToPlane,
} from "./plane.ts";

const MIN_CELL_PX = 2;
const MAX_CELL_PX = 64;
/** Background, grid lines and the 3D camera marker. */
const BG = [21, 23, 27] as const;
const MINOR_LINE = "rgb(255 255 255 / 0.06)";
const MAJOR_LINE = "rgb(255 255 255 / 0.16)";
const ORIGIN_LINE = "rgb(34 211 238 / 0.35)";
/** The focused 3D view's camera, and the other 3D views'. */
const CAMERA = [34, 211, 238] as const;
const OTHER_CAMERA = [148, 163, 184] as const;
/** Another 2D view's slice across this one: amber, as the slice guide is in 3D. */
const GUIDE_FILL = "rgb(251 191 36 / 0.08)";
const GUIDE_LINE = "rgb(251 191 36 / 0.7)";
/** How far a camera's view cone reaches on screen, in CSS pixels, when it looks along the slice. */
const CONE_PX = 46;
/** The selection: bright on its layers, a dim outline off them. */
const SELECTION_FILL = "rgb(103 232 249 / 0.12)";
const SELECTION_LINE = "rgb(103 232 249 / 0.95)";
const SELECTION_DIM = "rgb(103 232 249 / 0.35)";
/** A stroke being drawn; erasing shows red. */
const ERASE_LINE = "rgb(248 113 113 / 0.9)";
/** Facing arrows and part marks show from this many CSS pixels a cell. */
const GLYPH_PX = 12;
/** From this many CSS pixels a cell, a cell of parts draws its parts, not a corner mark. */
const FOOTPRINT_PX = 14;

/** How the Build tools draw in a 2D view (the 2D bar's Draw menu). */
export type DrawMode = "pencil" | "line" | "rect" | "fill";

/** How strongly the layer below shows through empty cells. */
const BELOW = 0.32;
/** Cells fetched beyond the visible edge, so small pans need no new request. */
const MARGIN = 8;
/** At most one refresh this often while the world keeps changing. */
const REFRESH_MS = 120;

export interface GridViewState {
  readonly axis: SliceAxis;
  readonly depth: number;
  /** Pixels per cell. */
  readonly cellPx: number;
  /** The cell under the pointer, in world coordinates, and what it holds. */
  readonly hover: { readonly at: readonly [number, number, number]; readonly what: string } | null;
  /** Quarter turns clockwise and a mirror on top of the slice's own orientation. */
  readonly turns: number;
  readonly mirror: boolean;
}

/** A stroke being drawn: its cells (plane u, v), and how blocks will face. */
interface Stroke {
  readonly erase: boolean;
  readonly mode: DrawMode;
  readonly start: readonly [number, number];
  last: [number, number];
  readonly cells: Map<string, readonly [number, number]>;
  readonly look: Vec3;
}

interface Fetched {
  readonly axis: SliceAxis;
  readonly depth: number;
  readonly u0: number;
  readonly v0: number;
  readonly width: number;
  readonly height: number;
  readonly ids: Uint16Array;
  readonly below: Uint16Array;
  readonly revision: number;
}

/**
 * Draws a slice onto a canvas: one pixel per cell into an offscreen image, scaled up without
 * smoothing, then grid lines and the 3D camera on top. Pan by dragging, zoom with the wheel,
 * step layers with [ and ] or Page Up and Page Down (right-hand keys, for left-handed mice).
 */
export class GridView {
  readonly canvas = document.createElement("canvas");
  readonly #engine: Engine;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #image = document.createElement("canvas");
  readonly #abort = new AbortController();
  readonly #observer: ResizeObserver;
  readonly #onState: (state: GridViewState) => void;
  #axis: SliceAxis = 1;
  #depth = 1;
  #north: Direction = "north";
  #grid: readonly [number, number] = [0, 0];
  #orientation: Orientation = orientationFor(1, "north");
  /** Screen-cell coordinate at the canvas centre (fractional). */
  #center: [number, number] = [0, 0];
  #cellPx = 12;
  #fetched: Fetched | null = null;
  #fetching = false;
  #lastFetch = 0;
  #dirty = true;
  #hover: GridViewState["hover"] = null;
  #hoverAsked = "";
  /** Panning: by the middle button, Space and drag, or left-drag with Select. */
  #pan: { x: number; y: number; moved: boolean; pick: Vec3 | null } | null = null;
  #space = false;
  #stroke: Stroke | null = null;
  #mode: DrawMode = "pencil";
  #turns = 0;
  #mirror = false;
  #frame = 0;
  /** Where the 3D cameras were last drawn. */
  #cameraKey = "";
  /** Draw the 3D views' cameras. */
  #cameras = true;
  /** The 3D views draw this slice, and only while this pane is focused. */
  #showGuide = false;
  /** The window last given to the 3D views. */
  #guideKey = "";

  constructor(host: HTMLElement, engine: Engine, onState: (state: GridViewState) => void) {
    this.#engine = engine;
    this.#onState = onState;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    this.#ctx = ctx;
    this.canvas.className = "grid-canvas";
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(host);
    const signal = this.#abort.signal;
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.#onDown(e), { signal });
    c.addEventListener("pointermove", (e) => this.#onMove(e), { signal });
    c.addEventListener("pointerup", (e) => this.#onUp(e), { signal });
    c.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    c.addEventListener(
      "keyup",
      (e) => {
        if (e.code === "Space") this.#space = false;
      },
      { signal },
    );
    for (const store of [engine.selection, engine.anchor, engine.hotbar.state]) {
      const off = store.subscribe(() => {
        this.#dirty = true;
      });
      signal.addEventListener("abort", off);
    }
    c.addEventListener("pointerleave", () => this.#setHover(null), { signal });
    c.addEventListener("wheel", (e) => this.#onWheel(e), { signal, passive: false });
    c.addEventListener("keydown", (e) => this.#onKey(e), { signal });
    this.#resize();
    const tick = () => {
      this.#frame = requestAnimationFrame(tick);
      this.#update();
    };
    this.#frame = requestAnimationFrame(tick);
  }

  get state(): GridViewState {
    return {
      axis: this.#axis,
      depth: this.#depth,
      cellPx: this.#cellPx,
      hover: this.#hover,
      turns: this.#turns,
      mirror: this.#mirror,
    };
  }

  /**
   * Centres the view on a world position and shows the slice through it, zoomed so `extent`
   * cells fit.
   */
  focus(
    at: readonly [number, number, number],
    extent: number,
    north: Direction,
    grid: readonly [number, number],
  ) {
    this.#north = north;
    this.#grid = grid;
    const parent = this.canvas.parentElement;
    const fit = Math.min(parent?.clientWidth ?? 600, parent?.clientHeight ?? 600) / (extent + 4);
    this.#cellPx = Math.min(24, Math.max(MIN_CELL_PX, fit));
    const [u, v, depth] = worldToPlane(this.#axis, at);
    this.#depth = Math.floor(depth);
    this.#setOrientation();
    this.#centerOn(u, v);
    this.#changed();
  }

  setAxis(axis: SliceAxis): void {
    if (axis === this.#axis) return;
    // Keep looking at the same place: the cell at the centre stays at the centre.
    const centre = this.#centreWorld();
    this.#axis = axis;
    this.#setOrientation();
    const [u, v, depth] = worldToPlane(axis, centre);
    this.#depth = Math.floor(depth);
    this.#centerOn(u, v);
    this.#changed();
  }

  /**
   * Slices through a world cell and centres on it, keeping the zoom; with `axis`, turns the
   * slice to that axis first.
   */
  sliceThrough(cell: readonly [number, number, number], axis?: SliceAxis): void {
    if (axis !== undefined && axis !== this.#axis) {
      this.#axis = axis;
      this.#setOrientation();
    }
    const [u, v, depth] = worldToPlane(this.#axis, cell);
    this.#depth = Math.floor(depth);
    this.#centerOn(u, v);
    this.#changed();
  }

  /** Turns or mirrors the picture, keeping the same cell in the middle. */
  setView(turns: number, mirror: boolean): void {
    const centre = this.#centreWorld();
    this.#turns = ((Math.round(turns) % 4) + 4) % 4;
    this.#mirror = mirror;
    this.#setOrientation();
    const [u, v] = worldToPlane(this.#axis, centre);
    this.#centerOn(u, v);
    this.#changed();
  }

  /** How the Build tools draw here: pencil strokes, lines, rectangles or fills. */
  setDrawMode(mode: DrawMode): void {
    this.#mode = mode;
  }

  setDepth(depth: number): void {
    this.#depth = Math.round(depth);
    this.#changed();
  }

  /** Draws or hides this slice in the 3D views. */
  setShowGuide(on: boolean): void {
    if (on === this.#showGuide) return;
    this.#showGuide = on;
    this.#guideKey = "";
    if (on) this.#dirty = true;
    else this.#engine.clearSliceGuide(this);
  }

  /** Shows or hides the 3D views' camera markers. */
  setCameras(on: boolean): void {
    if (on === this.#cameras) return;
    this.#cameras = on;
    this.#dirty = true;
  }

  dispose(): void {
    this.#engine.clearSliceGuide(this);
    this.#engine.setFlatSlice(this, null);
    cancelAnimationFrame(this.#frame);
    this.#abort.abort();
    this.#observer.disconnect();
    this.canvas.remove();
  }

  #setOrientation(): void {
    this.#orientation = turnedOrientation(
      orientationFor(this.#axis, this.#north),
      this.#turns,
      this.#mirror,
    );
  }

  #centerOn(u: number, v: number): void {
    const [s, t] = planeToScreen(this.#orientation, Math.floor(u), Math.floor(v));
    this.#center = [s + 0.5, t + 0.5];
  }

  /** The world cell at the centre of the view, on the current slice. */
  #centreWorld(): [number, number, number] {
    const [u, v] = screenToPlane(
      this.#orientation,
      Math.floor(this.#center[0]),
      Math.floor(this.#center[1]),
    );
    return planeToWorld(this.#axis, this.#depth, u, v);
  }

  #changed(): void {
    this.#dirty = true;
    this.#hoverAsked = "";
    this.#emit();
  }

  #emit(): void {
    this.#onState(this.state);
  }

  #resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(parent.clientWidth * ratio));
    this.canvas.height = Math.max(1, Math.round(parent.clientHeight * ratio));
    this.#dirty = true;
  }

  /** Screen cells visible: [s0, t0, s1, t1), plus the margin. */
  #visible(margin: number): [number, number, number, number] {
    const ratio = window.devicePixelRatio || 1;
    const px = this.#cellPx * ratio;
    const halfW = this.canvas.width / 2 / px;
    const halfH = this.canvas.height / 2 / px;
    const [cs, ct] = this.#center;
    return [
      Math.floor(cs - halfW) - margin,
      Math.floor(ct - halfH) - margin,
      Math.ceil(cs + halfW) + margin,
      Math.ceil(ct + halfH) + margin,
    ];
  }

  #update(): void {
    const revision = this.#engine.revision;
    const f = this.#fetched;
    const [s0, t0, s1, t1] = this.#visible(0);
    const covered =
      f !== null &&
      f.axis === this.#axis &&
      f.depth === this.#depth &&
      this.#covers(f, s0, t0, s1, t1);
    const stale = !covered || f.revision !== revision;
    if (stale && !this.#fetching && performance.now() - this.#lastFetch > REFRESH_MS)
      void this.#fetch(revision);
    const cameraKey = `${this.#cameras ? cameraKeyOf(this.#engine) : ""}|${this.#engine.flatRevision}`;
    if (cameraKey !== this.#cameraKey) {
      this.#cameraKey = cameraKey;
      this.#dirty = true;
    }
    if (this.#dirty) this.#draw();
  }

  #covers(f: Fetched, s0: number, t0: number, s1: number, t1: number): boolean {
    const o = this.#orientation;
    for (const [s, t] of [
      [s0, t0],
      [s1 - 1, t1 - 1],
    ] as const) {
      const [u, v] = screenToPlane(o, s, t);
      if (u < f.u0 || v < f.v0 || u >= f.u0 + f.width || v >= f.v0 + f.height) return false;
    }
    return true;
  }

  async #fetch(revision: number): Promise<void> {
    if (!this.#engine.info) return;
    this.#fetching = true;
    this.#lastFetch = performance.now();
    try {
      const [s0, t0, s1, t1] = this.#visible(MARGIN);
      const [ua, va] = screenToPlane(this.#orientation, s0, t0);
      const [ub, vb] = screenToPlane(this.#orientation, s1 - 1, t1 - 1);
      const u0 = Math.min(ua, ub);
      const v0 = Math.min(va, vb);
      let width = Math.abs(ub - ua) + 1;
      let height = Math.abs(vb - va) + 1;
      // Zoomed far out, a huge view shows its middle only rather than asking for too much.
      const scale = Math.sqrt(Math.min(1, MAX_SLICE_CELLS / (width * height)));
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
      const axis = this.#axis;
      const depth = this.#depth;
      const { ids, below } = await this.#engine.world.request({
        type: "slice",
        axis,
        depth,
        u0,
        v0,
        width,
        height,
      });
      this.#fetched = { axis, depth, u0, v0, width, height, ids, below, revision };
      this.#dirty = true;
    } catch (error) {
      console.error("The 2D view couldn't read its slice", error);
    } finally {
      this.#fetching = false;
    }
  }

  #draw(): void {
    this.#dirty = false;
    const ctx = this.#ctx;
    const { width: W, height: H } = this.canvas;
    ctx.fillStyle = `rgb(${BG.join(" ")})`;
    ctx.fillRect(0, 0, W, H);
    const f = this.#fetched;
    const [s0, t0, s1, t1] = this.#visible(0);
    const cols = s1 - s0;
    const rows = t1 - t0;
    const ratio = window.devicePixelRatio || 1;
    const px = this.#cellPx * ratio;
    // Screen position of screen cell (s, t)'s top-left corner.
    const sx = (s: number) => (s - this.#center[0]) * px + W / 2;
    const ty = (t: number) => (t - this.#center[1]) * px + H / 2;

    if (f && f.axis === this.#axis && f.depth === this.#depth && cols > 0 && rows > 0) {
      const looks = this.#engine.looks;
      const facing = this.#engine.facing;
      const showFootprints = px >= FOOTPRINT_PX * ratio;
      const image = this.#image;
      image.width = cols;
      image.height = rows;
      const ictx = image.getContext("2d");
      if (ictx) {
        const data = ictx.createImageData(cols, rows);
        const out = data.data;
        const o = this.#orientation;
        for (let t = 0; t < rows; t++)
          for (let s = 0; s < cols; s++) {
            const [u, v] = screenToPlane(o, s0 + s, t0 + t);
            const i = u - f.u0;
            const j = v - f.v0;
            const k = (s + t * cols) * 4;
            let r: number = BG[0];
            let g: number = BG[1];
            let b: number = BG[2];
            if (i >= 0 && j >= 0 && i < f.width && j < f.height) {
              const id = f.ids[i + j * f.width] ?? 0;
              const under = f.below[i + j * f.width] ?? 0;
              if (id !== 0 && showFootprints && ((facing[id] ?? 0) & FACING_PARTS) !== 0) {
                // Its parts are drawn over the background, so the empty part of the cell shows.
              } else if (id !== 0) {
                r = looks[id * 4] ?? 0;
                g = looks[id * 4 + 1] ?? 0;
                b = looks[id * 4 + 2] ?? 0;
              } else if (under !== 0) {
                r = mix(r, looks[under * 4] ?? 0, BELOW);
                g = mix(g, looks[under * 4 + 1] ?? 0, BELOW);
                b = mix(b, looks[under * 4 + 2] ?? 0, BELOW);
              }
            }
            out[k] = r;
            out[k + 1] = g;
            out[k + 2] = b;
            out[k + 3] = 255;
          }
        ictx.putImageData(data, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, sx(s0), ty(t0), cols * px, rows * px);
      }
    }

    this.#drawGrid(s0, t0, s1, t1, sx, ty, px);
    if (this.#cameras) this.#drawCameras(sx, ty, px);
    this.#drawOtherSlices(sx, ty, px);
    if (px >= GLYPH_PX * ratio) this.#drawFacings(s0, t0, s1, t1, sx, ty, px);
    this.#drawSelection(sx, ty, px);
    this.#drawStroke(sx, ty, px);
    this.#publishGuide(s0, t0, s1, t1);
    if (this.#hover) {
      const [u, v] = worldToPlane(this.#axis, this.#hover.at);
      const [s, t] = planeToScreen(this.#orientation, u, v);
      ctx.strokeStyle = "rgb(255 255 255 / 0.9)";
      ctx.lineWidth = Math.max(1, ratio);
      ctx.strokeRect(sx(s) + 0.5, ty(t) + 0.5, px - 1, px - 1);
    }
  }

  #drawGrid(
    s0: number,
    t0: number,
    s1: number,
    t1: number,
    sx: (s: number) => number,
    ty: (t: number) => number,
    px: number,
  ): void {
    const ctx = this.#ctx;
    const { width: W, height: H } = this.canvas;
    const o = this.#orientation;
    // Major lines run every 16 cells from the project's grid offset, on plans only (the
    // offset is horizontal); cuts mark every 16 from zero.
    const offsetFor = (onU: boolean) => {
      if (this.#axis !== 1) return 0;
      return onU ? (this.#grid[0] ?? 0) : (this.#grid[1] ?? 0);
    };
    const line = (horizontal: boolean, at: number, style: string) => {
      ctx.strokeStyle = style;
      ctx.beginPath();
      if (horizontal) {
        const y = Math.round(ty(at)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      } else {
        const x = Math.round(sx(at)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      ctx.stroke();
    };
    ctx.lineWidth = 1;
    // A screen line at s sits between cells s - 1 and s; in plane terms that is the edge
    // between plane cells n and n + 1, or n - 1 and n, depending on the axis's sign.
    const planeEdge = (a: { onU: boolean; sign: 1 | -1 }, s: number) => (a.sign > 0 ? s : -s);
    for (const [horizontal, from, to, axis] of [
      [false, s0, s1, o.right],
      [true, t0, t1, o.down],
    ] as const) {
      const offset = offsetFor(axis.onU);
      for (let n = from; n <= to; n++) {
        const edge = planeEdge(axis, n);
        const major = (((edge - offset) % 16) + 16) % 16 === 0;
        if (edge === 0 && this.#axis !== 1) line(horizontal, n, ORIGIN_LINE);
        else if (major) line(horizontal, n, MAJOR_LINE);
        else if (px >= 8) line(horizontal, n, MINOR_LINE);
      }
    }
  }

  /**
   * Each 3D view's camera, as a GPS app shows you: a dot where it stands and a cone the way
   * it looks, as wide as its view. The cone shortens as the camera looks out of the slice
   * (straight down on a plan), until only the dot is left. The focused view's is brightest.
   */
  #drawCameras(sx: (s: number) => number, ty: (t: number) => number, px: number): void {
    const ctx = this.#ctx;
    const ratio = window.devicePixelRatio || 1;
    const o = this.#orientation;
    const cameras = this.#engine.viewCameras();
    // The focused camera last, so it sits on top.
    cameras.sort((a, b) => Number(a.focused) - Number(b.focused));
    for (const { camera, focused } of cameras) {
      const p = camera.position;
      const [u, v] = worldToPlane(this.#axis, [p.x, p.y, p.z]);
      // Fractional screen position: the inverse map works on cells, so offset within the cell.
      const [s, t] = planeToScreen(o, Math.floor(u), Math.floor(v));
      const fu = u - Math.floor(u);
      const fv = v - Math.floor(v);
      const frac = (a: { onU: boolean; sign: 1 | -1 }) => {
        const f = a.onU ? fu : fv;
        return a.sign > 0 ? f : 1 - f;
      };
      const x = sx(s) + frac(o.right) * px;
      const y = ty(t) + frac(o.down) * px;
      const [r, g, b] = focused ? CAMERA : OTHER_CAMERA;

      const forward = camera.getWorldDirection(FORWARD);
      const [du, dv] = worldToPlane(this.#axis, [forward.x, forward.y, forward.z]);
      const along = (a: { onU: boolean; sign: 1 | -1 }) => (a.onU ? du : dv) * a.sign;
      const right = along(o.right);
      const down = along(o.down);
      const reach = Math.hypot(right, down);
      if (reach > 0.08) {
        const heading = Math.atan2(down, right);
        // A plan sees the camera's width; a cut its height.
        const vertical = THREE.MathUtils.degToRad(camera.fov);
        const wide =
          this.#axis === 1 ? 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect) : vertical;
        const half = Math.min(wide / 2, THREE.MathUtils.degToRad(60));
        const length = CONE_PX * ratio * reach;
        const fill = ctx.createRadialGradient(x, y, 0, x, y, length);
        fill.addColorStop(0, `rgb(${r} ${g} ${b} / ${focused ? 0.55 : 0.35})`);
        fill.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, length, heading - half, heading + half);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, 5 * ratio, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      ctx.fill();
      ctx.lineWidth = 1.5 * ratio;
      ctx.strokeStyle = "rgb(255 255 255 / 0.9)";
      ctx.stroke();
    }
  }

  /** Tells the 3D views what this view shows: its layer, as wide as the visible cells. */
  #publishGuide(s0: number, t0: number, s1: number, t1: number): void {
    if (!this.#engine.info) return;
    const [ua, va] = screenToPlane(this.#orientation, s0, t0);
    const [ub, vb] = screenToPlane(this.#orientation, s1 - 1, t1 - 1);
    const window: SliceWindow = {
      axis: this.#axis,
      depth: this.#depth,
      u0: Math.min(ua, ub),
      v0: Math.min(va, vb),
      u1: Math.max(ua, ub) + 1,
      v1: Math.max(va, vb) + 1,
    };
    const key = `${this.#showGuide}:${Object.values(window).join()}`;
    if (key === this.#guideKey) return;
    this.#guideKey = key;
    this.#engine.setFlatSlice(this, window);
    if (this.#showGuide) this.#engine.setSliceGuide(this, window);
    else this.#engine.clearSliceGuide(this);
  }

  /**
   * Where the other 2D views cut this one: each slice across this one's plane is a one-cell
   * band (amber, as the slice guide is in 3D). A slice parallel to this one draws nothing.
   */
  #drawOtherSlices(sx: (s: number) => number, ty: (t: number) => number, px: number): void {
    const others = this.#engine.flatSlices(this);
    if (others.length === 0) return;
    const ctx = this.#ctx;
    const { width: W, height: H } = this.canvas;
    const o = this.#orientation;
    for (const other of others) {
      if (other.axis === this.#axis) continue;
      // The other slice fixes one world axis; find which of this plane's u and v it is.
      const unit: [number, number, number] = [0, 0, 0];
      unit[other.axis] = 1;
      const [du] = worldToPlane(this.#axis, unit);
      const onU = du !== 0;
      // Plane cell n along that axis on screen: its screen cell, and which screen axis.
      const along = o.right.onU === onU ? o.right : o.down;
      const vertical = along === o.right;
      const [s, t] = onU ? planeToScreen(o, other.depth, 0) : planeToScreen(o, 0, other.depth);
      const at = vertical ? sx(s) : ty(t);
      ctx.fillStyle = GUIDE_FILL;
      ctx.strokeStyle = GUIDE_LINE;
      ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
      if (vertical) {
        ctx.fillRect(at, 0, px, H);
        ctx.strokeRect(Math.round(at) + 0.5, -1, Math.round(px) - 1, H + 2);
      } else {
        ctx.fillRect(0, at, W, px);
        ctx.strokeRect(-1, Math.round(at) + 0.5, W + 2, Math.round(px) - 1);
      }
    }
  }

  #toScreenCell(event: PointerEvent | WheelEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const s = (event.clientX - rect.left - rect.width / 2) / this.#cellPx + this.#center[0];
    const t = (event.clientY - rect.top - rect.height / 2) / this.#cellPx + this.#center[1];
    return [s, t];
  }

  /** The plane cell under a pointer, and which way from the cell's middle it is (the look). */
  #cellAt(event: PointerEvent): { u: number; v: number; look: Vec3 } {
    const [s, t] = this.#toScreenCell(event);
    const [u, v] = screenToPlane(this.#orientation, Math.floor(s), Math.floor(t));
    const fs = s - Math.floor(s) - 0.5;
    const ft = t - Math.floor(t) - 0.5;
    // The screen direction nearest the press, as a plane step, as a world direction.
    const o = this.#orientation;
    const along = Math.abs(fs) >= Math.abs(ft) ? o.right : o.down;
    const sign = (Math.abs(fs) >= Math.abs(ft) ? Math.sign(fs) : Math.sign(ft)) || 1;
    const du = along.onU ? along.sign * sign : 0;
    const dv = along.onU ? 0 : along.sign * sign;
    return { u, v, look: planeToWorld(this.#axis, 0, du, dv) };
  }

  /** The face a 2D edit counts as clicking: the slice's own axis (up, on a plan). */
  #face(): Vec3 {
    const face: [number, number, number] = [0, 0, 0];
    face[this.#axis] = 1;
    return face;
  }

  #onDown(event: PointerEvent): void {
    this.canvas.focus();
    this.canvas.setPointerCapture(event.pointerId);
    const { u, v, look } = this.#cellAt(event);
    const at = planeToWorld(this.#axis, this.#depth, u, v);
    const tool = this.#engine.tool.get();
    const middle = event.button === 1;
    const panLeft = event.button === 0 && (this.#space || tool === "select");
    if (middle || panLeft) {
      this.#pan = { x: event.clientX, y: event.clientY, moved: false, pick: middle ? at : null };
      return;
    }
    if (!this.#engine.info) return;
    if (tool === "select") {
      if (event.button !== 2) return;
      if (event.shiftKey) this.#engine.selectConnectedAt(at);
      else this.#engine.selectCornerAt(at);
      return;
    }
    const semantic = this.#engine.hotbar.current?.ref;
    // A shaped semantic is placed in 3D, one part at a time; drawing here builds whole blocks.
    if (event.button === 0 && this.#engine.refuseShaped()) return;
    if (tool === "exchange" && event.button === 0) {
      if (semantic === undefined) return;
      this.#engine.edit2d(
        this.#engine.world.request({
          type: "toolAt",
          tool: "exchange",
          brush: this.#engine.brush.get(),
          at,
          face: this.#face(),
          semantic,
        }),
      );
      return;
    }
    if (event.button !== 0 && event.button !== 2) return;
    const erase = event.button === 2;
    const mode = tool === "exchange" ? "pencil" : this.#mode;
    if (mode === "fill") {
      if (!erase && semantic === undefined) return;
      const [s0, t0, s1, t1] = this.#visible(0);
      const [ua, va] = screenToPlane(this.#orientation, s0, t0);
      const [ub, vb] = screenToPlane(this.#orientation, s1 - 1, t1 - 1);
      const window: [number, number, number, number] = [
        Math.min(ua, ub),
        Math.min(va, vb),
        Math.max(ua, ub) + 1,
        Math.max(va, vb) + 1,
      ];
      this.#engine.edit2d(
        this.#engine.world.request({
          type: "fillPlane",
          axis: this.#axis,
          depth: this.#depth,
          u,
          v,
          window,
          semantic: erase ? null : (semantic ?? null),
          face: this.#face(),
          look,
        }),
      );
      return;
    }
    if (!erase && semantic === undefined) return;
    this.#stroke = {
      erase,
      mode,
      start: [u, v],
      last: [u, v],
      cells: new Map([[`${u},${v}`, [u, v]]]),
      look,
    };
    this.#dirty = true;
  }

  #onMove(event: PointerEvent): void {
    const pan = this.#pan;
    if (pan) {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (pan.moved || Math.hypot(dx, dy) > 3) {
        pan.moved = true;
        this.#center[0] -= dx / this.#cellPx;
        this.#center[1] -= dy / this.#cellPx;
        pan.x = event.clientX;
        pan.y = event.clientY;
        this.#dirty = true;
      }
    }
    const { u, v } = this.#cellAt(event);
    const stroke = this.#stroke;
    if (stroke && (u !== stroke.last[0] || v !== stroke.last[1])) {
      if (stroke.mode === "pencil") {
        for (const c of lineCells(stroke.last, [u, v])) stroke.cells.set(`${c[0]},${c[1]}`, c);
      } else {
        stroke.cells.clear();
        const cells =
          stroke.mode === "line"
            ? lineCells(stroke.start, [u, v])
            : rectCells(stroke.start, [u, v]);
        for (const c of cells) stroke.cells.set(`${c[0]},${c[1]}`, c);
      }
      stroke.last = [u, v];
      this.#dirty = true;
    }
    void this.#askHover(planeToWorld(this.#axis, this.#depth, u, v));
  }

  #onUp(event: PointerEvent): void {
    const pan = this.#pan;
    this.#pan = null;
    if (pan?.pick && !pan.moved && event.button === 1) this.#engine.pickAt(pan.pick);
    const stroke = this.#stroke;
    this.#stroke = null;
    if (!stroke) return;
    this.#dirty = true;
    const cells: number[] = [];
    for (const [u, v] of stroke.cells.values())
      cells.push(...planeToWorld(this.#axis, this.#depth, u, v));
    const semantic = stroke.erase ? null : (this.#engine.hotbar.current?.ref ?? null);
    if (!stroke.erase && semantic === null) return;
    const what = stroke.erase
      ? "Erase"
      : stroke.mode === "pencil"
        ? "Paint"
        : stroke.mode === "line"
          ? "Line"
          : "Rectangle";
    const name = stroke.erase ? "" : ` ${this.#engine.hotbar.current?.name ?? ""}`;
    this.#engine.edit2d(
      this.#engine.world.request({
        type: "paintCells",
        cells,
        semantic,
        face: this.#face(),
        look: stroke.look,
        label: `${what} ${cells.length / 3}${name}`,
      }),
    );
  }

  #onWheel(event: WheelEvent): void {
    event.preventDefault();
    const [s, t] = this.#toScreenCell(event);
    const next = Math.min(
      MAX_CELL_PX,
      Math.max(MIN_CELL_PX, this.#cellPx * Math.exp(-event.deltaY * 0.0015)),
    );
    // Zoom about the pointer: the cell under it stays under it.
    const k = this.#cellPx / next;
    this.#center[0] = s - (s - this.#center[0]) * k;
    this.#center[1] = t - (t - this.#center[1]) * k;
    this.#cellPx = next;
    this.#dirty = true;
    this.#emit();
  }

  #onKey(event: KeyboardEvent): void {
    if (event.code === "Space") {
      this.#space = true;
      event.preventDefault();
      return;
    }
    if (isKey("flatMirror", event.code) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.setView(this.#turns, !this.#mirror);
      return;
    }
    if (isKey("rotateBlock", event.code) && this.#hover && !event.ctrlKey) {
      event.preventDefault();
      this.#engine.edit2d(
        this.#engine.world.request({
          type: "rotateAt",
          at: [this.#hover.at[0], this.#hover.at[1], this.#hover.at[2]],
          face: this.#face(),
          reverse: event.shiftKey,
        }),
      );
      return;
    }
    const step = isKey("layerUp", event.code) ? 1 : isKey("layerDown", event.code) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    this.setDepth(this.#depth + step * (event.shiftKey ? 4 : 1));
  }

  /**
   * The selection's bounds on this slice: filled and bright when the layer is inside it,
   * a dim outline when it lies on other layers. The first corner of a box being chosen shows
   * as one bright cell on its layer.
   */
  #drawSelection(sx: (s: number) => number, ty: (t: number) => number, px: number): void {
    const ctx = this.#ctx;
    const ratio = window.devicePixelRatio || 1;
    const rect = (a: Vec3, b: Vec3) => {
      const [ua, va] = worldToPlane(this.#axis, a);
      const [ub, vb] = worldToPlane(this.#axis, b);
      const [sa, ta] = planeToScreen(this.#orientation, ua, va);
      const [sb, tb] = planeToScreen(this.#orientation, ub, vb);
      const x = sx(Math.min(sa, sb));
      const y = ty(Math.min(ta, tb));
      return [x, y, (Math.abs(sb - sa) + 1) * px, (Math.abs(tb - ta) + 1) * px] as const;
    };
    const bounds = this.#engine.selection.get().bounds;
    if (bounds) {
      const lo: Vec3 = [bounds[0], bounds[1], bounds[2]];
      const hi: Vec3 = [bounds[3], bounds[4], bounds[5]];
      const inside = this.#depth >= (lo[this.#axis] ?? 0) && this.#depth <= (hi[this.#axis] ?? 0);
      const [x, y, w, h] = rect(lo, hi);
      if (inside) {
        ctx.fillStyle = SELECTION_FILL;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = inside ? SELECTION_LINE : SELECTION_DIM;
      ctx.lineWidth = (inside ? 2 : 1) * ratio;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    const anchor = this.#engine.anchor.get();
    if (anchor && Math.floor(anchor[this.#axis] ?? 0) === this.#depth) {
      const [x, y, w, h] = rect(anchor, anchor);
      ctx.strokeStyle = SELECTION_LINE;
      ctx.lineWidth = 2 * ratio;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
  }

  /** The stroke being drawn: the hotbar's colour, or red outlines when erasing. */
  #drawStroke(sx: (s: number) => number, ty: (t: number) => number, px: number): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    const ctx = this.#ctx;
    const color = this.#engine.hotbar.current?.color ?? "#ffffff";
    ctx.globalAlpha = stroke.erase ? 1 : 0.7;
    ctx.fillStyle = color;
    ctx.strokeStyle = ERASE_LINE;
    ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    for (const [u, v] of stroke.cells.values()) {
      const [s, t] = planeToScreen(this.#orientation, u, v);
      if (stroke.erase) ctx.strokeRect(sx(s) + 1.5, ty(t) + 1.5, px - 3, px - 3);
      else ctx.fillRect(sx(s), ty(t), px, px);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Which way turnable blocks face, when cells are big enough: an arrow in the slice's
   * plane, a diamond when they face out of it, hollow when upside down; cells of parts get
   * a small corner mark.
   */
  #drawFacings(
    s0: number,
    t0: number,
    s1: number,
    t1: number,
    sx: (s: number) => number,
    ty: (t: number) => number,
    px: number,
  ): void {
    const f = this.#fetched;
    const facing = this.#engine.facing;
    if (!f || f.axis !== this.#axis || f.depth !== this.#depth || facing.length === 0) return;
    const ctx = this.#ctx;
    const o = this.#orientation;
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.2);
    for (let t = t0; t < t1; t++)
      for (let s = s0; s < s1; s++) {
        const [u, v] = screenToPlane(o, s, t);
        const i = u - f.u0;
        const j = v - f.v0;
        if (i < 0 || j < 0 || i >= f.width || j >= f.height) continue;
        const id = f.ids[i + j * f.width] ?? 0;
        const bits = id === 0 ? 0 : (facing[id] ?? 0);
        if (bits === 0) continue;
        const x = sx(s);
        const y = ty(t);
        ctx.strokeStyle = "rgb(0 0 0 / 0.75)";
        ctx.fillStyle = "rgb(255 255 255 / 0.9)";
        if (bits & FACING_PARTS) {
          const drawn =
            px >= FOOTPRINT_PX * (window.devicePixelRatio || 1)
              ? this.#engine.partDraws.get(id)
              : undefined;
          if (drawn) {
            for (const shape of footprint(drawn, this.#axis, o)) {
              ctx.beginPath();
              shape.points.forEach(([fs, ft], n) => {
                const px0 = x + fs * px;
                const py0 = y + ft * px;
                if (n === 0) ctx.moveTo(px0, py0);
                else ctx.lineTo(px0, py0);
              });
              ctx.closePath();
              ctx.fillStyle = `#${shape.color.toString(16).padStart(6, "0")}`;
              ctx.fill();
              if (shape.outline) {
                ctx.strokeStyle = "rgb(0 0 0 / 0.55)";
                ctx.stroke();
              }
            }
            continue;
          }
          ctx.beginPath();
          ctx.moveTo(x + px * 0.62, y + px * 0.15);
          ctx.lineTo(x + px * 0.85, y + px * 0.15);
          ctx.lineTo(x + px * 0.85, y + px * 0.38);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          continue;
        }
        const side = SIDES[(bits & 7) - 1];
        if (!side) continue;
        const [du, dv] = worldToPlane(this.#axis, SIDE_VECTORS[side]);
        const along = (a: { onU: boolean; sign: 1 | -1 }) => (a.onU ? du : dv) * a.sign;
        const dx = along(o.right);
        const dy = along(o.down);
        const cx = x + px / 2;
        const cy = y + px / 2;
        const hollow = (bits & FACING_UPSIDE_DOWN) !== 0;
        ctx.beginPath();
        if (dx === 0 && dy === 0) {
          const d = px * 0.16;
          ctx.moveTo(cx, cy - d);
          ctx.lineTo(cx + d, cy);
          ctx.lineTo(cx, cy + d);
          ctx.lineTo(cx - d, cy);
        } else {
          // An arrowhead pointing the way the front faces.
          const r = px * 0.3;
          const w = px * 0.18;
          ctx.moveTo(cx + dx * r, cy + dy * r);
          ctx.lineTo(cx - dx * r * 0.4 - dy * w, cy - dy * r * 0.4 + dx * w);
          ctx.lineTo(cx - dx * r * 0.4 + dy * w, cy - dy * r * 0.4 - dx * w);
        }
        ctx.closePath();
        if (!hollow) ctx.fill();
        ctx.stroke();
      }
  }

  async #askHover(at: [number, number, number]): Promise<void> {
    const key = at.join(",");
    if (key === this.#hoverAsked) return;
    this.#hoverAsked = key;
    this.#setHover({ at, what: this.#hover?.what ?? "" });
    const what = await this.#engine.world.request({ type: "cell", at }).catch(() => null);
    if (this.#hoverAsked === key) this.#setHover({ at, what: what ?? "empty" });
  }

  #setHover(hover: GridViewState["hover"]): void {
    if (hover === null) this.#hoverAsked = "";
    this.#hover = hover;
    this.#dirty = true;
    this.#emit();
  }
}

const mix = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);

const FORWARD = new THREE.Vector3();

/** Changes whenever a 3D view's camera moves or turns enough to redraw its marker. */
function cameraKeyOf(engine: Engine): string {
  let key = "";
  for (const { camera, focused } of engine.viewCameras()) {
    const p = camera.position;
    const q = camera.quaternion;
    key += `${focused ? "*" : ""}${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)},`;
    key += `${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)};`;
  }
  return key;
}

/** The plane cells on a straight line between two cells, ends included. */
export function lineCells(
  a: readonly [number, number],
  b: readonly [number, number],
): [number, number][] {
  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const steps = Math.max(Math.abs(du), Math.abs(dv));
  if (steps === 0) return [[a[0], a[1]]];
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++)
    out.push([Math.round(a[0] + (du * i) / steps), Math.round(a[1] + (dv * i) / steps)]);
  return out;
}

/** Every plane cell of the rectangle with corners a and b. */
export function rectCells(
  a: readonly [number, number],
  b: readonly [number, number],
): [number, number][] {
  const out: [number, number][] = [];
  for (let u = Math.min(a[0], b[0]); u <= Math.max(a[0], b[0]); u++)
    for (let v = Math.min(a[1], b[1]); v <= Math.max(a[1], b[1]); v++) out.push([u, v]);
  return out;
}
