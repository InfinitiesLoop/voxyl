class_name HomeScreen
extends Control

signal open_layout_requested(layout: VoxelLayout, palette: Palette)

var _block_types_list: LibraryList
var _palettes_list: LibraryList
var _layouts_list: LibraryList
var _palette_picker: OptionButton

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

	VoxelWorld.workspace_changed.connect(_refresh)
	_refresh()

func _build_layouts_column() -> VBoxContainer:
	var col := VBoxContainer.new()
	col.size_flags_horizontal = SIZE_EXPAND_FILL

	_layouts_list = LibraryList.new()
	_layouts_list.list_title = "Layouts"
	_layouts_list.size_flags_vertical = SIZE_EXPAND_FILL
	col.add_child(_layouts_list)

	var open_bar := HBoxContainer.new()
	col.add_child(open_bar)

	var with_lbl := Label.new()
	with_lbl.text = "Palette:"
	open_bar.add_child(with_lbl)

	_palette_picker = OptionButton.new()
	_palette_picker.size_flags_horizontal = SIZE_EXPAND_FILL
	open_bar.add_child(_palette_picker)

	var open_btn := Button.new()
	open_btn.text = "Open →"
	open_btn.pressed.connect(_on_open_layout)
	open_bar.add_child(open_btn)

	return col

func _refresh(_arg = null) -> void:
	var ws := VoxelWorld.workspace
	_block_types_list.populate(ws.block_types.map(func(bt): return bt.name))
	_palettes_list.populate(ws.palettes.map(func(p): return p.name))
	_layouts_list.populate(ws.layouts.map(func(l): return l.name))

	var prev := _palette_picker.get_item_text(_palette_picker.selected) if _palette_picker.selected >= 0 else ""
	_palette_picker.clear()
	var restore_idx := 0
	for i in ws.palettes.size():
		_palette_picker.add_item(ws.palettes[i].name)
		if ws.palettes[i].name == prev:
			restore_idx = i
	if _palette_picker.item_count > 0:
		_palette_picker.selected = restore_idx

func _on_add_block_type(block_name: String) -> void:
	if VoxelWorld.workspace.get_block_type(block_name):
		return
	VoxelWorld.workspace.add_block_type(block_name)
	VoxelWorld.workspace_changed.emit()

func _on_delete_block_type(block_name: String) -> void:
	VoxelWorld.workspace.remove_block_type(block_name)
	VoxelWorld.workspace_changed.emit()

func _on_add_palette(palette_name: String) -> void:
	if VoxelWorld.workspace.get_palette(palette_name):
		return
	VoxelWorld.workspace.add_palette(palette_name)
	VoxelWorld.workspace_changed.emit()

func _on_delete_palette(palette_name: String) -> void:
	VoxelWorld.workspace.remove_palette(palette_name)
	VoxelWorld.workspace_changed.emit()

func _on_add_layout(layout_name: String) -> void:
	if VoxelWorld.workspace.get_layout(layout_name):
		return
	VoxelWorld.workspace.add_layout(layout_name)
	VoxelWorld.workspace_changed.emit()

func _on_delete_layout(layout_name: String) -> void:
	VoxelWorld.workspace.remove_layout(layout_name)
	VoxelWorld.workspace_changed.emit()

func _on_open_layout() -> void:
	var layout_name := _layouts_list.selected
	if layout_name.is_empty():
		return
	var layout := VoxelWorld.workspace.get_layout(layout_name)
	if not layout:
		return
	var pidx := _palette_picker.selected
	if pidx < 0 or pidx >= VoxelWorld.workspace.palettes.size():
		return
	var palette := VoxelWorld.workspace.palettes[pidx]
	open_layout_requested.emit(layout, palette)
