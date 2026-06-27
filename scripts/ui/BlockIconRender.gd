class_name BlockIconRender
extends RefCounted

# Lightweight 2D isometric icon for a block type — drawn straight onto a CanvasItem,
# no 3D viewport per cell, so a grid of hundreds of icons stays cheap. It's the
# block-library equivalent of HomeScreen._draw_block_preview, but resolves the block's
# model + bound textures (the material layer) instead of only its planning color.
#
# Still a lens on the library: it reads a BlockType's model/textures from the
# workspace and renders them; it owns no data. Blocks with no textures fall back to
# the flat `color` (the "undecided"/planning path stays first-class).

# Shared image cache (image_path -> ImageTexture). Static so the grid icons and the
# 3D preview both pull a PNG through here and never reload it. AssetLibrary.load_texture
# reads the loose file off disk (these assets bypass Godot's import pipeline).
static var _tex_cache := {}
# Animated frame-0 textures (image_path -> ImageTexture cropped to the top square).
static var _frame_cache := {}

# ImageTexture for a library-relative image path, cached. Null for an empty path or
# an unreadable file. The 3D preview reuses this so a texture is decoded once.
static func cached_texture(image_path: String) -> ImageTexture:
	if image_path.is_empty():
		return null
	if not _tex_cache.has(image_path):
		_tex_cache[image_path] = AssetLibrary.load_texture(image_path)
	return _tex_cache[image_path]

# The drawable texture for a TextureAsset, shared by the grid icon and the 3D preview.
# Static textures return the full cached image; animated frame-strips return a real
# frame-0 ImageTexture cropped to the top square. (An AtlasTexture region is NOT honored
# by a 3D StandardMaterial3D — it would sample the whole strip, squished — so we crop a
# genuine sub-image instead.) Null for a missing/unreadable asset.
static func face_texture(asset: TextureAsset) -> Texture2D:
	if asset == null or asset.image_path.is_empty():
		return null
	if not asset.is_animated():
		return cached_texture(asset.image_path)
	if not _frame_cache.has(asset.image_path):
		var img := AssetLibrary.load_image(asset.image_path)
		if img == null:
			_frame_cache[asset.image_path] = null
		else:
			var w := img.get_width()
			var h := mini(w, img.get_height())
			_frame_cache[asset.image_path] = ImageTexture.create_from_image(img.get_region(Rect2i(0, 0, w, h)))
	return _frame_cache[asset.image_path]

# Resolve the textures an icon needs from a block type: its UP face and one side
# face, plus the flat color fallback. Returns { up_tex, side_tex, color } where the
# textures are Texture2D or null (null → draw that face as the flat color). Blocks
# with no model textures return both null — the planning/color path.
static func resolve_faces(bt: BlockType, workspace: VoxelWorkspace) -> Dictionary:
	var out := {"up_tex": null, "side_tex": null, "color": bt.color}
	var model := _model_for(bt, workspace)
	if model == null or model.elements.is_empty() or not model.has_textures():
		return out
	var faces: Dictionary = model.elements[0].get("faces", {})
	out["up_tex"] = _face_texture(model, faces, BlockModel.Dir.UP, workspace)
	# Side: prefer the SOUTH (+Z) face the iso view shows head-on, then any horizontal.
	var side := _face_texture(model, faces, BlockModel.Dir.SOUTH, workspace)
	if side == null:
		for d in [BlockModel.Dir.NORTH, BlockModel.Dir.EAST, BlockModel.Dir.WEST]:
			side = _face_texture(model, faces, d, workspace)
			if side != null:
				break
	out["side_tex"] = side
	return out

# Draw the block as a 3-face isometric icon filling `size`, centered. FULL and SLAB
# get distinct silhouettes; STAIRS composes the two builtin boxes (slab + back step).
# Set ci.texture_filter = TEXTURE_FILTER_NEAREST on the canvas item so pixel art stays
# crisp. `faces` is a resolve_faces() result; `shape` is a BlockType.Shape.
static func draw_iso(ci: CanvasItem, size: Vector2, faces: Dictionary, shape: BlockType.Shape) -> void:
	var unit := minf(size.x, size.y) * 0.42
	var o := size * 0.5
	match shape:
		BlockType.Shape.SLAB:
			_draw_box(ci, o, unit, faces, Vector3.ZERO, Vector3(1, 0.5, 1))
		BlockType.Shape.STAIRS:
			# Painter's order: bottom slab first, then the upper step (nearer, +Z/+Y).
			_draw_box(ci, o, unit, faces, Vector3.ZERO, Vector3(1, 0.5, 1))
			_draw_box(ci, o, unit, faces, Vector3(0, 0.5, 0.5), Vector3.ONE)
		_:
			_draw_box(ci, o, unit, faces, Vector3.ZERO, Vector3.ONE)

# --- Internals --------------------------------------------------------------

# Project a unit-cube-space point to screen via a fixed isometric basis (same shape
# as HomeScreen's logo). The cube is centered on its [0,1] midpoint so it sits in the
# middle of the icon regardless of element height.
static func _project(o: Vector2, unit: float, v: Vector3) -> Vector2:
	var ix := Vector2(unit, unit * 0.5)
	var iy := Vector2(0, -unit)
	var iz := Vector2(-unit, unit * 0.5)
	return o + ix * (v.x - 0.5) + iy * (v.y - 0.5) + iz * (v.z - 0.5)

# Draw the three visible faces (top, front +Z, right +X) of an axis-aligned box.
static func _draw_box(ci: CanvasItem, o: Vector2, unit: float, faces: Dictionary,
		a: Vector3, b: Vector3) -> void:
	var base: Color = faces.get("color", Color(0.5, 0.5, 0.5))
	var up_tex: Texture2D = faces.get("up_tex")
	var side_tex: Texture2D = faces.get("side_tex")

	# Top face (y = b.y): brightened.
	_draw_face(ci, PackedVector2Array([
			_project(o, unit, Vector3(a.x, b.y, b.z)), _project(o, unit, Vector3(b.x, b.y, b.z)),
			_project(o, unit, Vector3(b.x, b.y, a.z)), _project(o, unit, Vector3(a.x, b.y, a.z))]),
		up_tex, base.lightened(0.18), 1.0)

	# Front face (z = b.z): base shade.
	_draw_face(ci, PackedVector2Array([
			_project(o, unit, Vector3(a.x, b.y, b.z)), _project(o, unit, Vector3(b.x, b.y, b.z)),
			_project(o, unit, Vector3(b.x, a.y, b.z)), _project(o, unit, Vector3(a.x, a.y, b.z))]),
		side_tex, base, 0.82)

	# Right face (x = b.x): darkened.
	_draw_face(ci, PackedVector2Array([
			_project(o, unit, Vector3(b.x, b.y, b.z)), _project(o, unit, Vector3(b.x, b.y, a.z)),
			_project(o, unit, Vector3(b.x, a.y, a.z)), _project(o, unit, Vector3(b.x, a.y, b.z))]),
		side_tex, base.darkened(0.22), 0.66)

# One quad face: textured (modulated by `shade`) when a texture is bound, else flat
# `color`. UVs map the four corners in declared order to the texture's [0,1] square.
static func _draw_face(ci: CanvasItem, pts: PackedVector2Array, tex: Texture2D,
		color: Color, shade: float) -> void:
	if tex != null:
		var uvs := PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
		ci.draw_colored_polygon(pts, Color(shade, shade, shade), uvs, tex)
	else:
		ci.draw_colored_polygon(pts, color)

# A bound face's drawable texture, or null. Animated frame-strips show frame 0 (via
# the shared face_texture helper), so a grid icon never displays a squished strip.
static func _face_texture(model: BlockModel, faces: Dictionary, dir: int,
		workspace: VoxelWorkspace) -> Texture2D:
	if not faces.has(dir):
		return null
	var key := str((faces[dir] as Dictionary).get("texture_key", "all"))
	if not model.textures.has(key):
		return null
	return face_texture(workspace.get_texture_asset(model.textures[key]))

# The model an icon renders: the block's explicit model_id (library), else the
# built-in for its shape — mirroring VoxelWorld.get_model_for_semantic, but resolved
# straight from the block type (library blocks aren't in any project/palette).
static func _model_for(bt: BlockType, workspace: VoxelWorkspace) -> BlockModel:
	if not bt.model_id.is_empty():
		var m := workspace.get_block_model(bt.model_id)
		if m != null:
			return m
	var shape_id := _builtin_id(bt.shape)
	var builtin := workspace.get_block_model(shape_id)
	return builtin if builtin != null else BlockModel.builtin_by_id(shape_id)

static func _builtin_id(shape: BlockType.Shape) -> String:
	match shape:
		BlockType.Shape.SLAB: return BlockModel.BUILTIN_SLAB
		BlockType.Shape.STAIRS: return BlockModel.BUILTIN_STAIRS
		_: return BlockModel.BUILTIN_FULL
