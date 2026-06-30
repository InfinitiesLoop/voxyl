class_name PalettePanel
extends VBoxContainer

# Palette-stack manager: add / remove / reorder the palettes a project subscribes to.
# It used to also list the project's template items (semantic blocks) — that list is
# gone; blocks are now chosen into hotbar slots from the inventory screen. This panel
# is embedded in that inventory screen so "which palettes are in scope" lives next to
# "which blocks go in the hotbar".

func _ready() -> void:
	VoxelWorld.project_opened.connect(func(_p): _rebuild())
	VoxelWorld.palette_stack_changed.connect(_rebuild)
	VoxelWorld.block_type_changed.connect(_rebuild)

func _rebuild(_arg = null) -> void:
	for child in get_children():
		if child.name != "Title":
			child.queue_free()
	await get_tree().process_frame

	if not VoxelWorld.active_project:
		return

	_build_stack_section()

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
