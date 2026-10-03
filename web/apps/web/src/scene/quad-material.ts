import { FACES } from "@voxyl/mesher";
import { attribute, positionGeometry, texture, uniformArray, varying, vec2 } from "three/tsl";
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
// in between, so shapes read clearly without lights. Basic lighting replaces this in Phase 3.
const FACE_SHADE = [0.8, 0.7, 1.0, 0.5, 0.9, 0.62];

/**
 * One material for every chunk. Each instance is a quad packed by the mesher into 8 bytes
 * (two unorm8x4 attributes): the vertex stage unpacks position, face and size, and the colour
 * comes from the palette texture by cell-state id. A palette swap only rewrites the texture.
 */
export function createQuadMaterial(palette: THREE.Texture): THREE.MeshBasicNodeMaterial {
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
  material.colorNode = texture(palette, paletteUv).rgb.mul(shade);
  return material;
}
