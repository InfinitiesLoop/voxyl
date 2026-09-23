# Shaped Parts — Microblocks & Architecture Shapes

Status: **Parts 1 and 3 implemented, awaiting UX feedback** (microblocks; architecture
shapes). Parts 2, 4, 5 not started.

Where Part 1 lives: `scripts/core/ShapeCatalog.gd` (shapes, slots, grids), `ShapeRules.gd`
(sharing rules), `ShapePlacement.gd` (click → part), `ShapeModels.gd` (generated textured
geometry); `VoxelWorld` (`_resolve_semantic` reports a shaped entry's shape,
`add_part`/`remove_part`/`can_add_part`, `icon_block_type_for_shape`); `View3D` (part
raycast, grid overlay, ghost, place/erase/pick); `View2DGrid._draw_part_footprints`;
`NewPaletteEntryDialog` (Block / Shape kinds), `ShapeGlyph` (drawn shape art), inventory +
Home palette editor + hotbar icons. Tests: `_test_shape_catalog`, `_test_shape_rules`,
`_test_shaped_parts` in `tests/SmokeTest.gd`.

## Goal

Let a build use sub-block shapes the way GTNH players actually build: Forge Microblocks
(covers, panels, slabs, hollow covers, strips, posts, pillars, nooks, corners, notches —
several per block, even of different materials) and ArchitectureCraft shapes (roofs,
slopes, cylinders, windows, arches… — one per block, in any of 24 orientations, e.g.
sideways stairs). One unified shape set. Later, Schematica export has to map each part
back to an FMP or AC part in-game, so Voxyl must block any combination the mods can't
represent.

Reference source (read while designing — worth re-reading when porting behavior):
- FMP: `github.com/GTNewHorizons/ForgeMultipart` — `microblock/MicroblockPlacement.scala`,
  `PlacementGrids.scala`, `TMicroOcclusion.scala`, `FaceMicroblock.scala`,
  `EdgeMicroblock.scala` (incl. `PostMicroClass`), `CornerMicroblock.scala`,
  `HollowMicroblock.scala`, `multipart/PartMap.java`, `TPartialOcclusion.scala`,
  `scalatraits/TSlottedTile.scala`, `TNormalOcclusion.scala`. (LGPL — port behavior, don't
  copy code.)
- AC: `github.com/GTNewHorizons/ArchitectureCraft` — `common/shape/Shape.java` (the
  shape table + `orientFromHitPosition`), `ShapeKind.java` (neighbor-matching
  placement), `common/tile/TileShape.java` (NBT), `resources/.../models/shape/*.objson`
  (triangle meshes, MIT).

## Decisions

1. **A shape is picked on the palette entry, next to its block type.** An entry maps a
   semantic to a block type (as always) and optionally a shape; with a shape it places
   that shape cut from its block instead of the whole block. "Trim Strip", "Roof Tile",
   "Stone Pillar" are real semantics: intent, described geometrically. Quick UX: make the
   entry once (Block / Shape tabs in the entry dialog), put it on the hotbar, place it
   many times.
2. **Shaped entries use their own block type.** (Part 1 first shipped with shapes cut
   from *another* entry — a "base" — but picking block + shape on the one entry is more
   natural; the user asked for it and chaining may come back later. Old palettes migrate
   on load: `Palette.migrate_legacy_shapes` copies the base's block into the entry.)
3. **Each placed part stores its own shape.** A part is `{semantic, shape, slot}`.
   Voxel data stays readable on its own: a palette edit, swap, stack change or removed
   palette can re-skin a build but never change its structure (Principles 2 & 3 —
   palettes are shared across projects, so this matters). Consequences:
   - Change a shaped entry's **block type** → every placed use re-skins immediately.
   - Change a shaped entry's **shape** → only future placements; placed parts keep
     theirs. (A "convert placed parts" dialog is deferred — Part 4.)
4. **Block anything the mods couldn't build.** Validity is a pure function of the cell's
   own data — FMP's "same material" test uses *same semantic* as a conservative stand-in
   — so a palette change can never make a valid cell invalid.
5. **Neutral core, Minecraft at the edges.** Shape ids/names are plain geometry words;
   the FMP/AC id mapping lives in a future export extension (like `mcimport/`), never in
   core.

## Data model

```
PaletteEntry
  semantic_name    String
  block_type_name  String   # the material ("" = undecided)
  shape_id         String   # "" → places the whole block; else a ShapeCatalog id
  base_name        String   # legacy only (see decision 2); cleared on load

BlockCell
  type_id, orientation, tags   # a native block (today's cell) — unchanged
  parts: Array                 # shaped parts; [] for a native block
                               # each: { semantic: String, shape: String, slot: int }
```

- A cell holds **either** one native block **or** a list of shaped parts. Native blocks
  are exclusive (FMP can't share a space with a vanilla block).
- For a part cell, `type_id` mirrors `parts[0].semantic` so every "is this occupied /
  what's here" caller (`get_block`, raycasts, connections, fill, stats) keeps working.
- `slot` is a placement index whose meaning comes from the shape's placement scheme
  (below). It's never a material.
- Persistence: `VoxelData.pack()` keeps the packed arrays for native cells and adds a
  sparse side channel (`_packed_part_indices` + `_packed_parts`, like tags). Old projects
  load unchanged. Undo history cell tuples gain a 4th element (parts); 3-element tuples
  still decode.

### Placement schemes (slot numbering)

Microblock slots use FMP's numbering so porting and export are 1:1:
- **Face** (cover/panel/slab, hollow): slot = side. Sides: 0 −Y, 1 +Y, 2 −Z (north),
  3 +Z (south), 4 −X (west), 5 +X (east). `side >> 1` = axis (0 Y, 1 Z, 2 X), `side & 1`
  = positive.
- **Corner** (nook/corner/notch): slot 0–7, bits: 1 = +Y, 2 = +Z, 4 = +X.
- **Edge** (strip/post/pillar): slot 0–11. 0–3 run along Y (bit0 +Z, bit1 +X), 4–7
  along Z (bit0 +X, bit1 +Y), 8–11 along X (bit0 +Y, bit1 +Z).
- **Centered** (even-size edges only — FMP's `PostMicroblock`): slot 12 + axis
  (12 Y, 13 Z, 14 X). The same "Post"/"Pillar" entry places on an edge or centered,
  depending on where you click, exactly like the mod.
- **Rotation** (AC shapes, Part 3): slot = side × 4 + turn (all 24 cube rotations).

### Shape catalog (Part 1)

| id | name | family | size (1/8) | slots |
|---|---|---|---|---|
| face1 / face2 / face4 | Cover / Panel / Slab | face | 1 / 2 / 4 | 6 |
| hollow1 / hollow2 / hollow4 | Hollow Cover / Panel / Slab | hollow | 1 / 2 / 4 | 6 |
| edge1 | Strip | edge | 1 | 12 |
| edge2 / edge4 | Post / Pillar | edge | 2 / 4 | 12 + 3 centered |
| corner1 / corner2 / corner4 | Nook / Corner / Notch | corner | 1 / 2 / 4 | 8 |

Geometry is generated boxes. Hollow = face slab with a centered ½-block hole.

## Validation (ShapeRules — port of FMP's occlusion)

Adding part N to a cell is allowed iff:
1. The cell is empty or already a part cell (never a native block).
2. **Slots:** no existing part of a slotted family (face/hollow/edge/corner) has N's slot
   (face and hollow share the 6 face slots). Centered posts aren't slotted.
3. **Micro test** (face/hollow/edge/corner pairs, sizes summing > 8): opposite faces
   conflict; with different semantics, corners differing on two axes conflict, an edge
   and a corner off that edge conflict, and same-axis diagonal edges conflict.
4. **Normal occlusion** (centered posts and hollow covers have hard boxes): their boxes
   may not intersect another part's boxes — except two posts on different axes, and a
   post with a face on its own axis (FMP's exceptions). Hollow covers' hard boxes
   exclude the hole, so a Post/Pillar can pass through them.
5. **Partial occlusion** on the 8×8×8 grid: every part (except hollow covers) must
   keep at least one sub-voxel no other part covers.

Rendering overlap (a strip lying inside a cover) is fine — FMP shrinks one visually; we
just draw both.

## Rendering & materials

- A part renders as a generated `BlockModel` (the shape's boxes at its slot) textured
  with the entry's block's full-cube face textures, **projected by position** — a strip
  shows the matching slice of the texture and lines up with neighbors (what FMP and AC
  do). Generated models are addressable by id (`shape:<shape>:<slot>:<base model id>`)
  so the 3D view, previews and icon baker all reuse their normal model paths and caches.
- Overlapping microblocks are trimmed at render time (FMP's "shrink rendering",
  `ShapeRules.render_boxes`): the lower-priority part stops where the other begins, so no
  two faces share a plane (no z-fighting). Strips yield to corners, corners to faces, the
  thinner face to the thicker, then the lower slot; posts are capped by end faces and split
  around crossing posts. Rules, aiming and 2D footprints still use the full boxes.
- An undecided block → the planning color, like any undecided block.
- Icons: a shaped entry's icon is its shape in its block's material (a synthetic block
  type for the icon baker), shown in the inventory grid and hotbar.

## Placement (3D)

Ported from FMP (`MicroblockPlacement` + `PlacementGrids`):
- Raycasts hit individual part boxes, not just whole cells, and know the exact hit point.
- The face you aim at shows the family's placement grid (face: center square + 4
  trapezoids; corner: quadrants; edge: 3×3). The zone under the crosshair picks the slot.
- Clicking a full block places into the neighbor cell. Clicking the inner face of a thin
  part places into that same cell when it fits (FMP's "internal" placement).
- **Ctrl** places on the opposite side (FMP's control modifier).
- Edge families: the center zone places a centered Post/Pillar along the face's axis.
- A translucent ghost shows exactly what will be placed; an invalid spot shows nothing.
- Left-click erases just the targeted part; middle-click picks the targeted part's entry.

## Parts (iterations)

**Part 1 — Microblocks end-to-end** (first UX checkpoint)
- Shaped palette entries: entry dialog gets Block / Shape tabs; shape picker beside the
  block chooser.
- Shape catalog + ShapeRules + part data (persistence, undo, copy/paste verbatim).
- 3D: part rendering with projected textures, part raycast, FMP placement + grid overlay
  + ghost, erase/pick single part.
- Inventory + hotbar icons for shaped entries.
- 2D grid: draws each part's footprint in its cell (read-only lens).
- Guard: tools that paint whole cells (2D paint/line/rect/fill, wand, build-to-me,
  exchange) do nothing with a shaped entry selected — `VoxelWorld.set_block` refuses
  shaped semantics, so no view can create a "native" cell of a shaped entry.

**Part 2 — Microblock polish** (driven by feedback)
- R rotates a part to the next slot around the aimed axis; paste rotation for parts.
- Growing by stacking the same semantic (cover + cover → 2/8 …, sizes 3/5/6/7).
- Multi-place tools for parts (e.g. wand along an edge run), 2D placement with a slot.
- Selection stats / project details count parts.

**Part 3 — Architecture shapes** (implemented, awaiting UX feedback)
- `scripts/core/ArchShapes.gd`: 89 shapes on six picker pages (Roofing, Slopes & Stairs,
  Rounded, Classical, Arches, Railings), generated from AC's own `Shape` table (names,
  symmetry, collision masks, flags, profiles). Left out for now: windows (need a second
  glass material + connection logic), cladding (an item, not a shape), the "glow" copies,
  and AC's Slab (the microblock Slab covers it).
- Geometry: roofs / ridges / valleys / A-B-C slope tiles ported from AC's `RenderRoof`
  (their no-neighbor forms — the "smart" joins that react to neighbors aren't modeled
  yet); everything else is AC's own `.objson` meshes, vendored (MIT) under
  `assets/shapes/architecturecraft/` with its LICENSE + README. Note for a future export
  build: `.objson` isn't an imported type, so the export preset needs `*.objson` in its
  include filter.
- Orientation: slot = side × 4 + turn (AC's `sideTurnRotations`, which are ordinary
  right-handed rotations, so they map straight onto Godot `Basis`), +24 for a banister's
  mirrored ±6/16 shift. Paste rotation re-solves (side, turn) for the turned basis.
- Rendering: `BlockModel` gained *mesh* elements (free-form triangles); `BlockMesher`
  builds them in both the color and textured paths. `ShapeModels` buckets each triangle
  by the direction its normal leans (ties → side) and binds the entry's block texture for
  that direction; AC's "projected" faces get position UVs like microblocks, the rest keep
  the model's UVs (roof slopes run their texture down the slope, as in the mod).
- Placement (`ArchShapes.orient_on_placement`, via `ShapePlacement`): always into the cell
  beside the clicked face; top face → upright, bottom → upside down, a wall's upper half →
  upside down, **Ctrl** (AC's sneak — Shift is fly-down here) → base against the wall
  (stairs on their side); turn from the click by symmetry; lines up with an adjacent
  architecture shape when profiles match (roof lines, cornices, stair runs); banisters on
  a stair-like shape follow it. Aiming uses AC's collision boxes (2×2×2 cubelets / posts /
  model boxes), which also draw the 2D footprint.
- Rules: an architecture shape keeps its cell to itself (the mod's are whole blocks).
- Picker: page tabs over a scrolling grid; glyphs draw the real triangles, each shown in
  whichever of its 4 turns faces the icon camera best (same slot the baked icons use).

**Part 4 — Convert placed parts** (deferred by request): reshape existing parts to a new
shape as one undoable, validated edit, reporting conflicts.

**Part 5 — Export**: `mcexport` extension. FMP part = `mcr_face|mcr_hllw|mcr_edge|mcr_cnr|
mcr_post`, shape byte = size << 4 | slot (edge slots offset, post = axis). AC =
`Shape` id + side + turn + base block. Semantic → block type → MC id via the palette at
export time.

## Open questions

- AC secondary materials (window glass, cladding): a second block type on the shaped
  entry?
- Should exact FMP sizes 3/5/6/7 be pickable directly as shapes, or only by stacking?
- Connection height for walls next to part cells currently reads the entry's block
  (always "tall"); refine if it looks wrong.
- AC's "smart" roof pieces (hip ridge/valley, and valley/ridge joins on plain tiles) react
  to neighbors in the mod; here they render their standalone form. Worth modeling as a
  render-time neighbor lookup (like fence connections) if roofs look wrong.
- Rotating a placed part (R / AC's hammer) — deferred with the rest of Part 2.
