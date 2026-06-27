# Block Import Pipeline — Design Plan

Status: **Phase 5 complete + pre-1.8 path + import-UX polish.** Remaining items are
the "Open questions / revisit later" list, not a numbered phase.

Progress log:
- **Phase 5.2 (done, 2026-06-27):** import-UX polish from real vanilla-import feedback
  (a ~1048-block import felt frozen, warnings were a bare count, names were unhelpful).
  - **Namespace-aware naming + overwrite.** `ImportService.name_for(ns,id)` treats the
    `minecraft` namespace as the *default* (no prefix): vanilla blocks import as `dirt`,
    `oak_planks`; every other namespace keeps its prefix (`create:cogwheel`). Because
    the importer reuses a block type by name, a vanilla import **overwrites** a like-
    named shipped default in place. The MC-specific "minecraft == default ns" rule lives
    only in the importer plugin — core `VoxelWorkspace` stays MC-free.
  - **Lowercase default block types.** `VoxelWorld._add_default_block_types` /
    `_add_default_palette` now ship `stone`, `oak_planks`, `oak_stairs`, … (MC-id style
    but still generic, no `minecraft:`), so importing the real game slots its textured
    blocks straight over the placeholders. The defaults don't *depend* on MC.
  - **Non-freezing import + progress.** `ImportService` gained an incremental API
    (`begin_import`/`import_step`/`end_import`); `import_selected` is now a thin wrapper
    over it. New `ImportProgressDialog` (`scripts/ui/`) drives it, `await`-ing a frame
    every 16 blocks so the bar/label repaint on the main thread, then shows the result.
  - **Warnings are shown, not just counted.** The dialog lists the warning lines in a
    scrollable read-only box plus a category summary (count per message prefix), so
    "1706 warnings" becomes legible ("blocks we couldn't fully translate — normal for a
    full game import").
  - **Selection defaults.** The browse list selects all by default; the "Select all"
    button became a checkbox that also deselects; search re-applies the checkbox state.
  - **Test isolation fix.** Startup `LibraryStore.load_into` made autoload-based tests
    depend on whatever `res://library` a prior import left behind. New
    `VoxelWorld.reset_for_tests()` (called first by both test scenes) rebuilds pristine,
    library-free defaults. 156 (was 150) smoke + 42 (was 37) shell green; validate clean;
    boots clean.
- **Phase 5.1 (done, 2026-06-26):** pre-1.8 (1.7.10-era) import. Discovered when the
  user pointed at a real GT New Horizons (MC 1.7.10) instance: pre-1.8 mods ship **no
  blockstate/model JSON** (blocks were drawn by Java code), only loose textures under
  `assets/<ns>/textures/blocks/*.png`. So the Phase 2–5 importer (which keys off
  blockstates) imports nothing from them. Added a second translator, **`MCFlatImporter`**
  (`scripts/mcimport/MCFlatImporter.gd`), that synthesizes voxyl's neutral layer from
  those bare textures — every block a unit cube. It's **smarter than "always a cube"**:
  block textures across that era follow vanilla's face-naming convention
  (`<base>_top`/`_bottom`/`_side`/`_front`), with the separator varying by mod
  (underscore in Thaumcraft, dot in Railcraft, **camelCase** in EnderIO —
  `solarPanelAdvancedSide`). `_tokenize` splits a name on `_`/`.`/`-`/space **and
  camelCase boundaries**; `_classify` strips trailing state words (`on`/`off`/`active`/
  `filled`/digits…) and a trailing face token, yielding a `{base, face}`. Textures
  sharing a base are grouped into ONE multi-face cube — but only when **corroborated**
  (≥2 distinct faces, or a face + a plain texture); a lone suffixed texture or a plain
  one stays its own uniform cube, so a coincidence (`treetop`) never invents a block.
  Faces fill specific dirs first, then `side`→horizontals, then a sensible default for
  gaps. Texture ingestion (copy/scan/animate, incl. `.png.mcmeta` which 1.7.10 already
  uses) is **shared with MCImporter** via the new static **`MCTexImport`** helper
  (MCImporter now delegates `_ensure_texture`/`_split_ref`/scan/mcmeta to it — one
  source of truth, zero behavior change, all prior tests unchanged). `ImportService`
  gained a `Mode { JSON, FLAT }` that routes to the right importer (same sources,
  same browse/import/dedup/persist). `ImportPanel` gained a **Format** OptionButton
  ("Minecraft 1.8+ (block models)" / "Older / pre-1.8 (textures only)") that
  re-browses on change, plus a caveat note in FLAT mode that shapes are guessed, and
  a **"Common locations"** menu (`MCInstallLocations`, pure path construction per
  `OS.get_name()`) that jumps the file/folder picker to where vanilla / CurseForge /
  Prism keep things on Windows & macOS (+ a Linux fallback). Prompted by real
  confusion that vanilla blocks (`minecraft:stone`/`dirt`) live in a version **.jar**,
  not in a mods folder — while a backport mod like Et Futurum supplies the
  `minecraft:`-namespace blocks that *do* appear in `mods/`. Locations present on the
  machine jump the right picker straight there; missing ones stay listed (disabled) as
  a hint. 150 (was 128) smoke + 37 (was 34) shell green; validate clean; boots clean.

  Honest limits of FLAT mode (documented in the panel + class header): only geometry
  *recorded in assets* can be recovered, and pre-1.8 records none — so slabs/stairs/
  fences/cross-plants all come in as cubes; transparency is detected (cutout/translucent)
  but never drives shape; runtime-composited mods (GregTech overlays) won't reassemble;
  textures in nested `blocks/<subdir>/` aren't browsed (flat listing only). The naming
  heuristic is a *default*, not a guarantee — everything imported is still a re-tintable,
  re-shapeable material-layer block the user can fix by hand.

- **Phase 5 (done, 2026-06-26):** import UX + library management. The MC-awareness
  was already complete (Phases 2–4); Phase 5 is the *source + browse + persistence*
  layer plus a thin UI. New **`MCAssetSource`** abstraction (`scripts/mcimport/`)
  decouples *where bytes live* from MCImporter's MC-layout knowledge: pure path
  →bytes/listing I/O relative to the assets root, with `MCDirSource` (a folder, the
  old behavior) and `MCZipSource` (a `ZIPReader` over a resource-pack `.zip` / mod
  `.jar`, mapping `<rel>` → `assets/<rel>` inside the archive). `MCImporter` now
  **reads through a source** instead of building OS paths (`_init` still accepts a
  String, wrapping it in `MCDirSource`, so every Phase 2–4 test is byte-for-byte
  unchanged); gained public `list_namespaces()`/`list_blocks(ns)` for browsing
  without importing, and an optional `name_override` on `import_block` so a caller
  can name a BlockType something other than the bare id. New
  **`ImportService`** orchestrates: `detect_sources(path)` (a `.zip`/`.jar` → one zip
  source; a folder with an `assets/` child → its assets root; a mods folder → one zip
  per archive; else the folder as assets root), `available_blocks()` (the browse
  list, `{ns,id,ref,source}` sorted by ref), and `import_selected()` which **dedups +
  namespaces** names (bare id when unique, qualified `ns:id` on a cross-namespace
  collision — friendly in the common single-pack case, collision-safe for multi-mod)
  then persists via `LibraryStore.save_all`. New **`ImportPanel`** (`Window`) is the
  "Add blocks…" UX off the HomeScreen Block-Types tab: file/folder source pickers,
  a search box, a multiselect `ItemList`, import, and the always-visible licensing
  note (decision 4). `VoxelWorld._ready` now calls `LibraryStore.load_into` so
  imported libraries survive a restart (projects/palettes are still code-seeded each
  launch — only the shared block-type/model/texture libraries persist). 128 (was 107)
  smoke + 34 shell green; validate clean; app boots clean.

  Decisions made while implementing Phase 5:
  - **Source abstraction sits *below* MCImporter, not inside core.** It's pure I/O
    (no MC concepts), so it doesn't violate "core stays MC-free" — MCImporter remains
    the one module that knows the `blockstates/models/textures` layout. Adding a new
    source kind (an HTTP pack, a directory index) is a new `MCAssetSource` subclass,
    nothing else.
  - **Lazy read, never extract.** Zip blocks are resolved file-by-file through the
    open `ZIPReader` (the parent chain pulls only what it needs), so importing 3 of a
    1000-block jar touches 3 blocks' worth of files. No temp-dir extraction.
  - **Dedup naming lives in the service, not the importer.** `import_block` still
    emits the bare id by default (tests unchanged); the service decides the final
    name from the *whole selection* and passes it via `name_override`. Collision rule:
    qualify when the bare id repeats in the selection, or when an existing imported
    block type's `model_id` namespace differs. Defaults (empty `model_id`, Title-Case
    names) never false-positive against MC's lowercase ids.
  - **Persistence is library-only.** `save_all`/`load_into` already merge by id/name,
    so startup load over the code-seeded defaults is safe. Projects and palettes are
    *not* persisted yet (pre-existing) — out of scope here; an imported block shows up
    in the Block-Types library and is assigned to a palette via the existing workflow.
  - **Synchronous import.** A full-jar import copies many PNGs; threading/progress is
    deferred (can't headless-verify a thread well, and the service is structured so a
    progress callback drops in later). Fine for selective imports, the common path.
  - **Still open:** threaded/progress import for huge selections; persisting
    projects/palettes; a tint-override editor (carried from Phase 4).
- **Phase 4 (done, 2026-06-25):** biome tinting. MC tints grayscale `tintindex`
  textures (grass, leaves, water) from biome colormaps decided in *Java*, not assets —
  the model JSON only carries a per-face `tintindex`. voxyl has no biomes, so the
  importer resolves each tinted block to a single **plains/default-biome color** and
  bakes it onto a new `BlockType.tint` (material-layer visual property, WHITE = no
  tint / identity). `MCImporter._apply_tint` scans the primary model's faces for
  `tint_index >= 0`, classifies the most-used tinted texture's *path*
  (`_classify_tint`: water→`#3F76E4`, leaves/foliage/vine/lily→`#77AB2F`,
  else→grass `#91BD59` — the one MC-specific bit, in the plugin) and stores it; it
  also marks each genuinely-tinted texture's `TextureAsset.tint_source` (only textures
  actually on a tintindex face, so a pre-composited `grass_block_side` is never
  mis-marked) and **folds the tint into `BlockType.color`** when the planning/dominant
  texture is itself tinted (leaves/water read green/blue in 2D; grass block keeps its
  brown side). New `VoxelWorld.get_tint_for_semantic` (last-wins palette walk, WHITE
  default). `View3D` multiplies the tint into faces: `_textured_mesh_for_model` now
  emits a `tinted` flag per surface (any face with `tint_index >= 0`), and
  `_surface_material(...,is_tinted,tint)` modulates — static via
  `StandardMaterial3D.albedo_color`, animated via a new `tint` shader uniform (cache
  key gained the semantic, since one model can render under two tints). WHITE is the
  identity, so the default/untinted build is byte-for-byte unchanged. 107 (was 94)
  smoke + 34 (was 32) shell green; validate clean; app boots clean.

  Decisions made (for Phase 5+):
  - **Tint is a per-`BlockType` color, gated by per-face `tint_index`.** This is the
    faithful MC model (tintindex is the render gate; the color is per-block) AND the
    plan's "expose tint as a per-BlockType color". `tint_index` already rode on the
    face since Phase 2; nothing new touches the data layer.
  - **Tint category is guessed from the texture path** because MC's real per-block
    color provider lives in Java, not the assets. The guess is only the *default*; a
    user can re-tint any block (it's a material-layer property). Water is treated as a
    fixed color, not yet biome-varying.
  - **Per-surface tint flag, not per-vertex.** A texture within one model is uniformly
    tinted-or-not in real MC content, so flagging the whole surface matches the per-face
    `tint_index` while keeping the shared, model-keyed mesh cache intact. If a future
    block reuses one texture both tinted and untinted in the same model, revisit with
    a vertex-color mask.
  - **Still open:** real biome colormaps / per-biome water (voxyl has no biomes, so
    likely a UI affordance — pick a biome preset — rather than terrain-driven); a tint
    editor in the Phase 5 UX so users can override the imported default.
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

### Phase 4 — Tinting / biome colors ✅ DONE
Grayscale + `tintindex` textures (grass, leaves, water, foliage) tinted from biome
colormaps. voxyl has no biomes → tint is a per-`BlockType` color (material-layer
visual property), defaulting to the MC plains/default biome.
- [x] New `BlockType.tint` (WHITE = no tint). New `VoxelWorld.get_tint_for_semantic`
      (last-wins palette walk). → `scripts/core/BlockType.gd`, `VoxelWorld.gd`.
- [x] Importer bakes the plains default + classifies tint category from the texture
      path; marks `TextureAsset.tint_source` only for genuinely-tinted textures; folds
      the tint into the planning `color` when the dominant texture is tinted.
      → `MCImporter._apply_tint` / `_classify_tint` / `_dominant_texture_key`.
- [x] `View3D` multiplies the tint into faces carrying a `tint_index` — per-surface
      `tinted` flag from `_textured_mesh_for_model`, applied via
      `StandardMaterial3D.albedo_color` (static) / a `tint` shader uniform (animated).
      WHITE stays the identity, so the untinted build is byte-for-byte unchanged.
- [x] **Validate:** 107 (smoke) + 34 (shell) green; validate clean; app boots clean.
      New `_test_mc_import_tint` / `_test_tint_resolver` (smoke) + `_check_tinted_render`
      (shell).

### Phase 5 — Import UX + library management ✅ DONE
- [x] "Add blocks…" panel: pick a source (resource-pack zip / mod jar, unzipped
      pack/assets dir, or mods folder), browse / search / multiselect, import.
      → `scripts/ui/ImportPanel.gd` off the HomeScreen Block-Types tab, over
      `ImportService` + the new `MCAssetSource` (`MCDirSource` / `MCZipSource`).
- [x] Dedup + namespace generated names. → `ImportService._resolve_names` (bare id
      when unique, qualified `ns:id` on a cross-namespace collision).
- [x] Show the licensing note (decision 4): imports from the user's own install.
      → always-visible note in `ImportPanel`.
- [x] Assigning imported `BlockType`s to palette semantics = the **existing** palette
      workflow, unchanged (import only fills the block-type library).
- [x] Imported libraries persist across restarts — `LibraryStore.save_all` after an
      import, `load_into` at startup in `VoxelWorld._ready`.
- [x] **Validate:** 128 (smoke) + 34 (shell) green; validate clean; app boots clean.
      New `_test_asset_sources` (dir/zip parity + zip→importer) + `_test_import_service`
      (browse / import / dedup / persist).

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
