import {
  abs,
  cameraPosition,
  Fn,
  float,
  fract,
  fwidth,
  length,
  max,
  min,
  positionWorld,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";

/**
 * Half the quad, in cells. The fade ends inside it, so the edge of the quad is never what
 * you see: from higher up the fade reaches farther (about 25 cells of fade per cell of
 * height, the ratio from Javier Salcedo's infinite-grid notes) and stops before the quad does.
 */
const HALF = 4000;
/** A major line every this many cells, shifted by the project's grid offset. */
const MAJOR = 16;
/** Fade at least this far, so standing on the grid still shows a neighbourhood. */
const MIN_FADE = 64;

/**
 * Cell edges on the ground (y = 0), drawn in the fragment shader so they stay one pixel
 * wide and fade out before they alias. The quad follows the camera in x and z; the lines
 * are in world space, so the grid does not slide. Blocks on the ground hide it.
 */
export class GroundGrid {
  readonly group = new THREE.Group();
  readonly #offsetX = uniform(0);
  readonly #offsetZ = uniform(0);
  readonly #material: THREE.Material;

  constructor() {
    const offsetX = this.#offsetX;
    const offsetZ = this.#offsetZ;
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;
    // Lose a coplanar fight with a block's bottom face.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    material.colorNode = Fn(() => {
      const xz = positionWorld.xz;
      const dist = length(xz.sub(cameraPosition.xz));
      const height = max(abs(cameraPosition.y), float(1));
      const fadeDist = min(max(height.mul(25), float(MIN_FADE)), float(HALF * 0.85));
      const fade = smoothstep(fadeDist, fadeDist.mul(0.2), dist);
      // Minor lines give up earlier, so the far grid is only the majors and stays quiet.
      const minorFade = smoothstep(fadeDist.mul(0.28), fadeDist.mul(0.04), dist);

      const fw = max(fwidth(xz), vec2(1e-4, 1e-4));
      const g = abs(fract(xz.sub(0.5)).sub(0.5));
      const minor = float(1).sub(min(min(g.x.div(fw.x), g.y.div(fw.y)), float(1)));

      const majorXz = xz.sub(vec2(offsetX, offsetZ));
      const mg = abs(fract(majorXz.div(MAJOR).sub(0.5)).sub(0.5));
      const mw = max(fwidth(majorXz.div(MAJOR)), vec2(1e-4, 1e-4));
      const major = float(1).sub(min(min(mg.x.div(mw.x), mg.y.div(mw.y)), float(1)));

      const alpha = max(minor.mul(0.12).mul(minorFade), major.mul(0.22).mul(fade));
      return vec4(0.72, 0.76, 0.8, alpha);
    })();
    this.#material = material;
    const geometry = new THREE.PlaneGeometry(HALF * 2, HALF * 2);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  /** Where the major lines fall: the project's major grid offset (0..15 in x and z). */
  setOffset(offset: readonly [number, number]): void {
    this.#offsetX.value = offset[0];
    this.#offsetZ.value = offset[1];
  }

  /** Keeps the quad under the camera. Only x and z: the grid stays on the ground. */
  follow(camera: THREE.Vector3Like): void {
    this.group.position.set(camera.x, 0, camera.z);
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  dispose(): void {
    const mesh = this.group.children[0] as THREE.Mesh;
    mesh.geometry.dispose();
    this.#material.dispose();
  }
}
