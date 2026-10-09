// Chisel's display names, read from the en_US.lang inside its own jar. Chisel hardcodes its
// variations in Java (see legacy/chisel-variations.ts), so the lang file is the only place that
// names them. Two families don't follow the usual key shape and need their own tables below.

/**
 * `chisel.<group>` -> the group's display name, `<group>.<meta>` -> a variant's, and
 * `SGP_DISPLAY:<group>:<meta>` -> the dyed glass families' variants (see `addDyedGlassNames`).
 *
 * Keys come from two lang shapes: `tile.chisel.<group>.name` (the group) and
 * `tile.<group>.<meta>.desc` (a variant). Anything else in the file is only kept raw, for the
 * dyed glass lookups.
 */
export function parseChiselLang(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const raw = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    raw.set(key, value);
    if (key.startsWith("tile.chisel.") && key.endsWith(".name")) {
      out.set(`chisel.${key.slice("tile.chisel.".length, -".name".length)}`, value);
    } else if (key.startsWith("tile.") && key.endsWith(".desc")) {
      out.set(key.slice("tile.".length, -".desc".length), value);
    }
  }
  addStainedGlassNames(out, raw);
  return out;
}

// Chisel's two dyed-glass families ("stained_glass_<color>" and "stained_glass_pane_<color>")
// name their variants "<featureColor>.<style>.desc" and "<featureColor>.pane.<style>.desc", not
// the "tile.<group>.<meta>.desc" shape parsed above. They are injected under the
// "SGP_DISPLAY:<group>:<meta>" keys the healer checks first, ahead of its meta-0 shortcut: unlike
// every other group, meta 0 here IS a real named variant, not flavour text.
//
// color -> meta base, one table per family (the two pack a different number of colours onto each
// shared block: 4 colours per block for the plain family, 2 for the pane family, the
// (i & 3) << 2 vs (i & 1) << 3 of the table's own comment).
const GLASS_META_BASE: Readonly<Record<string, number>> = {
  white: 0,
  orange: 4,
  magenta: 8,
  lightblue: 12,
  yellow: 0,
  lime: 4,
  pink: 8,
  gray: 12,
  lightgray: 0,
  cyan: 4,
  purple: 8,
  blue: 12,
  brown: 0,
  green: 4,
  red: 8,
  black: 12,
};

const GLASS_PANE_META_BASE: Readonly<Record<string, number>> = {
  white: 0,
  orange: 8,
  magenta: 0,
  lightblue: 8,
  yellow: 0,
  lime: 8,
  pink: 0,
  gray: 8,
  lightgray: 0,
  cyan: 8,
  purple: 0,
  blue: 8,
  brown: 0,
  green: 8,
  red: 0,
  black: 8,
};

/** featureColors[] disagrees with the group's colour name only here; the rest match. */
const GLASS_LANG_COLOR: Readonly<Record<string, string>> = { gray: "darkgray" };

/** (meta offset from the colour's base, the lang key's style fragment). The plain family has
 *  only the first four: no quadrant styles. */
const GLASS_STYLES: readonly (readonly [number, string])[] = [
  [0, "bubble"],
  [1, "glass"],
  [2, "glass.fancy"],
  [3, "glass.noborder"],
];

const GLASS_PANE_STYLES: readonly (readonly [number, string])[] = [
  ...GLASS_STYLES,
  [4, "glass.quadrant"],
  [5, "glass.fancyquadrant"],
];

function addStainedGlassNames(out: Map<string, string>, raw: ReadonlyMap<string, string>): void {
  for (const [color, base] of Object.entries(GLASS_META_BASE)) {
    addDyedGlassNames(out, raw, `stained_glass_${color}`, base, color, "");
  }
  for (const [color, base] of Object.entries(GLASS_PANE_META_BASE)) {
    addDyedGlassNames(out, raw, `stained_glass_pane_${color}`, base, color, "pane.");
  }
}

function addDyedGlassNames(
  out: Map<string, string>,
  raw: ReadonlyMap<string, string>,
  group: string,
  base: number,
  color: string,
  infix: string,
): void {
  const langColor = GLASS_LANG_COLOR[color] ?? color;
  for (const [offset, style] of infix ? GLASS_PANE_STYLES : GLASS_STYLES) {
    const name = raw.get(`${langColor}.${infix}${style}.desc`);
    if (name !== undefined) out.set(`SGP_DISPLAY:${group}:${base + offset}`, name);
  }
}

/**
 * A group folder name as words, for a group the lang file doesn't name. Same words as the Godot
 * importer's String.capitalize() (so a library imported by either names a block the same):
 * underscores become spaces, camelCase and letter/digit boundaries split ("hexPlating2" ->
 * "Hex Plating 2"), then each word is lowercased with its first letter upper-cased.
 */
export function prettifyGroup(folder: string): string {
  const s = folder.replaceAll("_", " ");
  const upper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
  const lower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
  const digit = (c: string) => c >= "0" && c <= "9";
  let spaced = "";
  let start = 0;
  for (let i = 1; i < s.length; i++) {
    const prev = s.charAt(i - 1);
    const cur = s.charAt(i);
    const nextLower = i + 1 < s.length && lower(s.charAt(i + 1));
    const breaks =
      (lower(prev) && upper(cur)) ||
      ((upper(prev) || digit(prev)) && upper(cur) && nextLower) ||
      (digit(prev) && lower(cur) && nextLower) ||
      ((upper(prev) || lower(prev)) && digit(cur));
    if (breaks) {
      spaced += `${s.slice(start, i)}_`;
      start = i;
    }
  }
  spaced += s.slice(start);
  return spaced
    .toLowerCase()
    .replaceAll("_", " ")
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
