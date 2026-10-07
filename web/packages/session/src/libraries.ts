// Block libraries kept in a folder (the browser's OPFS): imported ones only, since the default
// set is built into the app. An imported library is the user's own (from their game files)
// and stays on their device.
//
//   libraries/<id>/library.json   blocks, models and texture details (encodeLibrary)
//   libraries/<id>/pixels.bin     every texture's RGBA

import { decodeLibrary, encodeLibrary, type Library } from "@voxyl/blocks";
import type { Folder } from "./store.ts";

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
};

const SAFE_ID = /^[a-z0-9_.-]{1,64}$/;

export class LibraryStore {
  readonly #folder: Folder;

  constructor(folder: Folder) {
    this.#folder = folder;
  }

  /** Every stored library that loads (one stored in an older format is skipped). */
  async loadAll(): Promise<Library[]> {
    const out: Library[] = [];
    for (const id of await this.#folder.list("libraries")) {
      const library = await this.load(id);
      if (library) out.push(library);
    }
    return out;
  }

  async load(id: string): Promise<Library | null> {
    if (!SAFE_ID.test(id)) return null;
    const json = await this.#folder.read(`libraries/${id}/library.json`);
    const pixels = await this.#folder.read(`libraries/${id}/pixels.bin`);
    if (!json || !pixels) return null;
    return decodeLibrary(new runtime.TextDecoder().decode(json), pixels);
  }

  /** Stores a library, replacing one with the same id. */
  async save(library: Library): Promise<void> {
    if (!SAFE_ID.test(library.id)) throw new Error(`Not a library id: ${library.id}`);
    const { json, pixels } = encodeLibrary(library);
    await this.#folder.remove(`libraries/${library.id}`);
    await this.#folder.write(`libraries/${library.id}/pixels.bin`, pixels);
    // Written last, so a library is only found once its pixels are there.
    await this.#folder.write(
      `libraries/${library.id}/library.json`,
      new runtime.TextEncoder().encode(json),
    );
  }

  async delete(id: string): Promise<void> {
    if (SAFE_ID.test(id)) await this.#folder.remove(`libraries/${id}`);
  }
}
