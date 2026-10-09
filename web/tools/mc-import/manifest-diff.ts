// Compares two roster manifests (Godot's and the web port's) per mod.
//   node tools/mc-import/manifest-diff.ts <godot.json> <web.json> [maxListed=15]   (from web/)

import { readFile } from "node:fs/promises";
import type { NeiManifest } from "../../packages/mc-import/src/index.ts";

const [godotPath, webPath, limit = "15"] = process.argv.slice(2);
if (!godotPath || !webPath) {
  console.error("usage: node tools/mc-import/manifest-diff.ts <godot.json> <web.json> [maxListed]");
  process.exit(2);
}
const max = Number(limit);

type Mod = NeiManifest["mods"][string];
type Imported = Mod["imported"][number];

const load = async (path: string): Promise<NeiManifest> =>
  JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, ""));
const key = (e: { registry: string; meta: number }) => `${e.registry}@${e.meta}`;
const faceString = (e: Imported) =>
  Object.entries(e.faces)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([s, t]) => `${s}=${t}`)
    .join(" ");

const godot = await load(godotPath);
const web = await load(webPath);

const totals = { onlyGodot: 0, onlyWeb: 0, faces: 0, names: 0, same: 0 };
const lists: Record<string, string[]> = { onlyGodot: [], onlyWeb: [], faces: [], names: [] };
const rows: string[] = [];

for (const mod of [...new Set([...Object.keys(godot.mods), ...Object.keys(web.mods)])].sort()) {
  const g = godot.mods[mod];
  const w = web.mods[mod];
  const gi = new Map((g?.imported ?? []).map((e) => [key(e), e]));
  const wi = new Map((w?.imported ?? []).map((e) => [key(e), e]));
  const wd = new Set((w?.dropped ?? []).map(key));
  const gd = new Set((g?.dropped ?? []).map(key));
  let onlyGodot = 0;
  let onlyWeb = 0;
  let faces = 0;
  let names = 0;
  for (const [k, e] of gi) {
    const o = wi.get(k);
    if (!o) {
      onlyGodot++;
      lists.onlyGodot?.push(
        `${mod}  ${k}  ${faceString(e)}  (web: ${wd.has(k) ? "dropped" : "absent"})`,
      );
    } else if (faceString(e) !== faceString(o)) {
      faces++;
      lists.faces?.push(`${mod}  ${k}\n      godot ${faceString(e)}\n      web   ${faceString(o)}`);
    } else {
      totals.same++;
      if (e.name !== o.name) {
        names++;
        lists.names?.push(`${mod}  ${k}  godot "${e.name}"  web "${o.name}"`);
      }
    }
  }
  for (const [k, e] of wi) {
    if (!gi.has(k)) {
      onlyWeb++;
      lists.onlyWeb?.push(
        `${mod}  ${k}  ${faceString(e)}  (godot: ${gd.has(k) ? "dropped" : "absent"})`,
      );
    }
  }
  totals.onlyGodot += onlyGodot;
  totals.onlyWeb += onlyWeb;
  totals.faces += faces;
  totals.names += names;
  const flag = onlyGodot || onlyWeb || faces || names || g?.ns !== w?.ns;
  rows.push(
    `${flag ? "!" : " "} ${mod.padEnd(28)} imported ${String(g?.imported.length ?? "-").padStart(5)} / ${String(
      w?.imported.length ?? "-",
    ).padStart(5)}   dropped ${String(g?.dropped.length ?? "-").padStart(5)} / ${String(
      w?.dropped.length ?? "-",
    ).padStart(5)}   only-godot ${onlyGodot}  only-web ${onlyWeb}  faces ${faces}  names ${names}` +
      (g && w && g.ns !== w.ns ? `  ns ${g.ns} / ${w.ns}` : ""),
  );
}

console.log("mod                           (godot / web)");
console.log(rows.join("\n"));
console.log(
  `\nidentical faces: ${totals.same}   only in godot: ${totals.onlyGodot}   only in web: ${totals.onlyWeb}   ` +
    `different faces: ${totals.faces}   different names (same faces): ${totals.names}`,
);
for (const [name, list] of Object.entries(lists)) {
  if (list.length === 0) continue;
  console.log(`\n${name} (${list.length}, first ${Math.min(max, list.length)}):`);
  for (const line of list.slice(0, max)) console.log(`  ${line}`);
}
