// The narrow texture match for a confirmed roster entry. Pre-1.8 mods have no models, so the
// only link between a block and its pictures is a file name. The roster already says WHICH
// blocks exist (registry, meta); this only looks, for one such entry, in that mod's own
// `textures/blocks/` and then vanilla's shared "minecraft" domain, for files whose names
// correlate with the registry name and, for a meta-packed block, with the meta. One confident
// hit binds; none, or an ambiguous one, is a miss and the entry is dropped by the caller, never
// guessed. This is deliberately narrower than guessing block boundaries from file names (which
// made "weird blocks that use textures in ways blocks never do"): the roster gives the
// boundaries, and the face-suffix words (top, side, bottom...) are only read within one
// block's own files.
//
// The functions here are pure (a listing in, a decision out) so each rule has its own test.

import type { McSide } from "@voxyl/blocks";
import type { AssetSource } from "../sources/index.ts";
import { isValidInt, splitRef } from "./nei.ts";

const [N, E, S, W, U, D] = ["north", "east", "south", "west", "up", "down"] as const;
const HORIZONTAL: readonly McSide[] = [N, E, S, W];

/** Face word -> the sides it fills. */
export const FACE_WORDS: ReadonlyMap<string, readonly McSide[]> = new Map([
  ["top", [U]],
  ["up", [U]],
  ["bottom", [D]],
  ["down", [D]],
  ["bot", [D]],
  ["side", HORIZONTAL],
  ["sides", HORIZONTAL],
  ["front", [N]],
  ["facing", [N]],
  ["back", [S]],
  ["rear", [S]],
  ["left", [W]],
  ["right", [E]],
  ["north", [N]],
  ["south", [S]],
  ["east", [E]],
  ["west", [W]],
  ["end", [U, D]],
  ["ends", [U, D]],
  ["cap", [U, D]],
]);

/** Words of a render state a texture can carry without being another block. */
const STATE_WORDS: ReadonlySet<string> = new Set([
  "on",
  "off",
  "active",
  "inactive",
  "lit",
  "unlit",
]);

/** The order sides are given a default texture in. */
const SIDE_ORDER: readonly McSide[] = [U, D, N, S, E, W];

/**
 * Lowercase tokens of a name, split on `_ . - space ( )` and camelCase boundaries: "korp_ (4)"
 * is ["korp", "4"], "BlockControllerColumn" is ["block", "controller", "column"]. A digit counts
 * as lowercase, so "4kBlock" splits before the B. Only ASCII letters are cased for the split.
 */
export function tokenize(name: string): string[] {
  const out: string[] = [];
  let cur = "";
  let prevLower = false;
  for (const ch of name) {
    if (ch === "_" || ch === "." || ch === "-" || ch === " " || ch === "(" || ch === ")") {
      if (cur !== "") out.push(cur.toLowerCase());
      cur = "";
      prevLower = false;
      continue;
    }
    const upper = ch >= "A" && ch <= "Z";
    if (upper && prevLower && cur !== "") {
      out.push(cur.toLowerCase());
      cur = "";
    }
    cur += ch;
    prevLower = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
  }
  if (cur !== "") out.push(cur.toLowerCase());
  return out;
}

/**
 * The tokens a block's texture files must start with: the registry's local part, tokenized the
 * way a file name is. "tile.korpBlock" is ["korp"]; "ancient_debris" is ["ancient", "debris"],
 * matching a same-shaped file token for token (a single glued "ancient_debris" is a string no
 * real file name would produce). A leading "tile." is stripped, and so is a trailing "block" or
 * "blocks" token (Java's "korpBlock" never appears in the texture name) unless it is all there is.
 */
export function baseTokens(registry: string): string[] {
  let local = splitRef(registry).path;
  if (local.toLowerCase().startsWith("tile.")) local = local.slice(5);
  const tokens = tokenize(local);
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && (last === "block" || last === "blocks")) tokens.pop();
  return tokens;
}

/**
 * Whether `toks` is `base` exactly, or `base` followed ONLY by tokens that read as this same
 * block's own suffix (a numeral, a face or state word, or "block"/"blocks"): never an unrelated
 * longer name that merely starts with the same words. Without this, base ["copper"] (from
 * "copper_block") matched "copper_barrel_bottom" and made the block of copper wear barrel textures
 * instead of falling through to vanilla's own copper_block.
 */
export function matchesBase(toks: readonly string[], base: readonly string[]): boolean {
  if (base.length === 0 || toks.length < base.length) return false;
  for (let i = 0; i < base.length; i++) if (toks[i] !== base[i]) return false;
  for (let i = base.length; i < toks.length; i++) {
    const t = toks[i] as string;
    if (
      !(isValidInt(t) || FACE_WORDS.has(t) || STATE_WORDS.has(t) || t === "block" || t === "blocks")
    )
      return false;
  }
  return true;
}

/** One texture file that may belong to the block. */
export interface Candidate {
  /** The path under `textures/<subdir>/` without ".png" ("sub/agon"). */
  readonly name: string;
  /** "blocks", or "block" for the rare mod that uses the later folder name. */
  readonly subdir: "blocks" | "block";
  /** The tokens of the file's leaf name. */
  readonly toks: readonly string[];
}

/** The trailing integer of tokens ("korp_ (4)" -> 4), or -1 when the name has no number. */
export function trailingNumber(toks: readonly string[]): number {
  const last = toks[toks.length - 1];
  return last !== undefined && isValidInt(last) ? Number.parseInt(last, 10) : -1;
}

/**
 * The face word a name ends with once trailing numbers and state words are stripped, or ""
 * for a plain whole-block texture.
 */
export function faceOf(toks: readonly string[]): string {
  const t = [...toks];
  while (t.length > 0) {
    const last = t[t.length - 1] as string;
    if (!isValidInt(last) && !STATE_WORDS.has(last)) break;
    t.pop();
  }
  const last = t[t.length - 1];
  return last !== undefined && FACE_WORDS.has(last) ? last : "";
}

export type Faces = Partial<Record<McSide, Candidate>>;

/**
 * Which candidate draws each side of the block with this `meta`, or null when nothing confidently
 * matches. Candidates carrying a number are meta variants; the rest are one block's own faces.
 *
 * - If any file carries a number that only one file carries, the block is meta-packed: its
 *   meta's file draws every side, or there is no match (no other meta's file is borrowed).
 * - Otherwise only meta 0 may bind: a registry with several confirmed metas has the same
 *   candidate pool for each, and meta 1+ silently reusing meta 0's plain texture would be a
 *   confident-looking wrong picture (AE2's 4k/16k/64k crafting storage), worse than a drop.
 * - Face words fill their sides (a one-side word before a wider one: "top" before "side"); any
 *   side left takes the plain whole-block file, else the first face file. With no face word at
 *   all there must be exactly one plain file.
 */
export function resolveFaces(candidates: readonly Candidate[], meta: number): Faces | null {
  const seen = new Map<number, Candidate | null>();
  for (const c of candidates) {
    const n = trailingNumber(c.toks);
    if (n < 0) continue;
    // More than one file for a number makes it ambiguous: no file of it is used.
    seen.set(n, seen.has(n) ? null : c);
  }
  const numbered = new Map<number, Candidate>();
  for (const [n, c] of seen) if (c) numbered.set(n, c);
  if (numbered.size > 0) {
    const c = numbered.get(meta);
    if (!c) return null;
    return { up: c, down: c, north: c, south: c, east: c, west: c };
  }
  if (meta !== 0) return null;

  const byFace = new Map<string, Candidate>();
  const wholes: Candidate[] = [];
  for (const c of candidates) {
    const face = faceOf(c.toks);
    if (face === "") wholes.push(c);
    else if (!byFace.has(face)) byFace.set(face, c);
  }
  if (byFace.size === 0 && wholes.length !== 1) return null;

  const out: Faces = {};
  // Stable, so words that fill the same number of sides keep the order their files were listed in.
  const words = [...byFace.keys()].sort(
    (a, b) => (FACE_WORDS.get(a)?.length ?? 0) - (FACE_WORDS.get(b)?.length ?? 0),
  );
  for (const word of words) {
    const c = byFace.get(word) as Candidate;
    for (const side of FACE_WORDS.get(word) ?? []) if (!out[side]) out[side] = c;
  }
  const fallback = (wholes[0] ?? byFace.values().next().value) as Candidate;
  for (const side of SIDE_ORDER) if (!out[side]) out[side] = fallback;
  return out;
}

/**
 * The tokenized texture files of one namespace, indexed by their first token. A mod with
 * thousands of roster rows (GregTech: ~14k) asks for the same listing once per row, so the
 * tokenizing is done once and a lookup only looks at files that start with the right word. The
 * result is exactly what scanning the whole listing in order would give.
 */
export class TextureIndex {
  readonly #byFirst = new Map<string, Candidate[]>();

  /** Every .png under `<ns>/textures/blocks`, recursively; the older "block" folder if that is empty. */
  static of(source: AssetSource, ns: string): TextureIndex {
    let subdir: Candidate["subdir"] = "blocks";
    let files = source.listFilesRecursive(`${ns}/textures/blocks`);
    if (files.length === 0) {
      files = source.listFilesRecursive(`${ns}/textures/block`);
      subdir = "block";
    }
    return new TextureIndex(files, subdir);
  }

  constructor(files: readonly string[], subdir: Candidate["subdir"] = "blocks") {
    for (const f of files) {
      if (!f.endsWith(".png")) continue;
      const name = f.slice(0, -4);
      const toks = tokenize(name.slice(name.lastIndexOf("/") + 1)); // the leaf, not the subpath
      const first = toks[0];
      if (first === undefined) continue;
      let bucket = this.#byFirst.get(first);
      if (!bucket) {
        bucket = [];
        this.#byFirst.set(first, bucket);
      }
      bucket.push({ name, subdir, toks });
    }
  }

  /** The files whose tokens are `base` followed only by suffix words, in listing order. */
  matching(base: readonly string[]): Candidate[] {
    const first = base[0];
    const bucket = first === undefined ? undefined : this.#byFirst.get(first);
    return bucket ? bucket.filter((c) => matchesBase(c.toks, base)) : [];
  }
}

/** Letters and digits only, lowercased: "BuildCraft|Core" and "buildcraftcore" are one key. */
export function norm(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase())
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  return out;
}

/**
 * A few mods' @Mod id doesn't reduce to their assets folder even after `norm`, confirmed per jar
 * and never guessed: ProjectRed splits into ids "ProjRed|<Submodule>" that all share ONE
 * "assets/projectred/"; Extra Utilities registers as "ExtraUtilities" but ships
 * "assets/extrautils/" (normalizing can reformat a word, not shorten it).
 */
const NAMESPACE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["projredcore", "projectred"],
  ["projredillumination", "projectred"],
  ["projredtransmission", "projectred"],
  ["projredexploration", "projectred"],
  ["projredexpansion", "projectred"],
  ["projredfabrication", "projectred"],
  ["extrautilities", "extrautils"],
]);

/** A namespace's source and the real, on-disk spelling of the namespace. */
export interface Resolved {
  readonly source: AssetSource;
  readonly ns: string;
}

/**
 * Finds the source for a namespace name from a roster, which is not always spelled the way the
 * jar's folder is. Many 1.7.10 mods register blocks under their raw @Mod id ("Ztones",
 * "BuildCraft|Core", "AWWayofTime") while resource paths are always lowercase and sanitized
 * ("ztones", "buildcraftcore"). Tried in turn: the exact name (any case), the name reduced to
 * letters and digits, then the alias table. The result carries the REAL namespace, not the
 * row's own spelling: a zip entry is matched byte for byte, so "Ztones/textures/..." never finds
 * an entry stored as "ztones/textures/...".
 */
export class NamespaceResolver {
  readonly #sources = new Map<string, AssetSource>(); // lowercased namespace -> source
  readonly #realByLower = new Map<string, string>();
  readonly #realByNorm = new Map<string, string>();

  /**
   * `wrap` makes the one source for a namespace out of every source that provides it: a big
   * mod's own jar plus small satellite mods that patch a few more textures into its namespace
   * (GregTech has three), read as a union, so which jar lists last never hides the real one.
   */
  constructor(
    sources: readonly AssetSource[],
    wrap: (sources: readonly AssetSource[]) => AssetSource,
  ) {
    const byNs = new Map<string, AssetSource[]>();
    for (const s of sources) {
      for (const ns of s.namespaces()) {
        const lower = ns.toLowerCase();
        let list = byNs.get(lower);
        if (!list) {
          list = [];
          byNs.set(lower, list);
          this.#realByLower.set(lower, ns);
          this.#realByNorm.set(norm(ns), ns);
        }
        list.push(s);
      }
    }
    // A namespace of only one source still gets its own wrapper, so nothing special-cases one vs. many.
    for (const [lower, list] of byNs) this.#sources.set(lower, wrap(list));
  }

  resolve(ns: string): Resolved | null {
    const lower = ns.toLowerCase();
    const exact = this.#sources.get(lower);
    if (exact) return { source: exact, ns: this.#realByLower.get(lower) as string };
    const key = norm(ns);
    const real = this.#realByNorm.get(key) ?? NAMESPACE_ALIASES.get(key);
    const source = real === undefined ? undefined : this.#sources.get(real.toLowerCase());
    return real !== undefined && source ? { source, ns: real } : null;
  }
}

/** What the narrow match decided for one roster row. */
export type Attachment =
  | { readonly kind: "no-source" }
  | { readonly kind: "none" }
  | { readonly kind: "match"; readonly tier: Resolved; readonly faces: Faces };

/**
 * Matches one roster row (its registry, meta, namespace and mod label) to texture files. The
 * block's own namespace is tried first (then the mod's label, a second guess at the folder),
 * then vanilla's shared "minecraft" domain: a backport mod (EtFuturum, bringing newer blocks to
 * 1.7.10) registers blocks under its own id but ships most of their PNGs under
 * assets/minecraft/textures/blocks/, 559 of its 664 in the real GTNH jar. That widens WHERE the
 * search looks; the match stays exactly as narrow, one confident hit.
 */
export function attach(
  row: { registry: string; meta: number; ns: string; mod: string },
  resolver: NamespaceResolver,
  indexOf: (tier: Resolved) => TextureIndex,
): Attachment {
  const resolved = resolver.resolve(row.ns) ?? resolver.resolve(row.mod);
  if (!resolved) return { kind: "no-source" };
  const base = baseTokens(row.registry);
  if (base.length === 0) return { kind: "none" };
  const tiers = [resolved];
  const vanilla = resolver.resolve("minecraft");
  if (vanilla && vanilla.ns !== resolved.ns) tiers.push(vanilla);
  for (const tier of tiers) {
    const candidates = indexOf(tier).matching(base);
    if (candidates.length === 0) continue;
    const faces = resolveFaces(candidates, row.meta);
    if (faces) return { kind: "match", tier, faces };
  }
  return { kind: "none" };
}
