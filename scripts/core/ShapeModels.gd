class_name ShapeModels
extends RefCounted

# Generated geometry for shaped parts: a part (shape + slot) cut from a base block becomes
# an ordinary BlockModel — the shape's boxes, each face bound to the base block's own
# full-cube texture for that direction, with UVs *projected by position* so a strip shows
# the matching slice of the texture and lines up with its neighbors (what Forge Microblocks
# and ArchitectureCraft both do). Because the result is a plain BlockModel, the 3D view,
# block previews and the icon baker render it through their normal model paths and caches.
#
# Material-layer only: the base model is whatever the palette currently resolves the part's
# semantic to, so re-pointing a shaped entry's base re-skins every placed part (the voxel
# data only ever stores semantic + shape + slot). An undecided base (the built-in full cube,
# no textures) yields an untextured model, which renders on the planning-color path.
#
# Generated models are addressable by id — "shape:<shape>:<slot>:<base id>@<base stamp>" —
# via VoxelWorkspace.get_block_model, so anything that resolves models by id (the icon
# baker's synthetic block types) finds them. The id folds in the base model's instance +
# revision, so an edited or reimported base never serves a stale mesh from an id-keyed cache.

const ID_PREFIX := "shape:"

static var _by_id := {}    # id -> BlockModel

static func is_shape_model_id(model_id: String) -> bool:
	return model_id.begins_with(ID_PREFIX)

# A previously generated model by id, or null.
static func get_by_id(model_id: String) -> BlockModel:
	return _by_id.get(model_id, null)

static func clear_cache() -> void:
	_by_id.clear()

static func id_for(shape_id: String, slot: int, base: BlockModel) -> String:
	var base_id := "none"
	if base != null:
		base_id = "%s@%d.%d" % [base.id, base.get_instance_id(), base.revision]
	return "%s%s:%d:%s" % [ID_PREFIX, shape_id, slot, base_id]

# The model for one part of `shape_id` at `slot`, textured from `base` (null → untextured).
static func model_for(shape_id: String, slot: int, base: BlockModel) -> BlockModel:
	var mid := id_for(shape_id, slot, base)
	var hit: BlockModel = _by_id.get(mid, null)
	if hit != null:
		return hit
	var m := BlockModel.new()
	m.id = mid
	var bindings := _base_bindings(base)
	if ShapeCatalog.family_of(shape_id) == ShapeCatalog.Family.ARCH:
		m.elements = _arch_elements(shape_id, slot, bindings)
	else:
		m.elements = _box_elements(shape_id, slot, bindings)
	if base != null:
		m.textures = base.textures.duplicate()
		m.ambient_occlusion = base.ambient_occlusion
	_by_id[mid] = m
	return m

# A microblock's boxes, every face bound to the base's texture for its direction.
static func _box_elements(shape_id: String, slot: int, bindings: Dictionary) -> Array:
	var elements: Array = []
	for box in ShapeCatalog.boxes(shape_id, slot):
		var faces := {}
		for d in BlockModel.ALL_DIRS:
			var b: Dictionary = bindings.get(d, {})
			var face := BlockModel.make_face(str(b.get("texture_key", "all")),
				_remap(_projected_uv(d, box.position, box.end), b.get("uv", Rect2(0, 0, 1, 1))))
			face["tint_index"] = int(b.get("tint_index", -1))
			faces[d] = face
		elements.append({"from": box.position, "to": box.end, "faces": faces})
	return elements

# An architecture shape's triangles as mesh elements (see BlockModel): one per direction
# bucket, each bound to the base block's texture for that direction. A triangle's bucket is
# the direction its normal leans most (ties → the side, so a 45° roof slope takes the side
# texture). Projected faces get UVs from their position, exactly like a microblock face; the
# rest keep the shape's own UVs (a roof slope's texture runs down the slope, as in the mod).
static func _arch_elements(shape_id: String, slot: int, bindings: Dictionary) -> Array:
	# Accumulate into plain Arrays (Packed*Arrays are value types — appending through a
	# dictionary lookup would append to a copy), packed once at the end.
	var buckets := {}   # BlockModel.Dir -> [positions, normals, uvs]
	var lo := Vector3.ONE * INF
	var hi := -Vector3.ONE * INF
	for f in ArchShapes.placed_faces(shape_id, slot):
		var pos: PackedVector3Array = f["pos"]
		var nrm: PackedVector3Array = f["nrm"]
		var uv: PackedVector2Array = f["uv"]
		var projected: bool = f["projected"]
		for t in range(0, pos.size(), 3):
			var dir := _dir_of(nrm[t] + nrm[t + 1] + nrm[t + 2])
			var base_uv: Rect2 = (bindings.get(dir, {}) as Dictionary).get("uv", Rect2(0, 0, 1, 1))
			if not buckets.has(dir):
				buckets[dir] = [[], [], []]
			var bk: Array = buckets[dir]
			for k in 3:
				var p := pos[t + k]
				var local_uv: Vector2 = _point_uv(dir, p) if projected else uv[t + k]
				bk[0].append(p)
				bk[1].append(nrm[t + k])
				bk[2].append(base_uv.position + local_uv * base_uv.size)
				lo = lo.min(p)
				hi = hi.max(p)
	var out: Array = []
	for dir in buckets:
		var b: Dictionary = bindings.get(dir, {})
		var bk: Array = buckets[dir]
		var mesh := {"pos": PackedVector3Array(bk[0]), "nrm": PackedVector3Array(bk[1]), "uv": PackedVector2Array(bk[2])}
		out.append({"from": lo, "to": hi, "faces": {}, "mesh": mesh,
			"texture_key": str(b.get("texture_key", "all")), "tint_index": int(b.get("tint_index", -1))})
	return out

static func _dir_of(n: Vector3) -> int:
	var ax := absf(n.x); var ay := absf(n.y); var az := absf(n.z)
	if ay > maxf(ax, az) + 0.0001:
		return BlockModel.Dir.UP if n.y > 0.0 else BlockModel.Dir.DOWN
	if ax >= az:
		return BlockModel.Dir.EAST if n.x > 0.0 else BlockModel.Dir.WEST
	return BlockModel.Dir.SOUTH if n.z > 0.0 else BlockModel.Dir.NORTH

# Where point p (cell space) falls on a full cube's face texture in direction `dir` — the
# per-point form of _projected_uv, same convention.
static func _point_uv(dir: int, p: Vector3) -> Vector2:
	match dir:
		BlockModel.Dir.NORTH: return Vector2(p.x, 1.0 - p.y)
		BlockModel.Dir.EAST: return Vector2(p.z, 1.0 - p.y)
		BlockModel.Dir.SOUTH: return Vector2(1.0 - p.x, 1.0 - p.y)
		BlockModel.Dir.WEST: return Vector2(1.0 - p.z, 1.0 - p.y)
		BlockModel.Dir.UP: return Vector2(p.x, p.z)
	return Vector2(p.x, 1.0 - p.z)   # DOWN

# Per-direction face bindings (texture_key, uv, tint_index) of the base's full-cube element —
# the first element spanning the whole cell, else the biggest one. A direction the element
# lacks borrows any face it has, so every side of a part gets some texture.
static func _base_bindings(base: BlockModel) -> Dictionary:
	var out := {}
	if base == null or base.elements.is_empty():
		return out
	var best: Dictionary = {}
	var best_vol := -1.0
	for el in base.elements:
		var f: Vector3 = el.get("from", Vector3.ZERO)
		var t: Vector3 = el.get("to", Vector3.ONE)
		if f.is_zero_approx() and t.is_equal_approx(Vector3.ONE):
			best = el
			break
		var s := (t - f).abs()
		var vol := s.x * s.y * s.z
		if vol > best_vol:
			best_vol = vol
			best = el
	var faces: Dictionary = best.get("faces", {})
	if faces.is_empty():
		return out
	var any_face: Dictionary = faces.values()[0]
	for d in BlockModel.ALL_DIRS:
		var face: Dictionary = faces.get(d, any_face)
		out[d] = {
			"texture_key": str(face.get("texture_key", "all")),
			"uv": face.get("uv", Rect2(0, 0, 1, 1)),
			"tint_index": int(face.get("tint_index", -1)),
		}
	return out

# The UV rect (in 0–1 face space) a full cube would show over the box face a..b in
# direction `dir`. Matches BlockMesher.face_corners' corner order, so a part's face shows
# exactly the texels a whole block's face shows at the same place.
static func _projected_uv(dir: int, a: Vector3, b: Vector3) -> Rect2:
	match dir:
		BlockModel.Dir.NORTH: return Rect2(a.x, 1.0 - b.y, b.x - a.x, b.y - a.y)
		BlockModel.Dir.EAST: return Rect2(a.z, 1.0 - b.y, b.z - a.z, b.y - a.y)
		BlockModel.Dir.SOUTH: return Rect2(1.0 - b.x, 1.0 - b.y, b.x - a.x, b.y - a.y)
		BlockModel.Dir.WEST: return Rect2(1.0 - b.z, 1.0 - b.y, b.z - a.z, b.y - a.y)
		BlockModel.Dir.UP: return Rect2(a.x, a.z, b.x - a.x, b.z - a.z)
	return Rect2(a.x, 1.0 - b.z, b.x - a.x, b.z - a.z)   # DOWN

# Map a 0–1 local rect into the base face's own uv rect (usually the full 0–1 square).
static func _remap(local: Rect2, base_uv: Rect2) -> Rect2:
	return Rect2(base_uv.position + local.position * base_uv.size, local.size * base_uv.size)
