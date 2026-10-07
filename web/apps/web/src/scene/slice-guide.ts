import * as THREE from "three/webgpu";
import { planeToWorld, type SliceAxis } from "../views/plane.ts";

/** What a 2D view is showing: one layer along `axis`, the plane cells [u0, u1) × [v0, v1). */
export interface SliceWindow {
  readonly axis: SliceAxis;
  readonly depth: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/** Amber, so it never reads as the (cyan) selection. */
const COLOR = 0xfbbf24;
/** The edges where nothing hides them, and where blocks do. */
const EDGE_OPACITY = 0.8;
const HIDDEN_EDGE_OPACITY = 0.22;
/** The slab's faces: a tint you notice, not a wall. */
const FILL_OPACITY = 0.05;

/**
 * Where the active 2D view cuts the world, drawn in the 3D views: the one-cell slab of its
 * layer, as wide as the 2D view's window, so panning or zooming the 2D view moves it. Its
 * edges stay faintly visible through blocks; the slab is only a light tint.
 */
export class SliceGuide {
  readonly object = new THREE.Group();
  readonly #box = new THREE.BoxGeometry(1, 1, 1);
  readonly #edges = new THREE.EdgesGeometry(this.#box);
  readonly #fill: THREE.MeshBasicNodeMaterial;
  readonly #line: THREE.LineBasicNodeMaterial;
  readonly #hidden: THREE.LineBasicNodeMaterial;
  #window: SliceWindow | null = null;

  constructor() {
    this.#fill = new THREE.MeshBasicNodeMaterial({
      color: COLOR,
      transparent: true,
      opacity: FILL_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.#line = new THREE.LineBasicNodeMaterial({
      color: COLOR,
      transparent: true,
      opacity: EDGE_OPACITY,
      fog: false,
    });
    this.#hidden = new THREE.LineBasicNodeMaterial({
      color: COLOR,
      transparent: true,
      opacity: HIDDEN_EDGE_OPACITY,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const fill = new THREE.Mesh(this.#box, this.#fill);
    const hidden = new THREE.LineSegments(this.#edges, this.#hidden);
    const line = new THREE.LineSegments(this.#edges, this.#line);
    fill.renderOrder = 2;
    hidden.renderOrder = 2;
    line.renderOrder = 3;
    for (const part of [fill, hidden, line]) {
      part.frustumCulled = false;
      this.object.add(part);
    }
    this.object.visible = false;
  }

  /** The window to draw, or null when no 2D view is open. */
  get window(): SliceWindow | null {
    return this.#window;
  }

  show(window: SliceWindow | null): void {
    this.#window = window;
    if (!window) return;
    const a = planeToWorld(window.axis, window.depth, window.u0, window.v0);
    const b = planeToWorld(window.axis, window.depth + 1, window.u1, window.v1);
    const size = [0, 1, 2].map((i) => Math.max(Math.abs((b[i] ?? 0) - (a[i] ?? 0)), 0.01));
    const centre = [0, 1, 2].map((i) => ((a[i] ?? 0) + (b[i] ?? 0)) / 2);
    // A hair larger than the cells, so its edges aren't buried in the faces they run along.
    this.object.scale.set((size[0] ?? 1) + 0.02, (size[1] ?? 1) + 0.02, (size[2] ?? 1) + 0.02);
    this.object.position.set(centre[0] ?? 0, centre[1] ?? 0, centre[2] ?? 0);
  }

  dispose(): void {
    this.#box.dispose();
    this.#edges.dispose();
    this.#fill.dispose();
    this.#line.dispose();
    this.#hidden.dispose();
  }
}
