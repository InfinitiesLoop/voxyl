import * as THREE from "three/webgpu";
import type { Aim } from "../world/editing.ts";

/** How far the outline stands off the cell, so it isn't hidden in the faces it traces. */
const INFLATE = 0.004;

/**
 * What the crosshair aims at, Minecraft style: the edges of the cell it hits, or, aiming at
 * the ground plane, the square on the ground where a block would go.
 */
export class TargetOutline {
  readonly object: THREE.LineSegments;
  readonly #material: THREE.LineBasicNodeMaterial;

  constructor() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    this.#material = new THREE.LineBasicNodeMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.7,
      fog: false,
    });
    this.object = new THREE.LineSegments(geometry, this.#material);
    this.object.visible = false;
    this.object.renderOrder = 1;
    this.object.frustumCulled = false;
  }

  show(aim: Aim | null): void {
    if (!aim) {
      this.object.visible = false;
      return;
    }
    const o = this.object;
    if (aim.hit) {
      const [x, y, z] = aim.hit;
      o.position.set(x + 0.5, y + 0.5, z + 0.5);
      o.scale.setScalar(1 + INFLATE * 2);
      this.#material.color.setHex(0x111111);
    } else if (aim.place) {
      // A flat square just above the ground plane.
      const [x, y, z] = aim.place;
      o.position.set(x + 0.5, y + INFLATE, z + 0.5);
      o.scale.set(1, INFLATE, 1);
      this.#material.color.setHex(0xf0f0f0);
    }
    o.visible = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.#material.dispose();
  }
}
