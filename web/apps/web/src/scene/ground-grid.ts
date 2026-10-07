import * as THREE from "three/webgpu";

/** Cells the grid reaches from its centre each way. */
const HALF = 96;
/** The grid moves in steps of this many cells, so its lines stay on cell edges. */
const SNAP = 16;
const MAJOR = 16;

/**
 * Faint lines on the ground plane (y = 0, where the editor places blocks when the crosshair
 * meets nothing), with a stronger line every 16 cells from the project's grid offset. It
 * follows the camera in steps, so it seems to go on forever. Blocks on the ground hide it.
 */
export class GroundGrid {
  readonly group = new THREE.Group();
  readonly #minor: THREE.LineSegments;
  readonly #major: THREE.LineSegments;
  #offset: readonly [number, number] = [0, 0];

  constructor() {
    const material = (opacity: number) =>
      new THREE.LineBasicNodeMaterial({
        color: 0xffffff,
        transparent: true,
        opacity,
        depthWrite: false,
      });
    this.#minor = new THREE.LineSegments(lines(1, 0), material(0.07));
    this.#major = new THREE.LineSegments(lines(MAJOR, 0), material(0.2));
    for (const l of [this.#minor, this.#major]) {
      l.frustumCulled = false;
      this.group.add(l);
    }
  }

  /** Where the major lines fall: the project's major grid offset (0..15 in x and z). */
  setOffset(offset: readonly [number, number]): void {
    if (offset[0] === this.#offset[0] && offset[1] === this.#offset[1]) return;
    this.#offset = offset;
    this.#major.geometry.dispose();
    this.#major.geometry = lines(MAJOR, 0, offset);
  }

  /** Centres the grid under the camera. */
  follow(camera: THREE.Vector3Like): void {
    this.group.position.set(
      Math.round(camera.x / SNAP) * SNAP,
      0,
      Math.round(camera.z / SNAP) * SNAP,
    );
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  dispose(): void {
    for (const l of [this.#minor, this.#major]) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
  }
}

/** Lines every `step` cells across the grid's square, shifted by `offset`, at height `y`. */
function lines(step: number, y: number, offset: readonly [number, number] = [0, 0]) {
  const points: number[] = [];
  const first = (o: number) => -HALF + ((((o - -HALF) % step) + step) % step);
  for (let x = first(offset[0]); x <= HALF; x += step) points.push(x, y, -HALF, x, y, HALF);
  for (let z = first(offset[1]); z <= HALF; z += step) points.push(-HALF, y, z, HALF, y, z);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}
