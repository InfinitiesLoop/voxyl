// Writes the manifest of a roster import over a real instance, for comparing with Godot's.
//   node tools/mc-import/roster-manifest.ts <gameDir> <vanillaJar> <outFile>   (from web/)

import { writeFile } from "node:fs/promises";
import { neiManifest } from "../../packages/mc-import/src/index.ts";
import { importGtnh } from "./gtnh-roster.ts";

const [gameDir, vanillaJar, outFile] = process.argv.slice(2);
if (!gameDir || !vanillaJar || !outFile) {
  console.error("usage: node tools/mc-import/roster-manifest.ts <gameDir> <vanillaJar> <outFile>");
  process.exit(2);
}

const run = await importGtnh(gameDir, vanillaJar);
const manifest = neiManifest(run.result, run.drafts.values());
await writeFile(outFile, JSON.stringify(manifest));
console.log(
  `${run.result.imported.length} imported, ${run.result.dropped.length} dropped, ` +
    `${run.jars} jars opened in ${Math.round(run.openMs)} ms, imported in ${Math.round(run.importMs)} ms, ` +
    `rss ${run.rssMb} MB -> ${outFile}`,
);
