// Prefabs (web-core.md, section 8): a prefab is a small project with an anchor and a north,
// saved in the project format, so it can be opened and edited like one. Paste commands pin a
// prefab by its content hash, so editing a prefab later can't change what an old command meant.

import { boxOf } from "../box.ts";
import { CellSet } from "../cellset.ts";
import { cutPiece, forEachPieceCell, importSemantics, type Piece } from "../piece.ts";
import { Project } from "../project.ts";
import { hash64 } from "./bytes.ts";
import { loadProject, type SavedProject, saveProject } from "./project-file.ts";
import { stateInput } from "./state-json.ts";

/** Saves a piece as a prefab named `name`, keeping its anchor, north and box. */
export async function savePrefab(piece: Piece, name: string): Promise<SavedProject> {
  const project = new Project();
  const semantics = importSemantics(piece, project.semantics, undefined, () => undefined);
  const ids = piece.states.map((s) =>
    s === null ? 0 : project.world.states.intern(stateInput(s, (n) => semantics[n - 1] ?? 0)),
  );
  forEachPieceCell(piece, (x, y, z, n) => {
    const id = ids[n - 1] ?? 0;
    if (id !== 0) project.world.setId(x, y, z, id);
  });
  project.run({
    id: "prefab-settings",
    kind: "settings",
    args: { name, north: piece.north },
  });
  return saveProject(project, {
    size: piece.size,
    ...(piece.anchor && { anchor: piece.anchor }),
  });
}

/**
 * A prefab as a piece, ready to paste: every cell of its box, empty ones as air (so a paste
 * with `air` clears the prefab's whole box).
 */
export async function loadPrefab(saved: SavedProject): Promise<Piece> {
  const project = await loadProject(saved);
  const [w, h, d] = saved.manifest.size ?? sizeOf(project);
  const cells = CellSet.ofBox(boxOf([0, 0, 0, w - 1, h - 1, d - 1]));
  const piece = cutPiece(
    { world: project.world, semantics: project.semantics, north: project.settings.north },
    cells,
    saved.manifest.anchor,
  );
  if (!piece) throw new Error("A prefab can't be empty");
  return piece;
}

/**
 * A prefab's content hash: its cells, semantics, anchor and north, not its id or name. Chunk
 * blobs are named by their own hashes, so hashing the manifest covers every cell.
 */
export function prefabHash(saved: SavedProject): string {
  const { id: _, settings, ...content } = saved.manifest;
  const json = canonicalJSON({ ...content, north: settings.north });
  return hash64(utf8(json));
}

/** JSON with object keys sorted, so equal content always gives the same text. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function sizeOf(project: Project): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  project.world.forEachCell((cx, cy, cz) => {
    x = Math.max(x, cx + 1);
    y = Math.max(y, cy + 1);
    z = Math.max(z, cz + 1);
  });
  return [Math.max(1, x), Math.max(1, y), Math.max(1, z)];
}

function utf8(text: string): Uint8Array {
  const codec = globalThis as unknown as {
    TextEncoder: new () => { encode(t: string): Uint8Array };
  };
  return new codec.TextEncoder().encode(text);
}
