import { placementGrid, SIDE_VECTORS } from "@voxyl/shapes";
import * as THREE from "three/webgpu";
import type { PartGrid } from "../world/editing.ts";

/** How far the grid stands off the face it is drawn on, so it doesn't z-fight. */
const LIFT = 0.004;

/**
 * Where a click on the aimed face would put a shaped part: the shape's placement zones as
 * dark lines across the face (a microblock's border and the edges of the zones that pick its
 * slot), at the depth the ray met it. Architecture shapes orient from the click and have no
 * zones, so nothing is drawn for them.
 */
export class PlaceGrid {
  readonly object: THREE.LineSegments;
  readonly #material: THREE.LineBasicNodeMaterial;
  #geometry = new THREE.BufferGeometry();
  #shown = "";

  constructor() {
    this.#material = new THREE.LineBasicNodeMaterial({
      color: 0x0d0d14,
      transparent: true,
      opacity: 0.9,
      fog: false,
    });
    this.object = new THREE.LineSegments(this.#geometry, this.#material);
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
  }

  show(grid: PartGrid | null): void {
    const lines = grid ? placementGrid(grid.shape) : null;
    if (!grid || !lines || lines.length === 0) {
      this.object.visible = false;
      return;
    }
    const key = `${grid.cell.join()}|${grid.side}|${grid.shape}|${grid.point.map((v) => v.toFixed(3)).join()}`;
    if (key !== this.#shown) {
      this.#shown = key;
      this.#geometry.dispose();
      this.#geometry = new THREE.BufferGeometry();
      this.#geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(gridPoints(grid, lines), 3),
      );
      this.object.geometry = this.#geometry;
    }
    this.object.visible = true;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
  }
}

/** The zone lines laid on the face, in world coordinates (xyz xyz per segment). */
export function gridPoints(grid: PartGrid, lines: Float32Array): Float32Array {
  const n = SIDE_VECTORS[grid.side] ?? [0, 1, 0];
  const u = SIDE_VECTORS[(grid.side + 2) % 6] ?? [1, 0, 0];
  const v = SIDE_VECTORS[(grid.side + 4) % 6] ?? [0, 0, 1];
  const axis = Math.abs(n[0]) > 0.5 ? 0 : Math.abs(n[1]) > 0.5 ? 1 : 2;
  const center = [grid.cell[0] + 0.5, grid.cell[1] + 0.5, grid.cell[2] + 0.5];
  center[axis] = grid.point[axis] ?? 0;
  const out = new Float32Array((lines.length / 2) * 3);
  for (let i = 0, k = 0; i < lines.length; i += 2) {
    const a = lines[i] ?? 0;
    const b = lines[i + 1] ?? 0;
    for (let c = 0; c < 3; c++) {
      out[k++] = (center[c] ?? 0) + (u[c] ?? 0) * a + (v[c] ?? 0) * b + (n[c] ?? 0) * LIFT;
    }
  }
  return out;
}
