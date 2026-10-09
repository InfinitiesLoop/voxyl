# Agent tools (`packages/tools`)

Design for the web version's MCP tool surface (started 2026-10-09). The Godot app's ~80 tools
grew one at a time; this is the same job seen whole. Status and next steps are at the end.

## Shape of the thing

- **`packages/tools`** is pure TypeScript (no DOM, no Node), like `core`. It holds a registry of
  tools: `{ name, title, description, input (Zod), annotations, handler(host, args) }`.
- **`ToolHost`** is what handlers call: the core `Project` plus the few things outside it
  (block libraries, clipboard, prefab and shared-palette stores). Handlers never see the
  worker, the relay or WebMCP, so they test in Node with an in-memory host.
- **Adapters** (separate, thin): (1) the world worker, via one `{type: "tool", name, args}`
  message that calls `registry.call(host, name, args)`; (2) WebMCP in the tab; (3) MCP over HTTP
  through the relay; (4) the headless host. Each turns the registry into its transport's
  tool list (Zod to JSON Schema) and routes calls.
- Tools take **names, never ids**. Core wants numeric semantic and palette ids, so the tool
  layer resolves names and fails with a clear error listing the near matches.

## Principles (what we change from Godot)

1. **One addressing language.** Every tool that targets cells takes core's `Region` (box,
   selection, semantic, palette, structure, all, any, not, grow, shrink), with names for
   semantics and palettes. In Godot `{semantic}` meant a bounding box and surprised agents; in
   core it means the cells holding it.
2. **Selection is a region, not a mode.** `select` sets the user's selection from any region
   expression (that replaces `selection_set/resize/filter/grow/shrink/combine/isolate` and
   `structure_find`). Other tools reach it with `{selection: true}`. Agents rarely need it:
   they pass the region straight to the tool.
3. **Shaped or whole is the palette's business.** The agent places a semantic; the palette
   entry says whether that is a block or a part. No `cells_set` vs `parts_add` split, no
   `not_shaped` and `shape_mismatch` errors. Slot and orientation arguments apply when the
   semantic's shape needs them.
4. **One orientation vocabulary** per cell: `facing` (a direction word, the side it looks or
   points toward), `up` (direction word), and for parts `slot`. Torch-like blocks take
   `attached_to` as `facing`'s opposite with a documented rule. Direction words:
   up down north south east west. North is -Z.
5. **One undo step per call**, labelled `Claude: <tool>` (`source: "Claude"`, `group` = the
   call). A multi-command tool still undoes as one.
6. **Safe to repeat.** Mutating tools take an optional `op_id`; it becomes the command id, so
   core answers `duplicate` and nothing changes (ChatGPT runs calls twice).
7. **Preview is free.** Every mutating tool takes `dry_run`: it runs on `project.preview` and
   returns the same report without touching the project.
8. **Cheap by default.** Results are small: counts, bounds, a capped `rejected` list (with a
   `rejected_count`), never the cells. Reads are explicit about size.
9. **Structured everything.** Errors are `{ok: false, error: {code, message, ...}}`; partial
   problems use one `problems` list (Godot mixed `problems` and `warnings`). Success is
   `{ok: true, ...}`. Annotations carry `readOnlyHint`, `destructiveHint`, `idempotentHint`.
10. **Intent over cells.** Prefer verbs a builder would say (fill, replace, build from layers,
    move) to lists of coordinates. Coordinates are `[x, y, z]` integers.

## Tool set

Godot tool names in brackets show what each replaces.

**Session**
- `status`: the first call. Project name, bounds, cell count, palettes and semantics
  (names only), the user's selection (bounds and count), history labels (next undo and
  redo), whether an editor tab is attached, and a short conventions reminder.
  [status, project_info, view_list, selection_get]
- `history`: `{action: list | undo | redo, count}`. [history]

**Read**
- `inspect`: `{where?, view: summary | layers | cells | materials}`. `summary` is bounds,
  counts by semantic, parts by shape; `materials` groups by the actual block with its
  library and Minecraft id; `layers` is the text-layer dump (capped); `cells` lists up to
  N cells with their full state. [region_stats, region_text, cell_get, selection_get]
- `find_blocks`: `{query?, library?, near_color?, tolerance?, limit, offset}` plus
  `libraries: true` to list libraries. [block_search, library_list, block_get]
- `describe_shapes`: `{shape?}` lists shapes, or describes one (family, slots) and, with
  `up` and `facing`, which slot matches. [shape_list, shape_describe, shape_orient]

**Edit**
- `place`: `{cells: [{at, semantic, facing?, up?, slot?}], ...}`, or `{at: [[x,y,z],...],
  semantic}` for many cells with one semantic. [cells_set, parts_add]
- `fill`: `{where, semantic, style: solid | hollow | walls | frame | floor, ...}`. [region_fill]
- `clear`: `{where, semantic?}` (only that semantic when given). [cells_clear]
- `replace`: `{where?, from, to}`: every cell of one semantic becomes another, keeping
  orientation. [region_replace, semantic swaps]
- `build`: `{origin, axis, legend, layers}` text layers, with `where` for a dump the other
  way via `inspect`. [cells_place_layers]
- `transform`: `{where, move?, copy?, rotate?, mirror?, at?}`; a copy can be pasted
  elsewhere (`at`). One tool for move, copy, rotate and mirror. [region_move, region_copy,
  clipboard_paste, region_transform]
- `select`: `{where | null, isolate?}` sets or clears the user's selection.
- Every edit tool also takes `dry_run`, `op_id`, and optional `symmetry` and `repeat`
  (ported from Godot's edit props, added after the first tools land).

**Palette**
- `palette_get`: `{name?}`: the palette stack, or one palette's entries with the block each
  resolves to. [palette_list, palette_get]
- `palette_edit`: `{palette, ops: [{add|set|remove|rename, semantic, block?, shape?, glow?}],
  create?, link?}`: one call edits entries, and a rename carries the placed cells (core's
  rename does). [palette_create/update/delete, semantic_rename, project_palettes_set]

**Later** (each its own step)
- `prefab` tools (`prefab_list`, `prefab_save`, `prefab_place`, `prefab_edit`).
- `project` tools (list, open, create, settings).
- `capture` and `capture_sheet` (tiers 0 to 3; needs the CPU rasterizer, plan Phase 4).
- `export_schematic`, `probe_schematic`; Minecraft identity and NEI tools stay with import.
- User-view tools (`view_set`, `tool_set`, `cutaway`, `hotbar_set`) are UI state, not data:
  they stay out of the data registry and arrive as a separate `ui` group on the tab adapters
  only.
- Not carried over: `restart`, `logs` (dev-only), `screenshot` of the user's window.

## Build order

1. Package, registry, envelope, `ToolHost`, an in-memory test host, `status`, `history`,
   `inspect`, `select`, `place`, `fill`, `clear`, `replace`. Tests in Node. **Commit.**
2. `build`, `transform`, `palette_get`, `palette_edit`, `find_blocks`, `describe_shapes`.
3. Worker adapter: the `tool` message, the host over the worker's state. Then the WebMCP
   adapter in the tab and a dev panel to try a call.
4. Relay (Phase 4 server) and everything after.

## Status

Nothing built yet.
