// Pack a renderer readback into tight RGBA rows. WebGPU's copy aligns each row to 256
// bytes and does not pad the last one; WebGL is already tight and bottom-up.

/** Tight top-down RGBA, `width * height * 4` bytes. */
export function packRgba(
  src: ArrayBufferView,
  width: number,
  height: number,
  flipY: boolean,
): Uint8ClampedArray {
  const pixels =
    src instanceof Uint8Array ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  const tight = width * 4;
  const aligned = Math.ceil(tight / 256) * 256;
  const padded = (height - 1) * aligned + tight;
  const stride =
    pixels.length === width * height * 4 ? tight : pixels.length >= padded ? aligned : 0;
  if (stride === 0) {
    throw new Error(
      `Capture read back ${pixels.length} bytes for a ${width}×${height} image, which is neither tight RGBA nor 256-byte-aligned rows.`,
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = flipY ? height - 1 - y : y;
    const start = srcY * stride;
    out.set(pixels.subarray(start, start + tight), y * tight);
  }
  return out;
}
