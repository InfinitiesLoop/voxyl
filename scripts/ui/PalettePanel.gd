class_name PalettePanel
extends VBoxContainer

var _buttons: Dictionary = {}  # semantic_name -> Button

func _ready() -> void:
	VoxelWorld.layout_opened.connect(func(_l, _p): _rebuild())
	VoxelWorld.palette_swapped.connect(func(_p): _rebuild())
	VoxelWorld.selection_changed.connect(_on_selection_changed)

func _rebuild(_arg = null) -> void:
	for child in get_children():
		if child.name != "Title":
			child.queue_free()
	_buttons.clear()
	await get_tree().process_frame

	if not VoxelWorld.active_palette:
		return

	for entry in VoxelWorld.active_palette.entries:
		var btn := Button.new()
		btn.text = entry.semantic_name
		btn.tooltip_text = entry.block_type_name
		btn.toggle_mode = true
		btn.button_pressed = entry.semantic_name == VoxelWorld.selected_semantic
		btn.alignment = HORIZONTAL_ALIGNMENT_LEFT

		var normal := StyleBoxFlat.new()
		normal.bg_color = entry.color.darkened(0.4)
		normal.border_width_left = 5
		normal.border_color = entry.color
		normal.content_margin_left = 10
		normal.content_margin_top = 6
		normal.content_margin_bottom = 6
		btn.add_theme_stylebox_override("normal", normal)
		btn.add_theme_stylebox_override("hover", normal)

		var pressed_style := normal.duplicate() as StyleBoxFlat
		pressed_style.bg_color = entry.color.darkened(0.15)
		btn.add_theme_stylebox_override("pressed", pressed_style)

		var sub := Label.new()
		sub.text = entry.block_type_name
		sub.add_theme_color_override("font_color", entry.color.lightened(0.3))
		sub.add_theme_font_size_override("font_size", 10)
		sub.size_flags_horizontal = SIZE_EXPAND_FILL

		var semantic := entry.semantic_name
		btn.pressed.connect(func(): VoxelWorld.select_semantic(semantic))

		add_child(btn)
		_buttons[semantic] = btn

func _on_selection_changed(semantic_name: String) -> void:
	for s in _buttons:
		_buttons[s].button_pressed = s == semantic_name
