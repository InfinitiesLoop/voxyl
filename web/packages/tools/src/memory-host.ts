import type { Libraries } from "@voxyl/blocks";
import { hash64, type Piece, Project, type ProjectOptions } from "@voxyl/core";
import type {
  ClipboardPort,
  PrefabInfo,
  PrefabsPort,
  SharedPalettesPort,
  StoredSharedPalette,
  ToolHost,
} from "./tool.ts";

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
};
const utf8 = (text: string) => new runtime.TextEncoder().encode(text);

/** The cells of a piece that hold something. */
function occupiedCells(piece: Piece): number {
  let n = 0;
  for (let r = 0; r + 1 < piece.cells.length; r += 2) {
    const k = piece.cells[r] ?? 0;
    if (k !== 0 && piece.states[k - 1] !== null) n += piece.cells[r + 1] ?? 0;
  }
  return n;
}

/**
 * A host over one in-memory project: for tests, scripts and the headless host's first cut. It
 * counts the changes it was told about, and generates ids from a counter unless told not to.
 */
export class MemoryHost implements ToolHost {
  project: Project | null;
  editorAttached = false;
  /** Every `changed` notification, in order. */
  readonly changes: { tool: string; commandIds: readonly string[] }[] = [];
  #ids = 0;

  /** The clipboard's piece. */
  clip: Piece | null = null;
  readonly clipboard: ClipboardPort = {
    get: () => this.clip,
    set: (piece) => {
      this.clip = piece;
    },
  };

  /** The prefabs, in memory. */
  readonly prefabStore = new Map<string, { info: PrefabInfo; piece: Piece }>();
  readonly prefabs: PrefabsPort = {
    list: () => [...this.prefabStore.values()].map((p) => p.info).reverse(),
    load: (id) => this.prefabStore.get(id)?.piece ?? null,
    save: (piece, meta) => {
      const id = `pf${this.prefabStore.size + 1}-${++this.#ids}`;
      const info: PrefabInfo = {
        id,
        name: meta.name.trim(),
        tags: [...(meta.tags ?? [])],
        ...(meta.notes !== undefined && meta.notes !== "" && { notes: meta.notes }),
        cells: occupiedCells(piece),
        size: piece.size,
        hash: hash64(utf8(JSON.stringify(piece))),
        savedAt: this.#ids,
      };
      this.prefabStore.set(id, { info, piece });
      return info;
    },
    update: (id, changes) => {
      const found = this.prefabStore.get(id);
      if (!found) throw new Error("That prefab is gone");
      let { piece } = found;
      if (changes.anchor) piece = { ...piece, anchor: changes.anchor };
      const { notes: oldNotes, ...rest } = found.info;
      const notes = changes.notes === undefined ? oldNotes : changes.notes || undefined;
      const info: PrefabInfo = {
        ...rest,
        ...(notes !== undefined && { notes }),
        name: changes.name ?? found.info.name,
        tags: changes.tags ? [...changes.tags] : found.info.tags,
        hash: changes.anchor ? hash64(utf8(JSON.stringify(piece))) : found.info.hash,
      };
      this.prefabStore.set(id, { info, piece });
      return info;
    },
    delete: (id) => {
      this.prefabStore.delete(id);
    },
  };

  /** The shared palettes this host offers. */
  shared: StoredSharedPalette[] = [];
  readonly sharedPalettes: SharedPalettesPort = { list: () => this.shared };

  /** The block libraries this host offers; none by default. */
  blockLibraries: Libraries | null;

  constructor(
    project: Project | null = new Project(),
    options: { editor?: boolean; libraries?: Libraries } = {},
  ) {
    this.project = project;
    this.blockLibraries = options.libraries ?? null;
    this.editorAttached = options.editor ?? false;
  }

  /** A host over a fresh project. */
  static create(options: ProjectOptions & { libraries?: Libraries } = {}): MemoryHost {
    const { libraries, ...project } = options;
    return new MemoryHost(new Project(project), libraries ? { libraries } : {});
  }

  libraries(): Libraries {
    return this.blockLibraries ?? new Map();
  }

  newId(): string {
    return `mem-${++this.#ids}`;
  }

  changed(_project: Project, info: { tool: string; commandIds: readonly string[] }): void {
    this.changes.push(info);
  }
}
