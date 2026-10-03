export { FULL_SKY, LightEngine, type LightMaterials, SKY_SHIFT } from "./engine.ts";

/** Packs an emission colour ("#rrggbb") and level (0..15) into the engine's r << 8 | g << 4 | b. */
export function packEmission(color: string, level: number): number {
  const rgb = Number.parseInt(color.replace("#", ""), 16);
  const scale = (c: number) => Math.round((Math.min(15, Math.max(0, level)) * c) / 255);
  return (scale((rgb >> 16) & 0xff) << 8) | (scale((rgb >> 8) & 0xff) << 4) | scale(rgb & 0xff);
}
