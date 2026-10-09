// Compares the final manifests of Godot and the web port per namespace: which blocks (by
// registry and meta) only one has, and which differ in faces, pane or attachment.
//   node tools/mc-import/final-diff.ts <godot.json> <web.json> [--ns a,b] [--list 15]   (from web/)

import { readFile } from "node:fs/promises";
import type { FinalBlock, FinalManifest } from "../../packages/mc-import/src/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const only = flag("--ns")?.split(",");
const max = Number(flag("--list") ?? 15);
const [godotPath, webPath] = args;
if (!godotPath || !webPath) {
  console.error("usage: node tools/mc-import/final-diff.ts <godot.json> <web.json> [--ns a,b]");
  process.exit(2);
}

const load = async (path: string): Promise<FinalManifest> =>
  JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, ""));
const godot = await load(godotPath);
const web = await load(webPath);

const key = (b: FinalBlock) => (b.registry ? `${b.registry}@${b.meta}` : `name:${b.name}`);
const faces = (b: FinalBlock) =>
  b.faces
    ? Object.entries(b.faces)
        .sort(([a], [c]) => (a < c ? -1 : 1))
        .map(([s, t]) => `${s}=${t}`)
        .join(" ")
    : "-";

let bad = 0;
for (const ns of [
  ...new Set([...Object.keys(godot.libraries), ...Object.keys(web.libraries)]),
].sort()) {
  if (only && !only.includes(ns)) continue;
  const g = new Map((godot.libraries[ns] ?? []).map((b) => [key(b), b]));
  const w = new Map((web.libraries[ns] ?? []).map((b) => [key(b), b]));
  if (g.size === 0 && w.size === 0) continue;
  const onlyG = [...g.keys()].filter((k) => !w.has(k));
  const onlyW = [...w.keys()].filter((k) => !g.has(k));
  const differ: string[] = [];
  const names: string[] = [];
  for (const [k, gb] of g) {
    const wb = w.get(k);
    if (!wb) continue;
    const a = `${faces(gb)} pane=${gb.pane} attach=${gb.attachment} id=${gb.legacy_id}`;
    const b = `${faces(wb)} pane=${wb.pane} attach=${wb.attachment} id=${wb.legacy_id}`;
    if (a !== b) differ.push(`${k}\n      godot ${a}\n      web   ${b}`);
    else if (gb.name !== wb.name) names.push(`${k}: "${gb.name}" vs "${wb.name}"`);
  }
  const ok = !onlyG.length && !onlyW.length && !differ.length;
  console.log(
    `${ok ? "ok " : "DIFF"} ${ns}: godot ${g.size}, web ${w.size}; only godot ${onlyG.length}, only web ${onlyW.length}, differ ${differ.length}, names ${names.length}`,
  );
  if (ok && !names.length) continue;
  bad += ok ? 0 : 1;
  for (const [label, list] of [
    ["only godot", onlyG],
    ["only web", onlyW],
    ["differ", differ],
    ["name", names],
  ] as const) {
    for (const line of list.slice(0, max)) console.log(`    ${label}: ${line}`);
    if (list.length > max) console.log(`    ${label}: ... ${list.length - max} more`);
  }
}
console.log(bad ? `${bad} namespaces differ` : "no differences");
