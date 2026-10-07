import {
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  cross,
  dot,
  Fn,
  float,
  floor,
  fract,
  fwidth,
  If,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  output,
  positionLocal,
  positionWorld,
  pow,
  rangeFogFactor,
  select,
  sin,
  smoothstep,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { Rgb, SkyState, Vec3 } from "./sky-model.ts";

/**
 * Minecraft fogs its sky disc (16 above the eye) out to the render distance, so the sky
 * fades from its own colour overhead to the fog colour at the horizon as k / height; k is
 * 16 over a render distance of about 200.
 */
const SKY_FOG = 0.08;
/** Half the side of the sun's and moon's squares, at unit distance (Minecraft: 30 and 20 at 100). */
const SUN_SIZE = 0.15;
const MOON_SIZE = 0.1;
/** Star grid cells along a side of each face of the cube the stars sit on, and the chance of a star. */
const STAR_GRID = 96;
const STAR_CHANCE = 1500 / (6 * STAR_GRID * STAR_GRID);
/** A star's half size at unit distance (Minecraft: 0.15 to 0.25 across at 100). */
const STAR_SIZE = 0.00075;

const makeVec3 = () => uniform(new THREE.Vector3());
const makeFloat = (value: number) => uniform(value);
type Vec3Uniform = ReturnType<typeof makeVec3>;
type FloatUniform = ReturnType<typeof makeFloat>;
type V3 = THREE.Node<"vec3">;

interface SkyUniforms {
  readonly sun: Vec3Uniform;
  readonly pole: Vec3Uniform;
  readonly zenith: Vec3Uniform;
  readonly horizon: Vec3Uniform;
  readonly glow: Vec3Uniform;
  readonly glowAlpha: FloatUniform;
  readonly glowSide: Vec3Uniform;
  readonly stars: FloatUniform;
  readonly fogNear: FloatUniform;
  readonly fogFar: FloatUniform;
}

/** A pseudo-random number in 0..1 for a small 2D integer point. */
const hash = (p: THREE.Node<"vec2">) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

/** Minecraft's colours are sRGB; three wants linear light out. */
const toLinear = (c: V3) => pow(max(c, vec3(0, 0, 0)), vec3(2.2, 2.2, 2.2));

/**
 * The sky without sun, moon or stars (sRGB) along unit direction `d`: the zenith colour
 * fading into the horizon's, the horizon toward the sun tinted by the sunrise or sunset, and
 * the glow itself (Minecraft's fan: an ellipse on the sun's side, wider than tall, flatter as
 * it fades). Distant terrain fogs into this, so it melts into the sky behind it.
 */
function skyBase(d: V3, u: SkyUniforms): V3 {
  const up = d.y;
  const toward = max(dot(d, u.glowSide), 0);
  const horizon = mix(u.horizon, u.glow, u.glowAlpha.mul(toward));
  const fade = clamp(float(SKY_FOG).div(max(up, 1e-4)), 0, 1);
  const above = mix(u.zenith, horizon, fade);
  // Below the horizon, a little darker toward the ground.
  const color = above.mul(mix(float(1), float(0.6), smoothstep(0, 0.6, up.negate())));
  // The glow, on a plane one unit toward its side: 1.2 wide, 0.4 tall at its strongest.
  const forward = max(toward, 1e-3);
  const across = dot(d, cross(vec3(0, 1, 0), u.glowSide))
    .div(forward)
    .div(1.2);
  const height = up.div(forward).div(u.glowAlpha.mul(0.4).add(1e-3));
  const fan = clamp(float(1).sub(length(vec2(across, height))), 0, 1);
  const glowAmount = u.glowAlpha.mul(fan).mul(select(toward.greaterThan(1e-3), 1, 0));
  return mix(color, u.glow, glowAmount);
}

/** A square of pixels facing direction `axis` (sun or moon): its pixel coordinates in -1..1, or out of range. */
function squareAt(d: V3, axis: V3, pole: V3, size: number) {
  const x = dot(d, axis);
  const side = cross(axis, pole);
  const scale = max(x, 1e-4).mul(size);
  const p = vec2(dot(d, pole).div(scale), dot(d, side).div(scale));
  const inside = x.greaterThan(0).and(max(abs(p.x), abs(p.y)).lessThan(1));
  return { p, inside };
}

/** The sun: a white core in a yellow halo, 16 pixels across, added to the sky. */
function sunColor(d: V3, u: SkyUniforms): V3 {
  const { p, inside } = squareAt(d, u.sun, u.pole, SUN_SIZE);
  const pixel = floor(p.mul(8)).add(0.5).div(8);
  const ring = max(abs(pixel.x), abs(pixel.y));
  const halo = pow(clamp(float(1).sub(ring).div(0.5), 0, 1), float(1.5));
  const color = select(
    ring.lessThan(0.45),
    vec3(1, 1, 0.92),
    vec3(1, 0.8, 0.4).mul(halo).mul(0.55),
  );
  return select(inside, color, vec3(0, 0, 0));
}

/** The moon's 8 x 8 pixels; # is a crater. The outer ring is its rim. */
const MOON = [
  "........",
  "..##....",
  "..##..#.",
  "........",
  ".#...##.",
  ".....##.",
  "...#....",
  "........",
];

/** MOON as one bit a pixel (bit y * 8 + x): the top four rows, then the bottom four. */
const MOON_CRATERS = (() => {
  const words = [0, 0];
  MOON.forEach((row, y) => {
    for (let x = 0; x < 8; x++) {
      const i = y * 8 + x;
      if (row[x] === "#") words[i >> 5] = ((words[i >> 5] ?? 0) | (1 << (i & 31))) >>> 0;
    }
  });
  return words as [number, number];
})();

/** The moon: a pale grey square of 8 x 8 pixels with a few craters and a darker rim. */
function moonColor(d: V3, u: SkyUniforms): V3 {
  const { p, inside } = squareAt(d, u.sun.negate(), u.pole, MOON_SIZE);
  const cell = clamp(floor(p.mul(4)).add(4), 0, 7);
  const rim = max(abs(cell.x.sub(3.5)), abs(cell.y.sub(3.5))).greaterThan(3);
  const index = uint(cell.y.mul(8).add(cell.x));
  const row = select(index.lessThan(uint(32)), uint(MOON_CRATERS[0]), uint(MOON_CRATERS[1]));
  const crater = row
    .shiftRight(index.bitAnd(uint(31)))
    .bitAnd(uint(1))
    .equal(uint(1));
  const tone = select(rim, float(0.72), select(crater, float(0.76), float(0.92)));
  return select(inside, vec3(0.8, 0.82, 0.86).mul(tone), vec3(0, 0, 0));
}

/**
 * Stars fixed to the sky, so they turn with the sun: one in STAR_CHANCE cells of a grid on
 * each face of a cube around the eye, each a small square at least a pixel across.
 */
function starColor(d: V3, u: SkyUniforms): V3 {
  const c = vec3(dot(d, u.sun), dot(d, u.pole), dot(d, cross(u.sun, u.pole)));
  const a = abs(c);
  const onX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const onY = a.y.greaterThanEqual(a.z);
  const major = select(onX, a.x, select(onY, a.y, a.z));
  const flat = select(onX, c.yz, select(onY, c.xz, c.xy)).div(major);
  const face = select(onX, float(0), select(onY, float(2), float(4))).add(
    select(select(onX, c.x, select(onY, c.y, c.z)).greaterThan(0), 0, 1),
  );
  const grid = flat.mul(0.5).add(0.5).mul(STAR_GRID);
  const cell = floor(grid);
  const id = cell.add(vec2(face.mul(STAR_GRID), face.mul(7)));
  const present = hash(id).lessThan(STAR_CHANCE);
  const offset = vec2(hash(id.add(31)), hash(id.add(57)))
    .mul(0.6)
    .add(0.2);
  // Distance in radians, about (a cube face is 2 wide over a quarter turn near its middle).
  const toStar = grid
    .sub(cell)
    .sub(offset)
    .mul(2 / STAR_GRID);
  const dist = max(abs(toStar.x), abs(toStar.y));
  const size = float(STAR_SIZE).mul(hash(id.add(83)).mul(0.66).add(1));
  const pixel = max(length(fwidth(d)), 1e-6);
  const radius = max(size, pixel.mul(0.7));
  const cover = clamp(radius.sub(dist).div(pixel).add(0.5), 0, 1);
  const level = cover.mul(size.div(radius).mul(size.div(radius))).mul(u.stars);
  return vec3(1, 1, 1).mul(select(present, level, float(0)));
}

/**
 * The sky behind the world and the distance fog in front of it, both following a SkyState
 * (see sky-model.ts). The fog takes the sky's colour along each view ray, so faraway terrain
 * fades into whatever sky is behind it.
 *
 * The sky is a sphere around the eye drawn at the far plane after the opaque world, depth
 * tested, so it shades only pixels the world leaves empty (three's scene background shades
 * every pixel first). The fog finds the sky colour only for fragments it actually fogs.
 */
export class Sky {
  readonly #u: SkyUniforms = {
    sun: makeVec3(),
    pole: makeVec3(),
    zenith: makeVec3(),
    horizon: makeVec3(),
    glow: makeVec3(),
    glowAlpha: makeFloat(0),
    glowSide: makeVec3(),
    stars: makeFloat(0),
    fogNear: makeFloat(175),
    fogFar: makeFloat(500),
  };
  /** Add to the scene. */
  readonly mesh: THREE.Mesh;
  /** For scene.fogNode. */
  readonly fog: THREE.Node;

  constructor() {
    const u = this.#u;
    const material = new THREE.NodeMaterial();
    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.fog = false;
    material.lights = false;
    // Turned with the camera but never moved (w = 0), and pushed to the far plane (z = w).
    const view = modelViewMatrix.mul(vec4(positionLocal, 0));
    const clip = cameraProjectionMatrix.mul(vec4(view.xyz, 1));
    material.vertexNode = vec4(clip.x, clip.y, clip.w, clip.w);
    material.colorNode = Fn(() => {
      const d = normalize(positionLocal).toVar();
      const shown = smoothstep(-0.004, 0.004, d.y);
      const base = skyBase(d, u);
      const fade = float(1).sub(clamp(float(SKY_FOG).div(max(d.y, 1e-4)), 0, 1));
      const lights = sunColor(d, u).add(moonColor(d, u)).mul(shown).add(starColor(d, u).mul(fade));
      return vec4(toLinear(base.add(lights)), 1);
    })();
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    this.mesh.name = "Sky";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = Number.MAX_SAFE_INTEGER;

    this.fog = Fn(() => {
      const amount = rangeFogFactor(u.fogNear, u.fogFar).toVar();
      const color = vec3(0, 0, 0).toVar();
      If(amount.greaterThan(0), () => {
        color.assign(toLinear(skyBase(normalize(positionWorld.sub(cameraPosition)), u)));
      });
      return vec4(mix(output.rgb, color, amount), output.a);
    })();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  set(state: SkyState): void {
    const u = this.#u;
    setVec(u.sun, state.sun);
    setVec(u.pole, state.pole);
    setVec(u.zenith, state.zenith);
    setVec(u.horizon, state.horizon);
    setVec(u.glow, state.glow);
    setVec(u.glowSide, state.glowSide);
    u.glowAlpha.value = state.glowAlpha;
    u.stars.value = state.stars;
  }

  /** Terrain is clear up to `near` and fully fogged from `far`, in cells from the eye. */
  setFogRange(near: number, far: number): void {
    this.#u.fogNear.value = near;
    this.#u.fogFar.value = far;
  }
}

function setVec(target: Vec3Uniform, value: Vec3 | Rgb): void {
  target.value.set(value[0], value[1], value[2]);
}
