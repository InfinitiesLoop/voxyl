# Voxyl Web — Core Design (Phase 1)

Status: **Draft for review** (2026-10-06). Nothing here is built yet beyond what Phase 0
left in `packages/core` (chunks, storage by content, interned cell states, raycast).

Phase 1 is a greenfield design (the user's decision, 2026-10-06): the web version doesn't
have to be compatible with the Godot app. Godot's code and formats are inspiration. That app
grew one feature at a time, with local storage and no agents in mind. This one is designed
knowing what is coming: agents driving builds over MCP, a server that stores projects under a
10 MB free limit, and a relay that streams edits between a tab and the server. So it optimizes
for **performance and bandwidth** as well as clarity. The CLAUDE.md principles apply
unchanged.

Each section below says what Godot does, what the web version should do and why. The
decisions to review are collected at the end.

## 1. Semantics are a registry, not strings in cells

**Godot.** Every cell stores its semantic as a string ("Base", "Trim"). Renaming a semantic
rewrites every cell that uses it (`semantic_rename`). A shaped cell also mirrors its first
part's semantic into `type_id`, a workaround so code that asks "what's here?" keeps working.

**Web.** Each project has a **semantic registry**: id → `{ name, description?, hint? }`.
Cells reference semantics by small integer ids, through the interned cell-state table.

- **Renaming is free.** It changes the registry and no cells. The same goes for a
  description or a colour hint.
- **Descriptions are for agents.** A semantic can say what it means ("Trim: horizontal bands
  at each floor line, one block deep"). Tools read it back, so an agent picking up a build
  learns its vocabulary without asking. Undecided is still valid: a semantic needs no palette
  mapping (principle 5).
- **Names stay the key between projects.** Palettes and prefabs are shared across projects,
  so they match semantics by name. Placing a prefab maps its names into the project's
  registry, adding any that are missing.
- **No first-part mirror.** A cell is either one whole block or a set of parts. Occupied
  means a state id other than 0. Code that needs "the semantics here" asks for a list.

## 2. Orientation is a rotation

**Godot.** Orientation is Minecraft-shaped: a 6-way facing plus a top-half flag, in one int.
Turning a region rotates facings around an axis, with special cases for the poles. Mirroring
has known bugs (mirrored balustrades came out upside-down).

**Web.** Orientation is one of the **24 rotations of the cube**, a number from 0 to 23.

- Transforms compose by table lookup. Turning a region multiplies every cell's rotation by
  the turn, with no special cases.
- Facing and upside-down are both rotations, so stairs, slabs and logs fit with nothing
  extra.
- **Mirroring** maps a rotation through the mirror and back to the nearest rotation. That is
  exact for anything symmetric under the mirror (stairs, slabs, logs, most blocks). A
  genuinely chiral block can't be mirrored by any rotation. That case can be flagged, or
  handled by a palette-level "mirrored variant" later.
- Schematic export maps the rotation to each block's Minecraft properties, so nothing
  Minecraft-shaped lives in the core (principle 4).

Shaped parts keep their own slot numbering (FMP and ArchitectureCraft). Each shape family
gets a slot-under-rotation table, as `packages/shapes` already does for AC.

## 3. The cell model

A cell state is `{ semantic, rotation, tags?, parts? }`. A part is
`{ semantic, shape, slot }`. A cell is either a whole block or a list of parts, never both.
States are interned per project into `Uint16` ids, as Phase 0 already does. Chunks store
ids, with storage that follows content (empty, uniform or palette-packed bricks).

- **The state table is append-only while a project is open.** Ids stay stable, so saved
  chunks and in-flight commands keep meaning the same thing. Unused states are dropped when
  the project is compacted (on save or on the server).
- **Tags stay open-ended** (string, number or boolean values), for things like sign text.
  They are interned with the state, so a build with 10,000 distinct signs pays for 10,000
  states. That is fine below the 65,535 limit; a build that needs more would need a side table.
- **Attachments** (torches and the like) remain a block property in the library, as in
  Godot. The core only needs placement-validity rules that can ask "what is this attached
  to?".

## 4. Regions: one way to say "where"

**Godot.** Tools take boxes, plus filters and selection modes that grew one by one:
`{semantic}` regions that are really bounding boxes, narrowed selections, `structure_find`.
Agents end up hand-deriving footprints from `region_text`, which is how the walkway edit left
holes.

**Web.** A single **region expression**, used by every tool, the selection, and the editor:

```jsonc
{ "box": [x0, y0, z0, x1, y1, z1] }               // a box
{ "selection": true }                             // the current selection
{ "named": "East patio" }                         // a region saved in the project
{ "structure": { "seed": [x, y, z], "semantics": ["Deck", "Rail"] } }  // connected cells
{ "semantic": "Trim", "within": { "box": [...] } }  // exact cells, not their bounds
{ "all": [ ... ] } / { "any": [ ... ] } / { "not": ... }               // set algebra
{ "grow": 1, "of": ... } / { "shrink": 1, "of": ... }
```

- **It evaluates to exact cells.** The result is a sparse bitset over 8³ bricks (empty, full
  or a 64-byte mask), so even a 1M-cell region costs a few KB and set operations are word-wise.
- **The selection is a region value.** The editor and agents share it. Narrowing, growing
  and combining are the same algebra.
- **Named regions** ("East patio", "Hub walkway") are stored with the project as their
  expressions. An agent can then say "clear the East patio rail" instead of reciting
  coordinates. This was the first idea when `structure_find` was chosen (see the MCP
  notes), and it costs little once regions are values.

## 5. Edits are commands; deltas stay local

This is the biggest change, and it is what makes bandwidth and agents cheap.

**Godot.** An edit records per-cell before and after states (`EditOperation`). The history
is saved with the project. A 1M-cell fill is a million entries.

**Web.** An edit is a **command**: a small, deterministic description of intent.

```jsonc
{ "id": "c7f2…", "kind": "fill", "where": { "box": [...] }, "state": { "semantic": "Floor" },
  "source": "Claude", "label": "Pour the hall floor" }
```

- **Commands are what travels and what is logged.** The tab streams commands to the server.
  The server appends them to the project's op log, and replaying them produces the same
  cells. A 1M-cell fill is a hundred bytes on the wire, not megabytes.
- **The core is deterministic.** Applying a command depends only on the world and the
  command: no clocks, no randomness without a seed in the command, no dependence on hash-map
  order. A property test replays every command kind on two worlds and compares them.
- **Commands carry or pin what they depend on.** Pasting a prefab names the prefab's content
  hash, so a later edit to the prefab can't change what the old command meant. Clipboard
  pastes and freehand strokes carry their cells, run-length encoded.
- **Undo is a command too** (`{ kind: "undo", target: id }`). Both sides can compute the
  inverse, because both have the same before-state. The before and after deltas live only in
  the tab's memory for fast undo. Godot saves the history with the project; whether the web
  version keeps undo across sessions is an open question below.
- **Ids make commands idempotent.** A command the relay has already applied is acknowledged,
  not reapplied. This covers ChatGPT's duplicate tool calls and sync retries alike.
- **Labels and sources** feed the history view ("Claude: Pour the hall floor"). An agent can
  group several commands into one undo step (the "task grouping" idea from the MCP notes).
- **Every command reports what it changed**: counts per semantic, bounds, and later
  anomalies such as newly exposed holes. The delta is already in memory, so this costs
  nothing and saves the agent a read call.

The command set (first cut): `set` (explicit cells, RLE), `fill`, `clear`, `replace`
(semantic A to B within a region), `move`, `copy`, `transform` (turn or mirror a region in
place), `paste` (clipboard or prefab, with turn and mirror), `parts` (add or remove parts),
`undo`, `redo`. Project changes are commands too: semantic registry edits, palette stack,
settings, named regions.

## 6. Scratch worlds for previews and dry runs

Chunks are copy-on-write, so a **fork** of the world is cheap: it shares every chunk until one
is written.

- **Previews.** A paste ghost, a transform preview or an agent's "show me before you do it"
  applies the command to a fork, renders the fork and throws it away.
- **Dry runs** report counts and anomalies without touching the project.
- **The headless host** can fork, apply and capture without disturbing a tab that holds the
  lease.

## 7. Palettes resolve in one step

**Godot.** A project has a stack of palettes (last wins). Each palette maps semantic names to
block-type names and has its own stack of libraries searched in order, with `basic` as the
fallback. A palette can't pin a block to a particular library.

**Web.** A palette entry maps a semantic name to a **qualified block reference**
(`library:block`), plus an optional shape and options such as glow. The project keeps its
palette stack (layering a base palette with an accent palette is useful), but each lookup is
a direct reference: no library search order, no ambiguity, and no fallback surprise. An
unmapped semantic is undecided and draws with its hint colour.

Palettes, libraries and textures stay outside the world. Swapping a palette touches no cells
(principle 3).

## 8. The project format

Designed for the 10 MB free limit, for chunk-level sync, and for loading only what is needed.

| Part | Contents | Encoding |
| --- | --- | --- |
| `project.json` | Format version, id, name, timestamps, settings (north, grid offset), semantic registry, state table, palette stack, named regions | JSON, compressed |
| Chunk blobs | One per 32³ storage chunk: bricks as empty, uniform or bit-packed palette indices into the state table | Binary, compressed (`CompressionStream`, no codec dependencies) |
| `editor.json` | Camera and layout, hotbar, selection, cutaway | JSON; synced lazily, never part of the build's history |
| Op log (server) | Commands since the last snapshot | JSON lines, compacted into chunk blobs |

- **Chunks are content-addressed.** A chunk blob is named by its hash, so sync uploads only
  chunks that changed, and identical chunks (empty floors of a tower) are stored once.
- **Loading is lazy.** A tab or the headless host fetches the chunks a view or a command
  needs. That fixes the Godot app's load-everything-at-startup cost for free.
- **Derived data is never saved:** meshes, light and thumbnails can all be rebuilt.
- **Prefabs use the same format.** A prefab is a small project with an anchor and a north. Its
  content hash is what paste commands pin.
- **Budgets to measure in Phase 1:** bytes per occupied cell on the generated cities
  (plain and shaped), and command bytes for a typical agent session. The 10 MB limit should
  hold dozens of normal builds.

## 9. Undo and history

The tab keeps an undo stack of commands with their deltas in memory, labelled by source.
Undo and redo are commands, so they sync like any other edit. A new edit after an undo
clears the redo branch, as in Godot.

## 10. What else moves over, mostly as is

- **Project settings**: north and the major-grid offset, with "north is north" turns
  between projects, prefabs, the clipboard and exports.
- **Shape rules**: which parts can share a cell, and slot validity. Ported from
  `ShapeRules.gd` into `packages/shapes`, which already holds the geometry.
- **Read primitives for agents**: region stats, the layered text codec (`region_text`), and
  `structure_find`. They become functions over regions here, and tools in Phase 4.

## 11. Sample builds

There is no Godot oracle. Seeded generators on the web side supply the test builds: the
plain and shaped cities from Phase 0, plus smaller ones with prefabs, named regions and every
part family. Property tests check the invariants:

- Apply then undo restores the exact state.
- Four quarter-turns are the identity, and turning commutes with paste.
- Save then load is lossless.
- Replaying the op log gives the same chunks as the live world.
- A command applied twice by id changes nothing the second time.

## 12. Build order

1. Semantic registry, cell model with rotations, and the transform tables.
2. Regions: bitsets, the expression evaluator, selection, named regions, structure search.
3. Commands: deterministic apply, deltas, undo and redo, ids, change reports, forks.
4. The project format: save and load, content-addressed chunks, size measurements.
5. Prefabs and the clipboard, paste with turn and mirror, "north is north".
6. Shape rules and attachments, region stats and the text codec.

Each step lands with its tests, and the plan is updated as it goes.

## Decisions to review

1. **Commands, not deltas, as the unit of sync and logging** (section 5). Recommended: this
   is the bandwidth win, and it makes agents' edits cheap to send and to idempotently retry.
2. **Orientation as the 24 cube rotations** (section 2). Recommended. The cost: a truly chiral
   block can't be mirrored exactly, and needs a flag or a mirrored variant later.
3. **A semantic registry with ids and agent-facing descriptions** (section 1). Recommended.
4. **One region expression for tools, selection and editor, plus named regions** (section 4).
   Recommended.
5. **Qualified block references in palettes, no library search order** (section 7).
   Recommended. It simplifies the importer's job too.
6. **Does undo survive closing the project?** Godot keeps 100 steps on disk. The web version
   could keep the last N commands' inverses in the op log, at the cost of server storage, or
   start each session with an empty undo stack. Recommendation: keep undo for the session
   only, but keep the op log itself, which can restore the project to a past point if needed.
