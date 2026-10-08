import * as THREE from "three/webgpu";
import { BOX_EDGES } from "./cell-boxes.ts";

/** A box of cells outlined in one colour, over everything. The cutaway's bounds are drawn with it. */
export class BoxFrame {
  readonly object: THREE.LineSegments;
  readonly #material: THREE.LineBasicNodeMaterial;
  #geometry = new THREE.BufferGeometry();
  #shown = "";

  constructor(color: number) {
    this.#material = new THREE.LineBasicNodeMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      fog: false,
    });
    this.object = new THREE.LineSegments(this.#geometry, this.#material);
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
  }

  /** Outlines a box of cells (both corners inclusive), or hides the frame. */
  show(box: { readonly min: readonly number[]; readonly max: readonly number[] } | null): void {
    if (!box) {
      this.object.visible = false;
      this.#shown = "";
      return;
    }
    const key = `${box.min.join()}|${box.max.join()}`;
    if (key !== this.#shown) {
      this.#shown = key;
      const points = new Float32Array(BOX_EDGES.length * 3);
      BOX_EDGES.forEach(([x, y, z], i) => {
        points[i * 3] = x ? (box.max[0] ?? 0) + 1 : (box.min[0] ?? 0);
        points[i * 3 + 1] = y ? (box.max[1] ?? 0) + 1 : (box.min[1] ?? 0);
        points[i * 3 + 2] = z ? (box.max[2] ?? 0) + 1 : (box.min[2] ?? 0);
      });
      this.#geometry.dispose();
      this.#geometry = new THREE.BufferGeometry();
      this.#geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
      this.object.geometry = this.#geometry;
    }
    this.object.visible = true;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
  }
}
