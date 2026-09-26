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
# Alternate placement for shaped parts, held while clicking: a microblock goes on the far
# side (Forge Microblocks' Ctrl), an architecture shape goes base-against-the-wall
# (ArchitectureCraft's sneak). Two ways to hold it, so it works for either hand:
#   left Ctrl          — right-handed keyboard (right Ctrl stays fly-up)
#   mouse thumb button — back or forward, either hand
var _lctrl_held := false
var _alt_mouse_held := false

# --- Raycast state ---
var _target_hit := false
var _target_block := Vector3i.ZERO
var _target_place := Vector3i.ZERO
var _target_point := Vector3.ZERO     # exact world point the ray hit
var _target_normal := Vector3i.ZERO   # outward normal of the face that was hit
var _target_part := -1                # hit shaped part's index in its cell; -1 = whole block
var _floor_hit := false
var _floor_place := Vector3i.ZERO
var _floor_point := Vector3.ZERO      # exact world point on the floor plane
var _floor_y := 0  # Y level of the virtual placement floor

# --- Shaped-part placement preview ---
# With a shaped entry in hand, the aimed face shows the family's placement grid (which
# zone picks which slot) and a translucent copy of the exact part that would be placed.
var _place_grid: MeshInstance3D
var _part_ghost: MeshInstance3D
var _part_ghost_key := ""

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
# The source: null = the clipboard (Ctrl+V); a prefab when placing one (the inventory's
# Prefabs page). A prefab places its anchor cell on the aim and turns about it; the clipboard
# is anchored at its min corner.
var _paste_prefab: Prefab = null
# M toggles an east-west flip, applied after the turn (so R then M covers all eight images).
var _paste_mirror := false
var _paste_panel: ToolOverlayPanel
# The missing-palettes question is up for a prefab placement (input waits for it).
var _paste_asking := false
# One MultiMeshInstance3D per distinct semantic in the clipboard — unlike the single-semantic
# _ghost_mm above (build-to-me/wand only ever preview ONE block type), a pasted region can mix
# many, so each gets its own draw call.
var _paste_ghost_mms: Dictionary = {}       # semantic -> MultiMeshInstance3D
var _paste_ghost_mesh_keys: Dictionary = {} # semantic -> mesh signature, for rebuild-on-change
var _paste_offset_labels: Dictionary = {}   # "x"/"y"/"z" -> Label (paste overlay's live values)
# Wireframe outline around the pasted region's full bounds (see _setup_viewport for the
# show-through material and _update_paste_box) — the ghost blocks themselves are opaque now
# (see _GHOST_ALPHA/_build_paste_ghost_mesh below), so the box is what still reads through walls.
var _paste_box: MeshInstance3D
var _paste_box_mat: StandardMaterial3D

# Wand preview: per-cell wireframe outlines (one box per block the flood would place), like a
# builders-wand highlight — replaces the translucent ghost blocks for the wand, which read as
# noise across a big flood. See _draw_wand_cells.
var _wand_box: MeshInstance3D

# --- Tool overlays (middle-click panels) ------------------------------------
# An extensible system so any tool — or the paste modal — can offer a small panel that
# middle-click brings up (paste's offset controls were the first). The shared parts live
# here: the ToolOverlayPanel framing, the open/close mechanism (MMB frees the cursor to
# reveal the panel, MMB/click re-captures to hide it), and the bottom-center positioning.
# A tool opts in by registering a panel under a string id and mapping its Tool enum to that
# id (see _setup_tool_overlays); only the rows inside each panel vary by tool.
var _tool_overlays := {}          # id -> { "panel": ToolOverlayPanel, "refresh": Callable }
var _tool_overlay_ids := {}       # VoxelWorld.Tool -> overlay id (a tool's opt-in mapping)
# A tool overlay (not the paste modal — that's tracked by _paste_active) is currently open.
# Distinct from _fly_mode so the panel only shows when deliberately summoned via MMB, not
# every time the cursor happens to be free (e.g. after Esc, or in the default orbit view).
var _tool_overlay_open := false
const _PASTE_OVERLAY := "paste"
const _SELECTION_OVERLAY := "selection"
const _CUTAWAY_OVERLAY := "cutaway"
var _selection_overlay: ToolOverlayPanel   # kept typed so its refresh can rebuild the list

# Cutaway (see VoxelWorld.set_cutaway): cells inside _cut_box are hidden and clicks pass
# through them. On-screen views follow VoxelWorld's box; the offscreen capture view is
# given its own through set_cutaway_override, so an agent's renders never depend on (or
# disturb) what the user has cut away.
var _cut_box: Array = []              # [min, max] Vector3i, or [] = nothing cut
var _cut_override: Variant = null     # null = follow VoxelWorld; else the box to use ([] = none)
var _cutaway_panel_open := false      # the cutaway bounds panel is showing (cursor free)
var _cut_frame: MeshInstance3D        # outline of the cut box, shown while its panel is open
var _cut_value_labels := {}           # "x0"/"x1"/... -> Label (panel read-outs)
var _cut_toggle_btn: Button

# An offscreen instance (CaptureService's private camera for agent renders): never takes
# input, never bakes the project thumbnail, and moving its camera isn't a project change.
var offscreen := false

# What this view draws: null = the open build (VoxelWorld.active_project); set, a stand-in
# project it renders instead — a prefab wrapped with its preferred palettes, for thumbnails
# and previews. Semantics then resolve through that project's stack (VoxelWorld.
# begin_resolve_as around each rebuild), and edits to the open build are ignored. Only
# offscreen views take a source: an on-screen one would still edit the open build.
var source_project: VoxelProject = null

func _project() -> VoxelProject:
	return source_project if source_project != null else VoxelWorld.active_project

func set_source_project(p: VoxelProject) -> void:
	source_project = p
	_mark_dirty()

func _begin_source() -> void:
	if source_project != null:
		VoxelWorld.begin_resolve_as(source_project)

func _end_source() -> void:
	if source_project != null:
		VoxelWorld.end_resolve_as()

func _ready() -> void:
	_setup_viewport()
	_setup_overlay()
	_setup_tool_overlays()
	VoxelWorld.project_opened.connect(_on_project_opened)
	# Batches placed by agents (VoxelWorld.apply_edits) get the same reveal as the user's own.
	VoxelWorld.placement_fx_requested.connect(func(steps: Array): if not offscreen: _animate_placement(steps))
	if not offscreen:
		_toolbar = ViewToolbar.new(self)
		_toolbar.position = Vector2(6, 6)
		add_child(_toolbar)
	VoxelWorld.about_to_save.connect(_on_about_to_save)
	VoxelWorld.block_changed.connect(func(p, _s): if source_project == null: _mark_cell_dirty(p))
	VoxelWorld.palette_stack_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.block_type_changed.connect(func(): _mark_dirty(); if _fly_mode: _overlay.queue_redraw())
	VoxelWorld.selection_changed.connect(func(_s): if _fly_mode: _overlay.queue_redraw())
	# Keep the build-to-me ghost in sync with anything that changes what it would build.
	VoxelWorld.tool_changed.connect(func(_t): _refresh_ghost_preview())
	# The selection highlight is only shown while the Select tool is active, so switching
	# tools must re-evaluate its visibility.
	VoxelWorld.tool_changed.connect(func(_t): _update_selection_box())
	# Switching tools closes any open tool overlay (its rows belong to the tool you left).
	VoxelWorld.tool_changed.connect(func(_t): _close_tool_overlay_if_open())
	VoxelWorld.brush_size_changed.connect(func(_s): _refresh_ghost_preview())
	VoxelWorld.selection_changed.connect(func(_s): _refresh_ghost_preview())
	# Shaped-part grid + ghost follow the hand and the tool too.
	VoxelWorld.selection_changed.connect(func(_s): _refresh_shaped_preview())
	VoxelWorld.tool_changed.connect(func(_t): _refresh_shaped_preview())
	VoxelWorld.workspace_changed.connect(_on_workspace_changed)
	# The region selection is shared across views; repaint the box whenever it changes.
	VoxelWorld.region_selection_changed.connect(_update_selection_box)
	# Keep a visible selection overlay's dimensions/counts current as the region changes.
	VoxelWorld.region_selection_changed.connect(_update_tool_overlay_visibility)
	VoxelWorld.cutaway_changed.connect(_refresh_cutaway)
	VoxelWorld.prefab_paste_requested.connect(_on_prefab_paste_requested)
	visibility_changed.connect(_on_visibility_changed)
	set_process(true)
	# A view created while a project is already open (e.g. spawned during a layout
	# restore, after project_opened has already fired) must render the current build
	# itself — otherwise it stays blank until the next block_changed signal.
	if _project():
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
	if project == null or _viewport == null or project.scratch or offscreen:
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
	if source_project != null:
		return
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
	# Each view gets its own 3D world. A SubViewport otherwise draws into the shared root
	# world, so every 3D view (split panes, the agent's offscreen camera) would render every
	# other view's meshes, lights and sky on top of its own.
	_viewport.own_world_3d = true
	svc.add_child(_viewport)

	_world_env = WorldEnvironment.new()
	_world_env.environment = Environment.new()
	_viewport.add_child(_world_env)
	_init_skyboxes()
	_apply_sky()

	_sun = DirectionalLight3D.new()
	var sun := _sun
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.0
	_viewport.add_child(sun)

	_fill = DirectionalLight3D.new()
	var fill := _fill
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

	# Feature-edge overlay for outline/xray/wire — a single merged line mesh, sibling to
	# _voxel_root (never freed by _rebuild's per-cell clear), rebuilt in _rebuild_wire_lines.
	_wire_mi = MeshInstance3D.new()
	_wire_mi.visible = false
	_viewport.add_child(_wire_mi)

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

	# Shaped-part placement grid (drawn on the aimed face) + the part ghost.
	var place_grid_mat := StandardMaterial3D.new()
	place_grid_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	place_grid_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	place_grid_mat.albedo_color = Color(0.05, 0.05, 0.08, 0.9)
	_place_grid = MeshInstance3D.new()
	_place_grid.mesh = ImmediateMesh.new()
	_place_grid.material_override = place_grid_mat
	_place_grid.visible = false
	_viewport.add_child(_place_grid)
	_part_ghost = MeshInstance3D.new()
	_part_ghost.visible = false
	_viewport.add_child(_part_ghost)

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

	# Cutaway frame: the same show-through recipe in red, so the cut's edges read even where
	# the build around them hides them.
	var cut_behind := _sel_box_mat.duplicate() as StandardMaterial3D
	cut_behind.albedo_color = Color(1.0, 0.35, 0.3, 0.3)
	var cut_front := sel_front.duplicate() as StandardMaterial3D
	cut_front.albedo_color = Color(1.0, 0.45, 0.35, 1.0)
	cut_behind.next_pass = cut_front
	_cut_frame = MeshInstance3D.new()
	_cut_frame.mesh = ImmediateMesh.new()
	_cut_frame.material_override = cut_behind
	_cut_frame.visible = false
	_viewport.add_child(_cut_frame)

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

	# Wand outlines: unshaded, no depth test so each per-block box reads clearly even through
	# other geometry (builders-wand style). Uses per-vertex color from _draw_cell_wire.
	var wand_mat := StandardMaterial3D.new()
	wand_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	wand_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	wand_mat.no_depth_test = true
	wand_mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	wand_mat.vertex_color_use_as_albedo = true
	_wand_box = MeshInstance3D.new()
	_wand_box.mesh = ImmediateMesh.new()
	_wand_box.material_override = wand_mat
	_wand_box.visible = false
	_viewport.add_child(_wand_box)

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
	_apply_lighting()
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
	if offscreen:
		return
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
		elif key.physical_keycode == KEY_CTRL and not key.echo and _lctrl_held != key.pressed:
			_lctrl_held = key.pressed
			_refresh_shaped_preview()   # the ghost jumps to the opposite slot while held

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
			# H / End: switch the cutaway off and on (End for the right hand, near the arrows).
			if (key.keycode == KEY_H or key.keycode == KEY_END) and not key.echo \
					and VoxelWorld.has_cutaway:
				VoxelWorld.set_cutaway_enabled(not VoxelWorld.cutaway_enabled)
				get_viewport().set_input_as_handled()
				return
			# BACKSPACE erases the selected region (one undo step), but only while the Select
			# tool is active — otherwise a stray selection would hijack the key in every tool.
			# Handled here in _input so it wins over any lower-priority BACKSPACE binding.
			if key.keycode == KEY_BACKSPACE and VoxelWorld.active_tool == VoxelWorld.Tool.SELECT \
					and VoxelWorld.has_selection:
				VoxelWorld.delete_selection()
				get_viewport().set_input_as_handled()
				return
			# 1–9 palette slots + R rotate (captured mode only)
			if _fly_mode:
				var kc := key.keycode
				if _paste_active and kc == KEY_R:
					_paste_rotation = (_paste_rotation + 1) % 4
					_refresh_ghost_preview()
					get_viewport().set_input_as_handled()
					return
				if _paste_active and kc == KEY_M:
					_toggle_paste_mirror()
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
	# Either mouse thumb button (back/forward) held = alternate placement for shaped parts,
	# the handedness-neutral twin of left Ctrl (see _alt_placement). Tracked on press AND
	# release, so it's checked before the pressed-only click handling below.
	if event is InputEventMouseButton and ((event as InputEventMouseButton).button_index == MOUSE_BUTTON_XBUTTON1 \
			or (event as InputEventMouseButton).button_index == MOUSE_BUTTON_XBUTTON2):
		var thumb := (event as InputEventMouseButton).pressed
		if thumb != _alt_mouse_held:
			_alt_mouse_held = thumb
			_refresh_shaped_preview()
		get_viewport().set_input_as_handled()
		return
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
			# lock, MMB opens the offset overlay — no erase/pick/palette-cycle while pending.
			match mb.button_index:
				MOUSE_BUTTON_RIGHT:  _commit_paste()
				MOUSE_BUTTON_LEFT:   _toggle_paste_lock()
				MOUSE_BUTTON_MIDDLE: _open_tool_overlay()  # reveals the panel, same as Esc used to
		else:
			match mb.button_index:
				MOUSE_BUTTON_LEFT:        _erase_targeted_block()
				MOUSE_BUTTON_RIGHT:       _use_primary_tool()
				# MMB opens the active tool's overlay if it registered one; otherwise it keeps
				# its default "pick block" role. This is a tool's opt-in to the overlay system.
				MOUSE_BUTTON_MIDDLE:
					if _tool_overlay_ids.has(VoxelWorld.active_tool):
						_open_tool_overlay()
					else:
						_pick_targeted_block()
				MOUSE_BUTTON_WHEEL_UP:    _cycle_palette(-1)
				MOUSE_BUTTON_WHEEL_DOWN:  _cycle_palette(1)
		get_viewport().set_input_as_handled()

# Non-captured mouse: drag-to-look + scroll-to-dolly
func _on_svc_input(event: InputEvent) -> void:
	if offscreen:
		return
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
		elif mb.button_index == MOUSE_BUTTON_MIDDLE and mb.pressed and _visible_overlay_id() != "":
			_close_tool_overlay()  # closes the overlay and resumes flying, mirroring MMB in _input
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			# Dolly forward along look direction (orthographic: zoom, since distance does nothing)
			if _camera.projection == Camera3D.PROJECTION_ORTHOGONAL:
				_camera.size = maxf(1.0, _camera.size / 1.1)
			else:
				_camera_pos += _get_look_dir() * DOLLY_STEP
			_update_camera()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if _camera.projection == Camera3D.PROJECTION_ORTHOGONAL:
				_camera.size = minf(500.0, _camera.size * 1.1)
			else:
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
	# Recapturing the cursor always dismisses a tool overlay (the paste modal itself stays
	# live — only its panel hides, since panels only show while the cursor is free).
	_tool_overlay_open = false
	if _cutaway_panel_open:
		_cutaway_panel_open = false
		_update_cut_frame()
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	_overlay.visible = true
	_update_tool_overlay_visibility()
	_update_crosshair_target()
	_overlay.queue_redraw()

func _release_cursor() -> void:
	_fly_mode = false
	_drag_looking = false
	_rctrl_held = false
	_ralt_held = false
	_rshift_held = false
	_lctrl_held = false
	_alt_mouse_held = false
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	_highlight.visible = false
	_clear_shaped_preview()
	if _paste_active:
		# Mid-paste: MMB (see _input) called this to step out of fly mode and reveal the
		# offset panel — the paste itself (ghost, aim, offset, lock) stays live, frozen at
		# the last aimed cell.
		_update_tool_overlay_visibility()
		_overlay.queue_redraw()
		return
	_overlay.visible = false
	_target_hit = false
	_floor_hit = false
	_clear_ghost()
	_clear_wand_box()
	# If MMB (see _input) freed the cursor to open a tool overlay, reveal it now; otherwise
	# this is a plain Esc/blur release and _update leaves every panel hidden.
	_update_tool_overlay_visibility()

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
		"render": render_options.duplicate(),
		"ortho_size": _camera.size if _camera else 20.0,
	}

func apply_view_state(state: Dictionary) -> void:
	_camera_pos = state.get("camera_pos", _camera_pos)
	_yaw = state.get("yaw", _yaw)
	_pitch = state.get("pitch", _pitch)
	_current_sky = int(state.get("sky", _current_sky))
	_applying_state = true
	if state.get("render") is Dictionary:
		set_render_options(state["render"])
	if _camera != null and state.has("ortho_size"):
		_camera.size = float(state["ortho_size"])
	if _world_env != null:
		_apply_lighting()
	if _camera != null:
		_update_camera()
	_applying_state = false

# ---------------------------------------------------------------------------
# Render options (see ViewOptions) — per view, saved with the layout like the camera.
# ---------------------------------------------------------------------------

signal settings_changed()

var render_options := ViewOptions.defaults()
var _sun: DirectionalLight3D
var _fill: DirectionalLight3D
var _under_light: DirectionalLight3D
var _mode_mats := {}   # semantic -> material for the intent / clay lenses
var _xray_mats := {}   # semantic -> translucent material for the xray lens
var _wire_mats := {}   # mode -> line material (outline / xray / wire)
var _wire_mi: MeshInstance3D   # merged feature-edge geometry for outline / xray / wire
var _marker_box: MeshInstance3D
var _toolbar: Control

# Change some render options ({id: value}; unknown ids/values are ignored — check them with
# ViewOptions.check first). Rebuilds what the change affects and tells the toolbar.
func set_render_options(opts: Dictionary) -> void:
	var changed := false
	for k in opts:
		if render_options.has(k) and str(opts[k]) in ViewOptions.values(str(k)) and render_options[k] != str(opts[k]):
			render_options[k] = str(opts[k])
			changed = true
	if not changed:
		return
	_apply_lighting()
	_apply_projection()
	_mode_mats.clear()
	_xray_mats.clear()
	_mark_dirty()
	if not _applying_state and not offscreen:
		VoxelWorld.mark_dirty()   # the layout (with this view's settings) is saved with the project
	settings_changed.emit()

func _apply_lighting() -> void:
	if _world_env == null:
		return
	var env := _world_env.environment
	var lighting := str(render_options["lighting"])
	var plain := str(render_options["background"]) == "plain"
	_apply_sky()
	_sky_sphere.visible = not plain
	_grid_plane.visible = not plain
	if plain:
		env.background_color = Color(0.17, 0.18, 0.2)
	if _under_light == null:
		_under_light = DirectionalLight3D.new()
		_under_light.rotation_degrees = Vector3(70, 30, 0)   # shines upward, onto undersides
		_viewport.add_child(_under_light)
	match lighting:
		"studio":
			env.ambient_light_color = Color(0.92, 0.92, 0.95)
			env.ambient_light_energy = 0.55
			_sun.light_energy = 0.85
			_fill.light_energy = 0.45
			_under_light.light_energy = 0.4
			_under_light.visible = true
		"flat":
			env.ambient_light_color = Color.WHITE
			env.ambient_light_energy = 1.0
			_sun.light_energy = 0.0
			_fill.light_energy = 0.0
			_under_light.visible = false
		_:
			_sun.light_energy = 1.0
			_fill.light_energy = 0.35
			_under_light.visible = false

func _apply_projection() -> void:
	if _camera == null:
		return
	var ortho := str(render_options["projection"]) == "orthographic"
	_camera.projection = Camera3D.PROJECTION_ORTHOGONAL if ortho else Camera3D.PROJECTION_PERSPECTIVE
	if ortho and _camera.size < 1.0:
		_camera.size = 20.0

# The flat material a semantic gets in the intent / clay lenses. Intent colors are spread
# around the hue wheel by golden ratio in the project's palette order, so neighbors differ.
func _mode_material(semantic: String) -> StandardMaterial3D:
	if _mode_mats.has(semantic):
		return _mode_mats[semantic]
	var mat := StandardMaterial3D.new()
	if render_options["mode"] == "intent":
		mat.albedo_color = intent_color(semantic)
		if render_options["lighting"] == "flat":
			mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	else:
		mat.albedo_color = Color(0.78, 0.76, 0.72)
		mat.roughness = 0.9
	_mode_mats[semantic] = mat
	return mat

# The translucent fill material a semantic gets in the xray lens: its intent color at low
# opacity, both sides drawn so interior faces show through instead of being backface-culled.
func _xray_material(semantic: String) -> StandardMaterial3D:
	if _xray_mats.has(semantic):
		return _xray_mats[semantic]
	var mat := StandardMaterial3D.new()
	var c := intent_color(semantic)
	c.a = 0.15
	mat.albedo_color = c
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_xray_mats[semantic] = mat
	return mat

# The intent-lens color of a semantic (also what a capture's legend shows).
static func intent_color(semantic: String) -> Color:
	var names := VoxelWorld.merged_semantic_names()
	var i := names.find(semantic)
	if i < 0:
		i = names.size() + absi(semantic.hash()) % 17
	return Color.from_hsv(fposmod(0.08 + i * 0.618034, 1.0), 0.62, 0.92)

# Aim the camera: stand at `pos` looking at `target`. fov < 0 keeps the current one;
# ortho_size > 0 switches to an orthographic camera of that height, 0 to perspective.
func set_camera_pose(pos: Vector3, target: Vector3, fov := -1.0, ortho_size := -1.0) -> void:
	var dir := (target - pos).normalized()
	_camera_pos = pos
	_yaw = rad_to_deg(atan2(dir.x, dir.z))
	_pitch = clampf(rad_to_deg(asin(clampf(dir.y, -1.0, 1.0))), -89.0, 89.0)
	if _camera != null:
		if fov > 0.0:
			_camera.fov = fov
		if ortho_size > 0.0:
			render_options["projection"] = "orthographic"
			_camera.size = ortho_size
			_apply_projection()
			settings_changed.emit()
		elif ortho_size == 0.0 and render_options["projection"] != "perspective":
			render_options["projection"] = "perspective"
			_apply_projection()
			settings_changed.emit()
	_update_camera()

# The camera as plain numbers: position, look direction, vertical fov, ortho size (0 when
# perspective), and its right/up axes (for drawing an axes gizmo over a render).
func camera_info() -> Dictionary:
	var ortho := _camera.projection == Camera3D.PROJECTION_ORTHOGONAL
	return {"pos": _camera_pos, "dir": _get_look_dir(), "fov": _camera.fov,
		"ortho_size": _camera.size if ortho else 0.0,
		"right": _camera.global_transform.basis.x, "up": _camera.global_transform.basis.y}

func camera_node() -> Camera3D:
	return _camera

# Frame a box of cells (inclusive min/max) from a compass bearing and elevation, keeping
# this view's projection. Used by the toolbar's camera presets and by agents.
func frame_cells(mn: Vector3i, mx: Vector3i, from_bearing: float, elevation: Variant) -> void:
	var box := AABB(Vector3(mn), Vector3(mx - mn + Vector3i.ONE))
	var aspect := float(_viewport.size.x) / maxf(1.0, float(_viewport.size.y))
	var ortho := str(render_options["projection"]) == "orthographic"
	var floor_y := float(mn.y)
	var pose := CameraFraming.frame(box, from_bearing, elevation, _camera.fov, aspect, 1.15, ortho, -1.0, floor_y)
	set_camera_pose(pose["pos"], pose["target"], -1.0, float(pose["ortho_size"]) if ortho else -1.0)

# Offscreen rendering (CaptureService): draw the next frame, then read it back.
func render_once() -> void:
	_viewport.render_target_update_mode = SubViewport.UPDATE_ONCE

func viewport_image() -> Image:
	return _viewport.get_texture().get_image()

func set_viewport_size(s: Vector2i) -> void:
	size = Vector2(s)
	_viewport.size = s

# A wireframe box around cells [mn, mx] (a capture's framed region), or hidden with null.
func set_marker_box(mn: Variant, mx: Variant = null, color := Color(1.0, 0.85, 0.3)) -> void:
	if _marker_box == null:
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.vertex_color_use_as_albedo = true
		mat.no_depth_test = true
		_marker_box = MeshInstance3D.new()
		_marker_box.mesh = ImmediateMesh.new()
		_marker_box.material_override = mat
		_viewport.add_child(_marker_box)
	var im := _marker_box.mesh as ImmediateMesh
	im.clear_surfaces()
	if mn == null:
		_marker_box.visible = false
		return
	var lo := Vector3(mn as Vector3i)
	var hi := Vector3(mx as Vector3i) + Vector3.ONE
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for a in 3:
		for i in 4:
			var p := lo
			var q := lo
			var b := (a + 1) % 3
			var c := (a + 2) % 3
			p[b] = hi[b] if i & 1 else lo[b]
			p[c] = hi[c] if i & 2 else lo[c]
			q = p
			q[a] = hi[a]
			im.surface_set_color(color)
			im.surface_add_vertex(p)
			im.surface_set_color(color)
			im.surface_add_vertex(q)
	im.surface_end()
	_marker_box.visible = true

func set_active(active: bool) -> void:
	if _active == active:
		return
	_active = active
	if not _active:
		if _paste_active:
			_cancel_paste()  # a backgrounded pane can't be left mid-paste with a live panel
		# Drop any open tool overlay too — a backgrounded pane shouldn't keep one floating.
		_tool_overlay_open = false
		_update_tool_overlay_visibility()
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
		# A modal (the inventory) is taking over — don't leave a tool overlay floating over it.
		_tool_overlay_open = false
		_update_tool_overlay_visibility()
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
	if _guide.is_empty() or not _project():
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
	var aabb := _project().data.get_used_aabb()
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
	if not _applying_state and not offscreen:
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
	if not _project():
		return Vector3.ZERO
	var aabb := _project().data.get_used_aabb()
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
	if not _full_rebuild_pending:   # a pending full rebuild already covers every cell
		_dirty_positions[pos] = true
		for dir in BlockMesher.DIR_NORMALS:
			_dirty_positions[pos + Vector3i(BlockMesher.DIR_NORMALS[dir])] = true
	_schedule_flush()

# The offscreen view (CaptureService's) only has to be current when a capture is taken, so
# it holds its changes until flush_pending() rather than rebuilding alongside the visible
# views on every edit and palette change — at ~100k cells that doubled every rebuild.
func _schedule_flush() -> void:
	if offscreen:
		_dirty = true
		return
	if not _dirty:
		_dirty = true
		call_deferred("_flush_dirty")

# Bring the view up to date now (the capture path calls this before it renders).
func flush_pending() -> void:
	if _dirty:
		_flush_dirty()

# Coalesces however many _mark_dirty/_mark_cell_dirty calls happened this frame (e.g. a
# bulk tool or a multi-block undo/redo step, each emitting block_changed per cell) into
# one deferred flush. A pending full rebuild wins outright since it already covers every
# dirty position.
func _flush_dirty() -> void:
	# Every cell asks the palette what its semantic resolves to (several times over) and looks
	# its model up by id; nothing can change mid-flush, so each is resolved once per pass.
	_begin_source()
	VoxelWorld.begin_resolve_memo()
	_flush_memo_live = true
	_flush_dirty_inner()
	_flush_memo_live = false
	_flush_memo.clear()
	VoxelWorld.end_resolve_memo()
	_end_source()

# Per-flush lookups (see _flush_dirty). Outside a flush they go straight through.
var _flush_memo := {}
var _flush_memo_live := false

# A model by id, catalog-wide (a state map's variant/part model). The workspace searches
# every library for it, which at ~140 libraries was most of a cell's build cost.
func _block_model_by_id(model_id: String) -> BlockModel:
	if not _flush_memo_live:
		return VoxelWorld.workspace.get_block_model(model_id)
	var key := "m:" + model_id
	if not _flush_memo.has(key):
		_flush_memo[key] = VoxelWorld.workspace.get_block_model(model_id)
	return _flush_memo[key]

func _semantic_model(semantic: String) -> BlockModel:
	if not _flush_memo_live:
		return VoxelWorld.get_model_for_semantic(semantic)
	var key := "s:" + semantic
	if not _flush_memo.has(key):
		_flush_memo[key] = VoxelWorld.get_model_for_semantic(semantic)
	return _flush_memo[key]

func _flush_dirty_inner() -> void:
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
	if not _project():
		return
	var data := _project().data
	for pos: Vector3i in positions:
		_update_cell_node(pos, data)
	# Re-apply emphasis/guide the same way a full rebuild would (both are cheap: emphasis
	# only touches the nodes that exist, guide only resizes a 4-vertex plane).
	if _slice_active:
		_update_slice_visuals()
	_refresh_guide()
	_rebuild_wire_lines()

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
	node.visible = not _in_cut(pos)
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
	_part_ghost_key = ""
	for child in _voxel_root.get_children():
		_voxel_root.remove_child(child)
		child.free()
	_cell_nodes.clear()
	_normal_mats.clear()
	_faded_mats.clear()
	_onplane_mats.clear()
	_mode_mats.clear()
	_xray_mats.clear()
	# Per-rebuild material caches (pick up palette / block-type edits); the heavy
	# ImageTexture cache and shared geometry/shaders persist across rebuilds.
	_model_tex_cache.clear()
	_surface_mats.clear()
	if not _project():
		return
	var data := _project().data
	_cut_box = _wanted_cut_box()
	var cut_on := not _cut_box.is_empty()
	for pos: Vector3i in data.cells.keys():
		var cell: BlockCell = data.cells[pos]
		var semantic: String = cell.type_id
		if semantic.is_empty():
			continue
		var node := _build_cell_node(pos, cell, semantic)
		if cut_on and _in_cut(pos):
			node.visible = false
		_voxel_root.add_child(node)
		_cell_nodes[pos] = node
	# Re-apply emphasis if a rebuild happened while choosing a slice (e.g. an edit
	# in another view, or a palette change).
	if _slice_active:
		_update_slice_visuals()
	_refresh_guide()  # the guide plane spans the build, so resize it on rebuild
	_rebuild_wire_lines()

# ---------------------------------------------------------------------------
# Feature-edge overlay (outline / xray / wire)
#
# A single merged PRIMITIVE_LINES mesh covering the whole build, recomputed on every
# rebuild (full or incremental — any single cell's edit can change a neighbor's
# dedup, so there's no cheaper correct incremental path at this build size). No-ops
# immediately when the current mode doesn't use it.
#
# Edges are collected in WORLD space, keyed by their two rounded endpoints, each
# tagged with every face's world-space outward normal that touches it. An edge
# touched by exactly two faces with the same normal is an interior seam between two
# coplanar visible faces (a flat run of a mass, a strip lying on a cover) and is
# dropped; anything else — one face only (a silhouette boundary) or two differing
# normals (a real corner/crease) — is kept. `xray` skips the drop and keeps every
# edge ("all edges" per the design). Free-form mesh elements (architecture shapes:
# roof tiles, stairs, arches, …) are skipped for now — a known v1 gap, not a bug.
# ---------------------------------------------------------------------------

func _rebuild_wire_lines() -> void:
	var mode := str(render_options["mode"])
	if mode != "outline" and mode != "xray" and mode != "wire":
		_wire_mi.visible = false
		return
	_begin_source()
	_rebuild_wire_lines_inner(mode)
	_end_source()

func _rebuild_wire_lines_inner(mode: String) -> void:
	var edges := {}   # "x,y,z|x,y,z" -> {a: Vector3, b: Vector3, dirs: Array[Vector3], semantic: String}
	if _project():
		var data := _project().data
		for pos: Vector3i in data.cells.keys():
			var cell: BlockCell = data.cells[pos]
			var semantic: String = cell.type_id
			if semantic.is_empty() or _in_cut(pos):
				continue
			var center := Vector3(pos) + Vector3(0.5, 0.5, 0.5)
			if cell.is_shaped():
				for i in cell.parts.size():
					var part: Dictionary = cell.parts[i]
					var others := cell.parts.duplicate()
					others.remove_at(i)
					var m := VoxelWorld.get_part_model(part, others)
					if m != null:
						_accumulate_wire_edges(edges, m, Basis(), center, str(part.get("semantic", semantic)), null, pos)
			else:
				var resolved := _resolve_cell_parts(pos, cell, semantic)
				# Only a lone full-cube part is eligible for neighbor face culling: a rotated,
				# multipart or non-cube model's faces don't necessarily align with a neighbor's,
				# so they always draw in full (and lean on the dedup pass below instead).
				var simple := resolved.size() == 1 and _is_simple_full_cube(resolved[0]["model"]) \
					and (resolved[0]["basis"] as Basis).is_equal_approx(Basis())
				for p in resolved:
					_accumulate_wire_edges(edges, p["model"], p["basis"], center, semantic, data if simple else null, pos)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_LINES)
	var dedup := mode != "xray"
	var colored := mode != "outline"
	var any := false
	for key in edges:
		var e: Dictionary = edges[key]
		var dirs: Array = e["dirs"]
		if dedup and dirs.size() == 2 and (dirs[0] as Vector3).is_equal_approx(dirs[1]):
			continue
		st.set_color(intent_color(str(e["semantic"])) if colored else Color(0.05, 0.05, 0.05))
		st.add_vertex(e["a"])
		st.add_vertex(e["b"])
		any = true
	_wire_mi.mesh = st.commit() if any else null
	_wire_mi.material_override = _wire_material_for(mode)
	_wire_mi.visible = any

# All box-element edges of one rendered part (a plain block, a multipart side, or a shaped
# part), transformed into world space exactly like its triangle mesh (see BlockMesher.color_mesh
# + the mi.transform applied in _build_cell_node), and folded into `edges`. `data`/`pos` — only
# ever passed for a lone full-cube cell — enable neighbor face culling: without it, a face
# shared by two solid neighbors would still add its own two edges on top of the two the
# neighbor adds for the same seam, so a shared edge ends up touched 3-4 times instead of the
# clean 2 the dedup pass in _rebuild_wire_lines depends on.
func _accumulate_wire_edges(edges: Dictionary, model: BlockModel, basis: Basis, center: Vector3,
		semantic: String, data: VoxelData, pos: Vector3i) -> void:
	if model == null:
		return
	var recenter := Transform3D(Basis(), -Vector3(0.5, 0.5, 0.5))
	for element in model.elements:
		if element.has("mesh"):
			continue   # free-form (architecture) geometry: not covered in v1
		var from: Vector3 = element["from"]
		var to: Vector3 = element["to"]
		var xform := BlockMesher.element_xform(element)
		var nbasis := xform.basis.inverse().transposed()
		for dir in BlockMesher.DIR_NORMALS:
			if data != null and _neighbor_hides_face(data, pos, dir):
				continue
			var corners := BlockMesher.face_corners(dir, from, to)
			var world_corners: Array[Vector3] = []
			for c in corners:
				var local: Vector3 = recenter * (xform * (c as Vector3))
				world_corners.append(center + basis * (local * VOXEL_SCALE))
			var world_normal := (basis * (nbasis * (BlockMesher.DIR_NORMALS[dir] as Vector3))).normalized()
			for i in 4:
				_add_edge(edges, world_corners[i], world_corners[(i + 1) % 4], world_normal, semantic)

# A line sitting exactly on the triangle surface beneath it z-fights (flickers, fades at
# grazing angles) once depth test is on — visible in outline, which needs depth test for
# correct hidden-line removal. Nudging it off the surface along the first face normal that
# touches it (an edge's later touches, if any, only ever add a differing-normal crease, so the
# offset direction doesn't need to reconcile more than one) fixes it without being visible at
# normal viewing distances.
const _EDGE_OFFSET := 0.006

func _add_edge(edges: Dictionary, a: Vector3, b: Vector3, n: Vector3, semantic: String) -> void:
	var ka := "%.4f,%.4f,%.4f" % [a.x, a.y, a.z]
	var kb := "%.4f,%.4f,%.4f" % [b.x, b.y, b.z]
	var key := (ka + "|" + kb) if ka < kb else (kb + "|" + ka)
	if not edges.has(key):
		var off := n * _EDGE_OFFSET
		edges[key] = {"a": a + off, "b": b + off, "dirs": [], "semantic": semantic}
	(edges[key]["dirs"] as Array).append(n)

# True for a model that's exactly one axis-aligned, unrotated box spanning the whole cell —
# the shape whose silhouette is identical regardless of which semantic or block it renders,
# and the only shape _neighbor_hides_face can reason about without doing full mesh-overlap math.
func _is_simple_full_cube(model: BlockModel) -> bool:
	if model == null or model.elements.size() != 1:
		return false
	var el: Dictionary = model.elements[0]
	if el.has("mesh") or el.has("rotation"):
		return false
	var from: Vector3 = el.get("from", Vector3.ONE)
	var to: Vector3 = el.get("to", Vector3.ZERO)
	return from.is_equal_approx(Vector3.ZERO) and to.is_equal_approx(Vector3.ONE)

# Whether `pos`'s neighbor in `dir` is itself a lone, unrotated full cube — i.e. whether it
# fully covers the face `pos` shares with it, regardless of the two semantics involved (this
# is a structural/silhouette lens, not a material one). Conservative: a shaped, multipart,
# rotated or otherwise non-cube neighbor never hides a face, so real geometry is never lost.
func _neighbor_hides_face(data: VoxelData, pos: Vector3i, dir: int) -> bool:
	var npos := pos + Vector3i(BlockMesher.DIR_NORMALS[dir])
	var ncell: BlockCell = data.get_cell(npos)
	if ncell == null or ncell.type_id.is_empty() or ncell.is_shaped() or _in_cut(npos):
		return false
	var nparts := _resolve_cell_parts(npos, ncell, ncell.type_id)
	return nparts.size() == 1 and (nparts[0]["basis"] as Basis).is_equal_approx(Basis()) \
		and _is_simple_full_cube(nparts[0]["model"])

func _wire_material_for(mode: String) -> StandardMaterial3D:
	if _wire_mats.has(mode):
		return _wire_mats[mode]
	var mat := StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = mode != "outline"   # outline hides behind nearer geometry; xray/wire see through
	_wire_mats[mode] = mat
	return mat

# A cell resolves to one or more render parts (geometry + a model rotation). A plain
# block is a single part; a connecting/multipart block is its post plus a side part per
# connected neighbor. The uniform VOXEL_SCALE leaves full blocks filling their whole cell
# (no air gap); a plain cube at the default orientation reduces to identity·scale — a
# flush full-block render. Shared by the full rebuild loop above and _update_cell_node's
# single-cell incremental path, so both build identical nodes.
func _build_cell_node(pos: Vector3i, cell: BlockCell, semantic: String) -> Node3D:
	var center := Vector3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
	if cell.is_shaped():
		# Shaped parts (covers, strips, …): one child per part, each its generated model —
		# the part's own stored shape + slot, textured from whatever its semantic's base
		# currently maps to. Geometry is already in place within the cell, so no rotation.
		var holder := Node3D.new()
		holder.position = center
		for i in cell.parts.size():
			var part: Dictionary = cell.parts[i]
			var others := cell.parts.duplicate()
			others.remove_at(i)   # overlaps with these are trimmed away (no z-fighting)
			var pmi := MeshInstance3D.new()
			_apply_cell_appearance(pmi, str(part.get("semantic", "")), VoxelWorld.get_part_model(part, others))
			pmi.transform = Transform3D(Basis().scaled(Vector3.ONE * VOXEL_SCALE), Vector3.ZERO)
			holder.add_child(pmi)
		return holder
	var parts := _resolve_cell_parts(pos, cell, semantic)
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
			var m := _block_model_by_id(str(part.get("model_id", "")))
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
			var m := _block_model_by_id(str(entry.get("model_id", "")))
			if m != null:
				return [{"model": m, "basis": BlockMesher.rotation_basis(int(entry.get("x_rot", 0)), int(entry.get("y_rot", 0)))}]
	# Plain block (and the safety net if a state_map's model went missing): the
	# resolved model rotated by the cell's own orientation.
	return [{"model": _semantic_model(semantic), "basis": Orientation.basis_of(cell.orientation)}]

# Connection state per direction for a cell: "none" when the neighbor cell is empty,
# else the neighbor's connect-height classification ("low"/"tall", derived from its
# resolved model's geometry via VoxelWorld.get_connect_height_for_semantic). Keyed by
# BlockModel.Dir (0..5), matching the dirs the importer wrote into a part's `when`
# clauses. Computed fresh every rebuild from neighbor occupancy + shape — nothing
# about connections is ever stored on the cell (data stores intent only).
func _cell_connections(pos: Vector3i) -> Dictionary:
	var data := _project().data
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
	var mode := str(render_options["mode"])
	if mode == "wire":
		# Wire draws no fill at all — the feature-edge overlay (_wire_mi) is the whole picture.
		mi.mesh = null
		mi.set_meta("textured", false)
		return
	if mode == "xray":
		mi.mesh = _mesh_for_model(model)
		mi.material_override = _xray_material(semantic)
		mi.set_meta("textured", false)
		return
	if mode != "textured":
		# Intent / clay / outline lenses: the same geometry, one flat material per semantic (or
		# one for all), ignoring textures entirely. Outline's dark feature edges are drawn on
		# top by the _wire_mi overlay, so its fill is identical to clay's.
		mi.mesh = _mesh_for_model(model)
		mi.material_override = _mode_material(semantic)
		mi.set_meta("textured", false)
		return
	var resolved := _resolve_model_textures(model)
	if resolved.is_empty():
		mi.mesh = _mesh_for_model(model)
		mi.material_override = _color_material(semantic)
		mi.set_meta("textured", false)
		return
	var entry := _textured_mesh_for_model(model)
	mi.mesh = entry["mesh"]
	# The whole per-surface material list for this semantic + model, built once per rebuild
	# (like _surface_mats, which it's stored in) instead of re-keying every surface of every
	# cell — thousands of identical cells share it.
	var set_key := semantic + "||" + _model_key(model)
	var mats: Array = _surface_mats.get(set_key, [])
	if mats.is_empty():
		var keys: Array = entry["keys"]
		var tinted: Array = entry["tinted"]
		# The biome tint is per block type (semantic); WHITE leaves the surface as-is, so
		# the default/untinted build renders byte-for-byte as before.
		var tint: Color = VoxelWorld.get_tint_for_semantic(semantic)
		for i in keys.size():
			mats.append(_surface_material(semantic, model, keys[i], resolved, bool(tinted[i]), tint))
		_surface_mats[set_key] = mats
	for i in mats.size():
		mi.set_surface_override_material(i, mats[i])
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
		_clear_wand_box()
		_clear_shaped_preview()
		_highlight.visible = false
		_overlay.queue_redraw()
		return

	var result := _raycast_grid(_camera_pos, _get_look_dir(), 20.0)
	_target_hit = result.get("hit", false)
	_target_part = -1

	if _target_hit:
		_target_block = result.pos
		_target_place = result.prev_pos
		_target_point = result.get("point", Vector3(_target_block))
		_target_normal = result.get("normal", _target_place - _target_block)
		_target_part = int(result.get("part", -1))
		_highlight_mat.albedo_color = Color(1.0, 1.0, 1.0, 1.0)
		_highlight_mat.transparency = BaseMaterial3D.TRANSPARENCY_DISABLED
		if _target_part >= 0:
			# Outline the face of the part itself, not the whole cell.
			var part: Dictionary = VoxelWorld.active_project.data.get_cell(_target_block).parts[_target_part]
			var b := ShapeCatalog.bounds(str(part["shape"]), int(part["slot"]))
			_draw_face_highlight(_target_block, _target_normal, AABB(Vector3(_target_block) + b.position, b.size))
		else:
			_draw_face_highlight(_target_block, _target_place - _target_block)
		_highlight.visible = true
	else:
		var floor_result := _raycast_floor_plane(_camera_pos, _get_look_dir())
		_floor_hit = floor_result.get("hit", false)
		if _floor_hit:
			_floor_place = floor_result.pos
			_floor_point = floor_result.get("point", Vector3(_floor_place))
			_highlight_mat.albedo_color = Color(0.08, 0.75, 1.0, 0.22)
			_highlight_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			_draw_floor_fill(_floor_place)
			_highlight.visible = true
		else:
			_highlight.visible = false

	_overlay.queue_redraw()
	_refresh_ghost_preview()
	_refresh_shaped_preview()

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
#
# `box` (world space) overrides the bounds — used to outline a single shaped part's face.
func _draw_face_highlight(block: Vector3i, normal: Vector3i, box := AABB()) -> void:
	var n := Vector3(normal)
	var bbox := box if box.size != Vector3.ZERO else _cell_world_aabb(block)
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
		var cell := data.get_cell(cur)
		if cell != null and not _in_cut(cur):
			if cell.is_shaped():
				# A part cell only blocks the ray where a part actually is — the gaps around
				# a strip or through a hollow cover are see-through and clickable beyond.
				var ph := _raycast_parts(origin, dir, cur, cell)
				if not ph.is_empty():
					return {hit = true, pos = cur, prev_pos = prev, point = ph["point"],
						normal = ph["normal"], part = ph["part"]}
			else:
				return {hit = true, pos = cur, prev_pos = prev, point = origin + dir * t,
					normal = prev - cur, part = -1}
		prev = cur
		if tx <= ty and tx <= tz:
			t = tx; tx += dtx; ix += sx
		elif ty <= tz:
			t = ty; ty += dty; iy += sy
		else:
			t = tz; tz += dtz; iz += sz

	return {hit = false}

# The nearest shaped part of `cell` (at cell_pos) the ray hits: { point, normal, part } or {}.
func _raycast_parts(origin: Vector3, dir: Vector3, cell_pos: Vector3i, cell: BlockCell) -> Dictionary:
	var best := {}
	var best_t := INF
	for i in cell.parts.size():
		var part: Dictionary = cell.parts[i]
		for box in ShapeCatalog.boxes(str(part.get("shape", "")), int(part.get("slot", 0))):
			var hit := _ray_box(origin, dir, AABB(Vector3(cell_pos) + box.position, box.size))
			if not hit.is_empty() and float(hit["t"]) < best_t:
				best_t = hit["t"]
				best = {"point": origin + dir * best_t, "normal": hit["normal"], "part": i}
	return best

# Slab test: where a ray (unit `d`) enters `box`, as { t, normal } (the entered face's
# outward normal), or {} on a miss / when the origin is already inside.
static func _ray_box(o: Vector3, d: Vector3, box: AABB) -> Dictionary:
	var tmin := -INF
	var tmax := INF
	var n_axis := -1
	var n_sign := 0
	for a in 3:
		if absf(d[a]) < 1e-9:
			if o[a] < box.position[a] or o[a] > box.end[a]:
				return {}
			continue
		var t1: float = (box.position[a] - o[a]) / d[a]
		var t2: float = (box.end[a] - o[a]) / d[a]
		var sgn := -1                    # entering through the min face → normal is -axis
		if t1 > t2:
			var tmp := t1; t1 = t2; t2 = tmp
			sgn = 1
		if t1 > tmin:
			tmin = t1
			n_axis = a
			n_sign = sgn
		tmax = minf(tmax, t2)
		if tmin > tmax:
			return {}
	if n_axis < 0 or tmin < 0.0:
		return {}
	var n := Vector3i.ZERO
	n[n_axis] = n_sign
	return {"t": tmin, "normal": n}

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
	return {hit = true, pos = cell, point = hit_world}

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
		VoxelWorld.Tool.EXCHANGE:
			_exchange()
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
	var data := VoxelWorld.active_project.data
	var placed := VoxelWorld.selected_semantic
	var default_orient := _derive_place_orientation(block + normal, normal)
	# When both the placed block and the block it extends from are orientable, each new block
	# copies the orientation of its own contact block — the cell it sits against, one step back
	# along the face normal. So extending a run of mixed-orientation barrels keeps each barrel's
	# facing instead of stamping one derived orientation across the whole set.
	var placed_orientable := VoxelWorld.is_orientable_for_semantic(placed)
	VoxelWorld.begin_operation("Wand")
	for group in groups:
		for cell: Vector3i in group:
			var o := default_orient
			if placed_orientable:
				var src := data.get_cell(cell - normal)
				if src != null and VoxelWorld.is_orientable_for_semantic(src.type_id):
					o = src.orientation
			VoxelWorld.set_block(cell, placed, o)
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
# Exchange (flood-replace a same-type region in the clicked face's plane)
# ---------------------------------------------------------------------------

# "Exchange": right-click a block to replace it — and the connected run of same-type blocks
# coplanar with the clicked face, out to the brush radius — with the SELECTED block. Unlike the
# wand (which extends outward along the normal), this swaps the blocks in place. brush_size is
# the radius: 1 = just the clicked block, 2 = up to 3×3, etc., but always bounded to the
# connected same-type region (a 2×2 dirt patch in a stone wall replaces only those 4). One undo
# step.
func _exchange() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty() or not _target_hit:
		return
	var block := _target_block
	var normal := _target_place - _target_block
	var cells := _exchange_cells(block, normal)
	if cells.is_empty():
		return
	var placed := VoxelWorld.selected_semantic
	var orient := _derive_place_orientation(block, normal)
	VoxelWorld.begin_operation("Exchange")
	for cell: Vector3i in cells:
		VoxelWorld.set_block(cell, placed, orient)
	VoxelWorld.end_operation()
	_update_crosshair_target()

# The cells an exchange from (block, normal) would replace: flood-fill of same-type cells
# coplanar with the clicked face (4-connected in that plane), bounded to a Chebyshev radius of
# brush_size-1 from the clicked block. Pure computation — shared by the commit and the preview.
func _exchange_cells(block: Vector3i, normal: Vector3i) -> Array:
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
	var radius := maxi(VoxelWorld.brush_size - 1, 0)
	var visited := {block: true}
	var queue: Array = [block]
	var out: Array = [block]
	var head := 0
	while head < queue.size():
		var c: Vector3i = queue[head]
		head += 1
		for nd in neighbors:
			var nc: Vector3i = c + nd
			if visited.has(nc):
				continue
			if absi(nc[u] - block[u]) > radius or absi(nc[v] - block[v]) > radius:
				continue
			if data.get_block(nc) != semantic:
				continue
			visited[nc] = true
			queue.append(nc)
			out.append(nc)
	return out

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
		_clear_wand_box()
		_refresh_paste_ghost()
		return
	if not _fly_mode or not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty() \
			or VoxelWorld.is_shaped_semantic(VoxelWorld.selected_semantic):
		# (A shaped entry previews as a single part — _refresh_shaped_preview — and the
		# whole-cell tools below never place one.)
		_clear_ghost()
		_clear_wand_box()
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
		VoxelWorld.Tool.EXCHANGE:
			if _target_hit:
				groups = [_exchange_cells(_target_block, _target_place - _target_block)]
		_:
			_clear_ghost()
			_clear_wand_box()
			return
	var cells: Array = []
	for group in groups:
		cells.append_array(group)
	# The wand and exchange preview as per-block outlines (builders-wand style), not translucent
	# ghost blocks — a big flood of ghosts just reads as noise. Build-to-me keeps the ghost column.
	if VoxelWorld.active_tool == VoxelWorld.Tool.WAND or VoxelWorld.active_tool == VoxelWorld.Tool.EXCHANGE:
		_clear_ghost()
		_draw_wand_cells(cells)
		return
	_clear_wand_box()
	if cells.is_empty():
		_clear_ghost()
		return
	_ensure_ghost_mesh(VoxelWorld.selected_semantic)
	_set_ghost_cells(cells)

# Outline each cell the wand would fill with its own wireframe box (empty hides the overlay).
# One box per block rather than a single region bound, so you read exactly which cells get
# placed — the builders-wand look.
func _draw_wand_cells(cells: Array) -> void:
	if _wand_box == null:
		return
	var im := _wand_box.mesh as ImmediateMesh
	im.clear_surfaces()
	if cells.is_empty():
		_wand_box.visible = false
		return
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	var col := Color(0.55, 0.9, 1.0, 0.95)
	for c: Vector3i in cells:
		_draw_cell_wire(im, c, col, 1.0)
	im.surface_end()
	_wand_box.visible = true

func _clear_wand_box() -> void:
	if _wand_box == null or not _wand_box.visible:
		return
	(_wand_box.mesh as ImmediateMesh).clear_surfaces()
	_wand_box.visible = false

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

# ---------------------------------------------------------------------------
# Shaped parts: placement (Forge Microblocks' rules, via ShapePlacement), the placement
# grid drawn on the aimed face, and the part ghost.
# ---------------------------------------------------------------------------

# Whether the hand holds a shaped entry with the plain place tool. The whole-cell tools
# (build-to-me, wand, exchange) never place parts — VoxelWorld.set_block refuses shaped
# semantics — so they show no part preview either.
func _placing_shape() -> bool:
	if not _fly_mode or _paste_active or not VoxelWorld.active_project:
		return false
	match VoxelWorld.active_tool:
		VoxelWorld.Tool.BUILD_TO_ME, VoxelWorld.Tool.WAND, VoxelWorld.Tool.EXCHANGE, VoxelWorld.Tool.SELECT:
			return false
	return VoxelWorld.is_shaped_semantic(VoxelWorld.selected_semantic)

# The aimed face in ShapePlacement's terms: { cell, side, vhit, point }, or {}. Aiming at
# the ground plane counts as clicking the top face of the cell under the floor.
func _shaped_aim() -> Dictionary:
	if _target_hit:
		if _target_normal == Vector3i.ZERO:
			return {}
		return {"cell": _target_block, "side": ShapeCatalog.side_from_normal(Vector3(_target_normal)),
			"vhit": _target_point - Vector3(_target_block), "point": _target_point}
	if _floor_hit:
		var below := _floor_place + Vector3i(0, -1, 0)
		var p := Vector3(_floor_point.x, float(_floor_place.y), _floor_point.z)
		return {"cell": below, "side": 1, "vhit": p - Vector3(below), "point": p}
	return {}

func _alt_placement() -> bool:
	return _lctrl_held or _alt_mouse_held

func _shaped_placement(aim: Dictionary) -> Dictionary:
	if aim.is_empty():
		return {}
	var semantic := VoxelWorld.selected_semantic
	return ShapePlacement.resolve(semantic, VoxelWorld.get_shape_id_for_semantic(semantic),
		aim["cell"], aim["vhit"], aim["side"], _alt_placement())

func _refresh_shaped_preview() -> void:
	if not _placing_shape():
		_clear_shaped_preview()
		return
	var aim := _shaped_aim()
	if aim.is_empty():
		_clear_shaped_preview()
		return
	_draw_place_grid(VoxelWorld.get_shape_id_for_semantic(VoxelWorld.selected_semantic), aim)
	var placement := _shaped_placement(aim)
	if placement.is_empty():
		_part_ghost.visible = false   # nothing fits here: grid only, no ghost
		return
	var part: Dictionary = placement["part"]
	# Trimmed against what's already in the target cell, like the placed part will be.
	var target := VoxelWorld.active_project.data.get_cell(placement["pos"])
	var model := VoxelWorld.get_part_model(part, target.parts if target else [])
	var key := str(part["semantic"]) + "|" + _model_key(model)
	if key != _part_ghost_key:
		_part_ghost_key = key
		_part_ghost.mesh = _build_ghost_mesh(str(part["semantic"]), model)
	var pos: Vector3i = placement["pos"]
	_part_ghost.transform = Transform3D(Basis().scaled(Vector3.ONE * VOXEL_SCALE),
		Vector3(pos) + Vector3(0.5, 0.5, 0.5))
	_part_ghost.visible = true

func _clear_shaped_preview() -> void:
	if _place_grid != null and _place_grid.visible:
		(_place_grid.mesh as ImmediateMesh).clear_surfaces()
		_place_grid.visible = false
	if _part_ghost != null:
		_part_ghost.visible = false

# The shape family's placement zones drawn across the aimed cell face, at the hit's depth,
# so you can see which zone picks which slot (Forge Microblocks' grid overlay).
func _draw_place_grid(shape_id: String, aim: Dictionary) -> void:
	var lines := ShapeCatalog.grid_lines(shape_id)
	if lines.is_empty():
		# Architecture shapes have no zones — just the ghost.
		(_place_grid.mesh as ImmediateMesh).clear_surfaces()
		_place_grid.visible = false
		return
	var side: int = aim["side"]
	var cell: Vector3i = aim["cell"]
	var point: Vector3 = aim["point"]
	var n: Vector3 = ShapeCatalog.SIDE_VECS[side]
	var u_axis: Vector3 = ShapeCatalog.SIDE_VECS[(side + 2) % 6]
	var v_axis: Vector3 = ShapeCatalog.SIDE_VECS[(side + 4) % 6]
	var center := Vector3(cell) + Vector3(0.5, 0.5, 0.5)
	var comp := 0 if absf(n.x) > 0.5 else (1 if absf(n.y) > 0.5 else 2)
	center[comp] = point[comp]
	center += n * 0.004   # just off the surface so it doesn't z-fight
	var im := _place_grid.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for seg in lines:
		for p2: Vector2 in seg:
			im.surface_add_vertex(center + u_axis * p2.x + v_axis * p2.y)
	im.surface_end()
	_place_grid.visible = true

func _place_shaped_part() -> void:
	var placement := _shaped_placement(_shaped_aim())
	if placement.is_empty():
		return
	VoxelWorld.begin_operation("Place")
	VoxelWorld.add_part(placement["pos"], placement["part"])
	VoxelWorld.end_operation()
	_update_crosshair_target()

func _place_targeted_block() -> void:
	if not VoxelWorld.active_project or VoxelWorld.selected_semantic.is_empty():
		return
	if VoxelWorld.is_shaped_semantic(VoxelWorld.selected_semantic):
		_place_shaped_part()
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
	# The ray may have passed through the open part of a part cell on its way to the target;
	# a whole block never overwrites that.
	if VoxelWorld.active_project.data.get_cell(place_pos) != null:
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
	var prof := VoxelWorld.orientation_profile_for_semantic(VoxelWorld.selected_semantic)
	if prof["mode"] == "full":
		if not prof.get("directional", true):
			# Non-directional cube (plain FULL block, no facing data): keep its model faces
			# bound to world axes so per-face textures never rotate by how it was placed.
			return Orientation.make(Orientation.Facing.NORTH)
		var n := face_normal
		if prof["into_surface"]:
			# Hopper-style: its spout feeds the block it's attached to, so it faces INTO the
			# clicked surface — the opposite way a barrel/dispenser (which faces out) does.
			n = -n
		return Orientation.make(Orientation.from_normal(n))
	# Horizontal schemes. Only "horizontal_half" (stairs/slabs) ever takes a top/bottom half; a
	# plain horizontal block (chest, furnace) stays bottom-half so it can never be flipped over.
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
	# Stairs/slabs (horizontal_half) face the way the player is LOOKING (away from them), so a
	# stair's stepped side ends up toward the player — matching Minecraft. A plain horizontal
	# block (chest, furnace) faces the player instead. (Slabs are facing-agnostic, so their flip
	# is invisible; this is really the stairs fix.)
	var facing := Orientation.from_dir(horiz if prof["mode"] == "horizontal" else -horiz)
	var top := false
	if prof["mode"] == "horizontal_half":
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
	if _target_part >= 0:
		VoxelWorld.remove_part(_target_block, _target_part)   # just the aimed piece
	else:
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
		if _target_part >= 0 and _target_part < cell.parts.size():
			VoxelWorld.pick_block(str(cell.parts[_target_part]["semantic"]))
		else:
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
	if cell == null or cell.is_shaped():
		return   # rotating shaped parts is a later iteration (see .plans/shaped-parts.md)
	var normal := _target_place - _target_block  # face pointing toward the camera
	var steps := -1 if reverse else 1
	var o := cell.orientation
	var prof := VoxelWorld.orientation_profile_for_semantic(cell.type_id)
	var normal_vertical := absi(normal.y) >= absi(normal.x) and absi(normal.y) >= absi(normal.z)
	if prof["mode"] == "full":
		o = Orientation.rotate_around_axis(o, Orientation.dominant_axis(normal), steps)
	elif prof["mode"] == "horizontal_half" and not normal_vertical:
		o = Orientation.toggle_top(o)         # side face flips stairs/slabs upside-down
	else:
		o = Orientation.rotate_cw(o, steps)   # cycle the 4 horizontal facings (never top-flip)
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
	# Only show the selection highlight while the Select tool is active — the selection state
	# persists under other tools (for copy/paste/DELETE), it's just not drawn.
	if VoxelWorld.active_tool != VoxelWorld.Tool.SELECT:
		_sel_box.visible = false
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
#   M     — mirror (east-west flip, after the turn)
#   Esc   — cancel outright, flying or not; never a "back out one level" step, so it can't be
#           pressed by reflex while reaching for the popup and lose the whole paste
# Entering/exiting never touches VoxelWorld.active_tool — this is purely a View3D-local modal
# layered over whatever tool/fly state was already active. The same modal places a prefab
# (VoxelWorld.request_prefab_paste): only the source cells and the anchor differ.
# ---------------------------------------------------------------------------

func _enter_paste_mode(prefab: Prefab = null) -> void:
	if not VoxelWorld.active_project or (prefab == null and not VoxelWorld.has_clipboard()):
		return
	_paste_prefab = prefab
	_paste_active = true
	_paste_offset = Vector3i.ZERO
	_paste_rotation = 0
	_paste_mirror = false
	_paste_locked = false
	if _paste_panel != null:
		_paste_panel.set_title("Place: " + prefab.name if prefab != null else "Paste")
	if not _fly_mode:
		_capture_cursor()  # also refreshes the crosshair aim + ghost
	else:
		_update_crosshair_target()
	_update_tool_overlay_visibility()
	_overlay.visible = true
	_overlay.queue_redraw()

# The inventory picked a prefab: the focused 3D view places it. With a 2D view focused, the
# first 3D view on screen takes it (and focus), so picking one never silently does nothing.
func _on_prefab_paste_requested(prefab: Prefab) -> void:
	if offscreen or source_project != null or not is_visible_in_tree():
		return
	if not _active:
		var sh := _shell()
		if sh == null or sh.focused_view() is View3D:
			return
		for v in sh.all_views():
			if v is View3D and sh.is_view_shown(v) and not (v as View3D).offscreen:
				if v != self:
					return
				break
		focus_requested.emit()
		if not _active:
			return
	if _paste_active:
		_cancel_paste()
	_enter_paste_mode(prefab)

func _shell() -> MultiViewShell:
	var host: Node = get_parent()
	while host != null and not (host is MultiViewShell):
		host = host.get_parent()
	return host as MultiViewShell

func _cancel_paste() -> void:
	if not _paste_active:
		return
	_paste_active = false
	_paste_prefab = null
	_clear_paste_ghost()
	_update_tool_overlay_visibility()
	_overlay.queue_redraw()

func _toggle_paste_mirror() -> void:
	_paste_mirror = not _paste_mirror
	_refresh_ghost_preview()
	_overlay.queue_redraw()

# --- Paste source: the clipboard or a prefab, and how it's turned -----------------------

func _paste_cells() -> Dictionary:
	return _paste_prefab.data.cells if _paste_prefab != null else VoxelWorld.clipboard_cells()

func _paste_box_size() -> Vector3i:
	return _paste_prefab.size if _paste_prefab != null else VoxelWorld.clipboard_size()

# The source cell that lands on the aimed cell (and that turns pivot about).
func _paste_handle() -> Vector3i:
	return _paste_prefab.anchor if _paste_prefab != null else Vector3i.ZERO

func _paste_basis() -> Basis:
	return RegionOps.turn_basis(_paste_rotation, "x" if _paste_mirror else "")

func _paste_xform() -> SpatialXform:
	return SpatialXform.about(_paste_basis(), Vector3.ZERO)

# Place the source at the current aim/offset/turn, skipping any cell that's already occupied
# (never overwrite), as one undo step. A prefab using semantics this project's palettes don't
# have first asks whether to add the prefab's palettes that define them (bottom of the stack).
# No-op if nothing is aimed at.
func _commit_paste() -> void:
	if not _paste_active or _paste_asking:
		return
	var anchor = _paste_anchor()
	if anchor == null:
		_finish_paste()
		return
	if _paste_prefab != null:
		var m := VoxelWorld.prefab_missing(_paste_prefab, VoxelWorld.active_project)
		if not (m["palettes"] as Array).is_empty():
			_ask_prefab_palettes(m, anchor)
			return
	_place_paste(anchor)

# The yes/no before placing a prefab whose semantics this project doesn't map. Yes adds the
# palettes then places; No places anyway (those cells render undecided); closing the dialog
# cancels this placement and leaves the paste live to try again.
func _ask_prefab_palettes(missing: Dictionary, anchor: Vector3i) -> void:
	_paste_asking = true
	set_input_suspended(true)
	var names: Array = missing["palettes"]
	var n := (missing["missing"] as Array).size()
	var d := AcceptDialog.new()
	d.title = "Missing palettes"
	d.dialog_text = "\"%s\" uses %d semantic%s this project doesn't map (%s).\nAdd palette%s %s to the bottom of this project's stack?" % [
		_paste_prefab.name, n, "" if n == 1 else "s", ", ".join(missing["missing"]),
		"" if names.size() == 1 else "s", ", ".join(names.map(func(x: String) -> String: return "\"%s\"" % x))]
	d.ok_button_text = "Yes"
	d.add_button("No", true, "no")
	var done := func(place: bool, add: bool) -> void:
		d.queue_free()
		_paste_asking = false
		if add:
			VoxelWorld.add_prefab_palettes(VoxelWorld.active_project, names)
		if place and _paste_active:
			_place_paste(anchor)
		set_input_suspended(false)
	d.confirmed.connect(func(): done.call(true, true))
	d.custom_action.connect(func(_a: StringName): done.call(true, false))
	d.canceled.connect(func(): done.call(false, false))
	add_child(d)
	d.popup_centered()

func _place_paste(anchor: Vector3i) -> void:
	var targets := _paste_targets(anchor)
	if not targets.is_empty():
		var t := _paste_xform()
		var cells := _paste_cells()
		VoxelWorld.begin_operation("Place " + _paste_prefab.name if _paste_prefab != null else "Paste")
		for pos: Vector3i in targets:
			var cell := t.apply_cell(cells[targets[pos]])
			if cell != null:   # a chiral part with no mirror image is left out
				VoxelWorld.set_cell(pos, cell)
		VoxelWorld.end_operation()
		_animate_placement(_group_by_distance(targets.keys(), anchor))
	_finish_paste()

func _finish_paste() -> void:
	_paste_active = false
	_paste_prefab = null
	_clear_paste_ghost()
	_update_tool_overlay_visibility()
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
	var t := _paste_xform()
	var handle := _paste_handle()
	var out := {}
	for rel: Vector3i in _paste_cells():
		var pos := anchor + t.apply_pos(rel - handle)
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
	var cells := _paste_cells()
	var t := _paste_xform()
	var by_semantic := {}   # semantic -> Array[{"pos": Vector3i, "o": int}]
	for pos: Vector3i in targets:
		var src: BlockCell = cells[targets[pos]]
		var o := t.apply_orientation(src.orientation)
		if not by_semantic.has(src.type_id):
			by_semantic[src.type_id] = []
		by_semantic[src.type_id].append({"pos": pos, "o": o})
	_set_paste_ghost_groups(by_semantic)

# The [min, max] inclusive world bounds the pasted box would occupy at `anchor`, current turn
# and mirror. An axis-aligned map only swaps/negates axes, so mapping the box's two extreme
# corners and taking their component-wise min/max is exactly the moved box.
func _paste_bounds(anchor: Vector3i) -> Array:
	var t := _paste_xform()
	var handle := _paste_handle()
	var c0 := t.apply_pos(Vector3i.ZERO - handle)
	var c1 := t.apply_pos(_paste_box_size() - Vector3i.ONE - handle)
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
# Tool overlays — the shared middle-click panel system (see the field block near the top).
#
# Registration pairs a ToolOverlayPanel (the card framing) with a refresh Callable under an
# id, and maps any Tool enum values that should summon it. The paste modal registers one too,
# keyed off _paste_active rather than a tool. Everything down to the "Paste overlay content"
# header is generic; the per-tool rows live in the _build_*/_refresh_* helpers below it.
# ---------------------------------------------------------------------------

func _setup_tool_overlays() -> void:
	_register_tool_overlay(_PASTE_OVERLAY, _build_paste_overlay(), _update_paste_offset_labels)
	_selection_overlay = _build_selection_overlay()
	_register_tool_overlay(_SELECTION_OVERLAY, _selection_overlay, _refresh_selection_overlay,
		[VoxelWorld.Tool.SELECT])
	var cut_panel := _build_cutaway_overlay()
	_register_tool_overlay(_CUTAWAY_OVERLAY, cut_panel, _update_cutaway_panel)

func _register_tool_overlay(id: String, panel: ToolOverlayPanel, refresh: Callable,
		tools: Array = []) -> void:
	panel.close_requested.connect(_close_tool_overlay)
	add_child(panel)
	# reset_size() gives the free-floating panel its real min size once, so it's never a
	# zero-size unclickable rect; _position_tool_overlay re-fits it each time it's shown.
	panel.reset_size()
	_tool_overlays[id] = {"panel": panel, "refresh": refresh}
	for tool in tools:
		_tool_overlay_ids[tool] = id

# The overlay that should be VISIBLE right now, or "" — panels only show while the cursor is
# free (never over a captured fly view). Paste (a modal) wins; otherwise it's the active
# tool's overlay, but only once deliberately summoned via MMB (_tool_overlay_open).
func _visible_overlay_id() -> String:
	if _fly_mode:
		return ""
	if _paste_active:
		return _PASTE_OVERLAY
	if _cutaway_panel_open:
		return _CUTAWAY_OVERLAY
	if _tool_overlay_open:
		return _tool_overlay_ids.get(VoxelWorld.active_tool, "")
	return ""

# Show exactly the resolved overlay (refreshing + re-fitting it first) and hide the rest.
func _update_tool_overlay_visibility() -> void:
	var id := _visible_overlay_id()
	for oid in _tool_overlays:
		var entry: Dictionary = _tool_overlays[oid]
		var panel: ToolOverlayPanel = entry["panel"]
		if oid == id:
			(entry["refresh"] as Callable).call()
			_position_tool_overlay(panel)
			panel.visible = true
		else:
			panel.visible = false

# MMB in fly mode when the active tool/modal offers an overlay: free the cursor so its
# controls are clickable. _release_cursor keeps the panel up because _tool_overlay_open is
# now set (or _paste_active is), instead of doing the full Esc-style teardown.
func _open_tool_overlay() -> void:
	_tool_overlay_open = true
	_release_cursor()

# MMB/click while an overlay is up: re-capture the cursor, which hides the panel and (for a
# tool overlay) drops back into flying right where you left off.
func _close_tool_overlay() -> void:
	_capture_cursor()

# Close an open tool overlay if one is showing (e.g. the tool changed out from under it).
# No-op for the paste modal, whose panel is torn down through _cancel_paste/_commit_paste.
func _close_tool_overlay_if_open() -> void:
	if _tool_overlay_open:
		_tool_overlay_open = false
		if not _fly_mode:
			_update_tool_overlay_visibility()

# Bottom-center of the whole multi-pane workspace, not this specific pane — so an overlay
# stays put regardless of which pane/view summoned it, and doesn't get clipped sitting flush
# against a pane's own edge (which can be the window edge in single-pane view).
func _position_tool_overlay(panel: Control) -> void:
	panel.reset_size()  # re-fit: a rebuilt list (e.g. selection counts) changes the size
	var rect := _workspace_rect()
	var sz := panel.size
	panel.global_position = Vector2(
		rect.position.x + (rect.size.x - sz.x) * 0.5,
		rect.position.y + rect.size.y - sz.y - 16.0)

# Walk up to the shared MultiViewShell (every pane lives under one) for its global rect;
# falls back to the window if one somehow can't be found.
func _workspace_rect() -> Rect2:
	var host: Node = self
	while host != null and not (host is MultiViewShell):
		host = host.get_parent()
	if host is Control:
		return (host as Control).get_global_rect()
	return get_viewport().get_visible_rect()

# ---------------------------------------------------------------------------
# Paste overlay content — offset nudgers, rotate, place/cancel. Only these rows are paste-
# specific; the framing and open/close mechanism are shared above.
# ---------------------------------------------------------------------------

func _build_paste_overlay() -> ToolOverlayPanel:
	var panel := ToolOverlayPanel.new("Paste")
	_paste_panel = panel
	var content := panel.content

	for axis in ["x", "y", "z"]:
		content.add_child(_build_axis_row(axis))

	var turn_row := HBoxContainer.new()
	turn_row.add_theme_constant_override("separation", 8)
	content.add_child(turn_row)
	var rotate_btn := Button.new()
	rotate_btn.text = "Rotate 90° (R)"
	rotate_btn.focus_mode = Control.FOCUS_NONE
	rotate_btn.custom_minimum_size = Vector2(0, 40)
	rotate_btn.add_theme_font_size_override("font_size", 16)
	rotate_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rotate_btn.pressed.connect(func():
		_paste_rotation = (_paste_rotation + 1) % 4
		_refresh_ghost_preview()
		_update_paste_offset_labels())
	turn_row.add_child(rotate_btn)
	var mirror_btn := Button.new()
	mirror_btn.text = "Mirror (M)"
	mirror_btn.tooltip_text = "Flip east-west (after the turn)"
	mirror_btn.focus_mode = Control.FOCUS_NONE
	mirror_btn.custom_minimum_size = Vector2(0, 40)
	mirror_btn.add_theme_font_size_override("font_size", 16)
	mirror_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	mirror_btn.pressed.connect(_toggle_paste_mirror)
	turn_row.add_child(mirror_btn)

	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 8)
	content.add_child(buttons)
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
	return panel

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

# ---------------------------------------------------------------------------
# Selection overlay content — the Select tool's read-out: the region's dimensions and a
# per-semantic block tally (air included). Both the region and its contents change freely,
# so the list is rebuilt wholesale on each refresh; the framing/open/close are shared above.
# ---------------------------------------------------------------------------

func _build_selection_overlay() -> ToolOverlayPanel:
	# Rows depend on the live selection, so the card starts as just its frame; the content is
	# filled in by _refresh_selection_overlay whenever MMB on the Select tool summons it.
	return ToolOverlayPanel.new("Selection")

func _refresh_selection_overlay() -> void:
	var content := _selection_overlay.content
	for child in content.get_children():
		content.remove_child(child)
		child.queue_free()
	var stats := _selection_stats()
	if stats.is_empty():
		content.add_child(_overlay_note(
			"No region selected.\nRight-click two corners with the Select tool."))
		return
	var dims: Vector3i = stats["size"]
	content.add_child(_overlay_note("%d × %d × %d  ·  %s cells" % [
		dims.x, dims.y, dims.z, _grouped(stats["total"])]))
	content.add_child(HSeparator.new())
	# Occupied semantics first (busiest first), then air — so the eye lands on what's built.
	var counts: Dictionary = stats["counts"]
	var semantics := counts.keys()
	semantics.sort_custom(func(a, b):
		return counts[a] > counts[b] if counts[a] != counts[b] else a < b)
	for semantic: String in semantics:
		content.add_child(_selection_count_row(
			VoxelWorld.get_color_for_semantic(semantic), semantic, counts[semantic]))
	# Air last, with a hollow swatch — it's a tally of what's NOT there, not a block type.
	content.add_child(_selection_count_row(Color.TRANSPARENT, "Air", stats["air"], true))
	content.add_child(HSeparator.new())
	var cut_btn := _overlay_button("Cut away this region")
	cut_btn.tooltip_text = "Hide these cells in the 3D views so you can see and build inside"
	cut_btn.pressed.connect(func():
		VoxelWorld.set_cutaway(VoxelWorld.selection_min, VoxelWorld.selection_max)
		open_cutaway_panel())
	content.add_child(cut_btn)
	var prefab_btn := _overlay_button("Save as prefab…  (Ctrl+P)")
	prefab_btn.tooltip_text = "Keep this region as a named prefab you can place again in any project"
	prefab_btn.pressed.connect(func(): SaveRegionDialog.open(self))
	content.add_child(prefab_btn)
	var export_btn := _overlay_button("Export to Schematica…")
	export_btn.tooltip_text = "Write this region out as a real .schematic file (blocks/parts with a confirmed Minecraft identity only)"
	export_btn.pressed.connect(func(): SaveRegionDialog.open_export_region(self))
	content.add_child(export_btn)
	# Bounds last: the panel grows upward from the bottom edge, so these rows stay under the
	# pointer while the counts above change with every nudge.
	content.add_child(HSeparator.new())
	var hint := _overlay_note("Move each face of the box.  Shift+click: 5 cells")
	hint.add_theme_font_size_override("font_size", 13)
	hint.add_theme_color_override("font_color", Color(0.72, 0.76, 0.84))
	content.add_child(hint)
	for axis in 3:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 4)
		var label := Label.new()
		label.text = (["X", "Y", "Z"] as Array)[axis] + ":"
		label.add_theme_font_size_override("font_size", 16)
		label.custom_minimum_size = Vector2(22, 0)
		row.add_child(label)
		for max_side in [false, true]:
			if max_side:
				var dash := Label.new()
				dash.text = "to"
				dash.add_theme_color_override("font_color", Color(0.72, 0.76, 0.84))
				row.add_child(dash)
			row.add_child(_sel_nudge_button("-", axis, max_side, -1))
			var value := Label.new()
			value.text = str((VoxelWorld.selection_max if max_side else VoxelWorld.selection_min)[axis])
			value.add_theme_font_size_override("font_size", 16)
			value.custom_minimum_size = Vector2(48, 0)
			value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			row.add_child(value)
			row.add_child(_sel_nudge_button("+", axis, max_side, 1))
		content.add_child(row)

func _sel_nudge_button(text: String, axis: int, max_side: bool, dir: int) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(34, 34)
	b.add_theme_font_size_override("font_size", 18)
	b.pressed.connect(func():
		var step := 5 if Input.is_key_pressed(KEY_SHIFT) else 1
		# Deferred: the nudge rebuilds this panel, which must not free the button mid-click.
		VoxelWorld.nudge_selection_face.call_deferred(axis, max_side, dir * step))
	return b

# One "[swatch] name … count" row. `hollow` dims the text and outlines the swatch (used for
# the air row) so the count of empty cells reads as distinct from the placed block types.
func _selection_count_row(fill: Color, label_text: String, count: int, hollow := false) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	row.add_child(_overlay_swatch(fill, hollow))
	var name_label := Label.new()
	name_label.text = label_text
	name_label.add_theme_font_size_override("font_size", 15)
	name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(name_label)
	var count_label := Label.new()
	count_label.text = _grouped(count)
	count_label.add_theme_font_size_override("font_size", 15)
	count_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	row.add_child(count_label)
	if hollow:
		var dim := Color(0.72, 0.76, 0.84)
		name_label.add_theme_color_override("font_color", dim)
		count_label.add_theme_color_override("font_color", dim)
	return row

# A 16px palette-color chip. Hollow (air) draws a faint outline over nothing instead of a
# fill — the color is read live from the palette (Principle 3), never stored in the data.
func _overlay_swatch(fill: Color, hollow: bool) -> Panel:
	var box := Panel.new()
	box.custom_minimum_size = Vector2(16, 16)
	var sb := StyleBoxFlat.new()
	if hollow:
		sb.bg_color = Color.TRANSPARENT
		sb.border_color = Color(0.5, 0.55, 0.62)
		sb.set_border_width_all(1)
	else:
		sb.bg_color = fill
	sb.set_corner_radius_all(3)
	box.add_theme_stylebox_override("panel", sb)
	return box

func _overlay_note(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 15)
	return label

# Dimensions + a semantic→count tally for the current region (air = volume − occupied), or
# {} when there's no completed selection. Iterates the placed cells and tests membership
# rather than walking the region volume (which can be millions of cells): the same tack
# VoxelProject.semantic_counts takes, bounded by the project's block count, not the box size.
func _selection_stats() -> Dictionary:
	if not VoxelWorld.has_selection or not VoxelWorld.active_project:
		return {}
	var box := VoxelWorld.selection_box()
	if box.is_empty():
		return {}
	var lo: Vector3i = box[0]
	var hi: Vector3i = box[1]
	var dims := hi - lo + Vector3i.ONE
	var total := dims.x * dims.y * dims.z
	var counts := {}
	var occupied := 0
	for pos: Vector3i in VoxelWorld.active_project.data.cells:
		if pos.x < lo.x or pos.x > hi.x or pos.y < lo.y or pos.y > hi.y \
				or pos.z < lo.z or pos.z > hi.z:
			continue
		var cell: BlockCell = VoxelWorld.active_project.data.cells[pos]
		counts[cell.type_id] = counts.get(cell.type_id, 0) + 1
		occupied += 1
	return {"size": dims, "total": total, "counts": counts, "air": total - occupied}

# Thousands-grouped string for the read-out — a region can span millions of cells.
func _grouped(n: int) -> String:
	var s := str(absi(n))
	var out := ""
	var c := 0
	for i in range(s.length() - 1, -1, -1):
		out = s[i] + out
		c += 1
		if c % 3 == 0 and i > 0:
			out = "," + out
	return ("-" if n < 0 else "") + out

# ---------------------------------------------------------------------------
# Cutaway — hide a box of cells to see and build inside (VoxelWorld owns the box; see
# set_cutaway there). Nodes inside it are simply made invisible, so switching it on/off or
# nudging a face never rebuilds geometry; the raycast and the wire overlay skip them too.
# ---------------------------------------------------------------------------

# The capture view's own cutaway: a [min, max] box, [] for none, or null to follow the user's.
func set_cutaway_override(box: Variant) -> void:
	_cut_override = box
	_refresh_cutaway()

func _wanted_cut_box() -> Array:
	if _cut_override != null:
		return _cut_override
	return VoxelWorld.cutaway_box()

func _in_cut(pos: Vector3i) -> bool:
	if _cut_box.is_empty():
		return false
	var lo: Vector3i = _cut_box[0]
	var hi: Vector3i = _cut_box[1]
	return pos.x >= lo.x and pos.x <= hi.x and pos.y >= lo.y and pos.y <= hi.y \
		and pos.z >= lo.z and pos.z <= hi.z

# Re-apply the cutaway after it changed: only nodes whose inside/outside state can have
# flipped are touched — those in the old or new box, walked by volume when that's smaller
# than the node count (a face nudge on a small cut), else by scanning every node.
func _refresh_cutaway() -> void:
	var old := _cut_box
	var new_box := _wanted_cut_box()
	if old == new_box:
		_update_cut_frame()
		_update_cutaway_panel()
		return
	_cut_box = new_box
	var vol := 0
	for b in [old, new_box]:
		if not b.is_empty():
			var d: Vector3i = (b[1] as Vector3i) - (b[0] as Vector3i) + Vector3i.ONE
			vol += d.x * d.y * d.z
	if vol < _cell_nodes.size():
		for b in [old, new_box]:
			if b.is_empty():
				continue
			var lo: Vector3i = b[0]
			var hi: Vector3i = b[1]
			for x in range(lo.x, hi.x + 1):
				for y in range(lo.y, hi.y + 1):
					for z in range(lo.z, hi.z + 1):
						var node = _cell_nodes.get(Vector3i(x, y, z))
						if node != null:
							(node as Node3D).visible = not _in_cut(Vector3i(x, y, z))
	else:
		for pos: Vector3i in _cell_nodes:
			(_cell_nodes[pos] as Node3D).visible = not _in_cut(pos)
	_rebuild_wire_lines()
	_update_cut_frame()
	_update_cutaway_panel()
	if _target_hit or _fly_mode:
		_update_crosshair_target()
	if _overlay:
		_overlay.queue_redraw()

# Show the cutaway panel (from the selection overlay or the toolbar). Frees the cursor so its
# buttons are clickable; recapturing it (MMB, a click on the view, Done) hides it again.
func open_cutaway_panel() -> void:
	if not VoxelWorld.has_cutaway or offscreen:
		return
	_tool_overlay_open = false
	_cutaway_panel_open = true
	if _fly_mode:
		_release_cursor()
	else:
		_update_tool_overlay_visibility()
	_update_cut_frame()

# Toolbar shortcut: cut away everything above the camera over the whole build, the quick
# "lift the roof off" section. The box starts one cell above eye level.
func cut_above_camera() -> void:
	if not VoxelWorld.active_project:
		return
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if aabb.is_empty():
		return
	var lo: Vector3i = aabb[0]
	var hi: Vector3i = aabb[1]
	var y := clampi(int(floor(_camera_pos.y)) + 1, lo.y, hi.y)
	VoxelWorld.set_cutaway(Vector3i(lo.x - 1, y, lo.z - 1), Vector3i(hi.x + 1, hi.y + 1, hi.z + 1))

func _update_cut_frame() -> void:
	if _cut_frame == null:
		return
	var shown := _cutaway_panel_open and VoxelWorld.has_cutaway
	_cut_frame.visible = shown
	if not shown:
		return
	var lo := Vector3(VoxelWorld.cutaway_min)
	var hi := Vector3(VoxelWorld.cutaway_max) + Vector3.ONE
	var im := _cut_frame.mesh as ImmediateMesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for a in 3:
		var b := (a + 1) % 3
		var c := (a + 2) % 3
		for i in 4:
			var p := lo
			p[b] = hi[b] if i & 1 else lo[b]
			p[c] = hi[c] if i & 2 else lo[c]
			var q := p
			q[a] = hi[a]
			im.surface_add_vertex(p)
			im.surface_add_vertex(q)
	im.surface_end()

# Panel: per axis, the min face and the max face each with -/+ (Shift = 5 cells), like the
# paste offset rows; then Show/Hide, Clear and Done.
func _build_cutaway_overlay() -> ToolOverlayPanel:
	var panel := ToolOverlayPanel.new("Cutaway")
	var content := panel.content
	var hint := _overlay_note("Move each face of the cut box.  Shift+click: 5 cells")
	hint.add_theme_font_size_override("font_size", 13)
	hint.add_theme_color_override("font_color", Color(0.72, 0.76, 0.84))
	content.add_child(hint)
	for axis in 3:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 4)
		var label := Label.new()
		label.text = (["X", "Y", "Z"] as Array)[axis] + ":"
		label.add_theme_font_size_override("font_size", 16)
		label.custom_minimum_size = Vector2(22, 0)
		row.add_child(label)
		for max_side in [false, true]:
			if max_side:
				var dash := Label.new()
				dash.text = "to"
				dash.add_theme_color_override("font_color", Color(0.72, 0.76, 0.84))
				row.add_child(dash)
			row.add_child(_cut_nudge_button("-", axis, max_side, -1))
			var value := Label.new()
			value.add_theme_font_size_override("font_size", 16)
			value.custom_minimum_size = Vector2(48, 0)
			value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			row.add_child(value)
			_cut_value_labels["%d%d" % [axis, int(max_side)]] = value
			row.add_child(_cut_nudge_button("+", axis, max_side, 1))
		content.add_child(row)
	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 8)
	content.add_child(buttons)
	_cut_toggle_btn = _overlay_button("Show all")
	_cut_toggle_btn.tooltip_text = "Switch the cutaway off and on (H / End while flying)"
	_cut_toggle_btn.pressed.connect(func(): VoxelWorld.set_cutaway_enabled(not VoxelWorld.cutaway_enabled))
	buttons.add_child(_cut_toggle_btn)
	var clear_btn := _overlay_button("Clear")
	clear_btn.tooltip_text = "Forget the cut box"
	clear_btn.pressed.connect(func():
		VoxelWorld.clear_cutaway()
		_close_cutaway_panel())
	buttons.add_child(clear_btn)
	var done_btn := _overlay_button("Done")
	done_btn.pressed.connect(_close_cutaway_panel)
	buttons.add_child(done_btn)
	return panel

# Hide the panel but stay where you are (orbiting, or with the cursor free); a click on the
# view resumes flying as usual. MMB on the panel instead goes straight back to flying.
func _close_cutaway_panel() -> void:
	_cutaway_panel_open = false
	_update_cut_frame()
	_update_tool_overlay_visibility()

func _cut_nudge_button(text: String, axis: int, max_side: bool, dir: int) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(34, 34)
	b.add_theme_font_size_override("font_size", 18)
	b.pressed.connect(func():
		var step := 5 if Input.is_key_pressed(KEY_SHIFT) else 1
		VoxelWorld.nudge_cutaway_face(axis, max_side, dir * step))
	return b

func _overlay_button(text: String) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(0, 38)
	b.add_theme_font_size_override("font_size", 15)
	b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	return b

func _update_cutaway_panel() -> void:
	if _cut_value_labels.is_empty():
		return
	for axis in 3:
		(_cut_value_labels["%d0" % axis] as Label).text = str(VoxelWorld.cutaway_min[axis])
		(_cut_value_labels["%d1" % axis] as Label).text = str(VoxelWorld.cutaway_max[axis])
	_cut_toggle_btn.text = "Show all" if VoxelWorld.cutaway_enabled else "Cut away"
	if _cutaway_panel_open and not VoxelWorld.has_cutaway:
		_cutaway_panel_open = false
		_update_tool_overlay_visibility()

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
	var title := "%s%s  offset (%d, %d, %d)  ·  rotation %d°%s" % [
		"Place prefab \"%s\"" % _paste_prefab.name if _paste_prefab != null else "Paste",
		"  (locked)" if _paste_locked else "",
		_paste_offset.x, _paste_offset.y, _paste_offset.z, _paste_rotation * 90,
		"  ·  mirrored" if _paste_mirror else ""]
	_overlay.draw_string(font, Vector2(14.0, 30.0), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(0.85, 1.0, 0.9, 0.95))
	var hint := ("RMB place  ·  LMB lock/unlock  ·  MMB offset controls  ·  R rotate  ·  M mirror  ·  Esc cancel" if _fly_mode
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
	if not _cut_box.is_empty():
		_overlay.draw_string(font, Vector2(_overlay.size.x - 14.0, 30.0), "Cutaway on  ·  H/End to show all",
			HORIZONTAL_ALIGNMENT_RIGHT, -1, 14, Color(1.0, 0.6, 0.5, 0.9))
	var hint := "WASD move  ·  Space/RCtrl up · Shift// down  ·  LMB erase · RMB place · MMB pick  ·  R rotate (look at face)  ·  Tab slice · 1–0 slot · E inventory · Esc"
	_overlay.draw_string(font, Vector2(10.0, _overlay.size.y - 10.0),
		hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1,1,1,0.45))
