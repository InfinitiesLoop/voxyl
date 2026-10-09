// Imports a launcher instance (a modpack such as GTNH) as block libraries, one per mod: the
// whole pre-1.8 route in one call. Plan first (what the picked folder offers, so the UI can say
// what is missing), then import: open every mod jar by its directory only, read NEI's Data
// Dumps for the confirmed roster, match textures, run the pack healers, apply the saw whitelist,
// and hand back plain `Library` values for the caller to store.
//
// Pre-1.8 mods have no models, so the NEI dumps are the only truth about what the blocks are;
// a folder without them cannot be imported, and the plan says how to make them. The folder is
// the user's own and is only read.

import type { Library } from "@voxyl/blocks";
import { gtnhExtension } from "./extensions/gtnh.ts";
import { LibraryDraft } from "./legacy/draft.ts";
import type { Extension } from "./legacy/extension.ts";
import { isSawable, parseMicroblocksCfg } from "./legacy/microblocks-cfg.ts";
import { NeiDumpError, type NeiRoster, parseNeiDumps } from "./legacy/nei.ts";
import { type AbortLike, ImportAborted, importRoster } from "./legacy/roster.ts";
import { runHealers } from "./legacy/run-heal.ts";
import { TextureIngest } from "./legacy/texture.ts";
import type { AssetSource } from "./sources/asset-source.ts";
import { type FsDir, type FsFile, fileIn, openArchive } from "./sources/fs.ts";
import { findSiblingText, type InstanceScan, scanInstance } from "./sources/instance.ts";
import { ZipAssetSource } from "./sources/zip-source.ts";
import { utf8 } from "./streams.ts";

/** What the picked folder offers an import. */
export interface InstancePlan {
  /** The game folder's name (".minecraft", or the instance folder). */
  readonly gameFolder: string;
  readonly mods: number;
  /** Vanilla version jars found in `versions/`. */
  readonly versionJars: number;
  readonly dumps: { readonly item: boolean; readonly itempanel: boolean; readonly block: boolean };
  readonly hasMicroblocksCfg: boolean;
  /** Whether the vanilla `minecraft` textures are reachable (a version jar was found). */
  readonly hasVanilla: boolean;
  /** What stops the import, in words the UI can show; empty when it can go ahead. */
  readonly problems: readonly string[];
}

export const NEI_HOWTO =
  "In the game, open NEI, then Options → Tools → Data Dumps: click Items, switch Item Panel to " +
  "CSV mode and click it, then click Blocks. The dumps are written to the game folder's " +
  "dumps folder.";

export async function planInstance(picked: FsDir): Promise<InstancePlan | null> {
  const scan = await scanInstance(picked);
  if (!scan) return null;
  const has = async (dir: FsDir | null, name: string) => !!dir && !!(await fileIn(dir, name));
  const dumps = {
    item: await has(scan.dumps, "item.csv"),
    itempanel: await has(scan.dumps, "itempanel.csv"),
    block: await has(scan.dumps, "block.csv"),
  };
  const problems: string[] = [];
  if (scan.mods.length === 0) problems.push("No mods were found in this folder.");
  if (!(dumps.item && dumps.itempanel && dumps.block)) {
    problems.push(
      `NEI's Data Dumps are missing (${["item", "itempanel", "block"]
        .filter((k) => !dumps[k as keyof typeof dumps])
        .map((k) => `${k}.csv`)
        .join(", ")}). ${NEI_HOWTO}`,
    );
  }
  return {
    gameFolder: scan.root.name,
    mods: scan.mods.length,
    versionJars: scan.versionJars.length,
    dumps,
    hasMicroblocksCfg: !!scan.config && !!(await fileIn(scan.config, "microblocks.cfg")),
    hasVanilla: scan.versionJars.length > 0,
    problems,
  };
}

export interface InstanceImportOptions {
  readonly picked: FsDir;
  /** The vanilla client jar when the instance has none of its own (Prism keeps it elsewhere). */
  readonly vanillaJar?: FsFile;
  /** Library id for a namespace; default `prefix + namespace` with unsafe characters replaced. */
  readonly prefix?: string;
  readonly extensions?: readonly Extension[];
  readonly onProgress?: (phase: string, done: number, total: number) => void;
  readonly signal?: AbortLike;
}

export interface InstanceImportResult {
  readonly libraries: Library[];
  readonly imported: number;
  readonly dropped: number;
  /** Roster entries left out for lack of a confident texture match, by mod. */
  readonly droppedByMod: Readonly<Record<string, number>>;
  readonly healed: readonly string[];
  readonly warnings: readonly string[];
  readonly ms: number;
}

/** A library id from a namespace: letters, digits, `.`, `_` and `-` only. */
export function libraryIdFor(prefix: string, ns: string): string {
  return `${prefix}${ns}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function importInstance(opts: InstanceImportOptions): Promise<InstanceImportResult> {
  const start = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const scan = await scanInstance(opts.picked);
  if (!scan)
    throw new Error(
      "This folder isn't a Minecraft game folder (no mods, versions or resourcepacks).",
    );
  const roster = await readRoster(scan);

  // Vanilla first: a mod that patches the minecraft domain is read after it.
  const sources: AssetSource[] = [];
  const vanilla = opts.vanillaJar ? [opts.vanillaJar] : scan.versionJars;
  for (const jar of vanilla) sources.push(await ZipAssetSource.open(jar.name, await jar.open()));
  const mods = scan.mods;
  let opened = 0;
  progress("Opening mods", 0, mods.length);
  // Opened a few at a time but kept in the pack's order: the first source to hold a file wins.
  const modSources: (AssetSource | null)[] = new Array(mods.length).fill(null);
  await inBatches(mods, 8, async (mod, i) => {
    try {
      modSources[i] = await openArchive(mod);
    } catch {
      // A jar that isn't a readable zip has no assets to offer.
    }
    progress("Opening mods", ++opened, mods.length);
  });
  for (const source of modSources) if (source) sources.push(source);
  if (opts.signal?.aborted) throw new ImportAborted();

  const prefix = opts.prefix ?? "pack-";
  const drafts = new Map<string, LibraryDraft>();
  const labelByNs = new Map<string, string>();
  for (const [mod, rows] of roster.rowsByMod) {
    for (const row of rows) if (!labelByNs.has(row.ns)) labelByNs.set(row.ns, mod);
  }
  const ingest = new TextureIngest();
  const result = await importRoster({
    roster,
    sources,
    ingest,
    libraries: (ns) => {
      let draft = drafts.get(ns);
      if (!draft) {
        draft = new LibraryDraft(libraryIdFor(prefix, ns), labelByNs.get(ns) ?? ns);
        drafts.set(ns, draft);
      }
      return draft;
    },
    ...(opts.signal && { signal: opts.signal }),
    onProgress: (done, total) => progress("Matching textures", done, total),
  });

  const healed = await runHealers({
    extensions: opts.extensions ?? [gtnhExtension],
    drafts,
    resolver: result.resolver,
    ingest,
    legacyIdFor: (registry) => roster.legacyIdFor(registry),
    siblingText: (name) => findSiblingText(scan, name),
    ...(opts.signal && { signal: opts.signal }),
    onProgress: (done, total) => progress("Healing mods", done, total),
  });
  if (opts.signal?.aborted) throw new ImportAborted();

  await applySawWhitelist(scan, drafts);

  const libraries = [...drafts.values()]
    .filter((d) => Object.keys(d.blocks).length > 0)
    .map((d) => d.toLibrary());
  return {
    libraries,
    imported: result.imported.length,
    dropped: result.dropped.length,
    droppedByMod: result.droppedByMod,
    healed: healed.healed,
    warnings: ingest.warnings,
    ms: Date.now() - start,
  };
}

async function readRoster(scan: InstanceScan): Promise<NeiRoster> {
  const text = async (name: string) => {
    const file = scan.dumps ? await fileIn(scan.dumps, name) : null;
    if (!file) return null;
    const source = await file.open();
    return utf8.decode(await source.read(0, source.size));
  };
  const [item, itempanel, block] = [
    await text("item.csv"),
    await text("itempanel.csv"),
    await text("block.csv"),
  ];
  if (item === null || itempanel === null || block === null) {
    throw new NeiDumpError(`NEI's Data Dumps are missing from this folder. ${NEI_HOWTO}`);
  }
  return parseNeiDumps({ item, itempanel, block });
}

/** Marks which blocks ForgeMultipart's saw can cut, from the pack's `microblocks.cfg`. */
async function applySawWhitelist(
  scan: InstanceScan,
  drafts: ReadonlyMap<string, LibraryDraft>,
): Promise<void> {
  const file = scan.config ? await fileIn(scan.config, "microblocks.cfg") : null;
  if (!file) return;
  const source = await file.open();
  const whitelist = parseMicroblocksCfg(utf8.decode(await source.read(0, source.size)));
  if (whitelist.size === 0) return;
  for (const draft of drafts.values()) {
    for (const [name, block] of Object.entries(draft.blocks)) {
      if (!block.mc) continue;
      const sawable = isSawable(whitelist, block.mc.registry, block.mc.meta ?? 0);
      draft.addBlock(name, { ...block, mc: { ...block.mc, sawable } });
    }
  }
}

/** Runs `work` over `items`, `size` at a time. */
async function inBatches<T>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<void>,
) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map((item, j) => work(item, i + j)));
  }
}
