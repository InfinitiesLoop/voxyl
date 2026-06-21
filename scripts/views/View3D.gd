class_name View3D
extends Control

# Emitted on a mouse press inside the viewport so the shell can focus this pane.
signal focus_requested

# ---------------------------------------------------------------------------
# Single unified camera — one position/orientation used in both modes.
# "Fly mode" only controls whether the cursor is captured.
# Clicking captures cursor; Esc releases it. Position never jumps.
# ---------------------------------------------------------------------------

# Camera dolly distance per scroll notch in orbit mode (lower = less sensitive).
# TODO: drive this from a user sensitivity setting.
const DOLLY_STEP := 1.25

# Keys the camera consumes while flying, so they don't also drive the UI
# (e.g. arrow keys switching tabs or moving focus).
const _MOVEMENT_KEYS := [
	KEY_W, KEY_A, KEY_S, KEY_D,
	KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT,
	KEY_SPACE, KEY_SHIFT, KEY_SLASH,
]

# Camera transform
var _camera_pos := Vector3(8, 12, 28)
var _yaw := 180.0    # horizontal look angle (degrees)
var _pitch := -20.0  # vertical look angle (degrees)

# Whether the cursor is captured (first-person controls active)
var _fly_mode := false

# Set by the shell: only the focused pane's current view processes global input.
# (View3D._input is a global handler, so multiple visible 3D views would
# otherwise all react to the same keys/mouse.)
var _active := true

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

# --- Slice-select mode ---
# A transient modal state for choosing a 2D slice. All of this is view-local:
# the chosen axis/center are handed to a fresh View2DGrid instance on confirm.
var _slice_active := false
var _slice_axis := 1
var _slice_center := Vector3i.ZERO
var _orbit_dist := 16.0       # camera distance to the pivot while orbiting
var _drag_moved := false      # distinguishes an orbit-drag from a confirm-click
var _cell_nodes := {}         # Vector3i -> MeshInstance3D (filled in _rebuild)
var _normal_mats := {}        # semantic -> StandardMaterial3D (base appearance)
var _faded_mats := {}         # semantic -> StandardMaterial3D (off-plane fade)
var _onplane_mats := {}       # semantic -> StandardMaterial3D (on-plane pop)
var _plane_sheet: MeshInstance3D
var _plane_sheet_mat: ShaderMaterial
var _slice_marker: MeshInstance3D
var _slice_marker_mat: StandardMaterial3D
var _slice_pulse := 0.0               # animates (breathes) the center marker
var _slice_bounds_lo := Vector3.ZERO  # cached plane extent — avoids a per-frame AABB scan
var _slice_bounds_hi := Vector3.ZERO

func _ready() -> void:
	_setup_viewport()
	_setup_overlay()
	VoxelWorld.project_opened.connect(_on_project_opened)
	VoxelWorld.block_changed.connect(func(_p, _s): _mark_dirty())
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.selection_changed.connect(func(_s): if _fly_mode: _overlay.queue_redraw())
	visibility_changed.connect(_on_visibility_changed)
	set_process(true)

func _on_visibility_changed() -> void:
	if visible:
		return
	if _fly_mode:
		_release_cursor()
	if _slice_active:
		_exit_slice_select()

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

	# Slice-select: translucent sheet (with a cell grid) cutting through the slice.
	_plane_sheet_mat = ShaderMaterial.new()
	_plane_sheet_mat.shader = _make_slice_plane_shader()
	_plane_sheet_mat.set_shader_parameter("fill_color", Color(0.12, 0.8, 1.0, 0.13))
	_plane_sheet_mat.set_shader_parameter("line_color", Color(0.45, 0.95, 1.0, 0.5))
	_plane_sheet = MeshInstance3D.new()
	_plane_sheet.mesh = ImmediateMesh.new()
	_plane_sheet.material_override = _plane_sheet_mat
	_plane_sheet.visible = false
	_viewport.add_child(_plane_sheet)

	# Slice-select: bright line work — plane border + center-cell wireframe.
	_slice_marker_mat = StandardMaterial3D.new()
	_slice_marker_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_slice_marker_mat.vertex_color_use_as_albedo = true
	_slice_marker = MeshInstance3D.new()
	_slice_marker.mesh = ImmediateMesh.new()
	_slice_marker.material_override = _slice_marker_mat
	_slice_marker.visible = false
	_viewport.add_child(_slice_marker)

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

# Translucent fill + cell grid for the slice-select plane sheet. The grid lives
# in world space and snaps to integer cell boundaries; `slice_axis` selects which
# two world axes lie in the plane.
func _make_slice_plane_shader() -> Shader:
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode unshaded, cull_disabled, blend_mix, depth_draw_never;

uniform int slice_axis;
uniform vec4 fill_color;
uniform vec4 line_color;

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 coord;
	if (slice_axis == 0) {
		coord = world_pos.zy;
	} else if (slice_axis == 2) {
		coord = world_pos.xy;
	} else {
		coord = world_pos.xz;
	}
	vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
	float line = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
	ALBEDO = mix(fill_color.rgb, line_color.rgb, line);
	ALPHA = mix(fill_color.a, line_color.a, line);
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
	if _slice_active:
		if is_visible_in_tree():
			_slice_pulse += delta
			_update_slice_marker()
		return
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
	if not _active or not is_visible_in_tree():
		return

	# Slice-select is modal — it consumes keyboard input until confirmed/cancelled.
	# (Mouse is handled in _on_svc_input so orbit/confirm work in the viewport.)
	if _slice_active:
		_handle_slice_key(event)
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
			if key.keycode == KEY_TAB:
				_enter_slice_select()
				get_viewport().set_input_as_handled()
				return
			if key.keycode == KEY_ESCAPE and _fly_mode:
				_release_cursor()
				get_viewport().set_input_as_handled()
				return
			if key.keycode == KEY_B:
				_cycle_sky()
			# 1–9 palette slots (captured mode only)
			if _fly_mode:
				var kc := key.keycode
				if kc >= KEY_1 and kc <= KEY_9:
					_select_palette_slot(kc - KEY_1)
					get_viewport().set_input_as_handled()
					return

		# Keep fly-mode movement keys (incl. arrows) from also reaching the UI.
		if _fly_mode and key.keycode in _MOVEMENT_KEYS:
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
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		focus_requested.emit()
	if _slice_active:
		_handle_slice_mouse(event)
		return
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
			_camera_pos += _get_look_dir() * DOLLY_STEP
			_update_camera()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_camera_pos -= _get_look_dir() * DOLLY_STEP
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
	if not _active:
		return
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

# Called by the shell when focus changes. Losing focus drops any captured
# cursor and exits slice-select so a background view can't keep grabbing input.
func set_active(active: bool) -> void:
	if _active == active:
		return
	_active = active
	if not _active:
		if _fly_mode:
			_release_cursor()
		if _slice_active:
			_exit_slice_select()

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
	_cell_nodes.clear()
	_normal_mats.clear()
	_faded_mats.clear()
	_onplane_mats.clear()
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	for pos: Vector3i in data.cells.keys():
		var semantic: String = data.cells[pos]
		if semantic.is_empty():
			continue
		if not _normal_mats.has(semantic):
			var mat := StandardMaterial3D.new()
			mat.albedo_color = VoxelWorld.get_color_for_semantic(semantic)
			_normal_mats[semantic] = mat
		var mi := MeshInstance3D.new()
		var mesh := BoxMesh.new()
		mesh.size = Vector3(0.94, 0.94, 0.94)
		mi.mesh = mesh
		mi.material_override = _normal_mats[semantic]
		mi.position = Vector3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
		mi.set_meta("semantic", semantic)
		_voxel_root.add_child(mi)
		_cell_nodes[pos] = mi
	# Re-apply emphasis if a rebuild happened while choosing a slice (e.g. an edit
	# in another view, or a palette change).
	if _slice_active:
		_update_slice_visuals()

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
# Slice-select mode
#
# Tab enters an interactive mode for choosing a 2D slice. The axis + center
# block are auto-derived from where the camera is looking, then nudged with the
# keyboard, before spawning a centered 2D view (Enter/LMB) or cancelling (Esc/RMB).
# ---------------------------------------------------------------------------

func _enter_slice_select() -> void:
	if not VoxelWorld.active_project:
		return
	var look := _get_look_dir()
	var result := _raycast_grid(_camera_pos, look, 20.0)
	if result.get("hit", false):
		# Looking at a block face → slice through that block, parallel to the face.
		_slice_center = result.pos
		var normal: Vector3i = (result.prev_pos as Vector3i) - (result.pos as Vector3i)
		_slice_axis = _dominant_axis(Vector3(normal))
	else:
		# Empty look → dominant camera axis; the ground plane when looking up/down.
		_slice_axis = _dominant_axis(look)
		if _slice_axis == 1:
			var fr := _raycast_floor_plane(_camera_pos, look)
			if fr.get("hit", false):
				_slice_center = fr.pos
			else:
				_slice_center = _floor_vec3i(_camera_pos + look * 8.0)
		else:
			_slice_center = _floor_vec3i(_camera_pos + look * 8.0)

	_orbit_dist = _camera_pos.distance_to(_slice_center_world())
	if _orbit_dist < 2.0:
		_orbit_dist = 16.0
	if _fly_mode:
		_release_cursor()  # visible cursor for orbit-drag + click-to-confirm
	_slice_active = true
	_slice_pulse = 0.0
	_highlight.visible = false
	_overlay.visible = true
	_plane_sheet.visible = true
	_slice_marker.visible = true
	_update_slice_visuals()

func _exit_slice_select() -> void:
	if not _slice_active:
		return
	_slice_active = false
	for pos: Vector3i in _cell_nodes:
		var mi: MeshInstance3D = _cell_nodes[pos]
		var semantic: String = mi.get_meta("semantic", "")
		if _normal_mats.has(semantic):
			mi.material_override = _normal_mats[semantic]
	_plane_sheet.visible = false
	_slice_marker.visible = false
	_overlay.visible = _fly_mode
	_overlay.queue_redraw()

func _confirm_slice() -> void:
	var axis := _slice_axis
	var center := _slice_center
	_exit_slice_select()
	VoxelWorld.request_slice_view(axis, center)

func _cycle_slice_axis() -> void:
	_slice_axis = (_slice_axis + 1) % 3
	_update_slice_visuals()

# Move the plane along its axis. key_sign = +1 forward (W/Up), -1 back (S/Down).
# "Forward" always pushes the plane away from the camera, deeper into the scene.
func _move_plane(key_sign: int) -> void:
	var dir := 1 if _get_look_dir()[_slice_axis] >= 0.0 else -1
	_slice_center = _add_axis(_slice_center, _slice_axis, dir * key_sign)
	_update_slice_visuals()

# Move the center cell within the plane. (dx, dy) is screen intent: +x right, +y up.
func _move_center(dx: int, dy: int) -> void:
	var fwd := _get_look_dir()
	var flat := Vector3(fwd.x, 0.0, fwd.z)
	if flat.length_squared() > 0.0:
		flat = flat.normalized()
	var right := flat.cross(Vector3.UP)
	var delta := Vector3i.ZERO
	if _slice_axis == 1:
		# Horizontal plane: forward picks an X/Z axis; right takes the other one
		# (forced perpendicular so no in-plane direction is ever unreachable).
		var f := _snap_horizontal(flat)
		delta += f * dy
		if f.x != 0:
			delta += Vector3i(0, 0, 1 if right.z >= 0.0 else -1) * dx
		else:
			delta += Vector3i(1 if right.x >= 0.0 else -1, 0, 0) * dx
	else:
		# Vertical plane: screen up → world Y; screen right → in-plane horizontal axis.
		delta += Vector3i(0, dy, 0)
		var horiz_axis := 2 if _slice_axis == 0 else 0
		var s := 1 if right[horiz_axis] >= 0.0 else -1
		delta += Vector3i(s * dx, 0, 0) if horiz_axis == 0 else Vector3i(0, 0, s * dx)
	_slice_center += delta
	_update_slice_visuals()

# --- Slice input ----------------------------------------------------------

func _handle_slice_key(event: InputEvent) -> void:
	if not (event is InputEventKey):
		return
	var key := event as InputEventKey
	if not key.pressed:
		return
	var shift := key.shift_pressed
	match key.keycode:
		KEY_TAB:
			_cycle_slice_axis()
		KEY_ESCAPE:
			_exit_slice_select()
		KEY_ENTER, KEY_KP_ENTER:
			_confirm_slice()
		KEY_W, KEY_UP:
			if shift: _move_center(0, 1)
			else: _move_plane(1)
		KEY_S, KEY_DOWN:
			if shift: _move_center(0, -1)
			else: _move_plane(-1)
		KEY_A, KEY_LEFT:
			if shift: _move_center(-1, 0)
		KEY_D, KEY_RIGHT:
			if shift: _move_center(1, 0)
	get_viewport().set_input_as_handled()

func _handle_slice_mouse(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_LEFT:
				if mb.pressed:
					_drag_looking = true
					_drag_last = mb.position
					_drag_moved = false
				else:
					if not _drag_moved:
						_confirm_slice()
					_drag_looking = false
			MOUSE_BUTTON_RIGHT:
				if mb.pressed:
					_exit_slice_select()
			MOUSE_BUTTON_WHEEL_UP:
				if mb.pressed: _move_plane(1)
			MOUSE_BUTTON_WHEEL_DOWN:
				if mb.pressed: _move_plane(-1)
	elif event is InputEventMouseMotion and _drag_looking:
		var motion := event as InputEventMouseMotion
		var d: Vector2 = motion.position - _drag_last
		_drag_last = motion.position
		if d.length() > 2.0:
			_drag_moved = true
		_yaw -= d.x * 0.4
		_pitch = clamp(_pitch - d.y * 0.4, -89.0, 89.0)
		_orbit_camera()

func _orbit_camera() -> void:
	_camera_pos = _slice_center_world() - _get_look_dir() * _orbit_dist
	_update_camera()

# --- Slice visuals --------------------------------------------------------

func _update_slice_visuals() -> void:
	var offset: int = _slice_center[_slice_axis]
	for pos: Vector3i in _cell_nodes:
		var mi: MeshInstance3D = _cell_nodes[pos]
		var semantic: String = mi.get_meta("semantic", "")
		if pos[_slice_axis] == offset:
			mi.material_override = _onplane_mat_for(semantic)
		else:
			mi.material_override = _faded_mat_for(semantic)
	var b := _slice_plane_bounds()
	_slice_bounds_lo = b[0]
	_slice_bounds_hi = b[1]
	_update_plane_sheet()
	_update_slice_marker()
	_overlay.queue_redraw()

# Off-plane appearance: dithered (order-independent) coverage + a brightness
# knockdown. An operation on the rendered block, not an assumption about its color.
func _faded_mat_for(semantic: String) -> StandardMaterial3D:
	if not _faded_mats.has(semantic):
		var base: Color = VoxelWorld.get_color_for_semantic(semantic)
		var m := StandardMaterial3D.new()
		m.albedo_color = Color(base.r * 0.7, base.g * 0.7, base.b * 0.7, 0.4)
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_HASH
		_faded_mats[semantic] = m
	return _faded_mats[semantic]

# On-plane appearance: full opacity + a gentle emissive lift so the working plane pops.
func _onplane_mat_for(semantic: String) -> StandardMaterial3D:
	if not _onplane_mats.has(semantic):
		var base: Color = VoxelWorld.get_color_for_semantic(semantic)
		var m := StandardMaterial3D.new()
		m.albedo_color = base
		m.emission_enabled = true
		m.emission = base
		m.emission_energy_multiplier = 0.35
		_onplane_mats[semantic] = m
	return _onplane_mats[semantic]

func _update_plane_sheet() -> void:
	_plane_sheet_mat.set_shader_parameter("slice_axis", _slice_axis)
	var off := float(_slice_center[_slice_axis]) + 0.5
	var c := _plane_corners(_slice_bounds_lo, _slice_bounds_hi, off)
	var im := _plane_sheet.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	im.surface_add_vertex(c[0]); im.surface_add_vertex(c[1]); im.surface_add_vertex(c[2])
	im.surface_add_vertex(c[0]); im.surface_add_vertex(c[2]); im.surface_add_vertex(c[3])
	im.surface_end()

func _update_slice_marker() -> void:
	var im := _slice_marker.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	var off := float(_slice_center[_slice_axis]) + 0.5
	var c := _plane_corners(_slice_bounds_lo, _slice_bounds_hi, off)
	var border := Color(0.25, 0.85, 1.0, 0.85)
	for i in 4:
		_marker_line(im, c[i], c[(i + 1) % 4], border)
	# Center cell: a distinct wireframe that breathes — chrome we own, not the
	# block's colour (which may not even be a flat colour).
	var t := 0.5 + 0.5 * sin(_slice_pulse * 4.5)
	_draw_cell_wire(im, _slice_center, Color(1.0, 0.95, 0.45) * (0.7 + 0.3 * t), 1.04 + 0.10 * t)
	im.surface_end()

func _marker_line(im: ImmediateMesh, a: Vector3, b: Vector3, col: Color) -> void:
	im.surface_set_color(col); im.surface_add_vertex(a)
	im.surface_set_color(col); im.surface_add_vertex(b)

func _draw_cell_wire(im: ImmediateMesh, cell: Vector3i, col: Color, s: float) -> void:
	var half := (s - 1.0) * 0.5
	var o := Vector3(cell) - Vector3(half, half, half)
	var p := [
		o + Vector3(0, 0, 0), o + Vector3(s, 0, 0), o + Vector3(s, 0, s), o + Vector3(0, 0, s),
		o + Vector3(0, s, 0), o + Vector3(s, s, 0), o + Vector3(s, s, s), o + Vector3(0, s, s),
	]
	var edges := [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
	for e in edges:
		_marker_line(im, p[e[0]], p[e[1]], col)

func _draw_slice_hud() -> void:
	var font := ThemeDB.fallback_font
	var axis_label: String = (["X", "Y", "Z"] as Array)[_slice_axis]
	var title := "Slice  %s = %d    center (%d, %d, %d)" % [
		axis_label, _slice_center[_slice_axis], _slice_center.x, _slice_center.y, _slice_center.z]
	_overlay.draw_string(font, Vector2(14.0, 30.0), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.85, 0.95, 1.0, 0.95))
	var hint := "W/S move plane  ·  Shift+WASD move center  ·  Tab cycle axis  ·  Wheel scrub  ·  Drag orbit  ·  Enter/LMB open  ·  Esc/RMB cancel"
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 10.0), hint,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.6))

# --- Slice math helpers ---------------------------------------------------

func _dominant_axis(v: Vector3) -> int:
	var ax := absf(v.x); var ay := absf(v.y); var az := absf(v.z)
	if ax >= ay and ax >= az:
		return 0
	return 1 if ay >= az else 2

func _add_axis(v: Vector3i, axis: int, d: int) -> Vector3i:
	match axis:
		0: return v + Vector3i(d, 0, 0)
		1: return v + Vector3i(0, d, 0)
		_: return v + Vector3i(0, 0, d)

func _snap_horizontal(v: Vector3) -> Vector3i:
	if absf(v.x) >= absf(v.z):
		return Vector3i(1 if v.x >= 0.0 else -1, 0, 0)
	return Vector3i(0, 0, 1 if v.z >= 0.0 else -1)

func _floor_vec3i(v: Vector3) -> Vector3i:
	return Vector3i(floori(v.x), floori(v.y), floori(v.z))

func _slice_center_world() -> Vector3:
	return Vector3(_slice_center) + Vector3(0.5, 0.5, 0.5)

# World-space (min, max) corners covering the build ∪ center, with a small margin.
func _slice_plane_bounds() -> Array:
	var lo := _slice_center
	var hi := _slice_center
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if not aabb.is_empty():
		lo = _vec_min(lo, aabb[0])
		hi = _vec_max(hi, aabb[1])
	lo -= Vector3i(2, 2, 2)
	hi += Vector3i(2, 2, 2)
	return [Vector3(lo), Vector3(hi) + Vector3.ONE]

func _plane_corners(mn: Vector3, mx: Vector3, off: float) -> Array:
	match _slice_axis:
		0: return [Vector3(off, mn.y, mn.z), Vector3(off, mx.y, mn.z), Vector3(off, mx.y, mx.z), Vector3(off, mn.y, mx.z)]
		2: return [Vector3(mn.x, mn.y, off), Vector3(mx.x, mn.y, off), Vector3(mx.x, mx.y, off), Vector3(mn.x, mx.y, off)]
		_: return [Vector3(mn.x, off, mn.z), Vector3(mx.x, off, mn.z), Vector3(mx.x, off, mx.z), Vector3(mn.x, off, mx.z)]

func _vec_min(a: Vector3i, b: Vector3i) -> Vector3i:
	return Vector3i(mini(a.x, b.x), mini(a.y, b.y), mini(a.z, b.z))

func _vec_max(a: Vector3i, b: Vector3i) -> Vector3i:
	return Vector3i(maxi(a.x, b.x), maxi(a.y, b.y), maxi(a.z, b.z))

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
	if _slice_active:
		_draw_slice_hud()
		return
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
	var hint := "WASD/Arrows move  ·  Space/RCtrl/ROpt up  ·  Shift// down  ·  LMB erase  ·  RMB place  ·  Tab slice  ·  1–9 palette  ·  Esc"
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
