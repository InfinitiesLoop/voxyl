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

# A preview's connection state for a multipart/connecting block: connected on the
# two opposite horizontal sides (EAST+WEST), nothing else. Rendering a connector as a
# straight run rather than in isolation is how MC shows these in the inventory — a
# glass pane reads as a full face-on pane, a fence/wall/bars as a clean straight
# section — instead of the lonely post/nub a truly-isolated cell resolves to. Keyed
# purely off is_multipart(), so no block ever needs special-casing. "tall" is the
# strongest connection value, so it satisfies boolean (fence/pane) and multi-value
# (wall low/tall) `when` clauses alike.
const _PREVIEW_CONNECTIONS := {
	BlockModel.Dir.NORTH: "none", BlockModel.Dir.EAST: "tall",
	BlockModel.Dir.SOUTH: "none", BlockModel.Dir.WEST: "tall",
	BlockModel.Dir.UP: "none", BlockModel.Dir.DOWN: "none",
}

# Memoized mesh geometry, shared across every block that resolves to the same model.
# BlockMesher builds pure geometry from a BlockModel: the mesh is a function of the model
# alone — the bound textures live in the per-block MATERIALS below, not in the mesh — so the
# thousands of blocks in a modpack that share a model (every full cube, every pane, every
# stair…) would otherwise each rebuild a byte-identical SurfaceTool mesh, the dominant CPU
# cost of a mass icon bake. Keyed by the model's instance id: VoxelWorkspace returns one
# BlockModel instance per id, so all its blocks hit the same entry; `rev` (BlockModel
# .revision) guards an in-place model edit. A Mesh is a resource assigned to
# MeshInstance3D.mesh with per-instance override materials, so one mesh is safely shared by
# many instances (nothing here mutates it). Cleared on workspace_changed — a reimport frees
# and recreates models (and Godot can recycle a freed instance id), so the cache must never
# outlive the workspace it was built against.
static var _color_cache := {}      # model instance_id -> { rev, mesh }
static var _textured_cache := {}   # model instance_id -> { rev, mesh, keys, tinted }
static var _cache_hooked := false

# The parts a multipart block shows in a preview (icon / detail panel). Shared with
# BlockIconBaker's cache signature so the cached icon and the live render always agree.
static func preview_parts(sm: BlockStateMap) -> Array:
	return sm.resolve_parts(_PREVIEW_CONNECTIONS)

# Configure `mi` to render `bt`. Pass a freshly created MeshInstance3D. A null block
# (or a block whose model is missing) leaves the instance empty.
#
# A connecting/multipart block (fence, pane, wall, …) renders its PREVIEW state — a
# straight EAST+WEST run (see _PREVIEW_CONNECTIONS) — as one child MeshInstance3D per
# resolved part, rather than just `bt.model_id`'s bare post. This is deliberately not
# a per-block special case: the parts come straight from the block's own imported
# blockstate, so a glass pane reads as a full face-on pane and a fence/wall as a clean
# straight section, with zero pane-specific code.
static func build_into(mi: MeshInstance3D, bt: BlockType) -> void:
	if bt == null:
		return
	_hook_invalidation()
	var sm := bt.state_map
	if sm != null and sm.is_multipart():
		for part in preview_parts(sm):
			var part_model := VoxelWorld.workspace.get_block_model(str(part.get("model_id", "")))
			if part_model == null:
				continue
			var child := MeshInstance3D.new()
			mi.add_child(child)
			child.transform = Transform3D(
				BlockMesher.rotation_basis(int(part.get("x_rot", 0)), int(part.get("y_rot", 0))), Vector3.ZERO)
			_build_model_into(child, part_model, bt)
		return
	var model := model_for(bt)
	if model == null:
		return
	_build_model_into(mi, model, bt)

# The mesh + materials for one already-resolved model, shared by the plain-block path
# and each multipart child above.
static func _build_model_into(mi: MeshInstance3D, model: BlockModel, bt: BlockType) -> void:
	var resolved := _resolve_textures(model)
	if resolved.is_empty():
		mi.mesh = _color_mesh_cached(model)
		var m := StandardMaterial3D.new()
		m.albedo_color = bt.color
		mi.material_override = m
		return
	var entry := _textured_mesh_cached(model)
	mi.mesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	for i in keys.size():
		mi.set_surface_override_material(i,
			_surface_material(keys[i], resolved, bool(tinted[i]), bt.tint, bt.color))

# The geometry for a model, built once and reused (see _color_cache/_textured_cache). The
# color path and the textured path are mutually exclusive for a given model, so each has its
# own cache; the per-block materials are still built fresh by the callers above.
static func _color_mesh_cached(model: BlockModel) -> Mesh:
	var iid := model.get_instance_id()
	var hit: Dictionary = _color_cache.get(iid, {})
	if not hit.is_empty() and hit["rev"] == model.revision:
		return hit["mesh"]
	var mesh := BlockMesher.color_mesh(model)
	_color_cache[iid] = {"rev": model.revision, "mesh": mesh}
	return mesh

static func _textured_mesh_cached(model: BlockModel) -> Dictionary:
	var iid := model.get_instance_id()
	var hit: Dictionary = _textured_cache.get(iid, {})
	if not hit.is_empty() and hit["rev"] == model.revision:
		return hit
	var entry := BlockMesher.textured_mesh(model)
	entry["rev"] = model.revision
	_textured_cache[iid] = entry
	return entry

# Wire the geometry cache to workspace_changed exactly once. A static-only class can't
# _ready, so build_into calls this on every render; VoxelWorld is an autoload, so it's always
# present by the time any block renders.
static func _hook_invalidation() -> void:
	if _cache_hooked:
		return
	_cache_hooked = true
	VoxelWorld.workspace_changed.connect(clear_mesh_cache)

static func clear_mesh_cache() -> void:
	_color_cache.clear()
	_textured_cache.clear()

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

# The library-relative image paths a block will pull through BlockTextureCache when built —
# i.e. exactly the textures build_into resolves (its model, or each multipart part's model).
# Added into `into` used as a set (path -> true) so a caller can dedupe across many blocks and
# hand the union to BlockTextureCache.predecode, decoding them in parallel before building.
static func collect_texture_paths(bt: BlockType, into: Dictionary) -> void:
	if bt == null:
		return
	var sm := bt.state_map
	if sm != null and sm.is_multipart():
		for part in preview_parts(sm):
			_collect_model_paths(VoxelWorld.workspace.get_block_model(str(part.get("model_id", ""))), into)
	else:
		_collect_model_paths(model_for(bt), into)

static func _collect_model_paths(model: BlockModel, into: Dictionary) -> void:
	if model == null or not model.has_textures():
		return
	for key in model.textures:
		var asset := VoxelWorld.workspace.get_texture_asset(model.textures[key])
		if asset != null and not asset.image_path.is_empty():
			into[asset.image_path] = true

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
