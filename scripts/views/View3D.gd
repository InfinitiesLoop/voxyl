class_name View3D
extends Control

# --- Orbit state (default / non-fly) ---
var _orbit_yaw := 45.0
var _orbit_pitch := 35.0
var _orbit_distance := 24.0
var _orbit_pressing := false
var _orbit_moved := false
var _drag_last := Vector2.ZERO

# --- Fly state ---
var _fly_mode := false
var _camera_pos := Vector3.ZERO
var _yaw := 0.0
var _pitch := 0.0
# Right-side modifier keys tracked manually via KEY_LOCATION_RIGHT:
#   right-ctrl (Windows) and right-alt/option (Mac) = jump/up
#   right-shift = sneak/down (same as left-shift, tracked for reset-on-exit)
var _rctrl_held := false
var _ralt_held := false
var _rshift_held := false

# --- Raycast result ---
var _target_hit := false
var _target_block := Vector3i.ZERO
var _target_place := Vector3i.ZERO

# --- Nodes ---
var _viewport: SubViewport
var _camera: Camera3D
var _voxel_root: Node3D
var _highlight: MeshInstance3D
var _overlay: Control

# --- Dirty flag ---
var _dirty := false

func _ready() -> void:
	_setup_viewport()
	_setup_overlay()
	VoxelWorld.project_opened.connect(_on_project_opened)
	VoxelWorld.block_changed.connect(func(_p, _s): _mark_dirty())
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty())
	visibility_changed.connect(func(): if not visible and _fly_mode: _exit_fly_mode())
	set_process(true)

func _on_project_opened(_p: VoxelProject) -> void:
	_mark_dirty()
	var s := VoxelWorld.active_project.data.size
	_orbit_distance = max(s.x, s.y, s.z) * 2.0
	_update_camera()

# ---------------------------------------------------------------------------
# Scene setup
# ---------------------------------------------------------------------------

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
	env.background_color = Color(0.10, 0.10, 0.14)
	env.ambient_light_color = Color(0.5, 0.5, 0.55)
	env.ambient_light_energy = 1.0
	world_env.environment = env
	_viewport.add_child(world_env)

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.3
	_viewport.add_child(sun)

	_camera = Camera3D.new()
	_viewport.add_child(_camera)

	_voxel_root = Node3D.new()
	_viewport.add_child(_voxel_root)

	# Highlight overlay for targeted block
	_highlight = MeshInstance3D.new()
	var hl_mesh := BoxMesh.new()
	hl_mesh.size = Vector3(1.04, 1.04, 1.04)
	_highlight.mesh = hl_mesh
	var hl_mat := StandardMaterial3D.new()
	hl_mat.albedo_color = Color(1.0, 1.0, 1.0, 0.35)
	hl_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	hl_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	hl_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	_highlight.material_override = hl_mat
	_highlight.visible = false
	_viewport.add_child(_highlight)

	_update_camera()

func _setup_overlay() -> void:
	_overlay = Control.new()
	_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_overlay.visible = false
	_overlay.draw.connect(_draw_overlay)
	add_child(_overlay)

# ---------------------------------------------------------------------------
# Per-frame update (fly movement)
# ---------------------------------------------------------------------------

func _process(delta: float) -> void:
	if not _fly_mode or not is_visible_in_tree():
		return
	var forward := _get_look_dir()
	var flat_fwd := Vector3(forward.x, 0.0, forward.z)
	if flat_fwd.length_squared() > 0.0:
		flat_fwd = flat_fwd.normalized()
	var right := flat_fwd.cross(Vector3.UP)
	var move := Vector3.ZERO
	if Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP):    move += flat_fwd
	if Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN):  move -= flat_fwd
	if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT):  move -= right
	if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT): move += right
	# Up: Space (right-hand) · Right-Ctrl/Windows or Right-Option/Mac (left-hand)
	if Input.is_key_pressed(KEY_SPACE) or _rctrl_held or _ralt_held: move.y += 1.0
	# Down: any Shift (right-hand sneak) · / (left-hand sneak)
	if Input.is_key_pressed(KEY_SHIFT) or Input.is_key_pressed(KEY_SLASH): move.y -= 1.0
	if move.length_squared() > 0.0:
		_camera_pos += move.normalized() * 10.0 * delta
		_update_camera()
		_update_crosshair_target()

# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree():
		return
	if event is InputEventKey:
		var key := event as InputEventKey
		# Track right-side modifier keys (KEY_LOCATION_RIGHT distinguishes left vs right)
		if key.location == KEY_LOCATION_RIGHT:
			match key.physical_keycode:
				KEY_CTRL:  _rctrl_held  = key.pressed
				KEY_ALT:   _ralt_held   = key.pressed
				KEY_SHIFT: _rshift_held = key.pressed
		if key.keycode == KEY_ESCAPE and key.pressed and _fly_mode:
			_exit_fly_mode()
			get_viewport().set_input_as_handled()
			return
	if not _fly_mode:
		return
	if event is InputEventMouseMotion:
		var motion := event as InputEventMouseMotion
		_yaw -= motion.relative.x * 0.18
		_pitch = clamp(_pitch - motion.relative.y * 0.18, -89.0, 89.0)
		_update_camera()
		_update_crosshair_target()
	elif event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			_erase_targeted_block()
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			_place_targeted_block()

# Orbit camera input (only active when NOT in fly mode)
func _on_svc_input(event: InputEvent) -> void:
	if _fly_mode:
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_orbit_pressing = true
				_orbit_moved = false
				_drag_last = mb.position
			else:
				_orbit_pressing = false
				if not _orbit_moved:
					_enter_fly_mode()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			_orbit_distance = max(3.0, _orbit_distance - 1.5)
			_update_camera()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_orbit_distance = min(150.0, _orbit_distance + 1.5)
			_update_camera()
	elif event is InputEventMouseMotion and _orbit_pressing:
		_orbit_moved = true
		var motion := event as InputEventMouseMotion
		var delta: Vector2 = motion.position - _drag_last
		_drag_last = motion.position
		_orbit_yaw -= delta.x * 0.4
		_orbit_pitch = clamp(_orbit_pitch - delta.y * 0.4, 2.0, 88.0)
		_update_camera()

# ---------------------------------------------------------------------------
# Fly mode enter / exit
# ---------------------------------------------------------------------------

func _enter_fly_mode() -> void:
	# Position fly camera at the current orbit camera position
	var pivot := _get_world_center()
	var yaw_rad := deg_to_rad(_orbit_yaw)
	var pitch_rad := deg_to_rad(_orbit_pitch)
	var offset := Vector3(
		sin(yaw_rad) * cos(pitch_rad),
		sin(pitch_rad),
		cos(yaw_rad) * cos(pitch_rad)
	) * _orbit_distance
	_camera_pos = pivot + offset
	# Look direction is the inverse of the orbit offset
	_yaw = _orbit_yaw + 180.0
	_pitch = -_orbit_pitch
	_fly_mode = true
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	_overlay.visible = true
	_update_camera()
	_update_crosshair_target()
	_overlay.queue_redraw()

func _sync_orbit_from_fly() -> void:
	# Derive orbit yaw/pitch/distance from the current fly camera position so
	# the orbit view picks up exactly where first-person left off.
	var pivot := _get_world_center()
	var offset := _camera_pos - pivot
	_orbit_distance = offset.length()
	if _orbit_distance < 0.01:
		return
	var norm := offset / _orbit_distance
	_orbit_pitch = rad_to_deg(asin(clamp(norm.y, -1.0, 1.0)))
	_orbit_yaw = rad_to_deg(atan2(norm.x, norm.z))

func _exit_fly_mode() -> void:
	_sync_orbit_from_fly()
	_fly_mode = false
	_orbit_pressing = false
	_rctrl_held = false
	_ralt_held = false
	_rshift_held = false
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	_overlay.visible = false
	_highlight.visible = false
	_update_camera()

# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------

func _update_camera() -> void:
	if not _camera:
		return
	if _fly_mode:
		_camera.position = _camera_pos
		var look_target := _camera_pos + _get_look_dir()
		_camera.look_at(look_target, Vector3.UP)
	else:
		var pivot := _get_world_center()
		var yaw_rad := deg_to_rad(_orbit_yaw)
		var pitch_rad := deg_to_rad(_orbit_pitch)
		var offset := Vector3(
			sin(yaw_rad) * cos(pitch_rad),
			sin(pitch_rad),
			cos(yaw_rad) * cos(pitch_rad)
		) * _orbit_distance
		_camera.position = pivot + offset
		_camera.look_at(pivot, Vector3.UP)

func _get_look_dir() -> Vector3:
	var yaw_rad := deg_to_rad(_yaw)
	var pitch_rad := deg_to_rad(_pitch)
	return Vector3(
		sin(yaw_rad) * cos(pitch_rad),
		sin(pitch_rad),
		cos(yaw_rad) * cos(pitch_rad)
	)

func _get_world_center() -> Vector3:
	if not VoxelWorld.active_project:
		return Vector3.ZERO
	var s := VoxelWorld.active_project.data.size
	return Vector3(s.x * 0.5, s.y * 0.5, s.z * 0.5)

# ---------------------------------------------------------------------------
# Voxel rebuild
# ---------------------------------------------------------------------------

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
		# +0.5 centres the BoxMesh within the DDA cell (x,y,z)→(x+1,y+1,z+1)
		mi.position = Vector3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
		_voxel_root.add_child(mi)

# ---------------------------------------------------------------------------
# Raycast (DDA grid traversal)
# ---------------------------------------------------------------------------

func _update_crosshair_target() -> void:
	if not VoxelWorld.active_project:
		_target_hit = false
		_highlight.visible = false
		return
	var result := _raycast_grid(_camera_pos, _get_look_dir(), 20.0)
	_target_hit = result.get("hit", false)
	if _target_hit:
		_target_block = result.pos
		_target_place = result.prev_pos
		_highlight.position = Vector3(_target_block.x + 0.5, _target_block.y + 0.5, _target_block.z + 0.5)
		_highlight.visible = true
	else:
		_highlight.visible = false

func _raycast_grid(origin: Vector3, direction: Vector3, max_dist: float) -> Dictionary:
	if not VoxelWorld.active_project:
		return {hit = false}
	var data := VoxelWorld.active_project.data
	var dir := direction.normalized()

	var ix := int(floor(origin.x))
	var iy := int(floor(origin.y))
	var iz := int(floor(origin.z))

	var sx: int = int(sign(dir.x))
	var sy: int = int(sign(dir.y))
	var sz: int = int(sign(dir.z))

	var tx: float = ((float(ix) + (1.0 if dir.x > 0.0 else 0.0)) - origin.x) / dir.x if dir.x != 0.0 else INF
	var ty: float = ((float(iy) + (1.0 if dir.y > 0.0 else 0.0)) - origin.y) / dir.y if dir.y != 0.0 else INF
	var tz: float = ((float(iz) + (1.0 if dir.z > 0.0 else 0.0)) - origin.z) / dir.z if dir.z != 0.0 else INF

	var dtx: float = (1.0 / abs(dir.x)) if dir.x != 0.0 else INF
	var dty: float = (1.0 / abs(dir.y)) if dir.y != 0.0 else INF
	var dtz: float = (1.0 / abs(dir.z)) if dir.z != 0.0 else INF

	var prev := Vector3i(ix, iy, iz)
	var t := 0.0

	while t < max_dist:
		var cur := Vector3i(ix, iy, iz)
		if data.is_in_bounds(cur) and not data.get_block(cur).is_empty():
			return {hit = true, pos = cur, prev_pos = prev}
		prev = cur
		if tx <= ty and tx <= tz:
			t = tx; tx += dtx; ix += sx
		elif ty <= tz:
			t = ty; ty += dty; iy += sy
		else:
			t = tz; tz += dtz; iz += sz

	return {hit = false}

# ---------------------------------------------------------------------------
# Block editing (fly mode)
# ---------------------------------------------------------------------------

func _place_targeted_block() -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	if not VoxelWorld.active_project.data.is_in_bounds(_target_place):
		return
	if not VoxelWorld.selected_semantic.is_empty():
		VoxelWorld.set_block(_target_place, VoxelWorld.selected_semantic)
		_update_crosshair_target()

func _erase_targeted_block() -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	VoxelWorld.clear_block(_target_block)
	_update_crosshair_target()

# ---------------------------------------------------------------------------
# 2D overlay: crosshair + hint text
# ---------------------------------------------------------------------------

func _draw_overlay() -> void:
	var center := _overlay.size / 2.0
	var color := Color(1.0, 1.0, 1.0, 0.9)
	_overlay.draw_line(center + Vector2(-14, 0), center + Vector2(14, 0), color, 1.5)
	_overlay.draw_line(center + Vector2(0, -14), center + Vector2(0, 14), color, 1.5)
	_overlay.draw_circle(center, 3.0, Color(0, 0, 0, 0.4))

	var font := ThemeDB.fallback_font
	var hint := "WASD / Arrows  ·  Space · RCtrl · ROpt = up  ·  Shift · / = down  ·  LMB erase  ·  RMB place  ·  Esc exit"
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 12.0), hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.55))
