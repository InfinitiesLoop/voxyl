class_name PalettePanel
extends VBoxContainer

var _buttons: Dictionary = {}  # semantic_name -> Button

func _ready() -> void:
	VoxelWorld.project_opened.connect(func(_p): _rebuild())
	VoxelWorld.palette_stack_changed.connect(_rebuild)
	VoxelWorld.selection_changed.connect(_on_selection_changed)

func _rebuild(_arg = null) -> void:
	for child in get_children():
		if child.name != "Title":
			child.queue_free()
	_buttons.clear()
	await get_tree().process_frame

	if not VoxelWorld.active_project:
		return

	for semantic_name in VoxelWorld.merged_semantic_names():
		var color := VoxelWorld.get_color_for_semantic(semantic_name)
		var block_type := VoxelWorld.get_block_type_for_semantic(semantic_name)

		var btn := Button.new()
		btn.text = semantic_name
		btn.tooltip_text = block_type if not block_type.is_empty() else "(unmapped)"
		btn.toggle_mode = true
		btn.button_pressed = semantic_name == VoxelWorld.selected_semantic
		btn.alignment = HORIZONTAL_ALIGNMENT_LEFT

		var normal := StyleBoxFlat.new()
		normal.bg_color = color.darkened(0.4)
		normal.border_width_left = 5
		normal.border_color = color
		normal.content_margin_left = 10
		normal.content_margin_top = 6
		normal.content_margin_bottom = 6
		btn.add_theme_stylebox_override("normal", normal)
		btn.add_theme_stylebox_override("hover", normal)

		var pressed_style := normal.duplicate() as StyleBoxFlat
		pressed_style.bg_color = color.darkened(0.15)
		btn.add_theme_stylebox_override("pressed", pressed_style)

		var captured := semantic_name
		btn.pressed.connect(func(): VoxelWorld.select_semantic(captured))
		add_child(btn)
		_buttons[semantic_name] = btn

func _on_selection_changed(semantic_name: String) -> void:
	for s in _buttons:
		_buttons[s].button_pressed = s == semantic_name
