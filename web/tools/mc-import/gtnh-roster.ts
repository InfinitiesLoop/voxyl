// Runs the pre-1.8 roster import over a real launcher instance on disk (a GTNH install), for
// the gated real-data test and the Godot parity script. Node only; the importer itself is not.

import {
  type AssetSource,
  fileIn,
  findSiblingText,
  gtnhExtension,
  importRoster,
  LibraryDraft,
  type NeiRoster,
  openArchive,
  parseNeiDumps,
  type RosterResult,
  runHealers,
  scanInstance,
  TextureIngest,
  ZipAssetSource,
} from "../../packages/mc-import/src/index.ts";
import { nodeDir, nodeFileAt } from "./node-fs.ts";

export interface GtnhRun {
  readonly roster: NeiRoster;
  readonly result: RosterResult;
  readonly drafts: Map<string, LibraryDraft>;
  readonly jars: number;
  /** Jars that could not be opened as zips. */
  readonly skipped: string[];
  readonly openMs: number;
  readonly importMs: number;
  /** Set when `heal` was asked for. */
  readonly healMs?: number;
  readonly healed?: string[] | undefined;
  readonly rssMb: number;
}

const text = async (dir: Awaited<ReturnType<typeof scanInstance>>, name: string) => {
  const folder = dir?.dumps;
  const file = folder ? await fileIn(folder, name) : null;
  if (!file) return null;
  const source = await file.open();
  return new TextDecoder().decode(await source.read(0, source.size));
};

/** Opens every mod jar (directories only, never whole) plus the vanilla jar, and imports. */
export async function importGtnh(
  gameDir: string,
  vanillaJar: string,
  opts: { mods?: string[]; heal?: boolean } = {},
): Promise<GtnhRun> {
  const scan = await scanInstance(nodeDir(gameDir));
  if (!scan) throw new Error(`${gameDir} is not a game folder`);
  const roster = parseNeiDumps({
    item: await text(scan, "item.csv"),
    itempanel: await text(scan, "itempanel.csv"),
    block: await text(scan, "block.csv"),
  });

  const t0 = performance.now();
  const sources: AssetSource[] = [];
  const skipped: string[] = [];
  // Vanilla first: a mod that patches the minecraft domain is read after it, as a pack lists them.
  sources.push(await ZipAssetSource.open("minecraft.jar", await nodeFileAt(vanillaJar).open()));
  for (const mod of scan.mods) {
    try {
      sources.push(await openArchive(mod));
    } catch {
      skipped.push(mod.name);
    }
  }
  const openMs = performance.now() - t0;

  const drafts = new Map<string, LibraryDraft>();
  const t1 = performance.now();
  const ingest = new TextureIngest();
  const result = await importRoster({
    roster,
    ingest,
    sources,
    ...(opts.mods && { mods: opts.mods }),
    libraries: (ns) => {
      let draft = drafts.get(ns);
      if (!draft) {
        draft = new LibraryDraft(ns);
        drafts.set(ns, draft);
      }
      return draft;
    },
  });
  const importMs = performance.now() - t1;
  let healMs: number | undefined;
  let healed: string[] | undefined;
  if (opts.heal) {
    const t2 = performance.now();
    const ran = await runHealers({
      extensions: [gtnhExtension],
      drafts,
      resolver: result.resolver,
      ingest,
      legacyIdFor: (registry) => roster.legacyIdFor(registry),
      siblingText: (name) => findSiblingText(scan, name),
    });
    healMs = performance.now() - t2;
    healed = ran.healed;
  }
  return {
    roster,
    result,
    drafts,
    jars: sources.length,
    skipped,
    openMs,
    importMs,
    ...(healMs !== undefined && { healMs, healed }),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  };
}
