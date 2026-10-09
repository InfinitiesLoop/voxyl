// A Node `fs` backing for the importer's folder interface, for tests and probes that read a
// real launcher instance from disk. Reads are ranged, like the browser's `File.slice`.

import { type FileHandle, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ByteSource, FsDir, FsFile } from "../../packages/mc-import/src/index.ts";

export function nodeDir(path: string, name = path.split(/[/]/).pop() ?? path): FsDir {
  return {
    name,
    async list() {
      const dirs: FsDir[] = [];
      const files: FsFile[] = [];
      for (const e of await readdir(path, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(nodeDir(join(path, e.name), e.name));
        else if (e.isFile()) files.push(nodeFile(join(path, e.name), e.name));
      }
      return { dirs, files };
    },
  };
}

/** A file on disk, opened lazily for ranged reads. */
export function nodeFileAt(path: string, name = path.split(/[/]/).pop() ?? path): FsFile {
  return nodeFile(path, name);
}

function nodeFile(path: string, name: string): FsFile {
  return {
    name,
    async open(): Promise<ByteSource> {
      const handle: FileHandle = await open(path, "r");
      const { size } = await handle.stat();
      // Handles are left to the garbage collector, as a browser File has no close.
      return {
        size,
        async read(start, end) {
          const stop = Math.min(end, size);
          const buf = new Uint8Array(Math.max(0, stop - start));
          if (buf.length) await handle.read(buf, 0, buf.length, start);
          return buf;
        },
      };
    },
  };
}
