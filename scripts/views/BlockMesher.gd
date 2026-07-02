class_name BlockMesher
extends RefCounted

# Pure, stateless geometry for a BlockModel — the single source of truth shared by
# every view (the 3D scene view and the block-library preview). Extracted from
# View3D so geometry is shared, not owned: "views are lenses; geometry is shared."
#
# Nothing here caches. Callers that rebuild often (View3D) keep their own per-id
# mesh caches wrapped around these builders; one-shot callers (the preview) just
# call directly. Material building, tints, and slice fades stay in the views —
# only mesh geometry lives here.

# Outward normal per BlockModel.Dir (NORTH=-Z, EAST=+X, SOUTH=+Z, WEST=-X, UP, DOWN).
const DIR_NORMALS := {
	0: Vector3(0, 0, -1), 1: Vector3(1, 0, 0), 2: Vector3(0, 0, 1),
	3: Vector3(-1, 0, 0), 4: Vector3(0, 1, 0), 5: Vector3(0, -1, 0),
}

# Color-path mesh: one BoxMesh per element, centered on the cell origin so an
# Orientation basis rotates about the cell center and a uniform scale shrinks it.
# BoxMesh carries clean normals/UVs/winding, so append_from gives well-lit geometry.
# A per-element model rotation (MC `rotation`: tilted planes like coral fans, crossed
# plants) is applied about its origin before centering, so a tilted element reads as
# tilted instead of lying flat.
static func color_mesh(model: BlockModel) -> Mesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var center := Transform3D(Basis(), -Vector3(0.5, 0.5, 0.5))
	for element in model.elements:
		var from: Vector3 = element["from"]
		var to: Vector3 = element["to"]
		var box := BoxMesh.new()
		box.size = to - from
		var place := Transform3D(Basis(), (from + to) * 0.5)
		st.append_from(box, 0, center * element_xform(element) * place)
	return st.commit()

# Per-face geometry for a textured model: one surface per distinct texture_key, with
# explicit UVs from each face's uv rect. Returns { mesh, keys, tinted } where `keys`
# (parallel to surface index) lets the caller bind a material per surface, and
# `tinted` (also parallel) flags surfaces any of whose faces carry a tint_index —
# those get the block's biome tint multiplied in by the caller. A texture in a given
# model is uniformly tint-or-not in practice (MC authors grayscale tint textures
# specifically), so grouping the flag per surface matches the per-face tint_index
# faithfully. Centered exactly like the color mesh, so Orientation + scale apply
# identically.
static func textured_mesh(model: BlockModel) -> Dictionary:
	var tools := {}              # texture_key -> SurfaceTool
	var order: Array[String] = []  # commit order → surface index
	var key_tinted := {}         # texture_key -> bool (any face tint_index >= 0)
	for element in model.elements:
		var from: Vector3 = element["from"]
		var to: Vector3 = element["to"]
		var faces: Dictionary = element["faces"]
		# A per-element rotation (tilted coral fans, crossed plants) applied about its
		# origin; its normal basis (inverse-transpose, so a rescale doesn't skew normals)
		# re-aims face shading. Identity when the element carries no rotation.
		var xform := element_xform(element)
		var nbasis := xform.basis.inverse().transposed()
		for dir in faces:
			var face: Dictionary = faces[dir]
			var key := str(face.get("texture_key", "all"))
			if not tools.has(key):
				var st := SurfaceTool.new()
				st.begin(Mesh.PRIMITIVE_TRIANGLES)
				tools[key] = st
				order.append(key)
				key_tinted[key] = false
			if int(face.get("tint_index", -1)) >= 0:
				key_tinted[key] = true
			add_face(tools[key], int(dir), from, to, face.get("uv", Rect2(0, 0, 1, 1)), xform, nbasis)
	var mesh := ArrayMesh.new()
	var keys: Array[String] = []
	var tinted: Array[bool] = []
	for key in order:
		tools[key].generate_tangents()
		tools[key].commit(mesh)
		keys.append(key)
		tinted.append(bool(key_tinted[key]))
	return {"mesh": mesh, "keys": keys, "tinted": tinted}

# Append one textured quad (two triangles) for a box face. Vertices are centered
# (corner - 0.5) to match the color mesh. `xform` is the element's 0–1-space rotation
# (identity for an axis-aligned element) applied before centering; `nbasis` re-aims the
# shading normal to match. Winding is self-correcting: Godot's front faces wind so the
# geometric cross product points *opposite* the surface normal, so flip the perimeter
# when our chosen order came out the other way. The winding check uses the un-rotated
# corners + normal — a rotation preserves orientation, so the same flip applies.
static func add_face(st: SurfaceTool, dir: int, from: Vector3, to: Vector3, uv: Rect2,
		xform := Transform3D(), nbasis := Basis()) -> void:
	var n: Vector3 = DIR_NORMALS[dir]
	var corners := face_corners(dir, from, to)
	# UVs parallel to the perimeter corners (top-left, bottom-left, bottom-right, top-right).
	var uvs := [
		uv.position,
		Vector2(uv.position.x, uv.end.y),
		uv.end,
		Vector2(uv.end.x, uv.position.y),
	]
	if (corners[1] - corners[0]).cross(corners[2] - corners[0]).dot(n) > 0.0:
		corners = [corners[0], corners[3], corners[2], corners[1]]
		uvs = [uvs[0], uvs[3], uvs[2], uvs[1]]
	var tn := (nbasis * n).normalized()
	for tri in [[0, 1, 2], [0, 2, 3]]:
		for i in tri:
			st.set_normal(tn)
			st.set_uv(uvs[i])
			st.add_vertex(xform * corners[i] - Vector3(0.5, 0.5, 0.5))

# Four perimeter corners of a box face in [0,1] box space (centering happens in
# add_face). Order is consistent per face; add_face fixes winding for Godot.
static func face_corners(dir: int, a: Vector3, b: Vector3) -> Array:
	match dir:
		0:  # NORTH (-Z)
			return [Vector3(a.x, b.y, a.z), Vector3(a.x, a.y, a.z), Vector3(b.x, a.y, a.z), Vector3(b.x, b.y, a.z)]
		1:  # EAST (+X)
			return [Vector3(b.x, b.y, a.z), Vector3(b.x, a.y, a.z), Vector3(b.x, a.y, b.z), Vector3(b.x, b.y, b.z)]
		2:  # SOUTH (+Z)
			return [Vector3(b.x, b.y, b.z), Vector3(b.x, a.y, b.z), Vector3(a.x, a.y, b.z), Vector3(a.x, b.y, b.z)]
		3:  # WEST (-X)
			return [Vector3(a.x, b.y, b.z), Vector3(a.x, a.y, b.z), Vector3(a.x, a.y, a.z), Vector3(a.x, b.y, a.z)]
		4:  # UP (+Y)
			return [Vector3(a.x, b.y, a.z), Vector3(a.x, b.y, b.z), Vector3(b.x, b.y, b.z), Vector3(b.x, b.y, a.z)]
		_:  # DOWN (-Y)
			return [Vector3(a.x, a.y, b.z), Vector3(a.x, a.y, a.z), Vector3(b.x, a.y, a.z), Vector3(b.x, a.y, b.z)]

# The element's rotation as a 0–1-space affine transform about its origin, or identity
# when it has none. An element's optional `rotation` is the neutral form of MC's tilted
# elements (coral fans' lifted planes, the crossed planes of plants):
#   { origin: Vector3 (0–1), axis: Vector3 (unit), angle: float (radians), rescale: bool }
# `rescale` stretches the two axes perpendicular to `axis` by 1/cos(angle) so the tilted
# element still spans the cell — MC's "rescale" flag, applied before the rotation.
static func element_xform(element: Dictionary) -> Transform3D:
	var rot = element.get("rotation", null)
	if rot == null:
		return Transform3D()
	var axis: Vector3 = (rot["axis"] as Vector3).normalized()
	var angle: float = rot["angle"]
	var basis := Basis(axis, angle)
	if bool(rot.get("rescale", false)) and not is_zero_approx(angle) and not is_zero_approx(cos(angle)):
		var s := 1.0 / absf(cos(angle))
		var ax := axis.abs()
		# 1.0 along the rotation axis, s on the two perpendicular axes (scale-before-rotate).
		basis = basis.scaled(Vector3(lerpf(s, 1.0, ax.x), lerpf(s, 1.0, ax.y), lerpf(s, 1.0, ax.z)))
	var origin: Vector3 = rot["origin"]
	return Transform3D(basis, origin - basis * origin)

# Model rotation for a state_map-driven part (a variant's baked x/y, or a multipart
# part's), in voxyl's convention. y degrees turn the model clockwise seen from above
# (NORTH→EAST→SOUTH→WEST), x degrees tilt about the world X axis; MC bakes x then y,
# so y is on the left. Verified against the horizontal facings: a NORTH-pointing arm
# with y=90 lands EAST, matching how MC rotates fence sides and stairs. Shared by
# View3D (real cells) and BlockRender3D (the library preview/icon), since both place
# the same state_map-resolved parts.
static func rotation_basis(x_deg: int, y_deg: int) -> Basis:
	return Basis(Vector3.UP, deg_to_rad(-y_deg)) * Basis(Vector3.RIGHT, deg_to_rad(-x_deg))
