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
# Phase 2 scope: `variants` — one model per orientation, with an optional MC-style
# model rotation (x/y degrees) the view applies in place of Orientation.basis_of.
# Phase 3 will extend this with neighbor-connection flags for fences/walls/panes.
#
# An entry is a Dictionary:
#   { facing: int, top: bool, model_id: String, x_rot: int, y_rot: int, uvlock: bool }
# `facing` == -1 marks the catch-all default (a state-less block, or the fallback
# when no facing matches). x_rot/y_rot are degrees (0/90/180/270); they encode the
# orientation the MC variant baked in, so a view consuming the map rotates by these
# instead of deriving a basis from `facing` (which would double-rotate).

const ANY_FACING := -1

@export var entries: Array = []   # Array[Dictionary] — see above

func is_empty() -> bool:
	return entries.is_empty()

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
