# Named libraries + palette library-subscription — implementation plan

## Context

Today the block library is **flat**: `VoxelWorkspace` holds single arrays (`block_types`,
`block_models`, `texture_assets`); `LibraryStore` persists them as loose `.tres` under one
`res://library/{models,textures,pixels,block_types}` root; `VoxelWorld` code-seeds ~65
Minecraft-style block-type names that an import overwrites in place by `ns:id`. Separately, a
**Palette** maps semantic names (`Base`, `Accent`, …) → block-type names, and a `VoxelProject` already
holds an ordered **stack of palettes** (`palette_names`, last-wins resolution).

This couples the built-in defaults to Minecraft (Principle 4) and gives no way to keep "vanilla MC"
and "gtnh" as separate, swappable sets. This change introduces named **Libraries** and lets each
**Palette** subscribe to a stack of them. The voxel data still stores only semantic intent —
everything below is the material layer (Principles 1–3).

### The model (no new top-level concept — Palette stays Palette)

```
Project ──(ordered stack)──▶ Palette ──(ordered stack)──▶ Library ──▶ BlockType
   │                           │  └─ semantic→block-type mapping (Base, Accent, …) — exists today
   │                           └─ NEW: subscribes to an ordered stack of libraries it draws from
   └─ voxel data stores semantic names only (unchanged)
```

- **Library** *(new)* — a named bundle of block types (+ the models/textures they need). e.g. `basic`,
  `vanilla-mc`, `gtnh`. This is the "named libraries" feature: the flat pile split into named sets.
- **Palette** *(evolved, same class/name)* — its existing semantic→block-type mapping **plus** a new
  ordered `library_names` stack naming the libraries it draws those block types from.
- **Project** — its existing ordered **stack of palettes** (`palette_names`), unchanged.

There is **no** "Template" concept and **no rename** of `Palette` / `palette_names` / `PaletteEntry` /
`PalettePanel`. The only change to `Palette` is the added `library_names` (+ a `builtin` flag).

### Resolution (a semantic name → rendered block, for the active project)

1. Walk the project's **palette stack** (`palette_names`, last-wins, exactly as today) to find the
   palette entry mapping `semantic → block_type_name`.
2. Resolve `block_type_name` → `BlockType` by walking **that palette's `library_names`** (first hit
   wins), with the built-in `basic` library as an implicit final fallback so "undecided"/planning
   blocks always render (Principle 5). Models/textures referenced by the block type resolve from the
   same library set.

### Built-in floor

Code-seed a built-in **Library** (`basic`, generic + naturals) **and** keep the existing built-in
**Palette** (`"Default"`) — now mapping its semantics onto the basic block types and subscribing to
`["basic"]`. Both are special in code (seeded, undeletable) but **look and behave like any normal
library/palette** in the UX — just sourced from code instead of disk. This is a reorganization of
today's `_add_default_block_types` (→ basic library) and `_add_default_palette` (→ built-in palette).

User decisions locked: named libraries + palette library-subscription; built-in set is generic + a few
naturals; **Block Types view is scoped to one library at a time**; per-library block `order`; built-in
library + palette are code-seeded but behave normally.

The existing flat `res://library` is **deleted** (user approved); MC assets get re-imported into named
libraries (also picking up the straight-stairs importer fix + `order` assignment).

## Phase 1 — Data model

**New `scripts/core/BlockLibrary.gd` (Resource):** `@export name`, `@export builtin := false`,
`@export block_types/block_models/texture_assets: Array[...]`. Owns the per-array `add/get/remove`
helpers (moved from `VoxelWorkspace`), `next_order()` (max `order` + 1), `sorted_block_types()` by
`(order, name)`.

**`scripts/core/BlockType.gd`:** add `@export var order: int = 0`.

**`scripts/core/Palette.gd`:** add `@export var library_names: Array[String] = []` (the ordered
library stack this palette draws from) and `@export var builtin := false`. Existing entries /
`get_block_type_name(semantic)` unchanged.

**`scripts/core/VoxelWorkspace.gd`:** replace the three flat arrays with
`@export var libraries: Array[BlockLibrary]` (the `palettes` and `projects` arrays stay).
- Library catalog API: `get_or_add_library`, `get_library`, `remove_library` (no-op if `builtin`),
  `list_libraries`.
- `resolve_block_type(name, library_names) -> BlockType` — walk the named libraries first-hit, then
  `basic` fallback. Plus `resolve_block_model` / `resolve_texture_asset` over the same scope.
- `find_block_type(name)` — catalog-wide convenience (first hit across all libraries) for the few
  context-free callers; prefer scoped resolution elsewhere.
- `register_builtin_models()` seeds FULL/SLAB/STAIRS builtin models into the `basic` library.

## Phase 2 — VoxelWorld: built-ins + resolution

**`scripts/core/VoxelWorld.gd`:**
- `_populate_defaults` seeds the built-in **`basic` library** (generic + naturals block types — decide
  exact ~14-name list at impl: `base`, `accent`, `highlight`, `trim`, `stone`, `dirt`, `grass`, `sand`,
  `wood`, `plank`, `glass`, `metal`, `leaves`, `water`, + one `slab` + one `stairs`; generic names, no
  `minecraft:` ids), and the built-in **`"Default"` palette** mapping the existing semantic names onto
  them and subscribing to `["basic"]`. Both flagged `builtin`.
- Rewrite the per-semantic resolvers (`get_color/tint/shape/model/texture_for_semantic`,
  `get_block_type_for_semantic`, `merged_semantic_names`) to walk `active_project.palette_names`
  (last-wins, as today) → `palette.get_block_type_name(semantic)` →
  `workspace.resolve_block_type(name, palette.library_names)`.
- The palette-stack API + `palette_stack_changed` signal stay exactly as they are — no view/UI
  subscriber changes.
- `reset_for_tests()` rebuilds the built-in library + palette in memory (ignores disk), as today.

## Phase 3 — Per-library persistence

**`scripts/core/AssetLibrary.gd`:** keep the single `ROOT`; add a library segment —
`path_for(library_name, relative)` → `ROOT/<library>/<relative>`; pixels at `<library>/pixels/<ns>/`.
Keep `load_image/load_texture(relative)` ROOT-relative; **store the library segment inside the saved
`image_path`** (e.g. `vanilla-mc/pixels/minecraft/block/stone.png`) so `BlockTextureCache` and the
loaders keep working unchanged.

**`scripts/core/LibraryStore.gd`:** per-library `save_library(library)`, `load_library(name) -> BlockLibrary`,
`list_libraries()` (root child folders). Persist palettes too (they now carry `library_names`).
`VoxelWorld._ready`: seed built-ins, then load on-disk libraries into the catalog + load saved
palettes. `basic` is **persisted but re-seeded** — any missing baseline block is restored on launch, so
it can't be emptied/deleted while edits still stick.

## Phase 4 — Import targets a library

**`scripts/mcimport/ImportService.gd`:** take a **target `BlockLibrary`** (existing or new). Import
writes block types/models/textures into it, assigns `order` via `library.next_order()`, writes pixels
under the library's path, and `save_library(target)` persists just it. The `minecraft == default ns`
naming rule stays; collisions are now **within the target library**.

## Phase 5 — UI

- **Block Types tab (`scripts/ui/HomeScreen.gd`, `scripts/ui/BlockGrid.gd`) — library-scoped:** add a
  left **library rail** (selectable list; create/delete, disabled for `basic`). Selecting a library is
  the management context; the grid shows only that library's `sorted_block_types()`. New layout
  `[library rail | detail | grid]`. "New block…" / "Add blocks…" act on the selected library;
  detail-panel edits/deletes call `save_library(selected)`.
- **Palettes tab (`HomeScreen`):** keep the semantic→block-type entry editor; add a **Libraries
  subsection** to pick/order the palette's `library_names`. Entry block-type pickers list block types
  from the palette's subscribed libraries (scoped), not a global flat array.
- **Import (`scripts/ui/ImportPanel.gd`):** add a **target-library picker** (existing libraries +
  "New library…"); pass the resolved `BlockLibrary` to `ImportService`. Default target = the Block
  Types tab's selected library (never `basic`).
- `PalettePanel` (per-project palette-stack editor) is unchanged.

## Phase 6 — Migration, tests, verification

- **Migration:** delete the existing `res://library` folder (user approved). `basic` seeds on first
  launch; user re-imports MC assets into named libraries.
- **Tests (`tests/SmokeTest.gd`, `tests/ShellTest.gd`):** update assertions touching
  `workspace.block_types`/`block_models`/`texture_assets` to the new library APIs; add coverage for:
  3-tier resolution (palette stack → palette's library stack, with `basic` fallback), built-in
  library + palette undeletable + re-seeded, import into a named library, per-library `order` + stable
  grid sort, a palette subscribing to multiple libraries with correct precedence.
- **Validate + test:** `bash tools/validate-scripts.sh` and `GODOT=/c/godot.exe bash tests/run_tests.sh`.
  The new `class_name BlockLibrary` script needs `/c/godot.exe --headless --import --path .` once first.
- **Visual (windowed bake-to-PNG harness — computer-use can't drive the Godot window):** Block Types
  tab shows one library at a time with correct `order`; the simplified `basic` set renders; a
  re-imported MC library composes under a palette that subscribes to both it and `basic`.

## Affected files (representative)

- New: `scripts/core/BlockLibrary.gd`.
- `scripts/core/BlockType.gd` (`order`), `scripts/core/Palette.gd` (`library_names` + `builtin`),
  `scripts/core/VoxelWorkspace.gd` (libraries catalog + resolvers), `scripts/core/VoxelWorld.gd`
  (built-in library + palette, resolution), `scripts/core/AssetLibrary.gd` + `LibraryStore.gd`
  (per-library paths/save/load), `scripts/mcimport/ImportService.gd` (target library + order),
  `scripts/ui/HomeScreen.gd` + `BlockGrid.gd` + `ImportPanel.gd` (library rail, scoped grid, palette
  library-subscription, import target).
- `tests/SmokeTest.gd`, `tests/ShellTest.gd`.
- **Plan doc dropped at the repo root** (per request); `.plans/named-libraries.md` marked resolved.

## Decisions locked

1. **3-tier:** Project → stack of Palettes → each Palette subscribes to a stack of Libraries →
   Libraries hold BlockTypes. Resolution: palette stack (last-wins) → palette's library stack
   (first-hit) → `basic` library fallback.
2. **No new concept, no rename.** `Palette` stays `Palette`; it just gains `library_names` (+ `builtin`).
   `palette_names`, `PaletteEntry`, `PalettePanel`, `palette_stack_changed` all unchanged.
3. Built-in **Library + Palette**, code-seeded, undeletable, behaving like normal instances. `basic`
   library persisted-but-re-seeded.
4. `order` is **per-library**; Block Types view shows **one library at a time**.
5. Built-in set = small generic + naturals (Phase 2 list), no `minecraft:` ids.
