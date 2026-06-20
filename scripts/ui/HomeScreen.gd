class_name HomeScreen
extends Control

signal open_layout_requested(layout: VoxelLayout)

var _block_types_list: LibraryList
var _palettes_list: LibraryList
var _layouts_list: LibraryList
var _stack_section: VBoxContainer
var _stack_list: VBoxContainer
var _stack_title: Label
var _add_to_stack_picker: OptionButton

func _ready() -> void:
	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 28)
	margin.add_theme_constant_override("margin_right", 28)
	margin.add_theme_constant_override("margin_top", 28)
	margin.add_theme_constant_override("margin_bottom", 28)
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 20)
	margin.add_child(vbox)

	var title := Label.new()
	title.text = "voxyl"
	vbox.add_child(title)

	var columns := HBoxContainer.new()
	columns.size_flags_vertical = SIZE_EXPAND_FILL
	columns.add_theme_constant_override("separation", 20)
	vbox.add_child(columns)

	_block_types_list = LibraryList.new()
	_block_types_list.list_title = "Block Types"
	_block_types_list.size_flags_horizontal = SIZE_EXPAND_FILL
	columns.add_child(_block_types_list)

	_palettes_list = LibraryList.new()
	_palettes_list.list_title = "Palettes"
	_palettes_list.size_flags_horizontal = SIZE_EXPAND_FILL
	columns.add_child(_palettes_list)

	columns.add_child(_build_layouts_column())

	_block_types_list.add_requested.connect(_on_add_block_type)
	_block_types_list.delete_requested.connect(_on_delete_block_type)
	_palettes_list.add_requested.connect(_on_add_palette)
	_palettes_list.delete_requested.connect(_on_delete_palette)
	_layouts_list.add_requested.connect(_on_add_layout)
	_layouts_list.delete_requested.connect(_on_delete_layout)
	_layouts_list.item_selected.connect(_on_layout_selected)

	VoxelWorld.workspace_changed.connect(_refresh)
	_refresh()

func _build_layouts_column() -> VBoxContainer:
	var col := VBoxContainer.new()
	col.size_flags_horizontal = SIZE_EXPAND_FILL
	col.add_theme_constant_override("separation", 8)

	_layouts_list = LibraryList.new()
	_layouts_list.list_title = "Layouts"
	_layouts_list.size_flags_vertical = SIZE_EXPAND_FILL
	col.add_child(_layouts_list)

	# Palette stack panel — shown when a layout is selected
	_stack_section = VBoxContainer.new()
	_stack_section.add_theme_constant_override("separation", 4)
	col.add_child(_stack_section)

	_stack_title = Label.new()
	_stack_title.text = "Palette Stack"
	_stack_section.add_child(_stack_title)

	_stack_list = VBoxContainer.new()
	_stack_section.add_child(_stack_list)

	var add_bar := HBoxContainer.new()
	_stack_section.add_child(add_bar)

	_add_to_stack_picker = OptionButton.new()
	_add_to_stack_picker.size_flags_horizontal = SIZE_EXPAND_FILL
	add_bar.add_child(_add_to_stack_picker)

	var add_btn := Button.new()
	add_btn.text = "Add"
	add_btn.pressed.connect(_on_add_palette_to_stack)
	add_bar.add_child(add_btn)

	var open_btn := Button.new()
	open_btn.text = "Open →"
	open_btn.pressed.connect(_on_open_layout)
	col.add_child(open_btn)

	_stack_section.visible = false
	return col

func _refresh(_arg = null) -> void:
	var ws := VoxelWorld.workspace
	_block_types_list.populate(ws.block_types.map(func(bt): return bt.name))
	_palettes_list.populate(ws.palettes.map(func(p): return p.name))
	_layouts_list.populate(ws.layouts.map(func(l): return l.name))
	_refresh_palette_picker()
	if not _layouts_list.selected.is_empty():
		_rebuild_stack(_layouts_list.selected)

func _refresh_palette_picker() -> void:
	var prev := _add_to_stack_picker.get_item_text(_add_to_stack_picker.selected) \
		if _add_to_stack_picker.selected >= 0 else ""
	_add_to_stack_picker.clear()
	var restore := 0
	for i in VoxelWorld.workspace.palettes.size():
		var p := VoxelWorld.workspace.palettes[i]
		_add_to_stack_picker.add_item(p.name)
		if p.name == prev:
			restore = i
	if _add_to_stack_picker.item_count > 0:
		_add_to_stack_picker.selected = restore

func _on_layout_selected(layout_name: String) -> void:
	_stack_section.visible = true
	_stack_title.text = "Palette Stack — %s" % layout_name
	_rebuild_stack(layout_name)

func _rebuild_stack(layout_name: String) -> void:
	for c in _stack_list.get_children():
		c.queue_free()
	var layout := VoxelWorld.workspace.get_layout(layout_name)
	if not layout:
		return
	for i in layout.palette_names.size():
		_stack_list.add_child(_make_stack_row(layout, i))

func _make_stack_row(layout: VoxelLayout, index: int) -> HBoxContainer:
	var row := HBoxContainer.new()

	var lbl := Label.new()
	lbl.text = layout.palette_names[index]
	lbl.size_flags_horizontal = SIZE_EXPAND_FILL
	row.add_child(lbl)

	var up_btn := Button.new()
	up_btn.text = "↑"
	up_btn.flat = true
	up_btn.disabled = index == 0
	up_btn.pressed.connect(func():
		VoxelWorld.move_palette_in_stack(layout, index, index - 1)
		_rebuild_stack(layout.name)
	)
	row.add_child(up_btn)

	var dn_btn := Button.new()
	dn_btn.text = "↓"
	dn_btn.flat = true
	dn_btn.disabled = index == layout.palette_names.size() - 1
	dn_btn.pressed.connect(func():
		VoxelWorld.move_palette_in_stack(layout, index, index + 1)
		_rebuild_stack(layout.name)
	)
	row.add_child(dn_btn)

	var del_btn := Button.new()
	del_btn.text = "✕"
	del_btn.flat = true
	del_btn.pressed.connect(func():
		VoxelWorld.remove_palette_from_stack(layout, index)
		_rebuild_stack(layout.name)
	)
	row.add_child(del_btn)

	return row

func _on_add_palette_to_stack() -> void:
	var layout_name := _layouts_list.selected
	if layout_name.is_empty():
		return
	var layout := VoxelWorld.workspace.get_layout(layout_name)
	if not layout:
		return
	var pidx := _add_to_stack_picker.selected
	if pidx < 0 or pidx >= VoxelWorld.workspace.palettes.size():
		return
	var palette_name := VoxelWorld.workspace.palettes[pidx].name
	VoxelWorld.add_palette_to_stack(layout, palette_name)
	_rebuild_stack(layout_name)

func _on_open_layout() -> void:
	var layout_name := _layouts_list.selected
	if layout_name.is_empty():
		return
	var layout := VoxelWorld.workspace.get_layout(layout_name)
	if layout:
		open_layout_requested.emit(layout)

func _on_add_block_type(block_name: String) -> void:
	if not VoxelWorld.workspace.get_block_type(block_name):
		VoxelWorld.workspace.add_block_type(block_name)
		VoxelWorld.workspace_changed.emit()

func _on_delete_block_type(block_name: String) -> void:
	VoxelWorld.workspace.remove_block_type(block_name)
	VoxelWorld.workspace_changed.emit()

func _on_add_palette(palette_name: String) -> void:
	if not VoxelWorld.workspace.get_palette(palette_name):
		VoxelWorld.workspace.add_palette(palette_name)
		VoxelWorld.workspace_changed.emit()

func _on_delete_palette(palette_name: String) -> void:
	VoxelWorld.workspace.remove_palette(palette_name)
	VoxelWorld.workspace_changed.emit()

func _on_add_layout(layout_name: String) -> void:
	if not VoxelWorld.workspace.get_layout(layout_name):
		VoxelWorld.workspace.add_layout(layout_name)
		VoxelWorld.workspace_changed.emit()

func _on_delete_layout(layout_name: String) -> void:
	VoxelWorld.workspace.remove_layout(layout_name)
	VoxelWorld.workspace_changed.emit()
