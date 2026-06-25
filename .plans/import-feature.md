# Block Import Pipeline — Design Plan

Status: **Phase 3 complete.** Pick up at Phase 4 (tinting / biome colors).

Progress log:
- **Phase 3 (done, 2026-06-23):** connecting/multipart blocks + a unified render-time
  part resolver. `BlockStateMap` gained a neutral `parts` array (multipart) beside
  `entries` (variants): a part is `{when, model_id, x_rot, y_rot, uvlock}` where `when`
  is an OR-of-clauses, each clause a `{Dir:int → bool}` AND — zero MC strings. New
  `is_multipart`/`add_part`/`resolve_parts`/`default_part_model_id`. `MCImporter` now
  translates `multipart` blockstates (`_import_multipart` + `_parse_when`/`_parse_clause`):
  boolean direction conditions (north/east/…=true/false) become clauses; multi-value
  vocabularies (walls' low/tall, redstone's none/side/up, and `AND`-of-conditions) are
  warned + skipped, so the block still imports its post. `BlockType.model_id` = the
  always-on (post) part; the bt-emit boilerplate is shared via `_emit_block_type`.
  `View3D` funnels every cell through `_resolve_cell_parts(pos, cell, semantic) →
  [{model, basis}]`: plain blocks → one part (model + `basis_of`, default build
  byte-for-byte unchanged); multipart → post + a side per occupied neighbor (connections
  DERIVED via `_cell_connections`, never stored — `BlockCell` untouched); variant blocks
  → this facing's model + the variant's baked x/y rotation via the new `_rotation_basis`
  INSTEAD of `basis_of` (the Phase 2→3 guardrail — no double-rotation). Single-part cells
  stay a lone `MeshInstance3D` (unchanged node structure); multipart cells become a
  `Node3D` container of per-part mesh instances — slice-mode + `_restore_base_material`
  iterate `_cell_mesh_instances(node)` so both shapes behave. New
  `VoxelWorld.get_block_type_object_for_semantic` (last-wins) hands the view the resolved
  BlockType+state_map. 94 (was 80) smoke + 32 (was 29) shell green; validate clean; app
  boots clean.

  Decisions made (for Phase 4+):
  - **Connection = neighbor occupancy.** Deliberately simple, derived purely from
    VoxelData, nothing stored (data = intent). Refine later (solidity / same-type /
    model-bounds) without touching the data layer or the resolver's shape.
  - **Boolean connections only this phase (fences, glass panes, iron bars).** Walls
    (low/tall) and redstone (none/side/up) carry a *multi-value per-direction* state, not
    a bool — those parts are skipped, so such blocks import as a bare post. Generalizing
    `when` to dir→state (string) plus a per-block connection-state computer is the
    follow-up.
  - **Rotation convention reused from `Orientation.basis_of`.** `_rotation_basis(x,y) =
    Basis(UP,-y°)·Basis(RIGHT,-x°)`; verified for the horizontal y-90° steps (a
    NORTH-pointing arm + y=90 → EAST, matching MC fence sides). x=180 (upside-down) and
    wall geometry still want *visual* confirmation — headless asserts only check
    structure/counts. Variant blocks now consume this, fixing a latent Phase 2 mismatch
    (an east-base MC model rendered unrotated at voxyl-NORTH).
  - **Element-level rotation still deferred.** Fence/pane/bar geometry is axis-aligned,
    so Phase 3 didn't need `rotation:{origin,axis,angle}`; it stays warned/skipped until
    rails/levers (or rotated wall caps) need it.
  - **Full rebuild recomputes connections.** `block_changed` → `_mark_dirty` → full
    `_rebuild`, so placing/clearing a neighbor re-derives every cell's parts. No
    incremental-neighbor path; revisit only if rebuild cost shows up.
- **Phase 2 (done, 2026-06-23):** the MC translator. New `scripts/mcimport/MCImporter.gd`
  is the *only* MC-aware module (the plugin boundary — core stays MC-free); it reads
  `assets/<ns>/{blockstates,models,textures}` off disk (res://·user://·absolute) and
  fills the workspace libraries + copies pixels through `AssetLibrary`. `import_block`
  resolves the model **parent chain** (`_resolve_model_json`, cached; textures merge
  child-wins, elements inherited-or-replaced), converts elements (16→1 units, faces →
  `BlockModel` faces with uv/cullface/rotation/tint_index; auto-UV when MC omits it,
  exact for full faces), imports each referenced PNG once (`_ensure_texture`: copy +
  `_scan_image` average-color/transparency + `.mcmeta` animation, **ticks→seconds ÷20**),
  samples the dominant texture's average into `BlockType.color` (decision 1), and parses
  blockstate `variants` into a **`BlockStateMap`** (new neutral resource, nested on
  `BlockType`). Refs canonicalize to `ns:path` (bare → minecraft) so models/textures
  dedup by id; **template parents (cube/cube_all) are flattened into each leaf model,
  never added as standalone models** (Phase 1 carry-over honored). `import_all()` walks
  every namespace → modded MC is free. `multipart` blockstates warn + skip (Phase 3).
  18 new smoke assertions (synthetic `assets/` tree — we bundle no MC content,
  decision 4) + 2 new shell assertions (importer → View3D render loop). 80 (was 62)
  smoke + 29 (was 27) shell green; validate clean.
- **Phase 1 (done, 2026-06-23):** neutral library container + asset storage +
  textured/animated rendering. New `scripts/core/AssetLibrary.gd` is the single
  storage accessor — `ROOT` (static var, `res://library`) is the one swap point for
  res://→user:// later; `path_for`/`ensure_dir`/`file_exists`/`list_files`/
  `load_image`/`load_texture` (loads loose PNGs via `Image.load`, bypassing the
  editor import pipeline — decision 3). New `scripts/core/LibraryStore.gd` persists
  the id-addressed libraries (`BlockModel`/`TextureAsset`/`BlockType`) as loose
  `.tres` under `models/`·`textures/`·`block_types/` (`pixels/<ns>/` holds the raw
  images `TextureAsset.image_path` points at); `save_all`/`load_into` (load merges
  by id/name so built-ins survive). `View3D` gained an **additive** textured path:
  models with bound, loadable textures render per-face quads (one surface per
  distinct texture_key, explicit UVs) with static `StandardMaterial3D`s or, for
  frame strips, a `ShaderMaterial` that walks the V-offset from `TIME`; models with
  no textures keep the BoxMesh **color path untouched**, so the default build is
  byte-for-byte unchanged. `.gitignore` excludes `/library/` (decision 4). 62 (was
  48) smoke + 27 (was 21) shell assertions green; validate clean.
- **Phase 0 (done, 2026-06-23):** material layer generalized. `BlockModel` +
  `TextureAsset` resources added; `VoxelWorkspace` gained `block_models` /
  `texture_assets` libraries with id-keyed CRUD + `register_builtin_models()`;
  `BlockType` gained `model_id`; `VoxelWorld` gained `get_model_for_semantic` /
  `get_texture_for_semantic`; `View3D` now builds geometry from `BlockModel`
  elements (`_mesh_for_model`, the old `_mesh_for_shape`/`_combine_boxes` are
  gone). FULL/SLAB/STAIRS are built-in models. 48 + 21 tests green; default build
  renders identically (model at true [0,1] size × a view-applied 0.94 scale ==
  the old baked geometry). NOTE: new `class_name` scripts require a reimport
  (`/c/godot.exe --headless --import --path .`) before validation can resolve
  them.

Goal: a pipeline to bring new block types into voxyl by reading the *same asset
format Minecraft and modded MC already use* — so we can visualize real blocks,
including animated textures (water, lava, sea lantern…) and complex shapes
(slabs, stairs, fences, walls, panes, bars).

---

## Why this fits voxyl's architecture (read this first)

Minecraft's resource system is itself an **intent → visual** mapping, split
almost exactly the way voxyl is. Importing MC is therefore squarely a
**material/palette-layer** concern — *as long as* we treat the import as a
**translator into a neutral format**, not as MC concepts leaking into the data.

| Minecraft concept | What it is | Maps onto voxyl's… |
|---|---|---|
| Block **state** (`facing`, `half`, `shape`, `north=true`…) | placement / derived state | **data layer** — `BlockCell.orientation` (already MC-shaped: facing + top bit) |
| **Blockstate JSON** (`variants` / `multipart`) | state → model + rotation | new **`BlockStateMap`** (orientation/neighbors → model), material layer |
| **Block model JSON** (`elements`, `faces`, `parent`) | cuboid geometry + per-face texture refs | new **`BlockModel`** — generalizes today's `Shape` enum |
| **Texture PNG + `.mcmeta`** | pixels + animation strip + tint flag | new **`TextureAsset`** |
| **Texture variables** (`#top`, `#side`, `#all`) | named slots filled per-block | `BlockModel.textures` bindings |

Load-bearing point: **everything MC defines lives in voxyl's material/palette
layer. None of it touches voxel data.** `Orientation` was deliberately built
MC-shaped (`scripts/core/Orientation.gd` — "near-direct mapping" to Schematica/
NBT on export); MC blockstates are the *import* side of that same bridge.

---

## Current state of the relevant code (as of this plan)

- `scripts/core/BlockType.gd` — `{name, color, shape: enum FULL/SLAB/STAIRS}`.
  Comment already says shape is a *visual* property in the material layer and
  "future versions will support textures here instead." This is the file we
  generalize.
- `scripts/core/BlockCell.gd` — `{type_id, orientation, tags}`. **Do not touch.**
  Stores intent only. `tags` is an open NBT-style dict (already there).
- `scripts/core/Palette.gd` / `PaletteEntry.gd` — semantic → block_type_name.
- `scripts/core/VoxelWorkspace.gd` — holds `block_types`, `palettes`, `projects`
  (all `@export` Resources, so serialized). Block-type CRUD lives here.
- `scripts/core/VoxelWorld.gd` (autoload) — resolves color/shape/block-type for a
  semantic by walking the palette stack **last-wins**:
  `get_color_for_semantic`, `get_shape_for_semantic`, `get_block_type_for_semantic`.
  Emits `block_type_changed`. This is where new resolver methods go.
- `scripts/views/View3D.gd` — `_rebuild()` builds one `StandardMaterial3D` per
  semantic (albedo = resolved color) and `_mesh_for_shape()` **hardcodes box
  geometry per enum value** (FULL box, SLAB, STAIRS via `_combine_boxes`).
  Applies `Orientation.basis_of(cell.orientation)`. This mesh builder is what
  gets generalized to consume `BlockModel` elements.
- `scripts/views/View2DGrid.gd` — `_draw_grid()` does
  `draw_rect(get_color_for_semantic(...))` and uses `get_shape_for_semantic` to
  draw a facing glyph. Confirms the 2D view is color-based.

---

## Decisions locked in this session

1. **2D view uses an average color, captured ONCE at import time** (sampled from
   the block's main texture, stored as `BlockType.color`). One-time cost, keeps
   the fast "planning" feel and the build-before-you-decide / undecided state
   working. **Door left open:** a 2D view may *later* render the texture face
   that lies in its slice plane (e.g. show the side texture for a vertical
   slice). Design `TextureAsset` / `BlockModel` so the per-face texture is
   queryable for this, but don't build it yet.
2. **`color` stays first-class**, never vestigial. `BlockType.model == null` →
   render today's color path. Texture/model layer is purely additive.
3. **Asset storage = loose files in a designated project area, not prebaked
   Godot import resources.** Users import *inside the running tool*, so assets
   cannot be Godot editor-imported. Prefer a `res://`-relative location (files
   sit next to the project install) over `user://`. BUT keep the path
   **abstracted behind a single accessor** — some OSes dislike apps writing
   outside application-support paths, so we may switch to `user://` or an
   OS-specific dir later without touching call sites.
4. **MC assets are the user's own.** Read from the user's installed game /
   resource packs / mod jars they own. Never bundle or redistribute MC assets.
   The importer is a reader, not a content source. State this in the import UI.
5. **Prefer references over inline (nested) resources.** Shared, reusable assets
   live in workspace-level libraries and are addressed by id: a `BlockType`
   references a `BlockModel` by id; a `BlockModel` references `TextureAsset`s by
   id. Nest a resource only when it's clearly the *only* place it would ever be
   used — e.g. a `BlockStateMap` describing how one specific block type binds
   orientation → model is fine to nest directly on that `BlockType`. Models and
   textures are reused across many blocks (MC templates like `block/cube_all`,
   shared texture PNGs), so they belong in the library, not inlined.

---

## New / changed types (the neutral, voxel-agnostic format)

Keep these expressible with **zero MC concepts** (no namespaces, no `minecraft:`
ids, no biome assumptions). If an MC-ism wants to live here, that's the signal to
push it into the importer instead.

Reference convention (decision 5): types link by **id**, not by inlining. Models
and textures are shared libraries on the workspace; only block-type-specific
*configuration* (e.g. a `BlockStateMap`) is nested.

- **`BlockModel`** (new Resource, library entry with an id) — generalizes `Shape`.
  - `elements: Array` — each `{ from: Vector3, to: Vector3, faces: { dir: Face } }`
    in voxyl units (convert MC's 0–16 on import).
  - `Face` = `{ texture_key: String, uv: Rect2, cullface: int, rotation: int,
    tint_index: int }`. `texture_key` is a local binding name resolved against
    `textures` below (mirrors MC's `#top`/`#side` variables).
  - `textures: Dictionary` — texture_key → `TextureAsset` **id** (reference, not
    inline; many models reuse the same PNG).
  - `ambient_occlusion: bool`.
  - Today's FULL / SLAB / STAIRS become **built-in** `BlockModel`s, so shaped
    blocks stop being special-cased code.
- **`TextureAsset`** (new Resource, library entry with an id) — wraps one texture.
  - `image_path: String` (via the storage accessor, see below).
  - Animation: `frame_count`, `frame_time`, `frame_order`, `interpolate`
    (MC stores frames as a vertical strip; keep that layout).
  - `tint_source`: none / foliage / grass / fixed color (Phase 4).
  - `transparency`: opaque / cutout (glass, leaves) / translucent.
  - `average_color: Color` — sampled at import, fed into `BlockType.color`.
- **`BlockStateMap`** (new Resource, **nested** on `BlockType` — the one allowed
  inline case, since it's purely that block's config) — translation of MC
  blockstates. Maps an `Orientation` (facing + top) — and, for connecting blocks,
  neighbor-connection flags — to `{ model_id, rotation_x, rotation_y, uvlock }`.
  Note it still references models **by id**. Trivial/empty for simple blocks
  (one model, rotate via `Orientation.basis_of` as today).
- **`BlockType`** evolves: keep `name`; **keep `color`** as the planning-hint /
  fallback; add optional `model_id: String` (reference into the model library)
  and optional nested `state_map: BlockStateMap`. Backward compatible: empty
  `model_id` → current color path.
- **`VoxelWorkspace`** gains two shared libraries alongside `block_types`:
  `block_models` and `texture_assets`, each looked up by id with add/get/remove
  methods mirroring the existing `block_type` CRUD. This is where references
  resolve. The importer dedups into these libraries (same model/texture imported
  once, referenced many times).
- **`VoxelWorld`** resolvers: add `get_model_for_semantic` /
  `get_texture_for_semantic` (resolving ids through the workspace libraries)
  alongside the existing color/shape resolvers — same last-wins palette-stack
  walk. Views consume these; no view owns texture state.

### Storage accessor

One small module/function, e.g. `AssetLibrary.path_for(relative) -> String`,
returning an absolute/`res://` path today. Every read/write of imported assets
goes through it. Swapping `res://` → `user://` → OS app-support later is then a
one-line change.

Layout sketch (under the abstracted root):
```
<asset-root>/
  textures/<namespace>/<block>.png        # copied PNGs (frame strips kept as-is)
  textures/<namespace>/<block>.png.json   # parsed animation/tint meta (or in TextureAsset)
  models/...                              # serialized BlockModel definitions
```

---

## Phases

### Phase 0 — Generalize the material layer (NO MC yet) ✅ DONE
The real architectural work; must land before any import code.
- [x] Add `BlockModel` + `TextureAsset` resources.
      → `scripts/core/BlockModel.gd`, `scripts/core/TextureAsset.gd`.
- [x] Generalize `View3D._mesh_for_shape` → a mesh builder that consumes
      `BlockModel.elements` (replaces hardcoded boxes + the shape enum switch).
      → `View3D._mesh_for_model`, keyed/cached by model id. **Carry-over to
      Phase 1:** it still applies one color material per semantic; per-face
      *textured* materials (multiple surfaces / UVs from the face data) are
      wired in at the Phase 1 material step. The face/uv data already rides on
      the model elements, unused for now.
- [x] Add `VoxelWorld.get_model_for_semantic` / `get_texture_for_semantic`.
      Same last-wins palette walk as the color/shape resolvers. `get_texture_*`
      returns null today (no textures imported → color path).
- [x] Express FULL / SLAB / STAIRS as built-in `BlockModel`s.
      → `BlockModel.builtin_full/slab/stairs`, reserved ids `full`/`slab`/
      `stairs`, seeded via `VoxelWorkspace.register_builtin_models()` in
      `VoxelWorld._ready`. `BlockType.shape` is kept as the *fallback selector*
      when `model_id` is empty (also still drives the 2D facing glyph + Hotbar
      hint), so nothing regressed.
- [x] **Validate:** default build renders identically; `validate-scripts.sh` clean;
      48 (smoke) + 21 (shell) tests pass. New `_test_models` covers the resolver.

Decisions made while implementing Phase 0 (for future phases):
- The inter-voxel gap is a **view rendering style**, not model geometry: models
  are authored at true size ([0,1] = a full block) and `View3D.VOXEL_SCALE`
  (0.94) shrinks them. Keep new models true-size; let views inset.
- Built-in models carry full per-face `faces` dicts (texture_key/uv/cullface/
  rotation/tint_index) even though Phase 0 only reads `from`/`to`. Phase 1 can
  rely on the face schema being present.
- `BlockType.shape` and `BlockModel` coexist intentionally (backward-compat +
  the 2D glyph). If/when 2D consumes models, revisit whether `shape` retires.

### Phase 1 — Neutral library container + asset storage ✅ DONE
- [x] Implement the storage accessor (`res://`-relative, abstracted).
      → `scripts/core/AssetLibrary.gd` (`ROOT` static var = the single swap point).
- [x] Define on-disk layout + serialization for `BlockModel`/`TextureAsset`/
      `BlockType`. → `scripts/core/LibraryStore.gd` (loose `.tres`; `models/`,
      `textures/`, `block_types/`, `pixels/<ns>/`).
- [x] Animated-texture rendering: MC's vertical frame strip, one `ShaderMaterial`
      advancing the V-offset by `frame_time` from `TIME` (no per-frame churn,
      instances animate in lockstep). → `View3D._anim_shader_for` /
      `_animated_material`, wired into the cell-appearance builder.
- [x] Container is fillable by hand or by any importer (round-trip test authors a
      model/texture/block type with no importer in sight).

Decisions made while implementing Phase 1 (for future phases):
- **Two render paths, color stays primary.** Textured rendering is purely
  additive: a model with loadable textures → per-face quads + per-surface
  materials; a model with none → the existing BoxMesh + color material. The default
  build (no textures) is untouched. Slice-mode (the 2D-planning emphasis) stays
  **color-based** even for textured cells — it overrides `material_override` with
  the average color, consistent with decision 1 (fast planning, color never
  vestigial). `_restore_base_material` drops the override afterward.
- **Texture binding is model-level, resolved per-render.** `model.textures` maps
  texture_key → `TextureAsset` id; `View3D` resolves ids → loadable images through
  the workspace library each rebuild (cached). No view owns texture state. Phase 2
  must flatten each MC block into its **own** `BlockModel` (parent geometry + that
  block's own bindings) — models are only shared when geometry *and* textures match.
- **Godot winding gotcha (baked into `_add_face`):** Godot's front faces wind so
  the triangle's geometric cross product points *opposite* the surface normal
  (verified by probe). The face builder self-corrects (flips the perimeter if it
  came out the other way), and a ShellTest asserts every textured triangle is
  front-facing — so Phase 2/3 geometry can't silently invert.
- **File format is `.tres` behind `LibraryStore`** (decision 5 = neutral *data
  model*, not a neutral *encoding*). It's plain text / hand-editable and carries no
  `.import` sidecar. If external-tool authoring ever needs JSON, change it in
  `LibraryStore` alone. `load_into` **merges** by id/name (never nukes built-ins).
- **`frame_time` is seconds/frame** in `TextureAsset` (the shader consumes it
  directly); the Phase 2 importer converts MC's ticks (×1/20) on the way in.
- **`average_color` still feeds the planning views** — Phase 2 samples it from the
  main texture at import and mirrors it into `BlockType.color` (decision 1), so 2D
  and slice-mode never touch pixels.

### Phase 2 — MC importer (the translator) ✅ DONE
Standalone module reading `assets/<ns>/{blockstates,models,textures}`:
- [x] Resolve model `parent` chain; merge `textures` maps + `elements`.
      → `MCImporter._resolve_model_json` (cached; child textures win, elements
      inherited unless the child defines its own).
- [x] Convert elements: 0–16 coords → voxyl units; faces → `BlockModel` faces
      (uv, rotation, cullface, tintindex). → `_convert_elements` / `_face_uv`
      (auto-UV derived from the element footprint when MC omits `uv`).
- [x] Copy referenced PNGs into the asset library via the accessor; parse
      `.png.mcmeta` `animation` → `TextureAsset` frames. → `_ensure_texture` /
      `_apply_mcmeta` (frametime ticks ÷20 → seconds; `_scan_image` for
      average-color + a transparency class).
- [x] Parse blockstate `variants` → `BlockStateMap`, mapping MC `facing`/`half`
      onto voxyl `Orientation`; flatten unmodeled properties. → new neutral
      `scripts/core/BlockStateMap.gd`, nested on `BlockType.state_map`.
- [x] Emit one `BlockType` per block (name = block id) with the sampled
      `average_color` and `model_id` = the resting-orientation model.
- [x] **Modded MC is nearly free:** `import_all()` walks every namespace under the
      assets root; bare refs canonicalize to `minecraft`, qualified refs stay put.

Decisions made while implementing Phase 2 (for Phase 3):
- **`BlockStateMap` data is captured but not yet consumed by views.** The importer
  fully translates `variants` into orientation → `{model_id, x_rot, y_rot, uvlock}`,
  and `BlockType.model_id` points at the **resting-orientation** model so the existing
  textured path renders imported blocks correctly *at default orientation*. Per-
  orientation model selection + applying the variant's MC x/y rotation is **deferred
  to the Phase 3 render-time resolver in the views** — it's the same integration point
  the multipart/connection resolver needs, and the rotation convention (MC bakes
  facing into the variant's x/y; voxyl currently rotates one NORTH-authored model via
  `Orientation.basis_of`) needs *visual* verification, not just headless asserts.
  **Guardrail for Phase 3:** when a `state_map` drives a block, the view must use the
  variant's x/y rotation and **not** also apply `basis_of` (double-rotation).
- **Surfaces are keyed by texture identity.** A face's `texture_key` is the canonical
  texture ref (`ns:path`), so `model.textures` is an identity map for imports and
  faces sharing a texture share one render surface (max sharing). Hand-authored models
  may still use friendly keys like `"all"` — `View3D` treats the key as opaque.
- **Element-level rotation (`rotation: {origin,axis,angle}`)** — used by rails/levers/
  fences — is **not** converted yet (warned, skipped). Add it when Phase 3 needs the
  rotated sub-cubes. UV `rotation`/flips are stored on the face but not yet applied to
  the geometry's UVs either.

### Phase 3 — Connecting / multipart blocks (fences, panes, bars) ✅ DONE
- [x] Handle MC's `multipart` blockstate form (`when` conditions on `north=true`…).
      → `MCImporter._import_multipart` / `_parse_when` / `_parse_clause`; boolean
      direction conditions only (walls' low/tall + redstone's side/up are skipped,
      warned — those need a multi-value connection vocabulary; see Phase 3 decisions).
- [x] **Render-time connection resolver** in the view: `View3D._resolve_cell_parts`
      inspects neighbors (`_cell_connections`), selects parts via
      `BlockStateMap.resolve_parts`, and builds a `Node3D` container of per-part mesh
      instances (single-part cells stay a lone `MeshInstance3D`).
- [x] **Connection state is derived, never stored** — `BlockCell` gained nothing;
      flags come from neighbor occupancy at render time, recomputed on every rebuild.
- [x] Folded the deferred Phase 2 variant-rotation consumption into the same resolver
      (`_rotation_basis`, no double-`basis_of`).
- [x] **Validate:** 94 (smoke) + 32 (shell) green; validate clean; app boots clean.

Still open after Phase 3 (carried into the relevant later phase / a future pass):
- **Walls + redstone** — multi-value per-direction connection states (low/tall,
  none/side/up). Generalize `when` to dir→state strings + a per-block state computer.
- **Element-level rotation** (`rotation:{origin,axis,angle}`) — still warned/skipped;
  add when rails/levers/rotated caps need rotated sub-cubes.
- **Rotation x=180 / upside-down + wall geometry** want a *visual* check (headless
  asserts only cover the boolean y-90° connecting case structurally).

### Phase 4 — Tinting / biome colors
- Grayscale + `tintindex` textures (grass, leaves, water, foliage) tinted from
  biome colormaps. voxyl has no biomes → expose tint as a per-`BlockType` color
  (a material-layer visual property), defaulting to MC plains/default biome.

### Phase 5 — Import UX + library management
- "Add blocks…" panel: pick a source (resource-pack zip, unzipped assets dir, or
  mods folder), browse / search / multiselect, import.
- Dedup + namespace generated names.
- Show the licensing note (decision 4): imports from the user's own install.
- Assigning imported `BlockType`s to palette semantics = the **existing** palette
  workflow, unchanged.

---

## Architectural guardrails (push back if the design drifts)

- **Neutral format is the core; MC importer is a plugin on top.** Core types stay
  MC-free. Protects principle #4 (voxel-agnostic, Minecraft-*inspired*).
- **Nothing in this pipeline touches `VoxelData` / `BlockCell`.** Shapes, textures,
  colors, connections, tints → all material layer or derived-at-render. If a step
  wants to store any of these on a cell, it's wrong.
- **`color` never becomes vestigial** — it's the graceful undecided/2D state.
- **Licensing:** reader, not a content source. Never bundle MC assets.

---

## Open questions / revisit later

- 2D side-texture rendering (door left open in decision 1) — needs per-face
  texture lookup by slice-plane normal; defer until there's demand.
- Storage root may move off `res://` (decision 3) — kept abstracted so it's cheap.
- Higher-res / non-16px textures: `TextureAsset` should carry native size; the UV
  math is resolution-independent, but confirm in Phase 1.
- Item-form models (inventory icons) are out of scope; we only need block models.
