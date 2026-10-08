// "What do I have to gather?" and "what is in this export?": a piece's contents read two ways,
// both through the palette as it is now and never stored (principles 1 and 3).
//
//   semanticRows   one row per semantic, with how many cells and parts use it and whether it can
//                  be exported (the include list, ticked and unticked by semantic);
//   materialRows   the same cells tallied by the ACTUAL block each semantic's look names, so two
//                  semantics on the same block merge, and a shaped part is its own item (a slab
//                  of a block isn't that block). An undecided semantic has no block to gather
//                  yet, so it keeps a row of its own. Port of the Godot app's MaterialList.gd.

import type { Piece } from "@voxyl/core";
import { shapeName } from "@voxyl/shapes";
import { tallyStates } from "./export.ts";
import { type IdentityResolver, identityText, type McIdentity } from "./identity.ts";

/** One inventory stack. */
export const STACK_SIZE = 64;

/** A quantity as stacks: "7×64 + 52", "8×64" when it fills them exactly, "" below one stack. */
export function stacksText(count: number): string {
  if (count < STACK_SIZE) return "";
  const rest = count % STACK_SIZE;
  const full = (count - rest) / STACK_SIZE;
  return rest > 0 ? `${full}×${STACK_SIZE} + ${rest}` : `${full}×${STACK_SIZE}`;
}

export type SemanticStatus =
  /** Has a block with a confirmed Minecraft identity. */
  | "ok"
  /** No block chosen yet: left out of the file. */
  | "undecided"
  /** A block with no confirmed Minecraft identity: left out of the file. */
  | "unmapped";

export interface SemanticRow {
  /** The piece's 1-based semantic number (what `exclude` takes). */
  readonly semantic: number;
  readonly name: string;
  /** Whole blocks of it. */
  readonly blocks: number;
  /** Parts of it, by shape id. */
  readonly parts: Readonly<Record<string, number>>;
  /** blocks plus all parts. */
  readonly count: number;
  readonly status: SemanticStatus;
  /** The block its look names ("library:block"), when there is one. */
  readonly block: string | null;
  readonly identity: McIdentity | null;
}

function status(
  piece: Piece,
  identify: IdentityResolver,
  semantic: number,
): { status: SemanticStatus; block: string | null; identity: McIdentity | null; glow: boolean } {
  const look = piece.semantics[semantic - 1]?.look;
  const block = look?.block ?? null;
  if (block === null || block === "") {
    return { status: "undecided", block: null, identity: null, glow: false };
  }
  const identity = identify(block);
  return {
    status: identity ? "ok" : "unmapped",
    block,
    identity,
    glow: look?.glow === true,
  };
}

/** Every semantic the piece uses, busiest first. */
export function semanticRows(piece: Piece, identify: IdentityResolver): SemanticRow[] {
  const counts = tallyStates(piece);
  const blocks = new Map<number, number>();
  const parts = new Map<number, Record<string, number>>();
  for (let n = 1; n < counts.length; n++) {
    const c = counts[n] ?? 0;
    const state = piece.states[n - 1];
    if (c === 0 || !state) continue;
    const [semantic, , , list] = state;
    if (list && list.length > 0) {
      for (const [s, shape] of list) {
        const mine = parts.get(s) ?? {};
        mine[shape] = (mine[shape] ?? 0) + c;
        parts.set(s, mine);
      }
    } else {
      blocks.set(semantic, (blocks.get(semantic) ?? 0) + c);
    }
  }
  const rows: SemanticRow[] = [];
  for (let s = 1; s <= piece.semantics.length; s++) {
    const own = blocks.get(s) ?? 0;
    const shaped = parts.get(s) ?? {};
    const count = own + Object.values(shaped).reduce((sum, v) => sum + v, 0);
    if (count === 0) continue;
    const found = status(piece, identify, s);
    rows.push({
      semantic: s,
      name: piece.semantics[s - 1]?.name ?? `#${s}`,
      blocks: own,
      parts: shaped,
      count,
      status: found.status,
      block: found.block,
      identity: found.identity,
    });
  }
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface MaterialRow {
  /** "library:block", or null while undecided. */
  readonly block: string | null;
  /** A part's shape id, or null for whole blocks. */
  readonly shape: string | null;
  readonly glow: boolean;
  readonly count: number;
  /** The semantics merged into this row, with how many each contributed. */
  readonly semantics: Readonly<Record<string, number>>;
  readonly undecided: boolean;
  readonly identity: McIdentity | null;
}

/** What to gather to build the kept cells in the game, busiest first. */
export function materialRows(
  piece: Piece,
  identify: IdentityResolver,
  exclude: ReadonlySet<number> = new Set(),
): MaterialRow[] {
  const counts = tallyStates(piece);
  const rows = new Map<
    string,
    {
      block: string | null;
      shape: string | null;
      glow: boolean;
      count: number;
      semantics: Record<string, number>;
      identity: McIdentity | null;
    }
  >();
  const add = (semantic: number, shape: string | null, count: number) => {
    const found = status(piece, identify, semantic);
    const glow = shape !== null && found.glow;
    const name = piece.semantics[semantic - 1]?.name ?? `#${semantic}`;
    const key = found.block === null ? `?${name}|${shape}` : `${found.block}|${shape}|${glow}`;
    let row = rows.get(key);
    if (!row) {
      row = { block: found.block, shape, glow, count: 0, semantics: {}, identity: found.identity };
      rows.set(key, row);
    }
    row.count += count;
    row.semantics[name] = (row.semantics[name] ?? 0) + count;
  };
  for (let n = 1; n < counts.length; n++) {
    const c = counts[n] ?? 0;
    const state = piece.states[n - 1];
    if (c === 0 || !state) continue;
    const [semantic, , , list] = state;
    if (list && list.length > 0) {
      for (const [s, shape] of list) if (!exclude.has(s)) add(s, shape, c);
    } else if (!exclude.has(semantic)) {
      add(semantic, null, c);
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, undecided: r.block === null }))
    .sort((a, b) => b.count - a.count || materialTitle(a).localeCompare(materialTitle(b)));
}

/** "oak planks" -> a row's name: the block, or "Undecided (Mass)", with its shape and glow. */
export function materialTitle(
  row: MaterialRow,
  label: (blockRef: string) => string = (ref) => ref,
): string {
  let text =
    row.block === null ? `Undecided (${Object.keys(row.semantics).join(", ")})` : label(row.block);
  if (row.shape !== null) text += ` · ${shapeName(row.shape)}${row.glow ? " (glow)" : ""}`;
  return text;
}

/** Plain text for the clipboard, one item per line: "500× Oak planks  (7×64 + 52)  [minecraft:planks]". */
export function materialText(
  rows: readonly MaterialRow[],
  label?: (blockRef: string) => string,
): string {
  return rows
    .map((row) => {
      const stacks = stacksText(row.count);
      const id = row.identity ? identityText(row.identity) : "";
      return `${row.count}× ${materialTitle(row, label)}${stacks ? `  (${stacks})` : ""}${id ? `  [${id}]` : ""}`;
    })
    .join("\n");
}
