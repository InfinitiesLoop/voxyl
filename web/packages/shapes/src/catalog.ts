// The shapes a semantic can take, as the shape picker lists them: pages of ids with readable
// names. A semantic's form names a shape by id; geometry words only, nothing mod-specific.

import { ARCH_SHAPES } from "./arch.ts";
import { MICRO_SHAPES } from "./micro.ts";

export interface ShapePage {
  readonly title: string;
  readonly ids: readonly string[];
}

const archIds = Object.keys(ARCH_SHAPES);

/** Microblocks first, then the architecture shapes by kind. */
export const SHAPE_PAGES: readonly ShapePage[] = [
  { title: "Microblocks", ids: Object.keys(MICRO_SHAPES) },
  { title: "Roofing", ids: archIds.filter((id) => id.startsWith("roof_")) },
  { title: "Slopes", ids: archIds.filter((id) => id.startsWith("slope_")) },
];

/** A shape's readable name, or its id when it isn't known. */
export function shapeName(shape: string): string {
  return MICRO_SHAPES[shape]?.name ?? ARCH_SHAPES[shape]?.name ?? shape;
}
