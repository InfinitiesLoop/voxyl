extends Node

# Build/edit tools. Ordinals are appended-only so nothing that stored a tool by
# index breaks. Which views a tool works in (2D "slice" / 3D "3d" / both) and whether
# it wants a brush size are declared in tool_supports_view / tool_uses_brush below —
# the tool rail and the views both read from there so they can never disagree.
enum Tool { PAINT, ERASE, LINE, RECT, FILL, BUILD_TO_ME, WAND, SELECT }

signal workspace_changed()
signal project_opened(project: VoxelProject)
signal palette_stack_changed()
signal block_changed(pos: Vector3i, semantic_name: String)
# Fired whenever the active project's undo/redo history changes (a step pushed, an undo, a
# redo, or a project open). UI that reflects history state — the EditorBar undo/redo
# buttons, a future Photoshop-style history panel — repaints from this. Carries no payload;
# listeners read can_undo()/can_redo()/history_entries().
signal history_changed()
signal selection_changed(semantic_name: String)
# Fired whenever the cuboid region selection changes — a corner set, the box completed,
# the box cleared, or a project opened. Distinct from selection_changed above, which is
# the palette/semantic "in hand" selection. Every view repaints its selection outline
# from this; carries no payload — listeners read selection_box()/has_selection.
signal region_selection_changed()
signal tool_changed(tool: Tool)
# Brush size (edge length of a tool's footprint, in cells). Only tools that opt in
# via tool_uses_brush() honor it; the rest place a single cell. View/UI reflect this.
signal brush_size_changed(size: int)
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
# Brush footprint edge length in cells (1 = single cell). Clamped by set_brush_size.
var brush_size: int = 1

# Cuboid region selection (the Select tool). Two opposite-corner cells define an
# inclusive min→max box; future copy/cut/paste will operate on it. This is project-tied
# editor state — persisted with the build like the hotbar/layout (Principle 2), NOT voxel
# data: it references positions only, never a block type or material, so palette/data stay
# decoupled. All views are lenses that visualize the same box. The pending first corner
# (mid two-click) is transient and never persisted.
var has_selection: bool = false
var selection_min: Vector3i = Vector3i.ZERO
var selection_max: Vector3i = Vector3i.ZERO
var _selection_anchor: Variant = null  # Vector3i first corner, or null between cycles

# Shared 9-slot hotbar: each entry is a semantic name ("" = empty slot). The
# active slot's semantic is the selected_semantic used for placement.
var hotbar: Array[String] = []
var active_slot: int = 0

# One-shot timer backing the debounced autosave (created in _ready).
var _save_timer: Timer

# --- Undo/redo recording state ---------------------------------------------
# The operation currently being recorded (between begin_operation/end_operation), or null.
# While set, the block mutators funnel their before→after deltas into it instead of each
# becoming its own history entry — so a whole paint-drag / line / fill / paste is ONE step.
var _current_op: EditOperation = null
# Re-entrancy depth so nested begin/end pairs (or a view that begins while one is already
# open) collapse into a single step; the op is only sealed/pushed when depth returns to 0.
var _op_depth := 0
# True only while an undo/redo is being applied, so the mutations it drives don't get
# re-recorded as brand-new history (which would make undo un-undoable).
var _applying_history := false

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	hotbar.resize(HOTBAR_SIZE)
	hotbar.fill("")
	# Seed the built-in material floor (basic library + Default palette), then load any
	# on-disk named libraries and saved palettes over it. `basic` is re-seeded here so a
	# missing baseline block is always restored (it can't be emptied).
	_seed_material_defaults()
	LibraryStore.load_persisted(workspace)
	# Finish unlinking any library a prior session deleted but didn't get to purge (delete only
	# moves the folder into .trash; the slow per-file unlink happens off-thread here).
	LibraryStore.purge_trash()
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
	active_project.has_selection = has_selection
	active_project.selection_min = selection_min
	active_project.selection_max = selection_max
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
	has_selection = false
	_selection_anchor = null
	_populate_defaults()
	workspace_changed.emit()

func open(project: VoxelProject) -> void:
	active_project = project
	_load_hotbar_from_project()
	# Restore the saved region selection (transient anchor always starts clear).
	has_selection = project.has_selection
	selection_min = project.selection_min
	selection_max = project.selection_max
	_selection_anchor = null
	var names := merged_semantic_names()
	selected_semantic = hotbar[active_slot] if not hotbar[active_slot].is_empty() \
		else (names[0] if not names.is_empty() else "")
	project_opened.emit(project)
	hotbar_changed.emit()
	active_slot_changed.emit(active_slot)
	history_changed.emit()
	region_selection_changed.emit()

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
	var before: Variant = _encode_cell(active_project.data.get_cell(pos))
	active_project.data.set_block(pos, semantic_name, orientation)
	_record_change(pos, before, _encode_cell(active_project.data.get_cell(pos)), "Place")
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
	var before: Variant = _encode_cell(cell)
	cell.orientation = orientation
	_record_change(pos, before, _encode_cell(cell), "Rotate")
	block_changed.emit(pos, cell.type_id)
	mark_dirty()

func clear_block(pos: Vector3i) -> void:
	if not active_project:
		return
	var before: Variant = _encode_cell(active_project.data.get_cell(pos))
	active_project.data.clear_block(pos)
	_record_change(pos, before, null, "Erase")
	block_changed.emit(pos, "")
	mark_dirty()

# ---------------------------------------------------------------------------
# Undo / redo — command history layered over the block mutators above.
#
# A logical step (a whole paint-drag, a line, a fill, a paste) is bracketed by
# begin_operation()/end_operation(); every set_block/clear_block/reorient_block in between
# records its minimal before→after delta into that one step. A mutator called with no step
# open auto-wraps into its own single-cell step, so ANY edit path is undoable without
# opting in. Applying an undo/redo replays stored cell states directly and is flagged so it
# never records itself as new history. See EditOperation/EditHistory for the delta model.
# ---------------------------------------------------------------------------

# Open a recording session named for the step about to happen. Nestable — an inner
# begin/end pair just extends the outer step (depth-counted), so overlapping view code
# can't produce a half-recorded op.
func begin_operation(op_name: String) -> void:
	if _op_depth == 0:
		_current_op = EditOperation.new(op_name)
	_op_depth += 1

# Close the current recording session. At depth 0 the step is sealed and, if it made any
# net change, pushed onto the undo stack (clearing the redo branch). A no-op step (nothing
# changed, or changes that cancelled out) is discarded — it neither creates an entry nor
# disturbs an existing redo stack.
func end_operation() -> void:
	if _op_depth == 0:
		return
	_op_depth -= 1
	if _op_depth > 0:
		return
	var op := _current_op
	_current_op = null
	if op == null or active_project == null:
		return
	op.seal()
	if op.is_empty():
		return
	active_project.history.push(op)
	history_changed.emit()
	mark_dirty()

func can_undo() -> bool:
	return active_project != null and active_project.history.can_undo()

func can_redo() -> bool:
	return active_project != null and active_project.history.can_redo()

# Undo the most recent step: restore every touched cell's `before` state. Returns false
# when there's nothing to undo.
func undo() -> bool:
	if not can_undo():
		return false
	_apply_op(active_project.history.pop_undo(), false)
	return true

# Redo the most recently undone step: restore every touched cell's `after` state. Returns
# false when there's nothing to redo.
func redo() -> bool:
	if not can_redo():
		return false
	_apply_op(active_project.history.pop_redo(), true)
	return true

# Timeline snapshot for a history view (labels + which state is current). See
# EditHistory.entries().
func history_entries() -> Dictionary:
	return active_project.history.entries() if active_project else {"entries": [], "current": -1}

# Replay one step's stored cell states onto the live data. `is_redo` picks each change's
# `after`, undo picks its `before`. Guarded by _applying_history so the mutations don't get
# recorded as new history; emits block_changed per cell so every view repaints, and marks
# the project dirty so the moved history cursor persists.
func _apply_op(op: EditOperation, is_redo: bool) -> void:
	if op == null or active_project == null:
		return
	_applying_history = true
	var data := active_project.data
	var states: Array = op.afters if is_redo else op.befores
	for i in op.positions.size():
		var pos: Vector3i = op.positions[i]
		var encoded: Variant = states[i]
		if encoded == null:
			data.clear_block(pos)
			block_changed.emit(pos, "")
		else:
			data.set_cell(pos, _decode_cell(encoded))
			block_changed.emit(pos, encoded[0])
	_applying_history = false
	history_changed.emit()
	mark_dirty()

# Funnel one cell's delta into the open step, or — if none is open — into its own
# single-cell step. No-ops (before == after) and history-replay mutations are ignored.
func _record_change(pos: Vector3i, before: Variant, after: Variant, default_name: String) -> void:
	if _applying_history or before == after:
		return
	if _current_op != null:
		_current_op.record(pos, before, after)
		return
	var op := EditOperation.new(default_name)
	op.record(pos, before, after)
	op.seal()
	if op.is_empty() or active_project == null:
		return
	active_project.history.push(op)
	history_changed.emit()

# Encode a BlockCell into the plain-data tuple EditOperation stores (null = empty cell).
# tags are deep-copied so a later in-place edit of the live cell can't mutate recorded
# history. See EditOperation for the tuple contract.
func _encode_cell(cell: BlockCell) -> Variant:
	if cell == null:
		return null
	return [cell.type_id, cell.orientation, cell.tags.duplicate(true)]

func _decode_cell(encoded: Array) -> BlockCell:
	return BlockCell.new(encoded[0], encoded[1], (encoded[2] as Dictionary).duplicate(true))

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

# Whether a semantic can be oriented across all 6 directions (barrels, dispensers,
# logs, …) rather than constrained to the 4 horizontal facings + a top/bottom half
# (stairs, slabs). Two ways to earn it:
#   - A state_map that itself declares a vertical (up/down) facing — the block was
#     imported with real per-direction geometry, so rotating it into any of the 6
#     poses picks a baked model MC itself would use.
#   - No state_map at all (FLAT-imported, or a plain undecided block) AND a FULL
#     shape. There's no baked per-facing variant to protect here, just one cube
#     rendered via the generic whole-mesh transform (Orientation.basis_of), which is
#     well-defined for any of the 6 facings — so a plain top/side/bottom cube can be
#     tipped onto its side even though vanilla MC never renders it that way. Voxyl is
#     MC-inspired, not MC-coupled (see CLAUDE.md); a schematic-style exporter can
#     reconcile the difference later if a pose has no vanilla equivalent.
# A state_map that exists but declares ONLY horizontal facings (stairs, slabs) is the
# one case that stays constrained: resolve() would silently fall back to an arbitrary
# entry for a facing it never baked, so the horizontal + half scheme is the only safe
# choice there. Shape is checked via get_shape_for_semantic so an "undecided" semantic
# (no resolved block type) still defaults to FULL — the least-restrictive scheme.
func has_full_facing_for_semantic(semantic_name: String) -> bool:
	var bt: BlockType = _resolve_semantic(semantic_name).get("bt")
	if bt != null and bt.state_map != null and not bt.state_map.is_empty():
		return bt.state_map.has_vertical_facing()
	return get_shape_for_semantic(semantic_name) == BlockType.Shape.FULL

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

# A block's connection-height classification ("low" or "tall") for a neighbor in a
# multipart connection (walls, redstone-style wiring): derived at render time from
# the resolved model's own geometry — never a stored/authored property — so it stays
# in step with whatever the palette currently maps the semantic to (same decoupling
# as color/shape/model). "tall" means the model's silhouette reaches (near) full
# block height; "low" covers everything shorter (slabs, thin connectors). Callers
# supply "none" themselves for an empty neighbor — this never returns it.
#
# This is deliberately generic (a semantic -> String classification), not MC-specific,
# so a future stair-corner feature can reuse it without rework; only MCImporter.gd
# knows MC's own vocabulary (low/tall/side/up) and maps it to "low"/"tall" at import
# time. The height threshold is a tunable heuristic, not a law of nature — a non-MC
# voxel game's notion of "tall" could differ.
const _TALL_HEIGHT_THRESHOLD := 0.8

func get_connect_height_for_semantic(semantic_name: String) -> String:
	var bt: BlockType = _resolve_semantic(semantic_name).get("bt")
	if bt and bt.shape == BlockType.Shape.SLAB and bt.model_id.is_empty():
		return "low"   # cheap, clarifying fast-path for the un-imported planning case
	var model := get_model_for_semantic(semantic_name)
	return "tall" if model != null and model.max_height() >= _TALL_HEIGHT_THRESHOLD else "low"

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

# ---------------------------------------------------------------------------
# Palette editing (contents of a palette, not the per-project subscription
# stack above). Every mutator here is a no-op on a builtin palette (the
# code-seeded "Default") except duplicate_palette — that's the intended way
# to fork it into something editable. Centralizing here (rather than letting
# callers poke palette.entries/library_names directly) means the read-only
# guard can't be bypassed by a future UI control that forgets to check it.
# ---------------------------------------------------------------------------

func add_palette(palette_name: String) -> Palette:
	var p := workspace.add_palette(palette_name)
	_save_palettes()
	workspace_changed.emit()
	return p

func duplicate_palette(source: Palette, new_name: String) -> Palette:
	var p := workspace.duplicate_palette(source.name, new_name)
	if p != null:
		_save_palettes()
		workspace_changed.emit()
	return p

func rename_palette(palette: Palette, new_name: String) -> bool:
	if palette.builtin:
		return false
	var n := new_name.strip_edges()
	if n.is_empty() or n == palette.name or workspace.get_palette(n) != null:
		return false
	# Palette subscriptions are stored by name, so a rename must repoint every
	# project's palette_names stack to keep it resolving.
	var old_name := palette.name
	palette.name = n
	for project in workspace.projects:
		for i in project.palette_names.size():
			if project.palette_names[i] == old_name:
				project.palette_names[i] = n
	_save_palettes()
	workspace_changed.emit()
	return true

func remove_palette(palette: Palette) -> void:
	if palette.builtin:
		return
	workspace.remove_palette(palette.name)
	LibraryStore.delete_palette(palette.name)
	_save_palettes()
	workspace_changed.emit()

func add_palette_entry(palette: Palette, semantic_name: String) -> PaletteEntry:
	if palette.builtin:
		return null
	var e := PaletteEntry.new()
	e.semantic_name = semantic_name
	palette.entries.append(e)
	_save_palettes()
	workspace_changed.emit()
	return e

func rename_palette_entry(palette: Palette, entry: PaletteEntry, new_name: String) -> bool:
	if palette.builtin:
		return false
	var n := new_name.strip_edges()
	if n.is_empty() or n == entry.semantic_name or palette.get_entry(n) != null:
		return false
	entry.semantic_name = n
	_save_palettes()
	workspace_changed.emit()
	return true

func assign_palette_entry_block(palette: Palette, entry: PaletteEntry, block_type_name: String) -> void:
	if palette.builtin:
		return
	entry.block_type_name = block_type_name
	notify_block_type_changed()
	_save_palettes()
	workspace_changed.emit()

func remove_palette_entry(palette: Palette, entry: PaletteEntry) -> void:
	if palette.builtin:
		return
	palette.entries.erase(entry)
	_save_palettes()
	workspace_changed.emit()

func add_palette_library(palette: Palette, library_name: String) -> void:
	if palette.builtin:
		return
	palette.library_names.append(library_name)
	_save_palettes()
	workspace_changed.emit()

func remove_palette_library(palette: Palette, index: int) -> void:
	if palette.builtin:
		return
	palette.library_names.remove_at(index)
	_save_palettes()
	workspace_changed.emit()

func move_palette_library(palette: Palette, from_idx: int, to_idx: int) -> void:
	if palette.builtin:
		return
	palette.library_names.insert(to_idx, palette.library_names.pop_at(from_idx))
	_save_palettes()
	workspace_changed.emit()

func _save_palettes() -> void:
	LibraryStore.save_palettes(workspace)

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

# ---------------------------------------------------------------------------
# Region selection (the Select tool) — one shared cuboid across every view.
#
# The two-click state machine, driven by whichever view the user right-clicks in.
# Each click advances it: (empty) set the first corner → (anchored) complete the
# cuboid → (selected) clear. Kept whole here rather than in a view so all views share
# one selection and one state (Principle 2). Future copy/cut/paste reads selection_box().
# ---------------------------------------------------------------------------

# Advance the state machine with a clicked cell. `cell` is a Vector3i corner, or null
# when the crosshair is on nothing — a null click can still CLEAR an existing selection
# but can't start or finish one.
func select_region_click(cell: Variant) -> void:
	if has_selection:
		clear_selection()  # third click clears
		return
	if cell == null:
		return
	var corner: Vector3i = cell
	if _selection_anchor == null:
		_selection_anchor = corner
		region_selection_changed.emit()  # show the pending single-cell first corner
		return
	var a: Vector3i = _selection_anchor
	selection_min = Vector3i(mini(a.x, corner.x), mini(a.y, corner.y), mini(a.z, corner.z))
	selection_max = Vector3i(maxi(a.x, corner.x), maxi(a.y, corner.y), maxi(a.z, corner.z))
	_selection_anchor = null
	has_selection = true
	region_selection_changed.emit()
	mark_dirty()

# Drop the current selection (and any pending anchor). No-op — and no signal — when
# there's nothing to clear, so idle repaints stay cheap.
func clear_selection() -> void:
	if not has_selection and _selection_anchor == null:
		return
	has_selection = false
	_selection_anchor = null
	region_selection_changed.emit()
	mark_dirty()

# The inclusive [min, max] box a view should outline: the completed cuboid, or the
# pending single-cell first corner, or [] when there's neither.
func selection_box() -> Array:
	if has_selection:
		return [selection_min, selection_max]
	if _selection_anchor != null:
		return [_selection_anchor, _selection_anchor]
	return []

const BRUSH_SIZE_MAX := 15

func set_brush_size(size: int) -> void:
	size = clampi(size, 1, BRUSH_SIZE_MAX)
	if size == brush_size:
		return
	brush_size = size
	brush_size_changed.emit(size)

# Which view kinds a tool is usable in ("3d" = View3D, "slice" = View2DGrid). This is
# the single source of truth the tool rail greys buttons from and the views could gate
# on. PAINT (the pencil) works everywhere; the shape/flood tools are 2D-only for now;
# "build to me" is inherently camera-relative, so 3D-only. Select (cuboid region) works
# everywhere — each view visualizes the same box.
func tool_supports_view(tool: Tool, view_kind: String) -> bool:
	match tool:
		Tool.PAINT, Tool.SELECT:
			return true
		Tool.BUILD_TO_ME, Tool.WAND:
			return view_kind == "3d"
		Tool.ERASE, Tool.LINE, Tool.RECT, Tool.FILL:
			return view_kind == "slice"
		_:
			return true

# Whether a tool honors brush_size (footprint > 1 cell). Others always place one cell.
func tool_uses_brush(tool: Tool) -> bool:
	return tool == Tool.BUILD_TO_ME

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
		["shingle",   Color(0.35, 0.18, 0.15), BlockType.Shape.FULL],
		["pane",      Color(0.85, 0.85, 0.88), BlockType.Shape.FULL],
		["glow",      Color(0.95, 0.85, 0.45), BlockType.Shape.FULL],
		["lantern",   Color(0.90, 0.55, 0.20), BlockType.Shape.FULL],
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
		["Floor1",       "stone"],
		["Floor2",       "plank"],
		["Wall",         "base"],
		["Trim",         "trim"],
		["Accent",       "accent"],
		["Window",       "glass"],
		["Window Pane",  "pane"],
		["Roof",         "shingle"],
		["Stairs",       "stairs"],
		["Slab",         "slab"],
		["Light Block",  "glow"],
		["Light Fixture","lantern"],
	]
	for s in slots:
		var e := PaletteEntry.new()
		e.semantic_name = s[0]
		e.block_type_name = s[1]
		p.entries.append(e)
