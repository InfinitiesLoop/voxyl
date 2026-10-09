// Imports a real GTNH instance (roster, then the healers) and writes the final manifest, in the
// shape the Godot parity script writes, for `final-diff.ts`.
//   node tools/mc-import/final-manifest.ts <gameDir> <vanillaJar> <outFile>   (from web/)

import { writeFile } from "node:fs/promises";
import { finalManifest } from "../../packages/mc-import/src/index.ts";
import { importGtnh } from "./gtnh-roster.ts";

const [gameDir, vanillaJar, outFile] = process.argv.slice(2);
if (!gameDir || !vanillaJar || !outFile) {
  console.error("usage: node tools/mc-import/final-manifest.ts <gameDir> <vanillaJar> <outFile>");
  process.exit(2);
}

const run = await importGtnh(gameDir, vanillaJar, { heal: true });
await writeFile(outFile, JSON.stringify(finalManifest(run.drafts)));
const blocks = [...run.drafts.values()].reduce((n, d) => n + Object.keys(d.blocks).length, 0);
console.log(
  `${blocks} blocks in ${run.drafts.size} libraries; roster ${Math.round(run.importMs)} ms, ` +
    `heal ${Math.round(run.healMs ?? 0)} ms (${run.healed?.length ?? 0} namespaces), ` +
    `rss ${run.rssMb} MB -> ${outFile}`,
);
