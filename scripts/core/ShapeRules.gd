class_name ShapeRules
extends RefCounted

# Which shaped parts may share one cell — a port of Forge Microblocks' occlusion rules
# (TSlottedTile, TMicroOcclusion, TNormalOcclusion, PartialOcclusionTest), so anything
# Voxyl lets you build can exist in-game and a future exporter never meets a cell it can't
# represent. See .plans/shaped-parts.md ("Validation").
#
# Works on plain part dictionaries { semantic, shape, slot } and nothing else: validity is
# a function of the cell's own data, never the palette. Where FMP asks "same material?",
# this asks "same semantic?" — two different semantics might map to the same block, but
# treating them as different is the stricter reading, so no palette edit can ever turn a
# valid cell invalid.

# Whether `part` can be added to a cell already holding `existing` parts.
static func can_add(existing: Array, part: Dictionary) -> bool:
	var shape := str(part.get("shape", ""))
	var slot := int(part.get("slot", -1))
	if not ShapeCatalog.is_valid_slot(shape, slot):
		return false
	# One part per slot (faces and hollow faces share the six face slots).
	var fslot := fmp_slot(part)
	if fslot >= 0:
		for p in existing:
			if fmp_slot(p) == fslot:
				return false
	# Pairwise tests, both directions (TileMultipart.occlusionTest).
	for p in existing:
		if not _occlusion_test(p, part) or not _occlusion_test(part, p):
			return false
	# Every part must stay at least partly visible.
	var all := existing.duplicate()
	all.append(part)
	return _partial_occlusion_ok(all)

# Whether a whole list of parts is a valid cell (each added in turn).
static func is_valid_cell(parts: Array) -> bool:
	var acc: Array = []
	for p in parts:
		if not can_add(acc, p):
			return false
		acc.append(p)
	return true

# FMP's slot index for a slotted part (faces 0-5, corners 7-14, edges 15-26), or -1 for a
# centered post, which isn't slotted.
static func fmp_slot(part: Dictionary) -> int:
	var shape := str(part.get("shape", ""))
	var slot := int(part.get("slot", -1))
	match ShapeCatalog.family_of(shape):
		ShapeCatalog.Family.FACE, ShapeCatalog.Family.HOLLOW:
			return slot
		ShapeCatalog.Family.CORNER:
			return 7 + slot
		ShapeCatalog.Family.EDGE:
			return -1 if slot >= ShapeCatalog.CENTER_SLOT else 15 + slot
	return -1

static func _is_post(part: Dictionary) -> bool:
	return ShapeCatalog.is_centered(str(part.get("shape", "")), int(part.get("slot", -1)))

static func _size(part: Dictionary) -> int:
	return ShapeCatalog.size_of(str(part.get("shape", "")))

static func _family(part: Dictionary) -> int:
	return ShapeCatalog.family_of(str(part.get("shape", "")))

static func _partial(part: Dictionary) -> Array[AABB]:
	return ShapeCatalog.partial_boxes(str(part.get("shape", "")), int(part.get("slot", -1)))

static func _hard(part: Dictionary) -> Array[AABB]:
	return ShapeCatalog.hard_boxes(str(part.get("shape", "")), int(part.get("slot", -1)))

# a.occlusionTest(b) — true when `a` tolerates `b` next to it.
static func _occlusion_test(a: Dictionary, b: Dictionary) -> bool:
	if _is_post(a):
		if _is_post(b):
			return int(a["slot"]) != int(b["slot"])   # posts on different axes may cross
		# A face (not hollow) on the post's own axis caps it — allowed.
		if _family(b) == ShapeCatalog.Family.FACE and (int(b["slot"]) >> 1) == int(a["slot"]) - ShapeCatalog.CENTER_SLOT:
			return true
		return _normal_test(a, b)
	# Hollow faces carry hard boxes too (normal occlusion) on top of the micro rules.
	if _family(a) == ShapeCatalog.Family.HOLLOW and not _normal_test(a, b):
		return false
	if _is_post(b):
		return true    # the micro rules only apply between slotted parts
	return _micro_test(a, b)

# a's hard boxes must not intersect any of b's hard or partial boxes.
static func _normal_test(a: Dictionary, b: Dictionary) -> bool:
	var mine := _hard(a)
	if mine.is_empty():
		return true
	var theirs: Array[AABB] = _hard(b)
	theirs.append_array(_partial(b))
	for m in mine:
		for t in theirs:
			if m.intersects(t):
				return false
	return true

# Render priority class of an FMP slot: faces 2, corners 1, edges 0.
static func _shape_priority(fslot: int) -> int:
	if fslot < 6:
		return 2
	if fslot < 15:
		return 1
	return 0

# TMicroOcclusion.occlusionTest: slotted parts whose sizes sum past a full block may still
# collide depending on where they sit (and, for some pairs, whether they're the same
# material).
static func _micro_test(a: Dictionary, b: Dictionary) -> bool:
	if _size(a) + _size(b) <= 8:
		return true
	var s1 := fmp_slot(a)
	var s2 := fmp_slot(b)
	var p1 := _shape_priority(s1)
	var p2 := _shape_priority(s2)
	if p1 == 2 and p2 == 2 and s2 == (s1 ^ 1):
		return false     # opposite faces overlap
	if str(a.get("semantic", "")) == str(b.get("semantic", "")):
		return true
	if p1 == 1 and p2 == 1:
		var mask := (s1 - 7) ^ (s2 - 7)
		if mask == 3 or mask == 5 or mask == 6:
			return false
	if p1 == 0 and p2 == 1 and not _edge_corner_ok(s1 - 15, s2 - 7):
		return false
	if p1 == 1 and p2 == 0 and not _edge_corner_ok(s2 - 15, s1 - 7):
		return false
	if p1 == 0 and p2 == 0:
		var e1 := s1 - 15
		var e2 := s2 - 15
		if (e1 & 0xC) == (e2 & 0xC) and ((e1 & 3) ^ (e2 & 3)) == 3:
			return false
	return true

static func _edge_corner_ok(e: int, c: int) -> bool:
	return (c & ShapeCatalog.edge_axis_mask(e)) == ShapeCatalog.unpack_edge_bits(e)

# PartialOcclusionTest: rasterize every part's partial boxes onto an 8×8×8 grid; each part
# (bar hollow faces, which may be fully covered) must own at least one sub-voxel alone.
static func _partial_occlusion_ok(parts: Array) -> bool:
	var grid := PackedInt32Array()
	grid.resize(512)
	grid.fill(0)
	for i in parts.size():
		for box in _partial(parts[i]):
			var x0 := int(box.position.x * 8.0 + 0.5); var x1 := int(box.end.x * 8.0 + 0.5)
			var y0 := int(box.position.y * 8.0 + 0.5); var y1 := int(box.end.y * 8.0 + 0.5)
			var z0 := int(box.position.z * 8.0 + 0.5); var z1 := int(box.end.z * 8.0 + 0.5)
			for x in range(x0, x1):
				for y in range(y0, y1):
					for z in range(z0, z1):
						var k := (x * 8 + y) * 8 + z
						grid[k] = i + 1 if grid[k] == 0 else -1
	var visible := {}
	for v in grid:
		if v > 0:
			visible[v - 1] = true
	for i in parts.size():
		if _family(parts[i]) == ShapeCatalog.Family.HOLLOW:
			continue
		if not visible.has(i):
			return false
	return true
