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

# Uniform scale applied to every voxel mesh. This is a view rendering style, not
# model geometry: BlockModel elements are authored at true size (a full block fills
# [0,1]). At 1.0 a full block occupies its whole cell, so adjacent full blocks meet
# flush with no air gap; partial models (slabs, fences) keep their authored size.
const VOXEL_SCALE := 1.0

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

# Set true while a modal overlay (the inventory screen) is up: input is ignored
# and any captured cursor is released, but the prior fly state is remembered so
# editing resumes exactly where it left off when the overlay closes.
var _suspended := false
var _fly_before_suspend := false

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
# A single block_changed edit no longer forces a full-scene rebuild (that was O(total
# blocks in the project) per edit — fine at a few hundred blocks, ruinous at tens of
# thousands). Instead we track exactly which cells need their render node touched;
# _flush_dirty rebuilds only those nodes. Structural/appearance-wide changes (palette
# edits, block-type edits, opening a project) still go through the full _rebuild path
# via _full_rebuild_pending, since those can affect every cell's look.
var _dirty := false                # true once a flush (incremental or full) is scheduled
var _dirty_positions := {}         # Vector3i -> true; cells needing a node rebuild
var _full_rebuild_pending := false

# --- Placement animation (bulk builds) -------------------------------------
# A bulk tool writes its blocks to the data immediately, then asks for a quick reveal:
# a blue placeholder box is spawned over each new cell and cleared on a short per-step
# stagger, so the real blocks pop in a slice at a time toward the camera. Pure view
# chrome — see _animate_placement. Tunable/disable-able here; swapping in a different
# effect (e.g. scale-popping the real block) is localized to _spawn_placeholder.
const PLACEMENT_FX_ENABLED := true
const PLACEMENT_FX_HOLD := 0.075   # seconds a placeholder is held before it may clear
const PLACEMENT_FX_STEP := 0.0375  # added delay per step deeper into the column
const WAND_LIMIT := 32   # wand flood reaches at most this many cells each way from the click
var _fx_root: Node3D
var _fx_material: StandardMaterial3D
var _placeholder_mesh: BoxMesh
var _placement_fx: Array = []     # [{ node: MeshInstance3D, reveal_at: float }]

# --- Ghost preview overlay -------------------------------------------------
# Reusable translucent preview of the cells an action WOULD affect, drawn without ever
# touching block data (drives build-to-me / wand — single block at a time). A single
# MultiMeshInstance3D whose mesh IS the selected block at _GHOST_ALPHA, so it looks like a
# see-through copy of what you'd place and stays one draw call at any cell count. Paste has
# its own, separate opaque+tinted ghost recipe below (_paste_ghost_mms /
# _build_paste_ghost_mesh) since a whole pasted region of these gets illegible fast.
const _GHOST_ALPHA := 0.75
var _ghost_mm: MultiMeshInstance3D
var _ghost_last: Array = []        # last cell set shown, to skip redundant rebuilds
var _ghost_mesh_key := ""          # selected-block signature the ghost mesh was built for

# True only while apply_view_state is restoring a saved camera, so _update_camera
# doesn't mistake the restore for a user move and reschedule an autosave.
var _applying_state := false

# --- Slice-select mode ---
# A transient modal state for choosing a 2D slice. All of this is view-local:
# the chosen axis/center are handed to a fresh View2DGrid instance on confirm.
var _slice_active := false
var _slice_axis := 1
var _slice_center := Vector3i.ZERO
var _orbit_dist := 16.0       # camera distance to the pivot while orbiting
var _drag_moved := false      # distinguishes an orbit-drag from a confirm-click
var _cell_nodes := {}         # Vector3i -> MeshInstance3D, or Node3D container of parts (multipart)
var _model_meshes := {}       # model id (String) -> Mesh (built lazily, shared)
var _normal_mats := {}        # semantic -> StandardMaterial3D (base appearance)
var _faded_mats := {}         # semantic -> StandardMaterial3D (off-plane fade)
var _onplane_mats := {}       # semantic -> StandardMaterial3D (on-plane pop)

# --- Textured render path (additive — the color path above is untouched) ------
# Models that bind textures get per-face geometry with explicit UVs and one surface
# per distinct texture (BoxMesh's atlas UVs can't show a per-face image); the
# material is bound per surface so a model never owns texture state — it's resolved
# from the workspace library on each rebuild. Models with no textures stay on the
# color path, so the default build (no textures) renders exactly as before.
var _textured_model_meshes := {}  # model id -> { "mesh": ArrayMesh, "keys": Array[String] }
var _texture_cache := {}          # image_path -> ImageTexture (heavy; kept across rebuilds)
var _model_tex_cache := {}        # model id -> { texture_key -> { "tex":, "image": } }
var _surface_mats := {}           # "<model id>|<texture_key>" -> Material
var _anim_shaders := {}           # TextureAsset.Transparency -> Shader (one per variant)

# Box-face outward normals live in BlockMesher.DIR_NORMALS (shared geometry); the
# connection-flag scan below reads them from there.
var _plane_sheet: MeshInstance3D
var _plane_sheet_mat: ShaderMaterial
var _slice_marker: MeshInstance3D
var _slice_marker_mat: StandardMaterial3D
var _slice_pulse := 0.0               # animates (breathes) the center marker
var _slice_bounds_lo := Vector3.ZERO  # cached plane extent — avoids a per-frame AABB scan
var _slice_bounds_hi := Vector3.ZERO

# Guide plane: another view's active 2D slice, projected here as a reference.
var _guide_plane: MeshInstance3D
var _guide_plane_mat: ShaderMaterial
var _guide: Dictionary = {}

# Selection box: the Select tool's cuboid, outlined so it reads through blocks (see
# _setup_viewport for the two-pass show-through material and _update_selection_box).
var _sel_box: MeshInstance3D
var _sel_box_mat: StandardMaterial3D

# --- Paste mode -------------------------------------------------------------
# Interactive drop of the clipboard (Ctrl+V): a live ghost preview follows the crosshair
# (like build-to-me/wand) plus a manual offset/rotation the player can dial in. It's a
# view-local modal layered on top of fly mode rather than a VoxelWorld tool — entering it
# doesn't touch active_tool, so whatever tool was selected is exactly as it was on exit.
var _paste_active := false
var _paste_offset := Vector3i.ZERO
var _paste_rotation := 0   # quarter-turns (0-3) applied around Y, see Orientation.rotate_*_cw
# LMB toggles this: false = the anchor follows the crosshair every frame (the default,
# "aim and place" feel); true = it's pinned to wherever it was at the moment of toggling, so
# the player can look around freely without the paste drifting off the spot they lined up.
var _paste_locked := false
var _paste_locked_base := Vector3i.ZERO
# One MultiMeshInstance3D per distinct semantic in the clipboard — unlike the single-semantic
# _ghost_mm above (build-to-me/wand only ever preview ONE block type), a pasted region can mix
# many, so each gets its own draw call.
var _paste_ghost_mms: Dictionary = {}       # semantic -> MultiMeshInstance3D
var _paste_ghost_mesh_keys: Dictionary = {} # semantic -> mesh signature, for rebuild-on-change
var _paste_popup: PanelContainer            # offset/rotate/place/cancel controls (MMB to show)
var _paste_offset_labels: Dictionary = {}   # "x"/"y"/"z" -> Label
# Wireframe outline around the pasted region's full bounds (see _setup_viewport for the
# show-through material and _update_paste_box) — the ghost blocks themselves are opaque now
# (see _GHOST_ALPHA/_build_paste_ghost_mesh below), so the box is what still reads through walls.
var _paste_box: MeshInstance3D
var _paste_box_mat: StandardMaterial3D

func _ready() -> void:
	_setup_viewport()
	_setup_overlay()
	_build_paste_popup()
	VoxelWorld.project_opened.connect(_on_project_opened)
	VoxelWorld.about_to_save.connect(_on_about_to_save)
	VoxelWorld.block_changed.connect(func(p, _s): _mark_cell_dirty(p))
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.block_type_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.selection_changed.connect(func(_s): if _fly_mode: _overlay.queue_redraw())
	# Keep the build-to-me ghost in sync with anything that changes what it would build.
	VoxelWorld.tool_changed.connect(func(_t): _refresh_ghost_preview())
	VoxelWorld.brush_size_changed.connect(func(_s): _refresh_ghost_preview())
	VoxelWorld.selection_changed.connect(func(_s): _refresh_ghost_preview())
	VoxelWorld.workspace_changed.connect(_on_workspace_changed)
	# The region selection is shared across views; repaint the box whenever it changes.
	VoxelWorld.region_selection_changed.connect(_update_selection_box)
	visibility_changed.connect(_on_visibility_changed)
	set_process(true)
	# A view created while a project is already open (e.g. spawned during a layout
	# restore, after project_opened has already fired) must render the current build
	# itself — otherwise it stays blank until the next block_changed signal.
	if VoxelWorld.active_project:
		_mark_dirty()
	_update_selection_box()

func _on_visibility_changed() -> void:
	if visible:
		return
	if _paste_active:
		_cancel_paste()
	if _fly_mode:
		_release_cursor()
	if _slice_active:
		_exit_slice_select()

# Bake a preview thumbnail from the live 3D viewport just before the project is saved, so
# the home-screen card shows the build from the perspective the camera was last in — with
# no render cost at listing time. Only the active project is saved, so only its thumbnail
# refreshes. get_texture().get_image() returns the last drawn frame (current while this
# view is rendering); ProjectStore.save_thumbnail skips empty images so a blank capture
# never clobbers a good preview.
const THUMB_MAX_SIDE := 320

func _on_about_to_save(project: VoxelProject) -> void:
	if project == null or _viewport == null:
		return
	var img := _viewport.get_texture().get_image()
	if img == null or img.is_empty():
		return
	var longest := maxi(img.get_width(), img.get_height())
	if longest > THUMB_MAX_SIDE:
		var factor := float(THUMB_MAX_SIDE) / float(longest)
		img.resize(int(img.get_width() * factor), int(img.get_height() * factor), Image.INTERPOLATE_BILINEAR)
	ProjectStore.save_thumbnail(project.name, img)

func _on_project_opened(_p: VoxelProject) -> void:
	_clear_placement_fx()  # drop any in-flight reveal from the previous build
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
	sun.light_energy = 1.0
	_viewport.add_child(sun)

	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(40, -135, 0)
	fill.light_color = Color(1.0, 1.0, 1.0)
	fill.light_energy = 0.35
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

	# Placement-FX layer: transient blue placeholders live here, above the voxel meshes
	# and untouched by _rebuild (which only clears _voxel_root).
	_fx_root = Node3D.new()
	_viewport.add_child(_fx_root)
	_fx_material = StandardMaterial3D.new()
	_fx_material.albedo_color = Color(0.16, 0.52, 1.0, 1.0)
	_fx_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	# Ghost preview overlay: one MultiMesh whose mesh + per-surface translucent materials
	# are the selected block itself (built lazily in _ensure_ghost_mesh), so the preview
	# reads as a 50%-opacity copy of what you'd place. One draw call regardless of count.
	var ghost_multimesh := MultiMesh.new()
	ghost_multimesh.transform_format = MultiMesh.TRANSFORM_3D
	ghost_multimesh.instance_count = 0
	_ghost_mm = MultiMeshInstance3D.new()
	_ghost_mm.multimesh = ghost_multimesh
	_ghost_mm.visible = false
	_viewport.add_child(_ghost_mm)

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

	# Guide plane: the active 2D slice from another view, projected here (amber).
	_guide_plane_mat = ShaderMaterial.new()
	_guide_plane_mat.shader = _make_slice_plane_shader()
	_guide_plane_mat.set_shader_parameter("fill_color", Color(1.0, 0.6, 0.2, 0.09))
	_guide_plane_mat.set_shader_parameter("line_color", Color(1.0, 0.65, 0.25, 0.38))
	_guide_plane = MeshInstance3D.new()
	_guide_plane.mesh = ImmediateMesh.new()
	_guide_plane.material_override = _guide_plane_mat
	_guide_plane.visible = false
	_viewport.add_child(_guide_plane)

	# Slice-select: bright line work — plane border + center-cell wireframe.
	_slice_marker_mat = StandardMaterial3D.new()
	_slice_marker_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_slice_marker_mat.vertex_color_use_as_albedo = true
	_slice_marker = MeshInstance3D.new()
	_slice_marker.mesh = ImmediateMesh.new()
	_slice_marker.material_override = _slice_marker_mat
	_slice_marker.visible = false
	_viewport.add_child(_slice_marker)

	# Selection box: a wireframe cuboid for the Select tool that stays visible through
	# blocks. A two-pass material fakes "outline behind geometry, dimmed": the base pass
	# ignores depth (no_depth_test) so the whole box always draws, but dim; its next_pass
	# depth-tests normally, redrawing only the currently-visible edges bright on top. So an
	# edge in front of a block is bright, an edge behind one stays dim — never fully hidden,
	# but obviously occluded. Neither pass writes depth, so it never disturbs the scene.
	_sel_box_mat = StandardMaterial3D.new()
	_sel_box_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_sel_box_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_sel_box_mat.no_depth_test = true
	_sel_box_mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	_sel_box_mat.albedo_color = Color(0.28, 0.62, 1.0, 0.28)  # dim: where behind blocks
	var sel_front := StandardMaterial3D.new()
	sel_front.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	sel_front.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	sel_front.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	sel_front.albedo_color = Color(0.4, 0.8, 1.0, 1.0)  # bright: where visible
	_sel_box_mat.next_pass = sel_front
	_sel_box = MeshInstance3D.new()
	_sel_box.mesh = ImmediateMesh.new()
	_sel_box.material_override = _sel_box_mat
	_sel_box.visible = false
	_viewport.add_child(_sel_box)

	# Paste box: same show-through recipe as the selection box above, marking the pasted
	# region's full bounds so it reads clearly even where the (now fully opaque) ghost
	# blocks themselves are occluded or off past the edge of what's on screen.
	_paste_box_mat = StandardMaterial3D.new()
	_paste_box_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_paste_box_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_paste_box_mat.no_depth_test = true
	_paste_box_mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	_paste_box_mat.albedo_color = Color(0.3, 0.55, 1.0, 0.30)  # dim: where behind blocks
	var paste_front := StandardMaterial3D.new()
	paste_front.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	paste_front.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	paste_front.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	paste_front.albedo_color = Color(0.5, 0.75, 1.0, 1.0)  # bright: where visible
	_paste_box_mat.next_pass = paste_front
	_paste_box = MeshInstance3D.new()
	_paste_box.mesh = ImmediateMesh.new()
	_paste_box.material_override = _paste_box_mat
	_paste_box.visible = false
	_viewport.add_child(_paste_box)

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
	env.ambient_light_energy = 0.6

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
	_tick_placement_fx()
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
	if not _active or _suspended or not is_visible_in_tree():
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
			if key.keycode == KEY_TAB or key.keycode == KEY_ENTER or key.keycode == KEY_KP_ENTER:
				_enter_slice_select()
				get_viewport().set_input_as_handled()
				return
			# Ctrl/Cmd+V: drop into paste mode. Ungated by _fly_mode (like Tab above) — it
			# captures the cursor itself if not already flying, so it works from a cold view.
			if key.keycode == KEY_V and (key.ctrl_pressed or key.meta_pressed) and not key.echo:
				_enter_paste_mode()
				get_viewport().set_input_as_handled()
				return
			if key.keycode == KEY_ESCAPE:
				if _paste_active:
					# Esc is always a hard cancel for paste, flying or not — MMB is the way
					# to reach the offset popup (see the mouse-button handling below), so Esc
					# doesn't need double duty here.
					_cancel_paste()
					get_viewport().set_input_as_handled()
					return
				if _fly_mode:
					_release_cursor()
					get_viewport().set_input_as_handled()
					return
			if key.keycode == KEY_B:
				_cycle_sky()
			# 1–9 palette slots + R rotate (captured mode only)
			if _fly_mode:
				var kc := key.keycode
				if _paste_active and kc == KEY_R:
					_paste_rotation = (_paste_rotation + 1) % 4
					_refresh_ghost_preview()
					get_viewport().set_input_as_handled()
					return
				if kc >= KEY_1 and kc <= KEY_9:
					_select_palette_slot(kc - KEY_1)
					get_viewport().set_input_as_handled()
					return
				if kc == KEY_0:
					_select_palette_slot(9)  # the tenth slot
					get_viewport().set_input_as_handled()
					return
				if kc == KEY_R:
					_rotate_targeted_block(key.shift_pressed)
					get_viewport().set_input_as_handled()
					return

		# Keep fly-mode movement keys (incl. arrows) from also reaching the UI.
		if _fly_mode and key.keycode in _MOVEMENT_KEYS:
			get_viewport().set_input_as_handled()
			return

	if not _fly_mode:
		return

	# --- Captured mouse: look + edit ---
	# While flying we own all mouse input — consume it so an unconsumed click
	# can't fall through to GUI hit-testing (at the captured/centre position) and
	# steal focus into another pane.
	if event is InputEventMouseMotion:
		var motion := event as InputEventMouseMotion
		_yaw -= motion.relative.x * 0.18
		_pitch = clamp(_pitch - motion.relative.y * 0.18, -89.0, 89.0)
		_update_camera()
		_update_crosshair_target()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		var mb := event as InputEventMouseButton
		if _paste_active:
			# Paste mode repurposes the primary buttons: RMB confirms, LMB toggles anchor
			# lock, MMB opens the offset popup — no erase/pick/palette-cycle while pending.
			match mb.button_index:
				MOUSE_BUTTON_RIGHT:  _commit_paste()
				MOUSE_BUTTON_LEFT:   _toggle_paste_lock()
				MOUSE_BUTTON_MIDDLE: _release_cursor()  # opens the popup, same as Esc used to
		else:
			match mb.button_index:
				MOUSE_BUTTON_LEFT:        _erase_targeted_block()
				MOUSE_BUTTON_RIGHT:       _use_primary_tool()
				MOUSE_BUTTON_MIDDLE:      _pick_targeted_block()
				MOUSE_BUTTON_WHEEL_UP:    _cycle_palette(-1)
				MOUSE_BUTTON_WHEEL_DOWN:  _cycle_palette(1)
		get_viewport().set_input_as_handled()

# Non-captured mouse: drag-to-look + scroll-to-dolly
func _on_svc_input(event: InputEvent) -> void:
	if _suspended:
		return
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed and not _active:
		focus_requested.emit()
		get_viewport().set_input_as_handled()
		return
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
		elif mb.button_index == MOUSE_BUTTON_MIDDLE and mb.pressed and _paste_active:
			_capture_cursor()  # closes the popup and resumes flying, mirroring MMB in _input
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
	_update_paste_popup_visibility()
	_update_crosshair_target()
	_overlay.queue_redraw()

func _release_cursor() -> void:
	_fly_mode = false
	_drag_looking = false
	_rctrl_held = false
	_ralt_held = false
	_rshift_held = false
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	_highlight.visible = false
	if _paste_active:
		# Mid-paste: MMB (see _input) called this to step out of fly mode and reveal the
		# offset popup — the paste itself (ghost, aim, offset, lock) stays live, frozen at
		# the last aimed cell.
		_update_paste_popup_visibility()
		_overlay.queue_redraw()
		return
	_overlay.visible = false
	_target_hit = false
	_floor_hit = false
	_clear_ghost()

# Called by the shell when focus changes. Losing focus drops any captured
# cursor and exits slice-select so a background view can't keep grabbing input.
# ---------------------------------------------------------------------------
# Persisted view state (the shell reads/writes this to save layout with a project)
# ---------------------------------------------------------------------------

func view_kind() -> String:
	return "3d"

# Snapshot the camera (position + look angles) and current skybox, so a reopened
# project restores the exact viewpoint. Fly/drag/slice-select are transient and not
# saved.
func get_view_state() -> Dictionary:
	return {
		"camera_pos": _camera_pos,
		"yaw": _yaw,
		"pitch": _pitch,
		"sky": _current_sky,
	}

func apply_view_state(state: Dictionary) -> void:
	_camera_pos = state.get("camera_pos", _camera_pos)
	_yaw = state.get("yaw", _yaw)
	_pitch = state.get("pitch", _pitch)
	_current_sky = int(state.get("sky", _current_sky))
	_applying_state = true
	if _world_env != null:
		_apply_sky()
	if _camera != null:
		_update_camera()
	_applying_state = false

func set_active(active: bool) -> void:
	if _active == active:
		return
	_active = active
	if not _active:
		if _paste_active:
			_cancel_paste()  # a backgrounded pane can't be left mid-paste with a live popup
		if _fly_mode:
			_release_cursor()
		if _slice_active:
			_exit_slice_select()

# Suspend/resume for a modal overlay (the inventory screen). Suspending releases a
# captured cursor but remembers that we were flying; resuming re-captures it so the
# user drops straight back into edit mode where they left off. View-agnostic chrome
# drives this through the shell — the view never knows what overlay is up.
func set_input_suspended(s: bool) -> void:
	if _suspended == s:
		return
	_suspended = s
	if s:
		_fly_before_suspend = _fly_mode
		if _fly_mode:
			_release_cursor()
	elif _fly_before_suspend and _active and is_visible_in_tree():
		_capture_cursor()

# Show another view's active 2D slice as a translucent reference plane (or hide
# it when there's no guide / this view is the active one).
func set_guide(desc: Dictionary) -> void:
	_guide = desc
	_refresh_guide()

func _refresh_guide() -> void:
	if not _guide_plane:
		return
	if _guide.is_empty() or not VoxelWorld.active_project:
		_guide_plane.visible = false
		return
	var axis: int = _guide["axis"]
	var offset: int = _guide["offset"]
	_guide_plane_mat.set_shader_parameter("slice_axis", axis)
	var b := _guide_bounds()
	var c := _plane_corners(axis, b[0], b[1], float(offset) + 0.5)
	var im := _guide_plane.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	im.surface_add_vertex(c[0]); im.surface_add_vertex(c[1]); im.surface_add_vertex(c[2])
	im.surface_add_vertex(c[0]); im.surface_add_vertex(c[2]); im.surface_add_vertex(c[3])
	im.surface_end()
	_guide_plane.visible = true

func _guide_bounds() -> Array:
	var lo := Vector3i(-8, -8, -8)
	var hi := Vector3i(8, 8, 8)
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if not aabb.is_empty():
		lo = aabb[0]
		hi = aabb[1]
	lo -= Vector3i(2, 2, 2)
	hi += Vector3i(2, 2, 2)
	return [Vector3(lo), Vector3(hi) + Vector3.ONE]

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
	# Camera moved → the project's saved viewpoint is stale. Cheap debounce restart;
	# skipped while we're applying a loaded state (that's not a user change).
	if not _applying_state:
		VoxelWorld.mark_dirty()

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
	_full_rebuild_pending = true
	_schedule_flush()

# A single cell changed (block_changed). Its own render node needs rebuilding, and so
# do its 6 neighbors: connecting/multipart blocks derive their connection flags from
# neighbor occupancy at render time (see _cell_connections), so a neighbor's node can
# be stale even though its own data didn't change. Bounded to 7 nodes per edit regardless
# of how many blocks the project holds — this is the fix for per-edit cost scaling with
# total project size instead of with edit size.
func _mark_cell_dirty(pos: Vector3i) -> void:
	_dirty_positions[pos] = true
	for dir in BlockMesher.DIR_NORMALS:
		_dirty_positions[pos + Vector3i(BlockMesher.DIR_NORMALS[dir])] = true
	_schedule_flush()

func _schedule_flush() -> void:
	if not _dirty:
		_dirty = true
		call_deferred("_flush_dirty")

# Coalesces however many _mark_dirty/_mark_cell_dirty calls happened this frame (e.g. a
# bulk tool or a multi-block undo/redo step, each emitting block_changed per cell) into
# one deferred flush. A pending full rebuild wins outright since it already covers every
# dirty position.
func _flush_dirty() -> void:
	_dirty = false
	if _full_rebuild_pending:
		_full_rebuild_pending = false
		_dirty_positions.clear()
		_rebuild()
		return
	if _dirty_positions.is_empty():
		return
	var positions := _dirty_positions.keys()
	_dirty_positions.clear()
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	for pos: Vector3i in positions:
		_update_cell_node(pos, data)
	# Re-apply emphasis/guide the same way a full rebuild would (both are cheap: emphasis
	# only touches the nodes that exist, guide only resizes a 4-vertex plane).
	if _slice_active:
		_update_slice_visuals()
	_refresh_guide()

# Rebuild exactly one cell's render node in place — the incremental counterpart to the
# per-cell body of _rebuild()'s loop below (kept in sync via _build_cell_node).
func _update_cell_node(pos: Vector3i, data: VoxelData) -> void:
	var old_node = _cell_nodes.get(pos)
	if old_node != null:
		_voxel_root.remove_child(old_node)
		old_node.free()
		_cell_nodes.erase(pos)
	var cell: BlockCell = data.get_cell(pos)
	if cell == null or cell.type_id.is_empty():
		return
	var node := _build_cell_node(pos, cell, cell.type_id)
	_voxel_root.add_child(node)
	_cell_nodes[pos] = node

# _model_meshes/_textured_model_meshes are now keyed by each model's revision (_model_key),
# so a changed model can never be served a stale entry — correctness doesn't depend on
# this handler firing at all. What it's for is memory: without it, every distinct edit to
# the same model id (undo/redo, iterating on a reimport, …) would pile up its own orphaned
# entry for the rest of the session. workspace_changed is the signal every structural edit
# already fires, so it's a convenient point to trim back to just what's current.
func _on_workspace_changed() -> void:
	_model_meshes.clear()
	_textured_model_meshes.clear()
	_mark_dirty()

func _rebuild() -> void:
	_dirty = false
	_ghost_mesh_key = ""  # block appearance may have changed; rebuild the ghost mesh lazily
	for child in _voxel_root.get_children():
		_voxel_root.remove_child(child)
		child.free()
	_cell_nodes.clear()
	_normal_mats.clear()
	_faded_mats.clear()
	_onplane_mats.clear()
	# Per-rebuild material caches (pick up palette / block-type edits); the heavy
	# ImageTexture cache and shared geometry/shaders persist across rebuilds.
	_model_tex_cache.clear()
	_surface_mats.clear()
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	for pos: Vector3i in data.cells.keys():
		var cell: BlockCell = data.cells[pos]
		var semantic: String = cell.type_id
		if semantic.is_empty():
			continue
		var node := _build_cell_node(pos, cell, semantic)
		_voxel_root.add_child(node)
		_cell_nodes[pos] = node
	# Re-apply emphasis if a rebuild happened while choosing a slice (e.g. an edit
	# in another view, or a palette change).
	if _slice_active:
		_update_slice_visuals()
	_refresh_guide()  # the guide plane spans the build, so resize it on rebuild

# A cell resolves to one or more render parts (geometry + a model rotation). A plain
# block is a single part; a connecting/multipart block is its post plus a side part per
# connected neighbor. The uniform VOXEL_SCALE leaves full blocks filling their whole cell
# (no air gap); a plain cube at the default orientation reduces to identity·scale — a
# flush full-block render. Shared by the full rebuild loop above and _update_cell_node's
# single-cell incremental path, so both build identical nodes.
func _build_cell_node(pos: Vector3i, cell: BlockCell, semantic: String) -> Node3D:
	var parts := _resolve_cell_parts(pos, cell, semantic)
	var center := Vector3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
	var node: Node3D
	if parts.size() == 1:
		# Common case (every default-build cell): a single MeshInstance3D, placed
		# directly so the node structure — and thus the render — is unchanged.
		var mi := MeshInstance3D.new()
		_apply_cell_appearance(mi, semantic, parts[0]["model"])
		mi.transform = Transform3D((parts[0]["basis"] as Basis).scaled(Vector3.ONE * VOXEL_SCALE), center)
		node = mi
	else:
		# Multipart: a container at the cell center holding one child per part,
		# each with its own model + rotation. The cached per-model meshes and
		# per-surface materials are reused across parts and cells.
		var container := Node3D.new()
		container.position = center
		for part in parts:
			var mi := MeshInstance3D.new()
			_apply_cell_appearance(mi, semantic, part["model"])
			mi.transform = Transform3D((part["basis"] as Basis).scaled(Vector3.ONE * VOXEL_SCALE), Vector3.ZERO)
			container.add_child(mi)
		node = container
	return node

# ---------------------------------------------------------------------------
# Render-time part resolver
#
# Turns a cell into the list of {model, basis} parts to draw. This is the single
# integration point for a block type's state_map: plain blocks, orientation
# variants, and connecting/multipart blocks all funnel through here so the rebuild
# loop never special-cases them. Connection flags are DERIVED from neighbors at
# render time and never stored on the cell (data stores intent only).
# ---------------------------------------------------------------------------

func _resolve_cell_parts(pos: Vector3i, cell: BlockCell, semantic: String) -> Array:
	var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
	var sm: BlockStateMap = bt.state_map if bt else null
	# Connecting block: its post + a side part for each occupied neighbor.
	if sm != null and sm.is_multipart():
		var conns := _cell_connections(pos)
		var out: Array = []
		for part in sm.resolve_parts(conns):
			var m := VoxelWorld.workspace.get_block_model(str(part.get("model_id", "")))
			if m != null:
				out.append({"model": m, "basis": BlockMesher.rotation_basis(int(part.get("x_rot", 0)), int(part.get("y_rot", 0)))})
		if not out.is_empty():
			return out
	# Orientation variant: pick this facing's model + its baked rotation. We apply
	# the variant's x/y here INSTEAD of Orientation.basis_of, so the rotation MC
	# already encoded isn't applied twice (the Phase 2 → 3 guardrail).
	elif sm != null and not sm.is_empty():
		var entry := sm.resolve(cell.orientation)
		if not entry.is_empty():
			var m := VoxelWorld.workspace.get_block_model(str(entry.get("model_id", "")))
			if m != null:
				return [{"model": m, "basis": BlockMesher.rotation_basis(int(entry.get("x_rot", 0)), int(entry.get("y_rot", 0)))}]
	# Plain block (and the safety net if a state_map's model went missing): the
	# resolved model rotated by the cell's own orientation.
	return [{"model": VoxelWorld.get_model_for_semantic(semantic), "basis": Orientation.basis_of(cell.orientation)}]

# Connection state per direction for a cell: "none" when the neighbor cell is empty,
# else the neighbor's connect-height classification ("low"/"tall", derived from its
# resolved model's geometry via VoxelWorld.get_connect_height_for_semantic). Keyed by
# BlockModel.Dir (0..5), matching the dirs the importer wrote into a part's `when`
# clauses. Computed fresh every rebuild from neighbor occupancy + shape — nothing
# about connections is ever stored on the cell (data stores intent only).
func _cell_connections(pos: Vector3i) -> Dictionary:
	var data := VoxelWorld.active_project.data
	var conns := {}
	for dir in BlockMesher.DIR_NORMALS:
		var npos := pos + Vector3i(BlockMesher.DIR_NORMALS[dir])
		var neighbor_semantic := data.get_block(npos)
		conns[dir] = "none" if neighbor_semantic.is_empty() \
			else VoxelWorld.get_connect_height_for_semantic(neighbor_semantic)
	return conns

# Per-model-id cache around BlockMesher.color_mesh (the shared geometry builder).
# Orientation.basis_of() rotates the centered box about the cell center and
# VOXEL_SCALE shrinks it; the cache keeps the rebuild cheap across cells/rebuilds.
func _mesh_for_model(model: BlockModel) -> Mesh:
	var key := _model_key(model)
	if not _model_meshes.has(key):
		_model_meshes[key] = BlockMesher.color_mesh(model)
	return _model_meshes[key]

# A model's cache key folds in its revision counter (bumped by BlockModel itself whenever
# elements/textures/ambient_occlusion change — see BlockModel.gd) rather than just its id,
# so every per-model-id cache below (mesh, resolved textures, surface materials) self-
# invalidates: a changed model gets a different key, and the old entry is simply never
# looked up again. A plain int read + string concat, not a hash — cheap enough to call on
# every cell in a rebuild, unlike re-hashing elements/textures per lookup.
func _model_key(model: BlockModel) -> String:
	var base := model.id if not model.id.is_empty() else str(model.get_instance_id())
	return "%s#%d" % [base, model.revision]

# ---------------------------------------------------------------------------
# Cell appearance: textured path (new) layered over the color path (Phase 0)
# ---------------------------------------------------------------------------

# Pick geometry + materials for one cell. The textured path runs when the resolved
# model binds loadable textures; otherwise the original color path renders (so the
# default build, which has none, is byte-for-byte unchanged). The "textured" meta
# tells slice-mode how to restore the base look afterward.
func _apply_cell_appearance(mi: MeshInstance3D, semantic: String, model: BlockModel) -> void:
	mi.set_meta("semantic", semantic)
	var resolved := _resolve_model_textures(model)
	if resolved.is_empty():
		mi.mesh = _mesh_for_model(model)
		mi.material_override = _color_material(semantic)
		mi.set_meta("textured", false)
		return
	var entry := _textured_mesh_for_model(model)
	mi.mesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	# The biome tint is per block type (semantic); WHITE leaves the surface as-is, so
	# the default/untinted build renders byte-for-byte as before.
	var tint: Color = VoxelWorld.get_tint_for_semantic(semantic)
	for i in keys.size():
		mi.set_surface_override_material(i,
			_surface_material(semantic, model, keys[i], resolved, bool(tinted[i]), tint))
	mi.set_meta("textured", true)

# Base color material for a semantic (the planning/"undecided" path). Cached in
# _normal_mats, which slice-mode also restores from.
func _color_material(semantic: String) -> StandardMaterial3D:
	if not _normal_mats.has(semantic):
		var mat := StandardMaterial3D.new()
		mat.albedo_color = VoxelWorld.get_color_for_semantic(semantic)
		_normal_mats[semantic] = mat
	return _normal_mats[semantic]

# Resolve a model's texture-key bindings to loadable textures through the workspace
# library (model.textures holds TextureAsset *ids*). Keys whose asset is missing or
# whose pixels won't load are dropped; an empty result sends the cell to the color
# path. Cached per model id for the rebuild.
func _resolve_model_textures(model: BlockModel) -> Dictionary:
	if not model.has_textures():
		return {}
	var mid := _model_key(model)
	if _model_tex_cache.has(mid):
		return _model_tex_cache[mid]
	var out := {}
	for key in model.textures:
		var asset := VoxelWorld.workspace.get_texture_asset(model.textures[key])
		if asset == null or asset.image_path.is_empty():
			continue
		var image := _cached_texture(asset.image_path)
		if image == null:
			continue
		out[key] = {"tex": asset, "image": image}
	_model_tex_cache[mid] = out
	return out

func _cached_texture(image_path: String) -> ImageTexture:
	if not _texture_cache.has(image_path):
		_texture_cache[image_path] = AssetLibrary.load_texture(image_path)
	return _texture_cache[image_path]

# Per-model-id cache around BlockMesher.textured_mesh (shared geometry). The result
# is { mesh, keys, tinted }: "keys" (parallel to surface index) lets the caller bind
# a material per surface, and "tinted" flags surfaces whose faces carry a tint_index
# so the caller multiplies in the block's biome tint (Phase 4). Geometry only is
# cached; materials are resolved per rebuild from the workspace library.
func _textured_mesh_for_model(model: BlockModel) -> Dictionary:
	var mid := _model_key(model)
	if not _textured_model_meshes.has(mid):
		_textured_model_meshes[mid] = BlockMesher.textured_mesh(model)
	return _textured_model_meshes[mid]

# Material for one textured surface: the bound texture's static or animated
# material, cached by semantic+model+key; a face bound to a key the model never
# supplied falls back to the semantic's color. `is_tinted` faces multiply `tint`
# (the block's biome color) into the texture — WHITE is the identity, so untinted
# surfaces are unchanged. The cache key carries the semantic because the same model
# can render under two block types with different tints.
func _surface_material(semantic: String, model: BlockModel, key: String,
		resolved: Dictionary, is_tinted: bool, tint: Color) -> Material:
	if not resolved.has(key):
		return _color_material(semantic)
	var cache_key := semantic + "|" + _model_key(model) + "|" + key
	if not _surface_mats.has(cache_key):
		var info: Dictionary = resolved[key]
		var asset: TextureAsset = info["tex"]
		var image: ImageTexture = info["image"]
		var effective_tint := tint if is_tinted else Color.WHITE
		var mat: Material
		if asset.is_animated():
			mat = _animated_material(asset, image, effective_tint)
		else:
			mat = _static_texture_material(asset, image, effective_tint)
		_surface_mats[cache_key] = mat
	return _surface_mats[cache_key]

# `tint` modulates the texture (StandardMaterial3D multiplies albedo_texture by
# albedo_color); WHITE leaves it untouched, so the default path is unchanged.
func _static_texture_material(asset: TextureAsset, image: ImageTexture, tint: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_texture = image
	m.albedo_color = tint
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST  # MC art is pixel-exact
	match asset.transparency:
		TextureAsset.Transparency.CUTOUT:
			m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
		TextureAsset.Transparency.TRANSLUCENT:
			m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m

# Animated textures are an MC-style vertical frame strip. One ShaderMaterial walks
# the V-offset down the strip from TIME — no per-frame mesh/material churn, and all
# instances sharing the material animate in lockstep. frame_time is seconds/frame
# (the importer converts MC's ticks); 0 → effectively static. `tint` multiplies the
# sampled color (WHITE = identity), matching the static path.
func _animated_material(asset: TextureAsset, image: ImageTexture, tint: Color) -> ShaderMaterial:
	var sm := ShaderMaterial.new()
	sm.shader = _anim_shader_for(asset.transparency)
	sm.set_shader_parameter("tex", image)
	sm.set_shader_parameter("frame_count", asset.frame_count)
	sm.set_shader_parameter("frame_time", asset.frame_time)
	sm.set_shader_parameter("interp", asset.interpolate)
	sm.set_shader_parameter("tint", tint)
	return sm

# One shader per transparency variant (render_mode is fixed at compile time), built
# lazily and cached. The frame walk is identical across variants.
func _anim_shader_for(transparency: TextureAsset.Transparency) -> Shader:
	if _anim_shaders.has(transparency):
		return _anim_shaders[transparency]
	var render_mode := "cull_back"
	var alpha_body := ""
	match transparency:
		TextureAsset.Transparency.CUTOUT:
			alpha_body = "\tif (c.a < 0.5) { discard; }\n"
		TextureAsset.Transparency.TRANSLUCENT:
			render_mode = "cull_back, blend_mix"
			alpha_body = "\tALPHA = c.a;\n"
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode %s;

uniform sampler2D tex : source_color, filter_nearest;
uniform int frame_count = 1;
uniform float frame_time = 0.0;
uniform bool interp = false;
uniform vec4 tint : source_color = vec4(1.0);

void fragment() {
	float fc = max(float(frame_count), 1.0);
	float t = frame_time > 0.0 ? TIME / frame_time : 0.0;
	float f = floor(mod(t, fc));
	// Frames stack vertically (MC layout); advance V one frame-height per step.
	vec4 c = texture(tex, vec2(UV.x, (UV.y + f) / fc));
	if (interp) {
		float nf = mod(f + 1.0, fc);
		vec4 c2 = texture(tex, vec2(UV.x, (UV.y + nf) / fc));
		c = mix(c, c2, fract(t));
	}
%s	ALBEDO = c.rgb * tint.rgb;
}
""" % [render_mode, alpha_body]
	_anim_shaders[transparency] = shader
	return shader

# ---------------------------------------------------------------------------
# Raycast
# ---------------------------------------------------------------------------

func _update_crosshair_target() -> void:
	_target_hit = false
	_floor_hit = false
	if not VoxelWorld.active_project:
		_clear_ghost()
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
	_refresh_ghost_preview()

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

# The face rectangle is sized to the block's ACTUAL rendered bounds (see _cell_world_aabb),
# not a fixed unit cube: a block whose model doesn't fill the whole cell (a chest template,
# a slab, …) would otherwise show its highlight floating above/outside the real geometry —
# a bright gap that reads as a hole cut into the block (the reported "cutout on the chest
# top", which turned out to be this highlight box, not the mesh itself).
func _draw_face_highlight(block: Vector3i, normal: Vector3i) -> void:
	var n := Vector3(normal)
	var bbox := _cell_world_aabb(block)
	if bbox.size == Vector3.ZERO:
		bbox = AABB(Vector3(block), Vector3.ONE)   # no rendered geometry found: fall back
	var lo := bbox.position
	var hi := bbox.position + bbox.size
	var mid := (lo + hi) * 0.5
	const MARGIN := 0.002   # nudge off the surface so it doesn't z-fight with it
	var center := Vector3(
		(hi.x if n.x > 0.0 else lo.x) if absf(n.x) > 0.5 else mid.x,
		(hi.y if n.y > 0.0 else lo.y) if absf(n.y) > 0.5 else mid.y,
		(hi.z if n.z > 0.0 else lo.z) if absf(n.z) > 0.5 else mid.z,
	) + n * MARGIN
	var t1: Vector3
	var t2: Vector3
	if absf(n.y) > 0.5:
		t1 = Vector3((hi.x - lo.x) * 0.5, 0.0, 0.0)
		t2 = Vector3(0.0, 0.0, (hi.z - lo.z) * 0.5)
	elif absf(n.x) > 0.5:
		t1 = Vector3(0.0, (hi.y - lo.y) * 0.5, 0.0)
		t2 = Vector3(0.0, 0.0, (hi.z - lo.z) * 0.5)
	else:
		t1 = Vector3((hi.x - lo.x) * 0.5, 0.0, 0.0)
		t2 = Vector3(0.0, (hi.y - lo.y) * 0.5, 0.0)
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

# The union of a cell's actual rendered mesh bounds, in world space — a plain block is one
# MeshInstance3D, a multipart/connecting block several (see _cell_mesh_instances); either
# way this is the real visible footprint, which can be smaller than (or offset within) the
# full unit cell. Empty (zero size) when the cell has no node or no mesh yet.
func _cell_world_aabb(pos: Vector3i) -> AABB:
	var node = _cell_nodes.get(pos)
	if node == null:
		return AABB()
	var result := AABB()
	var first := true
	for mi in _cell_mesh_instances(node):
		if mi.mesh == null:
			continue
		var world_box: AABB = mi.global_transform * mi.mesh.get_aabb()
		result = world_box if first else result.merge(world_box)
		first = false
	return result

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

# Right-click action in fly mode, dispatched by the active tool. The pencil — and any
# tool without 3D-specific behavior — places a single block; build-to-me extrudes a
# column toward the camera. (Left-click stays a single erase for every tool.)
func _use_primary_tool() -> void:
	match VoxelWorld.active_tool:
		VoxelWorld.Tool.BUILD_TO_ME:
			_build_to_me()
		VoxelWorld.Tool.WAND:
			_wand()
		VoxelWorld.Tool.SELECT:
			_select_region_click()
		_:
			_place_targeted_block()

# "Build to me": extrude a column from the crosshair'd face straight along that face's
# normal toward the camera, stopping just short of the cell the camera occupies. The
# column follows the single axis of the face normal — any horizontal offset from the
# camera is ignored — so aiming at a top face 10 cells below the camera lays 9 blocks
# up. brush_size widens it to an N×N cross-section. The whole extrude is one undo step;
# the new blocks are revealed with a quick placement animation.
func _build_to_me() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		return
	var anchor := _build_to_me_anchor()
	if anchor.is_empty():
		return
	var place: Vector3i = anchor["place"]
	var normal: Vector3i = anchor["normal"]
	var groups := _build_to_me_cells(place, normal)
	if groups.is_empty():
		return
	var orient := _derive_place_orientation(place, normal)
	VoxelWorld.begin_operation("Build to me")
	for group in groups:
		for cell: Vector3i in group:
			VoxelWorld.set_block(cell, VoxelWorld.selected_semantic, orient)
	VoxelWorld.end_operation()
	_animate_placement(groups)
	_update_crosshair_target()  # re-aims, refreshing the ghost onto the next column

# The build-to-me anchor from the current crosshair target: the first cell to fill and
# the face normal to extrude along, or {} if nothing is targeted. Shared by the commit
# and the live ghost preview so they can never disagree about what will be built.
func _build_to_me_anchor() -> Dictionary:
	if _target_hit:
		return {"place": _target_place, "normal": _target_place - _target_block}
	elif _floor_hit:
		return {"place": _floor_place, "normal": Vector3i(0, 1, 0)}
	return {}

# The cells a build-to-me from (place, normal) would fill, grouped by column step (each
# group is one N×N slice, ordered face → camera). Occupied cells are skipped. Pure
# computation — no data writes — so both the commit and the preview call it.
func _build_to_me_cells(place: Vector3i, normal: Vector3i) -> Array:
	var axis := _dominant_axis(Vector3(normal))
	if normal[axis] == 0:
		return []
	var step := 1 if normal[axis] > 0 else -1
	# Cells from the placement cell up to (excluding) the camera's cell along this axis.
	var count := (floori(_camera_pos[axis]) - place[axis]) * step
	if count <= 0:
		return []
	var data := VoxelWorld.active_project.data
	# Brush footprint: an N×N square in the plane perpendicular to the build axis,
	# centered on the column. `perp` is the two axes that aren't the build axis.
	var brush := maxi(VoxelWorld.brush_size, 1)
	@warning_ignore("integer_division")
	var lo := -((brush - 1) / 2)  # left/top offset to center the N×N footprint
	var perp := [0, 1, 2]
	perp.erase(axis)
	var groups: Array = []
	for i in count:
		var base := _add_axis(place, axis, step * i)
		var this_step: Array = []
		for du in brush:
			for dv in brush:
				var cell := base
				cell[perp[0]] += lo + du
				cell[perp[1]] += lo + dv
				if data.get_block(cell).is_empty():   # never clobber an existing block
					this_step.append(cell)
		if not this_step.is_empty():
			groups.append(this_step)
	return groups

# ---------------------------------------------------------------------------
# Wand (flood-extend a face)
# ---------------------------------------------------------------------------

# "Wand": right-click a face to grow the connected run of same-type blocks on that face
# outward by one, using the SELECTED block. Flood-fills across the face plane from the
# clicked block, following only cells of the block you clicked (so a stone-brick wall with
# wood ends grows only the stone bricks), bounded to ±WAND_LIMIT each way, placing a block
# in the face-normal direction over every exposed cell it reaches. One undo step.
func _wand() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		return
	var anchor := _wand_anchor()
	if anchor.is_empty():
		return
	var block: Vector3i = anchor["block"]
	var normal: Vector3i = anchor["normal"]
	var groups := _wand_cells(block, normal)
	if groups.is_empty():
		return
	var orient := _derive_place_orientation(block + normal, normal)
	VoxelWorld.begin_operation("Wand")
	for group in groups:
		for cell: Vector3i in group:
			VoxelWorld.set_block(cell, VoxelWorld.selected_semantic, orient)
	VoxelWorld.end_operation()
	_animate_placement(groups)
	_update_crosshair_target()

# The wand needs a real block face: the clicked block and the face normal, or {} if the
# crosshair isn't on a block (the virtual floor has nothing to extend).
func _wand_anchor() -> Dictionary:
	if _target_hit:
		return {"block": _target_block, "normal": _target_place - _target_block}
	return {}

# The cells a wand from (block, normal) would fill, grouped by square-ring distance from
# the clicked block (so the reveal ripples outward). Flood-fills same-type cells coplanar
# with the click, 4-connected in the face plane, bounded ±WAND_LIMIT per axis; a cell
# contributes a target when the cell in the normal direction is empty. Pure computation —
# shared by the commit and the ghost preview so they can't disagree.
func _wand_cells(block: Vector3i, normal: Vector3i) -> Array:
	var data := VoxelWorld.active_project.data
	var semantic := data.get_block(block)
	if semantic.is_empty():
		return []
	var axis := _dominant_axis(Vector3(normal))
	var perp := [0, 1, 2]
	perp.erase(axis)
	var u: int = perp[0]
	var v: int = perp[1]
	var du := _add_axis(Vector3i.ZERO, u, 1)
	var dv := _add_axis(Vector3i.ZERO, v, 1)
	var neighbors := [du, -du, dv, -dv]
	var visited := {block: true}
	var queue: Array = [block]
	var head := 0
	var by_ring := {}   # square-ring distance -> Array[Vector3i] of target cells
	while head < queue.size():
		var c: Vector3i = queue[head]
		head += 1
		var t := c + normal
		if data.get_block(t).is_empty():
			var ring := maxi(absi(c[u] - block[u]), absi(c[v] - block[v]))
			if not by_ring.has(ring):
				by_ring[ring] = []
			by_ring[ring].append(t)
		for nd in neighbors:
			var nc: Vector3i = c + nd
			if visited.has(nc):
				continue
			if absi(nc[u] - block[u]) > WAND_LIMIT or absi(nc[v] - block[v]) > WAND_LIMIT:
				continue
			if data.get_block(nc) != semantic:
				continue
			visited[nc] = true
			queue.append(nc)
	var rings := by_ring.keys()
	rings.sort()
	var groups: Array = []
	for ring in rings:
		groups.append(by_ring[ring])
	return groups

# ---------------------------------------------------------------------------
# Ghost preview overlay (reusable)
# ---------------------------------------------------------------------------

# Show translucent ghosts for what the active tool WOULD build at the crosshair, without
# touching block data. Called whenever the aim, tool, brush, or selection changes.
# Currently drives the build-to-me column; the same _set_ghost_cells overlay is meant to
# back copy/paste preview too.
func _refresh_ghost_preview() -> void:
	if _paste_active:
		# Unlike the tool ghosts below, paste stays live while the cursor is released (the
		# offset popup is up) — it must not be gated on _fly_mode.
		_refresh_paste_ghost()
		return
	if not _fly_mode or not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		_clear_ghost()
		return
	var groups: Array = []
	var a: Dictionary = {}
	match VoxelWorld.active_tool:
		VoxelWorld.Tool.BUILD_TO_ME:
			a = _build_to_me_anchor()
			if not a.is_empty():
				groups = _build_to_me_cells(a["place"], a["normal"])
		VoxelWorld.Tool.WAND:
			a = _wand_anchor()
			if not a.is_empty():
				groups = _wand_cells(a["block"], a["normal"])
		_:
			_clear_ghost()
			return
	if groups.is_empty():
		_clear_ghost()
		return
	var cells: Array = []
	for group in groups:
		cells.append_array(group)
	_ensure_ghost_mesh(VoxelWorld.selected_semantic)
	_set_ghost_cells(cells)

# Point the ghost overlay at an explicit set of cells (empty hides it). Skips the
# MultiMesh rebuild when the set is unchanged, so holding aim on one face is free.
func _set_ghost_cells(cells: Array) -> void:
	if _ghost_mm == null or cells == _ghost_last:
		return
	_ghost_last = cells.duplicate()
	var mm := _ghost_mm.multimesh
	mm.instance_count = cells.size()
	for i in cells.size():
		var c: Vector3i = cells[i]
		mm.set_instance_transform(i, Transform3D(
			Basis().scaled(Vector3.ONE * VOXEL_SCALE),
			Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5)))
	_ghost_mm.visible = not cells.is_empty()

func _clear_ghost() -> void:
	if _ghost_mm == null or _ghost_last.is_empty():
		return
	_ghost_last = []
	_ghost_mm.multimesh.instance_count = 0
	_ghost_mm.visible = false

# Ensure the ghost MultiMesh is showing the currently selected block. Its mesh + per-
# surface translucent materials are the real block geometry/textures at 50% alpha, so the
# preview looks like a see-through copy of what you'd place. Rebuilt only when the
# selected block (or its appearance, via _rebuild resetting the key) changes.
func _ensure_ghost_mesh(semantic: String) -> void:
	if _ghost_mm == null:
		return
	var model := VoxelWorld.get_model_for_semantic(semantic)
	var key := semantic + "|" + (_model_key(model) if model else "none")
	if key == _ghost_mesh_key and _ghost_mm.multimesh.mesh != null:
		return
	_ghost_mesh_key = key
	_ghost_mm.multimesh.mesh = _build_ghost_mesh(semantic, model)

func _build_ghost_mesh(semantic: String, model: BlockModel) -> Mesh:
	if model == null:
		var box := BoxMesh.new()
		box.material = _ghost_color_material(VoxelWorld.get_color_for_semantic(semantic))
		return box
	var resolved := _resolve_model_textures(model)
	if resolved.is_empty():
		var mesh := BlockMesher.color_mesh(model) as ArrayMesh
		mesh.surface_set_material(0, _ghost_color_material(VoxelWorld.get_color_for_semantic(semantic)))
		return mesh
	var entry := BlockMesher.textured_mesh(model)
	var tmesh: ArrayMesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	var tint: Color = VoxelWorld.get_tint_for_semantic(semantic)
	for i in keys.size():
		tmesh.surface_set_material(i,
			_ghost_texture_material(str(keys[i]), resolved, bool(tinted[i]), tint, semantic))
	return tmesh

# Translucent material for a color/undecided block ghost, at _GHOST_ALPHA. Depth write is
# off so stacked ghosts blend without per-instance sorting; the opaque scene still occludes
# them. Build-to-me/wand only ever preview one block at a time, so a soft see-through works;
# paste (below) uses a different, fully-opaque recipe since a whole pasted region of these
# gets illegible fast.
func _ghost_color_material(col: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(col.r, col.g, col.b, _GHOST_ALPHA)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	return m

# Translucent textured material for one ghost surface — the block's own texture at
# _GHOST_ALPHA (animated strips render static, fine for a preview). A face with no bound
# texture falls back to the block's ghost color.
func _ghost_texture_material(key: String, resolved: Dictionary, is_tinted: bool,
		tint: Color, semantic: String) -> Material:
	if not resolved.has(key):
		return _ghost_color_material(VoxelWorld.get_color_for_semantic(semantic))
	var info: Dictionary = resolved[key]
	var image: ImageTexture = info["image"]
	var t := tint if is_tinted else Color.WHITE
	var m := StandardMaterial3D.new()
	m.albedo_texture = image
	m.albedo_color = Color(t.r, t.g, t.b, _GHOST_ALPHA)
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	return m

# ---------------------------------------------------------------------------
# Paste ghost mesh — fully opaque, tinted (not translucent)
#
# A pasted region can be dozens of blocks at once; at that count the translucent x-ray look
# above stops being readable as "the actual blocks" and just reads as noise. Instead these are
# rendered fully solid — same real geometry/texture as the block would be for real — with its
# color washed toward a cool blue so it still reads as a preview at a glance (an obvious "not
# real yet" signal that doesn't rely on legibility-costing transparency), same idea as
# WorldEdit-style clipboard-paste previews in other voxel tools: solid blocks + a colored
# bounding outline (_paste_box above) rather than x-ray ghosting. Normal depth draw (unlike
# the translucent ghosts) since there's no blending to protect and it should occlude/be
# occluded like real geometry.
# ---------------------------------------------------------------------------

const _PASTE_TINT := Color(0.35, 0.55, 1.0)
const _PASTE_TINT_STRENGTH := 0.4

func _build_paste_ghost_mesh(semantic: String, model: BlockModel) -> Mesh:
	if model == null:
		var box := BoxMesh.new()
		box.material = _paste_solid_color_material(VoxelWorld.get_color_for_semantic(semantic))
		return box
	var resolved := _resolve_model_textures(model)
	if resolved.is_empty():
		var mesh := BlockMesher.color_mesh(model) as ArrayMesh
		mesh.surface_set_material(0, _paste_solid_color_material(VoxelWorld.get_color_for_semantic(semantic)))
		return mesh
	var entry := BlockMesher.textured_mesh(model)
	var tmesh: ArrayMesh = entry["mesh"]
	var keys: Array = entry["keys"]
	var tinted: Array = entry["tinted"]
	var tint: Color = VoxelWorld.get_tint_for_semantic(semantic)
	for i in keys.size():
		tmesh.surface_set_material(i,
			_paste_solid_texture_material(str(keys[i]), resolved, bool(tinted[i]), tint, semantic))
	return tmesh

func _paste_solid_color_material(col: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = col.lerp(_PASTE_TINT, _PASTE_TINT_STRENGTH)
	return m

func _paste_solid_texture_material(key: String, resolved: Dictionary, is_tinted: bool,
		tint: Color, semantic: String) -> Material:
	if not resolved.has(key):
		return _paste_solid_color_material(VoxelWorld.get_color_for_semantic(semantic))
	var info: Dictionary = resolved[key]
	var image: ImageTexture = info["image"]
	var t := tint if is_tinted else Color.WHITE
	var m := StandardMaterial3D.new()
	m.albedo_texture = image
	m.albedo_color = t.lerp(_PASTE_TINT, _PASTE_TINT_STRENGTH)
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	return m

# ---------------------------------------------------------------------------
# Placement animation (bulk builds)
# ---------------------------------------------------------------------------

# Reveal freshly placed blocks with a quick per-step pop: an opaque blue placeholder is
# dropped over each new cell (hiding the real block already sitting beneath it), then
# cleared on a stagger that marches deeper into the build — so it reads as the blocks
# building toward you. Data is untouched by any of this (Principle 2); tune or disable
# via the PLACEMENT_FX_* constants.
func _animate_placement(placed_by_step: Array) -> void:
	if not PLACEMENT_FX_ENABLED or placed_by_step.is_empty():
		return
	var now := Time.get_ticks_msec() / 1000.0
	for step_index in placed_by_step.size():
		var reveal_at := now + PLACEMENT_FX_HOLD + step_index * PLACEMENT_FX_STEP
		for cell: Vector3i in placed_by_step[step_index]:
			_placement_fx.append({"node": _spawn_placeholder(cell), "reveal_at": reveal_at})

func _spawn_placeholder(cell: Vector3i) -> MeshInstance3D:
	if _placeholder_mesh == null:
		_placeholder_mesh = BoxMesh.new()
		_placeholder_mesh.size = Vector3.ONE
	var mi := MeshInstance3D.new()
	mi.mesh = _placeholder_mesh
	mi.material_override = _fx_material
	# Slightly oversized so it fully occludes the real (possibly smaller) block beneath.
	mi.transform = Transform3D(Basis().scaled(Vector3.ONE * VOXEL_SCALE * 1.03),
		Vector3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5))
	_fx_root.add_child(mi)
	return mi

# Free each placeholder once its reveal time passes, letting the real block show. Runs
# every frame from _process (ahead of the fly/slice early-outs) so an in-flight reveal
# completes even after you drop out of fly mode.
func _tick_placement_fx() -> void:
	if _placement_fx.is_empty():
		return
	var now := Time.get_ticks_msec() / 1000.0
	var still: Array = []
	for fx in _placement_fx:
		if now >= fx["reveal_at"]:
			(fx["node"] as Node).queue_free()
		else:
			still.append(fx)
	_placement_fx = still

func _clear_placement_fx() -> void:
	for fx in _placement_fx:
		(fx["node"] as Node).queue_free()
	_placement_fx.clear()

func _place_targeted_block() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		return
	var place_pos: Vector3i
	var face_normal: Vector3i
	if _target_hit:
		place_pos = _target_place
		face_normal = _target_place - _target_block  # points out of the placed-against face
	elif _floor_hit:
		place_pos = _floor_place
		face_normal = Vector3i(0, 1, 0)  # standing on the ground plane
	else:
		return
	# Orient like Minecraft: a 6-way block (barrel, dispenser, a plain undecided/FULL
	# cube, …) faces the way you placed it — the direction pointing out of the surface
	# you clicked. A block constrained to horizontal + a half (stairs, slabs) instead
	# faces the player and lands top-half when placed against a ceiling or while
	# looking up at a side face. Tweak afterwards with R (rotate about the face you're
	# looking at).
	var o := _derive_place_orientation(place_pos, face_normal)
	VoxelWorld.begin_operation("Place")
	VoxelWorld.set_block(place_pos, VoxelWorld.selected_semantic, o)
	VoxelWorld.end_operation()
	_update_crosshair_target()

func _derive_place_orientation(place_pos: Vector3i, face_normal: Vector3i) -> int:
	if VoxelWorld.has_full_facing_for_semantic(VoxelWorld.selected_semantic):
		return Orientation.make(Orientation.from_normal(face_normal))
	var to_cam := _camera_pos - (Vector3(place_pos) + Vector3(0.5, 0.5, 0.5))
	var horiz := Vector3(to_cam.x, 0.0, to_cam.z)
	if horiz.length_squared() < 0.0001:
		# Camera has (almost) no horizontal offset from the cell — e.g. standing right
		# under a ceiling block and looking straight up. from_dir() on a near-zero
		# vector ties toward UP/DOWN, which breaks the top/bottom-half flip below (it
		# only works around a horizontal facing axis). Fall back to camera yaw, which
		# stays well-defined at any pitch (clamped short of straight up/down).
		var look := _get_look_dir()
		horiz = Vector3(-look.x, 0.0, -look.z)
	var facing := Orientation.from_dir(horiz)
	var top := false
	if face_normal.y < 0:
		top = true       # placed under a block
	elif face_normal.y > 0:
		top = false      # placed on top of one (or the floor)
	else:
		top = _get_look_dir().y > 0.2  # side face, looking up → upper half
	return Orientation.make(facing, top)

func _erase_targeted_block() -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	VoxelWorld.begin_operation("Erase")
	VoxelWorld.clear_block(_target_block)
	VoxelWorld.end_operation()
	_update_crosshair_target()

# MC creative "pick block": copy the targeted cell's semantic + orientation into
# the hand (active hotbar slot, or jump to an existing slot holding it).
func _pick_targeted_block() -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	var cell := VoxelWorld.active_project.data.get_cell(_target_block)
	if cell:
		VoxelWorld.pick_block(cell.type_id)

# Rotate the crosshair-targeted block about the axis of the face you're looking at.
# A 6-way block (barrel, dispenser, a plain undecided/FULL cube, …) cycles its facing
# around that axis — looking at the top/bottom cycles the 4 horizontal facings (like
# rotate_cw), looking at a side reaches UP/DOWN — so every direction is reachable from
# any view. A block constrained to horizontal + a half (stairs, slabs) keeps the old
# split: top/bottom turns the block, a side flips it upside-down. Shift reverses the
# turn. This is how you re-orient in 3D — there is no global orientation mode.
func _rotate_targeted_block(reverse: bool) -> void:
	if not _target_hit or not VoxelWorld.active_project:
		return
	var cell := VoxelWorld.active_project.data.get_cell(_target_block)
	if cell == null:
		return
	var normal := _target_place - _target_block  # face pointing toward the camera
	var steps := -1 if reverse else 1
	var o := cell.orientation
	if VoxelWorld.has_full_facing_for_semantic(cell.type_id):
		o = Orientation.rotate_around_axis(o, Orientation.dominant_axis(normal), steps)
	elif absi(normal.y) >= absi(normal.x) and absi(normal.y) >= absi(normal.z):
		o = Orientation.rotate_cw(o, steps)
	else:
		o = Orientation.toggle_top(o)
	VoxelWorld.begin_operation("Rotate")
	VoxelWorld.reorient_block(_target_block, o)
	VoxelWorld.end_operation()
	_update_crosshair_target()

# ---------------------------------------------------------------------------
# Region selection (the Select tool)
# ---------------------------------------------------------------------------

# Right-click with the Select tool: feed the crosshair'd cell to the shared state machine
# (a hit block's own cell, else the ground cell, else null — which still lets the click
# clear an existing selection). Both corners of the cuboid are picked this way; the box
# and its state live on VoxelWorld so every view stays in sync.
func _select_region_click() -> void:
	if not VoxelWorld.active_project:
		return
	var cell: Variant = null
	if _target_hit:
		cell = _target_block
	elif _floor_hit:
		cell = _floor_place
	VoxelWorld.select_region_click(cell)

# Rebuild the wireframe box around the current selection (or the pending first corner),
# hiding it when there's none. The box is world-space and independent of blocks, so it
# never needs a data rebuild — only this cheap line refresh when the selection changes.
func _update_selection_box() -> void:
	if _sel_box == null:
		return
	var box := VoxelWorld.selection_box()
	if box.is_empty():
		_sel_box.visible = false
		return
	var lo := Vector3(box[0] as Vector3i)
	var hi := Vector3(box[1] as Vector3i) + Vector3.ONE
	var p := [
		Vector3(lo.x, lo.y, lo.z), Vector3(hi.x, lo.y, lo.z), Vector3(hi.x, lo.y, hi.z), Vector3(lo.x, lo.y, hi.z),
		Vector3(lo.x, hi.y, lo.z), Vector3(hi.x, hi.y, lo.z), Vector3(hi.x, hi.y, hi.z), Vector3(lo.x, hi.y, hi.z),
	]
	var edges := [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
	var im := _sel_box.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for e in edges:
		im.surface_add_vertex(p[e[0]])
		im.surface_add_vertex(p[e[1]])
	im.surface_end()
	_sel_box.visible = true

# ---------------------------------------------------------------------------
# Paste mode (Ctrl+V) — drop the clipboard via the ghost-preview overlay
#
# A live preview follows the crosshair like build-to-me/wand, plus a manual offset/rotation
# that persists for the rest of the paste (never reset except on a fresh Ctrl+V):
#   RMB   — commit the paste
#   LMB   — toggle the anchor between "follows the crosshair" (default) and "locked" at its
#           current position, so the player can look elsewhere without the paste drifting
#   MMB   — open/close the offset popup (releases/re-captures the cursor to do it — see
#           _release_cursor/_capture_cursor; also reachable by clicking the bare viewport)
#   R     — rotate 90°
#   Esc   — cancel outright, flying or not; never a "back out one level" step, so it can't be
#           pressed by reflex while reaching for the popup and lose the whole paste
# Entering/exiting never touches VoxelWorld.active_tool — this is purely a View3D-local modal
# layered over whatever tool/fly state was already active.
# ---------------------------------------------------------------------------

func _enter_paste_mode() -> void:
	if not VoxelWorld.active_project or not VoxelWorld.has_clipboard():
		return
	_paste_active = true
	_paste_offset = Vector3i.ZERO
	_paste_rotation = 0
	_paste_locked = false
	if not _fly_mode:
		_capture_cursor()  # also refreshes the crosshair aim + ghost
	else:
		_update_crosshair_target()
	_update_paste_popup_visibility()
	_overlay.visible = true
	_overlay.queue_redraw()

func _cancel_paste() -> void:
	if not _paste_active:
		return
	_paste_active = false
	_clear_paste_ghost()
	_update_paste_popup_visibility()
	_overlay.queue_redraw()

# Clone the clipboard into the world at the current aim/offset/rotation, skipping any cell
# that's already occupied (never overwrite), as one undo step. No-op if nothing is aimed at
# or every target cell is already occupied.
func _commit_paste() -> void:
	if not _paste_active:
		return
	var anchor = _paste_anchor()
	if anchor != null:
		var targets := _paste_targets(anchor)
		if not targets.is_empty():
			var clip := VoxelWorld.clipboard_cells()
			VoxelWorld.begin_operation("Paste")
			for pos: Vector3i in targets:
				var src: BlockCell = clip[targets[pos]]
				var cell := src.duplicate_cell()
				cell.orientation = Orientation.rotate_rigid_cw(cell.orientation, _paste_rotation)
				VoxelWorld.set_cell(pos, cell)
			VoxelWorld.end_operation()
			_animate_placement(_group_by_distance(targets.keys(), anchor))
	_paste_active = false
	_clear_paste_ghost()
	_update_paste_popup_visibility()
	_update_crosshair_target()

# Bucket cells by Manhattan distance from `origin` (nearest first), so _animate_placement
# reveals a pasted region radiating outward from the anchor instead of all at once — build-
# to-me/wand get their staggered reveal from a directional column/ring order; a paste's
# shape is arbitrary, so distance-from-anchor is the natural equivalent.
func _group_by_distance(cells: Array, origin: Vector3i) -> Array:
	var by_ring := {}
	for pos: Vector3i in cells:
		var ring: int = absi(pos.x - origin.x) + absi(pos.y - origin.y) + absi(pos.z - origin.z)
		if not by_ring.has(ring):
			by_ring[ring] = []
		by_ring[ring].append(pos)
	var rings := by_ring.keys()
	rings.sort()
	var groups: Array = []
	for ring in rings:
		groups.append(by_ring[ring])
	return groups

# The world position the clipboard's local origin (its selection_min at copy time) would land
# on right now: the crosshair's placement cell (same one a normal block placement would use),
# or the frozen base while locked (see _toggle_paste_lock), plus the manual offset. Null when
# nothing is aimed at and the anchor was never locked.
func _paste_anchor() -> Variant:
	var base: Vector3i
	if _paste_locked:
		base = _paste_locked_base
	elif _target_hit:
		base = _target_place
	elif _floor_hit:
		base = _floor_place
	else:
		return null
	return base + _paste_offset

# LMB: freeze the anchor at its current live position so the player can look elsewhere
# without the paste following, or unfreeze it to resume tracking the crosshair. Locking
# with nothing currently aimed at is a no-op (nothing to freeze onto).
func _toggle_paste_lock() -> void:
	if not _paste_active:
		return
	if _paste_locked:
		_paste_locked = false
	else:
		if _target_hit:
			_paste_locked_base = _target_place
		elif _floor_hit:
			_paste_locked_base = _floor_place
		else:
			return
		_paste_locked = true
	_refresh_ghost_preview()
	_overlay.queue_redraw()

# Cells the paste at `anchor` (current rotation) would touch: world position -> the
# clipboard's relative key, skipping any position already occupied. Pure position math only
# (no BlockCell cloning) so it's cheap to call every frame for the ghost; the commit clones
# the source cell once per surviving hit. Shared by both so they can't disagree.
func _paste_targets(anchor: Vector3i) -> Dictionary:
	var data := VoxelWorld.active_project.data
	var clip := VoxelWorld.clipboard_cells()
	var out := {}
	for rel: Vector3i in clip:
		var pos := anchor + Orientation.rotate_offset_cw(rel, _paste_rotation)
		if data.get_block(pos).is_empty():
			out[pos] = rel
	return out

# Refresh the paste ghost from the current aim/offset/rotation — called from
# _refresh_ghost_preview() (see below) whenever the aim, offset, or rotation changes.
func _refresh_paste_ghost() -> void:
	if not _paste_active or not VoxelWorld.active_project:
		_clear_paste_ghost()
		return
	var anchor = _paste_anchor()
	if anchor == null:
		_clear_paste_ghost()
		return
	_update_paste_box(anchor)
	var targets := _paste_targets(anchor)
	var clip := VoxelWorld.clipboard_cells()
	var by_semantic := {}   # semantic -> Array[{"pos": Vector3i, "o": int}]
	for pos: Vector3i in targets:
		var src: BlockCell = clip[targets[pos]]
		var o := Orientation.rotate_rigid_cw(src.orientation, _paste_rotation)
		if not by_semantic.has(src.type_id):
			by_semantic[src.type_id] = []
		by_semantic[src.type_id].append({"pos": pos, "o": o})
	_set_paste_ghost_groups(by_semantic)

# The [min, max] inclusive world bounds the pasted region's box would occupy at `anchor`,
# current rotation. A 90°-multiple rotation only swaps/negates the X/Z axes (no shearing), so
# rotating just the two extreme corners of the local box and taking their component-wise
# min/max is exactly the rotated AABB — no need to touch every clipboard cell.
func _paste_bounds(anchor: Vector3i) -> Array:
	var clip_size := VoxelWorld.clipboard_size()
	var c0 := Orientation.rotate_offset_cw(Vector3i.ZERO, _paste_rotation)
	var c1 := Orientation.rotate_offset_cw(clip_size - Vector3i.ONE, _paste_rotation)
	var lo := anchor + Vector3i(mini(c0.x, c1.x), mini(c0.y, c1.y), mini(c0.z, c1.z))
	var hi := anchor + Vector3i(maxi(c0.x, c1.x), maxi(c0.y, c1.y), maxi(c0.z, c1.z))
	return [lo, hi]

# Rebuild the wireframe outline around the pasted region's full bounds — same box-drawing
# recipe as _update_selection_box, just fed rotation-aware bounds instead of the selection.
func _update_paste_box(anchor: Vector3i) -> void:
	if _paste_box == null:
		return
	var bounds := _paste_bounds(anchor)
	var lo := Vector3(bounds[0] as Vector3i)
	var hi := Vector3(bounds[1] as Vector3i) + Vector3.ONE
	var p := [
		Vector3(lo.x, lo.y, lo.z), Vector3(hi.x, lo.y, lo.z), Vector3(hi.x, lo.y, hi.z), Vector3(lo.x, lo.y, hi.z),
		Vector3(lo.x, hi.y, lo.z), Vector3(hi.x, hi.y, lo.z), Vector3(hi.x, hi.y, hi.z), Vector3(lo.x, hi.y, hi.z),
	]
	var edges := [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
	var im := _paste_box.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for e in edges:
		im.surface_add_vertex(p[e[0]])
		im.surface_add_vertex(p[e[1]])
	im.surface_end()
	_paste_box.visible = true

# Push one ghost MultiMeshInstance3D per semantic present this frame (building/rebuilding its
# mesh only when the semantic's appearance changes, same caching as _ensure_ghost_mesh), then
# hide any left over from a previous frame whose semantic no longer appears.
func _set_paste_ghost_groups(by_semantic: Dictionary) -> void:
	for semantic in by_semantic.keys():
		var mm := _ensure_paste_ghost_mm(semantic)
		var entries: Array = by_semantic[semantic]
		var multimesh := mm.multimesh
		multimesh.instance_count = entries.size()
		for i in entries.size():
			var e: Dictionary = entries[i]
			var pos: Vector3i = e["pos"]
			var o: int = e["o"]
			multimesh.set_instance_transform(i, Transform3D(
				Orientation.basis_of(o).scaled(Vector3.ONE * VOXEL_SCALE),
				Vector3(pos) + Vector3(0.5, 0.5, 0.5)))
		mm.visible = true
	for semantic in _paste_ghost_mms.keys():
		if not by_semantic.has(semantic):
			var mm: MultiMeshInstance3D = _paste_ghost_mms[semantic]
			if mm.visible:
				mm.multimesh.instance_count = 0
				mm.visible = false

func _ensure_paste_ghost_mm(semantic: String) -> MultiMeshInstance3D:
	var mm: MultiMeshInstance3D = _paste_ghost_mms.get(semantic)
	if mm == null:
		var multimesh := MultiMesh.new()
		multimesh.transform_format = MultiMesh.TRANSFORM_3D
		mm = MultiMeshInstance3D.new()
		mm.multimesh = multimesh
		_viewport.add_child(mm)
		_paste_ghost_mms[semantic] = mm
	var model := VoxelWorld.get_model_for_semantic(semantic)
	var key := semantic + "|" + (_model_key(model) if model else "none")
	if key != _paste_ghost_mesh_keys.get(semantic, ""):
		_paste_ghost_mesh_keys[semantic] = key
		mm.multimesh.mesh = _build_paste_ghost_mesh(semantic, model)
	return mm

func _clear_paste_ghost() -> void:
	for semantic in _paste_ghost_mms.keys():
		var mm: MultiMeshInstance3D = _paste_ghost_mms[semantic]
		mm.multimesh.instance_count = 0
		mm.visible = false
	if _paste_box != null:
		_paste_box.visible = false

# ---------------------------------------------------------------------------
# Paste offset popup — a small non-modal panel for precise adjustment. MMB (or the bare
# viewport click / this panel's own MMB) toggles it, releasing/re-capturing the cursor since
# it needs real clicks; hidden again the moment fly resumes.
# ---------------------------------------------------------------------------

func _build_paste_popup() -> void:
	_paste_popup = PanelContainer.new()
	_paste_popup.visible = false
	_paste_popup.mouse_filter = Control.MOUSE_FILTER_STOP
	_paste_popup.custom_minimum_size = Vector2(260, 0)
	# MMB toggles the popup — closing needs to work from a click anywhere on the panel
	# itself (blank space included), not just the background viewport behind it.
	_paste_popup.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed \
				and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_MIDDLE:
			_capture_cursor()
			get_viewport().set_input_as_handled())
	# Opaque bordered card (same recipe as InventoryScreen's panel) — a bare PanelContainer
	# falls back to the theme's default panel style, which reads as translucent against the
	# 3D view behind it.
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.14, 0.17, 1.0)
	sb.border_color = Color(0.42, 0.47, 0.58)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	sb.set_content_margin_all(16)
	sb.shadow_color = Color(0, 0, 0, 0.5)
	sb.shadow_size = 12
	_paste_popup.add_theme_stylebox_override("panel", sb)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 10)
	_paste_popup.add_child(col)

	var title := Label.new()
	title.text = "Paste"
	title.add_theme_font_size_override("font_size", 20)
	col.add_child(title)
	col.add_child(HSeparator.new())

	for axis in ["x", "y", "z"]:
		col.add_child(_build_axis_row(axis))

	var rotate_btn := Button.new()
	rotate_btn.text = "Rotate 90°"
	rotate_btn.focus_mode = Control.FOCUS_NONE
	rotate_btn.custom_minimum_size = Vector2(0, 40)
	rotate_btn.add_theme_font_size_override("font_size", 16)
	rotate_btn.pressed.connect(func():
		_paste_rotation = (_paste_rotation + 1) % 4
		_refresh_ghost_preview()
		_update_paste_offset_labels())
	col.add_child(rotate_btn)

	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 8)
	col.add_child(buttons)
	var place_btn := Button.new()
	place_btn.text = "Place"
	place_btn.focus_mode = Control.FOCUS_NONE
	place_btn.custom_minimum_size = Vector2(0, 40)
	place_btn.add_theme_font_size_override("font_size", 16)
	place_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	place_btn.pressed.connect(_commit_paste)
	buttons.add_child(place_btn)
	var cancel_btn := Button.new()
	cancel_btn.text = "Cancel"
	cancel_btn.focus_mode = Control.FOCUS_NONE
	cancel_btn.custom_minimum_size = Vector2(0, 40)
	cancel_btn.add_theme_font_size_override("font_size", 16)
	cancel_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	cancel_btn.pressed.connect(_cancel_paste)
	buttons.add_child(cancel_btn)

	add_child(_paste_popup)
	# Anchors stay at the Control default (top-left, fixed size) — reset_size() applies its
	# real minimum size once here (get_combined_minimum_size(), same as a Container would lay
	# out) so it's never a zero-size, unclickable rect. Placement from here on is pure
	# global_position math in _position_paste_popup(), not anchors, so it can be pinned to
	# the whole workspace rather than wherever this particular pane happens to sit.
	_paste_popup.reset_size()

func _build_axis_row(axis: String) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var label := Label.new()
	label.text = axis.to_upper() + ":"
	label.add_theme_font_size_override("font_size", 16)
	label.custom_minimum_size = Vector2(22, 0)
	row.add_child(label)
	var minus := Button.new()
	minus.text = "-"
	minus.focus_mode = Control.FOCUS_NONE
	minus.custom_minimum_size = Vector2(40, 36)
	minus.add_theme_font_size_override("font_size", 18)
	minus.pressed.connect(func(): _nudge_paste_offset(axis, -1))
	row.add_child(minus)
	var value := Label.new()
	value.text = "0"
	value.add_theme_font_size_override("font_size", 16)
	value.custom_minimum_size = Vector2(36, 0)
	value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	row.add_child(value)
	_paste_offset_labels[axis] = value
	var plus := Button.new()
	plus.text = "+"
	plus.focus_mode = Control.FOCUS_NONE
	plus.custom_minimum_size = Vector2(40, 36)
	plus.add_theme_font_size_override("font_size", 18)
	plus.pressed.connect(func(): _nudge_paste_offset(axis, 1))
	row.add_child(plus)
	return row

func _nudge_paste_offset(axis: String, delta: int) -> void:
	match axis:
		"x": _paste_offset.x += delta
		"y": _paste_offset.y += delta
		"z": _paste_offset.z += delta
	_refresh_ghost_preview()
	_update_paste_offset_labels()

func _update_paste_offset_labels() -> void:
	if _paste_offset_labels.is_empty():
		return
	(_paste_offset_labels["x"] as Label).text = str(_paste_offset.x)
	(_paste_offset_labels["y"] as Label).text = str(_paste_offset.y)
	(_paste_offset_labels["z"] as Label).text = str(_paste_offset.z)

func _update_paste_popup_visibility() -> void:
	if _paste_popup == null:
		return
	_paste_popup.visible = _paste_active and not _fly_mode
	if _paste_popup.visible:
		_position_paste_popup()
		_update_paste_offset_labels()

# Bottom-center of the whole multi-pane workspace, not this specific pane — so the popup
# stays put regardless of which pane/view is doing the pasting, and doesn't get clipped by
# sitting flush against a pane's own edge (which can be the window edge in single-pane view).
func _position_paste_popup() -> void:
	var rect := _paste_workspace_rect()
	var popup_size := _paste_popup.size
	_paste_popup.global_position = Vector2(
		rect.position.x + (rect.size.x - popup_size.x) * 0.5,
		rect.position.y + rect.size.y - popup_size.y - 16.0)

# Walk up to the shared MultiViewShell (every pane lives under one) for its global rect;
# falls back to the window if one somehow can't be found.
func _paste_workspace_rect() -> Rect2:
	var host: Node = self
	while host != null and not (host is MultiViewShell):
		host = host.get_parent()
	if host is Control:
		return (host as Control).get_global_rect()
	return get_viewport().get_visible_rect()

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
		_restore_base_material(_cell_nodes[pos])
	_plane_sheet.visible = false
	_slice_marker.visible = false
	_overlay.visible = _fly_mode
	_overlay.queue_redraw()

func _confirm_slice() -> void:
	var axis := _slice_axis
	var center := _slice_center
	# Derive horizontal-axis flip from camera right vector: if camera "right" points
	# in the negative direction of the 2D view's horizontal world-axis, the view
	# would be mirrored — flip it so left-in-2D == left-in-3D.
	var look := _get_look_dir()
	var flat := Vector3(look.x, 0.0, look.z)
	if flat.length_squared() > 0.0:
		flat = flat.normalized()
	var right := flat.cross(Vector3.UP)
	var flipped := false
	match axis:
		0: flipped = right.z < 0.0   # X-slice: horizontal world axis is Z
		1: flipped = right.x < 0.0   # Y-slice: horizontal world axis is X
		2: flipped = right.x < 0.0   # Z-slice: horizontal world axis is X
	_exit_slice_select()
	VoxelWorld.request_slice_view(axis, center, flipped)

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
		var on_plane := pos[_slice_axis] == offset
		for mi in _cell_mesh_instances(_cell_nodes[pos]):
			var semantic: String = mi.get_meta("semantic", "")
			mi.material_override = _onplane_mat_for(semantic) if on_plane else _faded_mat_for(semantic)
	var b := _slice_plane_bounds()
	_slice_bounds_lo = b[0]
	_slice_bounds_hi = b[1]
	_update_plane_sheet()
	_update_slice_marker()
	_overlay.queue_redraw()

# Return a cell to its non-slice look: textured cells drop the override so their
# per-surface materials show again; color cells get their base color material back.
# Accepts a single MeshInstance3D or a multipart container (restores every part).
func _restore_base_material(node: Node) -> void:
	for mi in _cell_mesh_instances(node):
		if mi.get_meta("textured", false):
			mi.material_override = null
		else:
			var semantic: String = mi.get_meta("semantic", "")
			if _normal_mats.has(semantic):
				mi.material_override = _normal_mats[semantic]

# The MeshInstance3D(s) a cell node owns: itself for a single-part cell, or its
# children for a multipart container. Lets slice-mode treat both uniformly.
func _cell_mesh_instances(node: Node) -> Array:
	if node is MeshInstance3D:
		return [node]
	var out: Array = []
	for child in node.get_children():
		if child is MeshInstance3D:
			out.append(child)
	return out

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
	var c := _plane_corners(_slice_axis, _slice_bounds_lo, _slice_bounds_hi, off)
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
	var c := _plane_corners(_slice_axis, _slice_bounds_lo, _slice_bounds_hi, off)
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

func _draw_paste_hud() -> void:
	var font := ThemeDB.fallback_font
	if _fly_mode:
		var center := _overlay.size / 2.0
		# Amber crosshair while the anchor is locked (pinned in place, not tracking aim) so
		# the "frozen" state reads at a glance, not just from the HUD text.
		var col := Color(1.0, 0.75, 0.25, 0.95) if _paste_locked else Color(1, 1, 1, 0.9)
		_overlay.draw_line(center + Vector2(-14, 0),  center + Vector2(14, 0),  col, 1.5)
		_overlay.draw_line(center + Vector2(0,  -14), center + Vector2(0,  14), col, 1.5)
		_overlay.draw_circle(center, 3.0, Color(0,0,0,0.4))
	var title := "Paste%s  offset (%d, %d, %d)  ·  rotation %d°" % [
		"  (locked)" if _paste_locked else "",
		_paste_offset.x, _paste_offset.y, _paste_offset.z, _paste_rotation * 90]
	_overlay.draw_string(font, Vector2(14.0, 30.0), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.85, 1.0, 0.9, 0.95))
	var hint := ("RMB place  ·  LMB lock/unlock  ·  MMB offset controls  ·  R rotate  ·  Esc cancel" if _fly_mode
		else "MMB or click the view to resume aiming  ·  Esc or Cancel to abort")
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 10.0), hint,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.7))

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

func _plane_corners(axis: int, mn: Vector3, mx: Vector3, off: float) -> Array:
	match axis:
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

# Wheel scrubs the shared hotbar, MC-style (wrapping across all the slots).
func _cycle_palette(delta: int) -> void:
	var n := VoxelWorld.HOTBAR_SIZE
	VoxelWorld.select_slot((VoxelWorld.active_slot + delta % n + n) % n)

func _select_palette_slot(slot: int) -> void:
	VoxelWorld.select_slot(slot)

# ---------------------------------------------------------------------------
# 2D overlay: crosshair · hotbar · hints
# ---------------------------------------------------------------------------

func _draw_overlay() -> void:
	if _slice_active:
		_draw_slice_hud()
		return
	if _paste_active:
		_draw_paste_hud()
		return
	var center := _overlay.size / 2.0
	_overlay.draw_line(center + Vector2(-14, 0),  center + Vector2(14, 0),  Color(1,1,1,0.9), 1.5)
	_overlay.draw_line(center + Vector2(0,  -14), center + Vector2(0,  14), Color(1,1,1,0.9), 1.5)
	_overlay.draw_circle(center, 3.0, Color(0,0,0,0.4))
	var font := ThemeDB.fallback_font
	if _sky_label_timer > 0.0 and _skyboxes.size() > 1:
		var sky_name: String = _skyboxes[_current_sky]["name"]
		_overlay.draw_string(font, Vector2(_overlay.size.x * 0.5, 32.0),
			"Sky: " + sky_name, HORIZONTAL_ALIGNMENT_CENTER, -1, 16, Color(1,1,1,0.85))
	var hint := "WASD move  ·  Space/RCtrl up · Shift// down  ·  LMB erase · RMB place · MMB pick  ·  R rotate (look at face)  ·  Tab slice · 1–0 slot · E inventory · Esc"
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 10.0),
		hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1,1,1,0.45))
