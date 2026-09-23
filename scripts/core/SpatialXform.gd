class_name SpatialXform
extends RefCounted

# A rigid move of cells in the grid: an axis-aligned rotation or reflection (`basis`,
# entries 0/±1) followed by a translation, acting on cell-center coordinates (cell (x,y,z)'s
# center is the point (x,y,z)). It moves a whole edit — position, a plain block's facing, a
# shaped part's slot (ShapeCatalog.transform_part) — so symmetry, repeat, paste-rotate and
# mirror all go through one function. Pure geometry: no palette, no view.
#
# Symmetry and repeat are the batch forms (expand): an edit list is copied through every
# element of a symmetry group, then through every step of a repeat.

var basis := Basis()
var origin := Vector3.ZERO   # translation applied after the basis

func _init(p_basis := Basis(), p_origin := Vector3.ZERO) -> void:
	basis = p_basis
	origin = p_origin

# The map p -> basis * (p - pivot) + pivot.
static func about(p_basis: Basis, pivot: Vector3) -> SpatialXform:
	var b := _snap(p_basis)
	return SpatialXform.new(b, pivot - b * pivot)

static func translation(offset: Vector3i) -> SpatialXform:
	return SpatialXform.new(Basis(), Vector3(offset))

# self after other (apply `other` first).
func compose(other: SpatialXform) -> SpatialXform:
	return SpatialXform.new(basis * other.basis, basis * other.origin + origin)

func key() -> String:
	var o := (origin * 2.0).round()
	return "%s|%d,%d,%d" % [str(basis), int(o.x), int(o.y), int(o.z)]

func is_identity() -> bool:
	return basis.is_equal_approx(Basis()) and origin.is_zero_approx()

func apply_pos(p: Vector3i) -> Vector3i:
	return Vector3i((basis * Vector3(p) + origin).round())

# Whether this map sends cells to cells (a pivot on a half-cell can make a rotation land
# between cells).
func is_grid_aligned(sample: Vector3i = Vector3i.ZERO) -> bool:
	var q := basis * Vector3(sample) + origin
	return q.is_equal_approx(q.round())

# A plain block's orientation moved through the basis: the facing direction turns with it,
# the top-half flag stays (no symmetry here flips Y).
func apply_orientation(o: int) -> int:
	var d := basis * Vector3(Orientation.dir_of(o))
	return Orientation.make(Orientation.from_dir(d), Orientation.is_top(o))

# A BlockCell moved through the basis (null if one of its parts has no image — a chiral
# architecture shape mirrored with no twin).
func apply_cell(cell: BlockCell) -> BlockCell:
	if cell == null:
		return null
	var out := cell.duplicate_cell()
	if cell.is_shaped():
		var parts: Array = []
		for p in cell.parts:
			var q := ShapeCatalog.transform_part(p, basis)
			if q.is_empty():
				return null
			parts.append(q)
		out.parts = parts
		out.sync_type_id()
	else:
		out.orientation = apply_orientation(cell.orientation)
	return out

# One edit (see VoxelWorld.apply_edits) moved through this map. Returns {} when its part
# can't be moved (reported by the caller as "no_mirror_image").
func apply_edit(e: Dictionary) -> Dictionary:
	var out := e.duplicate()
	out["pos"] = apply_pos(e["pos"])
	match str(e.get("op", "")):
		"block":
			out["orientation"] = apply_orientation(int(e.get("orientation", 0)))
		"part":
			var q := ShapeCatalog.transform_part(e["part"], basis)
			if q.is_empty():
				return {}
			out["part"] = q
		"cell":
			var c := apply_cell(e["cell"])
			if c == null:
				return {}
			out["cell"] = c
	return out

# --- Symmetry groups ------------------------------------------------------------------

# Parse a symmetry spec into the list of maps it generates (identity first):
#   { rotate4: {center:[x,z]} }     four quarter-turns about a vertical axis
#   { rotate2: {center:[x,z]} }     half-turn
#   { mirror_x: x0 }                reflect x about the plane x = x0
#   { mirror_z: z0 }                reflect z about z = z0
#   { mirror_diag: {center:[x,z]} } swap x and z through the center (true = [0,0])
# Centers are cell-center coordinates; use .5 to put the pivot on a cell boundary. Several
# keys combine (their generated group). Returns { maps: Array[SpatialXform] } or { error }.
static func group_from_spec(spec: Dictionary) -> Dictionary:
	var gens: Array = []
	for k in spec.keys():
		var v: Variant = spec[k]
		match str(k):
			"rotate4", "rotate2":
				var c: Variant = _center2(v)
				if c == null:
					return {"error": "%s needs center:[x,z]" % k}
				var steps := 1 if str(k) == "rotate4" else 2
				gens.append(about(Basis(Vector3.UP, deg_to_rad(-90.0 * steps)), c))
			"mirror_x":
				gens.append(about(Basis(Vector3(-1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, 1)),
					Vector3(float(v), 0, 0)))
			"mirror_z":
				gens.append(about(Basis(Vector3(1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, -1)),
					Vector3(0, 0, float(v))))
			"mirror_diag":
				var c: Variant = Vector3.ZERO if typeof(v) == TYPE_BOOL else _center2(v)
				if c == null:
					return {"error": "mirror_diag needs true or center:[x,z]"}
				gens.append(about(Basis(Vector3(0, 0, 1), Vector3(0, 1, 0), Vector3(1, 0, 0)), c))
			_:
				return {"error": "unknown symmetry '%s' (rotate4, rotate2, mirror_x, mirror_z, mirror_diag)" % k}
	var maps: Array = [SpatialXform.new()]
	var seen := {maps[0].key(): true}
	var frontier: Array = maps.duplicate()
	while not frontier.is_empty() and maps.size() < 16:
		var next: Array = []
		for m: SpatialXform in frontier:
			for g: SpatialXform in gens:
				var c := g.compose(m)
				c.basis = _snap(c.basis)
				if not seen.has(c.key()):
					seen[c.key()] = true
					maps.append(c)
					next.append(c)
		frontier = next
	return {"maps": maps}

static func _center2(v: Variant) -> Variant:
	var c: Variant = v.get("center", null) if v is Dictionary else v
	if not (c is Array) or (c as Array).size() < 2:
		return null
	return Vector3(float(c[0]), 0.0, float(c[1]))

static func _snap(b: Basis) -> Basis:
	return Basis(b.x.round(), b.y.round(), b.z.round())

# Translations for a repeat spec { count: n | [nx,ny,nz], step: [dx,dy,dz] }. A scalar count
# steps n times along `step`; a per-axis count builds a grid with `step` as the per-axis
# spacing. Returns { offsets: Array[Vector3i] } or { error }.
static func repeat_offsets(spec: Dictionary) -> Dictionary:
	var step_v: Variant = spec.get("step", null)
	if not (step_v is Array) or (step_v as Array).size() < 3:
		return {"error": "repeat needs step:[dx,dy,dz]"}
	var step := Vector3i(int(step_v[0]), int(step_v[1]), int(step_v[2]))
	var count: Variant = spec.get("count", 1)
	var out: Array = []
	if count is Array:
		var n := Vector3i(maxi(1, int(count[0])), maxi(1, int(count[1])), maxi(1, int(count[2])))
		for i in n.x:
			for j in n.y:
				for k in n.z:
					out.append(Vector3i(i * step.x, j * step.y, k * step.z))
	else:
		for i in maxi(1, int(count)):
			out.append(step * i)
	if out.size() > 4096:
		return {"error": "repeat makes %d copies (max 4096)" % out.size()}
	return {"offsets": out}

# Copy an edit list through a symmetry group then a repeat. Images that can't be made
# (a chiral part with no mirror twin) are listed in `rejected`. Exact duplicates (the same
# edit landing twice, e.g. on the symmetry axis) are dropped.
static func expand(edits: Array, maps: Array, offsets: Array) -> Dictionary:
	var out: Array = []
	var rejected: Array = []
	var seen := {}
	if offsets.is_empty():
		offsets = [Vector3i.ZERO]
	for off: Vector3i in offsets:
		for m: SpatialXform in maps:
			var t := translation(off).compose(m)
			for e: Dictionary in edits:
				var moved := e if t.is_identity() else t.apply_edit(e)
				if moved.is_empty():
					rejected.append({"pos": t.apply_pos(e["pos"]), "reason": "no_mirror_image",
						"detail": "this shape has no slot that mirrors it (chiral, no left/right twin)"})
					continue
				var k := _edit_key(moved)
				if seen.has(k):
					continue
				seen[k] = true
				out.append(moved)
	return {"edits": out, "rejected": rejected}

static func _edit_key(e: Dictionary) -> String:
	var p: Vector3i = e["pos"]
	var body := ""
	match str(e.get("op", "")):
		"block": body = "%s|%d" % [e.get("semantic", ""), int(e.get("orientation", 0))]
		"part": body = str(VoxelData.pack_parts([e["part"]]))
		"cell":
			var c: BlockCell = e["cell"]
			body = "%s|%d|%s" % [c.type_id, c.orientation, str(VoxelData.pack_parts(c.parts))] if c else "null"
	return "%d,%d,%d|%s|%s" % [p.x, p.y, p.z, e.get("op", ""), body]
