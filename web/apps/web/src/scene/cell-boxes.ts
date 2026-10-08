import * as THREE from "three/webgpu";

/** A cell's twelve edges as corner offsets, two points each. */
export const BOX_EDGES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
  [0, 0, 0],
  [0, 1, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 0, 1],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 0, 0],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 1],
  [0, 1, 0],
  [0, 1, 1],
  [1, 1, 0],
  [1, 1, 1],
];
/** Each box sits this far inside its cell, so the boxes of neighbouring cells stay apart. */
const INSET = 0.04;

/**
 * Many cells, each outlined on its own: what a multi-block tool would build, the
 * builders'-wand look (one box per block reads exactly which cells a click fills, where a
 * crowd of ghost blocks reads as noise). Drawn over the world so hidden cells still show.
 */
export class CellBoxes {
  readonly object: THREE.LineSegments;
  readonly #material: THREE.LineBasicNodeMaterial;
  #geometry = new THREE.BufferGeometry();
  #shown = "";

  constructor(color: number) {
    this.#material = new THREE.LineBasicNodeMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      fog: false,
    });
    this.object = new THREE.LineSegments(this.#geometry, this.#material);
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  /** `cells` is x, y, z triples; null or empty hides the boxes. */
  show(cells: Int32Array | null): void {
    const key = cells ? `${cells.length}:${cells.join()}` : "";
    if (key === this.#shown) return;
    this.#shown = key;
    if (!cells || cells.length === 0) {
      this.object.visible = false;
      return;
    }
    const lo = INSET;
    const hi = 1 - INSET;
    const points = new Float32Array((cells.length / 3) * BOX_EDGES.length * 3);
    let k = 0;
    for (let i = 0; i < cells.length; i += 3) {
      const x = cells[i] ?? 0;
      const y = cells[i + 1] ?? 0;
      const z = cells[i + 2] ?? 0;
      for (const [ex, ey, ez] of BOX_EDGES) {
        points[k++] = x + (ex ? hi : lo);
        points[k++] = y + (ey ? hi : lo);
        points[k++] = z + (ez ? hi : lo);
      }
    }
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
