import { FACES } from "@voxyl/mesher";
import {
  attribute,
  clamp,
  dot,
  Fn,
  float,
  floor,
  int,
  ivec3,
  max,
  mix,
  modelWorldMatrix,
  positionGeometry,
  pow,
  select,
  texture,
  uint,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { LightVolume, LinearTexture } from "./light-volume.ts";

/** The palette texture is 256 x 256, one texel per possible cell-state id. */
export const PALETTE_SIZE = 256;
/** Palette texel alpha marking a light-emitting material, drawn at full brightness. */
export const EMISSIVE_ALPHA = 0;

/** The packed light the light volume stores in light-blocking cells (LightEngine OPAQUE_LIGHT). */
const OPAQUE_LIGHT = 0xffff;

const unit = (axis: number, sign = 1) =>
  new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);

const FACE_U = FACES.map((f) => unit(f.u));
const FACE_V = FACES.map((f) => unit(f.v));
const FACE_NORMAL = FACES.map((f) => unit(f.axis, f.sign));
// A +X face sits on the far side of its cell; a -X face on the near side.
const FACE_OFFSET = FACES.map((f) => (f.sign > 0 ? unit(f.axis) : new THREE.Vector3()));
// Fixed brightness per face (+X, -X, +Y, -Y, +Z, -Z). Unlit, every side differs a little so
// shapes read without light; lit, Minecraft's: top 1, east/west 0.6, north/south 0.8, bottom 0.5.
const FLAT_SHADE = [0.8, 0.7, 1.0, 0.5, 0.9, 0.62];
const LIT_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8];

const makeFloat = (value: number) => uniform(value);
type FloatUniform = ReturnType<typeof makeFloat>;

/** Values every lit material shares, changed at runtime without rebuilding anything. */
export interface LightUniforms {
  /** Time of day, 0 (midnight) to 1 (noon), as Minecraft darkens the sky. */
  readonly daylight: FloatUniform;
  /** Minecraft's Brightness setting: 0 Moody, 0.5 the default, 1 Bright. */
  readonly brightness: FloatUniform;
}

export function createLightUniforms(): LightUniforms {
  return { daylight: makeFloat(1), brightness: makeFloat(0.5) };
}

/** Unpacks the quad header every material shares: position, face, palette colour. */
function quadBasics(palette: THREE.Texture) {
  const a = attribute("quadA", "vec4").mul(255).round(); // x, y, z, face
  const b = attribute("quadB", "vec4").mul(255).round(); // w, h, id low, id high
  const face = a.w.toInt();
  const corner = positionGeometry.xy; // the base quad's corner, 0 or 1 along U and V
  // Explicit type arguments: inferred, the element type widens to string and loses its methods.
  const u = uniformArray<"vec3">(FACE_U, "vec3").element(face);
  const v = uniformArray<"vec3">(FACE_V, "vec3").element(face);
  const offset = uniformArray<"vec3">(FACE_OFFSET, "vec3").element(face);
  const position = a.xyz
    .add(offset)
    .add(u.mul(corner.x.mul(b.x)))
    .add(v.mul(corner.y.mul(b.y)));
  const id = b.z.add(b.w.mul(256));
  const paletteUv = varying<"vec2">(
    vec2(id.mod(PALETTE_SIZE), id.div(PALETTE_SIZE).floor()).add(0.5).div(PALETTE_SIZE),
  );
  const color = texture(palette, paletteUv);
  return { face, corner, position, color };
}

/**
 * Minecraft's lightmap (LightTexture): sky and block light levels, 0..15 and blended across
 * the face, to a colour. Each level goes through the f / (4 - 3f) brightness curve. The sky
 * dims toward a blue tint at night but never to black; block light is boosted by 1.5 and
 * added, not maxed, so lamps still show in shade. Then Minecraft's gamma (Brightness lifts
 * dark values by 1 - (1 - x)^4) and its slight pull toward grey. Block light keeps the colour
 * its emitter gives it rather than Minecraft's fixed warm torch tint.
 */
function minecraftLight(
  sky: THREE.Node<"float">,
  block: THREE.Node<"vec3">,
  uniforms: LightUniforms,
) {
  const curve = (level: THREE.Node<"vec3">) => {
    const f = level.div(15);
    return f.div(f.mul(-3).add(4));
  };
  const skyLevel = vec3(sky, sky, sky);
  const darken = mix(float(0.2), float(1), uniforms.daylight);
  const skyBrightness = darken.mul(0.95).add(0.05);
  const skyColor = mix(vec3(darken, darken, 1), vec3(1, 1, 1), 0.35);
  const grey = vec3(0.75, 0.75, 0.75);
  const raw = curve(block)
    .mul(1.5)
    .add(skyColor.mul(curve(skyLevel).mul(skyBrightness)));
  const clamped = clamp(mix(raw, grey, 0.04), 0, 1);
  const lifted = vec3(1, 1, 1).sub(pow(vec3(1, 1, 1).sub(clamped), vec3(4, 4, 4)));
  return clamp(mix(mix(clamped, lifted, uniforms.brightness), grey, 0.04), 0, 1);
}

/**
 * Minecraft multiplies colours by shade, occlusion and light in sRGB, never linearising;
 * three multiplies in linear light and encodes to sRGB afterwards, which lifts darks a lot
 * (a 0.1 factor shows as about 0.35). Raising the combined factor to 2.2 makes the linear
 * product display as Minecraft's: in its darkness you can barely see.
 */
function minecraftFactor(light: THREE.Node<"vec3">, shade: THREE.Node<"float">) {
  return pow(light.mul(shade), vec3(2.2, 2.2, 2.2));
}

/** Lighting off: palette colour and a fixed shade per face. */
export function createFlatMaterial(palette: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const { face, position, color } = quadBasics(palette);
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = position;
  const shade = varying<"float">(uniformArray<"float">(FLAT_SHADE, "float").element(face));
  material.colorNode = color.rgb.mul(shade);
  return material;
}

/** Light the volume reports where it holds none: open sky, not light-blocking. */
const MISSING_LIGHT = 0xf000;

/** x - 1 for a stored "index + 1" (0 when x is 0, which callers treat as missing). */
const minusOne = (x: THREE.Node<"uint">) => select(x.greaterThan(uint(0)), x.sub(uint(1)), uint(0));

/** Element `index` (a uint) of a LinearTexture. */
function loadLinear(tex: LinearTexture, index: THREE.Node<"uint">) {
  const wb = tex.widthBits;
  const hb = tex.heightBits;
  const x = index.bitAnd(uint((1 << wb) - 1));
  const y = index.shiftRight(uint(wb)).bitAnd(uint((1 << hb) - 1));
  const z = index.shiftRight(uint(wb + hb));
  return uint(tex.node.load(ivec3(int(x), int(y), int(z))).x);
}

/**
 * Light from the light volume (see LightVolume and the world worker's LightLayout), so meshes
 * stay plain and merge on cell state alone. Each fragment finds the empty cell in front of
 * its face and reads the 3 x 3 cells around it in the face's plane, each looked up as chunk
 * grid -> chunk table -> brick pool. Then per corner: the average light of the open cells
 * around it and Minecraft's ambient occlusion, blended bilinearly across the cell.
 */
export function createVolumeLitMaterial(
  palette: THREE.Texture,
  uniforms: LightUniforms,
  volume: LightVolume,
  chunkBits: number,
  brickBits: number,
): THREE.MeshBasicNodeMaterial {
  const { face, position, color } = quadBasics(palette);
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = position;
  const shade = varying<"float">(uniformArray<"float">(LIT_SHADE, "float").element(face));
  const world = varying<"vec3">(modelWorldMatrix.mul(vec4(position, 1)).xyz);
  const faceIndex = varying<"float">(face.toFloat()).round().toInt();
  const n = uniformArray<"vec3">(FACE_NORMAL, "vec3").element(faceIndex);
  const u = uniformArray<"vec3">(FACE_U, "vec3").element(faceIndex);
  const v = uniformArray<"vec3">(FACE_V, "vec3").element(faceIndex);

  const S = 1 << chunkBits;
  const B = 1 << brickBits;
  const perSide = S / B;
  const gridOrigin = uniform(volume.gridUniforms.origin);
  const gridSize = uniform(volume.gridUniforms.size);
  const cellOf = (x: THREE.Node<"vec3">, size: number) => x.sub(floor(x.div(size)).mul(size));
  /** Pool slot + 1 of the brick holding a world cell, or 0 if the volume has none. */
  const slotAt = (cell: THREE.Node<"vec3">) => {
    const chunk = floor(cell.div(S));
    const g = chunk.sub(gridOrigin);
    const inGrid = g.x
      .greaterThanEqual(0)
      .and(g.y.greaterThanEqual(0))
      .and(g.z.greaterThanEqual(0))
      .and(g.x.lessThan(gridSize.x))
      .and(g.y.lessThan(gridSize.y))
      .and(g.z.lessThan(gridSize.z));
    const gridIndex = max(g.x.add(g.z.mul(gridSize.x)).add(g.y.mul(gridSize.x.mul(gridSize.z))), 0);
    const table = loadLinear(volume.grid, uint(gridIndex)); // table + 1
    const brick = floor(cellOf(cell, S).div(B));
    const brickIndex = brick.x.add(brick.z.mul(perSide)).add(brick.y.mul(perSide * perSide));
    const slot = loadLinear(
      volume.tables,
      minusOne(table).mul(uint(volume.tableLength)).add(uint(brickIndex)),
    );
    return select(inGrid.and(table.greaterThan(uint(0))), slot, uint(0));
  };
  /** Packed light at a world cell in the brick at `slot` (slot + 1), or MISSING_LIGHT. */
  const lightIn = (cell: THREE.Node<"vec3">, slot: THREE.Node<"uint">) => {
    const inBrick = cellOf(cell, B);
    const cellIndex = inBrick.x.add(inBrick.z.mul(B)).add(inBrick.y.mul(B * B));
    const light = loadLinear(
      volume.pool,
      minusOne(slot).mul(uint(volume.brickVolume)).add(uint(cellIndex)),
    );
    return select(slot.greaterThan(uint(0)), light, uint(MISSING_LIGHT));
  };

  // Built inside Fn so each .toVar() is assigned where it is created, in order. Outside a Fn
  // three assigns a variable lazily at its first use, and select() compiles to if/else: the
  // brick slots would be assigned only in the branch the front cell takes, and neighbours on
  // other paths would read them unset (as missing light) along every brick boundary.
  material.colorNode = Fn(() => {
    const front = floor(world.add(n.mul(0.5))); // the empty cell the face looks into
    const within = world.sub(front);
    const fu = dot(within, u);
    const fv = dot(within, v);
    const at = (du: number, dv: number) => front.add(u.mul(du)).add(v.mul(dv));
    // The 9 cells read lie in at most 2 x 2 bricks: look up the brick of each diagonal once.
    // Along U, cells at -1 and +1 are in the low and high brick; the front cell itself is in
    // the low one unless it starts its brick (and likewise along V).
    const brickSlots = {
      [-1]: { [-1]: slotAt(at(-1, -1)).toVar(), 1: slotAt(at(-1, 1)).toVar() },
      1: { [-1]: slotAt(at(1, -1)).toVar(), 1: slotAt(at(1, 1)).toVar() },
    } as Record<number, Record<number, THREE.Node<"uint">>>;
    const lowU = dot(cellOf(front, B), u).greaterThan(0).toVar();
    const lowV = dot(cellOf(front, B), v).greaterThan(0).toVar();
    const slotFor = (du: number, dv: number): THREE.Node<"uint"> => {
      if (du === 0) return select(lowU, slotFor(-1, dv), slotFor(1, dv));
      if (dv === 0) return select(lowV, slotFor(du, -1), slotFor(du, 1));
      const slot = brickSlots[du]?.[dv];
      if (!slot) throw new Error("no brick slot");
      return slot;
    };
    const samples = new Map<string, THREE.Node<"uint">>();
    const load = (du: number, dv: number) => {
      const key = `${du},${dv}`;
      let sample = samples.get(key);
      if (!sample) {
        sample = lightIn(at(du, dv), slotFor(du, dv)).toVar();
        samples.set(key, sample);
      }
      return sample;
    };
    const decode = (packed: THREE.Node<"uint">) =>
      vec4(
        float(packed.shiftRight(uint(12))),
        float(packed.shiftRight(uint(8)).bitAnd(uint(15))),
        float(packed.shiftRight(uint(4)).bitAnd(uint(15))),
        float(packed.bitAnd(uint(15))),
      );
    const blocks = (packed: THREE.Node<"uint">) => float(packed.equal(uint(OPAQUE_LIGHT)));

    const center = decode(load(0, 0));
    const corner = (du: number, dv: number) => {
      const s1 = load(du, 0);
      const s2 = load(0, dv);
      const d = load(du, dv);
      const o1 = blocks(s1);
      const o2 = blocks(s2);
      const od = max(blocks(d), o1.mul(o2)); // no light or open air leaks past two blocked sides
      const w1 = o1.oneMinus();
      const w2 = o2.oneMinus();
      const wd = od.oneMinus();
      const light = center
        .add(decode(s1).mul(w1))
        .add(decode(s2).mul(w2))
        .add(decode(d).mul(wd))
        .div(w1.add(w2).add(wd).add(1));
      return { light, ao: float(1).sub(o1.add(o2).add(od).mul(0.2)) };
    };
    const k0 = corner(-1, -1);
    const k1 = corner(1, -1);
    const k2 = corner(1, 1);
    const k3 = corner(-1, 1);
    const light = mix(mix(k0.light, k1.light, fu), mix(k3.light, k2.light, fu), fv);
    const occlusion = mix(mix(k0.ao, k1.ao, fu), mix(k3.ao, k2.ao, fu), fv);
    const lit = select(
      color.a.lessThan(0.5),
      vec3(1, 1, 1),
      minecraftLight(light.x, light.yzw, uniforms),
    );
    return color.rgb.mul(minecraftFactor(lit, shade.mul(occlusion)));
  })();
  return material;
}
