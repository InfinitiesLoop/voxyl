import * as THREE from "three/webgpu";

/** How far the outline stands off the cells, so it isn't buried in the faces it traces. */
const LIFT = 0.012;

/**
 * The selection, drawn as its silhouette. Depth is ignored so a box stays visible through
 * the blocks inside it.
 */
export class SelectionOutline {
  readonly object: THREE.LineSegments;
  #geometry = new THREE.BufferGeometry();
  readonly #material: THREE.LineBasicNodeMaterial;

  constructor() {
    this.#material = new THREE.LineBasicNodeMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.95,
      fog: false,
      depthTest: false,
    });
    this.object = new THREE.LineSegments(this.#geometry, this.#material);
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
  }

  /** `lines` are xyz xyz segment endpoints in cell-corner coordinates. */
  show(lines: Float32Array): void {
    this.#geometry.dispose();
    this.#geometry = new THREE.BufferGeometry();
    this.object.geometry = this.#geometry;
    if (lines.length < 6) {
      this.object.visible = false;
      return;
    }
    this.#geometry.setAttribute("position", new THREE.BufferAttribute(lift(lines), 3));
    this.object.visible = true;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
  }
}

/** Pushes every point a short step away from the outline's centre. */
function lift(lines: Float32Array): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < lines.length; i += 3) {
    const x = lines[i] ?? 0;
    const y = lines[i + 1] ?? 0;
    const z = lines[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const out = new Float32Array(lines.length);
  for (let i = 0; i < lines.length; i += 3) {
    const x = lines[i] ?? 0;
    const y = lines[i + 1] ?? 0;
    const z = lines[i + 2] ?? 0;
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    out[i] = x + (dx / len) * LIFT;
    out[i + 1] = y + (dy / len) * LIFT;
    out[i + 2] = z + (dz / len) * LIFT;
  }
  return out;
}
