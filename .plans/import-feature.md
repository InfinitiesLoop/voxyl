# Block Import Pipeline — Design Plan

Status: **Shipped (Phases 0–5 complete).** This doc is now reference + a backlog;
the per-phase build logs were trimmed once each phase landed. What remains below is
the architecture, the locked decisions, and the still-open backlog.

Goal (delivered): a pipeline to bring new block types into voxyl by reading the
*same asset format Minecraft and modded MC already use* — visualizing real blocks,
including animated textures (water, lava, sea lantern…) and complex shapes (slabs,
stairs, fences, walls, panes, bars).

## What shipped

- **Neutral material layer** (`BlockModel`, `TextureAsset`, `BlockStateMap`,
  `BlockType.model_id`/`tint`/`state_map`) — generalizes the old `Shape` enum; FULL/
  SLAB/STAIRS are now built-in `BlockModel`s. Core stays MC-free.
- **Asset storage** behind one accessor (`AssetLibrary`, `res://library`, the single
  swap point for a future `user://` move) + `LibraryStore` (loose `.tres`, merge-on-load).
- **Textured + animated rendering** in `View3D` (per-face quads, NEAREST materials,
  a frame-strip shader advancing V-offset from `TIME`); color path untouched.
- **MC translator** (`scripts/mcimport/MCImporter.gd`, the one MC-aware module): model
  parent-chain resolve, element/face/uv conversion, PNG copy + `.mcmeta` animation,
  blockstate `variants` + `multipart` → `BlockStateMap`. `import_all()` walks every
  namespace, so modded MC is nearly free.
- **Connecting/multipart blocks** via a render-time resolver (`View3D._resolve_cell_parts`):
  connection state is **derived from neighbor occupancy, never stored** on the cell.
- **Biome tinting** as a per-`BlockType.tint` (WHITE = identity); importer bakes the
  plains default, classifies category from the texture path; `View3D` multiplies tint
  into `tint_index` faces.
- **Pre-1.8 (1.7.10-era) flat import** (`MCFlatImporter` + shared `MCTexImport`): synthesizes
  cubes from bare `textures/blocks/*.png`, grouping multi-face cubes by a corroborated
  naming heuristic. `ImportService.Mode { JSON, FLAT }` routes to the right importer.
- **Import UX + library management** (`ImportPanel`, `ImportService`, `MCAssetSource`
  with dir/zip sources, `ImportProgressDialog`): pick a source, browse/search/multiselect,
  non-freezing import with progress + shown warnings, namespace-aware naming/overwrite,
  persistence across restarts. Defaults ship as lowercase MC-id-style-but-generic
  (`stone`, `oak_planks`) so a vanilla import slots over the placeholders.
- **Rendering polish (2026-06-27):** library-preview icon bake batch 20→50/frame
  (`BlockIconBaker.BATCH`, `_BAKE_VERSION`→2 to re-bake disk icons); toned down the
  shared lighting rig (sun 1.3→1.0, fill 0.5→0.35, ambient energy 1.0→0.55 in
  `BlockIconBaker`/`BlockPreview3D`, View3D night ambient 0.9→0.6) — blocks were
  washed out; `View3D.VOXEL_SCALE` 0.94→1.0 so full blocks fill their whole cell and
  adjacent blocks meet flush (no air gap; partial models keep their authored size).

156 smoke + 42 shell green; validate clean; app boots clean.

---

## Why this fits voxyl's architecture (read this first)

Minecraft's resource system is itself an **intent → visual** mapping, split almost
exactly the way voxyl is. Importing MC is therefore squarely a **material/palette-layer**
concern — *as long as* we treat the import as a **translator into a neutral format**, not
as MC concepts leaking into the data.

| Minecraft concept | What it is | Maps onto voxyl's… |
|---|---|---|
| Block **state** (`facing`, `half`, `shape`, `north=true`…) | placement / derived state | **data layer** — `BlockCell.orientation` |
| **Blockstate JSON** (`variants` / `multipart`) | state → model + rotation | **`BlockStateMap`** (material layer) |
| **Block model JSON** (`elements`, `faces`, `parent`) | cuboid geometry + per-face texture refs | **`BlockModel`** |
| **Texture PNG + `.mcmeta`** | pixels + animation strip + tint flag | **`TextureAsset`** |
| **Texture variables** (`#top`, `#side`, `#all`) | named slots filled per-block | `BlockModel.textures` bindings |

Load-bearing point: **everything MC defines lives in voxyl's material/palette layer.
None of it touches voxel data.** `Orientation` was deliberately built MC-shaped; MC
blockstates are the *import* side of that same bridge.

---

## Decisions locked (still binding)

1. **2D view uses an average color, captured ONCE at import** (sampled from the block's
   main texture, stored as `BlockType.color`). Keeps the fast "planning" feel and the
   undecided state working. *Door left open:* a 2D view may later render the texture face
   in its slice plane — `TextureAsset`/`BlockModel` keep per-face textures queryable.
2. **`color` stays first-class**, never vestigial. `model_id` empty → color path. Texture/
   model layer is purely additive.
3. **Asset storage = loose files behind a single accessor.** `res://`-relative today,
   abstracted so a switch to `user://`/an OS app-support dir is a one-line change.
4. **MC assets are the user's own.** Read from their installed game / packs / mod jars.
   Never bundle or redistribute. The importer is a reader, not a content source (stated
   in the import UI).
5. **Prefer references over inline resources.** Shared models/textures live in workspace
   libraries addressed by id; only block-specific config (a `BlockStateMap`) is nested.

Other carried-forward conventions: inter-voxel sizing is a **view rendering style**, not
model geometry (models authored true-size, the view scales — now 1.0, flush);
`frame_time` is seconds/frame in `TextureAsset` (importer converts MC ticks ÷20);
connection = neighbor occupancy, recomputed every rebuild; rotation reuses
`Orientation.basis_of` / `_rotation_basis` (no double-rotation when a `state_map` drives a
block); surfaces are keyed by texture identity (`ns:path`) for max sharing.

---

## Architectural guardrails (push back if the design drifts)

- **Neutral format is the core; MC importer is a plugin on top.** Core types stay MC-free.
- **Nothing in this pipeline touches `VoxelData` / `BlockCell`.** Shapes, textures, colors,
  connections, tints → all material layer or derived-at-render.
- **`color` never becomes vestigial** — it's the graceful undecided/2D state.
- **Licensing:** reader, not a content source. Never bundle MC assets.

---

## Open backlog / revisit later

- **Walls + redstone** — multi-value per-direction connection states (low/tall, none/
  side/up). Generalize `when` to dir→state strings + a per-block state computer (today
  they import as a bare post).
- **Element-level rotation** (`rotation:{origin,axis,angle}`) — warned/skipped; add when
  rails/levers/rotated wall caps need rotated sub-cubes. UV `rotation`/flips are stored on
  the face but not applied to geometry UVs yet.
- **Visual check** for x=180 / upside-down + wall geometry (headless asserts only cover the
  boolean y-90° connecting case structurally).
- **Real biome colormaps / per-biome water** — voxyl has no biomes, so likely a UI preset
  rather than terrain-driven; plus a tint-override editor so users can fix the imported default.
- **Persisting projects/palettes** (today only the shared block-type/model/texture libraries
  persist; projects/palettes are code-seeded each launch).
- **FLAT-mode limits** (documented in the panel): only geometry *recorded in assets* is
  recoverable — pre-1.8 records none, so slabs/stairs/fences/cross-plants come in as cubes;
  runtime-composited mods (GregTech overlays) won't reassemble; nested `blocks/<subdir>/`
  textures aren't browsed.
- **2D side-texture rendering** (decision 1's open door) — needs per-face lookup by
  slice-plane normal; defer until there's demand.
- **Storage root** may move off `res://` (decision 3) — kept abstracted so it's cheap.
- **Higher-res / non-16px textures** — UV math is resolution-independent; `TextureAsset`
  should carry native size; confirm if a non-16px pack shows up.
- **Item-form models** (inventory icons) — out of scope; block models only.
