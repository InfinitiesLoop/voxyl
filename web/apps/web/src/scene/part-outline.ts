import { archTriangles, isExclusive, microBoxes } from "@voxyl/shapes";
import * as THREE from "three/webgpu";
import { BOX_EDGES } from "./cell-boxes.ts";

/** How far an outline stands off the geometry, so it isn't hidden in the faces it traces. */
const INFLATE = 0.006;

/**
 * The edges of one placed part: its boxes (a microblock) or the outline of its triangles (an
 * architecture shape). Shows the part the crosshair aims at, and, drawn over everything, the
 * part a click would place.
 */
export class PartOutline {
  readonly object: THREE.LineSegments;
  readonly #material: THREE.LineBasicNodeMaterial;
  #geometry = new THREE.BufferGeometry();
  #shown = "";

  constructor(color: number, options: { readonly overlay: boolean; readonly opacity?: number }) {
    this.#material = new THREE.LineBasicNodeMaterial({
      color,
      transparent: true,
      opacity: options.opacity ?? 0.9,
      depthTest: !options.overlay,
      fog: false,
    });
    this.object = new THREE.LineSegments(this.#geometry, this.#material);
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = options.overlay ? 3 : 1;
  }

  show(cell: readonly number[] | null, shape?: string, slot?: number): void {
    if (!cell || shape === undefined || slot === undefined) {
      this.object.visible = false;
      return;
    }
    const key = `${cell.join()}|${shape}|${slot}`;
    if (key === this.#shown) {
      this.object.visible = true;
      return;
    }
    const points = partEdges(cell, shape, slot);
    if (points.length === 0) {
      this.object.visible = false;
      return;
    }
    this.#shown = key;
    this.#geometry.dispose();
    this.#geometry = new THREE.BufferGeometry();
    this.#geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
    this.object.geometry = this.#geometry;
    this.object.visible = true;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
  }
}

/** Line segments (xyz xyz) tracing a part placed in `cell`, in world coordinates. */
export function partEdges(cell: readonly number[], shape: string, slot: number): Float32Array {
  const [cx = 0, cy = 0, cz = 0] = cell;
  if (isExclusive(shape)) {
    const tris = archTriangles(shape, slot);
    const out = new Float32Array((tris.length / 9) * 18);
    let k = 0;
    for (let i = 0; i + 8 < tris.length; i += 9) {
      for (let e = 0; e < 3; e++) {
        const a = i + e * 3;
        const b = i + ((e + 1) % 3) * 3;
        out[k++] = cx + (tris[a] ?? 0);
        out[k++] = cy + (tris[a + 1] ?? 0);
        out[k++] = cz + (tris[a + 2] ?? 0);
        out[k++] = cx + (tris[b] ?? 0);
        out[k++] = cy + (tris[b + 1] ?? 0);
        out[k++] = cz + (tris[b + 2] ?? 0);
      }
    }
    return out;
  }
  const boxes = microBoxes(shape, slot);
  const out = new Float32Array(boxes.length * BOX_EDGES.length * 3);
  let k = 0;
  for (const box of boxes) {
    const lo = [box[0] / 8 - INFLATE, box[1] / 8 - INFLATE, box[2] / 8 - INFLATE];
    const hi = [box[3] / 8 + INFLATE, box[4] / 8 + INFLATE, box[5] / 8 + INFLATE];
    for (const [ex, ey, ez] of BOX_EDGES) {
      out[k++] = cx + ((ex ? hi[0] : lo[0]) ?? 0);
      out[k++] = cy + ((ey ? hi[1] : lo[1]) ?? 0);
      out[k++] = cz + ((ez ? hi[2] : lo[2]) ?? 0);
    }
  }
  return out;
}
