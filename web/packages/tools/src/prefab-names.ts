// Prefabs by name: tools never take ids, but a name can be shared, so an id (or content hash)
// is accepted as a last resort and named in the "ambiguous" error.

import { notFound } from "./names.ts";
import { type PrefabInfo, type PrefabsPort, ToolError, type ToolHost } from "./tool.ts";

export function prefabStore(host: ToolHost): PrefabsPort {
  if (!host.prefabs) throw new ToolError("unavailable", "This host has no prefab store.");
  return host.prefabs;
}

/** The prefab a name, id or hash means. */
export async function resolvePrefab(host: ToolHost, ref: string): Promise<PrefabInfo> {
  const all = await prefabStore(host).list();
  const wanted = ref.trim();
  const byId = all.find((p) => p.id === wanted || p.hash === wanted);
  if (byId) return byId;
  const exact = all.filter((p) => p.name === wanted);
  const found =
    exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (found.length === 1) return found[0] as PrefabInfo;
  if (found.length > 1) {
    throw new ToolError(
      "ambiguous",
      `${found.length} prefabs are named "${wanted}". Use an id: ${found.map((p) => p.id).join(", ")}.`,
      { ids: found.map((p) => p.id) },
    );
  }
  throw notFound(
    "prefab",
    ref,
    all.map((p) => p.name),
  );
}

/** A prefab as a small result entry. */
export function prefabSummary(p: PrefabInfo) {
  return {
    name: p.name,
    id: p.id,
    size: p.size,
    cells: p.cells,
    ...(p.tags.length > 0 && { tags: p.tags }),
    ...(p.notes !== undefined && { notes: p.notes }),
  };
}
