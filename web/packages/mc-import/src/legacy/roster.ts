// The pre-1.8 import: every confirmed entry of the NEI roster becomes a one-cube block in the
// library of its namespace, textured by the narrow match in `attach.ts`, or is left out and
// counted. No model exists to import in a 1.7.10 mod, so the roster is the only truth about
// what the blocks are; the textures are best effort, and an entry that can't be matched to
// them confidently isn't imported at all (a block that looks like nothing, and that the user
// couldn't tell from any other undecided block, is no use as a placeholder).

import { MC_SIDES, type McSide } from "@voxyl/blocks";
import { type AssetSource, MultiSource } from "../sources/index.ts";
import {
  attach,
  type Candidate,
  NamespaceResolver,
  type Resolved,
  TextureIndex,
} from "./attach.ts";
import type { LibraryDraft } from "./draft.ts";
import type { NeiRoster, RosterRow } from "./nei.ts";
import { TextureIngest } from "./texture.ts";

/** What an `AbortSignal` is to this package, which builds without the DOM lib. */
export interface AbortLike {
  readonly aborted: boolean;
}

/** Thrown by an import that its signal cancelled. */
export class ImportAborted extends Error {
  override readonly name = "AbortError";
  constructor() {
    super("The import was cancelled");
  }
}

export interface ImportRosterOptions {
  readonly roster: NeiRoster;
  /** Every jar, folder or pack to read textures from. Sources that share a namespace are read as one. */
  readonly sources: readonly AssetSource[];
  /**
   * The library a row of this registry namespace goes into ("gregtech", "BuildCraft|Core": the
   * row's own prefix). The caller makes or reuses a draft per namespace, so it picks the library
   * ids and can seed a draft with an earlier import; asked for every row, so it should answer
   * the same draft for the same namespace.
   */
  readonly libraries: (ns: string) => LibraryDraft;
  /** Only these mods (by NEI's label); default all. */
  readonly mods?: readonly string[];
  readonly onProgress?: (done: number, total: number, mod: string) => void;
  readonly signal?: AbortLike;
  /**
   * Shared with other passes (the healers) so a texture used by both is read once, and their
   * warnings come out in one list. Default: a fresh one whose warnings are in the result.
   */
  readonly ingest?: TextureIngest;
  /** How many rows between giving the event loop a turn (default 200). */
  readonly yieldEvery?: number;
}

export interface ImportedEntry {
  readonly registry: string;
  readonly meta: number;
  readonly display: string;
  readonly mod: string;
  readonly ns: string;
  /** The block's name in its library. */
  readonly name: string;
  /** The id of the draft it is in. */
  readonly library: string;
  /**
   * False when a block with this identity was already there: a re-import reuses it, and so does
   * a row NEI lists twice (the same registry and meta with different NBT: Botany's flowers). Such
   * a row is still reported, as in the dropped list, so imported + dropped is the row count.
   */
  readonly created: boolean;
}

export interface DroppedEntry {
  readonly registry: string;
  readonly meta: number;
  readonly display: string;
  readonly mod: string;
  readonly ns: string;
}

export interface RosterResult {
  readonly imported: ImportedEntry[];
  readonly dropped: DroppedEntry[];
  /** New identities left out for lack of a confident texture match, per NEI mod label. */
  readonly droppedByMod: Record<string, number>;
  /** Problems and the per-mod drop summary ("no texture match, dropped: 3 block(s) in X"). */
  readonly warnings: string[];
  /** The namespace -> source lookup the import used, for passes that read more of the same sources. */
  readonly resolver: NamespaceResolver;
}

const SIDE_ORDER: readonly McSide[] = MC_SIDES;

/** The turn the event loop gets between batches, so a worker can see a cancel or a message. */
function nextTurn(): Promise<void> {
  const timers = globalThis as unknown as {
    setTimeout?: (run: () => void, ms: number) => unknown;
  };
  return new Promise((resolve) => (timers.setTimeout ? timers.setTimeout(resolve, 0) : resolve()));
}

/**
 * Imports the roster's entries (all mods, or `opts.mods`) into the drafts `opts.libraries`
 * names. Idempotent: an entry whose registry and meta already have a block in the draft updates
 * that block in place (a re-import never makes "Name (2)"), and an existing block that can't be
 * matched this time is left as it was.
 */
export async function importRoster(opts: ImportRosterOptions): Promise<RosterResult> {
  const { roster, libraries } = opts;
  const ingest = opts.ingest ?? new TextureIngest();
  const warnings = ingest.warnings;
  const resolver = new NamespaceResolver(opts.sources, (list) => new MultiSource(list));
  const indexes = new Map<string, TextureIndex>();
  const indexOf = (tier: Resolved) => {
    let index = indexes.get(tier.ns);
    if (!index) {
      index = TextureIndex.of(tier.source, tier.ns);
      indexes.set(tier.ns, index);
    }
    return index;
  };

  const wanted = opts.mods ? new Set(opts.mods) : null;
  const mods = roster.mods.filter((m) => !wanted || wanted.has(m));
  const total = mods.reduce((n, m) => n + roster.entries(m).length, 0);
  const every = Math.max(1, opts.yieldEvery ?? 200);

  const imported: ImportedEntry[] = [];
  const dropped: DroppedEntry[] = [];
  const droppedByMod: Record<string, number> = Object.create(null);
  const warnedNamespaces = new Set<string>();
  let done = 0;

  const importRow = async (row: RosterRow) => {
    const draft = libraries(row.ns);
    const existing = draft.findByIdentity(row.registry, row.meta);
    const match = attach(row, resolver, indexOf);
    if (match.kind === "no-source" && !warnedNamespaces.has(row.ns)) {
      warnedNamespaces.add(row.ns);
      warnings.push(
        `no assets found for mod namespace: ${row.ns} (its blocks are dropped, not imported)`,
      );
    }

    let name = existing?.name;
    let created = false;
    if (match.kind === "match") {
      const faces = await bindFaces(draft, match.tier, match.faces, ingest);
      if (faces) {
        created = !existing;
        name ??= draft.uniqueName(row.display || row.registry, (b, n) => `${b} (${n})`);
        draft.addCube(name, faces, {
          modelKey: `${match.tier.ns}:nei/${name}`,
          mc: {
            registry: row.registry,
            meta: row.meta,
            ...(row.legacyId >= 0 && { legacyId: row.legacyId }),
          },
        });
      }
    }
    if (name === undefined) {
      dropped.push({
        registry: row.registry,
        meta: row.meta,
        display: row.display,
        mod: row.mod,
        ns: row.ns,
      });
      droppedByMod[row.mod] = (droppedByMod[row.mod] ?? 0) + 1;
      return;
    }
    const current = draft.block(name);
    if (existing && current?.mc && row.legacyId >= 0 && current.mc.legacyId !== row.legacyId) {
      // A re-import that bound nothing still refreshes the identity's numeric id.
      draft.addBlock(name, { ...current, mc: { ...current.mc, legacyId: row.legacyId } });
    }
    imported.push({
      registry: row.registry,
      meta: row.meta,
      display: row.display,
      mod: row.mod,
      ns: row.ns,
      name,
      library: draft.id,
      created,
    });
  };

  for (const mod of mods) {
    opts.onProgress?.(done, total, mod);
    for (const row of roster.entries(mod)) {
      if (done % every === 0) {
        if (opts.signal?.aborted) throw new ImportAborted();
        opts.onProgress?.(done, total, mod);
        await nextTurn();
        if (opts.signal?.aborted) throw new ImportAborted();
      }
      await importRow(row);
      done++;
    }
  }
  opts.onProgress?.(done, total, "");

  // One line per mod, never one per block: a big pack drops thousands.
  for (const mod of Object.keys(droppedByMod).sort())
    warnings.push(`no texture match, dropped: ${droppedByMod[mod]} block(s) in ${mod}`);

  return { imported, dropped, droppedByMod, warnings, resolver };
}

/** The texture key for each side of a match, reading the files in; null if none could be read. */
async function bindFaces(
  draft: LibraryDraft,
  tier: Resolved,
  faces: Partial<Record<McSide, Candidate>>,
  ingest: TextureIngest,
): Promise<Partial<Record<McSide, string>> | null> {
  const out: Partial<Record<McSide, string>> = {};
  let any = false;
  for (const side of SIDE_ORDER) {
    const c = faces[side];
    if (!c) continue;
    const key = await ingest.ensure(draft, tier.source, `${tier.ns}:${c.subdir}/${c.name}`);
    if (key) {
      out[side] = key;
      any = true;
    }
  }
  return any ? out : null;
}
