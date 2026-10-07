// A tiny pixel canvas for drawing the default textures in code: seeded, so every build of the
// app draws the same pixels, and original by construction (nothing is copied from any game).

export type Rgb = readonly [number, number, number];

export function hex(color: string): Rgb {
  const n = Number.parseInt(color.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function toHex([r, g, b]: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Scales a colour's brightness: 1 keeps it, below darkens, above lightens. */
export function shade(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** A seeded random number generator (mulberry32), seeded from a string. */
export function random(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIZE = 16;

export class Canvas {
  readonly rgba = new Uint8Array(SIZE * SIZE * 4);
  readonly rand: () => number;

  constructor(seed: string) {
    this.rand = random(seed);
  }

  set(x: number, y: number, c: Rgb, alpha = 255): void {
    const i = (((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4;
    this.rgba[i] = Math.round(Math.min(255, Math.max(0, c[0])));
    this.rgba[i + 1] = Math.round(Math.min(255, Math.max(0, c[1])));
    this.rgba[i + 2] = Math.round(Math.min(255, Math.max(0, c[2])));
    this.rgba[i + 3] = alpha;
  }

  get(x: number, y: number): Rgb {
    const i = (((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4;
    return [this.rgba[i] ?? 0, this.rgba[i + 1] ?? 0, this.rgba[i + 2] ?? 0];
  }

  alpha(x: number, y: number): number {
    return this.rgba[(((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4 + 3] ?? 0;
  }

  /** Every pixel from a function of its position. */
  each(f: (x: number, y: number) => Rgb | null): this {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const c = f(x, y);
        if (c) this.set(x, y, c);
      }
    return this;
  }

  fill(c: Rgb): this {
    return this.each(() => c);
  }

  /** Varies each pixel's brightness by up to +/- amount. */
  noise(amount: number): this {
    return this.each((x, y) => shade(this.get(x, y), 1 + (this.rand() * 2 - 1) * amount));
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb): this {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, c);
    return this;
  }

  /** Multiplies a rectangle's brightness. */
  tone(x0: number, y0: number, x1: number, y1: number, k: number): this {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) this.set(x, y, shade(this.get(x, y), k));
    return this;
  }

  /** Scatters `count` single-pixel specks of brightness k. */
  specks(count: number, k: number): this {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(this.rand() * SIZE);
      const y = Math.floor(this.rand() * SIZE);
      this.set(x, y, shade(this.get(x, y), k));
    }
    return this;
  }

  clear(x: number, y: number): void {
    this.rgba[(y * SIZE + x) * 4 + 3] = 0;
  }
}
