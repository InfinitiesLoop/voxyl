// An assets root inside a mod jar or resource-pack zip: both keep it under a top-level
// `assets/` folder, so "minecraft/textures/blocks/stone.png" is "assets/minecraft/..." there.

import { type ByteSource, ZipReader } from "../zip.ts";
import { type AssetSource, PathIndex } from "./asset-source.ts";

const PREFIX = "assets/";

export class ZipAssetSource implements AssetSource {
  readonly label: string;
  readonly #zip: ZipReader;
  readonly #index: PathIndex;

  private constructor(label: string, zip: ZipReader, index: PathIndex) {
    this.label = label;
    this.#zip = zip;
    this.#index = index;
  }

  static async open(label: string, source: ByteSource): Promise<ZipAssetSource> {
    const zip = await ZipReader.open(source);
    const paths: string[] = [];
    for (const name of zip.names()) {
      if (name.startsWith(PREFIX)) paths.push(name.slice(PREFIX.length));
    }
    return new ZipAssetSource(label, zip, new PathIndex(paths));
  }

  namespaces = () => this.#index.namespaces();
  listFiles = (dir: string) => this.#index.listFiles(dir);
  listFilesRecursive = (dir: string) => this.#index.listFilesRecursive(dir);
  has = (rel: string) => this.#index.has(rel);

  async bytes(rel: string): Promise<Uint8Array | null> {
    return this.#index.has(rel) ? this.#zip.read(PREFIX + rel) : null;
  }
}
