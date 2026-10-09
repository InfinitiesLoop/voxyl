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

**Step 1 built (2026-10-09).** `packages/tools` (`@voxyl/tools`: pure TS, depends on core and
shapes only, no session) with the registry, envelope, `ToolHost`, an in-memory host
(`MemoryHost`, exported for the headless host and scripts) and eight tools: `status`,
`history`, `inspect`, `select`, `place`, `fill`, `clear`, `replace`. 44 Vitest tests (Node,
`packages/tools/test`); `pnpm check` is green. Core needed no change.

What exists:
- **Registry.** `defineTool`, `TOOLS`, `listTools()` (name, title, description, JSON Schema from
  `z.toJSONSchema`, annotations; the recursive region schema converts fine) and
  `callTool(host, name, rawArgs)`, which never throws. Envelope `{ok: true, ...}` or
  `{ok: false, error: {code, message, ...}}`. Codes so far: `unknown_tool` (with
  `suggestions`), `bad_argument` (with `issues: [{path, message}]`, the likeliest union branch
  shown), `no_project`, `not_found` (with `kind`, `query`, `suggestions`), `ambiguous`
  (a name in several palettes; give `{name, palette}`), `too_large` (inspect layers),
  `bad_region`, `command_failed` (a core CommandError), `internal`.
- **ToolHost** = `{project, editorAttached?, newId?(), changed?(project, info)}`. `changed` is
  awaited after every real (not dry) change, the hook for persisting or telling views. Libraries,
  clipboard and the prefab and palette stores join as optional async members when the tools
  that need them land.
- **Call context.** A handler is `handler(host, args, call)`; `call.run(specs)` stamps command
  ids (`op_id`, or `op_id:1`, `op_id:2` for several), source `Claude`, label `Claude: <tool>`
  and one group (`claude:<op_id>`), so a multi-command call is one undo step. Dry runs apply the
  commands to `project.fork()` (what `preview` does, but for a sequence); several commands are
  proven on a fork first, so a call applies completely or not at all. A repeated `op_id` comes
  back `duplicate: true` with nothing changed.
- **Names.** `SemRef` is `"Name"` or `{name, palette}`; matching is exact, then
  case-insensitive when unambiguous. `ToolRegion` mirrors core's `Region` with names for
  semantics and palettes. Reading never creates anything: a name a palette could derive but
  has not yet matches no cells.
- **Results** are small: `changed` (cells), `bounds` as `[x0,y0,z0,x1,y1,z1]`, per-semantic
  `before/after`, `rejected` (first 20) with `rejected_count`, one `problems` list.
- **Tools.** `place` builds one `set` and merges parts into the cell's existing parts, checking
  `rejectPart` from shapes (reasons: `slot_taken`, `exclusive`, `micro_conflict`, ..., plus the
  tool's `block_in_cell`, `slot_required`, `bad_slot`, `out_of_world`). `fill` styles solid,
  hollow (clears the inside first unless `keep_inside`: two commands, one undo), walls, frame
  and floor, all from the region's bounding box intersected with the region. `clear` with
  `semantic` is one `set` that removes only that semantic's parts from a cell of parts.
  `replace` is `resemantic` (keeps orientation; `skipped` counts cells whose geometry does not
  fit, `force` relabels). `history` lists steps (a group is one step) and undoes or redoes
  `count` of them. `inspect` has summary, materials, layers (capped at 32,768 cells in bounds)
  and cells (paged).

Deviations from the design above:
- **Handlers take a third argument**, the call context (`handler(host, args, call)`), which
  carries `run`; the design had `run` on the host. Per call it can hold the op id, group and
  dry-run flag, and hosts stay simple.
- **`select` has no `isolate`**: isolating is view state (hiding everything else), so it
  belongs with the later `ui` tools, not the data registry.
- **`select` and `history` take `op_id`/`dry_run`** like the others. `select` is not an undo
  step (core's `select` is non-undoable). Repeating a `history` undo with the same `op_id` is a
  no-op only while there is something left to undo (otherwise it reports "nothing more").
- Shaped parts: micro shapes and architecture (roof) shapes work through a semantic's shape
  and a `slot` name; that was cheap and needed nothing from core.

Known gaps:
- **No semantic creation yet.** `place`, `fill` and `replace` need the semantic to exist
  (`not_found` lists near matches); creating one waits for `palette_edit` (step 2). A fresh
  project has none, so `palette_edit` should come first in step 2.
- Architecture shapes take `slot` only (`"up=north turn=1"`); `up`/`facing` do not map onto
  their (side, turn) slots yet, and `attached_to` for torches is not ported.
- `symmetry` and `repeat` on edit tools are not in.
- `fill` styles other than solid use the region's bounding box; hollow's shell is "cells with a
  missing face neighbour". A part fill replaces the cell, it does not merge like `place`.
- A `{semantic}` region matching both a palette's own and a derived same-named semantic is
  `ambiguous`, never "all of them".
- `status` lists at most 200 semantics, and `regionStats` is a full scan (fine until builds are
  huge).

Next: build order step 2 (`build`, `transform`, `palette_get`, `palette_edit`, `find_blocks`,
`describe_shapes`), starting with `palette_edit` so semantics can be created. Then step 3, the
worker adapter (`{type: "tool", name, args}` calling `callTool`) over a host on the worker's
project, with `changed` wired to persistence and the views.

### Step 2a built: `palette_edit`, `palette_get`

- `palette_edit {palette, create?, palette_set?, ops[], delete?}`: ops are `add | set | rename |
  remove` on a semantic by name, with `block`, `shape`, `glow`, `tint`, `description` (null
  clears a field; `set` merges into the semantic's own look, so setting an inherited semantic
  overrides it in that palette only, deriving it on first use). A rename keeps the id, so
  cells follow. The call plans on a scratch fork (new palette ids come from the commands),
  then runs the same commands as one group: one undo step, all or nothing, errors say
  `ops[i] <op> <name>`. `delete: true` removes the palette (core refuses while cells use it).
- `palette_get {palette?}`: palette list, or one palette's entries with the resolved block,
  shape, glow, tint, cell count, `inherited_from` and `derived_from`.
- `callTool` now answers a repeated `op_id` before running the handler (`duplicate: true`), by
  looking for the id in the project history; planning tools can't be re-run on a changed project.
- Gap: `link` (shared palettes) needs the shared-palette store on the host; it lands with it.
