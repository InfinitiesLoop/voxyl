// A palette as an agent reads it: each semantic with the block it resolves to.

import {
  type PaletteId,
  PLACEMENTS,
  type Project,
  regionStats,
  type SemanticId,
} from "@voxyl/core";

/** Cells holding each semantic (a part counts once per cell it sits in), by id. */
export function usage(project: Project): Map<SemanticId, number> {
  const stats = regionStats(project);
  const out = new Map<SemanticId, number>();
  for (const b of stats.blocks) out.set(b.semantic, (out.get(b.semantic) ?? 0) + b.count);
  for (const p of stats.parts) out.set(p.semantic, (out.get(p.semantic) ?? 0) + p.count);
  return out;
}

/** One palette's entries: its own semantics, then the ones it could derive from ancestors. */
export function describePalette(project: Project, id: PaletteId, counts: Map<SemanticId, number>) {
  const registry = project.semantics;
  const palette = registry.palette(id);
  const look = (s: SemanticId) => {
    const r = registry.resolve(s);
    return {
      ...(r.form.shape !== undefined && { shape: r.form.shape }),
      ...(placementName(r.form.placement) !== undefined && {
        placement: placementName(r.form.placement),
      }),
      ...(r.look.block !== undefined && { block: r.look.block }),
      ...(r.look.glow !== undefined && { glow: r.look.glow }),
      ...(r.look.tint !== undefined && { tint: r.look.tint }),
      ...(r.description !== undefined && { description: r.description }),
    };
  };
  const entries = registry.offers(id).map((offer) => {
    if (offer.id !== undefined) {
      const own = registry.get(offer.id);
      const base = own.base;
      return {
        name: offer.name,
        ...look(offer.id),
        ...(base !== undefined && {
          derived_from: registry.palette(registry.get(base).palette).name,
        }),
        cells: counts.get(offer.id) ?? 0,
      };
    }
    const base = offer.base as SemanticId;
    return {
      name: offer.name,
      ...look(base),
      inherited_from: registry.palette(registry.get(base).palette).name,
      cells: 0,
    };
  });
  return {
    name: palette.name,
    ...(palette.description !== undefined && { description: palette.description }),
    ...(palette.extends !== undefined && { extends: registry.palette(palette.extends).name }),
    ...(palette.linked !== undefined && { linked: true }),
    semantics: entries,
  };
}

/** The name of a standard placement profile, when the semantic uses one. */
function placementName(profile: unknown): string | undefined {
  if (profile === undefined) return undefined;
  const text = JSON.stringify(profile);
  return Object.entries(PLACEMENTS).find(([, p]) => JSON.stringify(p) === text)?.[0];
}
