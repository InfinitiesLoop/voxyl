// A 2D view of one slice of the world: a plan of a layer, or a cut across x or z. It is a lens
// on the world in the world worker (CLAUDE.md principle 2): it asks for the cells it shows and
// colours them from the same looks table the 3D view uses, and owns nothing about the world.
// Read-only for now; the editor (Phase 3) adds placing.

import type { Direction } from "@voxyl/core";
import * as THREE from "three/webgpu";
import { isKey } from "../editor/keymap.ts";
import type { Engine } from "../scene/Engine.ts";
import type { SliceWindow } from "../scene/slice-guide.ts";
import { MAX_SLICE_CELLS } from "../world/protocol.ts";
import {
  type Orientation,
  orientationFor,
  planeToScreen,
  planeToWorld,
  type SliceAxis,
  screenToPlane,
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
  #drag: { x: number; y: number } | null = null;
  #frame = 0;
  /** Where the 3D cameras were last drawn. */
  #cameraKey = "";
  /** Draw the 3D views' cameras. */
  #cameras = true;
  /** This view's slice is the one the 3D views draw. */
  #active = false;
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
    c.addEventListener("pointerup", () => this.#onUp(), { signal });
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
    return { axis: this.#axis, depth: this.#depth, cellPx: this.#cellPx, hover: this.#hover };
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

  setDepth(depth: number): void {
    this.#depth = Math.round(depth);
    this.#changed();
  }

  /** Makes this view's slice the one the 3D views draw, or stops. */
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    this.#guideKey = "";
    if (active) this.#dirty = true;
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
    this.#orientation = orientationFor(this.#axis, this.#north);
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
              if (id !== 0) {
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
    const key = `${this.#active}:${Object.values(window).join()}`;
    if (key === this.#guideKey) return;
    this.#guideKey = key;
    this.#engine.setFlatSlice(this, window);
    if (this.#active) this.#engine.setSliceGuide(this, window);
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

  #onDown(event: PointerEvent): void {
    this.canvas.focus();
    this.canvas.setPointerCapture(event.pointerId);
    this.#drag = { x: event.clientX, y: event.clientY };
  }

  #onMove(event: PointerEvent): void {
    if (this.#drag) {
      this.#center[0] -= (event.clientX - this.#drag.x) / this.#cellPx;
      this.#center[1] -= (event.clientY - this.#drag.y) / this.#cellPx;
      this.#drag = { x: event.clientX, y: event.clientY };
      this.#dirty = true;
    }
    const [s, t] = this.#toScreenCell(event);
    const [u, v] = screenToPlane(this.#orientation, Math.floor(s), Math.floor(t));
    const at = planeToWorld(this.#axis, this.#depth, u, v);
    void this.#askHover(at);
  }

  #onUp(): void {
    this.#drag = null;
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
    const step = isKey("layerUp", event.code) ? 1 : isKey("layerDown", event.code) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    this.setDepth(this.#depth + step * (event.shiftKey ? 4 : 1));
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
