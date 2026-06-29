class_name HomeScreen
extends Control

signal open_project_requested(project: VoxelProject)

var _projects_container: VBoxContainer
var _palettes_list: LibraryList
var _palette_editor: Control
var _library_rail: LibraryList
var _selected_library: BlockLibrary
var _block_grid: BlockGrid
var _bt_detail: Control
var _bt_preview: BlockPreview3D
var _selected_block_type: String = ""
var _editing_palette: Palette
var _entry_list: VBoxContainer

# Shared column widths for the palette entry editor, so the header row and every entry/
# add row line up (the two leading columns expand equally; these two are fixed).
const _PAL_PREVIEW_W := 56
const _PAL_ACTION_W := 28

func _ready() -> void:
	var tabs := TabContainer.new()
	tabs.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(tabs)

	tabs.add_child(_build_projects_tab())
	tabs.add_child(_build_palettes_tab())
	tabs.add_child(_build_block_types_tab())

	VoxelWorld.workspace_changed.connect(_refresh)
	_refresh()

# ---------------------------------------------------------------------------
# Projects tab
# ---------------------------------------------------------------------------

func _build_projects_tab() -> Control:
	var root := _margin(16)
	root.name = "Projects"

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 12)
	root.add_child(vbox)

	var header := HBoxContainer.new()
	vbox.add_child(header)

	var title := Label.new()
	title.text = "Projects"
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)

	var new_btn := Button.new()
	new_btn.text = "New Project"
	new_btn.pressed.connect(_on_new_project)
	header.add_child(new_btn)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	vbox.add_child(scroll)

	_projects_container = VBoxContainer.new()
	_projects_container.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_projects_container.add_theme_constant_override("separation", 8)
	scroll.add_child(_projects_container)

	return root

func _rebuild_projects() -> void:
	for c in _projects_container.get_children():
		c.queue_free()
	for project in VoxelWorld.workspace.projects:
		_projects_container.add_child(_make_project_row(project))

func _make_project_row(project: VoxelProject) -> Control:
	var style_n := StyleBoxFlat.new()
	style_n.bg_color = Color(0.18, 0.18, 0.20)
	style_n.set_corner_radius_all(6)
	style_n.content_margin_left = 10; style_n.content_margin_right = 10
	style_n.content_margin_top = 10;  style_n.content_margin_bottom = 10

	var style_h := StyleBoxFlat.new()
	style_h.bg_color = Color(0.26, 0.26, 0.30)
	style_h.set_corner_radius_all(6)
	style_h.content_margin_left = 10; style_h.content_margin_right = 10
	style_h.content_margin_top = 10;  style_h.content_margin_bottom = 10

	var card := PanelContainer.new()
	card.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	card.add_theme_stylebox_override("panel", style_n)
	card.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	card.mouse_entered.connect(func(): card.add_theme_stylebox_override("panel", style_h))
	card.mouse_exited.connect(func(): card.add_theme_stylebox_override("panel", style_n))
	card.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT and (ev as InputEventMouseButton).pressed:
			open_project_requested.emit(project)
	)

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 14)
	hbox.mouse_filter = Control.MOUSE_FILTER_PASS
	card.add_child(hbox)

	var thumb := Control.new()
	thumb.custom_minimum_size = Vector2(60, 60)
	thumb.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	thumb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	thumb.draw.connect(func(): _draw_voxyl_logo(thumb))
	hbox.add_child(thumb)

	var name_lbl := Label.new()
	name_lbl.text = project.name
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	name_lbl.add_theme_font_size_override("font_size", 15)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hbox.add_child(name_lbl)

	var del_btn := Button.new()
	del_btn.text = "✕"
	del_btn.flat = true
	del_btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	del_btn.pressed.connect(func():
		VoxelWorld.workspace.remove_project(project.name)
		VoxelWorld.workspace_changed.emit()
	)
	hbox.add_child(del_btn)

	return card

func _draw_voxyl_logo(ctl: Control) -> void:
	var s: float = minf(ctl.size.x, ctl.size.y) / 14.0
	var ix := Vector2(s, s * 0.5); var iy := Vector2(0.0, -s); var iz := Vector2(-s, s * 0.5)
	var o := ctl.size * 0.5
	var p: Callable = func(x: float, y: float, z: float) -> Vector2: return o + ix * x + iy * y + iz * z

	# X arm — gray Base: top and front face
	ctl.draw_colored_polygon(PackedVector2Array([p.call(0,6,4), p.call(10,6,4), p.call(10,6,6), p.call(0,6,6)]), Color(0.80, 0.80, 0.80))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(0,4,6), p.call(10,4,6), p.call(10,6,6), p.call(0,6,6)]), Color(0.55, 0.55, 0.55))
	# Z arm — brick Highlight: top and right face
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,6,0), p.call(6,6,0), p.call(6,6,10), p.call(4,6,10)]), Color(0.88, 0.50, 0.38))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(6,4,0), p.call(6,4,10), p.call(6,6,10), p.call(6,6,0)]), Color(0.65, 0.33, 0.24))
	# Y arm — wood Accent: top, front, right (drawn last — tallest, always on top)
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,10,4), p.call(6,10,4), p.call(6,10,6), p.call(4,10,6)]), Color(0.90, 0.72, 0.45))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,0,6), p.call(6,0,6), p.call(6,10,6), p.call(4,10,6)]), Color(0.75, 0.58, 0.35))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(6,0,4), p.call(6,0,6), p.call(6,10,6), p.call(6,10,4)]), Color(0.65, 0.50, 0.28))

func _on_new_project() -> void:
	var dialog := AcceptDialog.new()
	dialog.title = "New Project"
	var input := LineEdit.new()
	input.placeholder_text = "Project name..."
	input.set_custom_minimum_size(Vector2(260, 0))
	dialog.add_child(input)
	dialog.confirmed.connect(func():
		var n := input.text.strip_edges()
		if not n.is_empty() and not VoxelWorld.workspace.get_project(n):
			VoxelWorld.workspace.add_project(n)
			VoxelWorld.workspace_changed.emit()
		dialog.queue_free()
	)
	dialog.canceled.connect(func(): dialog.queue_free())
	get_tree().root.add_child(dialog)
	dialog.popup_centered()
	input.grab_focus()

# ---------------------------------------------------------------------------
# Palettes tab
# ---------------------------------------------------------------------------

func _build_palettes_tab() -> Control:
	var root := Control.new()
	root.name = "Palettes"

	var split := HSplitContainer.new()
	split.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.add_child(split)

	# Left: palette library
	var left := _margin(12)
	left.custom_minimum_size.x = 200
	split.add_child(left)

	_palettes_list = LibraryList.new()
	_palettes_list.list_title = "Palettes"
	_palettes_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_palettes_list.add_requested.connect(_on_add_palette)
	_palettes_list.delete_requested.connect(_on_delete_palette)
	_palettes_list.item_selected.connect(_on_palette_selected)
	left.add_child(_palettes_list)

	# Right: palette entry editor
	_palette_editor = _build_palette_editor()
	split.add_child(_palette_editor)

	return root

func _build_palette_editor() -> Control:
	var root := _margin(16)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	root.add_child(vbox)

	var placeholder := Label.new()
	placeholder.name = "Placeholder"
	placeholder.text = "Select a palette to edit it."
	vbox.add_child(placeholder)

	root.set_meta("vbox", vbox)
	return root

func _on_palette_selected(palette_name: String) -> void:
	var palette := VoxelWorld.workspace.get_palette(palette_name)
	if not palette:
		return
	var vbox: VBoxContainer = _palette_editor.get_meta("vbox")
	for c in vbox.get_children():
		c.queue_free()
	await get_tree().process_frame

	var title := Label.new()
	title.text = palette.name
	vbox.add_child(title)

	var sep := HSeparator.new()
	vbox.add_child(sep)

	_editing_palette = palette
	# Libraries this palette draws from (priority order) — the new subscription editor.
	_build_palette_libraries(vbox, palette)

	vbox.add_child(HSeparator.new())

	# Column headers — aligned with the entry rows below: two expanding label columns,
	# then the fixed-width preview + action columns.
	var headers := HBoxContainer.new()
	headers.add_theme_constant_override("separation", 6)
	vbox.add_child(headers)
	var sem_h := Label.new()
	sem_h.text = "Semantic Name"
	sem_h.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	headers.add_child(sem_h)
	var bt_h := Label.new()
	bt_h.text = "Block Type"
	bt_h.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	headers.add_child(bt_h)
	var prev_h := Label.new()
	prev_h.text = "Preview"
	prev_h.clip_text = true
	prev_h.custom_minimum_size = Vector2(_PAL_PREVIEW_W, 0)
	headers.add_child(prev_h)
	var act_h := Control.new()
	act_h.custom_minimum_size = Vector2(_PAL_ACTION_W, 0)
	headers.add_child(act_h)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	vbox.add_child(scroll)

	_entry_list = VBoxContainer.new()
	_entry_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_entry_list.add_theme_constant_override("separation", 4)
	scroll.add_child(_entry_list)

	_editing_palette = palette
	_refresh_palette_entries()

func _refresh_palette_entries() -> void:
	if not _entry_list or not _editing_palette:
		return
	for c in _entry_list.get_children():
		c.queue_free()
	await get_tree().process_frame
	for entry in _editing_palette.entries:
		_entry_list.add_child(_make_entry_row(entry))
	_entry_list.add_child(_make_add_entry_row())

func _make_entry_row(entry: PaletteEntry) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)

	var name_edit := LineEdit.new()
	name_edit.text = entry.semantic_name
	name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_edit.text_submitted.connect(func(t): entry.semantic_name = t.strip_edges())
	name_edit.focus_exited.connect(func(): entry.semantic_name = name_edit.text.strip_edges())
	row.add_child(name_edit)

	var swatch := ColorRect.new()
	swatch.custom_minimum_size = Vector2(_PAL_PREVIEW_W, 0)
	swatch.size_flags_vertical = Control.SIZE_EXPAND_FILL
	swatch.mouse_filter = Control.MOUSE_FILTER_IGNORE

	# The picker lists block types from this palette's subscribed libraries (scoped, in
	# priority order, basic-fallback included), not a global flat array.
	var names := _scoped_block_type_names(_editing_palette)
	if not entry.block_type_name.is_empty() and entry.block_type_name not in names:
		names.push_front(entry.block_type_name)   # keep an off-scope mapping visible
	var block_picker := OptionButton.new()
	block_picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var current_idx := 0
	for i in names.size():
		block_picker.add_item(names[i])
		if names[i] == entry.block_type_name:
			current_idx = i
	block_picker.selected = current_idx
	block_picker.item_selected.connect(func(idx):
		entry.block_type_name = names[idx]
		var nb := VoxelWorld.workspace.resolve_block_type(entry.block_type_name, _editing_palette.library_names)
		swatch.color = nb.color if nb else Color(0.5, 0.5, 0.5)
		_save_palettes()
	)
	row.add_child(block_picker)

	var init_bt := VoxelWorld.workspace.resolve_block_type(entry.block_type_name, _editing_palette.library_names)
	swatch.color = init_bt.color if init_bt else Color(0.5, 0.5, 0.5)
	row.add_child(swatch)

	var del_btn := Button.new()
	del_btn.text = "✕"
	del_btn.flat = true
	del_btn.custom_minimum_size = Vector2(_PAL_ACTION_W, 0)
	del_btn.pressed.connect(func():
		_editing_palette.entries.erase(entry)
		_save_palettes()
		_refresh_palette_entries()
	)
	row.add_child(del_btn)

	return row

func _make_add_entry_row() -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)

	var name_input := LineEdit.new()
	name_input.placeholder_text = "New semantic name..."
	name_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(name_input)

	var names := _scoped_block_type_names(_editing_palette)
	var block_picker := OptionButton.new()
	block_picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	for n in names:
		block_picker.add_item(n)
	row.add_child(block_picker)

	# Spacer to align with the preview column in entry rows
	var gap := Control.new()
	gap.custom_minimum_size = Vector2(_PAL_PREVIEW_W, 0)
	gap.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(gap)

	var add_btn := Button.new()
	add_btn.text = "+"
	add_btn.custom_minimum_size = Vector2(_PAL_ACTION_W, 0)
	add_btn.pressed.connect(func():
		var n := name_input.text.strip_edges()
		if n.is_empty() or not _editing_palette:
			return
		var e := PaletteEntry.new()
		e.semantic_name = n
		var pidx := block_picker.selected
		e.block_type_name = names[pidx] if pidx >= 0 and pidx < names.size() else ""
		_editing_palette.entries.append(e)
		name_input.text = ""
		_save_palettes()
		_refresh_palette_entries()
	)
	row.add_child(add_btn)

	return row

# The block-type names a palette can map to: every block in its subscribed libraries
# (in priority order), then the basic-library fallback, de-duplicated.
func _scoped_block_type_names(palette: Palette) -> Array:
	var seen := {}
	var names: Array = []
	var libs := palette.library_names.duplicate()
	if VoxelWorkspace.BASIC_LIBRARY not in libs:
		libs.append(VoxelWorkspace.BASIC_LIBRARY)
	for lib_name in libs:
		var lib := VoxelWorld.workspace.get_library(lib_name)
		if lib == null:
			continue
		for bt in lib.sorted_block_types():
			if not seen.has(bt.name):
				seen[bt.name] = true
				names.append(bt.name)
	return names

# The palette's library-subscription editor: its ordered library_names (each with
# move-up / remove) plus an "add" picker of libraries it doesn't yet subscribe to.
# Editing it rescopes the entry pickers, so any change rebuilds the whole editor.
func _build_palette_libraries(vbox: VBoxContainer, palette: Palette) -> void:
	var lbl := Label.new()
	lbl.text = "Libraries (priority order, basic always applies last)"
	lbl.add_theme_font_size_override("font_size", 12)
	vbox.add_child(lbl)

	for i in palette.library_names.size():
		var idx := i
		var lib_name: String = palette.library_names[idx]
		var lrow := HBoxContainer.new()
		lrow.add_theme_constant_override("separation", 6)
		var nlbl := Label.new()
		nlbl.text = "%d. %s" % [idx + 1, lib_name]
		nlbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		lrow.add_child(nlbl)
		var up := Button.new()
		up.text = "↑"
		up.flat = true
		up.disabled = idx == 0
		up.pressed.connect(func():
			palette.library_names.remove_at(idx)
			palette.library_names.insert(idx - 1, lib_name)
			_save_palettes()
			_on_palette_selected(palette.name))
		lrow.add_child(up)
		var rem := Button.new()
		rem.text = "✕"
		rem.flat = true
		rem.pressed.connect(func():
			palette.library_names.remove_at(idx)
			_save_palettes()
			_on_palette_selected(palette.name))
		lrow.add_child(rem)
		vbox.add_child(lrow)

	# Add-library picker: libraries not already subscribed (basic is implicit, skip it).
	var available: Array = []
	for n in VoxelWorld.workspace.list_libraries():
		if n != VoxelWorkspace.BASIC_LIBRARY and n not in palette.library_names:
			available.append(n)
	if available.is_empty():
		return
	var add_row := HBoxContainer.new()
	add_row.add_theme_constant_override("separation", 6)
	var picker := OptionButton.new()
	picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	for n in available:
		picker.add_item(n)
	add_row.add_child(picker)
	var add_btn := Button.new()
	add_btn.text = "Add library"
	add_btn.pressed.connect(func():
		if picker.selected < 0:
			return
		palette.library_names.append(available[picker.selected])
		_save_palettes()
		_on_palette_selected(palette.name))
	add_row.add_child(add_btn)
	vbox.add_child(add_row)

func _save_palettes() -> void:
	LibraryStore.save_palettes(VoxelWorld.workspace)

func _on_add_palette(palette_name: String) -> void:
	if not VoxelWorld.workspace.get_palette(palette_name):
		VoxelWorld.workspace.add_palette(palette_name)
		_save_palettes()
		VoxelWorld.workspace_changed.emit()

func _on_delete_palette(palette_name: String) -> void:
	VoxelWorld.workspace.remove_palette(palette_name)
	_save_palettes()
	VoxelWorld.workspace_changed.emit()

# ---------------------------------------------------------------------------
# Block Types tab
# ---------------------------------------------------------------------------

func _build_block_types_tab() -> Control:
	var root := Control.new()
	root.name = "Libraries"

	# Library-scoped layout: [library rail | grid | detail]. Selecting a library in the
	# rail is the management context — the grid + actions all act on that one library.
	var split := HSplitContainer.new()
	split.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.add_child(split)

	# Far left: the library rail (create/rename/delete; rename+delete no-op for basic).
	var rail_box := _margin(12)
	rail_box.custom_minimum_size.x = 180
	split.add_child(rail_box)
	_library_rail = LibraryList.new()
	_library_rail.list_title = "Libraries"
	_library_rail.allow_rename = true
	_library_rail.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_library_rail.add_requested.connect(_on_add_library)
	_library_rail.delete_requested.connect(_on_delete_library)
	_library_rail.rename_requested.connect(_on_rename_library)
	_library_rail.item_selected.connect(_on_library_selected)
	rail_box.add_child(_library_rail)
	split.split_offset = 180

	var inner := HSplitContainer.new()
	inner.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	split.add_child(inner)

	# Middle (main): action header + the JEI-style icon grid.
	var right := _margin(12)
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inner.add_child(right)

	var rvbox := VBoxContainer.new()
	rvbox.add_theme_constant_override("separation", 8)
	right.add_child(rvbox)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	rvbox.add_child(header)

	var new_btn := Button.new()
	new_btn.text = "New block…"
	new_btn.pressed.connect(_on_new_block)
	header.add_child(new_btn)

	# Import blocks from the user's own MC assets — they land in this same grid.
	var import_btn := Button.new()
	import_btn.text = "Add blocks…"
	import_btn.pressed.connect(_on_import_blocks)
	header.add_child(import_btn)

	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(spacer)

	# Jump to the selected library's folder on disk.
	var folder_btn := Button.new()
	folder_btn.text = "Open folder"
	folder_btn.tooltip_text = "Reveal this library's folder in your file browser"
	folder_btn.pressed.connect(_on_open_library_folder)
	header.add_child(folder_btn)

	_block_grid = BlockGrid.new()
	_block_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_block_grid.block_selected.connect(_on_block_type_selected)
	rvbox.add_child(_block_grid)

	# Right: detail / edit panel for the selected block (3D preview + fields). Pinned to
	# a fixed width on the right so the divider doesn't drift as blocks are selected; the
	# resized hook keeps it there as the window (or the rail divider) resizes.
	_bt_detail = _build_bt_detail()
	inner.add_child(_bt_detail)
	inner.resized.connect(func(): inner.split_offset = maxi(0, int(inner.size.x) - 352))

	return root

# ---------------------------------------------------------------------------
# Library rail (Block Types tab)
# ---------------------------------------------------------------------------

func _on_add_library(library_name: String) -> void:
	if VoxelWorld.workspace.get_library(library_name) != null:
		return
	VoxelWorld.workspace.get_or_add_library(library_name)
	LibraryStore.save_library(VoxelWorld.workspace.get_library(library_name))
	_selected_library = VoxelWorld.workspace.get_library(library_name)
	_library_rail.selected = library_name
	VoxelWorld.workspace_changed.emit()

func _on_delete_library(library_name: String) -> void:
	var lib := VoxelWorld.workspace.get_library(library_name)
	if lib == null or lib.builtin:
		return   # the basic floor is undeletable
	VoxelWorld.workspace.remove_library(library_name)
	# Also remove the on-disk folder, or load_persisted re-finds it on the next launch and
	# the library comes back (the "ghost library that won't delete" bug).
	LibraryStore.delete_library(library_name)
	if _selected_library == lib:
		_selected_library = null
	VoxelWorld.workspace_changed.emit()

func _on_library_selected(library_name: String) -> void:
	_selected_library = VoxelWorld.workspace.get_library(library_name)
	_selected_block_type = ""
	if _block_grid:
		_block_grid.populate(_selected_library.sorted_block_types() if _selected_library else [])
	_refresh_bt_detail()

# Rename a library: prompt for a new name, then move it on disk + repoint palettes via
# LibraryStore. The basic floor is undeletable/unrenamable, so its ✎ no-ops.
func _on_rename_library(library_name: String) -> void:
	var lib := VoxelWorld.workspace.get_library(library_name)
	if lib == null or lib.builtin:
		return
	var dialog := AcceptDialog.new()
	dialog.title = "Rename Library"
	var input := LineEdit.new()
	input.text = library_name
	input.placeholder_text = "Library name…"
	input.custom_minimum_size = Vector2(260, 0)
	dialog.add_child(input)
	dialog.confirmed.connect(func():
		if LibraryStore.rename_library(VoxelWorld.workspace, library_name, input.text):
			if _selected_library == lib:
				_selected_library = lib   # same instance, new name
			VoxelWorld.workspace_changed.emit()
		dialog.queue_free())
	dialog.canceled.connect(func(): dialog.queue_free())
	get_tree().root.add_child(dialog)
	dialog.popup_centered()
	input.grab_focus()
	input.select_all()

# Reveal the selected library's folder in the OS file browser. Persist first so the
# folder exists even for a library that's only been created in memory.
func _on_open_library_folder() -> void:
	if _selected_library == null:
		return
	LibraryStore.save_library(_selected_library)
	OS.shell_open(ProjectSettings.globalize_path(AssetLibrary.path_for(_selected_library.name)))

# Pick a sensible selected library after a refresh: keep the current one if it still
# exists, else fall back to the first library (basic on a fresh install).
func _ensure_selected_library() -> void:
	if _selected_library != null and VoxelWorld.workspace.get_library(_selected_library.name) != null:
		return
	_selected_library = VoxelWorld.workspace.libraries[0] if not VoxelWorld.workspace.libraries.is_empty() else null

# The left detail panel shell: a styled PanelContainer (its background makes the
# split seam visible) at a fixed width, holding a scrollable vbox. The fixed width +
# clipped labels keep the divider from shifting as different blocks are selected.
# _refresh_bt_detail fills the vbox, which is stashed in meta so the rebuild finds it.
func _build_bt_detail() -> Control:
	var panel := PanelContainer.new()
	panel.custom_minimum_size.x = 340
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.13, 0.15)
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	sb.content_margin_top = 16
	sb.content_margin_bottom = 16
	panel.add_theme_stylebox_override("panel", sb)

	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	panel.add_child(scroll)

	var vbox := VBoxContainer.new()
	vbox.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vbox.add_theme_constant_override("separation", 10)
	scroll.add_child(vbox)

	var placeholder := Label.new()
	placeholder.name = "Placeholder"
	placeholder.text = "Select a block to edit it."
	vbox.add_child(placeholder)

	panel.set_meta("vbox", vbox)
	return panel

func _on_block_type_selected(bt_name: String) -> void:
	_selected_block_type = bt_name
	if _block_grid:
		_block_grid.set_selected(bt_name)
	_refresh_bt_detail()

func _refresh_bt_detail() -> void:
	if not _bt_detail:
		return
	var vbox: VBoxContainer = _bt_detail.get_meta("vbox")
	for c in vbox.get_children():
		c.queue_free()
	_bt_preview = null
	await get_tree().process_frame

	var bt := _selected_library.get_block_type(_selected_block_type) if _selected_library else null
	if not bt:
		var lbl := Label.new()
		lbl.name = "Placeholder"
		lbl.text = "Select a block to edit it."
		vbox.add_child(lbl)
		return

	# Name is read-only: palette entries reference block types by name, so renaming
	# would silently break those refs (rename is intentionally out of scope).
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	var name_lbl := Label.new()
	name_lbl.text = bt.name
	name_lbl.add_theme_font_size_override("font_size", 16)
	name_lbl.clip_text = true
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	header.add_child(name_lbl)
	var files_btn := Button.new()
	files_btn.text = "Open folder"
	files_btn.tooltip_text = "Reveal this block in the library in your file browser"
	files_btn.pressed.connect(func(): _on_open_in_files(bt))
	header.add_child(files_btn)
	vbox.add_child(header)

	# Live, rotatable 3D render of the block.
	_bt_preview = BlockPreview3D.new()
	_bt_preview.custom_minimum_size = Vector2(0, 280)
	_bt_preview.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vbox.add_child(_bt_preview)
	_bt_preview.set_block(bt)

	vbox.add_child(_labeled_picker("Color", bt.color, func(c: Color):
		bt.color = c
		_after_block_edit(bt)))

	vbox.add_child(_labeled_picker("Tint", bt.tint, func(c: Color):
		bt.tint = c
		_after_block_edit(bt)))

	var shape_row := HBoxContainer.new()
	var shape_lbl := Label.new()
	shape_lbl.text = "Shape"
	shape_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	shape_row.add_child(shape_lbl)
	var shape_opt := OptionButton.new()
	for s in ["Full", "Slab", "Stairs"]:
		shape_opt.add_item(s)
	shape_opt.selected = int(bt.shape)
	shape_opt.item_selected.connect(func(idx: int):
		bt.shape = idx as BlockType.Shape
		_after_block_edit(bt))
	shape_row.add_child(shape_opt)
	vbox.add_child(shape_row)

	vbox.add_child(HSeparator.new())

	var tex_header := Label.new()
	tex_header.text = "Textures"
	vbox.add_child(tex_header)
	_build_texture_bindings(vbox, bt)

	vbox.add_child(HSeparator.new())

	var del_btn := Button.new()
	del_btn.text = "Delete block"
	del_btn.pressed.connect(func(): _on_delete_block_type(bt.name))
	vbox.add_child(del_btn)

# A "<caption> [color]" row whose ColorPickerButton invokes `on_change(Color)`.
func _labeled_picker(caption: String, value: Color, on_change: Callable) -> HBoxContainer:
	var row := HBoxContainer.new()
	var lbl := Label.new()
	lbl.text = caption
	lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(lbl)
	var btn := ColorPickerButton.new()
	btn.color = value
	btn.custom_minimum_size = Vector2(90, 0)
	btn.color_changed.connect(on_change)
	row.add_child(btn)
	return row

# Texture-binding rows for the block's model. A block with no explicit (textured)
# model gets a "Set texture…" action that creates a full-cube model; one with bound
# keys lists each with a swatch + "Replace…".
func _build_texture_bindings(vbox: VBoxContainer, bt: BlockType) -> void:
	var model := _editable_model(bt)
	if model == null or not model.has_textures():
		var set_btn := Button.new()
		set_btn.text = "Set texture…"
		set_btn.pressed.connect(func(): _on_set_texture(bt))
		vbox.add_child(set_btn)
		return
	for key in model.textures:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		row.add_child(_texture_swatch(model.textures[key]))
		var klbl := Label.new()
		klbl.text = key
		klbl.tooltip_text = key
		klbl.clip_text = true
		klbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		klbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(klbl)
		var rep := Button.new()
		rep.text = "Replace…"
		rep.pressed.connect(func(): _on_replace_texture(bt, model, key))
		row.add_child(rep)
		vbox.add_child(row)

# A 32×32 preview of a bound texture: the image itself (NEAREST) when loadable, else
# a flat swatch of its planning average color.
func _texture_swatch(asset_id: String) -> Control:
	var asset := VoxelWorld.workspace.get_texture_asset(asset_id)
	if asset != null and not asset.image_path.is_empty():
		var img := BlockTextureCache.cached_texture(asset.image_path)
		if img != null:
			var swatch := TextureRect.new()
			swatch.texture = img
			swatch.custom_minimum_size = Vector2(32, 32)
			swatch.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
			swatch.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			return swatch
	var rect := ColorRect.new()
	rect.color = asset.average_color if asset != null else Color(0.5, 0.5, 0.5)
	rect.custom_minimum_size = Vector2(32, 32)
	return rect

# The block's own editable model (explicit model_id), or null for a built-in shape
# (no model to edit yet — the "Set texture…" path creates one). Scoped to the selected
# library so editing acts on that library's model.
func _editable_model(bt: BlockType) -> BlockModel:
	if bt.model_id.is_empty() or _selected_library == null:
		return null
	return _selected_library.get_block_model(bt.model_id)

func _on_set_texture(bt: BlockType) -> void:
	if _selected_library == null:
		return
	_pick_png(func(path: String):
		var lib := _selected_library
		var asset := TextureIngest.ingest_file(lib, path, "custom:%s/all" % bt.name)
		if asset == null:
			return
		var model := lib.get_block_model("custom:%s" % bt.name)
		if model == null:
			model = BlockModel.new()
			model.id = "custom:%s" % bt.name
			lib.add_block_model(model)
		model.elements = [BlockModel.box_element(Vector3.ZERO, Vector3.ONE, "all")]
		model.textures = {"all": asset.id}
		bt.model_id = model.id
		bt.color = asset.average_color
		_after_block_edit(bt)
		_refresh_bt_detail())

# Rebind one texture key to a freshly ingested PNG. The new asset gets a per-block id
# so replacing never clobbers a shared imported texture's pixels.
func _on_replace_texture(bt: BlockType, model: BlockModel, key: String) -> void:
	if _selected_library == null:
		return
	_pick_png(func(path: String):
		var asset := TextureIngest.ingest_file(_selected_library, path, "custom:%s/%s" % [bt.name, key])
		if asset == null:
			return
		model.textures[key] = asset.id
		_after_block_edit(bt)
		_refresh_bt_detail())

# Common post-edit: notify views, refresh this block's preview + grid icon, persist the
# block's library.
func _after_block_edit(bt: BlockType) -> void:
	VoxelWorld.notify_block_type_changed()
	if _bt_preview:
		_bt_preview.set_block(bt)
	if _block_grid:
		_block_grid.refresh_icons(bt.name)
	if _selected_library:
		LibraryStore.save_library(_selected_library)

func _on_new_block() -> void:
	var dlg := NewBlockDialog.new()
	dlg.submitted.connect(_create_block)
	get_tree().root.add_child(dlg)
	dlg.popup_centered()

# Build a new block type from the dialog's picks. Textures are optional: with none,
# the block is a gray full cube (the "build before you decide" path); with an "all"
# texture and optional Top/Bottom, a full-cube BlockModel is bound to those keys.
func _create_block(block_name: String, all_path: String, top_path: String, bottom_path: String) -> void:
	var lib := _selected_library
	if lib == null or lib.get_block_type(block_name) != null:
		return
	var bt := lib.add_block_type(block_name)
	var all_asset := _ingest_opt(lib, all_path, block_name, "all")
	var top_asset := _ingest_opt(lib, top_path, block_name, "top")
	var bottom_asset := _ingest_opt(lib, bottom_path, block_name, "bottom")
	if all_asset != null or top_asset != null or bottom_asset != null:
		var model := BlockModel.new()
		model.id = "custom:%s" % block_name
		var elem := BlockModel.box_element(Vector3.ZERO, Vector3.ONE, "all")
		model.textures = {}
		if all_asset != null:
			model.textures["all"] = all_asset.id
		if top_asset != null:
			model.textures["top"] = top_asset.id
			elem["faces"][BlockModel.Dir.UP] = BlockModel.make_face("top")
		if bottom_asset != null:
			model.textures["bottom"] = bottom_asset.id
			elem["faces"][BlockModel.Dir.DOWN] = BlockModel.make_face("bottom")
		model.elements = [elem]
		lib.add_block_model(model)
		bt.model_id = model.id
		var primary := all_asset if all_asset != null else (top_asset if top_asset != null else bottom_asset)
		bt.color = primary.average_color
	LibraryStore.save_library(lib)
	VoxelWorld.workspace_changed.emit()
	_selected_block_type = block_name
	if _block_grid:
		_block_grid.set_selected(block_name)
	_refresh_bt_detail()

# Ingest an optional PNG under a per-block/key id; null when no path was chosen.
func _ingest_opt(lib: BlockLibrary, path: String, block_name: String, key: String) -> TextureAsset:
	if path.is_empty():
		return null
	return TextureIngest.ingest_file(lib, path, "custom:%s/%s" % [block_name, key])

func _on_import_blocks() -> void:
	var panel := ImportPanel.new()
	# Default the import target to the Block Types tab's selected library (never basic);
	# the panel still lets the user pick or create another.
	if _selected_library != null and not _selected_library.builtin:
		panel.default_library = _selected_library.name
	get_tree().root.add_child(panel)
	panel.popup_centered()

# Reveal the block's saved resource in the OS file browser. Persists first so the
# .tres exists, then highlights it (falling back to the library root if needed). The
# block lives under its library's folder.
func _on_open_in_files(bt: BlockType) -> void:
	if _selected_library == null:
		return
	LibraryStore.save_library(_selected_library)
	var rel := AssetLibrary.in_library(_selected_library.name, AssetLibrary.BLOCK_TYPES_DIR) \
		.path_join(bt.name.validate_filename() + ".tres")
	var abs_path := ProjectSettings.globalize_path(AssetLibrary.path_for(rel))
	if FileAccess.file_exists(abs_path):
		OS.shell_show_in_file_manager(abs_path)
	else:
		OS.shell_open(ProjectSettings.globalize_path(AssetLibrary.path_for(_selected_library.name)))

func _on_delete_block_type(block_name: String) -> void:
	if _selected_library == null:
		return
	_selected_library.remove_block_type(block_name)
	if _selected_block_type == block_name:
		_selected_block_type = ""
	LibraryStore.save_library(_selected_library)
	VoxelWorld.workspace_changed.emit()
	_refresh_bt_detail()

# Pick a PNG from the OS filesystem and hand its path to `on_pick`.
func _pick_png(on_pick: Callable) -> void:
	var fd := FileDialog.new()
	fd.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	fd.access = FileDialog.ACCESS_FILESYSTEM
	fd.filters = PackedStringArray(["*.png ; PNG Images"])
	fd.use_native_dialog = true
	fd.file_selected.connect(func(p: String):
		on_pick.call(p)
		fd.queue_free())
	fd.canceled.connect(fd.queue_free)
	get_tree().root.add_child(fd)
	fd.popup_centered(Vector2i(720, 500))

# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------

func _refresh(_arg = null) -> void:
	if _projects_container:
		_rebuild_projects()
	if _palettes_list:
		_palettes_list.populate(VoxelWorld.workspace.palettes.map(func(p): return p.name))
	_ensure_selected_library()
	if _library_rail:
		_library_rail.selected = _selected_library.name if _selected_library else ""
		_library_rail.populate(VoxelWorld.workspace.list_libraries())
	if _block_grid:
		_block_grid.populate(_selected_library.sorted_block_types() if _selected_library else [])

func _margin(px: int) -> MarginContainer:
	var m := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, px)
	return m
