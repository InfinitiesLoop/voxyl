class_name HomeScreen
extends Control

signal open_project_requested(project: VoxelProject)

var _projects_container: VBoxContainer
var _palettes_list: LibraryList
var _palette_editor: Control
var _block_types_list: LibraryList
var _editing_palette: Palette
var _entry_list: VBoxContainer

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

	# Column headers
	var headers := HBoxContainer.new()
	vbox.add_child(headers)
	for h in ["Semantic Name", "Block Type", "Color", ""]:
		var lbl := Label.new()
		lbl.text = h
		lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL if h != "" else 0
		headers.add_child(lbl)

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

	var block_picker := OptionButton.new()
	block_picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var current_idx := 0
	for i in VoxelWorld.workspace.block_types.size():
		var bt := VoxelWorld.workspace.block_types[i]
		block_picker.add_item(bt.name)
		if bt.name == entry.block_type_name:
			current_idx = i
	block_picker.selected = current_idx
	block_picker.item_selected.connect(func(idx):
		entry.block_type_name = VoxelWorld.workspace.block_types[idx].name
	)
	row.add_child(block_picker)

	var color_btn := ColorPickerButton.new()
	color_btn.color = entry.color
	color_btn.custom_minimum_size = Vector2(48, 0)
	color_btn.color_changed.connect(func(c): entry.color = c)
	row.add_child(color_btn)

	var del_btn := Button.new()
	del_btn.text = "✕"
	del_btn.flat = true
	del_btn.pressed.connect(func():
		_editing_palette.entries.erase(entry)
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

	var block_picker := OptionButton.new()
	block_picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	for bt in VoxelWorld.workspace.block_types:
		block_picker.add_item(bt.name)
	row.add_child(block_picker)

	var color_btn := ColorPickerButton.new()
	color_btn.color = Color(0.6, 0.6, 0.6)
	color_btn.custom_minimum_size = Vector2(48, 0)
	row.add_child(color_btn)

	var add_btn := Button.new()
	add_btn.text = "+"
	add_btn.pressed.connect(func():
		var n := name_input.text.strip_edges()
		if n.is_empty() or not _editing_palette:
			return
		var e := PaletteEntry.new()
		e.semantic_name = n
		var pidx := block_picker.selected
		e.block_type_name = VoxelWorld.workspace.block_types[pidx].name if pidx >= 0 else ""
		e.color = color_btn.color
		_editing_palette.entries.append(e)
		name_input.text = ""
		_refresh_palette_entries()
	)
	row.add_child(add_btn)

	return row

func _on_add_palette(palette_name: String) -> void:
	if not VoxelWorld.workspace.get_palette(palette_name):
		VoxelWorld.workspace.add_palette(palette_name)
		VoxelWorld.workspace_changed.emit()

func _on_delete_palette(palette_name: String) -> void:
	VoxelWorld.workspace.remove_palette(palette_name)
	VoxelWorld.workspace_changed.emit()

# ---------------------------------------------------------------------------
# Block Types tab
# ---------------------------------------------------------------------------

func _build_block_types_tab() -> Control:
	var root := _margin(16)
	root.name = "Block Types"

	_block_types_list = LibraryList.new()
	_block_types_list.list_title = "Block Types"
	_block_types_list.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_block_types_list.add_requested.connect(_on_add_block_type)
	_block_types_list.delete_requested.connect(_on_delete_block_type)
	root.add_child(_block_types_list)

	return root

func _on_add_block_type(block_name: String) -> void:
	if not VoxelWorld.workspace.get_block_type(block_name):
		VoxelWorld.workspace.add_block_type(block_name)
		VoxelWorld.workspace_changed.emit()

func _on_delete_block_type(block_name: String) -> void:
	VoxelWorld.workspace.remove_block_type(block_name)
	VoxelWorld.workspace_changed.emit()

# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------

func _refresh(_arg = null) -> void:
	if _projects_container:
		_rebuild_projects()
	if _palettes_list:
		_palettes_list.populate(VoxelWorld.workspace.palettes.map(func(p): return p.name))
	if _block_types_list:
		_block_types_list.populate(VoxelWorld.workspace.block_types.map(func(bt): return bt.name))

func _margin(px: int) -> MarginContainer:
	var m := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, px)
	return m
