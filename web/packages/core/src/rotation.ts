// Orientation is one of the 24 rotations of the cube (web-core.md, section 3). A rotation maps a
// block's own model space onto the world: a model faces north (-Z) with +Y up, as Minecraft's
// do, and the cell's rotation turns it into place. Facing and upside-down are both just
// rotations, so turning a region is one table lookup per cell, with no special cases.
//
// Rotations are numbered 0..23 in a fixed order (identity first). The numbers are stored in
// cells and saved projects, so the order must never change.

/** A rotation of the cube, 0..23. */
export type Rotation = number;

/** An integer vector. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** 0 = X, 1 = Y, 2 = Z. */
export type Axis = 0 | 1 | 2;

export const ROTATION_COUNT = 24;
export const IDENTITY: Rotation = 0;

/** The direction a model's front faces before it is rotated. */
export const MODEL_FRONT: Vec3 = [0, 0, -1];
/** The direction a model's top faces before it is rotated. */
export const MODEL_UP: Vec3 = [0, 1, 0];

// Row-major 3x3 matrices of the 24 proper rotations: signed permutation matrices with
// determinant +1, generated in a fixed order so index 0 is the identity.
const MATRICES: Int8Array = (() => {
  const out: number[] = [];
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const p of perms) {
    for (let signs = 0; signs < 8; signs++) {
      const m = new Array<number>(9).fill(0);
      for (let row = 0; row < 3; row++) m[row * 3 + (p[row] ?? 0)] = signs & (1 << row) ? -1 : 1;
      if (det(m) === 1) out.push(...m);
    }
  }
  return Int8Array.from(out);
})();

const KEY_TO_ROTATION = new Map<string, Rotation>();
for (let r = 0; r < ROTATION_COUNT; r++) KEY_TO_ROTATION.set(matrixKey(matrixOf(r)), r);

// compose[a * 24 + b] is a ∘ b: apply b, then a.
const COMPOSE = new Uint8Array(ROTATION_COUNT * ROTATION_COUNT);
const INVERSE = new Uint8Array(ROTATION_COUNT);
for (let a = 0; a < ROTATION_COUNT; a++) {
  for (let b = 0; b < ROTATION_COUNT; b++) {
    const r = fromMatrix(multiply(matrixOf(a), matrixOf(b)));
    COMPOSE[a * ROTATION_COUNT + b] = r;
    if (r === IDENTITY) INVERSE[a] = b;
  }
}

/** The rotation's matrix, row-major. */
export function matrixOf(r: Rotation): number[] {
  assertRotation(r);
  return Array.from(MATRICES.subarray(r * 9, r * 9 + 9));
}

/** The rotation with this matrix. Throws if it isn't one of the 24. */
export function fromMatrix(m: readonly number[]): Rotation {
  const r = KEY_TO_ROTATION.get(matrixKey(m));
  if (r === undefined) throw new RangeError(`Not a rotation of the cube: [${m.join(", ")}]`);
  return r;
}

/** a ∘ b: the rotation that applies b, then a. */
export function compose(a: Rotation, b: Rotation): Rotation {
  assertRotation(a);
  assertRotation(b);
  return COMPOSE[a * ROTATION_COUNT + b] ?? IDENTITY;
}

export function inverse(r: Rotation): Rotation {
  assertRotation(r);
  return INVERSE[r] ?? IDENTITY;
}

/** Applies a rotation to an integer vector. */
export function rotate(r: Rotation, v: Vec3): Vec3 {
  assertRotation(r);
  const m = MATRICES;
  const o = r * 9;
  const [x, y, z] = v;
  return [
    (m[o] ?? 0) * x + (m[o + 1] ?? 0) * y + (m[o + 2] ?? 0) * z,
    (m[o + 3] ?? 0) * x + (m[o + 4] ?? 0) * y + (m[o + 5] ?? 0) * z,
    (m[o + 6] ?? 0) * x + (m[o + 7] ?? 0) * y + (m[o + 8] ?? 0) * z,
  ];
}

/**
 * A quarter-turn rotation about an axis, right-handed: positive turns go counter-clockwise
 * when looking down the axis from its positive end. Seen from above, a positive turn about
 * Y takes north (-Z) to west (-X); see turnClockwise for the usual building sense.
 */
export function turn(axis: Axis, quarterTurns: number): Rotation {
  const q = ((quarterTurns % 4) + 4) % 4;
  const c = [1, 0, -1, 0][q] ?? 1;
  const s = [0, 1, 0, -1][q] ?? 0;
  const m =
    axis === 0
      ? [1, 0, 0, 0, c, -s, 0, s, c]
      : axis === 1
        ? [c, 0, s, 0, 1, 0, -s, 0, c]
        : [c, -s, 0, s, c, 0, 0, 0, 1];
  return fromMatrix(m);
}

/** Quarter turns clockwise seen from above (north to east), as building tools mean it. */
export function turnClockwise(quarterTurns: number): Rotation {
  return turn(1, -quarterTurns);
}

/**
 * The rotation of a block mirrored across a world plane (the plane normal to `worldAxis`).
 * A mirror isn't a rotation, so the block is assumed symmetric under its own mirror across
 * `modelAxis` (default X: left-right symmetric, true of stairs, slabs, logs and most blocks).
 * The result is mirror(world) ∘ r ∘ mirror(model), a proper rotation. Mirroring twice gives r
 * back. A block with no mirror symmetry can't be mirrored exactly; placement profiles flag it.
 */
export function mirror(r: Rotation, worldAxis: Axis, modelAxis: Axis = 0): Rotation {
  return fromMatrix(
    multiply(multiply(mirrorMatrix(worldAxis), matrixOf(r)), mirrorMatrix(modelAxis)),
  );
}

/** Where a rotated model's front faces. */
export function facingOf(r: Rotation): Vec3 {
  return rotate(r, MODEL_FRONT);
}

/** Where a rotated model's top faces. */
export function upOf(r: Rotation): Vec3 {
  return rotate(r, MODEL_UP);
}

/** The rotation whose model front faces `front` and top faces `up` (perpendicular unit axes). */
export function rotationFacing(front: Vec3, up: Vec3): Rotation {
  for (let r = 0; r < ROTATION_COUNT; r++) {
    if (sameVec(facingOf(r), front) && sameVec(upOf(r), up)) return r;
  }
  throw new RangeError(`No rotation faces [${front}] with up [${up}]`);
}

/**
 * The rotations that leave a model looking the same, as a subgroup of the 24: a block shows
 * r and r ∘ g identically for every g in it. canonical() picks one representative so cells
 * that look identical share one stored state.
 */
export const SYMMETRY = {
  /** Every rotation looks different (stairs, a torch). */
  none: [IDENTITY] as readonly Rotation[],
  /** Rotation doesn't matter (a plain cube). */
  all: Array.from({ length: ROTATION_COUNT }, (_, r) => r) as readonly Rotation[],
  /** Only the axis the model's Y lies along matters (a log, a pillar). */
  axisY: stabilizer((r) => Math.abs(upOf(r)[1]) === 1),
} as const;

/** The subgroup of rotations satisfying `keeps`. */
export function stabilizer(keeps: (r: Rotation) => boolean): readonly Rotation[] {
  const group: Rotation[] = [];
  for (let r = 0; r < ROTATION_COUNT; r++) if (keeps(r)) group.push(r);
  return group;
}

/** The smallest rotation that looks the same as r under a model's symmetry group. */
export function canonical(r: Rotation, symmetry: readonly Rotation[]): Rotation {
  let best = r;
  for (const g of symmetry) {
    const candidate = compose(r, g);
    if (candidate < best) best = candidate;
  }
  return best;
}

export function isRotation(r: number): boolean {
  return Number.isInteger(r) && r >= 0 && r < ROTATION_COUNT;
}

function assertRotation(r: number): void {
  if (!isRotation(r)) throw new RangeError(`Rotation must be an integer 0..23, got ${r}`);
}

function mirrorMatrix(axis: Axis): number[] {
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  m[axis * 4] = -1;
  return m;
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[i * 3 + k] ?? 0) * (b[k * 3 + j] ?? 0);
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

function det(m: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function matrixKey(m: readonly number[]): string {
  return m.join(",");
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
