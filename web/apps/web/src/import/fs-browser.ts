// The browser's ways of handing a folder to the importer: a File System Access directory
// handle, or the flat file list a `<input webkitdirectory>` gives. Both become the importer's
// small `FsDir` interface, and a file is read lazily by slicing, so a pack's 250 mod jars
// (gigabytes) are never loaded whole. The user's files are only read.
//
// Also remembered folders: the picker reopens where the user was, and a stored handle asks
// for permission again rather than for the folder again.

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

// --- A folder from the File System Access API ---------------------------------------------

interface IterableDirectory {
  values(): AsyncIterable<FileSystemHandle>;
}

/** A directory handle as an `FsDir`. A folder is listed once and the listing kept. */
export function handleDir(handle: FileSystemDirectoryHandle): FsDir {
  let listing: Promise<{ dirs: FsDir[]; files: FsFile[] }> | null = null;
  const list = async () => {
    const dirs: FsDir[] = [];
    const files: FsFile[] = [];
    for await (const entry of (handle as unknown as IterableDirectory).values()) {
      if (entry.kind === "directory") dirs.push(handleDir(entry as FileSystemDirectoryHandle));
      else {
        const file = entry as FileSystemFileHandle;
        files.push({
          name: file.name,
          open: async () => fileSource(await file.getFile()),
        });
      }
    }
    return { dirs, files };
  };
  return {
    name: handle.name,
    list: () => {
      listing ??= list();
      return listing;
    },
  };
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

// --- Picking, and remembering the folder ----------------------------------------------------

interface PermissionOptions {
  mode: "read";
}
interface PermissionedHandle {
  queryPermission?(options: PermissionOptions): Promise<PermissionState>;
  requestPermission?(options: PermissionOptions): Promise<PermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?(options: {
    id?: string;
    mode?: "read";
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
}

/** Whether this browser can show the directory picker (otherwise `webkitdirectory` is used). */
export function canPickDirectory(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/**
 * Asks for a folder, opening where the last pick for this `purpose` was; null if the user
 * backed out. Must be called from a click.
 */
export async function pickDirectory(
  purpose: string,
  startIn?: FileSystemHandle | null,
): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    const handle = await picker.call(window, {
      id: purpose.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "_"),
      mode: "read",
      startIn: startIn ?? "documents",
    });
    await rememberHandle(purpose, handle);
    return handle;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/** Whether a stored handle can be read, asking the user once if it needs to (from a click). */
export async function ensureReadable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionedHandle;
  const options: PermissionOptions = { mode: "read" };
  if (!h.queryPermission || !h.requestPermission) return true;
  if ((await h.queryPermission(options)) === "granted") return true;
  return (await h.requestPermission(options)) === "granted";
}

const DB_NAME = "voxyl-folders";
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps a folder handle for a purpose (e.g. "mc-instance"). Failure to store is not an error. */
export async function rememberHandle(
  purpose: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put(handle, purpose));
  } catch {
    // Private windows and blocked storage just forget the folder.
  }
}

/** The folder last picked for a purpose, or null. */
export async function recallHandle(purpose: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const found = await withStore<unknown>("readonly", (store) => store.get(purpose));
    return found && (found as FileSystemHandle).kind === "directory"
      ? (found as FileSystemDirectoryHandle)
      : null;
  } catch {
    return null;
  }
}
