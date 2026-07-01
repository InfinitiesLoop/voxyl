extends Node

enum Tool { PAINT, ERASE, LINE, RECT, FILL }

signal workspace_changed()
signal project_opened(project: VoxelProject)
signal palette_stack_changed()
signal block_changed(pos: Vector3i, semantic_name: String)
signal selection_changed(semantic_name: String)
signal tool_changed(tool: Tool)
signal slice_view_requested(axis: int, center: Vector3i, flipped: bool)
signal block_type_changed()
# Unified hotbar shared by every view (no view owns it). hotbar_changed fires on
# slot reassignment; active_slot_changed when the highlighted slot moves.
signal hotbar_changed()
signal active_slot_changed(slot: int)
# Fired right before the active project is persisted, so owners of project-tied state
# that VoxelWorld doesn't hold itself (the view layout, owned by MultiViewShell) can
# write their current snapshot into the project first. See _flush_save.
signal about_to_save(project: VoxelProject)

const HOTBAR_SIZE := 12
# Debounce window for autosave: a burst of edits (a paint drag, an orbit) collapses
# into a single write this long after the last change.
const AUTOSAVE_DELAY := 1.0

var workspace: VoxelWorkspace
var active_project: VoxelProject
var selected_semantic: String = ""
var active_tool: Tool = Tool.PAINT

# Shared 9-slot hotbar: each entry is a semantic name ("" = empty slot). The
# active slot's semantic is the selected_semantic used for placement.
var hotbar: Array[String] = []
var active_slot: int = 0

# One-shot timer backing the debounced autosave (created in _ready).
var _save_timer: Timer

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	hotbar.resize(HOTBAR_SIZE)
	hotbar.fill("")
	# Seed the built-in material floor (basic library + Default palette), then load any
	# on-disk named libraries and saved palettes over it. `basic` is re-seeded here so a
	# missing baseline block is always restored (it can't be emptied).
	_seed_material_defaults()
	LibraryStore.load_persisted(workspace)
	# Load saved projects (the builds themselves). Only seed the code-built "first build"
	# when nothing has ever been saved — a returning user gets their own projects, not a
	# fresh demo over the top of them.
	ProjectStore.load_persisted(workspace)
	if workspace.projects.is_empty():
		_seed_default_project()
	_setup_autosave()
	workspace_changed.emit()

func _setup_autosave() -> void:
	_save_timer = Timer.new()
	_save_timer.one_shot = true
	_save_timer.wait_time = AUTOSAVE_DELAY
	_save_timer.timeout.connect(_flush_save)
	add_child(_save_timer)

# Schedule an autosave of the active project. Cheap to call on every mutation — it just
# (re)starts the debounce timer, so a burst of edits writes once when it settles.
func mark_dirty() -> void:
	if active_project != null and _save_timer != null:
		_save_timer.start()

# Persist the active project now (used on debounce timeout, and synchronously on
# go-home / app quit). Copies VoxelWorld-owned project state (the hotbar) into the
# project and lets other owners (the view layout) fill theirs via about_to_save first.
func save_active_project() -> void:
	if active_project == null:
		return
	if _save_timer != null:
		_save_timer.stop()
	_flush_save()

func _flush_save() -> void:
	if active_project == null:
		return
	active_project.hotbar = hotbar.duplicate()
	active_project.active_slot = active_slot
	about_to_save.emit(active_project)
	ProjectStore.save_project(active_project)

# Rebuild a pristine workspace from code alone. Tests call this first so they run
# against the code-seeded defaults regardless of whatever LibraryStore loaded at
# startup (a real on-disk library left by a prior import would otherwise make
# autoload-based assertions non-deterministic).
func reset_for_tests() -> void:
	workspace = VoxelWorkspace.new()
	active_project = null
	hotbar.fill("")
	active_slot = 0
	_populate_defaults()
	workspace_changed.emit()

func open(project: VoxelProject) -> void:
	active_project = project
	_load_hotbar_from_project()
	var names := merged_semantic_names()
	selected_semantic = hotbar[active_slot] if not hotbar[active_slot].is_empty() \
		else (names[0] if not names.is_empty() else "")
	project_opened.emit(project)
	hotbar_changed.emit()
	active_slot_changed.emit(active_slot)

# Restore this project's saved hotbar into the shared live hotbar, then fill any still-
# empty slots from the palette so a project saved before it had a full bar is still
# usable. active_slot is clamped in case HOTBAR_SIZE ever shrinks.
func _load_hotbar_from_project() -> void:
	hotbar.fill("")
	var saved := active_project.hotbar
	for i in mini(saved.size(), HOTBAR_SIZE):
		hotbar[i] = saved[i]
	active_slot = clampi(active_project.active_slot, 0, HOTBAR_SIZE - 1)
	_seed_hotbar_from_palette()

# Place a block. Orientation is decided by the edit view at placement time
# (2D: the clicked quadrant; 3D: how you place it), so it's always explicit here.
func set_block(pos: Vector3i, semantic_name: String, orientation: int = 0) -> void:
	if not active_project:
		return
	active_project.data.set_block(pos, semantic_name, orientation)
	block_changed.emit(pos, semantic_name)
	mark_dirty()

# Re-orient an existing cell in place (the R / Shift+R rotate tools). No-op if the
# cell is empty; emits block_changed so every view repaints.
func reorient_block(pos: Vector3i, orientation: int) -> void:
	if not active_project:
		return
	var cell := active_project.data.get_cell(pos)
	if cell == null:
		return
	cell.orientation = orientation
	block_changed.emit(pos, cell.type_id)
	mark_dirty()

func clear_block(pos: Vector3i) -> void:
	if not active_project:
		return
	active_project.data.clear_block(pos)
	block_changed.emit(pos, "")
	mark_dirty()

func get_block(pos: Vector3i) -> String:
	return active_project.data.get_block(pos) if active_project else ""

# Resolve a semantic to its winning palette + block type for the active project. Walks
# the project's palette stack last-wins (the last palette that maps the semantic to a
# block-type name wins), then resolves that name → BlockType through THAT palette's
# library stack (first-hit, basic fallback). Returns {} when no palette maps it, else
# { palette, name, bt } where `bt` may be null if no library in scope defines the name.
func _resolve_semantic(semantic_name: String) -> Dictionary:
	var result := {}
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if not palette:
			continue
		var bt_name := palette.get_block_type_name(semantic_name)
		if bt_name.is_empty():
			continue
		result = {
			"palette": palette,
			"name": bt_name,
			"bt": workspace.resolve_block_type(bt_name, palette.library_names),
		}
	return result

# The winning palette's library stack for a semantic (for scoped model/texture
# resolution), or [] when nothing maps it.
func _libs_for_semantic(semantic_name: String) -> Array:
	var r := _resolve_semantic(semantic_name)
	return (r["palette"] as Palette).library_names if r.has("palette") else []

func get_color_for_semantic(semantic_name: String) -> Color:
	var bt: BlockType = _resolve_semantic(semantic_name).get("bt")
	return bt.color if bt else Color(0.35, 0.35, 0.35)

# Resolved biome tint for a semantic (last-wins palette walk, same as color). The
# 3D view multiplies this into faces that carry a tint_index; WHITE (the default,
# and the value for any block type that never set one) leaves the face untinted.
# Still the material layer — the data never names a block type or a color.
func get_tint_for_semantic(semantic_name: String) -> Color:
	var bt: BlockType = _resolve_semantic(semantic_name).get("bt")
	return bt.tint if bt else Color.WHITE

func notify_block_type_changed() -> void:
	block_type_changed.emit()

func get_block_type_for_semantic(semantic_name: String) -> String:
	return _resolve_semantic(semantic_name).get("name", "")

# The resolved BlockType object for a semantic (last-wins palette walk), or null.
# Views that need more than color/geometry — e.g. the 3D view reading a block's
# state_map to drive orientation variants / multipart connection parts — go through
# this. It's still the material layer: the data never names a block type.
func get_block_type_object_for_semantic(semantic_name: String) -> BlockType:
	return _resolve_semantic(semantic_name).get("bt")

# Resolved render shape (FULL/SLAB/STAIRS) for a semantic, via the palette stack
# (last-wins, same as color/block-type). Shape is a visual property of the mapped
# block type — the data never stores it.
func get_shape_for_semantic(semantic_name: String) -> BlockType.Shape:
	var bt: BlockType = _resolve_semantic(semantic_name).get("bt")
	return bt.shape if bt else BlockType.Shape.FULL

# Resolved render geometry for a semantic, as a BlockModel. Same last-wins
# palette-stack walk as color/shape: find the mapped block type, then return its
# explicit model (model_id, resolved through the palette's library stack) or the
# built-in model for its `shape`. Always returns a model so the view never
# special-cases geometry.
func get_model_for_semantic(semantic_name: String) -> BlockModel:
	var r := _resolve_semantic(semantic_name)
	var bt: BlockType = r.get("bt")
	var libs: Array = (r["palette"] as Palette).library_names if r.has("palette") else []
	if bt and not bt.model_id.is_empty():
		var explicit := workspace.resolve_block_model(bt.model_id, libs)
		if explicit:
			return explicit
	var shape_id := _builtin_model_id_for_shape(bt.shape if bt else BlockType.Shape.FULL)
	var builtin := workspace.resolve_block_model(shape_id, libs)
	return builtin if builtin else BlockModel.builtin_by_id(shape_id)

# Primary TextureAsset for a semantic (the model's "all"/"side"/first binding),
# or null when the resolved model carries no textures — the color path. Resolves
# texture ids through the winning palette's library stack, same scope as the model.
# (Per-face lookup by slice-plane normal is deferred; see the plan.)
func get_texture_for_semantic(semantic_name: String) -> TextureAsset:
	var model := get_model_for_semantic(semantic_name)
	if model == null or model.textures.is_empty():
		return null
	var key := "all"
	if not model.textures.has(key):
		key = "side" if model.textures.has("side") else model.textures.keys()[0]
	return workspace.resolve_texture_asset(model.textures[key], _libs_for_semantic(semantic_name))

func _builtin_model_id_for_shape(shape: BlockType.Shape) -> String:
	match shape:
		BlockType.Shape.SLAB: return BlockModel.BUILTIN_SLAB
		BlockType.Shape.STAIRS: return BlockModel.BUILTIN_STAIRS
		_: return BlockModel.BUILTIN_FULL

func merged_semantic_names() -> Array[String]:
	var seen := {}
	var result: Array[String] = []
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if not palette:
			continue
		for entry in palette.entries:
			if entry.semantic_name not in seen:
				seen[entry.semantic_name] = true
				result.append(entry.semantic_name)
	return result

func add_palette_to_stack(project: VoxelProject, palette_name: String) -> void:
	project.palette_names.append(palette_name)
	_after_stack_change(project)

func remove_palette_from_stack(project: VoxelProject, index: int) -> void:
	project.palette_names.remove_at(index)
	_after_stack_change(project)

func move_palette_in_stack(project: VoxelProject, from_idx: int, to_idx: int) -> void:
	project.palette_names.insert(to_idx, project.palette_names.pop_at(from_idx))
	_after_stack_change(project)

# Shared tail for the palette-stack mutators: repaint the active project's views and
# persist the change. A stack edit on a non-active project is written straight through
# (it won't ride the active project's debounce timer).
func _after_stack_change(project: VoxelProject) -> void:
	if project == active_project:
		palette_stack_changed.emit()
		mark_dirty()
	else:
		ProjectStore.save_project(project)

func select_semantic(semantic_name: String) -> void:
	selected_semantic = semantic_name
	selection_changed.emit(semantic_name)

# ---------------------------------------------------------------------------
# Hotbar (unified across all views)
# ---------------------------------------------------------------------------

# Make `slot` the active one; its semantic becomes the selection used to place.
func select_slot(slot: int) -> void:
	if slot < 0 or slot >= HOTBAR_SIZE:
		return
	active_slot = slot
	active_slot_changed.emit(slot)
	select_semantic(hotbar[slot])
	mark_dirty()

# Assign a semantic to a slot (does not change which slot is active).
func set_hotbar_slot(slot: int, semantic_name: String) -> void:
	if slot < 0 or slot >= HOTBAR_SIZE:
		return
	hotbar[slot] = semantic_name
	hotbar_changed.emit()
	if slot == active_slot:
		select_semantic(semantic_name)
	mark_dirty()

# Put a semantic "in hand": if it's already on the hotbar, just jump to that
# slot; otherwise drop it into the active slot. This is MC creative "pick block".
func pick_block(semantic_name: String) -> void:
	if semantic_name.is_empty():
		return
	var existing := hotbar.find(semantic_name)
	if existing >= 0:
		select_slot(existing)
	else:
		hotbar[active_slot] = semantic_name
		hotbar_changed.emit()
		select_semantic(semantic_name)
		mark_dirty()

# Fill empty hotbar slots from the palette so a freshly opened project is usable.
# Existing assignments are preserved; only blanks get filled, in palette order.
func _seed_hotbar_from_palette() -> void:
	var names := merged_semantic_names()
	var next := 0
	for slot in HOTBAR_SIZE:
		if not hotbar[slot].is_empty():
			continue
		while next < names.size() and hotbar.has(names[next]):
			next += 1
		if next < names.size():
			hotbar[slot] = names[next]
			next += 1

func set_active_tool(tool: Tool) -> void:
	active_tool = tool
	tool_changed.emit(tool)

func request_slice_view(axis: int, center: Vector3i, flipped: bool = false) -> void:
	slice_view_requested.emit(axis, center, flipped)

# Full code-built defaults: the material floor + the demo project. Used by
# reset_for_tests so tests run against a pristine, disk-independent workspace.
func _populate_defaults() -> void:
	_seed_material_defaults()
	_seed_default_project()

# The always-present material layer: the basic library + the Default palette.
func _seed_material_defaults() -> void:
	_add_basic_library()
	_add_default_palette()

# The "first build" — only seeded on a truly fresh install (no saved projects). Starts
# empty so the user opens onto a blank canvas rather than a pre-made shape.
func _seed_default_project() -> void:
	var project := workspace.add_project("My First Build")
	project.palette_names.append("Default")

# Seed the code-built `basic` library (decision 5): a small set of generic +
# natural block types, no `minecraft:` ids, so the default floor is voxel-agnostic
# (Principle 4). It's flagged `builtin` — undeletable and re-seeded on launch — but
# behaves like any normal library. Idempotent on re-seed: an edited block keeps its
# edits, only missing baseline blocks are restored.
func _add_basic_library() -> void:
	var lib := workspace.basic_library()
	lib.register_builtin_models()
	# name, color, shape
	var blocks := [
		["base",      Color(0.55, 0.55, 0.55), BlockType.Shape.FULL],
		["accent",    Color(0.75, 0.60, 0.35), BlockType.Shape.FULL],
		["highlight", Color(0.72, 0.38, 0.28), BlockType.Shape.FULL],
		["trim",      Color(0.42, 0.42, 0.40), BlockType.Shape.FULL],
		["stone",     Color(0.50, 0.50, 0.52), BlockType.Shape.FULL],
		["dirt",      Color(0.48, 0.35, 0.22), BlockType.Shape.FULL],
		["grass",     Color(0.45, 0.62, 0.30), BlockType.Shape.FULL],
		["sand",      Color(0.85, 0.80, 0.58), BlockType.Shape.FULL],
		["wood",      Color(0.45, 0.33, 0.20), BlockType.Shape.FULL],
		["plank",     Color(0.66, 0.50, 0.30), BlockType.Shape.FULL],
		["glass",     Color(0.55, 0.78, 0.92), BlockType.Shape.FULL],
		["metal",     Color(0.72, 0.72, 0.76), BlockType.Shape.FULL],
		["leaves",    Color(0.35, 0.52, 0.25), BlockType.Shape.FULL],
		["water",     Color(0.25, 0.46, 0.85), BlockType.Shape.FULL],
		["slab",      Color(0.60, 0.60, 0.62), BlockType.Shape.SLAB],
		["stairs",    Color(0.66, 0.50, 0.30), BlockType.Shape.STAIRS],
	]
	for b in blocks:
		var bt := lib.get_block_type(b[0])
		if bt == null:
			bt = lib.add_block_type(b[0])
			bt.color = b[1]
			bt.shape = b[2]

# The built-in "Default" palette: maps the standard semantic names onto the basic
# block types and subscribes to the `basic` library. Flagged `builtin` (undeletable),
# but otherwise a normal palette. Idempotent — re-seeding leaves an existing one alone.
func _add_default_palette() -> void:
	if workspace.get_palette("Default") != null:
		return
	var p := workspace.add_palette("Default")
	p.builtin = true
	p.library_names = [VoxelWorkspace.BASIC_LIBRARY]
	var slots := [
		["Base",      "base"],
		["Accent",    "accent"],
		["Highlight", "highlight"],
		["Detail",    "glass"],
		["Trim",      "trim"],
		["Floor",     "dirt"],
		["Roof",      "plank"],
		["Stairs",    "stairs"],
		["Slab",      "slab"],
	]
	for s in slots:
		var e := PaletteEntry.new()
		e.semantic_name = s[0]
		e.block_type_name = s[1]
		p.entries.append(e)
