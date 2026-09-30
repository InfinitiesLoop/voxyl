class_name AttachmentModels
extends RefCounted

# Generated geometry for attachable blocks (see Attachment): built from a block's own texture,
# so any torch-like block gets the real thing without the importer having shipped a model for
# it — the old flat-imported mod torches included. Models are cached per texture + pose, so a
# thousand torches share one mesh.

static var _cache := {}

# A torch textured with `texture_id`: standing on its block, or (`leaning`) held by a wall on
# its -X side and leaning toward +X (Attachment turns it to the other walls). The same three
# elements Minecraft's own torch models have — a 2×10×2 post carrying the cap/base faces, and
# two crossed thin full-texture planes that draw the torch itself; the leaning pose tips all
# three 22.5° about the wall contact point.
static func torch(texture_id: String, leaning: bool) -> BlockModel:
	var key := "%s|%s" % [texture_id, leaning]
	if _cache.has(key):
		return _cache[key]
	var m := BlockModel.new()
	m.id = "attach:torch:%s:%s" % ["wall" if leaning else "stand", texture_id]
	m.ambient_occlusion = false
	m.textures = {"torch": texture_id}
	var x0 := -0.0625 if leaning else 0.4375
	var x1 := 0.0625 if leaning else 0.5625
	var y0 := 0.21875 if leaning else 0.0
	var plane_x := [x0, x1] if leaning else [0.4375, 0.5625]
	var post := _element(Vector3(x0, y0, 0.4375), Vector3(x1, y0 + 0.625, 0.5625), {
		BlockModel.Dir.DOWN: Rect2(0.4375, 0.8125, 0.125, 0.125),
		BlockModel.Dir.UP: Rect2(0.4375, 0.375, 0.125, 0.125),
	})
	var plane_a := _element(Vector3(plane_x[0], y0, 0.0), Vector3(plane_x[1], y0 + 1.0, 1.0), {
		BlockModel.Dir.WEST: Rect2(0, 0, 1, 1), BlockModel.Dir.EAST: Rect2(0, 0, 1, 1),
	})
	var plane_b := _element(Vector3(-0.5 if leaning else 0.0, y0, 0.4375), Vector3(0.5 if leaning else 1.0, y0 + 1.0, 0.5625), {
		BlockModel.Dir.NORTH: Rect2(0, 0, 1, 1), BlockModel.Dir.SOUTH: Rect2(0, 0, 1, 1),
	})
	var elements := [post, plane_a, plane_b]
	if leaning:
		for el: Dictionary in elements:
			el["rotation"] = {"origin": Vector3(0, 0.21875, 0.5), "axis": Vector3(0, 0, 1),
				"angle": deg_to_rad(-22.5), "rescale": false}
	m.elements = elements
	_cache[key] = m
	return m

# One box element whose listed faces carry `texture` slices (uv rects in 0..1 of the image).
static func _element(from: Vector3, to: Vector3, uvs: Dictionary) -> Dictionary:
	var faces := {}
	for dir in uvs:
		faces[dir] = BlockModel.make_face("torch", uvs[dir])
	return {"from": from, "to": to, "faces": faces}
