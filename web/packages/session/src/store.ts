// Saved projects in a folder of files: the browser's OPFS in the app, memory in tests, and
// later the server's object storage. Chunk blobs are content-addressed and shared by every
// project in the folder, so saving again writes only chunks that changed, and identical
// chunks (empty floors, a copied project) are stored once.
//
//   projects/<id>/entry.json      what the project list shows (ProjectEntry)
//   projects/<id>/manifest.json   the project format's manifest
//   blobs/<hash>                  compressed storage chunks

import {
  loadProject,
  type Manifest,
  type Project,
  type ProjectOptions,
  packBundle,
  type SavedProject,
  saveProject,
  unpackBundle,
} from "@voxyl/core";

/** The few file operations the store needs. Paths use "/" and name nested folders. */
export interface Folder {
  /** The file's bytes, or null if there is none. */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** Removes a file or a folder with everything in it; nothing happens if it isn't there. */
  remove(path: string): Promise<void>;
  /** The names of the files and folders directly inside a folder (none if it isn't there). */
  list(path: string): Promise<string[]>;
}

/** What a project list shows, kept apart from the manifest so listing reads little. */
export interface ProjectEntry {
  readonly id: string;
  readonly name: string;
  readonly cells: number;
  /** When it was last saved, in milliseconds since 1970. */
  readonly savedAt: number;
  /** Bytes of its manifest and the chunk blobs it uses (shared blobs count fully). */
  readonly bytes: number;
}

// TextEncoder, TextDecoder and crypto exist in every runtime this runs in; typed locally (no DOM lib).
const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
  crypto: { getRandomValues(bytes: Uint8Array): void };
};
const utf8 = {
  encode: (text: string) => new runtime.TextEncoder().encode(text),
  decode: (bytes: Uint8Array) => new runtime.TextDecoder().decode(bytes),
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Not a project id: ${id}`);
  return id;
}

export class ProjectStore {
  readonly #folder: Folder;
  /** Blob hashes known to be stored, filled on first use. */
  #blobs: Set<string> | null = null;

  constructor(folder: Folder) {
    this.#folder = folder;
  }

  /** Every saved project, most recently saved first. */
  async list(): Promise<ProjectEntry[]> {
    const entries: ProjectEntry[] = [];
    for (const id of await this.#folder.list("projects")) {
      const bytes = await this.#folder.read(`projects/${id}/entry.json`);
      if (bytes) entries.push(JSON.parse(utf8.decode(bytes)) as ProjectEntry);
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Saves a project, writing only blobs the folder doesn't have yet. */
  async save(
    project: Project,
    savedAt = Date.now(),
    pace?: () => Promise<void>,
  ): Promise<ProjectEntry> {
    return this.#write(await saveProject(project, undefined, pace), savedAt);
  }

  /** Opens a saved project. */
  async open(id: string, options: ProjectOptions = {}): Promise<Project> {
    return loadProject(await this.#saved(id), options);
  }

  /** The project as one file, for export. */
  async exportBundle(id: string): Promise<Uint8Array> {
    return packBundle(await this.#saved(id));
  }

  /**
   * Stores a bundle file. A project already in the folder under the same id is kept: the
   * import becomes a copy with a new id.
   */
  async importBundle(bytes: Uint8Array, savedAt = Date.now()): Promise<ProjectEntry> {
    const saved = await unpackBundle(bytes);
    const taken = new Set(await this.#folder.list("projects"));
    const id = taken.has(saved.manifest.id) ? newId() : saved.manifest.id;
    return this.#write({ ...saved, manifest: { ...saved.manifest, id } }, savedAt);
  }

  /** Deletes a project, and every blob no other project uses. */
  async delete(id: string): Promise<void> {
    await this.#folder.remove(`projects/${checkId(id)}`);
    const used = new Set<string>();
    for (const other of await this.#folder.list("projects")) {
      const manifest = await this.#manifest(other).catch(() => null);
      for (const hash of Object.values(manifest?.chunks ?? {})) used.add(hash);
    }
    const blobs = await this.#knownBlobs();
    for (const hash of [...blobs]) {
      if (used.has(hash)) continue;
      await this.#folder.remove(`blobs/${hash}`);
      blobs.delete(hash);
    }
  }

  async #write(saved: SavedProject, savedAt: number): Promise<ProjectEntry> {
    const { manifest } = saved;
    const id = checkId(manifest.id);
    const blobs = await this.#knownBlobs();
    let bytes = 0;
    for (const [hash, data] of saved.blobs) {
      bytes += data.byteLength;
      if (blobs.has(hash)) continue;
      await this.#folder.write(`blobs/${hash}`, data);
      blobs.add(hash);
    }
    const manifestBytes = utf8.encode(JSON.stringify(manifest));
    bytes += manifestBytes.byteLength;
    // The manifest goes last: a project is only listed once everything it needs is stored.
    await this.#folder.write(`projects/${id}/manifest.json`, manifestBytes);
    const entry: ProjectEntry = {
      id,
      name: manifest.settings.name,
      cells: manifest.cells,
      savedAt,
      bytes,
    };
    await this.#folder.write(`projects/${id}/entry.json`, utf8.encode(JSON.stringify(entry)));
    return entry;
  }

  async #manifest(id: string): Promise<Manifest> {
    const bytes = await this.#folder.read(`projects/${checkId(id)}/manifest.json`);
    if (!bytes) throw new Error(`No saved project ${id}`);
    return JSON.parse(utf8.decode(bytes)) as Manifest;
  }

  async #saved(id: string): Promise<SavedProject> {
    const manifest = await this.#manifest(id);
    const blobs = new Map<string, Uint8Array>();
    for (const hash of new Set(Object.values(manifest.chunks))) {
      const data = await this.#folder.read(`blobs/${hash}`);
      if (!data) throw new Error(`Saved project ${id} is missing chunk ${hash}`);
      blobs.set(hash, data);
    }
    return { manifest, blobs };
  }

  async #knownBlobs(): Promise<Set<string>> {
    this.#blobs ??= new Set(await this.#folder.list("blobs"));
    return this.#blobs;
  }
}

function newId(): string {
  const bytes = new Uint8Array(16);
  runtime.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A folder in memory, for tests. */
export class MemoryFolder implements Folder {
  readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data.slice());
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    for (const key of [...this.files.keys()])
      if (key.startsWith(`${path}/`)) this.files.delete(key);
  }

  async list(path: string): Promise<string[]> {
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      names.add(key.slice(path.length + 1).split("/")[0] as string);
    }
    return [...names];
  }
}
