class_name ShapePlacement
extends RefCounted

# Where a shaped part lands when you click a face — a port of Forge Microblocks'
# MicroblockPlacement, so pieces go exactly where a GTNH player expects. View-agnostic: a
# view supplies the hit (which cell, which face, where on it) and gets back the cell + part
# to add, already validated against VoxelWorld.can_add_part. The view only raycasts and
# draws; the rules live here.
#
#   hit_cell — the cell whose geometry was clicked (a plain block, a part cell, or — for
#              the ground plane — the cell under the floor).
#   vhit     — the hit point relative to hit_cell's min corner (0..1 on each axis).
#   side     — the clicked face's outward side (ShapeCatalog numbering, 0..5).
#   opposite — the "place on the far side" modifier (Ctrl in the 3D view).
#
# The grid on the face picks a slot. A click on a full block's face places into the
# neighboring cell; a click on the inner face of a thin part (hit depth < 1) places into
# that same cell when it fits ("internal" placement), otherwise falls back like FMP does.

const _EPS := 0.0005

# Returns { pos: Vector3i, part: Dictionary } or {} when nothing can be placed.
static func resolve(semantic: String, shape_id: String, hit_cell: Vector3i, vhit: Vector3,
		side: int, opposite: bool) -> Dictionary:
	if not VoxelWorld.active_project or not ShapeCatalog.has(shape_id) or side < 0 or side > 5:
		return {}
	var hcell := VoxelWorld.active_project.data.get_cell(hit_cell)
	if ShapeCatalog.is_exclusive(shape_id):
		return _resolve_arch(semantic, shape_id, hit_cell, hcell, vhit, side, opposite)
	var into_parts := hcell != null and hcell.is_shaped()
	var depth := vhit.dot(ShapeCatalog.SIDE_VECS[side]) + float((side % 2) ^ 1)
	var internal := into_parts and depth < 1.0 - _EPS
	var outside := hit_cell + ShapeCatalog.side_vec(side)
	var slot := ShapeCatalog.hit_slot(shape_id, vhit, side)

	if slot < 0:
		# The face's center zone: only even-size edge pieces (Post, Pillar) have a centered
		# form — a post running along the clicked face's axis.
		if ShapeCatalog.family_of(shape_id) != ShapeCatalog.Family.EDGE \
				or ShapeCatalog.size_of(shape_id) % 2 != 0:
			return {}
		var pslot := ShapeCatalog.CENTER_SLOT + (side >> 1)
		if internal and not opposite:
			return _try(semantic, shape_id, hit_cell, pslot)
		return _try(semantic, shape_id, outside, pslot)

	var oslot := ShapeCatalog.opposite_slot(shape_id, slot, side)
	var use_opp := ShapeCatalog.uses_opposite(shape_id, slot, side)
	if internal:
		if depth < 0.5 or not use_opp:
			var ret := _try(semantic, shape_id, hit_cell, slot)
			if not ret.is_empty():
				return ret if (not use_opp or not opposite) else _try(semantic, shape_id, hit_cell, oslot)
		if use_opp and not opposite:
			return _try(semantic, shape_id, hit_cell, oslot)
		return _try(semantic, shape_id, outside, slot)
	return _try(semantic, shape_id, outside, oslot if (use_opp and opposite) else slot)

# Architecture shapes (ArchitectureCraft's rules, via ArchShapes): always placed into the
# cell beside the clicked face, oriented from where on the face you clicked — or lined up
# with the clicked shape when their profiles match. `opposite` is the mod's sneak: base
# against the clicked face (a stair on its side), no lining up.
static func _resolve_arch(semantic: String, shape_id: String, hit_cell: Vector3i, hcell: BlockCell,
		vhit: Vector3, side: int, opposite: bool) -> Dictionary:
	var sv := ShapeCatalog.side_vec(side)
	# The click point relative to the new cell's center (AC's `hit`).
	var hit := vhit - Vector3(sv) - Vector3(0.5, 0.5, 0.5)
	var neighbor := {}
	if hcell != null and hcell.parts.size() == 1 and ShapeCatalog.is_exclusive(str(hcell.parts[0]["shape"])):
		neighbor = hcell.parts[0]
	var slot := ArchShapes.orient_on_placement(shape_id, side, hit, opposite, neighbor)
	return _try(semantic, shape_id, hit_cell + sv, slot)

static func _try(semantic: String, shape_id: String, pos: Vector3i, slot: int) -> Dictionary:
	var part := BlockCell.make_part(semantic, shape_id, slot)
	if not VoxelWorld.can_add_part(pos, part):
		return {}
	return {"pos": pos, "part": part}
