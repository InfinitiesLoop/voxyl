class_name BlockStateMap
extends Resource

# Neutral, voxel-agnostic translation of "which model (and extra rotation) renders
# for a given block placement". Generalizes Minecraft's blockstate `variants`, but
# carries ZERO MC concepts — it speaks only in voxyl's own Orientation (facing +
# top half) plus an explicit model rotation. The MC importer is the only thing that
# knows how to *fill* one of these; nothing here references namespaces or MC ids.
#
# Nested directly on the BlockType it configures (decision 5 — it's purely that one
# block's binding of orientation → model). Models are still referenced by *id* into
# the workspace library, never inlined.
#
# Two complementary forms, mirroring Minecraft's two blockstate shapes — but kept
# neutral (no MC ids, no property strings):
#
#   `entries` (variants) — one model per orientation, with an optional model
#     rotation (x/y degrees) the view applies in place of Orientation.basis_of.
#     An entry is a Dictionary:
#       { facing: int, top: bool, model_id: String, x_rot: int, y_rot: int, uvlock: bool }
#     `facing` == -1 marks the catch-all default (a state-less block, or the
#     fallback when no facing matches). x_rot/y_rot are degrees (0/90/180/270);
#     they encode the orientation the variant baked in, so a view consuming the
#     map rotates by these instead of deriving a basis from `facing` (which would
#     double-rotate).
#
#   `parts` (multipart) — a connecting block (fence, pane, bars, wall, redstone-style
#     wiring): a list of model parts, each shown when its connection condition
#     matches. A part is:
#       { when: Array, model_id: String, x_rot: int, y_rot: int, uvlock: bool }
#     `when` is the neutral connection condition: an Array of clauses with OR
#     semantics (the part shows if ANY clause holds); each clause is a Dictionary
#     mapping a direction (BlockModel.Dir, 0..5) to a required value, ANDed together.
#     A direction's *actual* connection state (computed by the view at render time,
#     see `resolve_parts`) is one of three neutral Strings: "none" (no neighbor),
#     "low" (a neighbor present with a short/thin profile), "tall" (a neighbor
#     present with a full-height profile) — the vocabulary walls already use in MC,
#     generalized to any connecting block. A clause's required value per direction is
#     one of:
#       bool     — legacy/simple occupancy ("true"/"false" in MC): matches whenever
#                   the direction is occupied at all (actual != "none"), regardless
#                   of low/tall. This is what every existing fence/pane/bars/vine part
#                   already stores, so old saved data keeps matching unchanged.
#       String   — exact match against the actual state (e.g. "low" or "tall").
#       Array    — OR across the listed states (MC's pipe-shorthand, e.g. "side|up"
#                  on redstone wire, translated to e.g. ["low","tall"]).
#     An empty `when` ([]) means "always show" — the post/core part. Connection
#     states themselves are DERIVED at render time from neighbor occupancy + shape;
#     nothing about connections is ever stored on the voxel data (same as MC).
#
# A block is one or the other: `parts` non-empty → multipart; else `entries`.

const ANY_FACING := -1

@export var entries: Array = []   # Array[Dictionary] — variant entries, see above
@export var parts: Array = []     # Array[Dictionary] — multipart parts, see above

func is_empty() -> bool:
	return entries.is_empty() and parts.is_empty()

# True when this map's variants include an UP or DOWN facing — barrels, dispensers,
# logs, pistons, … — as opposed to only the 4 horizontal facings (stairs, slabs,
# which instead vary by the top/bottom half). Derived straight from the entries an
# importer filled in, so it's data-driven rather than a per-block-name special case:
# any block whose own blockstate uses a vertical facing gets oriented across all 6
# directions; anything else keeps the horizontal-facing + half scheme.
func has_vertical_facing() -> bool:
	for e in entries:
		var f: int = e.get("facing", ANY_FACING)
		if f == Orientation.Facing.UP or f == Orientation.Facing.DOWN:
			return true
	return false

# True when this is a connecting/multipart block (driven by `parts`). The view
# computes connection flags from neighbors and selects parts via resolve_parts().
func is_multipart() -> bool:
	return not parts.is_empty()

# Add one orientation → model binding. `facing` is an Orientation.Facing value, or
# ANY_FACING for the default/state-less entry.
func add_variant(facing: int, top: bool, model_id: String,
		x_rot: int = 0, y_rot: int = 0, uvlock: bool = false) -> void:
	entries.append({
		"facing": facing, "top": top, "model_id": model_id,
		"x_rot": x_rot, "y_rot": y_rot, "uvlock": uvlock,
	})

# Best entry for a placement: exact (facing + top) wins, then facing-only, then the
# ANY_FACING default, then the first entry. Returns {} only when there are none.
# Callers read `model_id` / `x_rot` / `y_rot` off the result.
func resolve(orientation: int) -> Dictionary:
	if entries.is_empty():
		return {}
	var facing := Orientation.facing_of(orientation)
	var top := Orientation.is_top(orientation)
	var facing_match := {}
	var default_match := {}
	for e in entries:
		var ef: int = e.get("facing", ANY_FACING)
		if ef == ANY_FACING:
			if default_match.is_empty():
				default_match = e
			continue
		if ef == facing:
			if bool(e.get("top", false)) == top:
				return e
			if facing_match.is_empty():
				facing_match = e
	if not facing_match.is_empty():
		return facing_match
	if not default_match.is_empty():
		return default_match
	return entries[0]

# The model id rendered at the resting orientation (facing NORTH, bottom half) —
# the one BlockType.model_id should point at so non-orientation-aware views and the
# current 3D path still resolve geometry. "" when the map is empty.
func default_model_id() -> String:
	var e := resolve(Orientation.make(Orientation.Facing.NORTH, false))
	return str(e.get("model_id", "")) if not e.is_empty() else ""

# --- Multipart (connecting blocks) -----------------------------------------

# Add one multipart part. `when` is the OR-of-clauses condition ([] = always);
# each clause is a Dictionary { dir:int -> required }, where `required` is a bool
# (occupancy-only match), a String ("none"/"low"/"tall" exact match), or an Array of
# Strings (OR across states) — see the class doc comment above.
func add_part(when_clauses: Array, model_id: String,
		x_rot: int = 0, y_rot: int = 0, uvlock: bool = false) -> void:
	parts.append({
		"when": when_clauses, "model_id": model_id,
		"x_rot": x_rot, "y_rot": y_rot, "uvlock": uvlock,
	})

# Parts to render for a set of derived connection states (dir:int -> "none"/"low"/
# "tall", see the class doc comment). A part applies when its `when` is empty, or any
# clause matches (every dir requirement in the clause is satisfied by that direction's
# actual state). Returns them in declaration order so the always-on post draws first.
func resolve_parts(connections: Dictionary) -> Array:
	var out: Array = []
	for p in parts:
		if _part_applies(p, connections):
			out.append(p)
	return out

func _part_applies(part: Dictionary, connections: Dictionary) -> bool:
	var clauses: Array = part.get("when", [])
	if clauses.is_empty():
		return true
	for clause in clauses:           # OR across clauses
		var matched := true
		for dir in clause:           # AND within a clause
			var raw = connections.get(int(dir), "none")
			# Normalize to a canonical String so a legacy bool connection value
			# (still passed directly in a couple of data-layer tests) can't
			# stringify to "false"/"true" and accidentally dodge/satisfy a "none"
			# comparison: false always means "none", true is a distinct non-"none"
			# sentinel (never equal to "low"/"tall"). Checked by type (`is`), not
			# `==`, since GDScript errors comparing a bool to a String directly.
			var actual: String
			if raw is bool:
				actual = "true" if raw else "none"
			else:
				actual = str(raw)
			var required = clause[dir]
			var dir_matched: bool
			if required is bool:
				dir_matched = (actual != "none") == required
			elif required is String:
				dir_matched = actual == required
			elif required is Array:
				dir_matched = required.has(actual)
			else:
				dir_matched = false
			if not dir_matched:
				matched = false
				break
		if matched:
			return true
	return false

# The model id for the always-on part (the post/core), so BlockType.model_id and
# non-multipart-aware code still resolve a sensible single model. Falls back to the
# first part, then "".
func default_part_model_id() -> String:
	for p in parts:
		if (p.get("when", []) as Array).is_empty():
			return str(p.get("model_id", ""))
	return str(parts[0].get("model_id", "")) if not parts.is_empty() else ""
