// The folder tree an import reads, as a small interface the app backs with the File System
// Access API (or a `webkitdirectory` file list) and tests back with Node's `fs`. This package
// stays free of DOM and Node APIs, so everything it knows about files is this.

import { type ByteSource, ZipReader } from "../zip.ts";
import { type AssetSource, PathIndex } from "./asset-source.ts";
import { ZipAssetSource } from "./zip-source.ts";

export interface FsFile {
  readonly name: string;
  /** Opens the file for ranged reads. */
  open(): Promise<ByteSource>;
}

export interface FsDir {
  readonly name: string;
  list(): Promise<{ readonly dirs: readonly FsDir[]; readonly files: readonly FsFile[] }>;
}

/** The immediate subfolder called `name` (case-insensitive), or null. */
export async function subdir(dir: FsDir, name: string): Promise<FsDir | null> {
  const lower = name.toLowerCase();
  return (await dir.list()).dirs.find((d) => d.name.toLowerCase() === lower) ?? null;
}

/** The file called `name` (case-insensitive) directly in `dir`, or null. */
export async function fileIn(dir: FsDir, name: string): Promise<FsFile | null> {
  const lower = name.toLowerCase();
  return (await dir.list()).files.find((f) => f.name.toLowerCase() === lower) ?? null;
}

/** Opens a jar or zip as an assets root. */
export async function openArchive(file: FsFile): Promise<ZipAssetSource> {
  return ZipAssetSource.open(file.name, await file.open());
}

/** An unpacked assets folder (a resource pack on disk): its children are the namespaces. */
export class DirAssetSource implements AssetSource {
  readonly label: string;
  readonly #files: Map<string, FsFile>;
  readonly #index: PathIndex;

  private constructor(label: string, files: Map<string, FsFile>) {
    this.label = label;
    this.#files = files;
    this.#index = new PathIndex(files.keys());
  }

  static async open(root: FsDir): Promise<DirAssetSource> {
    const files = new Map<string, FsFile>();
    const walk = async (dir: FsDir, prefix: string) => {
      const { dirs, files: here } = await dir.list();
      for (const f of here) files.set(prefix + f.name, f);
      for (const d of dirs) await walk(d, `${prefix}${d.name}/`);
    };
    await walk(root, "");
    return new DirAssetSource(root.name, files);
  }

  namespaces = () => this.#index.namespaces();
  listFiles = (dir: string) => this.#index.listFiles(dir);
  listFilesRecursive = (dir: string) => this.#index.listFilesRecursive(dir);
  has = (rel: string) => this.#index.has(rel);

  async bytes(rel: string): Promise<Uint8Array | null> {
    const file = this.#files.get(rel);
    if (!file) return null;
    const source = await file.open();
    return source.read(0, source.size);
  }
}

// Re-exported so callers that only deal in folders need not know about the zip layer.
export { ZipReader };
