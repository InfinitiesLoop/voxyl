# Prefabs + Schematica import/export

Status: **ready to build** (not started). Asked for 2026-09-23 while building the scaled-up
Conduit Factory, where the same pieces were copied dozens of times (pillar, bay module,
walkway section, tree, farm level) through a single-slot clipboard shared with the user.
The user answered the first round of questions the same day (see "Decisions" and
"What the sample schematic shows"); implementation starts in a fresh session.

## Goal

A **prefab** is a named, reusable piece of a build, and a top-level concept next to
palettes and libraries. You save one from a selection, see it in a browser with a
thumbnail, and place it into any project as often as you like: turned, mirrored,
repeated. Schematica files come in and go out through the same door: a `.schematic`
imports as a prefab, and a prefab or a selected region of a project exports as one.

## Principles check

- **Data stores intent.** A prefab stores cells exactly as a project does (semantics,
  orientation, parts `{semantic, shape, slot}`). It never stores blocks or colors.
- **Palettes stay decoupled.** A prefab carries a *preferred palette stack* (names) so its
  thumbnail and preview look right with no project open. Placed into a project, its
  semantics resolve through **the project's** stack like any other cell.
- **Views are lenses.** Prefabs live in the workspace (VoxelWorld owns them). Views just
  preview and place them.
- **Voxel-agnostic core, Minecraft at the edges.** Prefabs are neutral. Schematica is an
  optional extension (`scripts/mcexport/`, beside `mcimport/`).

## Data model

`Prefab` (Resource), stored like palettes (`library/prefabs/<name>.tres`, sandbox-aware):
- `name`, `id`, `created_at`, `modified_at`, `tags` (search), `notes`
- `data: VoxelData`: cells keyed relative to the prefab's min corner, the same format
  as project data and the clipboard, so paste/rotate/mirror code is shared
- `size: Vector3i`, `anchor: Vector3i` (the handle cell used when placing; default min
  corner, or bottom-center for things like trees)
- `palette_names: Array[String]`: preferred stack, used for thumbnails and preview
- thumbnail PNG beside it (baked like project thumbnails)

No link back from placed copies in v1. A placed prefab is plain cells (like a paste).
"Update every instance when the prefab changes" is a possible later feature. It needs an
instance id per cell group, so it's deliberately out of v1.

## Placing into a project

Placement is the existing paste pipeline (`RegionOps.paste_edits`, symmetry, repeat), fed
from a prefab instead of the clipboard. It has the same R-to-rotate ghost in the 3D view.

**Missing semantics (decided).** Semantics the prefab uses that the project's stack doesn't
map would render undecided. Placing such a prefab **warns with a yes/no**, naming the
palettes it will add:

> "Brick Arch" uses 3 semantics this project doesn't map. Add palette "Old Town" to the
> bottom of this project's stack? [Yes] [No]

- **Yes** adds the prefab's preferred palettes that map them to the bottom of the stack,
  so the project's own palettes still win, then places.
- **No** places anyway; those cells render undecided (always valid, Principle 5).
- No prompt when nothing is missing, or when those palettes are already in the stack.
- Closing the dialog cancels the placement.
- Via MCP, `prefab_place` takes `add_palettes: bool` (default false). Its result lists
  `missing_semantics` and `palettes_available`, so an agent can decide and retry.

Remapping on the way in (prefab `Mass` → project `Wall Panel`) is a later add-on, not v1.

## UI

- **Home → Prefabs** tab next to Palettes/Libraries: grid of thumbnails, search/tags,
  rename, delete, "preview in 3D" (a scratch view with the preferred palettes).
- **Editor:** "Save selection as prefab…" (Selection overlay button + keybind). The
  inventory screen (E) gets a Prefabs page. Picking one enters the paste modal with the
  prefab as its source (R rotate, mirror, lock, offset: all the existing paste UX). The
  missing-palettes yes/no shows when the paste is committed, not when it's picked.
- **Selection overlay** also gets "Export .schematic…" (Phase 3).
- Every 3D binding keeps a right-hand/neutral option (see left-handed controls).

## MCP tools

`prefab_save {region, name, palettes?, anchor?}` · `prefab_list` ·
`prefab_get` (size, semantics, palettes) · `prefab_render` (thumbnail sheet) ·
`prefab_place {name, at, rotate, mirror, repeat, symmetry, only_air, overwrite, remap?,
add_palettes?}` · `prefab_update` (rename, palettes, anchor) · `prefab_delete`.
An agent could then save "bay module", "conduit pillar" and "birch tree" once and stamp
them, with no clipboard juggling and no multi-kilobyte layer payloads.

## Schematica (extension)

**Target:** Schematica `.schematic` for 1.7.10 (GTNH). The format is gzip NBT with
`Width/Height/Length`, `Materials="Alpha"`, `Blocks` (+ `AddBlocks` nibbles for ids >
255), `Data` (meta), `TileEntities`, `Entities`, and `SchematicaMapping` (name → numeric
id). Godot can gzip (`FileAccess.open_compressed`); we need a small NBT reader/writer.
Modern Sponge `.schem` is a later add-on for non-GTNH users.

**The mapping gap.** Imported libraries don't record Minecraft identity. A ztones block
is named `sets/korp/korp_ (4)`, not `Ztones:korp` meta 4. Export and import both need a
**block ↔ (registry name, meta) table** per library. It lives in the extension, never in
the core, and is generated where the pattern is known:
- ztones: set name → registry block, index → meta
- vanilla / Et Futurum: stained glass is native to 1.7.10 (`minecraft:stained_glass`,
  meta = color). Concrete comes from Et Futurum (the pack has it); expect
  `etfuturum:concrete` with meta = color, but verify the registry name in-game or from an
  NEI dump before relying on it.
- unknown blocks: listed in the export report and skipped, with a dialog to fill them in.

**Orientation → meta.** Per-family rules for the families we use: stairs, logs, slabs,
pillars. Anything else exports meta 0 and gets reported. Catwalks encode their rail sides
in meta (`catwalks:catwalk_unlit` metas 9–14 in the sample), with a separate
`catwalk_unlit_nobottom` block.

**Parts.** FMP microblocks export as the multipart tile entity (material registry name +
meta, slot, size). ArchitectureCraft shapes are block `ArchitectureCraft:shape` with a
`gcewing.shape` tile entity: `Shape` (numeric shape id; 90 and 113 in the sample),
`BaseName` (the material's registry name, e.g. `Ztones:tile.zestBlock`) and `BaseData`
(its meta). The tile entity has no rotation key, so rotation must live in the block's
meta (all 0 in the sample); confirm with a sample holding turned shapes. The shaped-parts plan already keeps shape ids and slots mappable to both
(Decision 4 blocks anything the mods can't build).

**Import → prefab.** Decode ids through `SchematicaMapping`, then registry names through
the mapping table, to library blocks. Every distinct block becomes a semantic named after
it ("Korp 4", renamable later). If an existing palette already maps a semantic to that
block, offer to reuse that semantic instead. A fresh palette is created with those
mappings and becomes the prefab's preferred stack.

**Region export** takes a project selection (or `{all}`) through the same writer. No
prefab is needed.

## What the sample schematic shows

`FactoryRoom.schematic` from the user's GTNH 2.9 world is a 63×8×44 room with a clean
room, multiblocks and a catwalk walkway. It was decoded with a throwaway Python NBT reader:
- Root `Schematic`: `Width/Height/Length`, `Materials="Alpha"`, `Blocks`, `AddBlocks`
  (half-length nibble array), `Data`, `TileEntities`, `Entities` (empty), `Icon` (item
  compound), and `SchematicaMapping` (registry name → numeric id, only the ids used).
- Cell index = `(y * Length + z) * Width + x`.
- **Ids above 4095 wrap.** `Blocks` + `AddBlocks` hold only 12 bits, but GTNH ids go past
  4095 (StorageDrawers is 10691–10693). The data holds `id & 0xFFF` (2499–2501), which
  matches nothing in the mapping.
  - On import, an unknown id is matched against `mapping_id & 0xFFF`. Use the match when
    exactly one mapping entry fits, and report the id otherwise.
  - Two ids in the sample (512, 1695) fit no entry at all; report and skip them.
  - Export must write only ids that survive the wrap, or refuse with a report.
- Ztones registry names are `Ztones:tile.<set>Block` + meta 0–15 (`korpBlock`,
  `iszmBlock`, `zestBlock`, ...) and `Ztones:lampf`. The voxyl library names these
  `sets/<set>/<set>_ (n)`; the index → meta rule still needs checking against textures.
- Most of the room is GregTech (`gregtech:gt.blockmachines`, casings, reinforced, glass),
  whose identity is in tile entities (`BaseMetaTileEntity.mID`). Import keeps them as
  semantics named after registry name + meta (or `mID`); we have no library art for them.
- Tile entities to ignore on import: EnderIO conduits, drawers, barrels, trophies.
- The sample has no FMP microblocks; a second sample with covers/slabs is still needed.

## Phases

1. **Prefab core:** model, storage, sandbox support, MCP tools, placement through the
   paste pipeline, missing-semantics handling in the tool result. Tests in
   SmokeTest/McpTest.
2. **Prefab UI:** Home tab with thumbnails, save-selection, inventory page, paste-modal
   source, missing-semantics dialog.
3. **Schematica export**, full blocks: NBT writer, mapping tables (ztones, vanilla/Et
   Futurum), orientation rules, export report. For regions and prefabs.
4. **Schematica import** → prefab (full blocks + orientation).
5. **Parts in schematics:** FMP and AC tile entities, both directions.

## Decisions

- Missing semantics on placement: **warn with yes/no**, naming the palettes it will add
  (see "Placing into a project").
- Concrete is Et Futurum's (the pack has it); stained glass is vanilla 1.7.10.
- Test data is `FactoryRoom.schematic` from the user's world (findings above). It lives
  at `%APPDATA%/PrismLauncher/instances/GTNH 2.9 Beta 2/.minecraft/schematics/`. Copy it
  into `tests/fixtures/` when Phase 4 starts.

## Open questions

1. Prefabs global to the workspace (like palettes) with export/import of single prefab
   files for sharing? (Proposed: yes; build it that way unless the user objects.)
2. A second sample with FMP microblocks and turned ArchitectureCraft shapes, for Phase 5.
3. Ztones library index → meta: confirm `korp_ (n)` is meta n-1 (compare textures).
