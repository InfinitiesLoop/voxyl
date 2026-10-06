// Copy, move, transform and paste on the city (web-core.md step 6): timings, and how big a
// piece (the clipboard's cells, carried inline by a paste command) is as JSON and deflated.
// Run from web/: node packages/fixtures/bench/placement.ts [cells] [--parts]

import { deflateRawSync } from "node:zlib";
import { type Command, cutPiece, Project, pieceCellCount } from "@voxyl/core";
import { generateCity } from "../src/index.ts";

const target = Number(process.argv[2] ?? 1_000_000);
const parts = process.argv.includes("--parts");
let n = 0;
const cmd = (kind: string, args: unknown): Command => ({ id: `b${n++}`, kind, args });

function time<T>(label: string, run: () => T): T {
  const start = performance.now();
  const out = run();
  console.log(`${label}: ${(performance.now() - start).toFixed(0)} ms`);
  return out;
}

const project = new Project({ chunkBits: 6 });
generateCity(project, { targetCells: target, seed: 1, parts });
console.log(`city: ${project.world.cellCount} cells${parts ? ", shaped" : ""}`);

for (const size of [16, 64, 128]) {
  const box = [0, 0, 0, size - 1, 63, size - 1] as const;
  const piece = time(`cut ${size}x64x${size}`, () =>
    cutPiece(
      { world: project.world, semantics: project.semantics, id: project.id, north: "north" },
      project.cells({ box: [...box] }),
    ),
  );
  if (!piece) continue;
  const json = JSON.stringify(cmd("paste", { piece, at: [0, 0, 0] }));
  const zipped = deflateRawSync(json);
  console.log(
    `  ${pieceCellCount(piece)} cells: paste command ${(json.length / 1024).toFixed(1)} KB JSON, ` +
      `${(zipped.length / 1024).toFixed(1)} KB deflated`,
  );
  const r = time("  paste turned into the same project", () =>
    project.run(cmd("paste", { piece, at: [2000, 0, 0], turn: 1 })),
  );
  console.log(`  changed ${r.report.cells} cells`);
}

const big = [0, 0, 0, 255, 63, 255] as const;
time("copy 256x64x256 with a turn", () =>
  project.run(cmd("copy", { where: { box: [...big] }, to: [0, 0, 600], turn: 1 })),
);
time("move it with a mirror", () =>
  project.run(
    cmd("move", { where: { box: [0, 0, 600, 255, 63, 855] }, to: [0, 0, 900], mirror: "x" }),
  ),
);
time("transform it in place", () =>
  project.run(cmd("transform", { where: { box: [0, 0, 900, 255, 63, 1155] }, turn: 2 })),
);
time("undo", () => project.run(cmd("undo", { target: project.undoTarget() })));
