# Voxyl Web — Core Design (Phase 1)

Status: **Accepted, being built** (2026-10-06). The user reviewed the draft the same day, and
their answers are folded in (marked **Decided** or **Confirmed**). Progress is under "Build
order".

Phase 1 is a greenfield design (the user's decision, 2026-10-06): the web version doesn't
have to be compatible with the Godot app. Godot's code and formats are inspiration. That app
grew one feature at a time, with local storage and no agents in mind. This one is designed
knowing what is coming: agents driving builds over MCP, a server that stores projects under a
10 MB free limit, and a relay that streams edits between a tab and the server. So it optimizes
for **performance and bandwidth** as well as clarity. The CLAUDE.md principles apply
unchanged.

## 1. Edits are commands

**Decided.** Every change to a project is a **command**: a small, deterministic description of
intent.

```jsonc
{ "id": "c7f2…", "kind": "fill", "where": { "box": [0, 0, 0, 40, 0, 30] },
  "state": { "semantic": 12 }, "source": "Claude", "label": "Pour the hall floor" }
```

Godot records each edit as per-cell before and after states, so a 1M-cell fill is a million
entries. Here the command is what travels and what is kept:

- **Small on the wire.** The tab streams commands to the server, which replays them to get
  the same cells. A 1M-cell fill is about a hundred bytes.
- **Deterministic.** Applying a command depends only on the world and the command: no clocks,
  no unseeded randomness, no dependence on hash-map order. A property test replays every
  command kind on two worlds and compares them.
- **Commands pin what they depend on.** Pasting a prefab names the prefab's content hash, so
  a later edit to the prefab can't change what the old command meant. Clipboard pastes and
  freehand strokes carry their cells, run-length encoded.
- **Idempotent by id.** A command whose id has already been applied is acknowledged, not
  reapplied. This covers ChatGPT's duplicate tool calls and sync retries alike. The relay
  only needs the last few dozen ids in memory.
- **Every command reports what it changed**: counts per semantic, bounds, and later anomalies
  such as newly exposed holes. The delta is already in memory, so this costs nothing and saves
  an agent a read call.
- **Project changes are commands too**: semantic and palette edits, settings.

**Adding a command touches one new file** (the user's requirement). Each command kind is a
module under `packages/core/src/commands/`:

```ts
// commands/fill.ts
export const fill = defineCommand({
  kind: "fill",
  args: z.object({ where: Region, state: CellStateRef }),   // also the MCP schema later
  apply(ctx, { where, state }) {                            // writes through ctx only
    const id = ctx.intern(state);
    for (const run of ctx.cells(where)) ctx.setRun(run, id);
  },
});
```

`commands/index.ts` is a list with one import per command. Everything else is generic and
written once:

- **Undo:** the world journals every write `apply` makes, so no command implements an
  inverse.
- **Ids, labels and sources.**
- **Change reports**, built from the journal.
- **Previews and dry runs:** apply to a fork (section 6).
- **Sync and replay.**
- **Validation:** the same Zod schema validates the editor, the relay and, in Phase 4, the
  MCP tool's arguments.

A command never needs to know about undo, sync, the relay or rendering.

First set: `set` (explicit cells, RLE), `fill`, `clear`, `replace`, `move`, `copy`,
`transform` (turn or mirror a region in place), `paste` (clipboard or prefab, with turn and
mirror), `parts`, `rotate` (section 3), plus the semantic, palette and settings edits.

## 2. Semantics and palettes

### What is decided

- **Cells refer to semantics by id, never to a palette entry.** The project's **semantic
  registry** says what the semantics are. Renaming a semantic, or anything else, is a
  registry edit that touches no cells.
- **A palette only maps.** It supplies the visuals for the semantics it has an opinion about,
  for rendering. It no longer defines which semantics exist.
- **Groups of a build are palettes, not named regions** (the user's call). The walkway is the
  set of cells whose semantics belong to the Walkway palette. That stays true through any edit,
  where a stored region would drift out of date. It also makes the walkway re-skinnable as a
  unit.
- **Palettes inherit from each other**, so a palette whose real purpose is to mark a part of the
  build costs almost nothing to set up, and can still override anything about its parent.

### The proposed model (to confirm)

```
Semantic  { id, name, description?, palette: paletteId, base?: semanticId,
            form?: { shape?, rotation? } }          // intent: what it is and how it's placed
Palette   { id, name, extends?: paletteId,
            looks: Map<semanticId, Look> }          // what it looks like
Look      { block?: "library:block", glow?, tint?, ... }   // material only
```

- **Every semantic lives in one palette.** That is its group. A new project starts with one
  palette, and a simple build never needs a second.
- **A child palette gets its parent's semantics as derived semantics.** Making Walkway extend
  Factory means Walkway can place "Deck" and "Rail" right away. The first time one is placed,
  the registry gains a Walkway semantic whose `base` is Factory's Deck. Its name, description,
  form and look all come from the base until Walkway overrides them. The link is by id, so
  renaming Factory's Deck renames Walkway's too, unless Walkway gave it its own name.
- **Re-skinning the whole build is still one edit** (principle 3): change Factory's looks, and
  every palette that inherits them follows. A child that overrides a look keeps its override.
- **Regions by palette.** `{ "palette": "Walkway" }` is every cell whose semantic lives in
  Walkway, optionally including Walkway's own child palettes.

**Where parameters live.** The user asked whether things like shape belong to the semantic or
to the palette entry, and floated allowing every parameter on both, with the palette entry as
an optional override. The proposal splits them by what they are instead:

- **Intent goes on the semantic: shape and placement rotation rules.** Shape is geometry, and
  geometry is intent. A strip is a strip in every palette, and placed parts already store their
  shape in the cell. Allowing a palette to override shape would only affect new placements, and
  would leave a build whose old and new trim differ for no visible reason.
- **Material goes on the palette's look: block, glow, tint.** A slab can glow in one palette and
  not in another.
- **Inheritance handles the rest.** A derived semantic can override its base's intent, and a
  child palette can override its parent's looks. The flexibility the user wanted comes through
  inheritance, with no "which side wins" rule to learn.

Whole-block geometry (stairs, slab, full cube) still comes from the block the look maps to, as
in Godot. An unmapped semantic is undecided and draws as a tinted cube (principle 5).

### Confirmed (2026-10-06)

1. **The model above is confirmed**: derived semantics are created the first time they are
   placed, and a palette's own semantics make up its region. Parameters split as proposed:
   intent on the semantic, material on the look.
2. **Shared palettes are palettes defined at the user level instead of in a project**, and
   identical otherwise. Projects define their own palettes, since needs vary by project. A
   project palette can extend a shared one (a theme), so several projects follow one set of
   looks without copying changes between them. **As built:** the project holds a *linked
   copy* of the shared palette, read-only in the project. A `palette_sync` command, which
   carries the shared palette's content, creates the copy or re-syncs it, matching semantics by
   key so ids and cells stay put. A project therefore stays self-contained: it renders for
   anyone, on the headless host and in exports, without the owner's user-level palettes.
3. **Palette variants are a future idea**, not Phase 1: keep a stone look and a concrete look of
   the same palette and flip which one is active. Noted under "Future ideas".

### Re-semantic: moving cells to another semantic

The user wants to select cells and switch them to a different semantic ("this area should
have used a more specific semantic"). That is the `resemantic` command: every cell in a region
whose semantic is A becomes B, and parts keep their shapes and slots. Conflicts are sorted by
whether they can be fixed without guessing:

| Conflict | Example | Handling |
| --- | --- | --- |
| None | Same form, rotation allowed | Switch |
| Rotation not allowed by B's placement profile | A log on its side becomes a block that only stands upright | Fixable: snap to the nearest allowed rotation, or reset it, and report how many cells changed |
| Whole block versus part, or a different shape | A full block to a strip semantic | Not fixable automatically: those cells are skipped and reported, unless the command asks to force it |

The command reports how many cells it switched, fixed and skipped, so an agent or the editor
can show what didn't fit. Which forced conversions make sense (a full block to a full-cover
part, say) is left for when it comes up.

## 3. Orientation and placement

**Decided.** Orientation is one of the **24 rotations of the cube**, a number from 0 to 23.

**How Godot does it today.** A cell stores a Minecraft-shaped facing: one of 6 directions
plus a "top half" flag for upside-down stairs and slabs. The block type the palette maps to
decides whether it draws as a cube, slab or stairs, and whether its importer limited it to
horizontal facings. Turning a region rotates facings around an axis, with special cases for
the poles. Mirroring has known bugs (mirrored balustrades came out upside-down).

**Web.**

- **Transforms compose by table lookup.** Turning a region multiplies every cell's rotation
  by the turn. Facing and upside-down are both rotations, so stairs, slabs and logs need
  nothing extra.
- **Mirroring** maps a rotation through the mirror to the matching rotation. That is exact
  for anything symmetric under the mirror, which covers almost every block. A truly
  mirror-asymmetric block is flagged rather than silently mangled.
- **Blocks opt into placement behaviour with data, not code** (the user's requirement). Each
  block or semantic declares a **placement profile**:
  - which rotations it allows (a torch: floor and four walls, never the ceiling; a hopper:
    down and four sides; stairs: four facings, upright or upside-down; a log: three axes);
  - how a click picks one, from a small set of rules Minecraft players know: face the player,
    face away from the clicked face, attach to the clicked face, upside-down when the click
    hits a block's upper half;
  - which rotations look the same (a plain cube ignores rotation, a log is symmetric end to
    end). Rotations are stored in that canonical form, so identical-looking cells share one
    state.

  The profile comes from the mapped block (the importer fills it in from Minecraft's block
  states), and a semantic's form can set or narrow it, so undecided semantics place sensibly
  too. There is no per-block code anywhere.
- **Fixing an orientation.** A `rotate` command turns a cell (or a region) about an axis, as
  in "rotate on this face", stepping to the next rotation the profile allows. The editor binds
  it to a key on the hovered face, and agents get it as a tool.
- **Parts (microblocks, ArchitectureCraft shapes)** keep their own slot numbering. Each shape
  family declares its slots, how slots move under each rotation and mirror, and which slots can
  share a cell. That is the same opt-in-by-data idea, kept in `packages/shapes`.

Schematic export maps rotations to each block's Minecraft properties, so nothing
Minecraft-shaped lives in the core (principle 4).

## 4. The cell model

A cell state is `{ semantic, rotation, tags?, parts? }`, where a part is
`{ semantic, shape, slot }`. A cell is either a whole block or a list of parts, never both.
Occupied means a state id other than 0. Godot's habit of mirroring the first part's semantic
into the cell is gone: code that asks "what's here?" gets a list.

States are interned per project into `Uint16` ids, as Phase 0 already does. Chunks store ids,
with storage that follows content (empty, uniform or palette-packed bricks).

- **The state table is append-only while a project is open.** Ids stay stable, so saved
  chunks and in-flight commands keep their meaning. Unused states are dropped when a project is
  compacted.
- **Tags stay open-ended** (string, number or boolean), for things like sign text. They are
  interned with the state. Fine below the 65,535-state limit; a build that needs more would
  need a side table.
- **Attachments** (torches and the like) come from the placement profile: "attaches to the
  clicked face" also tells validity checks what a cell hangs from.

## 5. Regions: one way to say "where"

**Decided.** One **region expression** language is shared by every command, by the selection
and by the editor:

```jsonc
{ "box": [x0, y0, z0, x1, y1, z1] }
{ "selection": true }
{ "palette": "Walkway" }                               // the cells of a group
{ "semantic": "Trim", "within": { "box": [...] } }     // exact cells, never their bounds
{ "structure": { "seed": [x, y, z], "semantics": ["Deck", "Rail"] } }   // connected cells
{ "all": [...] }  { "any": [...] }  { "not": ... }     // set algebra
{ "grow": 1, "of": ... }  { "shrink": 1, "of": ... }
```

- **It evaluates to exact cells:** a sparse bitset over 8³ bricks (empty, full or a 64-byte
  mask). A 1M-cell region costs a few KB, and set operations work a word at a time.
- **The selection is a region value**, shared by the editor and agents. Narrowing, growing
  and combining are the same algebra.
- **No named regions** (the user's call). Groups are palettes (section 2), which can't drift
  out of date.

## 6. Scratch worlds for previews and dry runs

Chunks are copy-on-write, so a **fork** of the world is cheap: it shares every chunk until one
is written. Paste ghosts, transform previews and an agent's "show me first" apply the command
to a fork, render it and throw it away. Dry runs report counts and anomalies without touching
the project. The headless host can fork, apply and capture without disturbing a tab that holds
the lease.

## 7. History: one log for undo and sync

**Decided** (the user asked to collapse the op log and the undo stack into one concept). A
project's **history** is its command log: append-only, the same list that syncs to the server.

- **Undo and redo are commands** appended to the log (`undo c7f2…`). The undo stack is not a
  separate structure: it's a walk back through the log that skips commands already undone.
  Because the log only ever grows, undo syncs like any other edit and never rewrites history
  another device has seen.
- **Deltas are a cache.** While a session runs, the tab keeps each command's before and after
  cells in memory, so undo is instant. They are never sent or stored.
- **Undo is session-only to start** (decided), without closing the door: undoing past the start
  of the session needs those deltas, and they can be rebuilt by replaying the log from the last
  snapshot. Serializing undo later is therefore a feature switch, not a format change. The one
  limit is compaction: when the server folds old commands into a snapshot, undo can reach back
  only to the oldest command it keeps. How long the log is kept is a storage-budget setting.
- **Labels and sources** ("Claude: Pour the hall floor") show in the history view. An agent can
  group several commands into one undo step, as the MCP notes suggested.

## 8. The project format

Designed for the 10 MB free limit, for chunk-level sync, and for loading only what is needed.

| Part | Contents | Encoding |
| --- | --- | --- |
| `project.json` | Format version, id, name, timestamps, settings (north, grid offset), the semantic registry, palettes, the state table | JSON, compressed |
| Chunk blobs | One per 32³ storage chunk: bricks as empty, uniform or bit-packed indices into the state table | Binary, compressed (`CompressionStream`, no codec dependencies) |
| History | Commands since the last snapshot | JSON lines, compacted into chunk blobs |
| `editor.json` | Camera and layout, hotbar, selection, cutaway | JSON, synced lazily and never part of the history |

- **Chunks are content-addressed.** A chunk blob is named by its hash, so sync uploads only
  chunks that changed, and identical chunks (the empty floors of a tower) are stored once.
- **Loading is lazy.** A tab or the headless host fetches the chunks a view or a command
  needs, which removes the Godot app's load-everything-at-startup cost.
- **Derived data is never saved:** meshes, light and thumbnails are rebuilt.
- **Prefabs use the same format.** A prefab is a small project with an anchor and a north, and
  its content hash is what paste commands pin.
- **Budgets to measure in Phase 1:** bytes per occupied cell on the generated cities (plain and
  shaped), and command bytes for a typical agent session. The 10 MB limit should hold dozens of
  normal builds.

## 9. What else carries over, mostly as is

- **Project settings:** north and the major-grid offset, with "north is north" turns between
  projects, prefabs, the clipboard and exports.
- **Shape rules:** which parts can share a cell, and slot validity, in `packages/shapes`, which
  already holds the geometry.
- **Read primitives for agents:** region stats, the layered text codec (`region_text`) and
  structure search, as functions over regions now and as tools in Phase 4.

## 10. Sample builds and tests

There is no Godot oracle. Seeded generators on the web side supply the test builds: the plain
and shaped cities from Phase 0, plus smaller ones with prefabs, inherited palettes and every
part family. Property tests check the invariants:

- Apply then undo restores the exact state.
- Four quarter-turns are the identity, and turning commutes with paste.
- Save then load is lossless.
- Replaying the history gives the same chunks as the live world.
- A command applied twice by id changes nothing the second time.
- Renaming a semantic or re-skinning a palette changes no chunk bytes.

## 11. Build order

1. The command framework (one file per command, journal, ids, change reports, forks) and the
   cell model with rotations and transform tables.
2. Semantics and palettes: the registry, inheritance, derived semantics, looks.
3. Regions: bitsets, the expression evaluator, the selection, structure search.
4. The history log: undo and redo as commands, session deltas.
5. The project format: save and load, content-addressed chunks, size measurements.
6. Prefabs and the clipboard: paste with turn and mirror, "north is north".
7. Placement profiles, `rotate`, shape rules, region stats and the text codec.

Each step lands with its tests and updates this document.

### Progress

- **Step 1 done (2026-10-06).** All in `packages/core`:
  - `rotation.ts`: the 24 rotations in a fixed order (identity first, saved in cells), compose,
    inverse, turns, mirror, facing, and canonical rotations under a symmetry group.
  - `cell-state.ts`: states hold semantic ids and a rotation. A cell is a whole block or parts,
    never both, and the first-part mirror is gone.
  - `semantics.ts`: the registry's first cut (ids, names, descriptions, rename). Palettes,
    inheritance and forms come in step 2.
  - Chunks are copy-on-write (`Chunk.clone`, brick arrays shared until written), and
    `Chunk.diff` skips shared bricks.
  - `World` has `fork`, `beginEdit`/`endEdit` (an `Edit` is per-chunk before and after
    snapshots) and `restore`.
  - The framework is `commands/command.ts`, one file per command (`set`, `fill`, `clear`), and
    the list in `commands/index.ts`.
  - `Project.run` validates with Zod, applies atomically (a throw restores the snapshots), drops
    repeated ids (last 64), and reports changed cells, bounds and per-semantic counts. `preview`
    runs on a fork.
  - Tests are property-based: deterministic replay; undo and redo from edits restore every
    intermediate state exactly; forks stay independent under random writes, including 16-bit
    palette overflow; rename touches no cell.
  - Regions are still boxes only (step 3).
  - The city fixture and the app now take a `Project` and resolve names through its registry.
- **Step 2 done (2026-10-06).**
  - `semantics.ts` holds palettes and semantics. Every project starts with palette 1, "Main".
    Palettes can extend each other, and cycles are refused, as is re-parenting that would orphan
    a derived semantic.
  - A semantic lives in one palette. `derive(palette, base)` makes a palette's semantic from an
    ancestor's, once, through nearer palettes' overrides.
  - `resolve()` applies inheritance field by field: name, description, form and look.
  - `offers(palette)` lists own and derivable semantics, and `semanticsIn(palette, withDescendants)`
    gives the groups that regions will use.
  - Linked copies of shared palettes come in through `sync()`.
  - Commands, one file each: `palette_add`, `palette_update`, `palette_sync`,
    `semantic_add`, `semantic_update`, `resemantic`. Any state argument can name a semantic as
    `{ palette, base }`, which derives it on first placement.
  - `Project` snapshots the registry around each command (rolled back on failure, kept for undo)
    and reports created palettes and semantics, `registryChanged`, and notes such as
    resemantic's switched and skipped counts.
  - `resemantic` keeps geometry and skips cells whose shape doesn't fit the target's form unless
    forced. Fixing disallowed rotations waits for placement profiles (step 7).
- **Step 3 done (2026-10-06).**
  - `cellset.ts` is a sparse set of positions: 128³ blocks keyed like chunks, holding 8³
    bricks that are full or a 512-bit mask. It has union, intersection and difference a brick or
    word at a time, grow and shrink through faces, exact bounds, and iteration in a fixed order.
  - `region.ts` holds the expression language as a recursive Zod schema: box, selection,
    palette (with descendants), semantic, structure (a flood fill from a seed, by semantics,
    diagonal optional, within a region or 256 cells of the seed), all/any/not, and grow/shrink.
    A region evaluates to exact cells, and anything over 64M cells is refused.
  - Context gains `cells`, `fill` (fast for plain boxes and full bricks) and `forEachIn`.
    `fill`, `clear` and `resemantic` take any region.
  - The selection is project state, changed by the `select` command. Commands saying
    `{ selection: true }` therefore replay the same anywhere, and `Applied` keeps the before and
    after selection for undo.
  - Measured on the 5M city (one Node thread):

    | Region | Cells | Time |
    | --- | --- | --- |
    | 200x60x200 box | 2.4M | 48 ms |
    | Every cell of the root palette | 5.0M | 0.54 s |
    | One semantic over the whole world | 548k | 0.29 s |
    | One semantic within a 200x60x200 box | 24k | 0.14 s |
    | Structure flood fill | 1.36M | 0.87 s |
    | Grow a 64³ box by 2 | 312k | 22 ms |
    | `resemantic` over a 400x100x400 box (cells switched) | 105k | 0.22 s |

    Fine for agent calls in a worker. If needed, the cost is per-cell `CellSet.add` and
    `getId`; skipping chunks and bricks with no matching state would cut it.
- **Step 4 done (2026-10-06).**
  - `Project.history` is the log: every command, oldest first, each marked active, undone or
    dead.
  - `undo` and `redo` are commands naming the step they act on (`Project.undoTarget()`,
    `redoTarget()`), so replaying the log anywhere does the same. Naming the wrong step is
    refused, and a repeated undo id is acknowledged, not applied again (ChatGPT's double calls).
  - Consecutive commands sharing a `group` undo as one step. The selection, undo and redo are
    logged but aren't steps (`undoable: false` on the command).
  - A new edit after an undo kills the redo branch.
  - Deltas (chunk and registry snapshots) stay in memory for the last `UNDO_LIMIT` (500)
    commands, and undo stops at the oldest. Registry revisions only move forward, even on undo.
  - A property test undoes and redoes random fills, clears and renames back through every
    state.
- **Step 5 done (2026-10-06).** In `packages/core/src/format/`:
  - `saveProject` writes a manifest (registry, compacted state table, storage chunk hashes) and
    blobs. `loadProject` reads them into any runtime chunk size (3 to 7 bits).
  - Storage chunks are a fixed 32³, encoded as 8³ bricks (empty, uniform, or bit-packed indices
    into the chunk's own palette), named by a 64-bit hash of the uncompressed bytes, then
    deflated with `CompressionStream`. Identical chunks are stored once.
  - `packBundle` and `unpackBundle` make one file for export.
  - Saving is canonical: states are compacted in old-id order, so a build saves to the same bytes
    whatever its history or chunk size (tested).
  - Measured (generated cities, one Node thread). The city is very regular, so real builds will
    be larger, but even a few times larger leaves the 10 MB free limit holding dozens of big
    builds and hundreds of normal ones.

    | Build | Bundle | Per cell | Save | Load |
    | --- | --- | --- | --- | --- |
    | 120k cells, plain | 11 KB | 0.09 B | 107 ms | 58 ms |
    | 120k cells, shaped parts | 16 KB | 0.13 B | 43 ms | 43 ms |
    | 1M cells, plain | 90 KB | 0.09 B | 0.31 s | 0.21 s |
    | 5M cells, plain | 473 KB | 0.10 B | 1.3 s | 0.93 s |
    | 5M cells, shaped parts | 682 KB | 0.14 B | 1.3 s | 0.90 s |

    A typical command is about 150 bytes of JSON ("Claude: Pour the hall floor", a 41x31
    fill).
  - Not yet: the history log on disk (Phase 4 sync) and `editor.json`. Settings came in step 6.
    An autosave writes only dirty storage chunks, so saves after an edit are a fraction of these
    times.
- **Step 6 done (2026-10-06).** Prefabs, the clipboard, turning and mirroring, north, settings:
  - `transform.ts`: a placement is quarter turns clockwise seen from above, then an optional
    mirror (x, y or z), as one signed-permutation matrix. A whole block's rotation composes with
    it (`transformRotation`; a mirror assumes the block is left-right symmetric, as `mirror`
    already did). `StateMover` moves states, memoized per state id.
  - Part slots move by geometry, not tables (`packages/shapes`, `transformSlot`). A microblock
    slot's image is the slot filling the same moved cells of the 8³ grid. An architecture slot
    is a rotation, so a turn composes exactly; a mirror picks the slot that is the shape
    mirrored across one of its own axes, checked against a key of its surface that ignores how
    the polygons were triangulated. Every microblock and all 16 roof and slope shapes have a
    mirror image. A shape with none (or with unknown geometry) is left out and reported as
    `rejected`; a move leaves such cells where they were. Core now depends on `@voxyl/shapes`.
  - Commands, one file each: `copy`, `move` and `transform` (turn or mirror in place) take a
    region; the corner (lowest x, y, z) of the result lands at `to`, or stays put for
    `transform`. They read from a copy-on-write fork, so overlapping moves are safe. `air`
    makes the region's empty cells clear what they land on.
  - `piece.ts`: a **piece** is cells lifted out of a project, for the clipboard and prefabs: its
    box, its north, an anchor, the states it uses, and the semantics those use, resolved and
    flattened (name, palette name, description, form, look, and the source id). Cells are
    run-length encoded over the box; index 0 is outside the piece, and a null state is air.
  - `paste` places a piece carried inline (the clipboard) or a prefab named by its content hash.
    The anchor lands at `at` and the piece turns about it: first by `turnsBetween(piece north,
    project north)`, then by `turn` and `mirror` ("north is north", the Godot rule). A host
    passes `Project` a `prefabs` lookup and loads a prefab before running the command; an
    unknown hash is a clear `CommandError`.
  - **How a piece's semantics map into a project (my choice, to review):** an explicit `map`
    wins; in the project the piece came from, the source id (so a rename between copy and
    paste is harmless); then the semantic of that name in the palette of that name, own or
    derivable; otherwise it is created there, with the palette if needed, carrying its look,
    so a prefab looks as authored in a project that has never seen it (Godot asked "add
    palette?"; here the created palette is the answer, and `map` is the "no"). A linked palette
    is read-only, so new semantics land in the root palette instead.
  - `settings` command: the project's name, north (`"north"`, `"east"`, `"south"`, `"west"`:
    which of its directions is the real north) and major grid offset (0..15 in x and z).
    Undoable; cells never move when north changes. Saved in the manifest, with the project's
    `id` (random, 128 bits), which pieces use to map back by id.
  - Prefabs (`format/prefab.ts`) are small projects in the project format, with `size` and
    `anchor` in the manifest and north in their settings, so one can be opened and edited like
    a project. `prefabHash` hashes the manifest (chunk blobs are already named by their hashes)
    with keys sorted, leaving out the id and name, so renaming a prefab keeps its hash and any
    cell change gives a new one. `loadPrefab` gives the piece back with the whole box as air
    where empty.
  - Tests: turning four times in place and mirroring twice are the identity on random builds
    of blocks, microblocks and roof parts; turning commutes with paste; north survives a round
    trip through a project facing another way; pastes map semantics as above; prefabs round-trip
    through a bundle with a stable hash; settings undo.
  - Measured (`node packages/fixtures/bench/placement.ts`, 1M-cell city, 64³ chunks, one Node
    thread):

    | Operation | Plain | Shaped |
    | --- | --- | --- |
    | Paste a 128x64x128 piece (68k cells; 86k shaped), turned | 43 ms | 56 ms |
    | That paste command as JSON / deflated | 187 KB / 4.1 KB | 298 KB / 11.5 KB |
    | Paste a 64x64x64 piece (20k cells; 25k shaped) as JSON / deflated | 44 KB / 1.0 KB | 66 KB / 2.2 KB |
    | Copy a 256x64x256 box with a turn | 0.26 s | 0.27 s |
    | Move it with a mirror | 0.52 s | 0.59 s |
    | Turn it in place | 0.58 s | 0.56 s |

    Commands carrying a clipboard are big as plain JSON but compress about 40x, so the relay
    and sync should send them compressed (WebSocket per-message deflate or a deflated body).
  - Not yet: a plain cube turned gets a new rotation, so a turned build can hold up to 24
    states per semantic that look the same. Placement profiles (step 7) say which rotations
    look alike and store the canonical one. Pieces carry no palette inheritance (they flatten
    looks), and a placed prefab keeps no link to its prefab (as in Godot's v1).

## Future ideas

- **Palette variants:** alternative looks for one palette (stone and concrete), with the
  project choosing which is active. Not planned yet; for later ideation.

## Decision log

| # | Question | Decision (2026-10-06) |
| --- | --- | --- |
| 1 | Commands or deltas as the unit of sync and logging | Commands. Each command kind is one self-contained file; everything else is generic. |
| 2 | Orientation | The 24 cube rotations. Placement familiar from Minecraft, a "rotate on face" fix, and per-block opt-in rules as data, with no block-specific code. |
| 3 | Semantics | A per-project registry. Cells hold semantic ids, renames are cheap, and palettes only map. Each semantic belongs to one palette, its group. Derived semantics come from palette inheritance. Intent sits on the semantic, material on the look. Shared palettes are defined at the user level. A `resemantic` command switches cells to another semantic. |
| 4 | Named regions | No. Groups of a build are palettes, with palette inheritance. |
| 5 | Palette block references | Qualified `library:block` references; no library search order. |
| 6 | Undo across sessions | Session-only for now, with the door kept open. The undo stack and the op log are one history log. |
