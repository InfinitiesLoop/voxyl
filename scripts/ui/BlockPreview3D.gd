class_name BlockPreview3D
extends Control

# A real, rotatable 3D render of a single library block, for the Block Types detail
# panel. It mirrors View3D's viewport/light/material setup but frames one centered
# block instead of a project: same shared BlockMesher geometry and the same
# NEAREST-filtered textured materials, so a block looks identical here and in-scene.
#
# It resolves model + textures straight from the BlockType (library blocks aren't in
# any project/palette), staying a lens on the material layer — no voxel data involved.

# Look direction the camera sits along (normalized); zoom scales the distance.
const _CAM_DIR := Vector3(0.9, 0.7, 1.2)
const _AUTO_SPIN := 0.6   # radians/sec idle rotation

var _viewport: SubViewport
var _camera: Camera3D
var _pivot: Node3D
var _mesh_instance: MeshInstance3D

var _cam_dist := 2.6
var _dragging := false
var _drag_last := Vector2.ZERO

func _ready() -> void:
	var svc := SubViewportContainer.new()
	svc.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	svc.stretch = true
	svc.gui_input.connect(_on_svc_input)
	add_child(svc)

	_viewport = SubViewport.new()
	_viewport.transparent_bg = true
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	# Isolate the preview in its own World3D. Otherwise the SubViewport shares the
	# window's world with the (possibly hidden) View3D panes, whose sky sphere, grid
	# plane and lights would bleed into the preview behind the block.
	_viewport.own_world_3d = true
	svc.add_child(_viewport)

	# Ambient so unlit faces aren't black; the scene background stays transparent.
	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_CLEAR_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.72, 0.74, 0.80)
	env.ambient_light_energy = 1.0
	world_env.environment = env
	_viewport.add_child(world_env)

	# Key + fill, mirroring View3D's directional rig.
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.3
	_viewport.add_child(sun)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(40, -135, 0)
	fill.light_energy = 0.5
	_viewport.add_child(fill)

	_camera = Camera3D.new()
	_viewport.add_child(_camera)
	_update_camera()

	_pivot = Node3D.new()
	_viewport.add_child(_pivot)
	_mesh_instance = MeshInstance3D.new()
	_pivot.add_child(_mesh_instance)

	set_process(true)

func _process(delta: float) -> void:
	if not _dragging and is_visible_in_tree():
		_pivot.rotation.y += delta * _AUTO_SPIN

# Render `bt` (or clear when null). Resolves the model's textures through the
# workspace library; textured models get one StandardMaterial3D per surface, plain
# ones a single color material (the planning path). Animated textures show frame 0.
func set_block(bt: BlockType) -> void:
	# Rebuild the instance so stale per-surface overrides never linger across blocks.
	_mesh_instance.queue_free()
	_mesh_instance = MeshInstance3D.new()
	_pivot.add_child(_mesh_instance)
	if bt == null:
		return
	var model := _model_for(bt)
	if model == null:
		return
	var resolved := _resolve_textures(model)
	if resolved.is_empty():
		_mesh_instance.mesh = BlockMesher.color_mesh(model)
		var m := StandardMaterial3D.new()
		m.albedo_color = bt.color
		_mesh_instance.material_override = m
		return
	var entry := BlockMesher.textured_mesh(model)
	_mesh_instance.mesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	for i in keys.size():
		_mesh_instance.set_surface_override_material(i,
			_surface_material(keys[i], resolved, bool(tinted[i]), bt.tint, bt.color))

# --- Input: drag-to-spin + scroll-to-zoom -----------------------------------

func _on_svc_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_LEFT:
				_dragging = mb.pressed
				_drag_last = mb.position
			MOUSE_BUTTON_WHEEL_UP:
				if mb.pressed:
					_cam_dist = clampf(_cam_dist - 0.3, 1.5, 6.0)
					_update_camera()
			MOUSE_BUTTON_WHEEL_DOWN:
				if mb.pressed:
					_cam_dist = clampf(_cam_dist + 0.3, 1.5, 6.0)
					_update_camera()
	elif event is InputEventMouseMotion and _dragging:
		var rel := (event as InputEventMouseMotion).relative
		_pivot.rotation.y -= rel.x * 0.01
		_pivot.rotation.x = clampf(_pivot.rotation.x - rel.y * 0.01, -1.3, 1.3)

# --- Internals --------------------------------------------------------------

func _update_camera() -> void:
	if not _camera:
		return
	_camera.position = _CAM_DIR.normalized() * _cam_dist
	_camera.look_at(Vector3.ZERO, Vector3.UP)

# Texture-key bindings resolved to drawable textures (shared with the grid's cache,
# so a PNG decodes once). Animated assets resolve to their frame-0 sub-image.
# Returns key -> { asset, tex }.
func _resolve_textures(model: BlockModel) -> Dictionary:
	var out := {}
	if not model.has_textures():
		return out
	for key in model.textures:
		var asset := VoxelWorld.workspace.get_texture_asset(model.textures[key])
		if asset == null:
			continue
		# Shared with the grid's cache; animated assets resolve to a real frame-0
		# texture (a 3D material can't crop an AtlasTexture region).
		var tex := BlockIconRender.face_texture(asset)
		if tex == null:
			continue
		out[key] = {"asset": asset, "tex": tex}
	return out

# Material for one surface: the bound texture (NEAREST, with CUTOUT/TRANSLUCENT from
# the asset), tinted only when the surface opts in via tint_index. A key the model
# never supplied falls back to the block's flat color.
func _surface_material(key: String, resolved: Dictionary, is_tinted: bool,
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

# The model to render: the block's explicit model_id (library), else the built-in
# for its shape (mirrors VoxelWorld.get_model_for_semantic, but from the block type).
func _model_for(bt: BlockType) -> BlockModel:
	if not bt.model_id.is_empty():
		var m := VoxelWorld.workspace.get_block_model(bt.model_id)
		if m != null:
			return m
	var shape_id := _builtin_id(bt.shape)
	var builtin := VoxelWorld.workspace.get_block_model(shape_id)
	return builtin if builtin != null else BlockModel.builtin_by_id(shape_id)

func _builtin_id(shape: BlockType.Shape) -> String:
	match shape:
		BlockType.Shape.SLAB: return BlockModel.BUILTIN_SLAB
		BlockType.Shape.STAIRS: return BlockModel.BUILTIN_STAIRS
		_: return BlockModel.BUILTIN_FULL
