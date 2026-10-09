// How the importer gets the folder the user chose: the flat file list an `<input webkitdirectory>`
// gives, which becomes the importer's small `FsDir` interface. A file is read lazily by
// slicing, so a pack's 250 mod jars (gigabytes) are never loaded whole. The user's files are
// only read, and stay in the browser: nothing here sends them anywhere. (The browser's own
// directory picker is not used: it refuses folders such as AppData, where launchers keep
// their instances.)

import type { ByteSource, FsDir, FsFile } from "@voxyl/mc-import";

/** A file read by ranged slices: only the bytes asked for are read from disk. */
export function fileSource(file: Blob): ByteSource {
  return {
    size: file.size,
    async read(start, end) {
      const stop = Math.min(end, file.size);
      if (stop <= start) return new Uint8Array(0);
      return new Uint8Array(await file.slice(start, stop).arrayBuffer());
    },
  };
}

/** A file as the importer sees it, under `name`. */
export function fileEntry(file: Blob, name: string): FsFile {
  return { name, open: async () => fileSource(file) };
}

// --- A folder from `<input webkitdirectory>` -----------------------------------------------

/** A file and its path from the picked folder's parent (`root/mods/x.jar`). */
export interface PickedFile {
  readonly path: string;
  readonly file: File;
}

/** The files an `<input webkitdirectory>` gave, with their relative paths. */
export function pickedFiles(files: Iterable<File>): PickedFile[] {
  return Array.from(files, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

interface Node {
  readonly name: string;
  readonly dirs: Map<string, Node>;
  readonly files: FsFile[];
}

const newNode = (name: string): Node => ({ name, dirs: new Map(), files: [] });

function toDir(node: Node): FsDir {
  return {
    name: node.name,
    async list() {
      return { dirs: [...node.dirs.values()].map(toDir), files: node.files };
    },
  };
}

/**
 * The picked folder as an `FsDir`. Paths start with the picked folder's own name; when every
 * path does, that is the root and its name. Names keep their case (lookups are
 * case-insensitive); either slash is a separator.
 */
export function filesDir(entries: readonly PickedFile[]): FsDir {
  const split = entries.map((e) => ({
    parts: e.path.split(/[\\/]+/).filter((p) => p !== ""),
    file: e.file,
  }));
  const first = split[0]?.parts[0];
  const shared =
    first !== undefined && split.every((e) => e.parts.length >= 2 && e.parts[0] === first);
  const root = newNode(shared ? first : "");
  for (const { parts, file } of split) {
    const names = shared ? parts.slice(1) : parts;
    const leaf = names.pop();
    if (leaf === undefined) continue;
    let at = root;
    for (const name of names) {
      let next = at.dirs.get(name);
      if (!next) {
        next = newNode(name);
        at.dirs.set(name, next);
      }
      at = next;
    }
    at.files.push(fileEntry(file, leaf));
  }
  return toDir(root);
}
