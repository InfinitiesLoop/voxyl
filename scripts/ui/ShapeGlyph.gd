class_name ShapeGlyph
extends Control

# A small isometric line-and-fill drawing of a ShapeCatalog shape inside a faint unit cube —
# the shape picker's button art, and the hotbar's stand-in until a shaped entry's real 3D
# icon bakes. Pure 2D drawing from the shape's own boxes (ShapeCatalog.boxes at its preview
# slot), so it needs no textures, no baking and no palette: it shows geometry only.
#
# The view matches the baked icons' camera (looking from -X, +Y, -Z), so the three faces
# drawn are the top, west and north ones.

var shape_id: String = "":
	set(v):
		shape_id = v
		queue_redraw()
var color := Color(0.62, 0.62, 0.66):
	set(v):
		color = v
		queue_redraw()

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	custom_minimum_size = Vector2(40, 40)

func _draw() -> void:
	draw_into(self, Rect2(Vector2.ZERO, size), shape_id, color)

# Draw `shape_id` into `rect` of any CanvasItem (the Hotbar calls this directly).
static func draw_into(ci: CanvasItem, rect: Rect2, p_shape_id: String, p_color: Color) -> void:
	if not ShapeCatalog.has(p_shape_id):
		return
	var s := minf(rect.size.x, rect.size.y) * 0.34
	# Screen positions of the world axes (isometric, from -X +Y -Z).
	var ex := Vector2(0.866, -0.5) * s
	var ez := Vector2(-0.866, -0.5) * s
	var ey := Vector2(0, -1) * s
	# Center the unit cube's projection in the rect.
	var origin := rect.get_center() - (ex + ey + ez) * 0.5
	var proj := func(p: Vector3) -> Vector2: return origin + ex * p.x + ey * p.y + ez * p.z

	var cube_col := Color(1, 1, 1, 0.16)
	_box_outline(ci, proj, Vector3.ZERO, Vector3.ONE, cube_col)

	if ShapeCatalog.family_of(p_shape_id) == ShapeCatalog.Family.ARCH:
		_draw_mesh(ci, proj, p_shape_id, p_color)
		return
	var boxes := ShapeCatalog.boxes(p_shape_id, ShapeCatalog.preview_slot(p_shape_id))
	# Painter's order: farthest from the viewer (at -X +Y -Z) first.
	boxes.sort_custom(func(a: AABB, b: AABB) -> bool:
		var ca := a.get_center(); var cb := b.get_center()
		return (-ca.x + ca.y - ca.z) < (-cb.x + cb.y - cb.z))
	var top := p_color.lightened(0.25)
	var west := p_color
	var north := p_color.darkened(0.25)
	var edge := p_color.darkened(0.55)
	for b in boxes:
		var lo := b.position
		var hi := b.end
		var faces := [
			[north, [Vector3(lo.x, lo.y, lo.z), Vector3(hi.x, lo.y, lo.z), Vector3(hi.x, hi.y, lo.z), Vector3(lo.x, hi.y, lo.z)]],
			[west, [Vector3(lo.x, lo.y, lo.z), Vector3(lo.x, lo.y, hi.z), Vector3(lo.x, hi.y, hi.z), Vector3(lo.x, hi.y, lo.z)]],
			[top, [Vector3(lo.x, hi.y, lo.z), Vector3(hi.x, hi.y, lo.z), Vector3(hi.x, hi.y, hi.z), Vector3(lo.x, hi.y, hi.z)]],
		]
		for f in faces:
			var pts := PackedVector2Array()
			for p in f[1]:
				pts.append(proj.call(p))
			ci.draw_colored_polygon(pts, f[0])
			pts.append(pts[0])
			ci.draw_polyline(pts, edge, 1.0, true)

# An architecture shape's triangles, flat-shaded: back faces dropped, the rest painted far to
# near. Cheap enough for the picker's ~100 glyphs (the roundest shapes are a few hundred
# triangles).
const _VIEW := Vector3(-0.577, 0.577, -0.577)          # toward the viewer
const _LIGHT := Vector3(-0.27, 0.9, -0.34)             # soft light from above-front

static func _draw_mesh(ci: CanvasItem, proj: Callable, p_shape_id: String, p_color: Color) -> void:
	var tris: Array = []   # [depth, PackedVector2Array, Color]
	for f in ArchShapes.placed_faces(p_shape_id, ShapeCatalog.preview_slot(p_shape_id)):
		var pos: PackedVector3Array = f["pos"]
		var nrm: PackedVector3Array = f["nrm"]
		for t in range(0, pos.size() - 2, 3):
			var n := (nrm[t] + nrm[t + 1] + nrm[t + 2]).normalized()
			if n.dot(_VIEW) <= 0.0:
				continue
			var c := (pos[t] + pos[t + 1] + pos[t + 2]) / 3.0
			var shade := 0.55 + 0.45 * maxf(0.0, n.dot(_LIGHT.normalized()))
			var col := Color(p_color.r * shade, p_color.g * shade, p_color.b * shade, 1.0)
			var a2: Vector2 = proj.call(pos[t])
			var b2: Vector2 = proj.call(pos[t + 1])
			var c2: Vector2 = proj.call(pos[t + 2])
			if absf((b2 - a2).cross(c2 - a2)) < 0.02:
				continue   # edge-on sliver: nothing to see, and it trips polygon triangulation
			tris.append([c.dot(_VIEW), PackedVector2Array([a2, b2, c2]), col])
	tris.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
	for tri in tris:
		ci.draw_colored_polygon(tri[1], tri[2])

static func _box_outline(ci: CanvasItem, proj: Callable, lo: Vector3, hi: Vector3, col: Color) -> void:
	var c := [
		Vector3(lo.x, lo.y, lo.z), Vector3(hi.x, lo.y, lo.z), Vector3(hi.x, lo.y, hi.z), Vector3(lo.x, lo.y, hi.z),
		Vector3(lo.x, hi.y, lo.z), Vector3(hi.x, hi.y, lo.z), Vector3(hi.x, hi.y, hi.z), Vector3(lo.x, hi.y, hi.z),
	]
	for e in [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]:
		ci.draw_line(proj.call(c[e[0]]), proj.call(c[e[1]]), col, 1.0, true)
