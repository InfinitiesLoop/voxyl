// Resizing a square RGBA picture, for places that show a texture at a size of their own (the
// block chooser's list icons are 16 px, its turning preview is drawn from one size for all six
// faces). Imported textures come in whatever size the mod used: 16 for vanilla, 32 or 64 for
// high-resolution packs, so showing one must never depend on it being 16.

/**
 * `rgba` (size * size * 4 bytes) as a `to` * `to` picture. Smaller picks pixels (each source
 * pixel becomes a block of the result); larger averages the source pixels each result pixel
 * covers, weighting colour by alpha so a see-through edge doesn't darken the fringe.
 */
export function resampleSquare(rgba: Uint8Array, size: number, to: number): Uint8Array {
  if (size === to) return rgba.slice();
  const out = new Uint8Array(to * to * 4);
  if (size <= 0 || rgba.length < size * size * 4) return out;
  for (let y = 0; y < to; y++) {
    const y0 = Math.floor((y * size) / to);
    const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * size) / to));
    for (let x = 0; x < to; x++) {
      const x0 = Math.floor((x * size) / to);
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * size) / to));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < Math.min(y1, size); sy++) {
        for (let sx = x0; sx < Math.min(x1, size); sx++) {
          const i = (sy * size + sx) * 4;
          const alpha = rgba[i + 3] ?? 0;
          r += (rgba[i] ?? 0) * alpha;
          g += (rgba[i + 1] ?? 0) * alpha;
          b += (rgba[i + 2] ?? 0) * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * to + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = n > 0 ? Math.round(a / n) : 0;
    }
  }
  return out;
}
