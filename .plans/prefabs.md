# Prefabs + Schematica import/export

Status: **design draft** (not started). Asked for 2026-09-23 while building the scaled-up
Conduit Factory, where the same pieces were copied dozens of times (pillar, bay module,
walkway section, tree, farm level) through a single-slot clipboard shared with the user.

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

**Missing semantics.** Semantics the prefab uses that the project's stack doesn't map
would render undecided. On placement Voxyl lists them and offers:
1. **Add the prefab's palettes** that map them to the bottom of the project's stack, so
   the project's own palettes still win (the user's suggestion; proposed default).
2. **Map to project semantics.** Rename on the way in, e.g. prefab `Mass` → project
   `Wall Panel`.
3. **Leave undecided.** Always valid (Principle 5).

## UI

- **Home → Prefabs** tab next to Palettes/Libraries: grid of thumbnails, search/tags,
  rename, delete, "preview in 3D" (a scratch view with the preferred palettes).
- **Editor:** "Save selection as prefab…" (Selection overlay button + keybind). The
  inventory screen (E) gets a Prefabs page. Picking one enters the paste modal with the
  prefab as its source (R rotate, mirror, lock, offset: all the existing paste UX).
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
- vanilla/Et Futurum: concrete and glass colors → meta (see question 3)
- unknown blocks: listed in the export report and skipped, with a dialog to fill them in.

**Orientation → meta.** Per-family rules for the families we use: stairs, logs, slabs,
pillars. Anything else exports meta 0 and gets reported.

**Parts.** FMP microblocks export as the multipart tile entity (material registry name +
meta, slot, size). ArchitectureCraft shapes export as `TileShape` (shape id, rotation,
base block). The shaped-parts plan already keeps shape ids and slots mappable to both
(Decision 4 blocks anything the mods can't build).

**Import → prefab.** Decode ids through `SchematicaMapping`, then registry names through
the mapping table, to library blocks. Every distinct block becomes a semantic named after
it ("Korp 4", renamable later). If an existing palette already maps a semantic to that
block, offer to reuse that semantic instead. A fresh palette is created with those
mappings and becomes the prefab's preferred stack.

**Region export** takes a project selection (or `{all}`) through the same writer. No
prefab is needed.

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

## Open questions

1. Prefabs global to the workspace (like palettes) with export/import of single prefab
   files for sharing? (Proposed: yes.)
2. Placing a prefab with missing semantics: auto-add its palettes (bottom of the stack),
   or always ask?
3. In your pack, what are the in-game blocks behind "vanilla concrete" and stained glass?
   1.7.10 has neither natively. Et Futurum's concrete, or something else?
4. Which Schematica build do you use in GTNH (the name → id mapping tag differs between
   forks)? Sample `.schematic` files from your world would make the import tests real.
