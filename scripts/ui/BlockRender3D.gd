class_name BlockRender3D
extends RefCounted

# Builds the real 3D appearance of a single library block onto a MeshInstance3D:
# shared BlockMesher geometry + per-surface textured materials (NEAREST, with the
# asset's CUTOUT/TRANSLUCENT mode and optional biome tint), or a single flat-color
# material for the planning/"undecided" path. The one source of truth shared by the
# rotatable block preview (BlockPreview3D) and the baked grid icons (BlockIconBaker),
# so a block looks identical wherever it's shown — a flower renders as its crossed
# planes, never a fake box.
#
# It resolves model + textures straight from the BlockType through the workspace
# library (library blocks aren't in any project/palette), staying a lens on the
# material layer — no voxel data involved. The caller passes a FRESH MeshInstance3D
# (so stale per-surface overrides never linger across blocks).

# Configure `mi` to render `bt`. Pass a freshly created MeshInstance3D. A null block
# (or a block whose model is missing) leaves the instance empty.
static func build_into(mi: MeshInstance3D, bt: BlockType) -> void:
	if bt == null:
		return
	var model := model_for(bt)
	if model == null:
		return
	var resolved := _resolve_textures(model)
	if resolved.is_empty():
		mi.mesh = BlockMesher.color_mesh(model)
		var m := StandardMaterial3D.new()
		m.albedo_color = bt.color
		mi.material_override = m
		return
	var entry := BlockMesher.textured_mesh(model)
	mi.mesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	for i in keys.size():
		mi.set_surface_override_material(i,
			_surface_material(keys[i], resolved, bool(tinted[i]), bt.tint, bt.color))

# The model to render: the block's explicit model_id (library), else the built-in for
# its shape (mirrors VoxelWorld.get_model_for_semantic, but resolved from the block
# type, since library blocks aren't in any project/palette).
static func model_for(bt: BlockType) -> BlockModel:
	if not bt.model_id.is_empty():
		var m := VoxelWorld.workspace.get_block_model(bt.model_id)
		if m != null:
			return m
	var shape_id := _builtin_id(bt.shape)
	var builtin := VoxelWorld.workspace.get_block_model(shape_id)
	return builtin if builtin != null else BlockModel.builtin_by_id(shape_id)

# --- Internals --------------------------------------------------------------

# Texture-key bindings resolved to drawable textures (shared with the grid/preview
# decode cache, so a PNG decodes once). Animated assets resolve to their frame-0
# sub-image. Returns key -> { asset, tex }.
static func _resolve_textures(model: BlockModel) -> Dictionary:
	var out := {}
	if not model.has_textures():
		return out
	for key in model.textures:
		var asset := VoxelWorld.workspace.get_texture_asset(model.textures[key])
		if asset == null:
			continue
		var tex := BlockTextureCache.face_texture(asset)
		if tex == null:
			continue
		out[key] = {"asset": asset, "tex": tex}
	return out

# Material for one surface: the bound texture (NEAREST, with CUTOUT/TRANSLUCENT from
# the asset), tinted only when the surface opts in via tint_index. A key the model
# never supplied falls back to the block's flat color.
static func _surface_material(key: String, resolved: Dictionary, is_tinted: bool,
		tint: Color, fallback: Color) -> Material:
	if not resolved.has(key):
		var c := StandardMaterial3D.new()
		c.albedo_color = fallback
		return c
	var info: Dictionary = resolved[key]
	var asset: TextureAsset = info["asset"]
	var m := StandardMaterial3D.new()
	m.albedo_texture = info["tex"]
	m.albedo_color = tint if is_tinted else Color.WHITE
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	match asset.transparency:
		TextureAsset.Transparency.CUTOUT:
			m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
		TextureAsset.Transparency.TRANSLUCENT:
			m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m

static func _builtin_id(shape: BlockType.Shape) -> String:
	match shape:
		BlockType.Shape.SLAB: return BlockModel.BUILTIN_SLAB
		BlockType.Shape.STAIRS: return BlockModel.BUILTIN_STAIRS
		_: return BlockModel.BUILTIN_FULL
