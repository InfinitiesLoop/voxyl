// A project: its world, its semantic registry, and the generic half of the command framework
// (web-core.md, sections 1 and 6). Every change goes through run(), which validates the
// command, applies it atomically, remembers its id so a repeat is harmless, and reports what
// changed. The undo and redo history builds on the recorded edits (step 4).

import { rejectCell } from "@voxyl/shapes";
import { type Box, unionBox } from "./box.ts";
import { type CellState, type CellStateInput, EMPTY_ID, semanticsOf } from "./cell-state.ts";
import type { CellSet } from "./cellset.ts";
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
import type { Piece } from "./piece.ts";
import {
  type CompiledPlacement,
  compilePlacement,
  type PlacementProfile,
} from "./placement-profile.ts";
import { evaluate, plainBox, type Region, RegionError, type RegionScope } from "./region.ts";
import { type PaletteId, type SemanticId, SemanticRegistry } from "./semantics.ts";
import { DEFAULT_SETTINGS, type ProjectSettings } from "./settings.ts";
import { StateMover } from "./transform.ts";
import { type Edit, World, type WorldOptions } from "./world.ts";

export interface ProjectOptions extends WorldOptions {
  /** The project's id (pieces cut from it map their semantics back by id). Default: random. */
  readonly id?: string;
  /** Prefab content by hash, for paste commands that name one (the host loads it first). */
  readonly prefabs?: (hash: string) => Piece | undefined;
}

/** How many recent command ids a project remembers to drop repeats. */
const RECENT_IDS = 64;
/** How many undoable commands keep their deltas in memory; undo stops at the oldest. */
export const UNDO_LIMIT = 500;

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
  /** The settings before and after, when the command changed them. */
  readonly settings: { readonly before: ProjectSettings; readonly after: ProjectSettings } | null;
  /** The selection before and after, when the command changed it. */
  readonly selection: { readonly before: CellSet | null; readonly after: CellSet | null } | null;
  readonly report: ChangeReport;
}

/** Where a history entry stands: applied, undone (redoable), or undone for good. */
export type EntryState = "active" | "undone" | "dead";

/** One command in the project's history (web-core.md, section 7). */
export interface HistoryEntry {
  readonly command: Command;
  /** False for the selection, undo and redo: they are logged but aren't undo steps. */
  readonly undoable: boolean;
  readonly state: EntryState;
  /** What it changed, kept in memory for undo; null for entries from before this session. */
  readonly applied: Applied | null;
}

interface Entry {
  readonly command: Command;
  readonly undoable: boolean;
  state: EntryState;
  applied: Applied | null;
}

export class Project {
  readonly id: string;
  readonly world: World;
  readonly semantics: SemanticRegistry;
  readonly #prefabs: ((hash: string) => Piece | undefined) | undefined;
  #settings: ProjectSettings;
  readonly #commands: ReadonlyMap<string, CommandDef>;
  readonly #recent = new Map<string, ChangeReport>();
  readonly #history: Entry[] = [];
  // Undone steps, most recent last; each step lists its entries latest first.
  readonly #redo: Entry[][] = [];
  // Undoable entries still holding deltas, oldest first (at most UNDO_LIMIT).
  readonly #withDeltas: Entry[] = [];
  // Never mutated once set: commands replace it, so undo can keep the old one.
  #selection: CellSet | null = null;
  // Compiled placement profiles by semantic, valid for one registry revision.
  readonly #placements = new Map<SemanticId, CompiledPlacement>();
  #placementsRevision = -1;
  /** A look's block's profile, used when the semantic's form sets none. The host supplies it. */
  #blockProfiles: ((block: string | undefined) => PlacementProfile | undefined) | null = null;

  constructor(
    options: ProjectOptions = {},
    from?: { world: World; semantics: SemanticRegistry; settings?: ProjectSettings },
  ) {
    this.id = options.id ?? randomId();
    this.world = from?.world ?? new World(options);
    this.semantics = from?.semantics ?? new SemanticRegistry();
    this.#settings = from?.settings ?? DEFAULT_SETTINGS;
    this.#prefabs = options.prefabs;
    this.#commands = new Map(COMMANDS.map((c) => [c.kind, c]));
  }

  /** The selected cells, or null. Part of the project, changed by the select command. */
  get selection(): CellSet | null {
    return this.#selection;
  }

  /** The project's settings: name, north, grid. Changed by the settings command. */
  get settings(): ProjectSettings {
    return this.#settings;
  }

  /** The exact cells of a region, evaluated against the project as it is now. */
  cells(region: Region): CellSet {
    try {
      return evaluate(region, this.#scope());
    } catch (error) {
      throw asCommandError(error);
    }
  }

  /**
   * Where a look's block's placement profile comes from, for semantics whose form sets none
   * (stairs face the player, a log follows the clicked face). The host knows the libraries;
   * the project doesn't, and nothing about it is saved. Pass null to stop asking.
   */
  setBlockProfiles(
    source: ((block: string | undefined) => PlacementProfile | undefined) | null,
  ): void {
    this.#blockProfiles = source;
    this.#placements.clear();
    this.#placementsRevision = -1;
  }

  /**
   * How a semantic's whole blocks may be oriented. Its form's profile wins; otherwise the
   * profile its look's block supplies (see setBlockProfiles). Anything goes when neither
   * does. The editor picks rotations for clicks with it.
   */
  placement(semantic: SemanticId): CompiledPlacement {
    if (this.#placementsRevision !== this.semantics.revision) {
      this.#placements.clear();
      this.#placementsRevision = this.semantics.revision;
    }
    let compiled = this.#placements.get(semantic);
    if (!compiled) {
      const resolved = this.semantics.has(semantic) ? this.semantics.resolve(semantic) : undefined;
      const profile = resolved?.form.placement ?? this.#blockProfiles?.(resolved?.look.block);
      compiled = compilePlacement(profile);
      this.#placements.set(semantic, compiled);
    }
    return compiled;
  }

  /**
   * Visits every occupied cell of a region (default: the whole build) with its state id: in a
   * fixed order for a region, chunk by chunk for the whole build.
   */
  forEachIn(
    region: Region | undefined,
    visit: (x: number, y: number, z: number, id: number) => void,
  ) {
    if (region === undefined) {
      this.world.forEachCell(visit);
      return;
    }
    const box = plainBox(region);
    if (box) {
      forEachInBox(this.world, box, visit);
      return;
    }
    this.cells(region).forEach((x, y, z) => {
      const id = this.world.getId(x, y, z);
      if (id !== EMPTY_ID) visit(x, y, z, id);
    });
  }

  /** Puts a selection back (undo). */
  restoreSelection(cells: CellSet | null): void {
    this.#selection = cells;
  }

  /**
   * The history: every command, oldest first, the same list that syncs. Undo and redo are
   * commands in it too, and the undo stack is a walk back through it.
   */
  get history(): readonly HistoryEntry[] {
    return this.#history;
  }

  /** What each command applied this session changed, oldest first. */
  get applied(): readonly Applied[] {
    return this.#history.flatMap((e) => (e.applied ? [e.applied] : []));
  }

  /** The id an undo command must name to undo the latest step, or null if nothing can be. */
  undoTarget(): string | null {
    return this.#undoStep()?.[0]?.command.id ?? null;
  }

  /** The id a redo command must name to redo the latest undone step, or null. */
  redoTarget(): string | null {
    return this.#redo.at(-1)?.[0]?.command.id ?? null;
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
    const undoable = this.#commands.get(command.kind)?.undoable !== false;
    if (undoable) {
      // A new edit after undoing: the undone steps can't be redone any more.
      for (const step of this.#redo) for (const e of step) e.state = "dead";
      this.#redo.length = 0;
    }
    this.#history.push({ command, undoable, state: "active", applied });
    if (undoable) this.#trim(this.#history.at(-1) as Entry);
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
    const fork = new Project(
      { id: this.id, ...(this.#prefabs && { prefabs: this.#prefabs }) },
      { world: this.world.fork(), semantics: this.semantics.clone(), settings: this.#settings },
    );
    fork.#selection = this.#selection;
    fork.#blockProfiles = this.#blockProfiles;
    return fork;
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
    const selectionBefore = this.#selection;
    const settingsBefore = this.#settings;
    const notes: Record<string, number | string> = {};
    world.beginEdit();
    try {
      def.apply(this.#context(notes), parsed.data);
    } catch (error) {
      world.restore(world.endEdit().before);
      this.semantics.restore(registryBefore);
      this.#selection = selectionBefore;
      this.#settings = settingsBefore;
      throw error instanceof RegionError ? new CommandError(error.message) : error;
    }
    const edit = world.endEdit();
    const changed = this.semantics.revision !== registryBefore.revision;
    const registry = changed ? { before: registryBefore, after: this.semantics.clone() } : null;
    const selection =
      this.#selection === selectionBefore
        ? null
        : { before: selectionBefore, after: this.#selection };
    const settings =
      this.#settings === settingsBefore ? null : { before: settingsBefore, after: this.#settings };
    const created = {
      palettes: newIds(registryBefore.palettes().length, this.semantics.palettes().length),
      semantics: newIds(registryBefore.size, this.semantics.size),
    };
    const report = { ...this.#report(edit), created, registryChanged: changed, notes };
    return { command, edit, registry, settings, selection, report };
  }

  #context(notes: Record<string, number | string>): CommandContext {
    const world = this.world;
    const semantics = this.semantics;
    const scope = this.#scope();
    const semantic = scope.semantic;
    const settings = () => this.#settings;
    const placement = (s: SemanticId) => this.placement(s);
    return {
      world,
      semantics,
      semantic,
      projectId: this.id,
      get settings() {
        return settings();
      },
      setSettings: (next) => {
        this.#settings = next;
      },
      prefab: (hash) => {
        const piece = this.#prefabs?.(hash);
        if (!piece) throw new CommandError(`Prefab ${hash} isn't loaded`);
        return piece;
      },
      intern(state: CellStateArg): number {
        const block = state.semantic === undefined ? undefined : semantic(state.semantic);
        const parts = state.parts?.map((p) => ({ ...p, semantic: semantic(p.semantic) }));
        // A whole block's rotation is stored fixed to its profile: allowed and canonical.
        const rotation =
          block !== undefined && parts === undefined
            ? placement(block).fix(state.rotation ?? 0)
            : state.rotation;
        if (parts) {
          const why = rejectCell(parts);
          if (why) {
            const list = parts.map((p) => `${p.shape}/${p.slot}`).join(", ");
            throw new CommandError(`Those parts can't share a cell (${why}): ${list}`);
          }
        }
        const input: CellStateInput = {
          ...(block !== undefined && { semantic: block }),
          ...(rotation !== undefined && { rotation }),
          ...(state.tags !== undefined && { tags: state.tags }),
          ...(parts !== undefined && { parts }),
        };
        try {
          return world.states.intern(input);
        } catch (error) {
          throw asCommandError(error);
        }
      },
      placement,
      mover: (m) => new StateMover(world.states, m, (s, r) => placement(s).fix(r)),
      set: (x, y, z, id) => world.setId(x, y, z, id),
      fillBox: (box, id) => world.fillBox(box.x0, box.y0, box.z0, box.x1, box.y1, box.z1, id),
      cells: (region) => evaluate(region, scope),
      fill(region, id) {
        const box = plainBox(region);
        if (box) return world.fillBox(box.x0, box.y0, box.z0, box.x1, box.y1, box.z1, id);
        let changed = 0;
        for (const b of evaluate(region, scope).bricks()) {
          if (b.full) {
            changed += world.fillBox(b.x, b.y, b.z, b.x + 7, b.y + 7, b.z + 7, id);
            continue;
          }
          for (let bit = 0; bit < 512; bit++) {
            if (!b.has(bit)) continue;
            if (world.setId(b.x + (bit & 7), b.y + (bit >> 6), b.z + ((bit >> 3) & 7), id))
              changed++;
          }
        }
        return changed;
      },
      forEachIn: (region, visit) => this.forEachIn(region, visit),
      setSelection: (cells) => {
        this.#selection = cells;
      },
      undo: (target) => {
        const step = this.#undoStep();
        const latest = step?.[0]?.command.id;
        if (!step || latest !== target) {
          throw new CommandError(
            latest ? `The latest undo step ends with ${latest}, not ${target}` : "Nothing to undo",
          );
        }
        for (const e of step) {
          const a = e.applied as Applied;
          world.restore(a.edit.before);
          if (a.registry) semantics.restore(a.registry.before);
          if (a.settings) this.#settings = a.settings.before;
          e.state = "undone";
        }
        this.#redo.push(step);
      },
      redo: (target) => {
        const step = this.#redo.at(-1);
        const latest = step?.[0]?.command.id;
        if (!step || latest !== target) {
          throw new CommandError(
            latest
              ? `The latest undone step ends with ${latest}, not ${target}`
              : "Nothing to redo",
          );
        }
        for (const e of [...step].reverse()) {
          const a = e.applied as Applied;
          world.restore(a.edit.after);
          if (a.registry) semantics.restore(a.registry.after);
          if (a.settings) this.#settings = a.settings.after;
          e.state = "active";
        }
        this.#redo.pop();
      },
      note(key, value) {
        notes[key] = value;
      },
    };
  }

  #scope(): RegionScope {
    const semantics = this.semantics;
    const selection = () => this.#selection;
    return {
      world: this.world,
      semantics,
      semantic(ref: SemanticArg): SemanticId {
        try {
          if (typeof ref === "number") {
            if (!semantics.has(ref)) throw new Error(`Unknown semantic id ${ref}`);
            return ref;
          }
          return semantics.derive(ref.palette, ref.base);
        } catch (error) {
          throw asCommandError(error);
        }
      },
      get selection() {
        return selection();
      },
    };
  }

  /**
   * The latest undo step, latest entry first: the newest active undoable command, plus the
   * active undoable commands before it in the same group (others in between are skipped).
   * Null if there is none, or it is from before this session (no deltas in memory).
   */
  #undoStep(): Entry[] | null {
    const step: Entry[] = [];
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const e = this.#history[i] as Entry;
      if (!e.undoable || e.state !== "active") continue;
      if (step.length === 0) {
        if (!e.applied) return null;
        step.push(e);
        if (e.command.group === undefined) break;
        continue;
      }
      if (e.command.group !== step[0]?.command.group || !e.applied) break;
      step.push(e);
    }
    return step.length > 0 ? step : null;
  }

  /** Drops the deltas of undoable commands beyond UNDO_LIMIT, oldest first. */
  #trim(entry: Entry): void {
    this.#withDeltas.push(entry);
    while (this.#withDeltas.length > UNDO_LIMIT) {
      const oldest = this.#withDeltas.shift();
      if (oldest) oldest.applied = null;
    }
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

/** A random id for a new project: 128 bits as hex. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  // crypto exists in every runtime core targets; typed locally (no DOM lib).
  (
    globalThis as unknown as { crypto: { getRandomValues(b: Uint8Array): void } }
  ).crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

/** Visits every occupied cell in a box, skipping chunks that don't exist, in a fixed order. */
function forEachInBox(
  world: World,
  box: Box,
  visit: (x: number, y: number, z: number, id: number) => void,
): void {
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
}
