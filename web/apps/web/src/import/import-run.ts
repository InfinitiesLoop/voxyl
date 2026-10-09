// One import run, apart from the worker that hosts it so a test can drive it: read the picked
// folder, build the libraries and store them. Storing replaces a library of the same id, so
// running the same import again (same prefix, same folder) updates in place and never adds a
// second copy.

import {
  type FsDir,
  type FsFile,
  type InstanceImportResult,
  importInstance,
} from "@voxyl/mc-import";
import { type Folder, LibraryStore } from "@voxyl/session";
import type { ImportReport } from "./protocol.ts";

export interface RunOptions {
  readonly picked: FsDir;
  readonly folder: Folder;
  readonly prefix: string;
  readonly vanillaJar?: FsFile;
  readonly onProgress: (phase: string, done: number, total: number) => void;
}

/** The mod whose entries can only be matched against a Minecraft jar. */
const VANILLA_MOD = "minecraft";

export async function importAndStore(opts: RunOptions): Promise<ImportReport> {
  const result = await importInstance({
    picked: opts.picked,
    prefix: opts.prefix,
    ...(opts.vanillaJar && { vanillaJar: opts.vanillaJar }),
    onProgress: opts.onProgress,
  });

  const store = new LibraryStore(opts.folder);
  let saved = 0;
  opts.onProgress("Saving libraries", 0, result.libraries.length);
  for (const library of result.libraries) {
    await store.save(library);
    opts.onProgress("Saving libraries", ++saved, result.libraries.length);
  }
  return reportOf(result);
}

/**
 * What the dialog shows. A modpack import with no Minecraft jar can't texture the vanilla
 * blocks, and says nothing about them: that is not a problem with the pack, and the vanilla
 * library comes from its own import.
 */
export function reportOf(result: InstanceImportResult): ImportReport {
  const quiet = !result.vanilla;
  const byMod = Object.entries(result.droppedByMod).filter(
    ([mod]) => !(quiet && mod.toLowerCase() === VANILLA_MOD),
  );
  const libraries = result.libraries.map((l) => ({
    id: l.id,
    name: l.name,
    blocks: Object.keys(l.blocks).length,
  }));
  return {
    libraries,
    blocks: libraries.reduce((sum, l) => sum + l.blocks, 0),
    dropped: byMod.reduce((sum, [, count]) => sum + count, 0),
    droppedByMod: byMod.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    healed: result.healed,
    warnings: result.warnings.filter((w) => !(quiet && isVanillaWarning(w))).length,
    ms: result.ms,
  };
}

const isVanillaWarning = (warning: string) =>
  /namespace: minecraft\b/i.test(warning) || /\bin minecraft$/i.test(warning);
