// The default set's textures, drawn in code: originals that a Minecraft player still reads at a
// glance (grey speckled stone, rounded cobbles, offset bricks, plank boards, bark and rings,
// framed glass). Each is a function of its name's seed, so every build draws the same pixels.

import type { Alpha, Texture } from "../library.ts";
import { Canvas, hex, mix, type Rgb, SIZE, shade, toHex } from "./paint.ts";

type Painter = (c: Canvas) => void;

/** Nearest and second-nearest seed distances on a wrapping tile, and the nearest seed. */
function cells(c: Canvas, count: number) {
  const seeds = Array.from({ length: count }, () => [c.rand() * SIZE, c.rand() * SIZE] as const);
  return (x: number, y: number) => {
    let d1 = Infinity;
    let d2 = Infinity;
    let nearest = 0;
    seeds.forEach(([sx, sy], i) => {
      let dx = Math.abs(x + 0.5 - sx);
      let dy = Math.abs(y + 0.5 - sy);
      dx = Math.min(dx, SIZE - dx);
      dy = Math.min(dy, SIZE - dy);
      const d = Math.hypot(dx, dy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        nearest = i;
      } else if (d < d2) d2 = d;
    });
    return { d1, d2, nearest };
  };
}

/** Rounded stones with dark gaps, lit from the top left. */
function stones(c: Canvas, count: number, tones: readonly Rgb[], gap: Rgb, gapWidth: number) {
  const at = cells(c, count);
  const tone = tones.map((t) => shade(t, 0.94 + c.rand() * 0.12));
  const isGap = (x: number, y: number) => {
    const { d1, d2 } = at(x, y);
    return d2 - d1 < gapWidth;
  };
  c.each((x, y) => {
    if (isGap(x, y)) return gap;
    const base = tone[at(x, y).nearest % tone.length] ?? gap;
    if (isGap(x - 1, y - 1)) return shade(base, 1.18);
    if (isGap(x + 1, y + 1)) return shade(base, 0.8);
    return base;
  });
}

const stone: Painter = (c) => {
  c.fill(hex("#7c7d7e")).noise(0.07);
  for (let i = 0; i < 7; i++) {
    const x = Math.floor(c.rand() * SIZE);
    const y = Math.floor(c.rand() * SIZE);
    const k = i % 2 === 0 ? 0.84 : 1.12;
    c.tone(x, y, x + 2 + Math.floor(c.rand() * 2), y + 1, k);
  }
};

const cobblestone: Painter = (c) => {
  stones(
    c,
    9,
    [hex("#7a7a7a"), hex("#8d8d8d"), hex("#6c6c6c"), hex("#979797")],
    hex("#4a4a4a"),
    1.1,
  );
  c.noise(0.05);
};

/** Bricks in courses: `rows` courses, `joints(row)` the x of each vertical joint. */
function courses(
  c: Canvas,
  rows: number,
  joints: (row: number) => readonly number[],
  brick: (row: number, col: number) => Rgb,
  mortar: Rgb,
) {
  const h = SIZE / rows;
  c.each((x, y) => {
    const row = Math.floor(y / h);
    const inRow = y % h;
    if (inRow === h - 1) return mortar;
    const js = joints(row);
    if (js.includes(x)) return mortar;
    const col = js.filter((j) => j < x).length;
    const base = brick(row, col);
    if (inRow === 0) return shade(base, 1.1);
    if (inRow === h - 2) return shade(base, 0.9);
    if (js.includes(x - 1)) return shade(base, 1.06);
    return base;
  });
}

const stoneBricks: Painter = (c) => {
  const tones = Array.from({ length: 8 }, () => shade(hex("#7b7b7b"), 0.94 + c.rand() * 0.12));
  courses(
    c,
    2,
    (row) => (row === 0 ? [3, 11] : [7, 15]),
    (row, col) => tones[row * 3 + col] ?? hex("#7b7b7b"),
    hex("#565656"),
  );
  c.noise(0.06);
};

const bricks: Painter = (c) => {
  const reds = [hex("#9b4b39"), hex("#8c4031"), hex("#a65844"), hex("#94493a")];
  courses(
    c,
    4,
    (row) => (row % 2 === 0 ? [7, 15] : [3, 11]),
    () => reds[Math.floor(c.rand() * reds.length)] ?? hex("#9b4b39"),
    hex("#a59e94"),
  );
  c.noise(0.05);
};

/** Four boards with grain and an end joint each. */
function planks(color: string): Painter {
  return (c) => {
    const base = hex(color);
    const ends = [11, 3, 14, 6];
    c.each((x, y) => {
      const board = Math.floor(y / 4);
      if (y % 4 === 3) return shade(base, 0.7);
      if (x === ends[board]) return shade(base, 0.76);
      return shade(base, 0.96 + ((board * 7 + x * 3) % 5) * 0.012);
    });
    // Grain: short darker streaks along the boards.
    for (let i = 0; i < 14; i++) {
      const y = Math.floor(c.rand() * 4) * 4 + Math.floor(c.rand() * 3);
      const x = Math.floor(c.rand() * SIZE);
      c.tone(x, y, x + 2 + Math.floor(c.rand() * 4), y + 1, 0.88);
    }
    c.noise(0.03);
  };
}

/** Bark: vertical furrows. */
function bark(color: string): Painter {
  return (c) => {
    const base = hex(color);
    const columns = Array.from({ length: SIZE }, () => 0.82 + c.rand() * 0.3);
    c.each((x, y) => {
      const wobble = Math.sin((y + x * 3) * 0.9) * 0.05;
      return shade(base, (columns[x] ?? 1) + wobble);
    });
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(c.rand() * SIZE);
      const y = Math.floor(c.rand() * SIZE);
      c.tone(x, y, x + 1, y + 3 + Math.floor(c.rand() * 4), 0.7);
    }
    c.noise(0.04);
  };
}

/** A sawn end: growth rings inside a ring of bark. */
function rings(wood: string, barkColor: string): Painter {
  return (c) => {
    const light = hex(wood);
    const dark = shade(light, 0.82);
    const b = hex(barkColor);
    c.each((x, y) => {
      const dx = Math.abs(x - 7.5);
      const dy = Math.abs(y - 7.5);
      if (Math.max(dx, dy) > 6.6) return shade(b, 0.92 + ((x + y) % 3) * 0.06);
      const r = Math.max(dx, dy) * 0.6 + Math.hypot(dx, dy) * 0.4;
      return Math.floor(r) % 2 === 0 ? light : dark;
    });
    c.noise(0.03);
  };
}

function flat(color: string, amount: number): Painter {
  return (c) => {
    c.fill(hex(color)).noise(amount);
  };
}

const sand: Painter = (c) => {
  c.fill(hex("#dad09f")).noise(0.05).specks(14, 0.88).specks(8, 1.08);
};

const gravel: Painter = (c) => {
  stones(
    c,
    15,
    [hex("#86807b"), hex("#6e6965"), hex("#9c9691"), hex("#7c736b")],
    hex("#57524f"),
    0.7,
  );
  c.noise(0.08);
};

const dirt: Painter = (c) => {
  c.fill(hex("#86613f")).noise(0.1).specks(16, 0.75).specks(8, 1.15);
};

const grassTop: Painter = (c) => {
  c.fill(hex("#689c3b")).noise(0.12).specks(18, 0.82).specks(10, 1.14);
};

const grassSide: Painter = (c) => {
  dirt(c);
  const green = hex("#689c3b");
  for (let x = 0; x < SIZE; x++) {
    const depth = 2 + (c.rand() < 0.45 ? 1 : 0) + (c.rand() < 0.2 ? 1 : 0);
    for (let y = 0; y < depth; y++) c.set(x, y, shade(green, 0.9 + c.rand() * 0.2));
  }
};

const sandstoneSide: Painter = (c) => {
  const base = hex("#d7c99a");
  c.each((_, y) => {
    if (y < 3) return shade(base, 1.06);
    if (y === 3 || y === 11) return shade(base, 0.86);
    if (y > 12) return shade(base, 0.95);
    return base;
  });
  c.noise(0.035);
};

const sandstoneTop: Painter = (c) => {
  c.fill(hex("#dccf9f")).noise(0.025);
};

const sandstoneBottom: Painter = (c) => {
  c.fill(hex("#d3c595")).noise(0.06).specks(12, 0.9);
};

/** Clear panes in a frame lit from the top left, with two glints. */
/**
 * The undecided look: a pale placeholder panel (a frame and faint diagonal hatching) that the
 * semantic's hint colour tints, so a build before any block is chosen still reads as
 * blocks, each semantic its own colour, and never as a real material.
 */
const undecided: Painter = (c) => {
  const base = hex("#f4f4f2");
  const hatch = hex("#dcdcd8");
  const frame = hex("#b9b9b4");
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      const inner = x === 1 || y === 1 || x === SIZE - 2 || y === SIZE - 2;
      if (edge) c.set(x, y, frame);
      else if (inner) c.set(x, y, shade(base, 1.02));
      else if ((x + y) % 6 === 0) c.set(x, y, hatch);
      else c.set(x, y, shade(base, 0.98 + c.rand() * 0.03));
    }
};

const glass: Painter = (c) => {
  const light = hex("#e4f1f3");
  const dim = hex("#a5c2c7");
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (y === 0 || x === 0) c.set(x, y, light);
      else if (y === SIZE - 1 || x === SIZE - 1) c.set(x, y, dim);
      else c.set(x, y, light, 0);
    }
  for (const [x, y] of [
    [3, 4],
    [4, 3],
    [5, 2],
    [3, 7],
    [4, 6],
    [5, 5],
    [6, 4],
    [7, 3],
  ] as const)
    c.set(x, y, mix(light, dim, 0.15));
};

/** A pane's edge seen end on: a thin frame strip down the middle. */
const glassPaneTop: Painter = (c) => {
  const light = hex("#d7e8eb");
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (x === 7 || x === 8) c.set(x, y, shade(light, x === 7 ? 1 : 0.85));
      else c.set(x, y, light, 0);
    }
};

const smoothStone: Painter = (c) => {
  c.fill(hex("#a2a2a2")).noise(0.02);
  const edge = hex("#7f7f7f");
  for (let i = 0; i < SIZE; i++) {
    c.set(i, 0, edge);
    c.set(i, SIZE - 1, edge);
    c.set(0, i, edge);
    c.set(SIZE - 1, i, edge);
  }
};

const quartzSide: Painter = (c) => {
  c.fill(hex("#e9e3da")).noise(0.025);
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(c.rand() * SIZE);
    const y = Math.floor(c.rand() * SIZE);
    c.tone(x, y, x + 3, y + 1, 0.97);
  }
};

const quartzTop: Painter = (c) => {
  quartzSide(c);
  for (let i = 1; i < SIZE - 1; i++) {
    c.set(i, 1, shade(c.get(i, 1), 0.94));
    c.set(1, i, shade(c.get(1, i), 0.94));
  }
};

const ironBlock: Painter = (c) => {
  const base = hex("#d9d9d9");
  c.each((x, y) => {
    if (y === 0 || x === 0) return shade(base, 1.08);
    if (y === SIZE - 1 || x === SIZE - 1) return shade(base, 0.76);
    if (y === 5 || y === 10) return shade(base, 0.82);
    if (y === 6 || y === 11) return shade(base, 1.06);
    return base;
  });
  c.noise(0.025);
};

const glowstone: Painter = (c) => {
  const at = cells(c, 8);
  const core = hex("#ffe8a3");
  const rim = hex("#a8782f");
  c.each((x, y) => {
    const { d1, d2 } = at(x, y);
    if (d2 - d1 < 0.9) return shade(rim, 0.8);
    return mix(core, rim, Math.min(1, d1 / 4));
  });
  c.noise(0.05);
};

const leaves: Painter = (c) => {
  const base = hex("#4b7c2b");
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (c.rand() < 0.2) c.set(x, y, base, 0);
      else c.set(x, y, shade(base, 0.75 + c.rand() * 0.45));
    }
};

const concrete = (color: string): Painter => flat(color, 0.022);

/** Every default texture by key. */
const PAINTERS: Readonly<Record<string, Painter>> = {
  stone,
  cobblestone,
  stone_bricks: stoneBricks,
  smooth_stone: smoothStone,
  bricks,
  oak_planks: planks("#a3834f"),
  spruce_planks: planks("#6f5334"),
  birch_planks: planks("#c4b179"),
  dark_oak_planks: planks("#4b301a"),
  oak_log: bark("#6a5234"),
  oak_log_top: rings("#b29159", "#6a5234"),
  spruce_log: bark("#3d2a17"),
  spruce_log_top: rings("#8a6a42", "#3d2a17"),
  sand,
  gravel,
  dirt,
  grass_block_top: grassTop,
  grass_block_side: grassSide,
  sandstone: sandstoneSide,
  sandstone_top: sandstoneTop,
  sandstone_bottom: sandstoneBottom,
  glass,
  glass_pane_top: glassPaneTop,
  quartz_block_side: quartzSide,
  quartz_block_top: quartzTop,
  iron_block: ironBlock,
  glowstone,
  terracotta: flat("#97604a", 0.05),
  oak_leaves: leaves,
  undecided,
  white_concrete: concrete("#d0d5d6"),
  light_gray_concrete: concrete("#7e7e75"),
  gray_concrete: concrete("#383b3f"),
  black_concrete: concrete("#0d0e13"),
  cyan_concrete: concrete("#177686"),
  blue_concrete: concrete("#2d308c"),
  red_concrete: concrete("#8c2423"),
  yellow_concrete: concrete("#eaae1c"),
};

export const DEFAULT_TEXTURE_KEYS = Object.keys(PAINTERS);

/** Paints one default texture. */
export function paintTexture(key: string): Texture {
  const painter = PAINTERS[key];
  if (!painter) throw new RangeError(`No default texture ${key}`);
  const canvas = new Canvas(key);
  painter(canvas);
  return textureOf(canvas.rgba);
}

/** A texture from RGBA pixels: its alpha use and average colour worked out. */
export function textureOf(rgba: Uint8Array, size = SIZE): Texture {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let cut = false;
  let blend = false;
  for (let i = 0; i < size * size; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    if (a === 0) cut = true;
    else if (a < 255) blend = true;
    if (a < 128) continue;
    r += rgba[i * 4] ?? 0;
    g += rgba[i * 4 + 1] ?? 0;
    b += rgba[i * 4 + 2] ?? 0;
    n++;
  }
  const alpha: Alpha = blend ? "blend" : cut ? "cutout" : "opaque";
  const color = n > 0 ? toHex([r / n, g / n, b / n]) : "#808080";
  return { size, rgba, alpha, color };
}
