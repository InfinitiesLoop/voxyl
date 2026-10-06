// The world worker: owns the open project (its World), the light engine and mesh scheduling
// (a WorldSession), so generating, opening and lighting never block the thread that draws.
// It hands mesh jobs to the mesh workers over MessagePorts and forwards their results to the
// main thread, together with light, in the order it produced them. Saved projects live in
// OPFS (a ProjectStore), read and written here.

import { type CellStateTable, EMPTY_ID, type Project, raycast } from "@voxyl/core";
import { CITY_THEME_KEY, cityThemeOf, cityThemePalette } from "@voxyl/fixtures";
import type { StateShape } from "@voxyl/mesher";
import {
  describeState,
  type LightingMode,
  ProjectStore,
  stateLooks,
  WorldSession,
} from "@voxyl/session";
import { planeToWorld } from "../views/plane.ts";
import {
  buildSample,
  type Framing,
  frameProject,
  sampleKind,
  savedId,
  themeAt,
  type WorldInfo,
} from "../worlds.ts";
import { OpfsFolder } from "./opfs-folder.ts";
import {
  type Command,
  type FromWorld,
  MAX_SLICE_CELLS,
  type MeshReply,
  type MeshRequest,
  type RayHit,
  type Replies,
  type ToWorld,
} from "./protocol.ts";

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

interface MeshPort {
  readonly port: MessagePort;
  load: number;
}

const store = new ProjectStore(new OpfsFolder("voxyl"));
let session: WorldSession | null = null;
let project: Project | null = null;
/** The id the open project is saved under, or null for an unsaved sample. */
let saved: string | null = null;
let autosave: ReturnType<typeof setTimeout> | null = null;
let worldId = -1;
let mode: LightingMode = "off";
let meshPorts: MeshPort[] = [];
let lastSeq = 0;
let idlePosted = -1;
/** The state count and registry revision the last looks sent were for. */
let looksPosted = { states: -1, revision: -1 };
/** Every state's shape so far, for mesh workers (id - 1 -> shape). */
let shapes: StateShape[] = [];
let pumpScheduled = false;
const meshTimes: number[] = [];

const nameOf = (semantic: number) => project?.semantics.nameOf(semantic) ?? "";
const materials = (states: CellStateTable) =>
  stateLooks(states, (project as Project).semantics).materials;
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
  const start = performance.now();
  const kind = sampleKind(command.source);
  const id = savedId(command.source);
  let framing: Framing;
  let next: Project;
  if (kind) {
    const built = buildSample(kind, command.chunkSize, themeAt(command.theme));
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
  session = new WorldSession(next.world);
  worldId = command.world;
  looksPosted = { states: -1, revision: -1 };
  shapes = [];
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
    case "deleteProject":
      if (command.id === saved) saved = null; // it stays on screen, no longer saved
      await store.delete(command.id);
      return null;
    case "importProject":
      return store.importBundle(command.bytes);
    case "exportProject":
      await flushAutosave();
      return store.exportBundle(command.id);
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
    case "setId": {
      const [x, y, z] = command.at;
      return edited(world().setId(x, y, z, command.id));
    }
    case "fillBox": {
      const [x0, y0, z0] = command.from;
      const [x1, y1, z1] = command.to;
      const count = world().fillBox(x0, y0, z0, x1, y1, z1, command.id);
      edited(count > 0);
      return count;
    }
    case "raycast": {
      const hit = raycast(world(), [...command.origin], [...command.dir], command.reach);
      if (!hit) return null;
      const semantic = nameOf(world().states.get(hit.id)?.semantic ?? 0);
      return { cell: hit.cell, normal: hit.normal, id: hit.id, semantic } satisfies RayHit;
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
    case "cell": {
      const state = world().get(...command.at);
      return state && project ? describeState(state, project.semantics) : null;
    }
    case "rayEdit": {
      const hit = raycast(world(), [...command.origin], [...command.dir], command.reach);
      if (!hit) return false;
      const [x, y, z] = hit.cell;
      if (command.action === "erase") return edited(world().setId(x, y, z, EMPTY_ID));
      const [nx, ny, nz] = hit.normal;
      if (nx === 0 && ny === 0 && nz === 0) return false; // the ray started inside a cell
      return edited(world().setId(x + nx, y + ny, z + nz, command.id));
    }
  }
}

/** Marks the project changed if an edit changed anything, and passes the result on. */
function edited(didChange: boolean): boolean {
  if (didChange) changed();
  return didChange;
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
    post({ type: "mesh", world: worldId, key, quads: none, quadCount: 0, tris: none, triCount: 0 });
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
  if (states.size === looksPosted.states && registry.revision === looksPosted.revision) return;
  const { colors } = stateLooks(states, registry);
  post({ type: "looks", world: worldId, colors }, [colors.buffer]);
  looksPosted = { states: states.size, revision: registry.revision };
}

function onMeshReply(port: MeshPort, reply: MeshReply): void {
  port.load--;
  const s = session;
  if (s && reply.world === worldId) {
    const { key, jobId, quads, quadCount, tris, triCount, lightBricks, ms } = reply.result;
    meshTimes.push(ms);
    if (meshTimes.length > 256) meshTimes.shift();
    post({ type: "mesh", world: worldId, key, quads, quadCount, tris, triCount }, [
      quads.buffer,
      tris.buffer,
    ]);
    s.finishJob(key, jobId, lightBricks);
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
