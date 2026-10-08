import * as THREE from "three/webgpu";
import type { PasteGhost } from "../world/protocol.ts";
import { BOX_EDGES } from "./cell-boxes.ts";

/** The most cells one ghost holds before the instance buffers grow. They grow by doubling. */
const START_CAPACITY = 4096;
/** Each ghost cube sits a hair inside its cell, so neighbours read as separate blocks. */
const SHRINK = 0.94;

/**
 * The clipboard as it would land where the Paste tool aims: every cell as a translucent cube in
 * its semantic's colour, and the box round them. Cell by cell for pieces up to the worker's
 * limit; past it, only the box, which still says where and how big. Drawn over the world, so a
 * ghost buried in a hill still shows.
 */
export class PasteGhostView {
  readonly object = new THREE.Group();
  readonly #material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    fog: false,
  });
  readonly #lineMaterial = new THREE.LineBasicNodeMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    fog: false,
  });
  readonly #geometry = new THREE.BoxGeometry(SHRINK, SHRINK, SHRINK);
  #cubes: THREE.InstancedMesh;
  #capacity = START_CAPACITY;
  readonly #box: THREE.LineSegments;
  readonly #boxGeometry = new THREE.BufferGeometry();
  readonly #matrix = new THREE.Matrix4();
  readonly #color = new THREE.Color();
  #shown: PasteGhost | null = null;

  constructor() {
    this.#cubes = this.#newCubes(this.#capacity);
    this.#box = new THREE.LineSegments(this.#boxGeometry, this.#lineMaterial);
    this.#box.frustumCulled = false;
    this.#box.renderOrder = 4;
    this.object.add(this.#cubes, this.#box);
    this.object.visible = false;
  }

  #newCubes(capacity: number): THREE.InstancedMesh {
    const cubes = new THREE.InstancedMesh(this.#geometry, this.#material, capacity);
    cubes.count = 0;
    cubes.frustumCulled = false;
    cubes.renderOrder = 3;
    return cubes;
  }

  /** Shows what a paste would fill, or nothing. The same ghost shown again costs nothing. */
  show(ghost: PasteGhost | null): void {
    if (ghost === null) {
      this.object.visible = false;
      this.#shown = null;
      return;
    }
    this.object.visible = true;
    if (this.#shown !== null && sameGhost(this.#shown, ghost)) return;
    this.#shown = ghost;
    const count = ghost.positions.length / 3;
    if (count > this.#capacity) {
      let capacity = this.#capacity;
      while (capacity < count) capacity *= 2;
      this.object.remove(this.#cubes);
      this.#cubes.dispose();
      this.#capacity = capacity;
      this.#cubes = this.#newCubes(capacity);
      this.object.add(this.#cubes);
    }
    for (let i = 0; i < count; i++) {
      this.#matrix.makeTranslation(
        (ghost.positions[i * 3] ?? 0) + 0.5,
        (ghost.positions[i * 3 + 1] ?? 0) + 0.5,
        (ghost.positions[i * 3 + 2] ?? 0) + 0.5,
      );
      this.#cubes.setMatrixAt(i, this.#matrix);
      this.#color.setRGB(
        (ghost.colors[i * 3] ?? 128) / 255,
        (ghost.colors[i * 3 + 1] ?? 128) / 255,
        (ghost.colors[i * 3 + 2] ?? 128) / 255,
        THREE.SRGBColorSpace,
      );
      this.#cubes.setColorAt(i, this.#color);
    }
    this.#cubes.count = count;
    this.#cubes.instanceMatrix.needsUpdate = true;
    if (this.#cubes.instanceColor) this.#cubes.instanceColor.needsUpdate = true;
    this.#cubes.visible = count > 0;

    const points = new Float32Array(BOX_EDGES.length * 3);
    BOX_EDGES.forEach(([x, y, z], i) => {
      points[i * 3] = x ? ghost.max[0] : ghost.min[0];
      points[i * 3 + 1] = y ? ghost.max[1] : ghost.min[1];
      points[i * 3 + 2] = z ? ghost.max[2] : ghost.min[2];
    });
    this.#boxGeometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
  }

  dispose(): void {
    this.#cubes.dispose();
    this.#geometry.dispose();
    this.#boxGeometry.dispose();
    this.#material.dispose();
    this.#lineMaterial.dispose();
  }
}

function sameGhost(a: PasteGhost, b: PasteGhost): boolean {
  if (a === b) return true;
  if (a.positions.length !== b.positions.length) return false;
  for (let i = 0; i < 3; i++) if (a.min[i] !== b.min[i] || a.max[i] !== b.max[i]) return false;
  for (let i = 0; i < a.positions.length; i++) if (a.positions[i] !== b.positions[i]) return false;
  for (let i = 0; i < a.colors.length; i++) if (a.colors[i] !== b.colors[i]) return false;
  return true;
}
