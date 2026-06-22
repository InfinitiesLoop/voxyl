class_name PalettePanel
extends VBoxContainer

var _buttons: Dictionary = {}

func _ready() -> void:
	VoxelWorld.project_opened.connect(func(_p): _rebuild())
	VoxelWorld.palette_stack_changed.connect(_rebuild)
	VoxelWorld.block_type_changed.connect(_rebuild)
	VoxelWorld.selection_changed.connect(_on_selection_changed)

func _rebuild(_arg = null) -> void:
	for child in get_children():
		if child.name != "Title":
			child.queue_free()
	_buttons.clear()
	await get_tree().process_frame

	if not VoxelWorld.active_project:
		return

	_build_stack_section()
	add_child(HSeparator.new())
	_build_semantic_buttons()

# ---------------------------------------------------------------------------
# Palette stack management (add / remove / reorder palettes on the project)
# ---------------------------------------------------------------------------

func _build_stack_section() -> void:
	var project := VoxelWorld.active_project

	for i in project.palette_names.size():
		var palette_name: String = project.palette_names[i]
		var row := HBoxContainer.new()

		var lbl := Label.new()
		lbl.text = palette_name
		lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		lbl.add_theme_font_size_override("font_size", 12)
		row.add_child(lbl)

		var up := Button.new()
		up.text = "↑"; up.flat = true; up.disabled = i == 0
		var ci := i
		up.pressed.connect(func(): VoxelWorld.move_palette_in_stack(project, ci, ci - 1))
		row.add_child(up)

		var dn := Button.new()
		dn.text = "↓"; dn.flat = true; dn.disabled = i == project.palette_names.size() - 1
		dn.pressed.connect(func(): VoxelWorld.move_palette_in_stack(project, ci, ci + 1))
		row.add_child(dn)

		var rm := Button.new()
		rm.text = "✕"; rm.flat = true
		rm.pressed.connect(func(): VoxelWorld.remove_palette_from_stack(project, ci))
		row.add_child(rm)

		add_child(row)

	# Add-to-stack row
	var available: Array = []
	for pal in VoxelWorld.workspace.palettes:
		if not project.palette_names.has(pal.name):
			available.append(pal)

	var add_row := HBoxContainer.new()

	var opt := OptionButton.new()
	opt.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	opt.add_theme_font_size_override("font_size", 12)
	for pal in available:
		opt.add_item((pal as Palette).name)
	add_row.add_child(opt)

	var add_btn := Button.new()
	add_btn.text = "+"
	add_btn.disabled = available.is_empty()
	add_btn.pressed.connect(func():
		if opt.selected >= 0 and opt.selected < available.size():
			VoxelWorld.add_palette_to_stack(project, (available[opt.selected] as Palette).name)
	)
	add_row.add_child(add_btn)

	add_child(add_row)

# ---------------------------------------------------------------------------
# Semantic color buttons
# ---------------------------------------------------------------------------

func _build_semantic_buttons() -> void:
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
		# Clicking a palette block swaps it into the active hotbar slot (and selects
		# it). Dragging it drops it onto a specific slot. Either way the palette is
		# the source of blocks; the hotbar is the working set.
		btn.pressed.connect(func(): VoxelWorld.set_hotbar_slot(VoxelWorld.active_slot, captured))
		btn.set_drag_forwarding(
			func(_at): return _make_drag(captured, color),
			func(_at, _data): return false,
			func(_at, _data): pass)
		add_child(btn)
		_buttons[semantic_name] = btn

# Drag payload + a little color swatch as the drag preview.
func _make_drag(semantic_name: String, color: Color) -> Variant:
	var preview := ColorRect.new()
	preview.color = color
	preview.custom_minimum_size = Vector2(28, 28)
	preview.size = Vector2(28, 28)
	set_drag_preview(preview)
	return {"type": "palette_block", "semantic": semantic_name}

func _on_selection_changed(semantic_name: String) -> void:
	for s in _buttons:
		_buttons[s].button_pressed = s == semantic_name
