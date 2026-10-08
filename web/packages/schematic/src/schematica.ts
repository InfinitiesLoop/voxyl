// The Schematica .schematic file: the NBT structure only. Nothing here walks cells or looks at
// palettes (export.ts does that). Port of the Godot app's SchematicaWriter.gd and
// SchematicaProbe.gd; the format was confirmed against Schematica's own reader and real files:
//
//   Width / Height / Length  Short
//   Materials                String "Alpha" (every Minecraft version after Classic)
//   Blocks                   ByteArray[W*H*L], index (y*L + z)*W + x, the low 8 bits of each
//                            cell's LOCAL id (SchematicaMapping says what each one is)
//   AddBlocks                ByteArray, only when some local id needs bits 8-11: one nibble per
//                            block, two to a byte, the HIGH nibble the even index. That is
//                            Schematica's order and the reverse of WorldEdit's, so the two
//                            readers can't both be satisfied; export.ts keeps local ids to a
//                            byte and only falls back to this past 255 distinct blocks.
//   Data                     ByteArray[W*H*L], each cell's metadata
//   Entities                 List<Compound>, always empty
//   TileEntities             List<Compound>, one per part cell
//   SchematicaMapping        Compound {registry: Short(local id)}, this file's own ids (0 is
//                            air), so the file never depends on a game's numeric id table
//   BlockMapping, ItemMapping  the same mapping under the names GTNH's WorldEdit fork reads: it
//                            re-resolves each registry name to the pasting world's current id
//                            (1.7.10 ids shift between sessions with mod load order). Without
//                            BlockMapping it pastes the stored id as it is and can collide
//                            with an unrelated mod's block. Voxyl places no items, so
//                            ItemMapping is empty.

import { type Compress, gunzip, gzip } from "./gzip.ts";
import { type Compound, nbt, readNbt, writeNbt } from "./nbt.ts";

/** Schematica stores each dimension as a Short. */
export const MAX_DIMENSION = 32767;

export interface SchematicData {
  /** Width (x), height (y), length (z). */
  readonly size: readonly [number, number, number];
  /** The low 8 bits of each cell's local id. */
  readonly blocks: Uint8Array;
  /** Bits 8-11 of each local id, packed Schematica's way; null when no id needs them. */
  readonly add: Uint8Array | null;
  readonly metas: Uint8Array;
  /** Registry name -> local id. */
  readonly mapping: Readonly<Record<string, number>>;
  readonly tileEntities: readonly Compound[];
}

/** The complete, gzipped file. */
export async function encodeSchematic(
  data: SchematicData,
  compress: Compress = gzip,
): Promise<Uint8Array> {
  const [w, h, l] = data.size;
  for (const d of data.size) {
    if (!Number.isInteger(d) || d < 0 || d > MAX_DIMENSION) {
      throw new RangeError(`A schematic is at most ${MAX_DIMENSION} cells along each axis`);
    }
  }
  const mapping: Compound = {};
  for (const [registry, id] of Object.entries(data.mapping)) mapping[registry] = nbt.short(id);
  const root: Compound = {
    Width: nbt.short(w),
    Height: nbt.short(h),
    Length: nbt.short(l),
    Materials: nbt.string("Alpha"),
    Blocks: nbt.byteArray(data.blocks),
    Data: nbt.byteArray(data.metas),
    Entities: nbt.list("compound", []),
    TileEntities: nbt.list("compound", data.tileEntities),
    SchematicaMapping: nbt.compound(mapping),
    BlockMapping: nbt.compound({ ...mapping }),
    ItemMapping: nbt.compound({}),
  };
  if (data.add) root.AddBlocks = nbt.byteArray(data.add);
  return compress(writeNbt("Schematic", root));
}

/** What a schematic holds, read back: its size, ids, a histogram of blocks, its tile entities. */
export interface SchematicProbe {
  readonly size: readonly [number, number, number];
  /** Registry name -> local id, from SchematicaMapping. */
  readonly mapping: Readonly<Record<string, number>>;
  /** Cells per registry name (or "id <n>" when the mapping doesn't cover an id). Air is left out. */
  readonly histogram: Readonly<Record<string, number>>;
  readonly tileEntities: readonly Compound[];
  /** Every cell's local id and metadata, index (y*L + z)*W + x. */
  readonly ids: Uint16Array;
  readonly metas: Uint8Array;
  readonly root: Compound;
}

/** Reads a gzipped .schematic. Null when it isn't a Schematica file. */
export async function probeSchematic(
  bytes: Uint8Array,
  decompress: Compress = gunzip,
): Promise<SchematicProbe | null> {
  let root: Compound;
  try {
    root = readNbt(await decompress(bytes)).value;
  } catch {
    return null;
  }
  const w = root.Width;
  const h = root.Height;
  const l = root.Length;
  const blocks = root.Blocks;
  if (
    w?.type !== "short" ||
    h?.type !== "short" ||
    l?.type !== "short" ||
    blocks?.type !== "byteArray"
  ) {
    return null;
  }
  const volume = w.value * h.value * l.value;
  if (blocks.value.length !== volume) return null;
  const addTag = root.AddBlocks;
  const add = addTag?.type === "byteArray" ? addTag.value : null;
  const metaTag = root.Data;
  const metas = metaTag?.type === "byteArray" ? metaTag.value : new Uint8Array(volume);

  const mapping: Record<string, number> = {};
  const names = new Map<number, string>();
  const mappingTag = root.SchematicaMapping;
  if (mappingTag?.type === "compound") {
    for (const [name, tag] of Object.entries(mappingTag.value)) {
      if (tag.type !== "short") continue;
      mapping[name] = tag.value;
      names.set(tag.value, name);
    }
  }
  const ids = new Uint16Array(volume);
  const histogram: Record<string, number> = {};
  for (let i = 0; i < volume; i++) {
    let id = blocks.value[i] ?? 0;
    if (add) {
      const packed = add[i >> 1] ?? 0;
      id |= (i % 2 === 0 ? packed >> 4 : packed & 0xf) << 8;
    }
    ids[i] = id;
    if (id === 0) continue;
    const key = names.get(id) ?? `id ${id}`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  const tiles = root.TileEntities;
  const tileEntities = tiles?.type === "list" ? (tiles.items as Compound[]) : [];
  return {
    size: [w.value, h.value, l.value],
    mapping,
    histogram,
    tileEntities,
    ids,
    metas,
    root,
  };
}
