import { type Project, ROOT_PALETTE } from "@voxyl/core";
import { slotNames } from "@voxyl/shapes";
import { callTool, MemoryHost } from "../src/index.ts";

/** A project with a few semantics: Floor, Wall, Glass (blocks), Trim (strips), Roof (tiles). */
export function setup() {
  const host = MemoryHost.create({ chunkBits: 4 });
  const project = host.project as Project;
  const s = project.semantics;
  const floor = s.add("Floor", { look: { block: "minecraft:stone" } });
  const wall = s.add("Wall", { look: { block: "minecraft:bricks" } });
  s.add("Glass");
  s.add("Trim", { form: { shape: "edge1" } });
  s.add("Roof", { form: { shape: "roof_tile" } });
  const alt = s.addPalette("Alt", { extends: ROOT_PALETTE });
  s.add("Lamp", { palette: alt });
  return { host, project, floor, wall };
}

// Results are checked field by field in tests, so they are typed loosely here.
// biome-ignore lint/suspicious/noExplicitAny: loose test envelope
export type Reply = { ok: boolean; error: Record<string, any>; [key: string]: any };

/** Calls a tool and returns the envelope, loosely typed for assertions. */
export async function call(host: MemoryHost, name: string, args: unknown = {}) {
  return (await callTool(host, name, args)) as unknown as Reply;
}

export async function ok(host: MemoryHost, name: string, args: unknown = {}): Promise<Reply> {
  const r = await call(host, name, args);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r;
}

export const trimSlots = slotNames("edge1");

/** Cell count and a cheap fingerprint of the world, to prove a call changed nothing. */
export function fingerprint(project: Project): string {
  const cells: string[] = [];
  project.world.forEachCell((x, y, z, id) => cells.push(`${x},${y},${z}=${id}`));
  return `${project.history.length}|${project.world.cellCount}|${cells.sort().join(";")}|${project.semantics.size}`;
}
