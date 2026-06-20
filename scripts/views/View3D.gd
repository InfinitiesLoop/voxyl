class_name View3D
extends Control

var _viewport: SubViewport
var _camera: Camera3D
var _voxel_root: Node3D
var _camera_yaw := 45.0
var _camera_pitch := 35.0
var _camera_distance := 24.0
var _drag_origin := Vector2.ZERO
var _is_dragging := false
var _dirty := false

func _ready() -> void:
	_setup_viewport()
	VoxelWorld.project_opened.connect(func(_p): _mark_dirty())
	VoxelWorld.block_changed.connect(func(_p, _s): _mark_dirty())
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty())

func _setup_viewport() -> void:
	var svc := SubViewportContainer.new()
	svc.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	svc.stretch = true
	svc.gui_input.connect(_on_svc_input)
	add_child(svc)

	_viewport = SubViewport.new()
	_viewport.transparent_bg = false
	svc.add_child(_viewport)

	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.13, 0.13, 0.18)
	env.ambient_light_color = Color(0.55, 0.55, 0.60)
	env.ambient_light_energy = 1.0
	world_env.environment = env
	_viewport.add_child(world_env)

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.2
	sun.shadow_enabled = false
	_viewport.add_child(sun)

	_camera = Camera3D.new()
	_viewport.add_child(_camera)

	_voxel_root = Node3D.new()
	_viewport.add_child(_voxel_root)

	_update_camera()

func _update_camera() -> void:
	if not _camera:
		return
	var pivot := _get_world_center()
	var yaw_rad := deg_to_rad(_camera_yaw)
	var pitch_rad := deg_to_rad(_camera_pitch)
	var offset := Vector3(
		_camera_distance * cos(pitch_rad) * sin(yaw_rad),
		_camera_distance * sin(pitch_rad),
		_camera_distance * cos(pitch_rad) * cos(yaw_rad)
	)
	_camera.position = pivot + offset
	_camera.look_at(pivot, Vector3.UP)

func _get_world_center() -> Vector3:
	if not VoxelWorld.active_project:
		return Vector3.ZERO
	var s := VoxelWorld.active_project.data.size
	return Vector3(s.x * 0.5, s.y * 0.5, s.z * 0.5)

func _mark_dirty(_arg = null) -> void:
	if not _dirty:
		_dirty = true
		call_deferred("_rebuild")

func _rebuild() -> void:
	_dirty = false
	for child in _voxel_root.get_children():
		_voxel_root.remove_child(child)
		child.free()

	if not VoxelWorld.active_project:
		return

	var data := VoxelWorld.active_project.data
	var materials: Dictionary = {}

	for pos: Vector3i in data.cells.keys():
		var semantic: String = data.cells[pos]
		if semantic.is_empty():
			continue
		if not materials.has(semantic):
			var mat := StandardMaterial3D.new()
			mat.albedo_color = VoxelWorld.get_color_for_semantic(semantic)
			materials[semantic] = mat
		var mi := MeshInstance3D.new()
		var mesh := BoxMesh.new()
		mesh.size = Vector3(0.94, 0.94, 0.94)
		mi.mesh = mesh
		mi.material_override = materials[semantic]
		mi.position = Vector3(pos.x, pos.y, pos.z)
		_voxel_root.add_child(mi)

	_update_camera()

func _on_svc_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			_is_dragging = mb.pressed
			_drag_origin = mb.position
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			_camera_distance = max(3.0, _camera_distance - 1.5)
			_update_camera()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_camera_distance = min(120.0, _camera_distance + 1.5)
			_update_camera()
	elif event is InputEventMouseMotion and _is_dragging:
		var motion := event as InputEventMouseMotion
		var delta: Vector2 = motion.position - _drag_origin
		_drag_origin = event.position
		_camera_yaw -= delta.x * 0.4
		_camera_pitch = clamp(_camera_pitch - delta.y * 0.4, 2.0, 88.0)
		_update_camera()
