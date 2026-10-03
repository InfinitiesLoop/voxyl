import { EMPTY_ID, raycast, type World } from "@voxyl/core";
import { mulberry32 } from "@voxyl/fixtures";
import * as THREE from "three/webgpu";
import { type Engine, percentile } from "../scene/Engine.ts";

export interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface BulkEdit {
  readonly label: string;
  readonly cells: number;
  /** Time to write the cells into the World. */
  readonly writeMs: number;
  /** Time from the start of the write until every affected chunk is remeshed and on screen. */
  readonly visibleMs: number;
}

export interface BenchResult {
  readonly when: string;
  readonly backend: string;
  readonly userAgent: string;
  readonly viewport: string;
  readonly world: string;
  readonly lighting: boolean;
  /** Time to light the whole world, with lighting on. */
  readonly lightAllMs: number | null;
  readonly lightMb: number;
  readonly cells: number;
  readonly chunkSize: number;
  readonly chunks: number;
  readonly quads: number;
  readonly workers: number;
  readonly generateMs: number;
  readonly initialMeshMs: number | null;
  readonly flight: {
    readonly seconds: number;
    readonly frameMs: Distribution;
    readonly cpuMs: Distribution;
  };
  readonly singleEdits: Distribution & { readonly misses: number };
  readonly bulk: readonly BulkEdit[];
}

const FLIGHT_SECONDS = 14;
const SINGLE_EDITS = 100;

/**
 * Scripted benchmark on the loaded world: a fixed flight (frame times), 100 single-cell
 * edits around the camera (edit-to-visible latency), then large box fills and clears above
 * the city (bulk remesh). Everything waits on real rendered frames.
 */
export async function runBench(
  engine: Engine,
  meta: { backend: string; world: string; lighting: boolean },
  progress: (step: string) => void,
): Promise<BenchResult> {
  const built = engine.built;
  const chunks = engine.chunks;
  if (!built || !chunks) throw new Error("No world loaded");
  const world = built.world;
  const [cx, , cz] = built.center;
  const e = Math.max(built.extent, 24);

  progress("Waiting for initial meshing");
  await chunks.whenIdle();

  // 1. Flight: an orbit, then a low pass through the streets.
  progress("Flying");
  const orbitSeconds = FLIGHT_SECONDS * 0.6;
  engine.setAutopilot((t) => {
    if (t < orbitSeconds) {
      const angle = (t / orbitSeconds) * Math.PI * 2;
      const r = e * 0.5;
      return {
        position: {
          x: cx + Math.cos(angle) * r,
          y: Math.max(40, e * 0.15),
          z: cz + Math.sin(angle) * r,
        },
        target: { x: cx, y: 10, z: cz },
      };
    }
    const k = Math.min(1, (t - orbitSeconds) / (FLIGHT_SECONDS - orbitSeconds));
    const x = cx - e * 0.45 + k * e * 0.9;
    return {
      position: { x, y: 28, z: cz + e * 0.07 },
      target: { x: x + 50, y: 22, z: cz + e * 0.07 },
    };
  });
  engine.startRecording();
  const flightStart = performance.now();
  while (performance.now() - flightStart < FLIGHT_SECONDS * 1000) await engine.nextFrame();
  const flight = engine.stopRecording();

  // 2. Single edits from a fixed viewpoint, alternating erase and place.
  progress("Single edits");
  engine.home();
  const home = {
    position: engine.fly.position.clone(),
    target: engine.fly.forward().add(engine.fly.position),
  };
  engine.setAutopilot(() => home);
  await engine.nextFrame();
  await chunks.whenIdle();
  const rand = mulberry32(42);
  const glow = world.states.intern({ semantic: "Glow" });
  const latencies: number[] = [];
  let misses = 0;
  const forward = engine.fly.forward();
  for (let i = 0; i < SINGLE_EDITS; i++) {
    const dir = forward
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), (rand() - 0.5) * 0.9)
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (rand() - 0.5) * 0.5);
    const p = engine.camera.position;
    const hit = raycast(world, [p.x, p.y, p.z], [dir.x, dir.y, dir.z], 2000);
    if (!hit) {
      misses++;
      continue;
    }
    const [x, y, z] = hit.cell;
    const [nx, ny, nz] = hit.normal;
    const start = performance.now();
    const changed =
      i % 2 === 0 ? world.setId(x, y, z, EMPTY_ID) : world.setId(x + nx, y + ny, z + nz, glow);
    if (!changed) {
      misses++;
      continue;
    }
    engine.afterEdit();
    await chunks.whenIdle();
    latencies.push(performance.now() - start);
  }

  const bulk: BulkEdit[] = [];
  const timeEdit = async (label: string, edit: () => number) => {
    progress(label);
    await engine.nextFrame();
    const start = performance.now();
    const cells = edit();
    const writeMs = performance.now() - start;
    engine.afterEdit();
    await chunks.whenIdle();
    bulk.push({ label, cells, writeMs, visibleMs: performance.now() - start });
  };

  // 3. A roof hole: open a 5x5 patch of a roof near the centre (sky light floods into the
  //    building, with lighting on) and close it again.
  const roof = findRoof(world, cx, cz, built.top);
  if (roof) {
    const [rx, ry, rz, id] = roof;
    await timeEdit("Roof hole open", () =>
      world.fillBox(rx - 2, ry, rz - 2, rx + 2, ry, rz + 2, EMPTY_ID),
    );
    await timeEdit("Roof hole close", () =>
      world.fillBox(rx - 2, ry, rz - 2, rx + 2, ry, rz + 2, id),
    );
  }

  // 4. Bulk fills and clears floating above the city.
  const y0 = built.top + 20;
  for (const [label, w, h, d] of [
    ["100k fill", 50, 40, 50],
    ["1M fill", 100, 100, 100],
  ] as const) {
    const x0 = Math.round(cx - w / 2);
    const z0 = Math.round(cz - d / 2);
    for (const clear of [false, true]) {
      await timeEdit(clear ? label.replace("fill", "clear") : label, () =>
        world.fillBox(x0, y0, z0, x0 + w - 1, y0 + h - 1, z0 + d - 1, clear ? EMPTY_ID : glow),
      );
    }
  }

  engine.setAutopilot(null);
  engine.home();
  const stats = engine.stats();
  progress("Done");
  return {
    when: new Date().toISOString(),
    backend: meta.backend,
    userAgent: navigator.userAgent,
    viewport: `${engine.renderer.domElement.width}x${engine.renderer.domElement.height}`,
    world: meta.world,
    lighting: meta.lighting,
    lightAllMs: stats.chunks?.lightAllMs ?? null,
    lightMb: stats.chunks?.lightMb ?? 0,
    cells: world.cellCount,
    chunkSize: world.layout.size,
    chunks: world.chunkCount,
    quads: stats.chunks?.quads ?? 0,
    workers: stats.chunks?.workers ?? 0,
    generateMs: built.generateMs,
    initialMeshMs: stats.initialMeshMs,
    flight: {
      seconds: FLIGHT_SECONDS,
      frameMs: distribution(flight.frameMs),
      cpuMs: distribution(flight.cpuMs),
    },
    singleEdits: { ...distribution(latencies), misses },
    bulk,
  };
}

/** The highest Roof cell near the centre, found by looking straight down: [x, y, z, id]. */
function findRoof(
  world: World,
  cx: number,
  cz: number,
  top: number,
): [number, number, number, number] | null {
  for (let r = 0; r <= 64; r += 4) {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ] as const) {
      const x = Math.round(cx + dx);
      const z = Math.round(cz + dz);
      const hit = raycast(world, [x + 0.5, top + 5, z + 0.5], [0, -1, 0], top + 10);
      if (hit && world.states.get(hit.id)?.semantic === "Roof") {
        return [hit.cell[0], hit.cell[1], hit.cell[2], hit.id];
      }
    }
  }
  return null;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}
