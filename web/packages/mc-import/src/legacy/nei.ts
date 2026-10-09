// NEI's own "Data Dumps" (Options -> Tools -> Data Dumps) as a roster of everything placeable
// in a pre-1.8 modpack: real registry name, meta, display name and mod, straight from the
// live Forge/NEI registry, never guessed. Three CSV files:
//
//   item.csv      Name, ID, Has Block, Mod, Class, Display Name. One row per registered Item.
//                 Only "Has Block" and the "Mod" label are used: which registry names are
//                 placeable, and their human mod grouping.
//   itempanel.csv Item Name, Item ID, Item meta, Has NBT, Display Name. One row per real
//                 SUBTYPE (what Item.getSubItems() lists, which is what NEI's own browsable
//                 list shows): this is what resolves meta-packed variants (Ztones "Korp 0".."15")
//                 and things with no registry-level identity at all (GregTech machines: one
//                 item id for every tier, told apart only by this meta).
//   block.csv     Name, ID, Has Item, Mod, Class, Display Name. EVERY registered block, item
//                 form or not. Only the numeric id is used, which schematic export needs even
//                 for a block nothing crafts (ForgeMultipart's placeholder world block).
//
// General to any 1.7.10 to 1.12 modpack that ships NEI, not GregTech-specific.

import { parseCsv } from "./csv.ts";

const ITEM_HEADER = ["Name", "ID", "Has Block", "Mod", "Class", "Display Name"];
const ITEMPANEL_HEADER = ["Item Name", "Item ID", "Item meta", "Has NBT", "Display Name"];
const BLOCK_HEADER = ["Name", "ID", "Has Item", "Mod", "Class", "Display Name"];

/** A dump that is missing or isn't the file it should be; the message says which. */
export class NeiDumpError extends Error {
  override readonly name = "NeiDumpError";
}

/** What item.csv says about a placeable registry name. */
export interface Placeable {
  readonly mod: string;
  /** The registry name's own prefix ("gregtech" of "gregtech:gt.blockmachines"). */
  readonly ns: string;
  /** The numeric id of this install, -1 when item.csv has none. */
  readonly legacyId: number;
}

/** One real subtype of a placeable block: a row of the roster. */
export interface RosterRow {
  readonly registry: string;
  readonly meta: number;
  readonly display: string;
  readonly mod: string;
  readonly ns: string;
  readonly legacyId: number;
}

/** A row of itempanel.csv before it is matched to item.csv. */
export interface PanelRow {
  readonly registry: string;
  readonly meta: number;
  readonly display: string;
}

/** A registry name's namespace and path; a bare name belongs to "minecraft". */
export function splitRef(ref: string): { ns: string; path: string } {
  const colon = ref.indexOf(":");
  return colon >= 0
    ? { ns: ref.slice(0, colon), path: ref.slice(colon + 1) }
    : { ns: "minecraft", path: ref };
}

/** Godot's `String.is_valid_int`: an optional sign and digits, nothing else. */
export function isValidInt(s: string): boolean {
  return /^[+-]?\d+$/.test(s);
}

const sameHeader = (row: readonly string[] | undefined, want: readonly string[]) =>
  row !== undefined && row.length === want.length && row.every((f, i) => f === want[i]);

/** The header is compared exactly; a byte order mark some editors add is let through. */
const records = (text: string) => parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** registry -> {mod, ns, legacyId} for every item.csv row with Has Block == "true". */
export function parseItemCsv(text: string, label = "item.csv"): Map<string, Placeable> {
  const rows = records(text);
  if (!sameHeader(rows[0], ITEM_HEADER))
    throw new NeiDumpError(`${label} doesn't look like an NEI item dump (unexpected header)`);
  const out = new Map<string, Placeable>();
  for (const row of rows.slice(1)) {
    if (row.length < 6 || !row[0]) continue;
    if (row[2] !== "true") continue;
    const registry = row[0];
    const id = row[1] ?? "";
    out.set(registry, {
      mod: row[3] ?? "",
      ns: splitRef(registry).ns,
      legacyId: isValidInt(id) ? Number.parseInt(id, 10) : -1,
    });
  }
  return out;
}

/** One entry per itempanel.csv row (rows without a numeric meta are skipped). */
export function parseItemPanelCsv(text: string, label = "itempanel.csv"): PanelRow[] {
  const rows = records(text);
  if (!sameHeader(rows[0], ITEMPANEL_HEADER))
    throw new NeiDumpError(`${label} doesn't look like an NEI Item Panel dump (unexpected header)`);
  const out: PanelRow[] = [];
  for (const row of rows.slice(1)) {
    if (row.length < 5 || !row[0]) continue;
    const meta = row[2] ?? "";
    if (!isValidInt(meta)) continue;
    out.push({ registry: row[0], meta: Number.parseInt(meta, 10), display: row[4] ?? "" });
  }
  return out;
}

/** registry -> numeric id for every registered block in block.csv. */
export function parseBlockCsv(text: string, label = "block.csv"): Map<string, number> {
  const rows = records(text);
  if (!sameHeader(rows[0], BLOCK_HEADER))
    throw new NeiDumpError(`${label} doesn't look like an NEI block dump (unexpected header)`);
  const out = new Map<string, number>();
  for (const row of rows.slice(1)) {
    const id = row[1] ?? "";
    if (row.length < 2 || !row[0] || !isValidInt(id)) continue;
    out.set(row[0], Number.parseInt(id, 10));
  }
  return out;
}

/** The three dump files' text; null for a file that is not there. */
export interface NeiDumpTexts {
  readonly item: string | null;
  readonly itempanel: string | null;
  readonly block: string | null;
}

/**
 * The parsed dumps: which registry names are placeable, the roster of their real subtypes
 * grouped by mod, and every registered block's numeric id.
 */
export class NeiRoster {
  /**
   * Every item.csv Has-Block row, not only the confirmed roster, so a registry that never had
   * an itempanel row can still be given its numeric id.
   */
  readonly placeable: ReadonlyMap<string, Placeable>;
  /** registry -> numeric id from block.csv. */
  readonly blockIds: ReadonlyMap<string, number>;
  /** Mod label -> its rows, in itempanel.csv order. */
  readonly rowsByMod: ReadonlyMap<string, readonly RosterRow[]>;
  /** The mod labels, sorted. */
  readonly mods: readonly string[];

  constructor(
    placeable: ReadonlyMap<string, Placeable>,
    panel: readonly PanelRow[],
    blockIds: ReadonlyMap<string, number> = new Map(),
  ) {
    this.placeable = placeable;
    this.blockIds = blockIds;
    const byMod = new Map<string, RosterRow[]>();
    for (const row of panel) {
      // itempanel.csv lists every item, not just placeable ones.
      const owner = placeable.get(row.registry);
      if (!owner) continue;
      let rows = byMod.get(owner.mod);
      if (!rows) {
        rows = [];
        byMod.set(owner.mod, rows);
      }
      rows.push({ ...row, mod: owner.mod, ns: owner.ns, legacyId: owner.legacyId });
    }
    this.rowsByMod = byMod;
    this.mods = [...byMod.keys()].sort();
  }

  /**
   * This install's numeric block id for `registry`, -1 when neither dump lists it. block.csv
   * first (every registered block), then item.csv's own Has-Block rows.
   */
  legacyIdFor(registry: string): number {
    const id = this.blockIds.get(registry);
    if (id !== undefined) return id;
    return this.placeable.get(registry)?.legacyId ?? -1;
  }

  entries(mod: string): readonly RosterRow[] {
    return this.rowsByMod.get(mod) ?? [];
  }

  /** Every row across every mod, mods in sorted order. */
  allEntries(): RosterRow[] {
    return this.mods.flatMap((mod) => this.entries(mod));
  }
}

/** Parses the three dumps. Throws a `NeiDumpError` for a missing file or a wrong header. */
export function parseNeiDumps(texts: NeiDumpTexts): NeiRoster {
  if (texts.item === null)
    throw new NeiDumpError("couldn't open item.csv — run NEI's Data Dumps (Items) first");
  const placeable = parseItemCsv(texts.item);
  if (texts.itempanel === null)
    throw new NeiDumpError(
      "couldn't open itempanel.csv — run NEI's Data Dumps (Item Panel, CSV mode) first",
    );
  const panel = parseItemPanelCsv(texts.itempanel);
  if (texts.block === null)
    throw new NeiDumpError(
      "couldn't find block.csv — run NEI's Data Dumps (Blocks) too, next to the others",
    );
  return new NeiRoster(placeable, panel, parseBlockCsv(texts.block));
}
