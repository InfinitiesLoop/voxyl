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
  mix,
  positionWorld,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";

/**
 * Half the quad, in cells. The fade ends inside it, so the edge of the quad is never what
 * you see: from higher up the fade reaches farther and stops before the quad does.
 */
const HALF = 4000;
/** A major line every this many cells, shifted by the project's grid offset. */
const MAJOR = 16;
/** The distance fade reaches at least this far, so standing on the grid shows a neighbourhood. */
const MIN_FADE = 96;
/** Cells of distance fade per cell of height (Javier Salcedo's infinite-grid notes use 25). */
const FADE_PER_HEIGHT = 25;
/**
 * Where the minor lines end: near at ground level, farther as you climb, but much less
 * steeply than the grid as a whole, so from high up only the ground below keeps them.
 */
const MINOR_REACH = 56;
const MINOR_PER_HEIGHT = 3;
/**
 * A family of lines fades by how crowded it is on screen (cells per pixel across it), over a
 * long gradient: whole while its lines are at least ~8 pixels apart, gone by ~2.5.
 */
const CROWD_START = 0.12;
const CROWD_END = 0.4;
/**
 * Line colour and strength by night and by day (day lines are dark, so a pale sky shows them).
 * Blending happens in linear light, so a faint pale line on black comes out much brighter
 * on screen than its alpha suggests: the night values are small on purpose.
 */
const NIGHT_RGB = [0.7, 0.75, 0.82] as const;
const DAY_RGB = [0.1, 0.13, 0.17] as const;
const NIGHT_ALPHA = { minor: 0.035, major: 0.065 };
const DAY_ALPHA = { minor: 0.2, major: 0.38 };

/**
 * Cell edges on the ground (y = 0), drawn in the fragment shader so they stay one pixel
 * wide and fade out before they alias. The quad follows the camera in x and z; the lines
 * are in world space, so the grid does not slide. Blocks on the ground hide it.
 */
export class GroundGrid {
  readonly group = new THREE.Group();
  readonly #offsetX = uniform(0);
  readonly #offsetZ = uniform(0);
  readonly #daylight = uniform(1);
  readonly #material: THREE.Material;

  constructor() {
    const offsetX = this.#offsetX;
    const offsetZ = this.#offsetZ;
    const daylight = this.#daylight;
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
      const fadeDist = min(max(height.mul(FADE_PER_HEIGHT), float(MIN_FADE)), float(HALF * 0.85));
      // A long gradient: the grid thins from a tenth of the way out to the end.
      const fade = smoothstep(fadeDist, fadeDist.mul(0.1), dist);

      // Each family of lines (along x, along z) fades on its own by how crowded it is, so
      // lines running away from the camera outlast the ones packed toward the horizon.
      const lines = (at: THREE.Node<"vec2">, per: number) => {
        const p = at.div(per);
        const fw = max(fwidth(p), vec2(1e-4, 1e-4));
        const g = abs(fract(p.sub(0.5)).sub(0.5));
        const onX = float(1).sub(min(g.x.div(fw.x), float(1)));
        const onZ = float(1).sub(min(g.y.div(fw.y), float(1)));
        const keepX = smoothstep(CROWD_END, CROWD_START, fw.x);
        const keepZ = smoothstep(CROWD_END, CROWD_START, fw.y);
        return max(onX.mul(keepX), onZ.mul(keepZ));
      };
      const minorEnd = height.mul(MINOR_PER_HEIGHT).add(MINOR_REACH);
      const minor = lines(xz, 1).mul(smoothstep(minorEnd, minorEnd.mul(0.15), dist));
      const major = lines(xz.sub(vec2(offsetX, offsetZ)), MAJOR);

      const minorAlpha = mix(float(NIGHT_ALPHA.minor), float(DAY_ALPHA.minor), daylight);
      const majorAlpha = mix(float(NIGHT_ALPHA.major), float(DAY_ALPHA.major), daylight);
      const alpha = max(minor.mul(minorAlpha), major.mul(majorAlpha)).mul(fade);
      const rgb = mix(vec3(...NIGHT_RGB), vec3(...DAY_RGB), daylight);
      return vec4(rgb, alpha);
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

  /** The sky's daylight, 0 at night to 1 by day: dark lines by day, faint pale ones at night. */
  setDaylight(daylight: number): void {
    this.#daylight.value = daylight;
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
