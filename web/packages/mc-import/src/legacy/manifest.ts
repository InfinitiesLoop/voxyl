// A stable, diffable listing of what a roster import did, per mod: each imported entry with the
// texture key on each of its sides, and each dropped one. The Godot importer writes the same
// shape, so checking the port against it is a plain diff.

import { MC_SIDES, type McSide } from "@voxyl/blocks";
import type { LibraryDraft } from "./draft.ts";
import type { RosterResult } from "./roster.ts";

export interface NeiManifest {
  readonly mods: Readonly<
    Record<
      string,
      {
        /** The registry namespace of the mod's first entry. */
        readonly ns: string;
        readonly imported: readonly {
          readonly registry: string;
          readonly meta: number;
          readonly display: string;
          readonly name: string;
          /** Side -> texture key, only the sides the block draws. */
          readonly faces: Readonly<Partial<Record<McSide, string>>>;
        }[];
        readonly dropped: readonly {
          readonly registry: string;
          readonly meta: number;
          readonly display: string;
        }[];
      }
    >
  >;
}

const byIdentity = (
  a: { registry: string; meta: number },
  b: { registry: string; meta: number },
) => (a.registry < b.registry ? -1 : a.registry > b.registry ? 1 : a.meta - b.meta);

/** The manifest of `result`; `drafts` are the libraries it imported into (to read faces from). */
export function neiManifest(result: RosterResult, drafts: Iterable<LibraryDraft>): NeiManifest {
  const byId = new Map<string, LibraryDraft>();
  for (const d of drafts) byId.set(d.id, d);

  const mods: Record<
    string,
    {
      ns: string;
      imported: NeiManifest["mods"][string]["imported"][number][];
      dropped: NeiManifest["mods"][string]["dropped"][number][];
    }
  > = {};
  const entry = (mod: string, ns: string) => {
    let m = mods[mod];
    if (!m) mods[mod] = m = { ns, imported: [], dropped: [] };
    return m;
  };

  for (const e of result.imported) {
    const draft = byId.get(e.library);
    const modelKey = draft?.block(e.name)?.variants?.[""]?.model;
    const element = modelKey === undefined ? undefined : draft?.models[modelKey]?.elements[0];
    const faces: Partial<Record<McSide, string>> = {};
    for (const side of MC_SIDES) {
      const face = element?.faces[side];
      if (face) faces[side] = face.texture;
    }
    entry(e.mod, e.ns).imported.push({
      registry: e.registry,
      meta: e.meta,
      display: e.display,
      name: e.name,
      faces,
    });
  }
  for (const d of result.dropped)
    entry(d.mod, d.ns).dropped.push({ registry: d.registry, meta: d.meta, display: d.display });

  const sorted: typeof mods = {};
  for (const mod of Object.keys(mods).sort()) {
    const m = mods[mod];
    if (!m) continue;
    m.imported.sort(byIdentity);
    m.dropped.sort(byIdentity);
    sorted[mod] = m;
  }
  return { mods: sorted };
}
