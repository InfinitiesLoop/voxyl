// A project: its world, its semantic registry, and the generic half of the command framework
// (web-core.md, sections 1 and 6). Every change goes through run(), which validates the
// command, applies it atomically, remembers its id so a repeat is harmless, and reports what
// changed. The undo and redo history builds on the recorded edits (step 4).

import { type CellState, type CellStateInput, EMPTY_ID, semanticsOf } from "./cell-state.ts";
import { Chunk } from "./chunk.ts";
import {
  type CellStateArg,
  type Command,
  type CommandContext,
  type CommandDef,
  CommandError,
  type SemanticArg,
} from "./commands/command.ts";
import { COMMANDS } from "./commands/index.ts";
import { chunkKeyToCoords } from "./coords.ts";
import { type Box, unionBox } from "./region.ts";
import { type PaletteId, type SemanticId, SemanticRegistry } from "./semantics.ts";
import { type Edit, World, type WorldOptions } from "./world.ts";

/** How many recent command ids a project remembers to drop repeats. */
const RECENT_IDS = 64;

/** What a command changed. */
export interface ChangeReport {
  /** Cells whose state changed. */
  readonly cells: number;
  /** The box around them, or null if nothing changed. */
  readonly bounds: Box | null;
  /** Per semantic: how many changed cells held it before and after (parts count each). */
  readonly semantics: readonly SemanticChange[];
  /** Palettes and semantics the command created (registry ids only grow). */
  readonly created: {
    readonly palettes: readonly PaletteId[];
    readonly semantics: readonly SemanticId[];
  };
  /** Whether the semantics or palettes changed. */
  readonly registryChanged: boolean;
  /** Figures the command added ("skipped": 12). */
  readonly notes: Readonly<Record<string, number | string>>;
}

export interface SemanticChange {
  readonly semantic: SemanticId;
  readonly name: string;
  readonly before: number;
  readonly after: number;
}

export interface RunResult {
  /** "duplicate" when the id was already applied: nothing was changed again. */
  readonly status: "applied" | "duplicate";
  readonly id: string;
  readonly report: ChangeReport;
}

/** One applied command with what it changed (kept for undo during the session). */
export interface Applied {
  readonly command: Command;
  readonly edit: Edit;
  /** The registry before and after, when the command changed it. */
  readonly registry: { readonly before: SemanticRegistry; readonly after: SemanticRegistry } | null;
  readonly report: ChangeReport;
}

export class Project {
  readonly world: World;
  readonly semantics: SemanticRegistry;
  readonly #commands: ReadonlyMap<string, CommandDef>;
  readonly #recent = new Map<string, ChangeReport>();
  readonly #applied: Applied[] = [];

  constructor(options: WorldOptions = {}, from?: { world: World; semantics: SemanticRegistry }) {
    this.world = from?.world ?? new World(options);
    this.semantics = from?.semantics ?? new SemanticRegistry();
    this.#commands = new Map(COMMANDS.map((c) => [c.kind, c]));
  }

  /** Commands applied this session, oldest first. */
  get applied(): readonly Applied[] {
    return this.#applied;
  }

  /**
   * Validates and applies a command. It applies completely or not at all: a command that
   * throws leaves the world as it was. Throws CommandError for an unknown kind or bad
   * arguments.
   */
  run(command: Command): RunResult {
    const seen = this.#recent.get(command.id);
    if (seen) return { status: "duplicate", id: command.id, report: seen };
    const applied = this.#apply(command);
    this.#remember(command.id, applied.report);
    this.#applied.push(applied);
    return { status: "applied", id: command.id, report: applied.report };
  }

  /**
   * Applies a command to a fork and returns the fork and the report: a preview or dry run.
   * The project itself doesn't change.
   */
  preview(command: Command): { project: Project; report: ChangeReport } {
    const project = this.fork();
    return { project, report: project.#apply(command).report };
  }

  /** A copy that shares chunks until either side writes. */
  fork(): Project {
    return new Project({}, { world: this.world.fork(), semantics: this.semantics.clone() });
  }

  #apply(command: Command): Applied {
    const def = this.#commands.get(command.kind);
    if (!def) throw new CommandError(`Unknown command kind "${command.kind}"`);
    const parsed = def.args.safeParse(command.args ?? {});
    if (!parsed.success) {
      throw new CommandError(`Bad arguments for ${command.kind}: ${parsed.error.message}`);
    }
    const world = this.world;
    const registryBefore = this.semantics.clone();
    const notes: Record<string, number | string> = {};
    world.beginEdit();
    try {
      def.apply(this.#context(notes), parsed.data);
    } catch (error) {
      world.restore(world.endEdit().before);
      this.semantics.restore(registryBefore);
      throw error;
    }
    const edit = world.endEdit();
    const changed = this.semantics.revision !== registryBefore.revision;
    const registry = changed ? { before: registryBefore, after: this.semantics.clone() } : null;
    const created = {
      palettes: newIds(registryBefore.palettes().length, this.semantics.palettes().length),
      semantics: newIds(registryBefore.size, this.semantics.size),
    };
    const report = { ...this.#report(edit), created, registryChanged: changed, notes };
    return { command, edit, registry, report };
  }

  #context(notes: Record<string, number | string>): CommandContext {
    const world = this.world;
    const semantics = this.semantics;
    const semantic = (ref: SemanticArg): SemanticId => {
      try {
        if (typeof ref === "number") {
          if (!semantics.has(ref)) throw new Error(`Unknown semantic id ${ref}`);
          return ref;
        }
        return semantics.derive(ref.palette, ref.base);
      } catch (error) {
        throw asCommandError(error);
      }
    };
    return {
      world,
      semantics,
      semantic,
      intern(state: CellStateArg): number {
        const input: CellStateInput = {
          ...(state.semantic !== undefined && { semantic: semantic(state.semantic) }),
          ...(state.rotation !== undefined && { rotation: state.rotation }),
          ...(state.tags !== undefined && { tags: state.tags }),
          ...(state.parts !== undefined && {
            parts: state.parts.map((p) => ({ ...p, semantic: semantic(p.semantic) })),
          }),
        };
        try {
          return world.states.intern(input);
        } catch (error) {
          throw asCommandError(error);
        }
      },
      set: (x, y, z, id) => world.setId(x, y, z, id),
      fillBox: (box, id) => world.fillBox(box.x0, box.y0, box.z0, box.x1, box.y1, box.z1, id),
      forEachInBox(box, visit) {
        const L = world.layout;
        for (let cy = L.toChunk(box.y0); cy <= L.toChunk(box.y1); cy++) {
          for (let cz = L.toChunk(box.z0); cz <= L.toChunk(box.z1); cz++) {
            for (let cx = L.toChunk(box.x0); cx <= L.toChunk(box.x1); cx++) {
              const chunk = world.chunk(cx, cy, cz);
              if (!chunk) continue;
              const x0 = Math.max(box.x0, cx * L.size);
              const x1 = Math.min(box.x1, cx * L.size + L.size - 1);
              const y0 = Math.max(box.y0, cy * L.size);
              const y1 = Math.min(box.y1, cy * L.size + L.size - 1);
              const z0 = Math.max(box.z0, cz * L.size);
              const z1 = Math.min(box.z1, cz * L.size + L.size - 1);
              for (let y = y0; y <= y1; y++) {
                for (let z = z0; z <= z1; z++) {
                  for (let x = x0; x <= x1; x++) {
                    const id = chunk.get(L.localIndex(L.toLocal(x), L.toLocal(y), L.toLocal(z)));
                    if (id !== EMPTY_ID) visit(x, y, z, id);
                  }
                }
              }
            }
          }
        }
      },
      note(key, value) {
        notes[key] = value;
      },
    };
  }

  #remember(id: string, report: ChangeReport): void {
    this.#recent.set(id, report);
    if (this.#recent.size > RECENT_IDS) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
  }

  /** Diffs an edit's snapshots into counts per semantic and the changed box. */
  #report(edit: Edit): Pick<ChangeReport, "cells" | "bounds" | "semantics"> {
    const L = this.world.layout;
    const S = L.size;
    const n = L.bricksPerAxis;
    const bs = L.brickSize;
    // Transitions between state ids, counted: "before,after" -> cells.
    const transitions = new Map<number, number>();
    const count = (before: number, after: number, cells: number) => {
      const key = before * 0x10000 + after;
      transitions.set(key, (transitions.get(key) ?? 0) + cells);
    };
    let cells = 0;
    let bounds: Box | null = null;
    for (const [key, before] of edit.before) {
      const after = edit.after.get(key) ?? null;
      const [cx, cy, cz] = chunkKeyToCoords(key);
      const ox = cx * S;
      const oy = cy * S;
      const oz = cz * S;
      Chunk.diff(before, after, {
        cell(index, a, b) {
          const x = ox + (index & L.mask);
          const y = oy + (index >> (2 * L.bits));
          const z = oz + ((index >> L.bits) & L.mask);
          cells++;
          count(a, b, 1);
          bounds = unionBox(bounds, { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z });
        },
        brick(brick, a, b, volume) {
          const x = ox + (brick % n) * bs;
          const z = oz + (Math.floor(brick / n) % n) * bs;
          const y = oy + Math.floor(brick / (n * n)) * bs;
          cells += volume;
          count(a, b, volume);
          bounds = unionBox(bounds, {
            x0: x,
            y0: y,
            z0: z,
            x1: x + bs - 1,
            y1: y + bs - 1,
            z1: z + bs - 1,
          });
        },
      });
    }
    const tally = new Map<SemanticId, { before: number; after: number }>();
    const add = (state: CellState | null, side: "before" | "after", cellsOf: number) => {
      if (!state) return;
      for (const semantic of semanticsOf(state)) {
        const entry = tally.get(semantic) ?? { before: 0, after: 0 };
        entry[side] += cellsOf;
        tally.set(semantic, entry);
      }
    };
    const states = this.world.states;
    for (const [key, n] of transitions) {
      const before = Math.floor(key / 0x10000);
      const after = key % 0x10000;
      add(before === EMPTY_ID ? null : states.get(before), "before", n);
      add(after === EMPTY_ID ? null : states.get(after), "after", n);
    }
    const semantics = [...tally]
      .sort(([a], [b]) => a - b)
      .map(([semantic, { before, after }]) => ({
        semantic,
        name: this.semantics.nameOf(semantic),
        before,
        after,
      }));
    return { cells, bounds, semantics };
  }
}

/** Ids from `before` + 1 to `after`: what an append-only registry added. */
function newIds(before: number, after: number): number[] {
  return Array.from({ length: Math.max(0, after - before) }, (_, i) => before + 1 + i);
}

function asCommandError(error: unknown): CommandError {
  return error instanceof CommandError
    ? error
    : new CommandError(error instanceof Error ? error.message : String(error));
}
