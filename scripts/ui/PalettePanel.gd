class_name PalettePanel
extends VBoxContainer

var _buttons: Dictionary = {}  # type_id -> Button

func _ready() -> void:
	VoxelWorld.block_types_changed.connect(_rebuild)
	VoxelWorld.palette_changed.connect(_rebuild)
	VoxelWorld.project_loaded.connect(func(_p): _rebuild())
	VoxelWorld.selection_changed.connect(_on_selection_changed)

func _rebuild(_arg = null) -> void:
	for child in get_children():
		if child.name != "Title":
			child.queue_free()
	_buttons.clear()
	await get_tree().process_frame

	for bt in VoxelWorld.project.block_types:
		var btn := Button.new()
		btn.text = bt.display_name
		btn.toggle_mode = true
		btn.button_pressed = bt.id == VoxelWorld.selected_type_id
		btn.alignment = HORIZONTAL_ALIGNMENT_LEFT

		var color := VoxelWorld.get_color_for_type(bt.id)

		var normal := StyleBoxFlat.new()
		normal.bg_color = color.darkened(0.4)
		normal.border_width_left = 5
		normal.border_color = color
		normal.content_margin_left = 10
		normal.content_margin_top = 6
		normal.content_margin_bottom = 6
		btn.add_theme_stylebox_override("normal", normal)
		btn.add_theme_stylebox_override("hover", normal)

		var pressed := normal.duplicate() as StyleBoxFlat
		pressed.bg_color = color.darkened(0.15)
		pressed.border_width_left = 5
		btn.add_theme_stylebox_override("pressed", pressed)

		var type_id := bt.id
		btn.pressed.connect(func(): VoxelWorld.select_type(type_id))
		add_child(btn)
		_buttons[bt.id] = btn

func _on_selection_changed(type_id: String) -> void:
	for id in _buttons:
		_buttons[id].button_pressed = id == type_id
