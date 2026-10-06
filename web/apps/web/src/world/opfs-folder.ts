import type { Folder } from "@voxyl/session";

/**
 * A ProjectStore folder in the browser's origin private file system (OPFS), rooted at a
 * subfolder. Works in workers, where the world worker uses it.
 */
export class OpfsFolder implements Folder {
  readonly #root: Promise<FileSystemDirectoryHandle>;

  constructor(name: string) {
    this.#root = navigator.storage
      .getDirectory()
      .then((top) => top.getDirectoryHandle(name, { create: true }));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const { dir, name } = await this.#parent(path, false);
    const handle = await dir?.getFileHandle(name).catch(notFound);
    if (!handle) return null;
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = await this.#parent(path, true);
    if (!dir) throw new Error(`Can't create a folder for ${path}`);
    const handle = await dir.getFileHandle(name, { create: true });
    const bytes = data as Uint8Array<ArrayBuffer>;
    if ("createWritable" in handle) {
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    }
    // Safari's workers only have sync access handles.
    const access = await (
      handle as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<{
          truncate(size: number): void;
          write(data: Uint8Array, options: { at: number }): number;
          flush(): void;
          close(): void;
        }>;
      }
    ).createSyncAccessHandle();
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
    access.close();
  }

  async remove(path: string): Promise<void> {
    const { dir, name } = await this.#parent(path, false);
    await dir?.removeEntry(name, { recursive: true }).catch(notFound);
  }

  async list(path: string): Promise<string[]> {
    const dir = await this.#dir(path.split("/").filter(Boolean), false);
    if (!dir) return [];
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    return names;
  }

  async #parent(path: string, create: boolean) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`Not a file path: ${path}`);
    return { dir: await this.#dir(parts, create), name };
  }

  async #dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let dir = await this.#root;
    for (const part of parts) {
      const next = await dir.getDirectoryHandle(part, { create }).catch(notFound);
      if (!next) return null;
      dir = next;
    }
    return dir;
  }
}

/** Missing files and folders read as nothing; anything else is a real failure. */
function notFound(error: unknown): null {
  if (error instanceof DOMException && error.name === "NotFoundError") return null;
  throw error;
}
