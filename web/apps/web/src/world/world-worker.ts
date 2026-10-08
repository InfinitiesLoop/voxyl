// The world worker: owns the open project (its World), the light engine and mesh scheduling
// (a WorldSession), so generating, opening and lighting never block the thread that draws.
// It hands mesh jobs to the mesh workers over MessagePorts and forwards their results to the
// main thread, together with light, in the order it produced them. Saved projects live in
// OPFS (a ProjectStore), read and written here.

import {
  bakeBlockIcon,
  compileBlock,
  compileShape,
  DEFAULT_LIBRARY_ID,
  defaultLibrary,
  type Library,
  parseBlockRef,
  profileOfBlock,
  searchBlocks,
} from "@voxyl/blocks";
import {
  type CellSet,
  type CellStateTable,
  cutPiece,
  type Command as EditCommand,
  IDENTITY,
  type Piece,
  type Project,
  raycast,
} from "@voxyl/core";
import { CITY_THEME_KEY, cityThemeOf, cityThemePalette } from "@voxyl/fixtures";
import { importJar } from "@voxyl/mc-import";
import type { ModelShape, StateShape } from "@voxyl/mesher";
import {
  BlockMaterials,
  type CellBox,
  describeState,
  isHidden,
  LibraryStore,
  type LightingMode,
  lookColor,
  newPaletteKey,
  PaletteStore,
  PrefabStore,
  ProjectStore,
  stateLooks,
  WorldSession,
} from "@voxyl/session";
import { outlineOf } from "../editor/outline.ts";
import { planeToWorld } from "../views/plane.ts";
import {
  buildSample,
  type Framing,
  frameProject,
  projectBounds,
  sampleKind,
  savedId,
  themeAt,
  type WorldInfo,
} from "../worlds.ts";
import {
  defaultAnchor,
  mirrorOf,
  type PasteArgs,
  type PieceCells,
  pieceCells,
  pieceThumbnail,
  placedBox,
  placedPositions,
} from "./clipboard.ts";
import {
  type Aim,
  addPaletteCommand,
  addSemanticCommand,
  aim,
  clearSelectionCommand,
  commandId,
  describeSemanticCommand,
  EDITOR_SOURCE,
  editSemanticCommand,
  eraseCommand,
  fillBoxCommand,
  fillSelectionCommand,
  historyState,
  linkExistingCommand,
  linkPaletteCommand,
  newProject,
  paletteInfo,
  partGhost,
  placeCommand,
  removeSemanticCommand,
  renameCommand,
  renamePaletteCommand,
  renameSemanticCommand,
  replaceSelectionCommand,
  resemanticSelectionCommand,
  rotateCommand,
  selectCommand,
  semanticIdOf,
  semanticOfState,
  setCellCommand,
  setLookCommand,
  settingsCommand,
  sharedFromPalette,
  stepCommand,
  unlinkPaletteCommand,
} from "./editing.ts";
import { fillCells, stateFacings, statePartDraws, strokeCommand } from "./flat-edit.ts";
import { OpfsFolder } from "./opfs-folder.ts";
import {
  type AimView,
  type BlockPreview,
  type BlockSearch,
  type ClipboardInfo,
  type Command,
  EMPTY_SELECTION,
  type FromWorld,
  type LibraryInfo,
  MAX_GHOST_CELLS,
  MAX_PREVIEW_CELLS,
  MAX_SLICE_CELLS,
  type MeshReply,
  type MeshRequest,
  type PasteGhost,
  type RayHit,
  type Replies,
  type ToWorld,
  type Vec3,
} from "./protocol.ts";
import { selectionView } from "./selection.ts";
import { toolCells, toolCommand } from "./tools.ts";

// The app compiles with DOM types, so describe the worker scope we use rather than pulling
// in the WebWorker lib (the two conflict in one program).
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<ToWorld>) => void): void;
  postMessage(message: FromWorld, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** Jobs each mesh worker may hold at once, so one slow chunk doesn't stall the rest. */
const JOBS_PER_WORKER = 2;
/** Longest stretch spent copying light before letting other messages in. */
const LIGHT_SLICE_MS = 8;
/** Bricks of light per message: 4096 is 512 KB. */
const LIGHT_BATCH = 4096;
const STATS_INTERVAL_MS = 250;
/** A saved project is saved this long after its last change. */
const AUTOSAVE_MS = 1500;

interface Clip {
  readonly piece: Piece;
  readonly cells: PieceCells;
  /** r, g, b for each piece semantic, by its 1-based number (index 0 is unused). */
  readonly colors: Uint8Array;
  readonly info: ClipboardInfo;
}

interface MeshPort {
  readonly port: MessagePort;
  load: number;
}

const store = new ProjectStore(new OpfsFolder("voxyl"));
const libraryStore = new LibraryStore(new OpfsFolder("voxyl"));
const paletteStore = new PaletteStore(new OpfsFolder("voxyl"));
const prefabStore = new PrefabStore(new OpfsFolder("voxyl"));
/** The clipboard: a piece, kept across projects so one can be copied into another. */
let clipboard: Clip | null = null;
let session: WorldSession | null = null;
let project: Project | null = null;
/** The id the open project is saved under, or null for an unsaved sample. */
let saved: string | null = null;
let autosave: ReturnType<typeof setTimeout> | null = null;
let worldId = -1;
let mode: LightingMode = "off";
/** Whether meshes carry feature edges (a pane draws an outline, x-ray or wire view). */
let edgesOn = false;
/** What the views hide: a cutaway box, and whether only the selection's box is shown. */
let cutHide: CellBox | null = null;
let isolating = false;
let meshPorts: MeshPort[] = [];
let lastSeq = 0;
let idlePosted = -1;
/** The state count and registry revision the last looks sent were for. */
let looksPosted = { states: -1, revision: -1 };
/** The registry revision the last palettes sent were for, and the last history state sent. */
let palettesPosted = -1;
let historyPosted = "";
/**
 * The selection last described to the main thread, and a stamp of the cells and the registry,
 * so a command that touches neither sends nothing. `contentRev` counts cell-changing edits.
 */
let shownSelection: CellSet | null | undefined;
let postedSelectionKey = "";
let contentRev = 0;
/** The outline of `shownSelection`, so a content change doesn't retrace it. */
let shownOutline: ReturnType<typeof outlineOf> | null = null;
/** Every state's shape so far, for mesh workers (id - 1 -> shape). */
let shapes: StateShape[] = [];
/** The libraries looks draw blocks from: the default set, and any imported ones. */
const libraries = new Map<string, Library>([[DEFAULT_LIBRARY_ID, defaultLibrary()]]);
/** Imported libraries, read from storage once at startup (before the first world opens). */
const librariesLoaded = libraryStore
  .loadAll()
  .then((stored) => {
    for (const library of stored) libraries.set(library.id, library);
  })
  .catch((error: unknown) => console.error("Reading the block libraries failed", error));
/** Textured faces of the open world's looks, numbered as the renderer has them. */
let blocks = new BlockMaterials(libraries);
/**
 * What the mesh workers last heard of the looks' say in shapes: which states are clear
 * (StateLooks.clear) and their block models, with each model as JSON to compare.
 */
const NO_LOOK_SHAPES: {
  clear: Uint8Array;
  models: (ModelShape | null)[];
  keys: string[];
} = {
  clear: new Uint8Array(0),
  models: [],
  keys: [],
};
let lookShapesSent = NO_LOOK_SHAPES;
let pumpScheduled = false;
const meshTimes: number[] = [];

const nameOf = (semantic: number) => project?.semantics.nameOf(semantic) ?? "";
const materials = (states: CellStateTable) =>
  stateLooks(states, (project as Project).semantics, blocks).materials;
const post = (message: FromWorld, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

function world() {
  if (!session) throw new Error("no world loaded");
  return session.world;
}

/** The open project changed: a saved one is saved again shortly. */
function changed(): void {
  if (saved === null) return;
  if (autosave !== null) clearTimeout(autosave);
  autosave = setTimeout(() => {
    autosave = null;
    if (project && saved !== null) void store.save(project).catch(reportSaveError);
  }, AUTOSAVE_MS);
}

function reportSaveError(error: unknown): void {
  console.error("Saving the project failed", error);
}

/** Saves now if an autosave is waiting (before another project replaces this one). */
async function flushAutosave(): Promise<void> {
  if (autosave === null) return;
  clearTimeout(autosave);
  autosave = null;
  if (project && saved !== null) await store.save(project).catch(reportSaveError);
}

async function open(command: Extract<Command, { type: "load" }>): Promise<WorldInfo> {
  await flushAutosave();
  await librariesLoaded;
  const start = performance.now();
  const kind = sampleKind(command.source);
  const id = savedId(command.source);
  let framing: Framing;
  let next: Project;
  if (kind) {
    const built = buildSample(kind, command.chunkSize, themeAt(command.theme), libraries);
    next = built.project;
    framing = built.framing;
    saved = null;
  } else if (id !== null) {
    next = await store.open(id, { chunkBits: Math.log2(command.chunkSize) });
    framing = frameProject(next);
    saved = id;
  } else {
    throw new Error(`Nothing to open called ${command.source}`);
  }
  // The project and its session change together, after the last await.
  project = next;
  shownSelection = undefined;
  postedSelectionKey = "";
  contentRev = 0;
  shownOutline = null;
  project.setBlockProfiles(blockProfile);
  session = new WorldSession(next.world);
  session.setEdges(edgesOn);
  cutHide = null;
  isolating = false;
  worldId = command.world;
  looksPosted = { states: -1, revision: -1 };
  palettesPosted = -1;
  historyPosted = "";
  shapes = [];
  blocks = new BlockMaterials(libraries);
  lookShapesSent = NO_LOOK_SHAPES;
  idlePosted = -1;
  meshTimes.length = 0;
  if (mode !== "off") session.setLighting(mode, materials);
  return {
    name: project.settings.name,
    saved,
    theme: cityThemeOf(next.semantics),
    north: next.settings.north,
    grid: next.settings.grid,
    chunkSize: command.chunkSize,
    ...framing,
    loadMs: performance.now() - start,
  };
}

async function handle(command: Command): Promise<Replies[Command["type"]]> {
  switch (command.type) {
    case "load":
      return open(command);
    case "save": {
      if (!project) throw new Error("no project open");
      const entry = await store.save(project);
      saved = entry.id;
      return entry;
    }
    case "projects":
      return store.list();
    case "createProject":
      // Saved at once, then opened from storage like any saved project (so its history
      // starts empty: the starter semantics aren't steps to undo).
      return store.save(newProject(command.name, 5));
    case "rename":
      return runEdit(renameCommand(openProject(), command.name)) >= 0;
    case "addSemantic":
      return (
        runEdit(
          addSemanticCommand(openProject(), command.palette, command.name, {
            ...(command.description !== undefined && { description: command.description }),
            ...(command.look !== undefined && { look: command.look }),
            ...(command.form !== undefined && { form: command.form }),
          }),
        ) >= 0
      );
    case "editSemantic":
      return (
        runEdit(
          editSemanticCommand(openProject(), command.semantic, {
            name: command.name,
            description: command.description,
            look: command.look,
            ...(command.form !== undefined && { form: command.form }),
          }),
        ) >= 0
      );
    case "renameSemantic":
      return runEdit(renameSemanticCommand(openProject(), command.semantic, command.name)) >= 0;
    case "setLook":
      return runEdit(setLookCommand(openProject(), command.semantic, command.look)) >= 0;
    case "addPalette":
      return runEdit(addPaletteCommand(openProject(), command.name, command.extends)) >= 0;
    case "renamePalette":
      return runEdit(renamePaletteCommand(openProject(), command.palette, command.name)) >= 0;
    case "findBlocks": {
      await librariesLoaded;
      const { matched, hits } = searchBlocks(libraries, {
        query: command.query,
        ...(command.library !== undefined && { library: command.library }),
        ...(command.limit !== undefined && { limit: command.limit }),
        ...(command.offset !== undefined && { offset: command.offset }),
      });
      const icons = new Uint8Array(hits.length * 1024);
      hits.forEach((hit, i) => {
        if (hit.icon) icons.set(hit.icon.subarray(0, 1024), i * 1024);
      });
      return {
        libraries: [...libraries.values()].map((l) => ({ id: l.id, name: l.name })),
        matched,
        hits: hits.map(({ ref, name, color }) => ({ ref, name, color })),
        icons,
      } satisfies BlockSearch;
    }
    case "deleteProject":
      if (command.id === saved) saved = null; // it stays on screen, no longer saved
      await store.delete(command.id);
      return null;
    case "importProject":
      return store.importBundle(command.bytes);
    case "exportProject":
      await flushAutosave();
      return store.exportBundle(command.id);
    case "libraries":
      await librariesLoaded;
      return [...libraries.values()].filter((l) => l.id !== DEFAULT_LIBRARY_ID).map(infoOf);
    case "importJar": {
      const start = performance.now();
      const { library, skipped } = await importJar(command.bytes);
      await libraryStore.save(library);
      libraries.set(library.id, library);
      librariesChanged();
      return { ...infoOf(library), skipped: skipped.length, ms: performance.now() - start };
    }
    case "deleteLibrary":
      if (command.id === DEFAULT_LIBRARY_ID) return null;
      await libraryStore.delete(command.id);
      libraries.delete(command.id);
      librariesChanged();
      return null;
    case "sharedPalettes": {
      await librariesLoaded;
      return (await paletteStore.list()).map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description ?? "",
        version: p.version,
        updated: p.updated,
        from: p.from ?? null,
        count: p.semantics.length,
        colors: p.semantics.map((s) => lookColor(s.look ?? {}, blocks)),
      }));
    }
    case "sharedPalette":
      return paletteStore.load(command.key);
    case "saveSharedPalette":
      return paletteStore.save(command.palette);
    case "deleteSharedPalette":
      await paletteStore.delete(command.key);
      return null;
    case "sharePalette": {
      const open = openProject();
      const spec = sharedFromPalette(open, command.palette, newPaletteKey());
      const stored = await paletteStore.save({ ...spec, from: open.settings.name });
      // Linking turns this palette into the copy of what was just shared: one step to undo.
      if (command.link) runEdit(linkExistingCommand(open, command.palette, stored));
      return stored.key;
    }
    case "unlinkPalette":
      return runEdit(unlinkPaletteCommand(openProject(), command.palette)) >= 0;
    case "linkPalette": {
      const shared = await paletteStore.load(command.key);
      if (!shared) throw new Error("That shared palette is gone");
      return runEdit(linkPaletteCommand(openProject(), shared)) >= 0;
    }
    case "paintCells":
      return (
        runEdit(
          strokeCommand(
            openProject(),
            command.cells,
            command.semantic,
            command.face,
            command.look,
            command.label,
          ),
        ) > 0
      );
    case "fillPlane": {
      const open = openProject();
      const { axis, depth, u, v, window } = command;
      const cells = fillCells(open, axis, depth, u, v, window);
      const name =
        command.semantic === null
          ? "Erase"
          : open.semantics.nameOf(semanticIdOf(open, command.semantic));
      const label = `Fill ${cells.length / 3} ${command.semantic === null ? "empty" : name}`;
      return (
        runEdit(strokeCommand(open, cells, command.semantic, command.face, command.look, label)) > 0
      );
    }
    case "toolAt": {
      const open = openProject();
      const [x, y, z] = command.at;
      const [fx, fy, fz] = command.face;
      const target: Aim = {
        hit: [x, y, z],
        id: open.world.getId(x, y, z),
        place: [x + fx, y + fy, z + fz],
        face: command.face,
        hitY: 0.5,
      };
      const click = { tool: command.tool, brush: command.brush, camera: command.at, aim: target };
      return runEdit(toolCommand(open, click, command.semantic, command.face)) > 0;
    }
    case "rotateAt": {
      const open = openProject();
      const id = open.world.getId(...command.at);
      if (id === 0) return false;
      const target: Aim = { hit: command.at, id, place: null, face: command.face, hitY: 0.5 };
      return runEdit(rotateCommand(open, target, command.reverse)) > 0;
    }
    case "semanticAt": {
      const state = world().get(...command.at);
      return state ? semanticOfState(state) : null;
    }
    case "removeSemantic":
      return runEdit(removeSemanticCommand(openProject(), command.semantic)) >= 0;
    case "blockPreview": {
      await librariesLoaded;
      return blockPreview(command.ref);
    }
    case "bakeIcons": {
      await librariesLoaded;
      const size = command.size ?? 64;
      if (!Number.isInteger(size) || size < 16 || size > 256)
        throw new Error(`Icon size ${size} is out of range`);
      if (command.refs.length > 8) throw new Error("Too many icons in one bake");
      const icons = new Uint8Array(command.refs.length * size * size * 4);
      command.refs.forEach((ref, i) => {
        const icon = bakeBlockIcon(libraries, ref, size);
        if (icon) icons.set(icon, i * size * size * 4);
      });
      return { size, icons };
    }
    case "describeSemantic":
      return (
        runEdit(describeSemanticCommand(openProject(), command.semantic, command.description)) >= 0
      );
    case "settings": {
      const { type: _, ...patch } = command;
      return runEdit(settingsCommand(openProject(), patch)) >= 0;
    }
    case "visibility":
      cutHide = command.hide;
      isolating = command.isolate;
      applyVisibility();
      pump();
      return null;
    case "edges":
      edgesOn = command.on;
      session?.setEdges(edgesOn);
      pump();
      return null;
    case "lighting":
      mode = command.mode;
      session?.setLighting(mode, materials);
      return { lightAllMs: session?.stats().lightAllMs ?? null };
    case "theme": {
      const linked = project?.semantics.palettes().find((p) => p.linked?.key === CITY_THEME_KEY);
      if (!project || !linked?.linked) return { applied: false, relit: false };
      // A newer version of the same shared palette: looks change, semantic ids and cells don't.
      const version = linked.linked.version + 1;
      const args = cityThemePalette(themeAt(command.theme), version);
      const result = project.run({ id: `theme-${version}`, kind: "palette_sync", args });
      if (result.report.registryChanged) changed();
      return { applied: true, relit: session?.setMaterials(materials) ?? false };
    }
    case "intern":
      return world().states.intern({ semantic: project?.semantics.ensure(command.semantic) ?? 0 });
    case "setId":
      return runEdit(setCellCommand(openProject(), command.at, command.id, "Set cell")) > 0;
    case "fillBox":
      return runEdit(
        fillBoxCommand(openProject(), command.from, command.to, command.id, "Fill box"),
      );
    case "aim": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      if (!target) return null;
      let preview: Int32Array | null = null;
      if (command.tool) {
        const cells = toolCells(world(), { ...command.tool, aim: target });
        const shown = Math.min(cells.length, MAX_PREVIEW_CELLS);
        preview = new Int32Array(shown * 3);
        for (let i = 0; i < shown; i++) preview.set(cells[i] as Vec3, i * 3);
      }
      const open = openProject();
      const ghost = command.part
        ? partGhost(open, target, command.part.semantic, command.part.opposite)
        : null;
      const state = target.part ? world().states.get(target.id) : null;
      const met = target.part ? state?.parts[target.part.index] : undefined;
      return {
        ...target,
        preview,
        ghost,
        aimed: met ? { shape: met.shape, slot: met.slot } : null,
        pasteGhost:
          command.paste && target.place ? pasteGhostAt(open, target.place, command.paste) : null,
      } satisfies AimView;
    }
    case "toolEdit": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      if (!target) return false;
      const click = {
        tool: command.tool,
        brush: command.brush,
        camera: command.camera,
        aim: target,
      };
      return runEdit(toolCommand(openProject(), click, command.semantic, command.dir)) > 0;
    }
    case "clipboardCopy": {
      const open = openProject();
      const selection = open.selection;
      if (!selection || selection.size === 0) return null;
      const piece = pieceOfSelection(open, selection);
      if (!piece) return null;
      const info = setClipboard(piece, "selection");
      if (command.cut) runEdit(clearSelectionCommand(open));
      return info;
    }
    case "clipboardInfo":
      return clipboard?.info ?? null;
    case "clipboardClear":
      clipboard = null;
      return null;
    case "paste": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      if (!clipboard || !target?.place) return 0;
      const at: Vec3 = [
        target.place[0] + command.offset[0],
        target.place[1] + command.offset[1],
        target.place[2] + command.offset[2],
      ];
      const mirror = mirrorOf(command);
      const from = clipboard.info.from === "selection" ? "" : `${clipboard.info.from}, `;
      const cells = runEdit({
        id: commandId(),
        kind: "paste",
        source: EDITOR_SOURCE,
        label: `Paste ${from}${clipboard.info.cells} blocks`,
        args: {
          piece: clipboard.piece,
          at,
          turn: command.turn,
          ...(mirror && { mirror }),
          ...(command.air && { air: true }),
        },
      });
      return Math.max(0, cells);
    }
    case "savePrefab": {
      const open = openProject();
      const piece =
        command.from === "clipboard"
          ? clipboard?.piece
          : open.selection && open.selection.size > 0
            ? pieceOfSelection(open, open.selection)
            : null;
      if (!piece) {
        throw new Error(
          command.from === "clipboard" ? "The clipboard is empty" : "Nothing is selected",
        );
      }
      await librariesLoaded;
      const colors = pieceColors(piece);
      const thumb = pieceThumbnail(piece, (n) => colors[n] ?? 0x808080);
      return prefabStore.save(piece, { name: command.name, tags: command.tags, thumb });
    }
    case "prefabs":
      return prefabStore.list();
    case "prefabThumb":
      return prefabStore.thumb(command.id);
    case "usePrefab": {
      const piece = await prefabStore.load(command.id);
      const entry = await prefabStore.entry(command.id);
      if (!piece || !entry) throw new Error("That prefab is gone");
      await librariesLoaded;
      return setClipboard(piece, entry.name);
    }
    case "updatePrefab":
      return prefabStore.update(command.id, {
        ...(command.name !== undefined && { name: command.name }),
        ...(command.tags !== undefined && { tags: command.tags }),
      });
    case "deletePrefab":
      await prefabStore.delete(command.id);
      return null;
    case "rotate": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      return target ? runEdit(rotateCommand(openProject(), target, command.reverse)) > 0 : false;
    }
    case "place": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      if (!target) return false;
      return (
        runEdit(
          placeCommand(openProject(), target, command.semantic, command.dir, command.opposite),
        ) > 0
      );
    }
    case "erase": {
      const target = aim(world(), command.origin, command.dir, command.reach, hiddenNow());
      return target ? runEdit(eraseCommand(openProject(), target)) > 0 : false;
    }
    case "select": {
      const open = openProject();
      if (command.where === null && open.selection === null) return { cells: 0 };
      const { report } = open.run(selectCommand(command.where));
      return { cells: Number(report.notes.selected ?? 0) };
    }
    case "fillSelection":
      return {
        cells: Math.max(
          0,
          runEdit(fillSelectionCommand(openProject(), command.semantic, command.look)),
        ),
      };
    case "clearSelection":
      return { cells: Math.max(0, runEdit(clearSelectionCommand(openProject()))) };
    case "replaceSelection":
      return {
        cells: Math.max(
          0,
          runEdit(replaceSelectionCommand(openProject(), command.semantic, command.look)),
        ),
      };
    case "resemanticSelection": {
      const report = applyEdit(resemanticSelectionCommand(openProject(), command.from, command.to));
      return {
        switched: Number(report?.notes.switched ?? 0),
        skipped: Number(report?.notes.skipped ?? 0),
      };
    }
    case "undo":
    case "redo":
      return runEdit(stepCommand(openProject(), command.type)) >= 0;
    case "raycast": {
      const hit = raycast(
        world(),
        [...command.origin],
        [...command.dir],
        command.reach,
        hiddenNow(),
      );
      if (!hit) return null;
      const state = world().states.get(hit.id);
      const met = hit.part ? state?.parts[hit.part.index] : undefined;
      const semanticId = met ? met.semantic : state ? semanticOfState(state) : 0;
      return {
        cell: hit.cell,
        normal: hit.normal,
        id: hit.id,
        semanticId,
        semantic: nameOf(semanticId),
      } satisfies RayHit;
    }
    case "slice": {
      const { axis, depth, u0, v0, width, height } = command;
      if (width < 0 || height < 0 || width * height > MAX_SLICE_CELLS)
        throw new Error(`A slice of ${width} x ${height} cells is too big`);
      const w = world();
      const ids = new Uint16Array(width * height);
      const below = new Uint16Array(width * height);
      for (let j = 0; j < height; j++)
        for (let i = 0; i < width; i++) {
          const [x, y, z] = planeToWorld(axis, depth, u0 + i, v0 + j);
          const [bx, by, bz] = planeToWorld(axis, depth - 1, u0 + i, v0 + j);
          ids[i + j * width] = w.getId(x, y, z);
          below[i + j * width] = w.getId(bx, by, bz);
        }
      return { ids, below };
    }
    case "bounds":
      return project ? projectBounds(project) : null;
    case "cell": {
      const state = world().get(...command.at);
      return state && project ? describeState(state, project.semantics) : null;
    }
    case "rayEdit": {
      const hit = raycast(world(), [...command.origin], [...command.dir], command.reach);
      if (!hit) return false;
      const [x, y, z] = hit.cell;
      const project = openProject();
      if (command.action === "erase")
        return runEdit(setCellCommand(project, [x, y, z], 0, "Remove")) > 0;
      const [nx, ny, nz] = hit.normal;
      if (nx === 0 && ny === 0 && nz === 0) return false; // the ray started inside a cell
      const at = [x + nx, y + ny, z + nz] as const;
      return runEdit(setCellCommand(project, at, command.id, "Place")) > 0;
    }
  }
}

/** Tells the session what to hide: the cutaway, and the selection's box when isolating. */
function applyVisibility(): void {
  if (!session) return;
  let only: CellBox | null = null;
  const bounds = isolating ? project?.selection?.bounds() : null;
  if (bounds) {
    only = { min: [bounds.x0, bounds.y0, bounds.z0], max: [bounds.x1, bounds.y1, bounds.z1] };
  }
  session.setVisibility({ hide: cutHide, only });
}

/** Whether a ray should pass through a cell: the views hide it. */
function hiddenNow(): ((x: number, y: number, z: number) => boolean) | undefined {
  const current = session?.visibility;
  if (!current || (current.hide === null && current.only === null)) return undefined;
  return (x, y, z) => isHidden(current, x, y, z);
}

/** The selection as a piece anchored at the middle of its footprint, on its floor. */
function pieceOfSelection(open: Project, selection: CellSet): Piece | null {
  const b = selection.bounds();
  if (!b) return null;
  const [ax, ay, az] = defaultAnchor([b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1]);
  return cutPiece(
    { world: open.world, semantics: open.semantics, id: open.id, north: open.settings.north },
    selection,
    [b.x0 + ax, b.y0 + ay, b.z0 + az],
  );
}

/** Each piece semantic's colour as 0xrrggbb, by its 1-based number (index 0 is unused). */
function pieceColors(piece: Piece): number[] {
  const out = [0];
  for (const s of piece.semantics) {
    out.push(Number.parseInt(lookColor(s.look ?? {}, blocks).slice(1), 16));
  }
  return out;
}

/** Puts a piece in the clipboard (anchored mid-footprint unless it says), and says what it is. */
function setClipboard(piece: Piece, from: string): ClipboardInfo {
  const anchored = piece.anchor ? piece : { ...piece, anchor: defaultAnchor(piece.size) };
  const cells = pieceCells(anchored);
  const colors = new Uint8Array(anchored.semantics.length * 3 + 3);
  pieceColors(anchored).forEach((rgb, n) => {
    colors[n * 3] = (rgb >> 16) & 0xff;
    colors[n * 3 + 1] = (rgb >> 8) & 0xff;
    colors[n * 3 + 2] = rgb & 0xff;
  });
  const info: ClipboardInfo = { size: anchored.size, cells: cells.semantics.length, from };
  clipboard = { piece: anchored, cells, colors, info };
  return info;
}

/** What a paste of the clipboard would fill with its anchor at `at`. */
function pasteGhostAt(open: Project, at: Vec3, args: PasteArgs): PasteGhost | null {
  if (!clipboard) return null;
  const { piece, cells, colors } = clipboard;
  const box = placedBox(piece, open.settings.north, at, args);
  if (cells.semantics.length > MAX_GHOST_CELLS) {
    return { positions: new Int32Array(0), colors: new Uint8Array(0), ...box };
  }
  const positions = placedPositions(piece, cells, open.settings.north, at, args);
  const rgb = new Uint8Array(cells.semantics.length * 3);
  for (let i = 0; i < cells.semantics.length; i++) {
    const n = cells.semantics[i] ?? 0;
    rgb[i * 3] = colors[n * 3] ?? 128;
    rgb[i * 3 + 1] = colors[n * 3 + 1] ?? 128;
    rgb[i * 3 + 2] = colors[n * 3 + 2] ?? 128;
  }
  return { positions, colors: rgb, ...box };
}

/** A block's faces as textures, tinted, for the block chooser's preview. */
function blockPreview(ref: string): BlockPreview | null {
  const block = compileBlock(libraries, ref, IDENTITY);
  const shape = block?.cube ? null : compileShape(libraries, ref, IDENTITY);
  const faces = block?.cube ?? shape?.sides ?? null;
  if (!block && !shape) return null;
  const out = new Uint8Array(6 * 1024);
  faces?.forEach((face, f) => {
    if (!face) return;
    const parsed = parseBlockRef(face.texture);
    const texture = parsed ? libraries.get(parsed.library)?.textures[parsed.block] : undefined;
    if (texture?.size !== 16) return;
    const tint = face.tint ? Number.parseInt(face.tint.slice(1), 16) : 0xffffff;
    const t = [(tint >> 16) & 0xff, (tint >> 8) & 0xff, tint & 0xff];
    for (let i = 0; i < 256; i++) {
      for (let c = 0; c < 3; c++)
        out[f * 1024 + i * 4 + c] = Math.round(
          ((texture.rgba[i * 4 + c] ?? 0) * (t[c] ?? 255)) / 255,
        );
      out[f * 1024 + i * 4 + 3] = texture.rgba[i * 4 + 3] ?? 0;
    }
  });
  return { faces: out, cube: block?.cube != null, color: block?.color ?? "#808080" };
}

function openProject(): Project {
  if (!project) throw new Error("no project open");
  return project;
}

/**
 * Runs an edit command on the open project (every edit goes through Project.run, so it is
 * in the history and undoes). Null when there was nothing to do.
 */
function applyEdit(command: EditCommand | null) {
  if (!command) return null;
  const open = openProject();
  const before = open.settings;
  const { report } = open.run(command);
  const after = open.settings;
  // A rename (or any settings change) touches no cells, but a saved project still stores it.
  const settingsChanged =
    after.name !== before.name ||
    after.north !== before.north ||
    after.grid[0] !== before.grid[0] ||
    after.grid[1] !== before.grid[1];
  if (report.cells > 0) contentRev++;
  if (report.cells > 0 || report.registryChanged || settingsChanged) changed();
  return report;
}

/** The cells an edit changed, or -1 if there was nothing to do. */
function runEdit(command: EditCommand | null): number {
  const report = applyEdit(command);
  return report ? report.cells : -1;
}

/** Tells the main thread what the selection holds, when that changed. */
function postSelection(): void {
  if (!project) return;
  const sel = project.selection;
  const key = `${contentRev}|${project.semantics.revision}|${sel?.size ?? 0}`;
  if (sel === shownSelection && key === postedSelectionKey) return;
  const setChanged = sel !== shownSelection;
  if (setChanged && isolating) applyVisibility();
  if (!sel || sel.size === 0) {
    const wasEmpty = shownSelection === null;
    shownSelection = null;
    shownOutline = null;
    postedSelectionKey = key;
    if (!wasEmpty) post({ type: "selection", world: worldId, view: EMPTY_SELECTION });
    return;
  }
  if (setChanged || !shownOutline) shownOutline = outlineOf(sel);
  shownSelection = sel;
  postedSelectionKey = key;
  const lines = shownOutline.lines.slice();
  const view = selectionView(project, { ...shownOutline, lines }, blocks);
  post({ type: "selection", world: worldId, view }, lines.byteLength > 0 ? [lines.buffer] : []);
}

/** Tells the main thread what undo and redo would do, and the name and grid, if that changed. */
function postHistory(): void {
  if (!project) return;
  const state = {
    ...historyState(project),
    name: project.settings.name,
    grid: project.settings.grid,
    north: project.settings.north,
  };
  const key = JSON.stringify(state);
  if (key === historyPosted) return;
  historyPosted = key;
  post({ type: "history", world: worldId, ...state });
}

/** Hands out whatever work the session has: mesh jobs, emptied chunks, light. */
function pump(): void {
  pumpScheduled = false;
  const s = session;
  if (!s) return;
  s.sync();
  const added = s.takeShapes();
  if (added) {
    shapes.push(...added.shapes);
    const request: MeshRequest = { world: worldId, ...added };
    for (const p of meshPorts) p.port.postMessage(request);
  }
  postLooks(s);
  for (;;) {
    let free: MeshPort | undefined;
    for (const p of meshPorts)
      if (p.load < JOBS_PER_WORKER && (!free || p.load < free.load)) free = p;
    if (!free) break;
    const job = s.takeJob();
    if (!job) break;
    free.load++;
    const request: MeshRequest = { world: worldId, job };
    free.port.postMessage(request, [job.cells.buffer]);
  }
  for (const key of s.takeRemoved()) {
    const none = new Uint16Array(0);
    post({
      type: "mesh",
      world: worldId,
      key,
      quads: none,
      quadCount: 0,
      tris: none,
      triCount: 0,
      edges: none,
    });
  }
  const start = performance.now();
  for (let u = s.takeLightUpdate(LIGHT_BATCH); u; u = s.takeLightUpdate(LIGHT_BATCH)) {
    const transfer: Transferable[] = [
      u.slots.buffer,
      u.bricks.buffer,
      u.tables.buffer,
      u.tableData.buffer,
    ];
    if (u.grid) transfer.push(u.grid.data.buffer);
    post({ type: "light", world: worldId, update: u }, transfer);
    if (performance.now() - start > LIGHT_SLICE_MS) {
      schedulePump(); // more may be waiting: let mesh results and commands in first
      return;
    }
  }
  if (s.idle && idlePosted !== lastSeq) {
    idlePosted = lastSeq;
    post({ type: "idle", world: worldId, seq: lastSeq });
  }
}

// Yields through a MessageChannel rather than setTimeout, which browsers clamp to 4 ms.
const yieldChannel = new MessageChannel();
yieldChannel.port1.onmessage = () => pump();

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  yieldChannel.port2.postMessage(null);
}

/** Sends every state's look when new states have appeared or the registry changed. */
function postLooks(s: WorldSession): void {
  const states = s.world.states;
  const registry = (project as Project).semantics;
  if (registry.revision !== palettesPosted) {
    palettesPosted = registry.revision;
    post({ type: "palettes", world: worldId, palettes: paletteInfo(project as Project, blocks) });
  }
  if (states.size === looksPosted.states && registry.revision === looksPosted.revision) return;
  const { colors, intent, faces, modelSlots, clear, models } = stateLooks(states, registry, blocks);
  const materials = blocks.data;
  const textures = blocks.takeTextures();
  const facing = stateFacings(project as Project);
  const partDraws = statePartDraws(project as Project, blocks);
  post(
    {
      type: "looks",
      world: worldId,
      colors,
      intent,
      facing,
      partDraws,
      faces,
      modelSlots,
      materials,
      textures,
    },
    [
      colors.buffer,
      intent.buffer,
      facing.buffer,
      faces.buffer,
      modelSlots.buffer,
      materials.buffer,
      textures.rgba.buffer,
    ],
  );
  looksPosted = { states: states.size, revision: registry.revision };
  sendLookShapes(s, clear, models);
}

/**
 * Tells the mesh workers which states are clear and which draw a block model, if that
 * changed. A state already in use whose answer changed changes which faces show, so every
 * chunk is meshed again.
 */
function sendLookShapes(s: WorldSession, clear: Uint8Array, models: (ModelShape | null)[]): void {
  const keys = models.map((m) => (m ? JSON.stringify(m) : ""));
  let same = clear.length === lookShapesSent.clear.length;
  let remesh = false;
  const n = Math.max(clear.length, lookShapesSent.clear.length);
  for (let id = 0; id < n; id++) {
    const was = lookShapesSent.clear[id] ?? 0;
    const wasModel = lookShapesSent.keys[id] ?? "";
    if ((clear[id] ?? 0) === was && (keys[id] ?? "") === wasModel) continue;
    same = false;
    // A state new since the last send has no cells meshed with the old answer.
    if (id < lookShapesSent.clear.length) remesh = true;
  }
  if (same) return;
  lookShapesSent = { clear, models, keys };
  const request: MeshRequest = { world: worldId, clear, models };
  for (const p of meshPorts) p.port.postMessage(request);
  if (remesh) s.remeshAll();
}

function onMeshReply(port: MeshPort, reply: MeshReply): void {
  port.load--;
  const s = session;
  if (s && reply.world === worldId) {
    const { key, jobId, quads, quadCount, tris, triCount, lightBricks, edges, ms } = reply.result;
    meshTimes.push(ms);
    if (meshTimes.length > 256) meshTimes.shift();
    // A chunk edited again while this mesh ran: the picture is of the older world.
    if (s.finishJob(key, jobId, lightBricks)) {
      post({ type: "mesh", world: worldId, key, quads, quadCount, tris, triCount, edges }, [
        quads.buffer,
        tris.buffer,
        edges.buffer,
      ]);
    }
  }
  pump();
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "meshPorts") {
    meshPorts = message.ports.map((port) => {
      const entry: MeshPort = { port, load: 0 };
      port.onmessage = (e: MessageEvent<MeshReply>) => onMeshReply(entry, e.data);
      // Shapes of the states the world already has, if it was loaded first.
      if (shapes.length > 0) {
        const request: MeshRequest = { world: worldId, from: 1, shapes };
        port.postMessage(request);
      }
      if (lookShapesSent.clear.length > 0) {
        const { clear, models } = lookShapesSent;
        const request: MeshRequest = { world: worldId, clear, models };
        port.postMessage(request);
      }
      return entry;
    });
    pump();
    return;
  }
  if (message.type === "camera") {
    session?.setCamera(...message.at);
    return;
  }
  // Commands run one at a time, in order, even those that wait on storage.
  queue = queue.then(() => run(message));
});

let queue: Promise<void> = Promise.resolve();

async function run(message: Extract<ToWorld, { seq: number }>): Promise<void> {
  const { seq } = message;
  try {
    const value = await handle(message);
    post({ type: "reply", seq, value }, transfersOf(value));
  } catch (error) {
    post({ type: "error", seq, message: error instanceof Error ? error.message : String(error) });
  }
  lastSeq = seq;
  postHistory();
  postSelection();
  pump();
}

setInterval(() => {
  const s = session;
  if (!s) return;
  const stats = s.stats();
  post({
    type: "stats",
    world: worldId,
    stats: {
      cells: s.world.cellCount,
      chunkCount: s.world.chunkCount,
      storageMb: s.world.memoryBytes / 2 ** 20,
      queued: stats.queued,
      inFlight: stats.inFlight,
      lightBricks: stats.lightBricks,
      lightTables: stats.lightTables,
      meshMsAvg: meshTimes.length > 0 ? meshTimes.reduce((a, b) => a + b, 0) / meshTimes.length : 0,
      lightAllMs: stats.lightAllMs,
      lightMb: stats.lightMb,
      lightCopyUs: stats.lightCopyUs,
    },
  });
}, STATS_INTERVAL_MS);

/** The buffers of typed arrays in a reply, moved rather than copied. */
function transfersOf(value: unknown): Transferable[] {
  if (ArrayBuffer.isView(value)) return [value.buffer as ArrayBuffer];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value)
    .filter((v): v is ArrayBufferView => ArrayBuffer.isView(v))
    .map((v) => v.buffer as ArrayBuffer);
}

function infoOf(library: Library): LibraryInfo {
  return { id: library.id, name: library.name, blocks: Object.keys(library.blocks).length };
}

/** The profile a look's block supplies, when the semantic's form sets none. */
function blockProfile(ref: string | undefined) {
  if (!ref) return undefined;
  const parsed = parseBlockRef(ref);
  const block = parsed ? libraries.get(parsed.library)?.blocks[parsed.block] : undefined;
  return block ? profileOfBlock(block) : undefined;
}

/** Looks that name the library's blocks change: resend looks, and relight if light did. */
function librariesChanged(): void {
  looksPosted = { states: -1, revision: -1 };
  palettesPosted = -1; // block colours may have changed
  // A block's profile may have arrived with its library.
  project?.setBlockProfiles(blockProfile);
  session?.setMaterials(materials);
}
