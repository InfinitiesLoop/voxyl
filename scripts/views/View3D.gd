class_name View3D
extends Control

# ---------------------------------------------------------------------------
# Single unified camera — one position/orientation used in both modes.
# "Fly mode" only controls whether the cursor is captured.
# Clicking captures cursor; Esc releases it. Position never jumps.
# ---------------------------------------------------------------------------

# Camera transform
var _camera_pos := Vector3(8, 12, 28)
var _yaw := 180.0    # horizontal look angle (degrees)
var _pitch := -20.0  # vertical look angle (degrees)

# Whether the cursor is captured (first-person controls active)
var _fly_mode := false

# Drag-to-look state (used in non-captured mode)
var _drag_looking := false
var _drag_last := Vector2.ZERO

# Right-side modifier keys tracked via KEY_LOCATION_RIGHT:
#   right-ctrl (Windows) / right-alt·option (Mac) = jump/up
#   right-shift = sneak/down (same as left-shift)
var _rctrl_held := false
var _ralt_held := false
var _rshift_held := false

# --- Raycast state ---
var _target_hit := false
var _target_block := Vector3i.ZERO
var _target_place := Vector3i.ZERO
var _floor_hit := false
var _floor_place := Vector3i.ZERO
var _floor_y := 0  # Y level of the virtual placement floor

# --- Nodes ---
var _viewport: SubViewport
var _camera: Camera3D
var _voxel_root: Node3D
var _highlight: MeshInstance3D
var _highlight_mat: StandardMaterial3D
var _overlay: Control
var _world_env: WorldEnvironment
var _grid_plane: MeshInstance3D
var _sky_sphere: MeshInstance3D

# --- Skybox ---
var _skyboxes: Array = []
var _current_sky: int = 0
var _sky_label_timer: float = 0.0

# --- Dirty flag ---
var _dirty := false

func _ready() -> void:
	_setup_viewport()
	_setup_overlay()
	VoxelWorld.project_opened.connect(_on_project_opened)
	VoxelWorld.block_changed.connect(func(_p, _s): _mark_dirty())
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.selection_changed.connect(func(_s): if _fly_mode: _overlay.queue_redraw())
	visibility_changed.connect(func(): if not visible and _fly_mode: _release_cursor())
	set_process(true)

func _on_project_opened(_p: VoxelProject) -> void:
	_mark_dirty()
	# Position camera to see the whole scene on first open
	var center := _get_world_center()
	var dist := 16.0
	_camera_pos = center + Vector3(sin(deg_to_rad(225.0)) * dist * 0.7, dist * 0.55, cos(deg_to_rad(225.0)) * dist * 0.7)
	_yaw = 45.0
	_pitch = -30.0
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

	_world_env = WorldEnvironment.new()
	_world_env.environment = Environment.new()
	_viewport.add_child(_world_env)
	_init_skyboxes()
	_apply_sky()

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.3
	_viewport.add_child(sun)

	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(40, -135, 0)
	fill.light_color = Color(1.0, 1.0, 1.0)
	fill.light_energy = 0.5
	_viewport.add_child(fill)

	_sky_sphere = MeshInstance3D.new()
	var sphere_mesh := SphereMesh.new()
	sphere_mesh.radius = 450.0
	sphere_mesh.height = 900.0
	sphere_mesh.radial_segments = 32
	sphere_mesh.rings = 16
	_sky_sphere.mesh = sphere_mesh
	var sky_mat := ShaderMaterial.new()
	sky_mat.shader = _make_sky_shader()
	sky_mat.render_priority = -100
	_sky_sphere.material_override = sky_mat
	_viewport.add_child(_sky_sphere)

	_grid_plane = MeshInstance3D.new()
	var plane_mesh := PlaneMesh.new()
	plane_mesh.size = Vector2(600.0, 600.0)
	_grid_plane.mesh = plane_mesh
	var grid_mat := ShaderMaterial.new()
	grid_mat.shader = _make_grid_shader()
	_grid_plane.material_override = grid_mat
	_grid_plane.position.y = -0.01
	_viewport.add_child(_grid_plane)

	_camera = Camera3D.new()
	_viewport.add_child(_camera)

	_voxel_root = Node3D.new()
	_viewport.add_child(_voxel_root)

	_highlight_mat = StandardMaterial3D.new()
	_highlight_mat.albedo_color = Color(1.0, 1.0, 1.0, 1.0)
	_highlight_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_highlight_mat.flags_use_point_size = false

	_highlight = MeshInstance3D.new()
	_highlight.mesh = ImmediateMesh.new()
	_highlight.material_override = _highlight_mat
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
# Skybox presets
# ---------------------------------------------------------------------------

func _init_skyboxes() -> void:
	_skyboxes = [
		{"name": "Night", "fn": "_sky_night"},
	]

func _apply_sky() -> void:
	var env := _world_env.environment
	call(_skyboxes[_current_sky]["fn"], env)

func _sky_night(env: Environment) -> void:
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.02, 0.00, 0.06)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.25, 0.18, 0.5)
	env.ambient_light_energy = 0.9

func _make_sky_shader() -> Shader:
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode unshaded, cull_front, depth_draw_never, blend_mix;

varying vec3 sky_dir;

void vertex() {
	sky_dir = VERTEX;
}

// 3D hash — no seams because there are no UV coordinates to wrap
float hash3(vec3 p) {
	p = fract(p * vec3(127.1, 311.7, 74.7));
	p += dot(p, p.yzx + 74.27);
	return fract((p.x + p.y) * p.z);
}

// 3D value noise — evaluates smoothly across any direction, zero seams
float vnoise3(vec3 p) {
	vec3 i = floor(p);
	vec3 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(hash3(i),               hash3(i + vec3(1,0,0)), f.x),
		    mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
		mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
		    mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
		f.z);
}

// Stars via cube-face projection: uniform cell size across all sky directions,
// no pole compression, no seam. Each face has its own cell grid.
float stars(vec3 dir, float scale, float threshold) {
	vec3 a = abs(dir);
	vec2 fuv;
	float face;
	if (a.x >= a.y && a.x >= a.z) {
		fuv = dir.yz / a.x;  face = sign(dir.x);
	} else if (a.y >= a.x && a.y >= a.z) {
		fuv = dir.xz / a.y;  face = sign(dir.y) + 2.0;
	} else {
		fuv = dir.xy / a.z;  face = sign(dir.z) + 4.0;
	}
	vec2 cell = floor((fuv * 0.5 + 0.5) * scale);
	vec2 local = fract((fuv * 0.5 + 0.5) * scale);
	vec3 seed = vec3(cell, face);
	float rng = hash3(seed);
	if (rng < threshold) return 0.0;
	vec2 pos = vec2(hash3(seed + vec3(7.3, 2.1, 0.0)), hash3(seed + vec3(1.7, 9.4, 0.0)));
	float d = length(local - pos);
	float sz = 0.03 + hash3(seed + vec3(3.1, 0.0, 0.0)) * 0.04;
	return smoothstep(sz, 0.0, d) * rng;
}

void fragment() {
	vec3 dir = normalize(sky_dir);

	float s = 0.0;
	s += stars(dir, 50.0,  0.86);
	s += stars(dir, 80.0,  0.89) * 0.7;
	s += stars(dir, 120.0, 0.91) * 0.5;
	s = clamp(s, 0.0, 1.0);

	// Nebula — 3D layered noise, no seam possible
	float n1 = vnoise3(dir * 2.0);
	float n2 = vnoise3(dir * 4.5 + vec3(1.3, 2.7, 0.4));
	float n3 = vnoise3(dir * 9.0 + vec3(2.1, 0.5, 3.2));
	float nebula = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
	nebula = smoothstep(0.45, 0.72, nebula) * 0.5;

	float hv  = vnoise3(dir * 1.5 + vec3(4.0, 2.0, 1.0));
	float hv2 = vnoise3(dir * 1.2 + vec3(0.5, 3.5, 2.0));
	vec3 neb_col = mix(vec3(0.30, 0.04, 0.50), vec3(0.04, 0.15, 0.55), hv);
	neb_col = mix(neb_col, vec3(0.50, 0.06, 0.28), hv2 * 0.35);

	vec3 base = vec3(0.006, 0.001, 0.015);
	ALBEDO = base + neb_col * nebula + vec3(s);
	ALPHA = 1.0;
}
"""
	return shader

func _make_grid_shader() -> Shader:
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode unshaded, cull_disabled, blend_mix, depth_draw_never;

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	// 1-unit grid (cyan)
	vec2 coord = world_pos.xz;
	vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
	float line1 = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);

	// 16-unit chunk grid (purple, thicker)
	vec2 coord8 = world_pos.xz / 16.0;
	vec2 g8 = abs(fract(coord8 - 0.5) - 0.5) / (fwidth(coord8) * 3.0);
	float line8 = 1.0 - clamp(min(g8.x, g8.y), 0.0, 1.0);

	float dist = length(world_pos.xz - CAMERA_POSITION_WORLD.xz);
	float fade = 1.0 - smoothstep(18.0, 55.0, dist);

	vec3 color = mix(vec3(0.08, 0.75, 1.0), vec3(0.65, 0.30, 1.0), line8);
	float alpha = clamp(max(line1, line8 * 2.5), 0.0, 1.0) * fade;

	ALBEDO = color;
	ALPHA = alpha;
}
"""
	return shader

func _cycle_sky() -> void:
	if _skyboxes.size() <= 1:
		return
	_current_sky = (_current_sky + 1) % _skyboxes.size()
	_apply_sky()
	_sky_label_timer = 2.5
	_overlay.queue_redraw()

# ---------------------------------------------------------------------------
# Per-frame movement (only while cursor captured)
# ---------------------------------------------------------------------------

func _process(delta: float) -> void:
	if _sky_label_timer > 0.0:
		_sky_label_timer -= delta
		if _sky_label_timer <= 0.0:
			_overlay.queue_redraw()
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
	if Input.is_key_pressed(KEY_SPACE) or _rctrl_held or _ralt_held: move.y += 1.0
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
		# Track right-side modifiers
		if key.location == KEY_LOCATION_RIGHT:
			match key.physical_keycode:
				KEY_CTRL:  _rctrl_held  = key.pressed
				KEY_ALT:   _ralt_held   = key.pressed
				KEY_SHIFT: _rshift_held = key.pressed

		if key.pressed:
			if key.keycode == KEY_ESCAPE and _fly_mode:
				_release_cursor()
				get_viewport().set_input_as_handled()
				return
			# X / Y / Z — open a 2D slice through the targeted position
			match key.keycode:
				KEY_X: _request_slice(0)
				KEY_Y: _request_slice(1)
				KEY_Z: _request_slice(2)
				KEY_B: _cycle_sky()
			# 1–9 palette slots (captured mode only)
			if _fly_mode:
				var kc := key.keycode
				if kc >= KEY_1 and kc <= KEY_9:
					_select_palette_slot(kc - KEY_1)
					get_viewport().set_input_as_handled()
					return

	if not _fly_mode:
		return

	# --- Captured mouse: look + edit ---
	if event is InputEventMouseMotion:
		var motion := event as InputEventMouseMotion
		_yaw -= motion.relative.x * 0.18
		_pitch = clamp(_pitch - motion.relative.y * 0.18, -89.0, 89.0)
		_update_camera()
		_update_crosshair_target()
	elif event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		var mb := event as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_LEFT:        _erase_targeted_block()
			MOUSE_BUTTON_RIGHT:       _place_targeted_block()
			MOUSE_BUTTON_WHEEL_UP:    _cycle_palette(-1)
			MOUSE_BUTTON_WHEEL_DOWN:  _cycle_palette(1)

# Non-captured mouse: drag-to-look + scroll-to-dolly
func _on_svc_input(event: InputEvent) -> void:
	if _fly_mode:
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_drag_looking = true
				_drag_last = mb.position
			else:
				if not _drag_looking or mb.position.distance_to(_drag_last) < 4.0:
					_capture_cursor()  # short click = enter fly mode
				_drag_looking = false
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			# Dolly forward along look direction
			_camera_pos += _get_look_dir() * 2.5
			_update_camera()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_camera_pos -= _get_look_dir() * 2.5
			_update_camera()
	elif event is InputEventMouseMotion and _drag_looking:
		var motion := event as InputEventMouseMotion
		var delta: Vector2 = motion.position - _drag_last
		_drag_last = motion.position
		_yaw -= delta.x * 0.4
		_pitch = clamp(_pitch - delta.y * 0.4, -89.0, 89.0)
		_update_camera()

# ---------------------------------------------------------------------------
# Cursor capture / release  (position never changes on switch)
# ---------------------------------------------------------------------------

func _capture_cursor() -> void:
	_fly_mode = true
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	_overlay.visible = true
	_update_crosshair_target()
	_overlay.queue_redraw()

func _release_cursor() -> void:
	_fly_mode = false
	_drag_looking = false
	_rctrl_held = false
	_ralt_held = false
	_rshift_held = false
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	_overlay.visible = false
	_highlight.visible = false
	_target_hit = false
	_floor_hit = false

# ---------------------------------------------------------------------------
# Camera  (same update path regardless of fly mode)
# ---------------------------------------------------------------------------

func _update_camera() -> void:
	if not _camera:
		return
	_camera.position = _camera_pos
	var look_target := _camera_pos + _get_look_dir()
	_camera.look_at(look_target, Vector3.UP)
	if _grid_plane:
		_grid_plane.position.x = _camera_pos.x
		_grid_plane.position.z = _camera_pos.z
	if _sky_sphere:
		_sky_sphere.position = _camera_pos

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
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if aabb.is_empty():
		return Vector3.ZERO
	var mn: Vector3i = aabb[0]; var mx: Vector3i = aabb[1]
	return Vector3(mn.x + mx.x + 1, mn.y + mx.y + 1, mn.z + mx.z + 1) * 0.5

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
		mi.position = Vector3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
		_voxel_root.add_child(mi)

# ---------------------------------------------------------------------------
# Raycast
# ---------------------------------------------------------------------------

func _update_crosshair_target() -> void:
	_target_hit = false
	_floor_hit = false
	if not VoxelWorld.active_project:
		_highlight.visible = false
		_overlay.queue_redraw()
		return

	var result := _raycast_grid(_camera_pos, _get_look_dir(), 20.0)
	_target_hit = result.get("hit", false)

	if _target_hit:
		_target_block = result.pos
		_target_place = result.prev_pos
		var normal := _target_place - _target_block
		_highlight_mat.albedo_color = Color(1.0, 1.0, 1.0, 1.0)
		_highlight_mat.transparency = BaseMaterial3D.TRANSPARENCY_DISABLED
		_draw_face_highlight(_target_block, normal)
		_highlight.visible = true
	else:
		var floor_result := _raycast_floor_plane(_camera_pos, _get_look_dir())
		_floor_hit = floor_result.get("hit", false)
		if _floor_hit:
			_floor_place = floor_result.pos
			_highlight_mat.albedo_color = Color(0.08, 0.75, 1.0, 0.22)
			_highlight_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			_draw_floor_fill(_floor_place)
			_highlight.visible = true
		else:
			_highlight.visible = false

	_overlay.queue_redraw()

func _draw_floor_fill(cell: Vector3i) -> void:
	var y := float(cell.y) + 0.005
	var x0 := float(cell.x);  var x1 := x0 + 1.0
	var z0 := float(cell.z);  var z1 := z0 + 1.0
	var im := _highlight.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	im.surface_add_vertex(Vector3(x0, y, z0))
	im.surface_add_vertex(Vector3(x1, y, z0))
	im.surface_add_vertex(Vector3(x1, y, z1))
	im.surface_add_vertex(Vector3(x0, y, z0))
	im.surface_add_vertex(Vector3(x1, y, z1))
	im.surface_add_vertex(Vector3(x0, y, z1))
	im.surface_end()

func _draw_face_highlight(block: Vector3i, normal: Vector3i) -> void:
	var n := Vector3(normal)
	var center := Vector3(block) + Vector3(0.5, 0.5, 0.5) + n * 0.502
	var t1: Vector3
	var t2: Vector3
	if abs(n.y) > 0.5:
		t1 = Vector3(0.5, 0.0, 0.0)
		t2 = Vector3(0.0, 0.0, 0.5)
	elif abs(n.x) > 0.5:
		t1 = Vector3(0.0, 0.5, 0.0)
		t2 = Vector3(0.0, 0.0, 0.5)
	else:
		t1 = Vector3(0.5, 0.0, 0.0)
		t2 = Vector3(0.0, 0.5, 0.0)
	var c0 := center - t1 - t2
	var c1 := center + t1 - t2
	var c2 := center + t1 + t2
	var c3 := center - t1 + t2
	var im := _highlight.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	im.surface_add_vertex(c0); im.surface_add_vertex(c1)
	im.surface_add_vertex(c1); im.surface_add_vertex(c2)
	im.surface_add_vertex(c2); im.surface_add_vertex(c3)
	im.surface_add_vertex(c3); im.surface_add_vertex(c0)
	im.surface_end()

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
		if not data.get_block(cur).is_empty():
			return {hit = true, pos = cur, prev_pos = prev}
		prev = cur
		if tx <= ty and tx <= tz:
			t = tx; tx += dtx; ix += sx
		elif ty <= tz:
			t = ty; ty += dty; iy += sy
		else:
			t = tz; tz += dtz; iz += sz

	return {hit = false}

func _raycast_floor_plane(origin: Vector3, direction: Vector3) -> Dictionary:
	if not VoxelWorld.active_project:
		return {hit = false}
	var dir := direction.normalized()
	if abs(dir.y) < 0.001:
		return {hit = false}
	var t := (float(_floor_y) - origin.y) / dir.y
	if t < 0.05 or t > 80.0:
		return {hit = false}
	var hit_world := origin + dir * t
	var cell := Vector3i(int(floor(hit_world.x)), _floor_y, int(floor(hit_world.z)))
	var data := VoxelWorld.active_project.data
	if not data.get_block(cell).is_empty():
		return {hit = false}
	return {hit = true, pos = cell}

# ---------------------------------------------------------------------------
# Block editing
# ---------------------------------------------------------------------------

func _place_targeted_block() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		return
	var place_pos: Vector3i
	if _target_hit:
		place_pos = _target_place
	elif _floor_hit:
		place_pos = _floor_place
	else:
		return
	VoxelWorld.set_block(place_pos, VoxelWorld.selected_semantic)
	_update_crosshair_target()

func _erase_targeted_block() -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	VoxelWorld.clear_block(_target_block)
	_update_crosshair_target()

# ---------------------------------------------------------------------------
# Slice view requests (X / Y / Z keys)
# ---------------------------------------------------------------------------

func _request_slice(p_axis: int) -> void:
	# Determine the slice position from what the crosshair is pointing at
	var pos_3d: Vector3i
	if _target_hit:
		pos_3d = _target_block
	elif _floor_hit:
		pos_3d = _floor_place
	else:
		var c := _get_world_center()
		pos_3d = Vector3i(int(c.x), int(c.y), int(c.z))

	var slice_p: int
	match p_axis:
		0: slice_p = pos_3d.x
		1: slice_p = pos_3d.y
		2: slice_p = pos_3d.z

	VoxelWorld.request_slice_view(p_axis, slice_p)

# ---------------------------------------------------------------------------
# Palette cycling
# ---------------------------------------------------------------------------

func _cycle_palette(delta: int) -> void:
	var names := VoxelWorld.merged_semantic_names()
	if names.is_empty():
		return
	var idx := names.find(VoxelWorld.selected_semantic)
	if idx < 0: idx = 0
	idx = (idx + delta) % names.size()
	if idx < 0: idx += names.size()
	VoxelWorld.select_semantic(names[idx])

func _select_palette_slot(slot: int) -> void:
	var names := VoxelWorld.merged_semantic_names()
	if slot < names.size():
		VoxelWorld.select_semantic(names[slot])

# ---------------------------------------------------------------------------
# 2D overlay: crosshair · hotbar · hints
# ---------------------------------------------------------------------------

func _draw_overlay() -> void:
	var center := _overlay.size / 2.0
	_overlay.draw_line(center + Vector2(-14, 0),  center + Vector2(14, 0),  Color(1,1,1,0.9), 1.5)
	_overlay.draw_line(center + Vector2(0,  -14), center + Vector2(0,  14), Color(1,1,1,0.9), 1.5)
	_overlay.draw_circle(center, 3.0, Color(0,0,0,0.4))
	_draw_hotbar()
	var font := ThemeDB.fallback_font
	if _sky_label_timer > 0.0 and _skyboxes.size() > 1:
		var sky_name: String = _skyboxes[_current_sky]["name"]
		_overlay.draw_string(font, Vector2(_overlay.size.x * 0.5, 32.0),
			"Sky: " + sky_name, HORIZONTAL_ALIGNMENT_CENTER, -1, 16, Color(1,1,1,0.85))
	var hint := "WASD/Arrows move  ·  Space/RCtrl/ROpt up  ·  Shift// down  ·  LMB erase  ·  RMB place  ·  X/Y/Z slice  ·  1–9 palette  ·  Esc"
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 10.0),
		hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1,1,1,0.45))

func _draw_hotbar() -> void:
	var names := VoxelWorld.merged_semantic_names()
	if names.is_empty():
		return
	const SLOT := 44.0
	const GAP  := 4.0
	const BOTTOM_MARGIN := 28.0
	var total := names.size()
	var sel_idx := maxi(0, names.find(VoxelWorld.selected_semantic))
	var visible_count := mini(total, 9)
	var start_idx := 0
	if total > 9:
		start_idx = clampi(sel_idx - 4, 0, total - 9)
	var total_w := visible_count * SLOT + (visible_count - 1) * GAP
	var sx := (_overlay.size.x - total_w) * 0.5
	var sy := _overlay.size.y - BOTTOM_MARGIN - SLOT
	_overlay.draw_rect(Rect2(sx - 6, sy - 6, total_w + 12, SLOT + 12), Color(0,0,0,0.55))
	var font := ThemeDB.fallback_font
	for i in visible_count:
		var idx := start_idx + i
		var semantic := names[idx]
		var color := VoxelWorld.get_color_for_semantic(semantic)
		var rx := sx + i * (SLOT + GAP)
		var slot_rect := Rect2(rx, sy, SLOT, SLOT)
		var is_selected := semantic == VoxelWorld.selected_semantic
		_overlay.draw_rect(slot_rect, color.darkened(0.35))
		_overlay.draw_rect(slot_rect.grow(-4), color)
		_overlay.draw_rect(slot_rect, Color(1,1,1, 0.9 if is_selected else 0.25),
			false, 2.5 if is_selected else 1.0)
		if i < 9:
			_overlay.draw_string(font, Vector2(rx + 3.0, sy + 13.0), str(i + 1),
				HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1,1,1,0.7))
