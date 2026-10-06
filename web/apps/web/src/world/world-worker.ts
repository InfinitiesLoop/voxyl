// The world worker: owns the World, the light engine and mesh scheduling (a WorldSession),
// so generating worlds, lighting them and preparing work never block the thread that draws.
// It hands mesh jobs to the mesh workers over MessagePorts and forwards their results to the
// main thread, together with light, in the order it produced them.

import { type CellStateTable, EMPTY_ID, type Project, raycast } from "@voxyl/core";
import type { StateShape } from "@voxyl/mesher";
import { type LightingMode, WorldSession } from "@voxyl/session";
import { lightMaterials, type Palette, paletteAt } from "../palettes.ts";
import { buildWorld } from "../worlds.ts";
import type {
  Command,
  FromWorld,
  MeshReply,
  MeshRequest,
  RayHit,
  Replies,
  ToWorld,
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

interface MeshPort {
  readonly port: MessagePort;
  load: number;
}

let session: WorldSession | null = null;
let project: Project | null = null;
let worldId = -1;
let mode: LightingMode = "off";
let palette: Palette = paletteAt(0);
let meshPorts: MeshPort[] = [];
let lastSeq = 0;
let idlePosted = -1;
let statesPosted = 0;
/** Every state's shape so far, for mesh workers (id - 1 -> shape). */
let shapes: StateShape[] = [];
let pumpScheduled = false;
const meshTimes: number[] = [];

const nameOf = (semantic: number) => project?.semantics.nameOf(semantic) ?? "";
const materials = (states: CellStateTable) => lightMaterials(palette, states, nameOf);
const post = (message: FromWorld, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

function world() {
  if (!session) throw new Error("no world loaded");
  return session.world;
}

function handle(command: Command): Replies[Command["type"]] {
  switch (command.type) {
    case "load": {
      const built = buildWorld(command.kind, command.chunkSize);
      project = built.project;
      session = new WorldSession(built.project.world);
      worldId = command.world;
      statesPosted = 0;
      shapes = [];
      idlePosted = -1;
      meshTimes.length = 0;
      if (mode !== "off") session.setLighting(mode, materials);
      return built.info;
    }
    case "lighting":
      mode = command.mode;
      session?.setLighting(mode, materials);
      return { lightAllMs: session?.stats().lightAllMs ?? null };
    case "palette":
      palette = command.palette;
      return { relit: session?.setMaterials(materials) ?? false };
    case "intern":
      return world().states.intern({ semantic: project?.semantics.ensure(command.semantic) ?? 0 });
    case "setId": {
      const [x, y, z] = command.at;
      return world().setId(x, y, z, command.id);
    }
    case "fillBox": {
      const [x0, y0, z0] = command.from;
      const [x1, y1, z1] = command.to;
      return world().fillBox(x0, y0, z0, x1, y1, z1, command.id);
    }
    case "raycast": {
      const hit = raycast(world(), [...command.origin], [...command.dir], command.reach);
      if (!hit) return null;
      const semantic = nameOf(world().states.get(hit.id)?.semantic ?? 0);
      return { cell: hit.cell, normal: hit.normal, id: hit.id, semantic } satisfies RayHit;
    }
    case "rayEdit": {
      const hit = raycast(world(), [...command.origin], [...command.dir], command.reach);
      if (!hit) return false;
      const [x, y, z] = hit.cell;
      if (command.action === "erase") return world().setId(x, y, z, EMPTY_ID);
      const [nx, ny, nz] = hit.normal;
      if (nx === 0 && ny === 0 && nz === 0) return false; // the ray started inside a cell
      return world().setId(x + nx, y + ny, z + nz, command.id);
    }
  }
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
  postStates(s);
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

/** Sends the semantic of every state id when new states have appeared (for the palette). */
function postStates(s: WorldSession): void {
  const states = s.world.states;
  if (states.size === statesPosted) return;
  const semantics = [""];
  for (let id = 1; id <= states.size; id++) semantics.push(nameOf(states.get(id)?.semantic ?? 0));
  post({ type: "states", world: worldId, semantics });
  statesPosted = states.size;
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
  const { seq } = message;
  try {
    post({ type: "reply", seq, value: handle(message) });
  } catch (error) {
    post({ type: "error", seq, message: error instanceof Error ? error.message : String(error) });
  }
  lastSeq = seq;
  pump();
});

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
