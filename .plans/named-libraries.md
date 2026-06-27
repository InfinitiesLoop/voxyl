# Named, composable block libraries

Status: **planned** (not started). Captures a design discussion from 2026-06-27 so a
fresh session can pick it up. Sibling to `.plans/import-feature.md` (Phase 5 import).

## Goal

Evolve the single, flat block library into **multiple named libraries** the user can
manage and that **templates compose** (overlap with precedence). Concretely:

- A **built-in default library** of basic block types that ships with voxyl and
  **cannot be deleted** (the always-present floor — the "undecided"/planning blocks).
- Importing MC assets creates/fills a **named** library (e.g. `vanilla-mc`, `gtnh`),
  not a single global pile.
- **Templates** pick a set of libraries and **overlap** them, so a build can draw on
  "vanilla mc" + "gtnh" at once, with a defined precedence on name collisions.
- A quick **reset/clear** action — under this design that's just "delete an imported
  library"; the built-in default library always remains.
- Block **ordering** within a library, assigned at import (see "Ordering" below).

The user is fine **invalidating the current `res://library` and re-importing** once the
new scheme lands. Do the stairs re-import (see `MCImporter._parse_variants` straight-only
fix, already shipped) and ordering in that same re-import pass.

## Background: there is no numeric/order "block ID" to import

The user asked whether the importer can record a Minecraft block ID, and how modded MC
does it. The accurate picture:

- **Since the 1.13 "flattening," there are no numeric block IDs** — vanilla *or* modded.
  Every block is keyed by a **string registry name** (`ResourceLocation`,
  `namespace:path`: `minecraft:stone`, `create:cogwheel`). Mods just use their own
  namespace. The old pre-1.13 numeric IDs (and the infamous mod "ID conflict" configs)
  were save-format / registry state, **never stored in the resource assets**.
- voxyl **already uses this string ID**: the importer names block types `ns:id`
  (un-prefixed for `minecraft`) and ids models/textures by their qualified ref. So the
  "block ID" the user remembers from modded MC is exactly what we already capture.
- **Ordering is the only thing missing, and it isn't in the assets we read.** Creative
  menu order lives in code (`CreativeModeTabs`) / mod registration order at runtime, not
  in the unzipped jars' `blockstates/models/textures`. So voxyl must **assign its own**
  order; it cannot read a canonical MC order.

## Current architecture (what exists today)

- `AssetLibrary` (`scripts/core/AssetLibrary.gd`) — single storage root
  `ROOT = "res://library"`, with `models/ textures/ pixels/<ns>/ block_types/`
  sub-areas. **Decision 3**: this is *the* one swap point for where assets live.
- `LibraryStore` (`scripts/core/LibraryStore.gd`) — `save_all(workspace)` /
  `load_into(workspace)` over loose `.tres`, keyed by id/name, into one flat set.
- `VoxelWorkspace` — holds flat arrays: `block_models`, `texture_assets`, `block_types`
  (plus palettes/projects). One global namespace; last-writer-wins by id/name.
- `VoxelWorld._ready` seeds built-ins in code (`_add_default_block_types`, ~65 MC-style
  names) then `LibraryStore.load_into` merges any imported library on top.
- `ImportService` imports a selected subset into the workspace and calls
  `LibraryStore.save_all`. Names dedupe via `ns:id` (`minecraft` == default namespace,
  so vanilla overwrites a like-named default in place).
- **Precedent to reuse:** VoxelWorld already has an ordered **palette stack** with
  precedence (`add/remove/move_palette_in_stack`, `palette_stack_changed`). A library
  stack should mirror this pattern so it feels consistent and stays a lens.

## Proposed design

### 1. A library is a named, self-contained set

Introduce a `BlockLibrary` concept: a named bundle of `block_models` + `texture_assets`
+ `block_types`. On disk, one folder per library under the storage root:

```
res://library/<library-name>/{models, textures, pixels/<ns>, block_types}/
```

`AssetLibrary` stays the single swap point but gains a per-library path helper
(`path_for(library, relative)`); keep `ROOT` as the only place the base path is defined.
`LibraryStore` gains `save_library(name, lib)` / `load_library(name)` and a
`list_libraries()` (the root's child folders).

### 2. Built-in default library (undeletable)

- The code-seeded defaults become a real, named library — e.g. `"basic"` (or
  `"built-in"`). It is **always present** and **cannot be deleted or cleared**; it is
  rebuilt from code on launch (not persisted, or persisted but always re-seeded).
- **Simplify it to just the really basic block types.** The current ~65-name list in
  `VoxelWorld._add_default_block_types` is too much for a "basic" set. Trim to a small,
  generic, voxel-agnostic palette — enough to build with before deciding materials.
  Proposed starter set (decide exact list during impl): `base`, `accent`, `highlight`,
  `trim`, `stone`, `dirt`, `wood`, `plank`, `glass`, `metal`, plus one each of
  `slab` / `stairs` to exercise non-cube shapes. Keep names **generic** (not MC ids) so
  the built-in library stays Minecraft-agnostic (Principle 4). Imported MC libraries are
  where `minecraft:*` names live.

### 3. Library stack + precedence (composition for templates)

- `VoxelWorkspace` holds an **ordered active library stack** instead of one flat set
  (mirrors the palette stack). Resolution of a block-type/model/texture by id walks the
  stack **top-first**; first hit wins, built-in `basic` sits at the bottom as the
  floor. This is the "overlap" the user wants.
- All current flat lookups (`get_block_type`, `get_block_model`, `get_texture_asset`,
  and the iteration the Block Types grid uses) route through the stack resolver. Views
  stay lenses — they ask the workspace, which composes libraries.
- **Templates** (project/template concept) reference libraries **by name** + order, so a
  template *is* a chosen, ordered library stack. Opening a template activates that stack.
  Decide: does a template embed the stack, or just names that must exist?

### 4. Import targets a chosen library

- `ImportService` gains a target library name (new or existing). Import fills that
  library and `save_library` persists just it. The `minecraft == default namespace`
  naming rule stays, but collisions are now **within a library**, not global — two packs
  in two libraries can both define `oak_planks` and the stack decides which shows.

### 5. Reset / delete

- "Reset library to defaults" = **delete a named imported library** (remove its folder,
  drop it from the stack). The built-in `basic` library can't be targeted.
- A small management UI in the Block Types tab: list libraries, create/rename/delete,
  reorder the stack (drag, like palettes), choose which is the import target.

### 6. Ordering

- Add an integer `order` (sequence index) to `BlockType`, assigned at import as a
  monotonic counter **within a library** (hand-authored "New block…" blocks append at
  `max+1`). The Block Types grid sorts by `(order, name)` — a pure lens, no shape change.
- This gives a **stable, intentional order** (import/registration sequence) without
  pretending to be MC creative order. If a curated vanilla order is ever wanted, it can
  seed `order` for known `minecraft:*` ids as an optional, MC-specific extension
  (Principle 4) — not core.
- Open: whether `order` is per-library (cleaner) and how cross-library stacks present
  order in the grid (group by library, then order within).

## Affected files / touchpoints

- `scripts/core/AssetLibrary.gd` — per-library path helper (keep single `ROOT`).
- `scripts/core/LibraryStore.gd` — per-library save/load + `list_libraries`.
- `scripts/core/VoxelWorkspace.gd` — library stack model + stack-aware resolvers.
- `scripts/core/VoxelWorld.gd` — seed built-in `basic` library (simplified list); stack
  signals (mirror `palette_stack_changed`); load imported libraries into the stack.
- `scripts/core/BlockType.gd` — `order` field.
- `scripts/mcimport/ImportService.gd` — target library + assign `order`.
- `scripts/ui/HomeScreen.gd` / `BlockGrid.gd` — library management UI; grid sorts by
  `order`; grid shows the active stack.
- Templates/projects — reference libraries by name + order.
- Tests: `SmokeTest`/`ShellTest` — library stack resolution, built-in undeletable,
  import-into-named-library, ordering.

## Open questions / decisions

1. Built-in library name + the exact simplified default block list.
2. Does a template embed its library stack, or reference names that must resolve?
3. Is `order` per-library or global? (per-library recommended)
4. Cross-library name collisions in the grid: show only the winner, or show all with a
   source badge?
5. Persist the built-in library to disk (re-seeded) or keep it code-only?

## Migration

- Invalidate the existing flat `res://library` (user agreed). On first launch under the
  new scheme: built-in `basic` library is seeded; the old flat library is either ignored
  or one-shot migrated into a single `imported` library. User will **re-import** their MC
  assets into named libraries — which also picks up the straight-stairs importer fix and
  assigns `order`.

## Verification

- Headless: workspace stack resolution (top wins), built-in can't be deleted, import
  into a named library, ordering assigned and grid sort stable.
- Visual (windowed bake-to-PNG harness — computer-use can't drive the Godot window):
  Block Types grid shows libraries composed in stack order with correct ordering; the
  simplified built-in set renders.
- Run `tools/validate-scripts.sh` + `tests/run_tests.sh` (with `GODOT=/c/godot.exe`).
  New `class_name` scripts need `/c/godot.exe --headless --import --path .` once first.
