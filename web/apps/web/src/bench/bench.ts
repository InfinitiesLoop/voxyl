import { EMPTY_ID } from "@voxyl/core";
import { mulberry32 } from "@voxyl/fixtures";
import type { LightingMode } from "@voxyl/session";
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
  /** Time until the world worker reports the cells written. */
  readonly writeMs: number;
  /** Time from sending the edit until every affected chunk is remeshed, lit and on screen. */
  readonly visibleMs: number;
}

export interface BenchResult {
  readonly when: string;
  readonly backend: string;
  readonly userAgent: string;
  readonly viewport: string;
  readonly world: string;
  readonly lighting: LightingMode;
  /** Time to light the whole world, with lighting on (in the world worker). */
  readonly lightAllMs: number | null;
  /** Light engine memory (world worker). */
  readonly lightMb: number;
  /** Light volume memory (GPU), with volume lighting. */
  readonly lightGpuMb: number;
  readonly cells: number;
  readonly chunkSize: number;
  readonly chunks: number;
  readonly quads: number;
  readonly quadMb: number;
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
 * the city (bulk remesh and relight). Edits go through the world worker as the user's do,
 * and everything waits on real rendered frames.
 */
export async function runBench(
  engine: Engine,
  meta: { backend: string; world: string; lighting: LightingMode },
  progress: (step: string) => void,
): Promise<BenchResult> {
  const info = engine.info;
  if (!info) throw new Error("No world loaded");
  const world = engine.world;
  const [cx, , cz] = info.center;
  const e = Math.max(info.extent, 24);

  progress("Waiting for initial meshing");
  await engine.whenIdle();

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
  await engine.whenIdle();
  const rand = mulberry32(42);
  const glow = await world.request({ type: "intern", state: { semantic: "Glow" } });
  const latencies: number[] = [];
  let misses = 0;
  const forward = engine.fly.forward();
  const p = engine.camera.position;
  for (let i = 0; i < SINGLE_EDITS; i++) {
    const dir = forward
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), (rand() - 0.5) * 0.9)
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (rand() - 0.5) * 0.5);
    const start = performance.now();
    const changed = await world.request({
      type: "rayEdit",
      origin: [p.x, p.y, p.z],
      dir: [dir.x, dir.y, dir.z],
      reach: 2000,
      action: i % 2 === 0 ? "erase" : "place",
      id: glow,
    });
    if (!changed) {
      misses++;
      continue;
    }
    await engine.whenIdle();
    latencies.push(performance.now() - start);
  }

  const bulk: BulkEdit[] = [];
  const timeEdit = async (label: string, edit: () => Promise<number>) => {
    progress(label);
    await engine.nextFrame();
    const start = performance.now();
    const cells = await edit();
    const writeMs = performance.now() - start;
    await engine.whenIdle();
    bulk.push({ label, cells, writeMs, visibleMs: performance.now() - start });
  };

  // 3. A roof hole: open a 5x5 patch of a roof near the centre (sky light floods into the
  //    building, with lighting on) and close it again.
  const roof = await findRoof(engine, cx, cz, info.top);
  if (roof) {
    const [rx, ry, rz, id] = roof;
    for (const [label, fill] of [
      ["Roof hole open", EMPTY_ID],
      ["Roof hole close", id],
    ] as const) {
      await timeEdit(label, () =>
        world.request({
          type: "fillBox",
          from: [rx - 2, ry, rz - 2],
          to: [rx + 2, ry, rz + 2],
          id: fill,
        }),
      );
    }
  }

  // 4. Bulk fills and clears floating above the city.
  const y0 = info.top + 20;
  for (const [label, w, h, d] of [
    ["100k fill", 50, 40, 50],
    ["1M fill", 100, 100, 100],
  ] as const) {
    const x0 = Math.round(cx - w / 2);
    const z0 = Math.round(cz - d / 2);
    for (const clear of [false, true]) {
      await timeEdit(clear ? label.replace("fill", "clear") : label, () =>
        world.request({
          type: "fillBox",
          from: [x0, y0, z0],
          to: [x0 + w - 1, y0 + h - 1, z0 + d - 1],
          id: clear ? EMPTY_ID : glow,
        }),
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
    lightAllMs: stats.world?.lightAllMs ?? null,
    lightMb: stats.world?.lightMb ?? 0,
    lightGpuMb: stats.chunks?.lightGpuMb ?? 0,
    cells: stats.world?.cells ?? 0,
    chunkSize: info.chunkSize,
    chunks: stats.world?.chunkCount ?? 0,
    quads: stats.chunks?.quads ?? 0,
    quadMb: stats.quadMb,
    workers: stats.meshWorkers,
    generateMs: info.generateMs,
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
async function findRoof(
  engine: Engine,
  cx: number,
  cz: number,
  top: number,
): Promise<[number, number, number, number] | null> {
  for (let r = 0; r <= 64; r += 4) {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ] as const) {
      const x = Math.round(cx + dx);
      const z = Math.round(cz + dz);
      const hit = await engine.world.request({
        type: "raycast",
        origin: [x + 0.5, top + 5, z + 0.5],
        dir: [0, -1, 0],
        reach: top + 10,
      });
      if (hit?.semantic === "Roof") return [hit.cell[0], hit.cell[1], hit.cell[2], hit.id];
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
