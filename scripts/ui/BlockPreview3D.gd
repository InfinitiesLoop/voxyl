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

# Render `bt` (or clear when null) via the shared BlockRender3D builder, so this
# rotatable preview and the baked grid icons resolve geometry + materials the same way.
func set_block(bt: BlockType) -> void:
	# Rebuild the instance so stale per-surface overrides never linger across blocks.
	_mesh_instance.queue_free()
	_mesh_instance = MeshInstance3D.new()
	_pivot.add_child(_mesh_instance)
	BlockRender3D.build_into(_mesh_instance, bt)

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
