class_name RegionOps
extends RefCounted

# Region operations as edit lists (see VoxelWorld.apply_edits): fill a box in a style,
# replace one semantic with another, move a box, paste a clipboard with a rotation or
# mirror. Pure functions of the data they're given — they decide WHAT changes; apply_edits
# validates and commits it as one undo step. Any view or agent can use them.

const FILL_STYLES := ["solid", "hollow", "walls", "frame", "floor"]

# Whether cell p belongs to a fill of the inclusive box [mn, mx] in `style`:
#   solid  — every cell
#   hollow — the box's shell (its six faces)
#   walls  — the four vertical faces (no floor, no ceiling)
#   frame  — the twelve edges only
#   floor  — the bottom layer only
static func in_style(style: String, p: Vector3i, mn: Vector3i, mx: Vector3i) -> bool:
	var bx := int(p.x == mn.x or p.x == mx.x)
	var by := int(p.y == mn.y or p.y == mx.y)
	var bz := int(p.z == mn.z or p.z == mx.z)
	match style:
		"hollow": return bx + by + bz >= 1
		"walls": return bx + bz >= 1
		"frame": return bx + by + bz >= 2
		"floor": return p.y == mn.y
	return true

# One edit per cell of the box in `style`, each a copy of `template` (an edit without pos).
static func fill_edits(mn: Vector3i, mx: Vector3i, style: String, template: Dictionary) -> Array:
	var out: Array = []
	for y in range(mn.y, mx.y + 1):
		for z in range(mn.z, mx.z + 1):
			for x in range(mn.x, mx.x + 1):
				var p := Vector3i(x, y, z)
				if in_style(style, p, mn, mx):
					var e := template.duplicate(true)
					e["pos"] = p
					out.append(e)
	return out

# The occupied cells inside the box, walking whichever is smaller: the box or the build.
static func cells_in(data: VoxelData, mn: Vector3i, mx: Vector3i) -> Array[Vector3i]:
	var out: Array[Vector3i] = []
	var vol := (mx.x - mn.x + 1) * (mx.y - mn.y + 1) * (mx.z - mn.z + 1)
	if vol > data.cells.size():
		for p: Vector3i in data.cells:
			if p.x >= mn.x and p.x <= mx.x and p.y >= mn.y and p.y <= mx.y and p.z >= mn.z and p.z <= mx.z:
				out.append(p)
	else:
		for y in range(mn.y, mx.y + 1):
			for z in range(mn.z, mx.z + 1):
				for x in range(mn.x, mx.x + 1):
					var p := Vector3i(x, y, z)
					if data.cells.has(p):
						out.append(p)
	return out

# Swap semantic `from` for `to` inside the box: whole blocks keep their orientation and
# tags, parts keep their shape and slot (only their semantic changes).
static func replace_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, from: String, to: String) -> Array:
	var out: Array = []
	for p in cells_in(data, mn, mx):
		var cell := data.get_cell(p)
		if cell.is_shaped():
			var hit := false
			var next := cell.duplicate_cell()
			for part in next.parts:
				if str(part["semantic"]) == from:
					part["semantic"] = to
					hit = true
			if hit:
				next.sync_type_id()
				out.append({"pos": p, "op": "cell", "cell": next})
		elif cell.type_id == from:
			out.append({"pos": p, "op": "cell", "cell": BlockCell.new(to, cell.orientation, cell.tags.duplicate(true))})
	return out

# Clear the matching cells of the box (all, or only those using `semantic`; `parts_only`
# leaves whole blocks alone). A semantic filter on a part cell removes just those parts.
static func clear_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, semantic := "", parts_only := false) -> Array:
	var out: Array = []
	for p in cells_in(data, mn, mx):
		var cell := data.get_cell(p)
		if parts_only and not cell.is_shaped():
			continue
		if semantic.is_empty():
			out.append({"pos": p, "op": "clear"})
		elif cell.is_shaped():
			var keep: Array = []
			for part in cell.parts:
				if str(part["semantic"]) != semantic:
					keep.append(part)
			if keep.size() == cell.parts.size():
				continue
			if keep.is_empty():
				out.append({"pos": p, "op": "clear"})
			else:
				out.append({"pos": p, "op": "cell", "cell": BlockCell.new("", 0, cell.tags.duplicate(true), keep)})
		elif cell.type_id == semantic:
			out.append({"pos": p, "op": "clear"})
	return out

# Move the box's contents by `offset`: clear the sources, then write each at its target.
static func move_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, offset: Vector3i) -> Array:
	var cells := cells_in(data, mn, mx)
	var out: Array = []
	for p in cells:
		out.append({"pos": p, "op": "clear"})
	for p in cells:
		out.append({"pos": p + offset, "op": "cell", "cell": data.get_cell(p).duplicate_cell()})
	return out

# Paste clipboard cells (keyed relative to their box's min corner, box `size`) so the
# pasted box's min corner lands on `at`, after `xform_basis` (a rotation / mirror).
# Parts without a mirror image are returned in `rejected`.
#
# The basis is applied about the box's min corner, not its center: an axis-aligned basis maps
# integer offsets to integer offsets exactly, and the box_lo renormalization below puts the
# result's min corner on `at` either way. Turning about the center broke boxes whose x and z
# sizes differ in parity (e.g. 22 x 3): the offsets landed on half cells and rounding them
# left a one-cell gap in the middle of the paste and stretched it by a cell.
static func paste_edits(clip: Dictionary, size: Vector3i, at: Vector3i, xform_basis := Basis()) -> Dictionary:
	var t := SpatialXform.about(xform_basis, Vector3.ZERO)
	var moved := {}
	var rejected: Array = []
	for rel: Vector3i in clip:
		var q := Vector3i((t.basis * Vector3(rel)).round())
		var cell := t.apply_cell(clip[rel])
		if cell == null:
			rejected.append({"pos": at + rel, "reason": "no_mirror_image"})
			continue
		moved[q] = cell
	# The transformed box's min corner: from all eight corners, not just the occupied cells.
	var box_lo := Vector3i(1 << 30, 1 << 30, 1 << 30)
	for i in 8:
		var c := Vector3((size.x - 1) * (i & 1), (size.y - 1) * ((i >> 1) & 1), (size.z - 1) * ((i >> 2) & 1))
		var q := Vector3i((t.basis * c).round())
		box_lo = Vector3i(mini(box_lo.x, q.x), mini(box_lo.y, q.y), mini(box_lo.z, q.z))
	var out: Array = []
	for q: Vector3i in moved:
		out.append({"pos": at + (q - box_lo), "op": "cell", "cell": moved[q]})
	return {"edits": out, "rejected": rejected}

# Counts inside the box: whole blocks by semantic, parts by "semantic|shape", and the
# bounds of what's there.
static func stats(data: VoxelData, mn: Vector3i, mx: Vector3i) -> Dictionary:
	var blocks := {}
	var parts := {}
	var lo := Vector3i.ZERO
	var hi := Vector3i.ZERO
	var n := 0
	for p in cells_in(data, mn, mx):
		var cell := data.get_cell(p)
		if n == 0:
			lo = p
			hi = p
		lo = Vector3i(mini(lo.x, p.x), mini(lo.y, p.y), mini(lo.z, p.z))
		hi = Vector3i(maxi(hi.x, p.x), maxi(hi.y, p.y), maxi(hi.z, p.z))
		n += 1
		if cell.is_shaped():
			for part in cell.parts:
				var s := str(part["semantic"])
				var key := "%s|%s" % [s, part["shape"]]
				parts[key] = int(parts.get(key, 0)) + 1
		else:
			blocks[cell.type_id] = int(blocks.get(cell.type_id, 0)) + 1
	return {"cells": n, "blocks": blocks, "parts": parts, "bounds": [lo, hi] if n > 0 else []}
