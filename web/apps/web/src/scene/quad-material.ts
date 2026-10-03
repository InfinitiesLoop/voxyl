import { FACES } from "@voxyl/mesher";
import {
  attribute,
  float,
  max,
  mix,
  positionGeometry,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";

/** The palette texture is 256 x 256, one texel per possible cell-state id. */
export const PALETTE_SIZE = 256;

const unit = (axis: number) =>
  new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);

const FACE_U = FACES.map((f) => unit(f.u));
const FACE_V = FACES.map((f) => unit(f.v));
// A +X face sits on the far side of its cell; a -X face on the near side.
const FACE_OFFSET = FACES.map((f) => (f.sign > 0 ? unit(f.axis) : new THREE.Vector3()));
// Fixed brightness per face (+X, -X, +Y, -Y, +Z, -Z): top brightest, bottom darkest, sides
// in between, as in Minecraft, so shapes read clearly with or without lighting.
const FACE_SHADE = [0.8, 0.7, 1.0, 0.5, 0.9, 0.62];

/** Values the renderer changes at runtime without rebuilding the material. */
export interface QuadUniforms {
  /** 1 with lighting on, 0 off (every face at full brightness). */
  readonly lighting: { value: number };
  /** Sky brightness, 0 (night) to 1 (day). Block light is unaffected. */
  readonly daylight: { value: number };
}

/**
 * One material for every chunk. Each instance is a quad the mesher packed into 24 bytes:
 * position, face, size and cell-state id, then the light at its four corners (sky, red,
 * green, blue). The vertex stage unpacks the quad; the colour comes from the palette texture
 * by cell-state id, so a palette swap only rewrites the texture. With lighting on, the
 * fragment blends the four corners across the face (no triangle-split artefacts), applies
 * Minecraft's brightness curve, scales sky light by daylight and takes the brighter of sky
 * and block light per channel.
 */
export function createQuadMaterial(palette: THREE.Texture): {
  material: THREE.MeshBasicNodeMaterial;
  uniforms: QuadUniforms;
} {
  const a = attribute("quadA", "vec4").mul(255).round(); // x, y, z, face
  const b = attribute("quadB", "vec4").mul(255).round(); // w, h, id low, id high
  const face = a.w.toInt();
  const corner = positionGeometry.xy; // the base quad's corner, 0 or 1 along U and V

  // Explicit type arguments: inferred, the element type widens to string and loses its methods.
  const u = uniformArray<"vec3">(FACE_U, "vec3").element(face);
  const v = uniformArray<"vec3">(FACE_V, "vec3").element(face);
  const offset = uniformArray<"vec3">(FACE_OFFSET, "vec3").element(face);

  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = a.xyz
    .add(offset)
    .add(u.mul(corner.x.mul(b.x)))
    .add(v.mul(corner.y.mul(b.y)));

  const id = b.z.add(b.w.mul(256));
  const paletteUv = varying<"vec2">(
    vec2(id.mod(PALETTE_SIZE), id.div(PALETTE_SIZE).floor()).add(0.5).div(PALETTE_SIZE),
  );
  const shade = varying<"float">(uniformArray<"float">(FACE_SHADE, "float").element(face));

  // Corner light, constant across the quad, blended by where the fragment sits on it.
  const uv = varying<"vec2">(corner);
  const c0 = varying<"vec4">(attribute("corner0", "vec4"));
  const c1 = varying<"vec4">(attribute("corner1", "vec4"));
  const c2 = varying<"vec4">(attribute("corner2", "vec4"));
  const c3 = varying<"vec4">(attribute("corner3", "vec4"));
  const light = mix(mix(c0, c1, uv.x), mix(c3, c2, uv.x), uv.y); // sky, r, g, b in 0..1

  // Minecraft's brightness curve, f / (4 - 3f): level 15 is full, level 8 about a fifth.
  const lighting = uniform(0);
  const daylight = uniform(1);
  const skyLevel = light.x;
  const sky = skyLevel.div(float(4).sub(skyLevel.mul(3))).mul(daylight);
  const blockLevel = light.yzw;
  const block = blockLevel.div(vec3(4, 4, 4).sub(blockLevel.mul(3)));
  const lit = max(max(vec3(sky, sky, sky), block), vec3(0.03, 0.03, 0.035));
  const brightness = mix(vec3(1, 1, 1), lit, lighting);

  material.colorNode = texture(palette, paletteUv).rgb.mul(shade).mul(brightness);
  return { material, uniforms: { lighting, daylight } };
}
