// Architecture shapes: one per cell, in any of 24 orientations (ArchitectureCraft's roofs,
// slopes, cylinders, ...). Ported from the Godot app's ArchShapes.gd. Only the roof family is
// here so far: its geometry is generated (AC's RenderRoof) rather than read from the mod's
// .objson meshes, which can follow when the editor needs them.
//
// A shape is authored in its own frame with its base on -Y at turn 0. A placed part's slot is
// side * 4 + turn: `side` (0 -Y, 1 +Y, 2 -Z, 3 +Z, 4 -X, 5 +X) is the face the base sits on,
// `turn` a quarter turn about it.

export interface ArchShape {
  readonly name: string;
}

export const ARCH_SHAPES: Readonly<Record<string, ArchShape>> = {
  roof_tile: { name: "Roof Tile" },
  roof_outer_corner: { name: "Roof Outer Corner" },
  roof_inner_corner: { name: "Roof Inner Corner" },
  roof_ridge: { name: "Gabled Roof Ridge" },
  roof_smart_ridge: { name: "Hip Roof Ridge" },
  roof_valley: { name: "Gabled Roof Valley" },
  roof_smart_valley: { name: "Hip Roof Valley" },
  slope_tile_a1: { name: "Slope A Start" },
  slope_tile_a2: { name: "Slope A End" },
  slope_tile_b1: { name: "Slope B Start" },
  slope_tile_b2: { name: "Slope B Middle" },
  slope_tile_b3: { name: "Slope B End" },
  slope_tile_c1: { name: "Slope C 1" },
  slope_tile_c2: { name: "Slope C 2" },
  slope_tile_c3: { name: "Slope C 3" },
  slope_tile_c4: { name: "Slope C 4" },
};

export const ARCH_SLOTS = 24;

export function archSlot(side: number, turn: number): number {
  return side * 4 + (turn & 3);
}

type Vec3 = readonly [number, number, number];
/** A 3 x 3 matrix, row-major. */
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (a[r * 3 + k] ?? 0) * (b[k * 3 + c] ?? 0);
      out.push(Math.round(s));
    }
  }
  return out as unknown as Mat3;
};
const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const cosSin = (deg: number) =>
  [
    Math.round(Math.cos((deg * Math.PI) / 180)),
    Math.round(Math.sin((deg * Math.PI) / 180)),
  ] as const;
const rx = (deg: number): Mat3 => {
  const [c, s] = cosSin(deg);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const ry = (deg: number): Mat3 => {
  const [c, s] = cosSin(deg);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const rz = (deg: number): Mat3 => {
  const [c, s] = cosSin(deg);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

/** The rotation for (side, turn): AC's sideTurnRotations, ordinary right-handed rotations. */
export function archRotation(side: number, turn: number): Mat3 {
  const sides: Mat3[] = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    rx(180),
    rx(90),
    mul(rx(-90), ry(180)),
    mul(rz(-90), ry(90)),
    mul(rz(90), ry(-90)),
  ];
  const s = sides[side];
  if (!s) throw new RangeError(`No side ${side}`);
  return mul(s, ry(90 * (turn & 3)));
}

/** One polygon of a shape in its 0..1 frame, with the normal it faces. */
interface Polygon {
  readonly verts: readonly Vec3[];
  readonly normal: Vec3;
}

const N_NZ: Vec3 = [0, 1, -1];
const N_PZ: Vec3 = [0, 1, 1];
const N_PX: Vec3 = [1, 1, 0];
const N_NX: Vec3 = [-1, 1, 0];
const RIGHT: Vec3 = [1, 0, 0];
const LEFT: Vec3 = [-1, 0, 0];
const DOWN: Vec3 = [0, -1, 0];
const BACK: Vec3 = [0, 0, 1];
const FORWARD: Vec3 = [0, 0, -1];
const C: Vec3 = [0.5, 0.5, 0.5];

const leftTriangle: Polygon = {
  verts: [
    [1, 1, 1],
    [1, 0, 1],
    [1, 0, 0],
  ],
  normal: RIGHT,
};
const rightTriangle: Polygon = {
  verts: [
    [0, 1, 1],
    [0, 0, 0],
    [0, 0, 1],
  ],
  normal: LEFT,
};
const bottomQuad: Polygon = {
  verts: [
    [0, 0, 1],
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
  ],
  normal: DOWN,
};
const backQuad: Polygon = {
  verts: [
    [0, 1, 1],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  normal: BACK,
};
const frontQuad: Polygon = {
  verts: [
    [1, 1, 0],
    [1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
  ],
  normal: FORWARD,
};
const leftQuad: Polygon = {
  verts: [
    [1, 1, 1],
    [1, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
  ],
  normal: RIGHT,
};
const rightQuad: Polygon = {
  verts: [
    [0, 1, 0],
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
  ],
  normal: LEFT,
};

const connectValleyLeft: Polygon[] = [
  { verts: [C, [1, 0.5, 0.5], [1, 1, 0]], normal: N_PZ },
  { verts: [C, [1, 1, 1], [1, 0.5, 0.5]], normal: N_NZ },
  {
    verts: [
      [1, 1, 1],
      [1, 0, 1],
      [1, 0.5, 0.5],
    ],
    normal: RIGHT,
  },
  {
    verts: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 0.5, 0.5],
    ],
    normal: RIGHT,
  },
  {
    verts: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 0.5, 0.5],
    ],
    normal: RIGHT,
  },
];
const connectValleyRight: Polygon[] = [
  { verts: [C, [0, 1, 0], [0, 0.5, 0.5]], normal: N_PZ },
  { verts: [C, [0, 0.5, 0.5], [0, 1, 1]], normal: N_NZ },
  {
    verts: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 0.5, 0.5],
    ],
    normal: LEFT,
  },
  {
    verts: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 0.5, 0.5],
    ],
    normal: LEFT,
  },
  {
    verts: [
      [0, 1, 0],
      [0, 0, 0],
      [0, 0.5, 0.5],
    ],
    normal: LEFT,
  },
];
const terminateValleyLeft: Polygon[] = [
  { verts: [[1, 1, 0], C, [1, 1, 1]], normal: N_NX },
  leftQuad,
];
const terminateValleyRight: Polygon[] = [
  { verts: [[0, 1, 1], C, [0, 1, 0]], normal: N_PX },
  rightQuad,
];
const terminateValleyFront: Polygon[] = [
  { verts: [[0, 1, 0], C, [1, 1, 0]], normal: N_PZ },
  frontQuad,
];
const terminateValleyBack: Polygon[] = [
  { verts: [[1, 1, 1], C, [0, 1, 1]], normal: N_NZ },
  backQuad,
];

/**
 * A slope tile (AC's renderSlopeXN): the top slopes from `start` at the back (+Z) to `end`
 * at the front; side walls are a quad of [offset, height] (skipped for a negative offset)
 * under a triangle of [offset, height]; a front wall `front` high, a back wall `back` high.
 */
function slopeTile(
  start: number,
  end: number,
  quad: readonly [number, number],
  tri: readonly [number, number],
  front: number,
  back: number,
): Polygon[] {
  const f: Polygon[] = [
    {
      verts: [
        [1, start, 1],
        [1, end, 0],
        [0, end, 0],
        [0, start, 1],
      ],
      normal: [0, 1, end - start],
    },
  ];
  const [o, h] = quad;
  if (o >= 0) {
    f.push({
      verts: [
        [0, o + h, 0],
        [0, o, 0],
        [0, o, 1],
        [0, o + h, 1],
      ],
      normal: LEFT,
    });
    f.push({
      verts: [
        [1, o + h, 1],
        [1, o, 1],
        [1, o, 0],
        [1, o + h, 0],
      ],
      normal: RIGHT,
    });
  }
  const [to, th] = tri;
  f.push({
    verts: [
      [1, to + th, 1],
      [1, to, 1],
      [1, to, 0],
    ],
    normal: RIGHT,
  });
  f.push({
    verts: [
      [0, to + th, 1],
      [0, to, 0],
      [0, to, 1],
    ],
    normal: LEFT,
  });
  if (front > 0) {
    f.push({
      verts: [
        [1, front, 0],
        [1, 0, 0],
        [0, 0, 0],
        [0, front, 0],
      ],
      normal: FORWARD,
    });
  }
  f.push({
    verts: [
      [0, back, 1],
      [0, 0, 1],
      [1, 0, 1],
      [1, back, 1],
    ],
    normal: BACK,
  });
  f.push(bottomQuad);
  return f;
}

const third = 1 / 3;

function roofPolygons(shape: string): Polygon[] | null {
  switch (shape) {
    case "roof_tile":
      return [
        {
          verts: [
            [1, 1, 1],
            [1, 0, 0],
            [0, 0, 0],
            [0, 1, 1],
          ],
          normal: N_NZ,
        },
        leftTriangle,
        rightTriangle,
        bottomQuad,
        backQuad,
      ];
    case "roof_outer_corner":
      return [
        {
          verts: [
            [0, 1, 1],
            [1, 0, 0],
            [0, 0, 0],
          ],
          normal: N_NZ,
        },
        {
          verts: [
            [0, 1, 1],
            [1, 0, 1],
            [1, 0, 0],
          ],
          normal: N_PX,
        },
        {
          verts: [
            [0, 1, 1],
            [0, 0, 1],
            [1, 0, 1],
          ],
          normal: BACK,
        },
        rightTriangle,
        bottomQuad,
      ];
    case "roof_inner_corner":
      return [
        { verts: [[0, 1, 0], C, [1, 0, 0]], normal: N_PX },
        { verts: [[1, 1, 1], [1, 0, 0], C], normal: N_NZ },
        {
          verts: [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, 0],
          ],
          normal: FORWARD,
        },
        leftTriangle,
        bottomQuad,
        ...terminateValleyBack,
        ...terminateValleyRight,
      ];
    case "roof_ridge":
      return [
        {
          verts: [
            [1, 0.5, 0.5],
            [1, 0, 0],
            [0, 0, 0],
            [0, 0.5, 0.5],
          ],
          normal: N_NZ,
        },
        {
          verts: [
            [0, 0.5, 0.5],
            [0, 0, 1],
            [1, 0, 1],
            [1, 0.5, 0.5],
          ],
          normal: N_PZ,
        },
        {
          verts: [
            [1, 0.5, 0.5],
            [1, 0, 1],
            [1, 0, 0],
          ],
          normal: RIGHT,
        },
        {
          verts: [
            [0, 0.5, 0.5],
            [0, 0, 0],
            [0, 0, 1],
          ],
          normal: LEFT,
        },
        bottomQuad,
      ];
    case "roof_smart_ridge":
      return [
        { verts: [C, [1, 0, 1], [1, 0, 0]], normal: N_PX },
        { verts: [C, [0, 0, 0], [0, 0, 1]], normal: N_NX },
        { verts: [C, [0, 0, 1], [1, 0, 1]], normal: N_PZ },
        { verts: [C, [1, 0, 0], [0, 0, 0]], normal: N_NZ },
        bottomQuad,
      ];
    case "roof_valley":
      return [
        ...connectValleyLeft,
        ...connectValleyRight,
        ...terminateValleyFront,
        ...terminateValleyBack,
        bottomQuad,
      ];
    case "roof_smart_valley":
      return [
        ...terminateValleyLeft,
        ...terminateValleyRight,
        ...terminateValleyFront,
        ...terminateValleyBack,
        bottomQuad,
      ];
    case "slope_tile_a1":
      return slopeTile(1, 0.5, [0, 0.5], [0.5, 0.5], 0.5, 1);
    case "slope_tile_a2":
      return slopeTile(0.5, 0, [-1, 0], [0, 0.5], 0, 0.5);
    case "slope_tile_b1":
      return slopeTile(1, 2 * third, [0, 2 * third], [2 * third, third], 2 * third, 1);
    case "slope_tile_b2":
      return slopeTile(2 * third, third, [0, third], [third, third], third, 2 * third);
    case "slope_tile_b3":
      return slopeTile(third, 0, [-1, 0], [0, third], 0, third);
    case "slope_tile_c1":
      return slopeTile(1, 0.75, [0, 0.75], [0.75, 0.25], 0.75, 1);
    case "slope_tile_c2":
      return slopeTile(0.75, 0.5, [0, 0.5], [0.5, 0.25], 0.5, 0.75);
    case "slope_tile_c3":
      return slopeTile(0.5, 0.25, [0, 0.25], [0.25, 0.25], 0.25, 0.5);
    case "slope_tile_c4":
      return slopeTile(0.25, 0, [-1, 0], [0, 0.25], 0, 0.25);
    default:
      return null;
  }
}

/**
 * The triangles of a placed architecture shape in cell space (0..1), 9 numbers each, wound
 * counter-clockwise seen from outside. Empty for an unknown shape or slot.
 */
export function archTriangles(shape: string, slot: number): number[] {
  const polygons = roofPolygons(shape);
  if (!polygons || !Number.isInteger(slot) || slot < 0 || slot >= ARCH_SLOTS) return [];
  const m = archRotation(slot >> 2, slot & 3);
  const place = (p: Vec3): Vec3 => {
    const r = apply(m, [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5]);
    return [r[0] + 0.5, r[1] + 0.5, r[2] + 0.5];
  };
  const out: number[] = [];
  for (const { verts, normal } of polygons) {
    const n = apply(m, normal);
    const placed = verts.map(place);
    const a = placed[0];
    if (!a) continue;
    for (let i = 1; i + 1 < placed.length; i++) {
      const b = placed[i];
      const c = placed[i + 1];
      if (!b || !c) continue;
      // Wind each triangle counter-clockwise around the normal it was authored with.
      const cross = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ];
      const facing = (cross[0] ?? 0) * n[0] + (cross[1] ?? 0) * n[1] + (cross[2] ?? 0) * n[2];
      const [p, q] = facing >= 0 ? [b, c] : [c, b];
      out.push(...a, ...p, ...q);
    }
  }
  return out;
}
