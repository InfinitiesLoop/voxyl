// Cell states as JSON, shared by the project manifest and pieces (clipboard and prefabs):
// [semantic, rotation, tags?, parts as [semantic, shape, slot]?]. Semantic numbers mean
// whatever the container says (registry ids in a manifest, 1-based indices in a piece).

import type { CellState, TagValue } from "../cell-state.ts";

export type StateJSON =
  | [number, number]
  | [number, number, Record<string, TagValue>]
  | [number, number, Record<string, TagValue>, [number, string, number][]];

/** A state as JSON, with its semantics renumbered by `semantic`. */
export function stateJSON(s: CellState, semantic: (id: number) => number = (id) => id): StateJSON {
  const tags = Object.keys(s.tags).length > 0 ? { ...s.tags } : null;
  if (s.parts.length > 0) {
    return [0, s.rotation, tags ?? {}, s.parts.map((p) => [semantic(p.semantic), p.shape, p.slot])];
  }
  return tags ? [semantic(s.semantic), s.rotation, tags] : [semantic(s.semantic), s.rotation];
}

/** The state input for JSON, with its semantics renumbered by `semantic`. */
export function stateInput(s: StateJSON, semantic: (n: number) => number = (n) => n) {
  const [sem, rotation, tags, parts] = s;
  return {
    ...(parts ? {} : { semantic: semantic(sem) }),
    rotation,
    ...(tags && Object.keys(tags).length > 0 && { tags }),
    ...(parts && {
      parts: parts.map(([p, shape, slot]) => ({ semantic: semantic(p), shape, slot })),
    }),
  };
}
