// Saving and loading projects (web-core.md, section 8). A saved project is a manifest (JSON)
// plus storage-chunk blobs named by the hash of their contents, so sync uploads only chunks
// that changed, and identical chunks are stored once. A bundle packs both into one file for
// export and tests. Derived data (meshes, light) is never saved.
//
// State ids are compacted on save: the states the cells use, renumbered 1..n in the order of
// their old ids, so the same build saves to the same bytes whatever its history.

import type { CellState } from "../cell-state.ts";
import { chunkKey, chunkKeyToCoords } from "../coords.ts";
import { Project, type ProjectOptions } from "../project.ts";
import { type RegistryJSON, SemanticRegistry } from "../semantics.ts";
import { type ProjectSettings, settingsFrom } from "../settings.ts";
import { World } from "../world.ts";
import { ByteReader, ByteWriter, deflate, hash64, inflate } from "./bytes.ts";
import {
  decodeStorageChunk,
  encodeStorageChunk,
  STORAGE_BITS,
  STORAGE_SIZE,
  STORAGE_VOLUME,
} from "./chunk-codec.ts";
import { type StateJSON, stateInput, stateJSON } from "./state-json.ts";

export const FORMAT_VERSION = 1;

export interface Manifest {
  readonly format: typeof FORMAT_VERSION;
  readonly id: string;
  readonly settings: ProjectSettings;
  readonly cells: number;
  readonly registry: RegistryJSON;
  /** State i + 1 of the saved chunks. */
  readonly states: readonly StateJSON[];
  /** Storage chunk coordinates ("x,y,z", in 32-cell units) to blob hash. */
  readonly chunks: Readonly<Record<string, string>>;
  /** Prefabs only: the cell a paste puts at its target, from the box's corner. */
  readonly anchor?: readonly [number, number, number];
  /** Prefabs only: the box the prefab fills, from [0, 0, 0]. */
  readonly size?: readonly [number, number, number];
}

export interface SavedProject {
  readonly manifest: Manifest;
  /** Compressed storage chunks by hash. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

/** How long a save works before it gives `pace` a turn. */
const SAVE_SLICE_MS = 6;

/**
 * Serializes a project. `pace`, when given, is awaited between chunks once the work has run a
 * few milliseconds, so a worker saving a big build can still answer commands (an undo) while it
 * does. Pass a project nothing edits meanwhile, such as a fork.
 */
export async function saveProject(
  project: Project,
  prefab?: { anchor?: readonly [number, number, number]; size: readonly [number, number, number] },
  pace?: () => Promise<void>,
): Promise<SavedProject> {
  let sliceStart = Date.now();
  const breathe = async () => {
    if (!pace || Date.now() - sliceStart < SAVE_SLICE_MS) return;
    await pace();
    sliceStart = Date.now();
  };
  const world = project.world;
  const L = world.layout;
  const keys = [...world.chunkKeys()].sort((a, b) => a - b);

  // Compact state ids: those in use, in old-id order.
  const used = new Set<number>();
  for (const key of keys) {
    world.chunkByKey(key)?.forEachUsedId((id) => used.add(id));
    await breathe();
  }
  const oldIds = [...used].sort((a, b) => a - b);
  const remap = new Uint16Array(world.states.size + 1);
  oldIds.forEach((id, i) => {
    remap[id] = i + 1;
  });
  const states = oldIds.map((id) => stateJSON(world.states.get(id) as CellState));

  const chunks: Record<string, string> = {};
  const blobs = new Map<string, Uint8Array>();
  const pending: Promise<void>[] = [];
  const store = (sx: number, sy: number, sz: number, dense: Uint16Array) => {
    const encoded = encodeStorageChunk(dense);
    if (!encoded) return;
    const hash = hash64(encoded);
    chunks[`${sx},${sy},${sz}`] = hash;
    if (!blobs.has(hash)) {
      blobs.set(hash, encoded);
      pending.push(deflate(encoded).then((z) => void blobs.set(hash, z)));
    }
  };

  const runtime = new Uint16Array(L.volume);
  const storage = new Uint16Array(STORAGE_VOLUME);
  if (L.bits >= STORAGE_BITS) {
    // Each runtime chunk holds (size / 32)³ storage chunks.
    const per = L.size / STORAGE_SIZE;
    for (const key of keys) {
      const chunk = world.chunkByKey(key);
      if (!chunk) continue;
      chunk.copyTo(runtime);
      const [cx, cy, cz] = chunkKeyToCoords(key);
      for (let py = 0; py < per; py++)
        for (let pz = 0; pz < per; pz++)
          for (let px = 0; px < per; px++) {
            // Rows along x are contiguous in both layouts.
            for (let y = 0; y < STORAGE_SIZE; y++)
              for (let z = 0; z < STORAGE_SIZE; z++) {
                const from = L.localIndex(
                  px * STORAGE_SIZE,
                  py * STORAGE_SIZE + y,
                  pz * STORAGE_SIZE + z,
                );
                const to = z * STORAGE_SIZE + y * STORAGE_SIZE ** 2;
                for (let x = 0; x < STORAGE_SIZE; x++)
                  storage[to + x] = remap[runtime[from + x] ?? 0] ?? 0;
              }
            store(cx * per + px, cy * per + py, cz * per + pz, storage);
            await breathe();
          }
    }
  } else {
    // Runtime chunks are smaller: gather each storage chunk from the runtime chunks inside it.
    const per = STORAGE_SIZE / L.size;
    const groups = new Map<string, number[]>();
    for (const key of keys) {
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const id = `${Math.floor(cx / per)},${Math.floor(cy / per)},${Math.floor(cz / per)}`;
      groups.set(id, [...(groups.get(id) ?? []), key]);
    }
    for (const [id, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      storage.fill(0);
      const [sx, sy, sz] = id.split(",").map(Number) as [number, number, number];
      for (const key of members) {
        world.chunkByKey(key)?.copyTo(runtime);
        const [cx, cy, cz] = chunkKeyToCoords(key);
        const ox = (cx - sx * per) * L.size;
        const oy = (cy - sy * per) * L.size;
        const oz = (cz - sz * per) * L.size;
        for (let y = 0; y < L.size; y++)
          for (let z = 0; z < L.size; z++)
            for (let x = 0; x < L.size; x++) {
              storage[ox + x + (oz + z) * STORAGE_SIZE + (oy + y) * STORAGE_SIZE ** 2] =
                remap[runtime[L.localIndex(x, y, z)] ?? 0] ?? 0;
            }
      }
      store(sx, sy, sz, storage);
      await breathe();
    }
  }
  await Promise.all(pending);

  const manifest: Manifest = {
    format: FORMAT_VERSION,
    id: project.id,
    settings: project.settings,
    cells: world.cellCount,
    registry: project.semantics.toJSON(),
    states,
    chunks,
    ...(prefab?.anchor && { anchor: prefab.anchor }),
    ...(prefab && { size: prefab.size }),
  };
  return { manifest, blobs };
}

export async function loadProject(
  saved: SavedProject,
  options: ProjectOptions = {},
): Promise<Project> {
  const { manifest } = saved;
  if (manifest.format !== FORMAT_VERSION)
    throw new Error(`Unknown project format ${manifest.format}`);
  const world = new World(options);
  const semantics = SemanticRegistry.fromJSON(manifest.registry);
  const ids = new Uint16Array(manifest.states.length + 1);
  manifest.states.forEach((s, i) => {
    ids[i + 1] = world.states.intern(stateInput(s));
  });
  const L = world.layout;

  // Decode each distinct blob once.
  const decoded = new Map<string, Uint16Array>();
  const blob = async (hash: string) => {
    let dense = decoded.get(hash);
    if (!dense) {
      const z = saved.blobs.get(hash);
      if (!z) throw new Error(`Missing chunk blob ${hash}`);
      dense = decodeStorageChunk(await inflate(z), new Uint16Array(STORAGE_VOLUME));
      for (let i = 0; i < dense.length; i++) dense[i] = ids[dense[i] ?? 0] ?? 0;
      decoded.set(hash, dense);
    }
    return dense;
  };

  const entries = Object.entries(manifest.chunks).map(([k, hash]) => {
    const [sx, sy, sz] = k.split(",").map(Number) as [number, number, number];
    return { sx, sy, sz, hash };
  });
  const runtime = new Uint16Array(L.volume);
  if (L.bits >= STORAGE_BITS) {
    const per = L.size / STORAGE_SIZE;
    const groups = new Map<number, typeof entries>();
    for (const e of entries) {
      const key = chunkKey(Math.floor(e.sx / per), Math.floor(e.sy / per), Math.floor(e.sz / per));
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const [key, members] of groups) {
      runtime.fill(0);
      const [cx, cy, cz] = chunkKeyToCoords(key);
      for (const e of members) {
        const dense = await blob(e.hash);
        const ox = (e.sx - cx * per) * STORAGE_SIZE;
        const oy = (e.sy - cy * per) * STORAGE_SIZE;
        const oz = (e.sz - cz * per) * STORAGE_SIZE;
        for (let y = 0; y < STORAGE_SIZE; y++)
          for (let z = 0; z < STORAGE_SIZE; z++)
            for (let x = 0; x < STORAGE_SIZE; x++) {
              runtime[L.localIndex(ox + x, oy + y, oz + z)] =
                dense[x + z * STORAGE_SIZE + y * STORAGE_SIZE ** 2] ?? 0;
            }
      }
      world.loadDense(cx, cy, cz, runtime);
    }
  } else {
    const per = STORAGE_SIZE / L.size;
    for (const e of entries) {
      const dense = await blob(e.hash);
      for (let py = 0; py < per; py++)
        for (let pz = 0; pz < per; pz++)
          for (let px = 0; px < per; px++) {
            let any = false;
            for (let y = 0; y < L.size; y++)
              for (let z = 0; z < L.size; z++)
                for (let x = 0; x < L.size; x++) {
                  const id =
                    dense[
                      px * L.size +
                        x +
                        (pz * L.size + z) * STORAGE_SIZE +
                        (py * L.size + y) * STORAGE_SIZE ** 2
                    ] ?? 0;
                  runtime[L.localIndex(x, y, z)] = id;
                  if (id !== 0) any = true;
                }
            if (any) world.loadDense(e.sx * per + px, e.sy * per + py, e.sz * per + pz, runtime);
          }
    }
  }
  world.takeDirtyChunks(); // a fresh world: everything is new anyway
  return new Project(
    { ...options, id: manifest.id },
    { world, semantics, settings: settingsFrom(manifest.settings) },
  );
}

// --- Bundles: one file holding a manifest and its blobs ---

const MAGIC = [0x56, 0x4f, 0x58, 0x4c]; // "VOXL"

/** Packs a saved project into one file: magic, version, compressed manifest, blobs. */
export async function packBundle(saved: SavedProject): Promise<Uint8Array> {
  const w = new ByteWriter();
  for (const b of MAGIC) w.u8(b);
  w.u8(FORMAT_VERSION);
  const json = await deflate(utf8.encode(JSON.stringify(saved.manifest)));
  w.varint(json.length);
  w.bytes(json);
  const hashes = [...saved.blobs.keys()].sort();
  w.varint(hashes.length);
  for (const hash of hashes) {
    const blob = saved.blobs.get(hash) as Uint8Array;
    w.bytes(utf8.encode(hash));
    w.varint(blob.length);
    w.bytes(blob);
  }
  return w.finish();
}

export async function unpackBundle(bytes: Uint8Array): Promise<SavedProject> {
  const r = new ByteReader(bytes);
  for (const b of MAGIC) if (r.u8() !== b) throw new Error("Not a Voxyl project bundle");
  const version = r.u8();
  if (version !== FORMAT_VERSION) throw new Error(`Unknown bundle version ${version}`);
  const manifest = JSON.parse(utf8.decode(await inflate(r.bytes(r.varint())))) as Manifest;
  const blobs = new Map<string, Uint8Array>();
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const hash = utf8.decode(r.bytes(16));
    blobs.set(hash, r.bytes(r.varint()).slice());
  }
  return { manifest, blobs };
}

// --- helpers ---

interface Utf8 {
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
}
// TextEncoder and TextDecoder exist in every runtime core targets; typed locally (no DOM lib).
const codecs = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
};
const utf8: Utf8 = {
  encode: (text) => new codecs.TextEncoder().encode(text),
  decode: (bytes) => new codecs.TextDecoder().decode(bytes),
};
