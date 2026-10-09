// Several sources that provide the same namespace, read as one. A modpack often has more
// than one jar touching a namespace: GregTech's own jar owns the bulk of `assets/gregtech/`
// and small satellite mods patch a few more files into it. Reading the union, first source
// first, means which jar happens to list last never hides the real one.

import type { AssetSource } from "./asset-source.ts";

export class MultiSource implements AssetSource {
  readonly sources: readonly AssetSource[];
  readonly #recursive = new Map<string, string[]>();

  constructor(sources: readonly AssetSource[]) {
    this.sources = sources;
  }

  get label(): string {
    return this.sources.map((s) => s.label).join(", ");
  }

  namespaces(): string[] {
    return [...new Set(this.sources.flatMap((s) => s.namespaces()))];
  }

  listFiles(dir: string): string[] {
    return [...new Set(this.sources.flatMap((s) => s.listFiles(dir)))];
  }

  listFilesRecursive(dir: string): string[] {
    let cached = this.#recursive.get(dir);
    if (!cached) {
      cached = [...new Set(this.sources.flatMap((s) => s.listFilesRecursive(dir)))];
      this.#recursive.set(dir, cached);
    }
    return cached;
  }

  has(rel: string): boolean {
    return this.sources.some((s) => s.has(rel));
  }

  async bytes(rel: string): Promise<Uint8Array | null> {
    for (const s of this.sources) if (s.has(rel)) return s.bytes(rel);
    return null;
  }
}
