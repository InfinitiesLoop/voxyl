// Finds what a launcher instance (or a plain `.minecraft`) offers an import, from the one
// folder the user picks: the mods, the vanilla version jars, resource packs, the config
// folder (microblocks.cfg, GregTech.lang beside it) and NEI's Data Dumps. Launchers differ in
// where the game folder sits (Prism and MultiMC put it in `.minecraft`/`minecraft` under the
// instance, CurseForge uses the instance folder itself), so a few likely roots are tried.

import { utf8 } from "../streams.ts";
import { type FsDir, type FsFile, fileIn, subdir } from "./fs.ts";

export interface InstanceScan {
  /** The game folder: the one holding `mods`, `config` and so on. */
  readonly root: FsDir;
  readonly mods: readonly FsFile[];
  /** `versions/<v>/<v>.jar` of a vanilla install. */
  readonly versionJars: readonly FsFile[];
  readonly resourcePacks: readonly FsFile[];
  /** Unpacked resource packs. */
  readonly resourcePackDirs: readonly FsDir[];
  readonly config: FsDir | null;
  /** NEI's Data Dumps folder. */
  readonly dumps: FsDir | null;
}

const isArchive = (f: FsFile) => /\.(jar|zip)$/i.test(f.name);

/** Looks for a game folder at the picked folder or just below it; null when none fits. */
export async function findGameRoot(picked: FsDir): Promise<FsDir | null> {
  const looksLikeGame = async (dir: FsDir) =>
    (await subdir(dir, "mods")) !== null ||
    (await subdir(dir, "versions")) !== null ||
    (await subdir(dir, "resourcepacks")) !== null;
  if (await looksLikeGame(picked)) return picked;
  const { dirs } = await picked.list();
  // `.minecraft` and `minecraft` first (Prism, MultiMC), then any other child (an instance
  // list folder is one level up and is not itself a game folder).
  const ordered = [
    ...dirs.filter((d) => /^\.?minecraft$/i.test(d.name)),
    ...dirs.filter((d) => !/^\.?minecraft$/i.test(d.name)),
  ];
  for (const d of ordered) if (await looksLikeGame(d)) return d;
  return null;
}

/** Everything an import can read from the game folder. Reads directories, never jar contents. */
export async function scanInstance(picked: FsDir): Promise<InstanceScan | null> {
  const root = await findGameRoot(picked);
  if (!root) return null;

  const mods: FsFile[] = [];
  const modsDir = await subdir(root, "mods");
  if (modsDir) {
    // Packs keep jars in `mods/` and in a version subfolder (`mods/1.7.10`).
    const walk = async (dir: FsDir, depth: number) => {
      const { dirs, files } = await dir.list();
      mods.push(...files.filter(isArchive));
      if (depth < 2) for (const d of dirs) await walk(d, depth + 1);
    };
    await walk(modsDir, 0);
  }

  const versionJars: FsFile[] = [];
  const versions = await subdir(root, "versions");
  if (versions) {
    for (const v of (await versions.list()).dirs) {
      const jar = await fileIn(v, `${v.name}.jar`);
      if (jar) versionJars.push(jar);
    }
  }

  const resourcePacks: FsFile[] = [];
  const resourcePackDirs: FsDir[] = [];
  const packs = await subdir(root, "resourcepacks");
  if (packs) {
    const { dirs, files } = await packs.list();
    resourcePacks.push(...files.filter((f) => /\.zip$/i.test(f.name)));
    resourcePackDirs.push(...dirs);
  }

  return {
    root,
    mods,
    versionJars,
    resourcePacks,
    resourcePackDirs,
    config: await subdir(root, "config"),
    dumps: await subdir(root, "dumps"),
  };
}

/**
 * Text of a file that sits beside the mods rather than in them, e.g. GregTech's `GregTech.lang`
 * (in the game folder, or under `config`): the game folder first, then `config` and the
 * folders in it. "" when absent.
 */
export async function findSiblingText(scan: InstanceScan, name: string): Promise<string> {
  const places: FsDir[] = [scan.root];
  if (scan.config) {
    places.push(scan.config);
    for (const d of (await scan.config.list()).dirs) places.push(d);
  }
  for (const dir of places) {
    const file = await fileIn(dir, name);
    if (file) {
      const source = await file.open();
      return utf8.decode(await source.read(0, source.size));
    }
  }
  return "";
}
