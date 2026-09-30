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
# `positions` (a mask) fills exactly those cells instead, ignoring `style`. Otherwise, a
# non-empty `filter` restricts the dense fill to cells whose EXISTING content matches it
# (a "paint over just the filtered cells" fill); needs `data` only in that case.
static func fill_edits(mn: Vector3i, mx: Vector3i, style: String, template: Dictionary,
		filter := {}, positions: Variant = null, data: VoxelData = null) -> Array:
	var out: Array = []
	if positions != null:
		for p: Vector3i in positions:
			var e := template.duplicate(true)
			e["pos"] = p
			out.append(e)
		return out
	if not filter.is_empty() and data != null:
		for p in cells_in(data, mn, mx, filter):
			if in_style(style, p, mn, mx):
				var e := template.duplicate(true)
				e["pos"] = p
				out.append(e)
		return out
	for y in range(mn.y, mx.y + 1):
		for z in range(mn.z, mx.z + 1):
			for x in range(mn.x, mx.x + 1):
				var p := Vector3i(x, y, z)
				if in_style(style, p, mn, mx):
					var e := template.duplicate(true)
					e["pos"] = p
					out.append(e)
	return out

# Whether `semantic` passes `filter` ({whitelist?, blacklist?} — both optional/empty
# means match everything). Whitelist non-empty restricts to those names; blacklist
# always excludes, checked after.
static func filter_ok(filter: Dictionary, semantic: String) -> bool:
	if filter.is_empty():
		return true
	var wl: Array = filter.get("whitelist", [])
	if not wl.is_empty() and not (semantic in wl):
		return false
	var bl: Array = filter.get("blacklist", [])
	return not (semantic in bl)

# Whether `cell` has any content passing `filter`: a whole block's type_id, or (for a
# shaped cell) at least one part's semantic.
static func matches_filter(cell: BlockCell, filter: Dictionary) -> bool:
	if filter.is_empty():
		return true
	if cell.is_shaped():
		for part in cell.parts:
			if filter_ok(filter, str(part["semantic"])):
				return true
		return false
	return filter_ok(filter, cell.type_id)

# `filter` with `extra_blacklist` names folded into its blacklist (used by cells_without's
# `exclude` argument, which predates the general filter and is sugar for a blacklist-only one).
static func merge_filter(filter: Dictionary, extra_blacklist: Array) -> Dictionary:
	if extra_blacklist.is_empty():
		return filter
	var bl: Array = (filter.get("blacklist", []) as Array).duplicate()
	for s in extra_blacklist:
		if not (s in bl):
			bl.append(s)
	var out := filter.duplicate(true) if not filter.is_empty() else {}
	out["blacklist"] = bl
	return out

# A copy of `cell` with only the content passing `filter` (parts kept, or the whole block
# if it passes) — null if nothing survives. The building block for "copy/keep the filtered
# selection" (cells_without) and "move the filtered selection" (move_edits, transform_edits).
static func keep_content(cell: BlockCell, filter: Dictionary) -> Variant:
	if filter.is_empty():
		return cell.duplicate_cell()
	if cell.is_shaped():
		var keep: Array = []
		for part in cell.parts:
			if filter_ok(filter, str(part["semantic"])):
				keep.append(part)
		if keep.is_empty():
			return null
		var c := cell.duplicate_cell()
		c.parts = keep.duplicate(true)
		c.sync_type_id()
		return c
	if filter_ok(filter, cell.type_id):
		return cell.duplicate_cell()
	return null

# The inverse of keep_content: what happens to `cell` when its matching content (parts
# named `semantic`, or all parts if `semantic` is empty, further gated by `filter`) is
# removed — null if nothing matches, {"clear": true} if the whole position empties out,
# else {"cell": <the remaining BlockCell>}. Shared by clear_edits, move_edits and
# transform_edits so "delete/move/rotate just the filtered content of a mixed cell" is
# one piece of logic.
static func remove_matching(cell: BlockCell, semantic: String, filter: Dictionary) -> Variant:
	if cell.is_shaped():
		var keep: Array = []
		var removed := false
		for part in cell.parts:
			var s := str(part["semantic"])
			if (semantic.is_empty() or s == semantic) and filter_ok(filter, s):
				removed = true
			else:
				keep.append(part)
		if not removed:
			return null
		if keep.is_empty():
			return {"clear": true}
		return {"cell": BlockCell.new("", 0, cell.tags.duplicate(true), keep)}
	if (semantic.is_empty() or cell.type_id == semantic) and filter_ok(filter, cell.type_id):
		return {"clear": true}
	return null

# The occupied cells inside the box matching `filter`, walking whichever is smaller: the
# box or the build. `positions` (non-null) replaces the box scan with that explicit list —
# how a selection mask (grow/shrink) feeds every region operation without changing them.
static func cells_in(data: VoxelData, mn: Vector3i, mx: Vector3i, filter := {}, positions: Variant = null) -> Array[Vector3i]:
	var out: Array[Vector3i] = []
	var candidates: Array = []
	if positions != null:
		candidates = positions
	else:
		var vol := (mx.x - mn.x + 1) * (mx.y - mn.y + 1) * (mx.z - mn.z + 1)
		if vol > data.cells.size():
			for p: Vector3i in data.cells:
				if p.x >= mn.x and p.x <= mx.x and p.y >= mn.y and p.y <= mx.y and p.z >= mn.z and p.z <= mx.z:
					candidates.append(p)
		else:
			for y in range(mn.y, mx.y + 1):
				for z in range(mn.z, mx.z + 1):
					for x in range(mn.x, mx.x + 1):
						candidates.append(Vector3i(x, y, z))
	for p: Vector3i in candidates:
		if data.cells.has(p) and matches_filter(data.cells[p], filter):
			out.append(p)
	return out

# Swap semantic `from` for `to` inside the box (optionally narrowed by `filter`/`positions`):
# whole blocks keep their orientation and tags, parts keep their shape and slot (only
# their semantic changes).
static func replace_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, from: String, to: String,
		filter := {}, positions: Variant = null) -> Array:
	if not filter_ok(filter, from):
		return []
	var out: Array = []
	for p in cells_in(data, mn, mx, filter, positions):
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
# `filter`/`positions` narrow which cells count as "in" the region the same way every
# other RegionOps function does; a mixed cell with some content outside the filter keeps
# that content and only loses the matching parts.
static func clear_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, semantic := "", parts_only := false,
		filter := {}, positions: Variant = null) -> Array:
	var out: Array = []
	for p in cells_in(data, mn, mx, filter, positions):
		var cell := data.get_cell(p)
		if parts_only and not cell.is_shaped():
			continue
		var r: Variant = remove_matching(cell, semantic, filter)
		if r == null:
			continue
		if r.get("clear", false):
			out.append({"pos": p, "op": "clear"})
		else:
			out.append({"pos": p, "op": "cell", "cell": r["cell"]})
	return out

# Move the box's contents by `offset` (optionally narrowed by `filter`/`positions`): clear
# the matching content at each source (leaving behind whatever didn't match), then write
# just that content at the target.
static func move_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, offset: Vector3i,
		filter := {}, positions: Variant = null) -> Array:
	var out: Array = []
	var moving := {}
	for p in cells_in(data, mn, mx, filter, positions):
		var cell := data.get_cell(p)
		var kept: Variant = keep_content(cell, filter)
		if kept == null:
			continue
		moving[p] = kept
		var removal: Variant = remove_matching(cell, "", filter)
		if removal == null:
			continue
		if removal.get("clear", false):
			out.append({"pos": p, "op": "clear"})
		else:
			out.append({"pos": p, "op": "cell", "cell": removal["cell"]})
	for p: Vector3i in moving:
		out.append({"pos": p + offset, "op": "cell", "cell": moving[p]})
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

# Copies of the box's cells (position → BlockCell) with the `exclude` semantics left out
# (sugar for a blacklist-only filter — see merge_filter), plus anything a `filter`/
# `positions` narrows out: whole blocks dropped, their parts removed from part cells (a
# cell left with no parts is dropped too).
static func cells_without(data: VoxelData, mn: Vector3i, mx: Vector3i, exclude: Array = [],
		filter := {}, positions: Variant = null) -> Dictionary:
	var eff := merge_filter(filter, exclude)
	var out := {}
	for p in cells_in(data, mn, mx, eff, positions):
		var kept: Variant = keep_content(data.get_cell(p), eff)
		if kept != null:
			out[p] = kept
	return out

# Semantic → count inside the box (cells for whole blocks, parts for part cells), narrowed
# by `filter`/`positions`.
static func semantic_counts(data: VoxelData, mn: Vector3i, mx: Vector3i, filter := {}, positions: Variant = null) -> Dictionary:
	var counts := {}
	for p in cells_in(data, mn, mx, filter, positions):
		var cell := data.get_cell(p)
		if cell.is_shaped():
			for part in cell.parts:
				var s := str(part["semantic"])
				if filter_ok(filter, s):
					counts[s] = int(counts.get(s, 0)) + 1
		else:
			counts[cell.type_id] = int(counts.get(cell.type_id, 0)) + 1
	return counts

# Place cells keyed relative to a box (a prefab) so its `anchor` cell lands on `at`, after
# `xform_basis` turns / mirrors them about that anchor. `renames` renames semantics on the way
# in ({from: to}). Parts without a mirror image come back in `rejected`.
static func place_edits(cells: Dictionary, anchor: Vector3i, at: Vector3i, xform_basis := Basis(), renames := {}) -> Dictionary:
	var t := SpatialXform.about(xform_basis, Vector3.ZERO)
	var out: Array = []
	var rejected: Array = []
	for rel: Vector3i in cells:
		var src: BlockCell = cells[rel]
		if not renames.is_empty():
			src = remap_cell(src, renames)
		var pos := at + t.apply_pos(rel - anchor)
		var cell := t.apply_cell(src)
		if cell == null:
			rejected.append({"pos": pos, "reason": "no_mirror_image"})
			continue
		out.append({"pos": pos, "op": "cell", "cell": cell})
	return {"edits": out, "rejected": rejected}

# A copy of `cell` with its semantics renamed through `renames` ({from: to}).
static func remap_cell(cell: BlockCell, renames: Dictionary) -> BlockCell:
	var out := cell.duplicate_cell()
	if out.is_shaped():
		for part in out.parts:
			var s := str(part["semantic"])
			if renames.has(s):
				part["semantic"] = str(renames[s])
		out.sync_type_id()
	elif renames.has(out.type_id):
		out.type_id = str(renames[out.type_id])
	return out

# The basis for `rotate` quarter turns clockwise seen from above, then an optional mirror
# ("x" flips east-west, "z" flips north-south) — what paste and prefab placement take.
static func turn_basis(rotate: int, mirror := "") -> Basis:
	var b := Basis(Vector3.UP, deg_to_rad(-90.0 * (posmod(rotate, 4))))
	match mirror:
		"x": b = Basis(Vector3(-1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, 1)) * b
		"z": b = Basis(Vector3(1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, -1)) * b
	return b

# Counts inside the box (narrowed by `filter`/`positions`): whole blocks by semantic,
# parts by "semantic|shape", and the bounds of what's there.
static func stats(data: VoxelData, mn: Vector3i, mx: Vector3i, filter := {}, positions: Variant = null) -> Dictionary:
	var blocks := {}
	var parts := {}
	var lo := Vector3i.ZERO
	var hi := Vector3i.ZERO
	var n := 0
	for p in cells_in(data, mn, mx, filter, positions):
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
				if not filter_ok(filter, s):
					continue
				var key := part_key(s, str(part["shape"]))
				parts[key] = int(parts.get(key, 0)) + 1
		else:
			blocks[cell.type_id] = int(blocks.get(cell.type_id, 0)) + 1
	return {"cells": n, "blocks": blocks, "parts": parts, "bounds": [lo, hi] if n > 0 else []}

# The key `stats` files a part's count under ("Semantic|shape"), and back. Every reader of
# stats' `parts` goes through these so the format is spelled in one place.
static func part_key(semantic: String, shape: String) -> String:
	return "%s|%s" % [semantic, shape]

static func split_part_key(key: String) -> Array:
	var cut := key.rfind("|")
	return [key.substr(0, cut), key.substr(cut + 1)]

# Semantic → count for a `stats` result: whole-block cells plus parts, each under its own
# semantic (what RegionOps.semantic_counts gives, but from already-tallied stats).
static func stats_semantic_counts(tally: Dictionary) -> Dictionary:
	var counts := {}
	var blocks: Dictionary = tally.get("blocks", {})
	for s: String in blocks:
		counts[s] = int(counts.get(s, 0)) + int(blocks[s])
	var parts: Dictionary = tally.get("parts", {})
	for key: String in parts:
		var s: String = split_part_key(key)[0]
		counts[s] = int(counts.get(s, 0)) + int(parts[key])
	return counts

# Rotate/mirror the matching content of the box in place via `t` (any pivot already baked
# in, e.g. SpatialXform.about). Only cells matching `filter`/`positions` are touched; a
# mixed cell keeps its non-matching content where it is and only the matching parts move.
# Parts without a mirror image come back in `rejected`, same as paste_edits.
static func transform_edits(data: VoxelData, mn: Vector3i, mx: Vector3i, t: SpatialXform,
		filter := {}, positions: Variant = null) -> Dictionary:
	var edits: Array = []
	var rejected: Array = []
	var moving := {}
	for p in cells_in(data, mn, mx, filter, positions):
		var cell := data.get_cell(p)
		var kept: Variant = keep_content(cell, filter)
		if kept == null:
			continue
		var removal: Variant = remove_matching(cell, "", filter)
		if removal != null:
			if removal.get("clear", false):
				edits.append({"pos": p, "op": "clear"})
			else:
				edits.append({"pos": p, "op": "cell", "cell": removal["cell"]})
		var np := t.apply_pos(p)
		var nc := t.apply_cell(kept)
		if nc == null:
			rejected.append({"pos": p, "reason": "no_mirror_image", "detail": "a part here has no mirror image"})
			continue
		moving[np] = nc
	for np: Vector3i in moving:
		edits.append({"pos": np, "op": "cell", "cell": moving[np]})
	return {"edits": edits, "rejected": rejected}
