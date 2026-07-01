# Multipart `when` Clauses — Planning Notes

Status: **Not started — this is a planning doc for a future session**, written after the
[glass import fix](import-feature.md) surfaced how big this gap actually is on a real
vanilla install. Goal of *this* doc: capture (1) exactly how to reproduce/inspect the
problem with a disposable harness, and (2) what we already know about its shape, so the
planning session doesn't have to re-derive it from scratch.

## The problem, in one line

`MCImporter._parse_when` / `_parse_clause` (`scripts/mcimport/MCImporter.gd:163-198`)
only understands multipart `when` clauses shaped like `{ north: "true", east: "false" }`
— a boolean per cardinal direction, ORed across an array. Real vanilla data uses that
shape for simple connectors (fences, panes, iron bars, vines, glow lichen), but walls,
redstone wire, and several unrelated blocks use richer shapes the parser rejects
outright, so those parts get dropped (warned) and the block imports missing pieces or
fails entirely. This is exactly the class of block the user wants full support for
(walls today; the request also names stairs, which is a related-but-distinct gap — see
"Stairs are not actually a `when` problem" below).

## Reproduction harness

There's no committed fixture for this — the richness only shows up against a **real
vanilla jar**, which isn't (and shouldn't be) checked into the repo. The approach used
during the glass fix was a disposable scene run through headless Godot, deleted
afterward. Recreate it like this:

1. **Find a vanilla version jar.** `MCInstallLocations.candidates()`
   (`scripts/mcimport/MCInstallLocations.gd`) lists the platform's likely spots; on this
   Windows dev machine the one used was:
   ```
   C:/Users/dvr42/AppData/Roaming/.minecraft/versions/26.2/26.2.jar
   ```
   (Any version ≥ 1.8 works — the jar is a zip with `assets/minecraft/...` inside,
   which `MCZipSource` reads directly, no unzip needed for the import itself.)

2. **Create `tests/_mc_probe.gd`** (Node script, not committed — delete when done):
   ```gdscript
   extends Node

   func _ready() -> void:
       var jar := "C:/Users/dvr42/AppData/Roaming/.minecraft/versions/26.2/26.2.jar"
       var src := MCZipSource.new(jar)
       var ws := VoxelWorkspace.new()
       var lib := ws.get_or_add_library("probe")
       var imp := MCImporter.new(src, lib)
       imp.import_namespace("minecraft")
       print("imported: %d" % imp.imported_blocks.size())
       print("warnings: %d" % imp.warnings.size())
       var counts := {}
       for w in imp.warnings:
           var head := w.split(":")[0]
           counts[head] = int(counts.get(head, 0)) + 1
       for k in counts:
           print("  %s: %d" % [k, counts[k]])
       print("---- unhandled 'when' warnings ----")
       for w in imp.warnings:
           if w.contains("unhandled 'when'"):
               print(w)
       src.close()
       get_tree().quit(0)
   ```

3. **Create `tests/_mc_probe.tscn`** wrapping it (same pattern as `tests/SmokeTest.tscn`):
   ```
   [gd_scene load_steps=2 format=3]

   [ext_resource type="Script" path="res://tests/_mc_probe.gd" id="1"]

   [node name="McProbe" type="Node"]
   script = ExtResource("1")
   ```

4. **Run it headless** (Godot lives at `/c/godot.exe` on this machine — see
   `windows-godot-toolchain` memory):
   ```bash
   cd /c/Users/dvr42/git/voxyl
   /c/godot.exe --headless --path . res://tests/_mc_probe.tscn 2>&1 \
     | grep -v "^WARNING:" | grep -v "^ERROR: [0-9]* RID"
   ```
   Takes ~60-90s importing the full `minecraft` namespace (~1000+ blocks); ran it via
   `run_in_background` last time rather than blocking on it.

5. **Delete both files when done** — they're a scratch harness, not a fixture. (If this
   investigation recurs often enough, consider promoting a *trimmed* synthetic jar with
   just the offending blockstate/model/texture files as a real committed test fixture
   instead of depending on a real MC install — see "Open questions" below.)

To drill into one specific block's raw JSON instead of running the whole importer,
extract just what's needed straight from the jar (it's a zip):
```bash
unzip -o "<jar>" -d /tmp/mcjar
cat /tmp/mcjar/assets/minecraft/blockstates/andesite_wall.json
```

## What the harness currently reports

Against `26.2.jar`'s `minecraft` namespace, post-glass-fix:

```
imported: 1082
warnings: 922
  multipart part skipped (unhandled 'when'): 685
  multipart had no usable parts: 19
  model has no usable geometry: 115
  all variant models failed to import: 97
  texture image missing: 6
```

The `685` is the one this plan is about. `102` vanilla blockstates use `multipart` at
all; most (fences, panes, iron/copper bars, vines, glow lichen, sculk vein, chorus
plant, fire) are pure boolean direction flags and already import fine. The failures
cluster into a few distinct shapes — see below.

## Taxonomy of `when` shapes the parser can't handle yet

Current code (`_parse_when` / `_parse_clause`) accepts: no `when` (always-on), a bare
clause (AND of `dir: "true"/"false"` pairs), or `{"OR": [clause, ...]}`. Rejects
`{"AND": [...]}` at the top level, and rejects any clause whose value isn't literally
`"true"`/`"false"`. Real data needs more:

1. **Multi-value direction state** (the actual "walls/stairs" case the user cares about)
   — `andesite_wall.json` and ~30 other `*_wall.json` files:
   ```json
   { "apply": {"model": "...wall_side", "uvlock": true}, "when": {"north": "low"} }
   { "apply": {"model": "...wall_side_tall"}, "when": {"north": "tall"} }
   ```
   A wall's connection per direction is tri-state (`none`/`low`/`tall`), not boolean —
   "low" if the neighbor is a short shape, "tall" if it's a full-height block/wall.
   This needs (a) `BlockStateMap`'s clause value widened from bool to a string/enum,
   and (b) `View3D._cell_connections` (`scripts/views/View3D.gd:896`) — currently a
   flat "is neighbor occupied" bool per direction — extended to derive that tri-state
   from the neighbor's actual shape, not just its presence.

2. **Pipe-shorthand OR-within-a-value** — `redstone_wire.json`:
   ```json
   { "north": "side|up" }
   ```
   means "north is side OR up". Same widening as #1, plus splitting on `|` when
   matching. Redstone wire's `up` state specifically means "climbing the side of an
   adjacent solid block" — a fairly deep MC-specific mechanic; may not be worth full
   fidelity (see open questions).

3. **Non-direction, non-boolean properties treated as connection keys** —
   `bamboo.json` (`"age": "0"`), `pink_petals.json`/`wildflowers.json`
   (`"flower_amount": "2|3|4"`), `chiseled_bookshelf.json` (`"slot_0_occupied":
   "true"`). These aren't neighbor connections at all — they're growth-stage or
   container-content state voxyl has no data for (no block entities, no "age" tick).
   The existing precedent is `_parse_variants`' `shape=straight` flattening for
   stairs (`MCImporter.gd:227-232`): pick one canonical value per unmodeled property
   and only import the rule(s) matching it, dropping the rest — not "unhandled",
   just "flattened to a default", the same move already made for `waterlogged` etc.

4. **Top-level `{"AND": [...]}`** — `chiseled_bookshelf.json` combines a placement
   property (`facing`) with a content property (`slot_N_occupied`) via explicit `AND`.
   Once #3's flattening exists, most `AND` cases collapse to a single non-rejected
   clause (fix the content property to its default, keep only the facing condition) —
   may not need dedicated `AND` parsing at all if #3 is done first.

## Stairs are not actually a `when` problem

Worth flagging since the user named stairs alongside walls: stairs use blockstate
**`variants`**, not `multipart`. `_parse_variants` already flattens every
`shape=inner_*/outer_*` corner variant down to the single `shape=straight` resting
form (`MCImporter.gd:227-232`) specifically because — like multipart connections —
corner shapes are *contextual on neighbors*, which voxyl declines to bake into
`BlockStateMap` (connections are derived at render time, never stored). Real support
for stair corners is a render-time neighbor-shape-inference problem analogous to #1
above, but through a completely different code path (`BlockStateMap.resolve()` /
`entries`, not `resolve_parts()` / `parts`). If the next session wants stairs corners
too, treat it as a second, parallel problem sharing the same underlying need ("infer a
neighbor's shape at render time") rather than an extension of the `when`-clause parser.

## Where the code lives

- `scripts/mcimport/MCImporter.gd:126-198` — `_import_multipart`, `_parse_when`,
  `_parse_clause`: MC `when` JSON → neutral clause form. This is the translation layer
  to extend.
- `scripts/core/BlockStateMap.gd:95-138` — `parts`, `add_part`, `resolve_parts`,
  `_part_applies`: the neutral multipart representation. Clause values are currently
  `{dir:int -> bool}`; widening the value type is a data-shape change here too.
- `scripts/views/View3D.gd:866-902` — `_resolve_cell_parts`, `_cell_connections`: where
  connection flags are *derived from neighbor occupancy at render time* (never stored
  on the cell — this is load-bearing per CLAUDE.md's "views are lenses" principle).
  Tri-state wall connections need this to inspect the neighbor's `BlockType`/shape, not
  just its presence.

## Open questions for the planning session

- How far to chase MC-specific rendering fidelity (redstone's up-the-wall climb,
  book-slot overlays) vs. flattening to a default, given voxyl's voxel-agnostic
  mandate (CLAUDE.md principle 4) — these mechanics don't generalize to other games'
  block sets.
- Whether "neighbor shape" (needed for wall tri-state and stair corners alike) becomes
  a shared, named concept in `BlockType`/`BlockModel` (e.g. a coarse height/solidity
  classification) rather than two bespoke solutions.
- Whether a trimmed, committed synthetic-jar fixture (a handful of hand-built
  blockstate/model/texture files covering wall tri-state + redstone pipe-OR) belongs in
  `tests/` so this stops depending on a real MC install for regression coverage, versus
  keeping it a manual, real-jar-only harness like this one.
