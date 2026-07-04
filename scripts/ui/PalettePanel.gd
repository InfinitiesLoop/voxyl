class_name PalettePanel
extends VBoxContainer

# Palette-stack manager: a scrollable, selectable, searchable list of the palettes a
# project subscribes to, plus reorder / remove / add-to-stack controls. Selecting a row
# is how the Inventory screen decides which palette's entries to show on the right —
# this panel only owns "which palettes are in scope and in what order", never any block
# data itself.
#
# The selection highlight mirrors LibraryList's (scripts/ui/LibraryList.gd) so a selected
# palette reads identically to a selected library elsewhere in the app.

signal item_selected(palette_name: String)

var selected: String = ""

# Set the highlighted row without emitting item_selected — used by the host (e.g. after
# a stack change picks a fallback palette) to keep the highlight in sync.
func set_selected(palette_name: String) -> void:
	selected = palette_name
	_update_selection()

var _search_terms: PackedStringArray = PackedStringArray()
var _list: VBoxContainer

func _ready() -> void:
	custom_minimum_size.x = 180
	VoxelWorld.project_opened.connect(func(_p): _rebuild())
	VoxelWorld.palette_stack_changed.connect(_rebuild)
	VoxelWorld.block_type_changed.connect(_rebuild)
	_rebuild()

# Called by the host (InventoryScreen) when the grid's own search box changes, so typing
# a term also narrows which palettes appear here — only those with a matching semantic
# name or assigned block type stay in the list.
func set_search_terms(terms: PackedStringArray) -> void:
	_search_terms = terms
	_rebuild()

func _rebuild(_arg = null) -> void:
	for child in get_children():
		child.queue_free()
	await get_tree().process_frame

	if not VoxelWorld.active_project:
		return

	var title := Label.new()
	title.text = "Palettes"
	title.add_theme_font_size_override("font_size", 12)
	title.modulate = Color(1, 1, 1, 0.7)
	add_child(title)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)

	_list = VBoxContainer.new()
	_list.size_flags_horizontal = SIZE_EXPAND_FILL
	scroll.add_child(_list)

	_build_stack_section()
	add_child(HSeparator.new())
	_build_add_section()

# ---------------------------------------------------------------------------
# Palette stack management (add / remove / reorder palettes on the project)
# ---------------------------------------------------------------------------

func _build_stack_section() -> void:
	var project := VoxelWorld.active_project

	for i in project.palette_names.size():
		var palette_name: String = project.palette_names[i]
		var palette := VoxelWorld.workspace.get_palette(palette_name)
		if not _search_terms.is_empty() and not _palette_has_match(palette, _search_terms):
			continue

		var row := PanelContainer.new()
		row.set_meta("item_name", palette_name)

		var hbox := HBoxContainer.new()
		row.add_child(hbox)

		var btn := Button.new()
		btn.text = palette_name
		btn.flat = true
		btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
		btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		btn.add_theme_font_size_override("font_size", 12)
		var captured := palette_name
		btn.pressed.connect(func():
			selected = captured
			_update_selection()
			item_selected.emit(captured)
		)
		hbox.add_child(btn)

		var up := Button.new()
		up.text = "↑"; up.flat = true; up.disabled = i == 0
		var ci := i
		up.pressed.connect(func(): VoxelWorld.move_palette_in_stack(project, ci, ci - 1))
		hbox.add_child(up)

		var dn := Button.new()
		dn.text = "↓"; dn.flat = true; dn.disabled = i == project.palette_names.size() - 1
		dn.pressed.connect(func(): VoxelWorld.move_palette_in_stack(project, ci, ci + 1))
		hbox.add_child(dn)

		var rm := Button.new()
		rm.text = "✕"; rm.flat = true
		rm.pressed.connect(func(): VoxelWorld.remove_palette_from_stack(project, ci))
		hbox.add_child(rm)

		_list.add_child(row)
		_apply_row_style(row, palette_name == selected)

# A term can hit either a palette entry's semantic name or its currently assigned block
# type — so searching "stone" finds a palette that maps "Base" to "Stone" even though
# "stone" never appears as a semantic name.
func _palette_has_match(palette: Palette, terms: PackedStringArray) -> bool:
	if palette == null:
		return false
	for e in palette.entries:
		if BlockGrid.matches_all_terms("%s %s" % [e.semantic_name, e.block_type_name], terms):
			return true
	return false

# ---------------------------------------------------------------------------
# Selection highlight (mirrors LibraryList's row styling)
# ---------------------------------------------------------------------------

static var _selected_sb: StyleBoxFlat
static func _selected_style() -> StyleBoxFlat:
	if _selected_sb == null:
		_selected_sb = StyleBoxFlat.new()
		_selected_sb.bg_color = Color(0.30, 0.55, 0.90, 0.35)
		_selected_sb.corner_radius_top_left = 4
		_selected_sb.corner_radius_top_right = 4
		_selected_sb.corner_radius_bottom_left = 4
		_selected_sb.corner_radius_bottom_right = 4
	return _selected_sb

func _apply_row_style(row: PanelContainer, is_selected: bool) -> void:
	if is_selected:
		row.add_theme_stylebox_override("panel", _selected_style())
	else:
		row.remove_theme_stylebox_override("panel")

func _update_selection() -> void:
	if not _list:
		return
	for row in _list.get_children():
		_apply_row_style(row, row.get_meta("item_name") == selected)

# ---------------------------------------------------------------------------
# Add-to-stack (unused palettes), pinned to the bottom
# ---------------------------------------------------------------------------

func _build_add_section() -> void:
	var project := VoxelWorld.active_project
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

	var new_btn := Button.new()
	new_btn.text = "New Palette"
	new_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	new_btn.pressed.connect(_on_new_palette)
	add_child(new_btn)

# Prompt for a name, then create a brand-new, empty palette. Unlike the standalone
# palette editor (HomeScreen._on_new_palette, which auto-generates "New Palette N" and
# jumps into the editor to rename), this is a project context — the new palette is added
# straight onto the project's stack and selected, ready for entries via the grid's own
# "+" tile, so it's worth asking for a real name up front instead.
func _on_new_palette() -> void:
	var dlg := NewPaletteDialog.new()
	dlg.submitted.connect(_create_palette)
	get_tree().root.add_child(dlg)
	dlg.popup_centered()

# A name already in use is silently ignored (same convention as HomeScreen._on_add_library
# for a duplicate library name) rather than auto-uniquifying a name the user just typed.
func _create_palette(palette_name: String) -> void:
	var project := VoxelWorld.active_project
	if not project or VoxelWorld.workspace.get_palette(palette_name) != null:
		return
	var p := VoxelWorld.add_palette(palette_name)
	VoxelWorld.add_palette_to_stack(project, p.name)
	selected = p.name
	item_selected.emit(p.name)
