// Read-only access to a Minecraft assets tree, whatever holds it: a mod jar or resource-pack
// zip, an unpacked folder, or several of these read as one. Every path is relative to the
// assets root, the directory that directly holds the namespace folders
// (`<ns>/blockstates`, `<ns>/models`, `<ns>/textures`), so a jar's `assets/` prefix never
// leaks out. Pure byte and listing I/O: the importers own all the Minecraft layout knowledge.

import { decodePng, type Image } from "../png.ts";
import { utf8 } from "../streams.ts";

export interface AssetSource {
  /** For diagnostics and the import report. */
  readonly label: string;
  /** Immediate subdirectory names of the assets root. */
  namespaces(): string[];
  /** File names directly inside `dir` (no recursion). */
  listFiles(dir: string): string[];
  /** Files under `dir`, each relative to it ("agon/0.png"). */
  listFilesRecursive(dir: string): string[];
  has(rel: string): boolean;
  /** A file's bytes, or null when it is missing. */
  bytes(rel: string): Promise<Uint8Array | null>;
}

/** UTF-8 text of a file, "" when missing. */
export async function readText(source: AssetSource, rel: string): Promise<string> {
  const bytes = await source.bytes(rel);
  return bytes ? utf8.decode(bytes) : "";
}

/** A decoded PNG, or null when missing or not decodable. */
export async function readImage(source: AssetSource, rel: string): Promise<Image | null> {
  const bytes = await source.bytes(rel);
  if (!bytes) return null;
  try {
    return await decodePng(bytes);
  } catch {
    return null;
  }
}

/**
 * An index of file paths with the listings the interface needs, built once from a flat list
 * of paths relative to the assets root.
 */
export class PathIndex {
  readonly #files = new Set<string>();
  /** Each directory ("" is the root) to its subdirectory names and its own file names. */
  readonly #dirs = new Map<string, { dirs: Set<string>; files: string[] }>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      if (!path || path.endsWith("/")) continue;
      this.#files.add(path);
      const parts = path.split("/");
      let dir = "";
      for (const name of parts.slice(0, -1)) {
        this.#entry(dir).dirs.add(name);
        dir = dir ? `${dir}/${name}` : name;
      }
      this.#entry(dir).files.push(parts[parts.length - 1] ?? "");
    }
  }

  #entry(dir: string) {
    let entry = this.#dirs.get(dir);
    if (!entry) {
      entry = { dirs: new Set(), files: [] };
      this.#dirs.set(dir, entry);
    }
    return entry;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  namespaces(): string[] {
    return [...(this.#dirs.get("")?.dirs ?? [])];
  }

  listFiles(dir: string): string[] {
    return [...(this.#dirs.get(trimSlashes(dir))?.files ?? [])];
  }

  listFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    const walk = (here: string, relative: string) => {
      const entry = this.#dirs.get(here);
      if (!entry) return;
      for (const f of entry.files) out.push(relative + f);
      for (const d of entry.dirs) walk(here ? `${here}/${d}` : d, `${relative}${d}/`);
    };
    walk(trimSlashes(dir), "");
    return out;
  }
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
