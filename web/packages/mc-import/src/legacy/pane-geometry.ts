// The multipart geometry every connecting "pane" block needs: a thin centre post plus four side
// arms/caps that extend to meet an occupied neighbour, or cap off flush when isolated. This is
// Minecraft's own pane shape (post/side/side_alt/noside/noside_alt), textured with a "glass"-role
// side texture and a "glass_pane_top"-role edge texture. Vanilla panes get this for free through
// the importer's real blockstate/model JSON; this is the same shape synthesized by hand for a
// source with no blockstate JSON to import it from at all (Chisel, 1.7.10), so a heal with only
// two flat textures can still produce real pane geometry instead of a full cube.
//
// Boxes and UV rects are lifted verbatim from an imported vanilla pane
// (minecraft:block/glass_pane_{post,side,side_alt,noside,noside_alt}), in sixteenths. The Godot
// importer's PaneGeometry.gd held the same numbers in 0..1 cell space, so a healed pane connects
// and caps exactly like the vanilla one does.

import type { Block, Element, Face, McSide, Model } from "@voxyl/blocks";

// The post/arm band: 7/16 .. 9/16 of the cell, 2/16 wide.
const MIN = 7;
const MAX = 9;

type Uv = readonly [number, number, number, number];

/** A face; `uv` is [u1, v1, u2, v2] in sixteenths, u2 < u1 meaning the texture runs mirrored. */
const face = (texture: string, uv: Uv, cullface?: McSide): Face => ({
  texture,
  uv,
  ...(cullface && { cullface }),
});

const box = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  faces: Element["faces"],
): Model => ({ elements: [{ from, to, faces }] });

export interface PaneModels {
  /** The five models, keyed `${baseKey}/post`, `/side`, `/side_alt`, `/noside`, `/noside_alt`. */
  readonly models: Record<string, Model>;
  /** The blockstate wiring: the post always, an arm per connected side, a cap per free one. */
  readonly block: Pick<Block, "multipart">;
}

/**
 * The models and multipart wiring of one connecting pane. `sideTexture` is a library texture key
 * for the flat visible faces (Minecraft's "glass" role), `edgeTexture` for the thin rim of the
 * post and arms (its "glass_pane_top" role); pass the same key for both when the source has one.
 * Connection reads the vanilla way: the properties north/east/south/west are "true" where a
 * neighbour is reached for, and anything else (or unset) caps that side.
 */
export function paneModels(baseKey: string, sideTexture: string, edgeTexture: string): PaneModels {
  const side = sideTexture;
  const edge = edgeTexture;
  const key = (name: string) => `${baseKey}/${name}`;

  const parts: Record<string, Model> = {
    post: box([MIN, 0, MIN], [MAX, 16, MAX], {
      up: face(edge, [MIN, MIN, MAX, MAX]),
      down: face(edge, [MIN, MIN, MAX, MAX]),
    }),
    // The north-pointing arm; turned y=90 for east (the wiring below), and `side_alt` for the
    // opposite pair.
    side: box([MIN, 0, 0], [MAX, 16, MIN], {
      north: face(edge, [MIN, 0, MAX, 16], "north"),
      east: face(side, [MAX, 0, 16, 16]),
      west: face(side, [16, 0, MAX, 16]),
      up: face(edge, [MIN, 0, MAX, MIN]),
      down: face(edge, [MIN, 0, MAX, MIN]),
    }),
    // The south-pointing arm: a mirror of `side`, not `side` turned 180, so the glass texture
    // reads the right way round on both opposite arms (see the east/west uv direction).
    side_alt: box([MIN, 0, MAX], [MAX, 16, 16], {
      east: face(side, [0, 0, MIN, 16]),
      south: face(edge, [MIN, 0, MAX, 16], "south"),
      west: face(side, [MIN, 0, 0, 16]),
      up: face(edge, [MIN, 0, MAX, MIN]),
      down: face(edge, [MIN, 0, MAX, MIN]),
    }),
    // The north-facing end cap, shown instead of an arm when there is no neighbour to reach
    // for. noside_alt is the same tiny box with its cap on the east face; together, turned per
    // direction, they cap all four sides. Textured with the side texture, not the edge one:
    // Minecraft caps a disconnected side with the plain glass look, the rim is only for the
    // post and arm tops.
    noside: box([MIN, 0, MIN], [MAX, 16, MAX], {
      north: face(side, [MAX, 0, MIN, 16]),
    }),
    noside_alt: box([MIN, 0, MIN], [MAX, 16, MAX], {
      east: face(side, [MIN, 0, MAX, 16]),
    }),
  };

  const models: Record<string, Model> = {};
  for (const [name, model] of Object.entries(parts)) models[key(name)] = model;

  // Identical in shape to a vanilla pane blockstate's multipart (1.13+): arms on "true", caps on
  // "false". The y turns are the Godot wiring's, which is vanilla's.
  const multipart: NonNullable<Block["multipart"]> = [
    { apply: { model: key("post") } },
    { when: { north: "true" }, apply: { model: key("side") } },
    { when: { east: "true" }, apply: { model: key("side"), y: 90 } },
    { when: { south: "true" }, apply: { model: key("side_alt") } },
    { when: { west: "true" }, apply: { model: key("side_alt"), y: 90 } },
    { when: { north: "false" }, apply: { model: key("noside") } },
    { when: { east: "false" }, apply: { model: key("noside_alt") } },
    { when: { south: "false" }, apply: { model: key("noside_alt"), y: 90 } },
    { when: { west: "false" }, apply: { model: key("noside"), y: 270 } },
  ];
  return { models, block: { multipart } };
}
